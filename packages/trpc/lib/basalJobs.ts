import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";

import {
  basalCalibrationsTable,
  basalJobsTable,
  basalRatingsTable,
  basalScoresTable,
  basalSettingsTable,
  bookmarks,
  bookmarkTags,
  tagsOnBookmarks,
} from "@karakeep/db/schema";
import {
  BasalClient,
  BasalUnavailableError,
} from "@karakeep/shared/basal/client";
import { buildDataset, groupFor } from "@karakeep/shared/basal/dataset";
import type { BasalDatasetEntry } from "@karakeep/shared/basal/dataset";
import { shouldAutoArchive } from "@karakeep/shared/basal/decision";
import type { BasalState } from "@karakeep/shared/basal/state";
import { buildBasalState, domainFromUrl } from "@karakeep/shared/basal/state";
import type { BasalRating } from "@karakeep/shared/basal/types";
import { toStoredScore } from "@karakeep/shared/basal/types";
import serverConfig from "@karakeep/shared/config";
import logger from "@karakeep/shared/logger";
import { htmlToPlainText } from "@karakeep/shared/utils/htmlUtils";

import type { AuthedContext } from "../index";
import { Bookmark } from "../models/bookmarks";

type DB = AuthedContext["db"];

export const BASAL_SCORE_BATCH_SIZE = 10;
export const BASAL_MAX_ITEMS_CAP = 200;
export const BASAL_MIN_RATINGS = 20;
export const BASAL_RECOMMENDED_RATINGS = 50;
export const BASAL_WEAK_TAG = "basal:slabe";
export const BASAL_CALIBRATION_TARGETS = ["0.01", "0.05"];

const MAX_RECORDED_ERRORS = 20;
// Title-only candidates are skipped, so look a bit further back than `limit`
// to avoid permanently uncrawlable bookmarks blocking the queue.
const CANDIDATE_SCAN_FACTOR = 3;
const STATE_LOAD_CHUNK = 50;

export type BasalSettings = Pick<
  typeof basalSettingsTable.$inferSelect,
  "autoArchive" | "archiveThreshold" | "minConfidence" | "maxItems"
>;

// Defaults come from the schema column definitions.
export const BASAL_SETTINGS_DEFAULTS: BasalSettings = {
  autoArchive: basalSettingsTable.autoArchive.default as boolean,
  archiveThreshold: basalSettingsTable.archiveThreshold.default as number,
  minConfidence: basalSettingsTable.minConfidence.default as number,
  maxItems: basalSettingsTable.maxItems.default as number,
};

export async function getBasalSettings(
  db: DB,
  userId: string,
): Promise<BasalSettings> {
  const row = await db.query.basalSettingsTable.findFirst({
    where: eq(basalSettingsTable.userId, userId),
  });
  if (!row) {
    return { ...BASAL_SETTINGS_DEFAULTS };
  }
  return {
    autoArchive: row.autoArchive,
    archiveThreshold: row.archiveThreshold,
    minConfidence: row.minConfidence,
    maxItems: row.maxItems,
  };
}

// ---------------------------------------------------------------------------
// Client + test seam

let clientFactory: () => BasalClient = () =>
  new BasalClient({ baseUrl: serverConfig.basal.bridgeUrl });
let beforeRunHook: ((jobId: string) => Promise<void>) | null = null;

export function getBasalClient(): BasalClient {
  return clientFactory();
}

// ---------------------------------------------------------------------------
// In-process runner: one job at a time, globally.

let activeJob: { id: string; promise: Promise<void> | null } | null = null;

/**
 * Test-only hooks. Not re-exported from the router; tests import this module
 * directly.
 */
export const basalJobsTestSeam = {
  setClientFactory(factory: (() => BasalClient) | null) {
    clientFactory =
      factory ??
      (() => new BasalClient({ baseUrl: serverConfig.basal.bridgeUrl }));
  },
  setBeforeRun(hook: ((jobId: string) => Promise<void>) | null) {
    beforeRunHook = hook;
  },
  async waitForIdle() {
    while (activeJob?.promise) {
      await activeJob.promise;
    }
  },
};

/**
 * Jobs left queued/running by a previous process can never finish. Mark them
 * failed lazily when the UI looks at them (no startup work).
 */
export async function reconcileStaleBasalJobs(db: DB, userId: string) {
  const conditions = [
    eq(basalJobsTable.userId, userId),
    inArray(basalJobsTable.status, ["queued", "running"]),
  ];
  if (activeJob) {
    conditions.push(ne(basalJobsTable.id, activeJob.id));
  }
  await db
    .update(basalJobsTable)
    .set({
      status: "failure",
      error: "Zadanie przerwane: serwer został zrestartowany.",
      finishedAt: new Date(),
    })
    .where(and(...conditions));
}

interface JobContext {
  db: DB;
  userId: string;
  jobId: string;
  client: BasalClient;
  result: Record<string, unknown>;
  setTotal(total: number): Promise<void>;
  setProcessed(processed: number): Promise<void>;
}

async function startBasalJob(
  db: DB,
  userId: string,
  type: "score" | "train",
  run: (ctx: JobContext) => Promise<void>,
): Promise<string> {
  if (activeJob) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "Inne zadanie Basal jest już w toku. Poczekaj na jego zakończenie.",
    });
  }
  // Reserve the slot synchronously so concurrent requests can't both pass.
  const slot: { id: string; promise: Promise<void> | null } = {
    id: "",
    promise: null,
  };
  activeJob = slot;

  let jobId: string;
  try {
    const [row] = await db
      .insert(basalJobsTable)
      .values({ userId, type, status: "queued" })
      .returning({ id: basalJobsTable.id });
    jobId = row.id;
  } catch (e) {
    activeJob = null;
    throw e;
  }
  slot.id = jobId;
  slot.promise = executeJob(db, userId, jobId, type, run);
  return jobId;
}

async function executeJob(
  db: DB,
  userId: string,
  jobId: string,
  type: "score" | "train",
  run: (ctx: JobContext) => Promise<void>,
) {
  const result: Record<string, unknown> = {};
  const updateJob = async (
    values: Partial<typeof basalJobsTable.$inferInsert>,
  ) => {
    await db
      .update(basalJobsTable)
      .set(values)
      .where(eq(basalJobsTable.id, jobId));
  };

  try {
    if (beforeRunHook) {
      await beforeRunHook(jobId);
    }
    const client = getBasalClient();
    result.mock = client.isMock();
    await updateJob({ status: "running" });
    await run({
      db,
      userId,
      jobId,
      client,
      result,
      setTotal: (total) => updateJob({ total }),
      setProcessed: (processed) => updateJob({ processed }),
    });
    await updateJob({ status: "success", result, finishedAt: new Date() });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error(`[basal][${type}][${jobId}] Job failed: ${message}`);
    try {
      await updateJob({
        status: "failure",
        error: message,
        result,
        finishedAt: new Date(),
      });
    } catch (dbErr) {
      logger.error(
        `[basal][${type}][${jobId}] Failed to record job failure: ${String(dbErr)}`,
      );
    }
  } finally {
    if (activeJob?.id === jobId) {
      activeJob = null;
    }
  }
}

// ---------------------------------------------------------------------------
// State loading

interface LoadedState extends BasalState {
  feedId: string | null;
  domain: string;
}

async function loadBasalStates(
  db: DB,
  userId: string,
  bookmarkIds: string[],
): Promise<Map<string, LoadedState>> {
  const out = new Map<string, LoadedState>();
  if (bookmarkIds.length === 0) {
    return out;
  }
  const rows = await db.query.bookmarks.findMany({
    where: and(
      eq(bookmarks.userId, userId),
      inArray(bookmarks.id, bookmarkIds),
    ),
    columns: { id: true, title: true, summary: true },
    with: {
      link: {
        columns: {
          url: true,
          title: true,
          description: true,
          htmlContent: true,
          contentAssetId: true,
        },
      },
      text: { columns: { text: true, sourceUrl: true } },
      asset: { columns: { content: true, sourceUrl: true, fileName: true } },
      tagsOnBookmarks: { with: { tag: { columns: { name: true } } } },
      rssFeeds: { with: { rssFeed: { columns: { id: true, name: true } } } },
    },
  });

  for (const row of rows) {
    const url =
      row.link?.url ?? row.text?.sourceUrl ?? row.asset?.sourceUrl ?? "";
    const domain = domainFromUrl(url);
    const feed = row.rssFeeds.find((f) => f.rssFeed)?.rssFeed ?? null;

    let text: string | null = null;
    if (row.link) {
      try {
        // Reader-view content (stored as an asset when large) or the inline
        // htmlContent, converted to plain text.
        const html = await Bookmark.getBookmarkHtmlContent(row.link, userId);
        text = html ? htmlToPlainText(html) : null;
      } catch (e) {
        logger.warn(
          `[basal] Failed to read content of bookmark ${row.id}: ${String(e)}`,
        );
      }
    } else if (row.text) {
      text = row.text.text;
    } else if (row.asset) {
      text = row.asset.content;
    }

    const state = buildBasalState({
      title: row.title ?? row.link?.title ?? row.asset?.fileName ?? "",
      url,
      domain,
      feedName: feed?.name ?? null,
      tags: row.tagsOnBookmarks.map((t) => t.tag.name),
      summary: row.summary,
      description: row.link?.description ?? null,
      text,
    });
    out.set(row.id, { ...state, feedId: feed?.id ?? null, domain });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Score job

/**
 * Non-archived bookmarks of the user without a rating and without a score,
 * newest first.
 */
export function selectUnscoredBookmarks(db: DB, userId: string) {
  return db
    .select({ id: bookmarks.id })
    .from(bookmarks)
    .leftJoin(
      basalRatingsTable,
      and(
        eq(basalRatingsTable.bookmarkId, bookmarks.id),
        eq(basalRatingsTable.userId, userId),
      ),
    )
    .leftJoin(
      basalScoresTable,
      and(
        eq(basalScoresTable.bookmarkId, bookmarks.id),
        eq(basalScoresTable.userId, userId),
      ),
    )
    .where(
      and(
        eq(bookmarks.userId, userId),
        eq(bookmarks.archived, false),
        isNull(basalRatingsTable.id),
        isNull(basalScoresTable.id),
      ),
    )
    .orderBy(desc(bookmarks.createdAt), desc(bookmarks.id));
}

async function getOrCreateTagId(db: DB, userId: string, name: string) {
  await db.insert(bookmarkTags).values({ userId, name }).onConflictDoNothing();
  const tag = await db.query.bookmarkTags.findFirst({
    where: and(eq(bookmarkTags.userId, userId), eq(bookmarkTags.name, name)),
    columns: { id: true },
  });
  if (!tag) {
    throw new Error(`Failed to create tag ${name}`);
  }
  return tag.id;
}

// Same direct-db approach as the rule engine's addTag + archiveBookmark actions.
async function archiveAsWeak(db: DB, userId: string, bookmarkId: string) {
  const tagId = await getOrCreateTagId(db, userId, BASAL_WEAK_TAG);
  await db
    .insert(tagsOnBookmarks)
    .values([{ attachedBy: "ai", bookmarkId, tagId }])
    .onConflictDoNothing();
  await db
    .update(bookmarks)
    .set({ archived: true })
    .where(and(eq(bookmarks.id, bookmarkId), eq(bookmarks.userId, userId)));
}

export function startBasalScoreJob(db: DB, userId: string, limit: number) {
  return startBasalJob(db, userId, "score", (ctx) => runScoreJob(ctx, limit));
}

async function runScoreJob(ctx: JobContext, limit: number) {
  const { db, userId, client, result } = ctx;
  const errors: string[] = [];
  Object.assign(result, {
    scored: 0,
    archived: 0,
    skippedTitleOnly: 0,
    failedBatches: 0,
    errors,
  });
  const counters = result as {
    scored: number;
    archived: number;
    skippedTitleOnly: number;
    failedBatches: number;
  };
  const recordError = (message: string) => {
    if (errors.length < MAX_RECORDED_ERRORS) {
      errors.push(message);
    }
  };

  const settings = await getBasalSettings(db, userId);
  const pool = await selectUnscoredBookmarks(db, userId).limit(
    Math.min(
      limit * CANDIDATE_SCAN_FACTOR,
      BASAL_MAX_ITEMS_CAP * CANDIDATE_SCAN_FACTOR,
    ),
  );

  const scorable: { id: string; state: string }[] = [];
  for (
    let i = 0;
    i < pool.length && scorable.length < limit;
    i += STATE_LOAD_CHUNK
  ) {
    const chunk = pool.slice(i, i + STATE_LOAD_CHUNK).map((r) => r.id);
    const states = await loadBasalStates(db, userId, chunk);
    for (const id of chunk) {
      if (scorable.length >= limit) {
        break;
      }
      const state = states.get(id);
      if (!state) {
        continue;
      }
      if (state.stateKind === "title_only") {
        counters.skippedTitleOnly++;
        continue;
      }
      scorable.push({ id, state: state.state });
    }
  }
  await ctx.setTotal(scorable.length);

  let processed = 0;
  for (let i = 0; i < scorable.length; i += BASAL_SCORE_BATCH_SIZE) {
    const batch = scorable.slice(i, i + BASAL_SCORE_BATCH_SIZE);
    const batchIds = new Set(batch.map((b) => b.id));
    try {
      const response = await client.score(batch);
      if (response.mock) {
        result.mock = true;
      }
      for (const r of response.results) {
        if (!batchIds.has(r.id)) {
          continue;
        }
        batchIds.delete(r.id);
        const stored = toStoredScore(r);
        await db
          .insert(basalScoresTable)
          .values({ userId, bookmarkId: r.id, ...stored })
          .onConflictDoUpdate({
            target: [basalScoresTable.userId, basalScoresTable.bookmarkId],
            set: { ...stored, modifiedAt: new Date() },
          });
        counters.scored++;
        if (
          shouldAutoArchive({
            label: r.label,
            probabilities: r.probabilities,
            expectedLevel: r.score,
            settings,
          })
        ) {
          await archiveAsWeak(db, userId, r.id);
          counters.archived++;
        }
      }
      if (batchIds.size > 0) {
        recordError(
          `Bridge returned no result for ${batchIds.size} item(s): ${[...batchIds].join(", ")}`,
        );
      }
    } catch (e) {
      if (e instanceof BasalUnavailableError) {
        // The bridge is gone; further batches would fail the same way.
        throw e;
      }
      counters.failedBatches++;
      recordError(e instanceof Error ? e.message : String(e));
    }
    processed += batch.length;
    await ctx.setProcessed(processed);
  }
}

// ---------------------------------------------------------------------------
// Train job

export function startBasalTrainJob(db: DB, userId: string, warnings: string[]) {
  return startBasalJob(db, userId, "train", (ctx) =>
    runTrainJob(ctx, [...warnings]),
  );
}

async function runTrainJob(ctx: JobContext, warnings: string[]) {
  const { db, userId, client, result } = ctx;
  result.warnings = warnings;

  const ratings = await db
    .select({
      bookmarkId: basalRatingsTable.bookmarkId,
      rating: basalRatingsTable.rating,
    })
    .from(basalRatingsTable)
    .innerJoin(bookmarks, eq(bookmarks.id, basalRatingsTable.bookmarkId))
    .where(
      and(eq(basalRatingsTable.userId, userId), eq(bookmarks.userId, userId)),
    );

  const entries: BasalDatasetEntry[] = [];
  for (let i = 0; i < ratings.length; i += STATE_LOAD_CHUNK) {
    const chunk = ratings.slice(i, i + STATE_LOAD_CHUNK);
    const states = await loadBasalStates(
      db,
      userId,
      chunk.map((r) => r.bookmarkId),
    );
    for (const r of chunk) {
      const state = states.get(r.bookmarkId);
      if (!state) {
        continue;
      }
      entries.push({
        id: r.bookmarkId,
        group: groupFor({ feedId: state.feedId, domain: state.domain }),
        state: state.state,
        stateKind: state.stateKind,
        rating: r.rating as BasalRating,
      });
    }
  }

  const { lines, skipped } = buildDataset(entries);
  result.labelled = lines.length;
  result.skipped = skipped;
  await ctx.setTotal(lines.length);

  if (lines.length < BASAL_MIN_RATINGS) {
    throw new Error(
      `Za mało ocenionych zakładek z treścią: ${lines.length} (pominięto ${skipped} bez treści). Trening wymaga co najmniej ${BASAL_MIN_RATINGS}.`,
    );
  }
  if (lines.length < BASAL_RECOMMENDED_RATINGS) {
    warnings.push(
      `Tylko ${lines.length} ocen z treścią trafiło do treningu; zalecane jest co najmniej ${BASAL_RECOMMENDED_RATINGS}.`,
    );
  }

  const health = await client.health();
  if (health.mock) {
    result.mock = true;
  }
  if (!health.ok) {
    throw new Error(
      `Basal bridge at ${client.baseUrl} is not ready: ${health.error ?? "unknown error"}`,
    );
  }

  const trained = await client.train(lines);
  if (trained.mock) {
    result.mock = true;
  }

  const metrics = trained.report as Record<string, unknown>;
  await db.transaction(async (tx) => {
    await tx
      .update(basalCalibrationsTable)
      .set({ active: false })
      .where(eq(basalCalibrationsTable.userId, userId));
    await tx
      .insert(basalCalibrationsTable)
      .values({
        id: trained.calibration_id,
        userId,
        model: health.model,
        mode: health.mode,
        targets: BASAL_CALIBRATION_TARGETS,
        metrics,
        path: trained.path,
        active: true,
      })
      .onConflictDoUpdate({
        target: basalCalibrationsTable.id,
        set: {
          model: health.model,
          mode: health.mode,
          metrics,
          path: trained.path,
          active: true,
        },
        setWhere: eq(basalCalibrationsTable.userId, userId),
      });
  });

  Object.assign(result, {
    calibrationId: trained.calibration_id,
    path: trained.path,
    report: trained.report,
  });
  await ctx.setProcessed(lines.length);
}
