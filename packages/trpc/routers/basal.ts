import { TRPCError } from "@trpc/server";
import { and, count, desc, eq, isNull, ne, or } from "drizzle-orm";
import { z } from "zod";

import {
  basalCalibrationsTable,
  basalJobsTable,
  basalRatingsTable,
  basalScoresTable,
  basalSettingsTable,
  bookmarks,
  rssFeedImportsTable,
  rssFeedsTable,
} from "@karakeep/db/schema";
import { isWeakByThreshold } from "@karakeep/shared/basal/decision";
import type { BasalHealth } from "@karakeep/shared/basal/types";
import { ratingToLabel, zBasalRating } from "@karakeep/shared/basal/types";

import { router, sessionProcedure } from "../index";
import {
  BASAL_MAX_ITEMS_CAP,
  BASAL_MIN_RATINGS,
  BASAL_RECOMMENDED_RATINGS,
  getBasalClient,
  getBasalSettings,
  reconcileStaleBasalJobs,
  selectUnscoredBookmarks,
  startBasalScoreJob,
  startBasalTrainJob,
} from "../lib/basalJobs";

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

// Basal is a UI feature: session auth only, no API keys.
export const basalAppRouter = router({
  status: sessionProcedure.query(async ({ ctx }) => {
    const userId = ctx.user.id;
    const db = ctx.db;
    await reconcileStaleBasalJobs(db, userId);

    const client = getBasalClient();
    let health: BasalHealth;
    let bridgeError: string | undefined;
    try {
      health = await client.health();
      bridgeError = health.error;
    } catch (e) {
      bridgeError = e instanceof Error ? e.message : String(e);
      health = {
        ok: false,
        model: "",
        mode: "",
        calibration_id: null,
        engine_version: "",
      };
    }

    const activeCalibration = await db.query.basalCalibrationsTable.findFirst({
      where: and(
        eq(basalCalibrationsTable.userId, userId),
        eq(basalCalibrationsTable.active, true),
      ),
      orderBy: desc(basalCalibrationsTable.createdAt),
    });

    const ratingRows = await db
      .select({ rating: basalRatingsTable.rating, count: count() })
      .from(basalRatingsTable)
      .where(eq(basalRatingsTable.userId, userId))
      .groupBy(basalRatingsTable.rating);
    const ratingsByLabel = { slaby: 0, sredni: 0, ciekawy: 0 };
    let ratings = 0;
    for (const row of ratingRows) {
      const parsed = zBasalRating.safeParse(row.rating);
      if (parsed.success) {
        ratingsByLabel[ratingToLabel(parsed.data)] += row.count;
      }
      ratings += row.count;
    }

    const [{ scored }] = await db
      .select({ scored: count() })
      .from(basalScoresTable)
      .where(eq(basalScoresTable.userId, userId));

    // Staleness is derived, never stored: a score is stale when it was
    // produced under a calibration other than the active one.
    let stale = 0;
    if (activeCalibration) {
      const [row] = await db
        .select({ stale: count() })
        .from(basalScoresTable)
        .where(
          and(
            eq(basalScoresTable.userId, userId),
            or(
              isNull(basalScoresTable.calibrationId),
              ne(basalScoresTable.calibrationId, activeCalibration.id),
            ),
          ),
        );
      stale = row.stale;
    }

    const unscoredQuery = selectUnscoredBookmarks(db, userId).as("unscored");
    const [{ unscored }] = await db
      .select({ unscored: count() })
      .from(unscoredQuery);

    const [{ feeds }] = await db
      .select({ feeds: count() })
      .from(rssFeedsTable)
      .where(eq(rssFeedsTable.userId, userId));

    const runningJob = await db.query.basalJobsTable.findFirst({
      where: and(
        eq(basalJobsTable.userId, userId),
        or(
          eq(basalJobsTable.status, "queued"),
          eq(basalJobsTable.status, "running"),
        ),
      ),
      orderBy: desc(basalJobsTable.createdAt),
    });

    const mock = client.isMock() || health.mock === true;

    return {
      bridge: {
        ok: health.ok,
        model: health.model,
        mode: health.mode,
        calibrationId: health.calibration_id,
        engineVersion: health.engine_version,
        baseUrl: client.baseUrl,
        ...(bridgeError ? { error: bridgeError } : {}),
      },
      activeCalibration: activeCalibration
        ? {
            id: activeCalibration.id,
            model: activeCalibration.model,
            mode: activeCalibration.mode,
            createdAt: activeCalibration.createdAt,
            metrics: activeCalibration.metrics,
          }
        : null,
      counts: {
        ratings,
        ratingsByLabel,
        scored,
        stale,
        unscored,
        feeds,
      },
      settings: await getBasalSettings(db, userId),
      runningJob: runningJob
        ? {
            id: runningJob.id,
            type: runningJob.type,
            processed: runningJob.processed,
            total: runningJob.total,
          }
        : null,
      mock,
    };
  }),

  rate: sessionProcedure
    .input(
      z.object({
        bookmarkId: z.string(),
        rating: zBasalRating.nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const bookmark = await ctx.db.query.bookmarks.findFirst({
        where: and(
          eq(bookmarks.id, input.bookmarkId),
          eq(bookmarks.userId, userId),
        ),
        columns: { id: true },
      });
      if (!bookmark) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Bookmark not found",
        });
      }

      if (input.rating === null) {
        await ctx.db
          .delete(basalRatingsTable)
          .where(
            and(
              eq(basalRatingsTable.userId, userId),
              eq(basalRatingsTable.bookmarkId, input.bookmarkId),
            ),
          );
        return null;
      }

      const [row] = await ctx.db
        .insert(basalRatingsTable)
        .values({
          userId,
          bookmarkId: input.bookmarkId,
          rating: input.rating,
        })
        .onConflictDoUpdate({
          target: [basalRatingsTable.userId, basalRatingsTable.bookmarkId],
          set: { rating: input.rating, modifiedAt: new Date() },
        })
        .returning();
      return {
        bookmarkId: row.bookmarkId,
        rating: row.rating,
        modifiedAt: row.modifiedAt,
      };
    }),

  updateSettings: sessionProcedure
    .input(
      z.object({
        autoArchive: z.boolean().optional(),
        archiveThreshold: z.number().optional(),
        minConfidence: z.number().optional(),
        maxItems: z.number().int().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const current = await getBasalSettings(ctx.db, userId);
      const next = {
        autoArchive: input.autoArchive ?? current.autoArchive,
        archiveThreshold: clamp(
          input.archiveThreshold ?? current.archiveThreshold,
          0,
          2,
        ),
        minConfidence: clamp(
          input.minConfidence ?? current.minConfidence,
          0,
          1,
        ),
        maxItems: clamp(
          input.maxItems ?? current.maxItems,
          1,
          BASAL_MAX_ITEMS_CAP,
        ),
      };
      await ctx.db
        .insert(basalSettingsTable)
        .values({ userId, ...next })
        .onConflictDoUpdate({
          target: basalSettingsTable.userId,
          set: { ...next, modifiedAt: new Date() },
        });
      return next;
    }),

  train: sessionProcedure
    .output(z.object({ jobId: z.string(), warnings: z.array(z.string()) }))
    .mutation(async ({ ctx }) => {
      const userId = ctx.user.id;
      const [{ ratings }] = await ctx.db
        .select({ ratings: count() })
        .from(basalRatingsTable)
        .where(eq(basalRatingsTable.userId, userId));
      if (ratings < BASAL_MIN_RATINGS) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Za mało ocen: ${ratings}. Trening wymaga co najmniej ${BASAL_MIN_RATINGS} ocenionych zakładek.`,
        });
      }
      const warnings: string[] = [];
      if (ratings < BASAL_RECOMMENDED_RATINGS) {
        warnings.push(
          `Tylko ${ratings} ocen — kalibracja może być niestabilna. Zalecane jest co najmniej ${BASAL_RECOMMENDED_RATINGS}.`,
        );
      }
      const jobId = await startBasalTrainJob(ctx.db, userId, warnings);
      return { jobId, warnings };
    }),

  scoreIncoming: sessionProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).optional(),
        })
        .optional(),
    )
    .output(z.object({ jobId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const settings = await getBasalSettings(ctx.db, userId);
      const limit = clamp(
        input?.limit ?? settings.maxItems,
        1,
        BASAL_MAX_ITEMS_CAP,
      );
      const jobId = await startBasalScoreJob(ctx.db, userId, limit);
      return { jobId };
    }),

  job: sessionProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      await reconcileStaleBasalJobs(ctx.db, ctx.user.id);
      const job = await ctx.db.query.basalJobsTable.findFirst({
        where: and(
          eq(basalJobsTable.id, input.id),
          eq(basalJobsTable.userId, ctx.user.id),
        ),
      });
      if (!job) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Job not found" });
      }
      return {
        id: job.id,
        type: job.type,
        status: job.status,
        total: job.total,
        processed: job.processed,
        result: job.result,
        error: job.error,
        createdAt: job.createdAt,
        finishedAt: job.finishedAt,
      };
    }),

  feedQuality: sessionProcedure.query(async ({ ctx }) => {
    const userId = ctx.user.id;
    const settings = await getBasalSettings(ctx.db, userId);

    const feeds = await ctx.db
      .select({
        id: rssFeedsTable.id,
        name: rssFeedsTable.name,
        enabled: rssFeedsTable.enabled,
      })
      .from(rssFeedsTable)
      .where(eq(rssFeedsTable.userId, userId))
      .orderBy(rssFeedsTable.name);

    const scoredRows = await ctx.db
      .select({
        feedId: rssFeedImportsTable.rssFeedId,
        bookmarkId: basalScoresTable.bookmarkId,
        expectedLevel: basalScoresTable.expectedLevel,
      })
      .from(rssFeedImportsTable)
      .innerJoin(
        rssFeedsTable,
        eq(rssFeedsTable.id, rssFeedImportsTable.rssFeedId),
      )
      .innerJoin(
        basalScoresTable,
        and(
          eq(basalScoresTable.bookmarkId, rssFeedImportsTable.bookmarkId),
          eq(basalScoresTable.userId, userId),
        ),
      )
      .where(eq(rssFeedsTable.userId, userId));

    // Dedupe per (feed, bookmark): one bookmark can be imported twice by a feed.
    const perFeed = new Map<string, Map<string, number>>();
    for (const row of scoredRows) {
      let levels = perFeed.get(row.feedId);
      if (!levels) {
        levels = new Map();
        perFeed.set(row.feedId, levels);
      }
      levels.set(row.bookmarkId, row.expectedLevel);
    }

    return feeds.map((feed) => {
      const levels = [...(perFeed.get(feed.id)?.values() ?? [])];
      const scoredCount = levels.length;
      const meanExpectedLevel =
        scoredCount > 0
          ? levels.reduce((a, b) => a + b, 0) / scoredCount
          : null;
      const weakShare =
        scoredCount > 0
          ? levels.filter((l) =>
              isWeakByThreshold(l, settings.archiveThreshold),
            ).length / scoredCount
          : null;
      return {
        feedId: feed.id,
        name: feed.name,
        enabled: feed.enabled,
        scoredCount,
        meanExpectedLevel,
        weakShare,
        suggestDisable:
          meanExpectedLevel !== null &&
          meanExpectedLevel < 1.0 &&
          scoredCount >= 10,
      };
    });
  }),
});
