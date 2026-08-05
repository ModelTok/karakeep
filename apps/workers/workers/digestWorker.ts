import { createHash } from "node:crypto";
import { and, asc, eq, gt } from "drizzle-orm";
import { workerStatsCounter } from "metrics";
import cron from "node-cron";
import { buildImpersonatingTRPCClient } from "trpc";
import { withWorkerEventLog, withWorkerTracing } from "workerTracing";

import type { ZDigestRequest } from "@karakeep/shared-server";
import { db } from "@karakeep/db";
import { bookmarkLinks, bookmarks, users } from "@karakeep/db/schema";
import { addLogFields, DigestQueue } from "@karakeep/shared-server";
import logger from "@karakeep/shared/logger";
import { DequeuedJob, getQueueClient } from "@karakeep/shared/queueing";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";

const DIGEST_LIST_NAME = "Prasówka";
const DIGEST_LIST_ICON = "📰";
const DAY_MS = 24 * 60 * 60 * 1000;

function isoDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

// Run weekly on Monday at 08:00 server time
export const DigestSchedulingWorker = cron.schedule(
  "0 8 * * MON",
  async () => {
    logger.info("[digest] Scheduling weekly digest jobs ...");
    try {
      const usersWithDigest = await db.query.users.findMany({
        columns: {
          id: true,
        },
        where: eq(users.digestEnabled, true),
      });

      logger.info(
        `[digest] Found ${usersWithDigest.length} users with digest enabled`,
      );

      const now = new Date();
      const currentWeek = isoDate(now); // Monday's date, since this only runs on Mondays

      for (const user of usersWithDigest) {
        // Deterministically spread digest generation across the day based on user ID
        const hash = createHash("sha256").update(user.id).digest("hex");
        const hashNum = parseInt(hash.substring(0, 8), 16);
        const delayMs = hashNum % DAY_MS;

        const idempotencyKey = `${user.id}-${currentWeek}`;

        await DigestQueue.enqueue(
          {
            userId: user.id,
          },
          {
            delayMs,
            idempotencyKey,
          },
        );

        logger.info(
          `[digest] Scheduled digest for user ${user.id} with delay ${Math.round(delayMs / 1000 / 60)} minutes`,
        );
      }

      logger.info("[digest] Finished scheduling digest jobs");
    } catch (error) {
      logger.error(`[digest] Error scheduling digest jobs: ${error}`);
    }
  },
  {
    runOnInit: false,
    scheduled: false,
  },
);

export class DigestWorker {
  static async build() {
    logger.info("Starting digest worker ...");
    const worker = (await getQueueClient())!.createRunner<ZDigestRequest>(
      DigestQueue,
      {
        run: withWorkerTracing(
          "digestWorker.run",
          withWorkerEventLog("digestWorker.run", run),
        ),
        onComplete: async (job) => {
          workerStatsCounter.labels("digest", "completed").inc();
          const jobId = job.id;
          logger.info(`[digest][${jobId}] Completed successfully`);
        },
        onError: async (job) => {
          workerStatsCounter.labels("digest", "failed").inc();
          if (job.numRetriesLeft == 0) {
            workerStatsCounter.labels("digest", "failed_permanent").inc();
          }
          const jobId = job.id;
          logger.error(
            `[digest][${jobId}] Digest job failed: ${job.error}\n${job.error?.stack}`,
          );
        },
      },
      {
        concurrency: 1,
        pollIntervalMs: 5000,
        timeoutSecs: 120,
      },
    );

    return worker;
  }
}

function buildDigestMarkdown(
  items: { title: string | null; url: string; summary: string | null }[],
): string {
  return items
    .map((item) => {
      const title = item.title ?? item.url;
      let line = `- [${title}](${item.url})`;
      if (item.summary) {
        line += `\n  ${item.summary}`;
      }
      return line;
    })
    .join("\n");
}

async function run(req: DequeuedJob<ZDigestRequest>) {
  const jobId = req.id;
  const userId = req.data.userId;
  addLogFields<"digestWorker.run">({ "user.id": userId });

  logger.info(`[digest][${jobId}] Building digest for user ${userId} ...`);

  const sevenDaysAgo = new Date(Date.now() - 7 * DAY_MS);

  const rows = await db
    .select({
      title: bookmarks.title,
      summary: bookmarks.summary,
      url: bookmarkLinks.url,
    })
    .from(bookmarks)
    .innerJoin(bookmarkLinks, eq(bookmarks.id, bookmarkLinks.id))
    .where(
      and(
        eq(bookmarks.userId, userId),
        eq(bookmarks.type, BookmarkTypes.LINK),
        gt(bookmarks.createdAt, sevenDaysAgo),
      ),
    )
    .orderBy(asc(bookmarks.createdAt));

  if (rows.length === 0) {
    logger.info(
      `[digest][${jobId}] No new links in the last 7 days for user ${userId}. Skipping.`,
    );
    return;
  }

  addLogFields<"digestWorker.run">({ "digest.item_count": rows.length });

  const trpcClient = await buildImpersonatingTRPCClient(userId);

  const { lists } = await trpcClient.lists.list();
  let digestList = lists.find((l) => l.name === DIGEST_LIST_NAME);
  if (!digestList) {
    digestList = await trpcClient.lists.create({
      name: DIGEST_LIST_NAME,
      icon: DIGEST_LIST_ICON,
    });
    logger.info(
      `[digest][${jobId}] Created "${DIGEST_LIST_NAME}" list (${digestList.id}) for user ${userId}`,
    );
  }

  const weekStart = isoDate(sevenDaysAgo);
  const weekEnd = isoDate(new Date());
  const markdown = buildDigestMarkdown(rows);

  const bookmark = await trpcClient.bookmarks.createBookmark({
    type: BookmarkTypes.TEXT,
    title: `${DIGEST_LIST_NAME} — ${weekStart} to ${weekEnd}`,
    text: markdown,
    source: "digest",
  });

  await trpcClient.lists.addToList({
    listId: digestList.id,
    bookmarkId: bookmark.id,
  });

  logger.info(
    `[digest][${jobId}] Created digest bookmark ${bookmark.id} with ${rows.length} items for user ${userId}`,
  );
}
