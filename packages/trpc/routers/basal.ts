import { TRPCError } from "@trpc/server";
import { and, count, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { z } from "zod";

import {
  basalCalibrationsTable,
  basalFeedRatingsTable,
  basalFeedScoresTable,
  basalJobsTable,
  basalRatingsTable,
  basalScoresTable,
  basalSettingsTable,
  bookmarks,
  rssFeedImportsTable,
  rssFeedsTable,
} from "@karakeep/db/schema";
import {
  isScoreStale,
  isWeakByThreshold,
} from "@karakeep/shared/basal/decision";
import type {
  BasalHealth,
  BasalLabel,
  BasalRating,
} from "@karakeep/shared/basal/types";
import { ratingToLabel, zBasalRating } from "@karakeep/shared/basal/types";

import type { AuthedContext } from "../index";
import { router, sessionProcedure } from "../index";
import {
  BASAL_MAX_ITEMS_CAP,
  BASAL_MIN_RATINGS,
  BASAL_RECOMMENDED_RATINGS,
  getBasalClient,
  getBasalSettings,
  reconcileStaleBasalJobs,
  selectUnscoredBookmarks,
  startBasalScoreFeedsJob,
  startBasalScoreJob,
  startBasalTrainJob,
} from "../lib/basalJobs";

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

// Max ids accepted by ratingsForBookmarks (one grid page).
const RATINGS_FOR_BOOKMARKS_CAP = 200;
// Feed quality falls back from article scores only below this many.
const FEED_QUALITY_MIN_SCORED = 10;

async function getActiveCalibrationId(
  db: AuthedContext["db"],
  userId: string,
): Promise<string | null> {
  const active = await db.query.basalCalibrationsTable.findFirst({
    where: and(
      eq(basalCalibrationsTable.userId, userId),
      eq(basalCalibrationsTable.active, true),
    ),
    orderBy: desc(basalCalibrationsTable.createdAt),
    columns: { id: true },
  });
  return active?.id ?? null;
}

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

    const [{ feedRatings }] = await db
      .select({ feedRatings: count() })
      .from(basalFeedRatingsTable)
      .where(eq(basalFeedRatingsTable.userId, userId));

    const [{ feedsScored }] = await db
      .select({ feedsScored: count() })
      .from(basalFeedScoresTable)
      .where(eq(basalFeedScoresTable.userId, userId));

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
        feedRatings,
        feedsScored,
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

  rateFeed: sessionProcedure
    .input(
      z.object({
        feedId: z.string(),
        rating: zBasalRating.nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const feed = await ctx.db.query.rssFeedsTable.findFirst({
        where: and(
          eq(rssFeedsTable.id, input.feedId),
          eq(rssFeedsTable.userId, userId),
        ),
        columns: { id: true },
      });
      if (!feed) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Feed not found",
        });
      }

      if (input.rating === null) {
        await ctx.db
          .delete(basalFeedRatingsTable)
          .where(
            and(
              eq(basalFeedRatingsTable.userId, userId),
              eq(basalFeedRatingsTable.feedId, input.feedId),
            ),
          );
        return null;
      }

      const [row] = await ctx.db
        .insert(basalFeedRatingsTable)
        .values({
          userId,
          feedId: input.feedId,
          rating: input.rating,
        })
        .onConflictDoUpdate({
          target: [basalFeedRatingsTable.userId, basalFeedRatingsTable.feedId],
          set: { rating: input.rating, modifiedAt: new Date() },
        })
        .returning();
      return {
        feedId: row.feedId,
        rating: row.rating,
        modifiedAt: row.modifiedAt,
      };
    }),

  feedRatings: sessionProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        feedId: basalFeedRatingsTable.feedId,
        rating: basalFeedRatingsTable.rating,
      })
      .from(basalFeedRatingsTable)
      .where(eq(basalFeedRatingsTable.userId, ctx.user.id));
    return rows.map((r) => ({
      feedId: r.feedId,
      rating: r.rating as BasalRating,
    }));
  }),

  ratingsForBookmarks: sessionProcedure
    .input(
      z.object({
        ids: z.array(z.string()).max(RATINGS_FOR_BOOKMARKS_CAP),
      }),
    )
    .query(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const out: Record<
        string,
        {
          rating: BasalRating | null;
          score: {
            label: BasalLabel;
            confidence: number;
            expectedLevel: number;
            model: string;
            calibrationId: string | null;
            stale: boolean;
          } | null;
        }
      > = {};
      if (input.ids.length === 0) {
        return out;
      }
      const activeCalibrationId = await getActiveCalibrationId(ctx.db, userId);
      const ratings = await ctx.db
        .select({
          bookmarkId: basalRatingsTable.bookmarkId,
          rating: basalRatingsTable.rating,
        })
        .from(basalRatingsTable)
        .where(
          and(
            eq(basalRatingsTable.userId, userId),
            inArray(basalRatingsTable.bookmarkId, input.ids),
          ),
        );
      const scores = await ctx.db
        .select({
          bookmarkId: basalScoresTable.bookmarkId,
          label: basalScoresTable.label,
          confidence: basalScoresTable.confidence,
          expectedLevel: basalScoresTable.expectedLevel,
          model: basalScoresTable.model,
          calibrationId: basalScoresTable.calibrationId,
        })
        .from(basalScoresTable)
        .where(
          and(
            eq(basalScoresTable.userId, userId),
            inArray(basalScoresTable.bookmarkId, input.ids),
          ),
        );

      for (const r of ratings) {
        out[r.bookmarkId] = { rating: r.rating as BasalRating, score: null };
      }
      for (const { bookmarkId, ...score } of scores) {
        const entry = out[bookmarkId] ?? { rating: null, score: null };
        entry.score = {
          ...score,
          label: score.label as BasalLabel,
          stale: isScoreStale(score.calibrationId, activeCalibrationId),
        };
        out[bookmarkId] = entry;
      }
      return out;
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
      const [{ articleRatings }] = await ctx.db
        .select({ articleRatings: count() })
        .from(basalRatingsTable)
        .where(eq(basalRatingsTable.userId, userId));
      const [{ feedRatings }] = await ctx.db
        .select({ feedRatings: count() })
        .from(basalFeedRatingsTable)
        .where(eq(basalFeedRatingsTable.userId, userId));
      const ratings = articleRatings + feedRatings;
      if (ratings < BASAL_MIN_RATINGS) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Za mało ocen: ${ratings}. Trening wymaga co najmniej ${BASAL_MIN_RATINGS} ocen (zakładek i feedów).`,
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

  scoreFeeds: sessionProcedure
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
      const [{ feeds }] = await ctx.db
        .select({ feeds: count() })
        .from(rssFeedsTable)
        .where(eq(rssFeedsTable.userId, userId));
      const limit = clamp(input?.limit ?? feeds, 1, BASAL_MAX_ITEMS_CAP);
      const jobId = await startBasalScoreFeedsJob(ctx.db, userId, limit);
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
    const activeCalibrationId = await getActiveCalibrationId(ctx.db, userId);

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

    const feedRatingRows = await ctx.db
      .select({
        feedId: basalFeedRatingsTable.feedId,
        rating: basalFeedRatingsTable.rating,
      })
      .from(basalFeedRatingsTable)
      .where(eq(basalFeedRatingsTable.userId, userId));
    const userRatings = new Map(
      feedRatingRows.map((r) => [r.feedId, r.rating as BasalRating]),
    );

    const feedScoreRows = await ctx.db
      .select({
        feedId: basalFeedScoresTable.feedId,
        label: basalFeedScoresTable.label,
        confidence: basalFeedScoresTable.confidence,
        expectedLevel: basalFeedScoresTable.expectedLevel,
        calibrationId: basalFeedScoresTable.calibrationId,
      })
      .from(basalFeedScoresTable)
      .where(eq(basalFeedScoresTable.userId, userId));
    const feedScores = new Map(feedScoreRows.map((r) => [r.feedId, r]));

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
      const userRating = userRatings.get(feed.id) ?? null;
      const feedScore = feedScores.get(feed.id);
      const basalFeedScore = feedScore
        ? {
            label: feedScore.label as BasalLabel,
            confidence: feedScore.confidence,
            expectedLevel: feedScore.expectedLevel,
            stale: isScoreStale(feedScore.calibrationId, activeCalibrationId),
          }
        : null;

      // Value behind the disable suggestion, most specific evidence first:
      //   1. mean of article scores once at least 10 articles are scored,
      //   2. otherwise the feed-level Basal score,
      //   3. otherwise the user's own feed rating (0..2).
      // Display only: nothing here writes to rssFeeds, and a feed rating never
      // disables a feed by itself.
      let decisionValue: number | null = null;
      if (
        meanExpectedLevel !== null &&
        scoredCount >= FEED_QUALITY_MIN_SCORED
      ) {
        decisionValue = meanExpectedLevel;
      } else if (basalFeedScore) {
        decisionValue = basalFeedScore.expectedLevel;
      } else if (userRating !== null) {
        decisionValue = userRating;
      }

      return {
        feedId: feed.id,
        name: feed.name,
        enabled: feed.enabled,
        scoredCount,
        meanExpectedLevel,
        articleMean: meanExpectedLevel,
        weakShare,
        userRating,
        basalFeedScore,
        suggestDisable: decisionValue !== null && decisionValue < 1.0,
      };
    });
  }),
});
