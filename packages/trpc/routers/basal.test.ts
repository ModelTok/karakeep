import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  basalCalibrationsTable,
  basalJobsTable,
  basalRatingsTable,
  basalScoresTable,
  bookmarkLinks,
  bookmarks,
  bookmarkTags,
  rssFeedImportsTable,
  rssFeedsTable,
  tagsOnBookmarks,
} from "@karakeep/db/schema";
import type { BasalClient } from "@karakeep/shared/basal/client";
import type {
  BasalProbabilities,
  BasalScoreItem,
  BasalScoreResponse,
} from "@karakeep/shared/basal/types";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";

import { BASAL_WEAK_TAG, basalJobsTestSeam } from "../lib/basalJobs";
import type { CustomTestContext, TestDB } from "../testUtils";
import { defaultBeforeEach } from "../testUtils";

beforeEach<CustomTestContext>(defaultBeforeEach(true));

afterEach(async () => {
  await basalJobsTestSeam.waitForIdle();
  basalJobsTestSeam.setBeforeRun(null);
  basalJobsTestSeam.setClientFactory(null);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

interface FakeClientOptions {
  probabilities?: (item: BasalScoreItem) => BasalProbabilities;
  gate?: Promise<void>;
}

function fakeClient(opts: FakeClientOptions = {}) {
  const scoredIds: string[] = [];
  const trainCalls: string[][] = [];
  const client = {
    baseUrl: "http://fake-bridge",
    isMock: () => false,
    health: () =>
      Promise.resolve({
        ok: true,
        model: "mini",
        mode: "fit",
        calibration_id: null,
        engine_version: "1",
      }),
    score: async (items: BasalScoreItem[]): Promise<BasalScoreResponse> => {
      if (opts.gate) {
        await opts.gate;
      }
      scoredIds.push(...items.map((i) => i.id));
      return {
        results: items.map((i) => {
          const p = opts.probabilities?.(i) ?? {
            slaby: 0.1,
            sredni: 0.6,
            ciekawy: 0.3,
          };
          const label =
            p.slaby >= p.sredni && p.slaby >= p.ciekawy
              ? ("slaby" as const)
              : p.ciekawy > p.sredni
                ? ("ciekawy" as const)
                : ("sredni" as const);
          return {
            id: i.id,
            score: p.sredni + 2 * p.ciekawy,
            label,
            probabilities: p,
            confidence: Math.max(p.slaby, p.sredni, p.ciekawy),
            model: "mini",
            calibration_id: "cal-1",
            latency_ms: 1,
          };
        }),
      };
    },
    train: (requests: string[]) => {
      trainCalls.push(requests);
      return Promise.resolve({
        calibration_id: "cal-new",
        path: "/cal/cal-new.json",
        report: {
          accuracy: 0.8,
          ece: 0.05,
          decisions: requests.length,
          automated_share: 0.5,
          thresholds: {},
        },
      });
    },
  };
  basalJobsTestSeam.setClientFactory(() => client as unknown as BasalClient);
  return { client, scoredIds, trainCalls };
}

async function createBookmark(
  db: TestDB,
  userId: string,
  opts: { title?: string; html?: string | null; createdAt?: Date } = {},
) {
  const [b] = await db
    .insert(bookmarks)
    .values({
      userId,
      type: BookmarkTypes.LINK,
      title: opts.title ?? "Some title",
      createdAt: opts.createdAt ?? new Date(),
    })
    .returning();
  await db.insert(bookmarkLinks).values({
    id: b.id,
    url: "https://example.com/" + b.id,
    htmlContent:
      opts.html === undefined ? "<p>Article body about BIM</p>" : opts.html,
  });
  return b.id;
}

async function waitForJob(
  api: CustomTestContext["apiCallers"][number],
  id: string,
) {
  await basalJobsTestSeam.waitForIdle();
  return api.basal.job({ id });
}

describe("basal.rate", () => {
  test<CustomTestContext>("create, change, clear", async ({
    apiCallers,
    db,
  }) => {
    const userId = (await apiCallers[0].users.whoami()).id;
    const bookmarkId = await createBookmark(db, userId);
    const api = apiCallers[0].basal;

    expect(await api.rate({ bookmarkId, rating: 2 })).toMatchObject({
      bookmarkId,
      rating: 2,
    });
    expect(await api.rate({ bookmarkId, rating: 0 })).toMatchObject({
      rating: 0,
    });
    const rows = await db.select().from(basalRatingsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].rating).toBe(0);

    expect(await api.rate({ bookmarkId, rating: null })).toBeNull();
    expect(await db.select().from(basalRatingsTable)).toHaveLength(0);
    // Clearing a missing rating is a no-op.
    expect(await api.rate({ bookmarkId, rating: null })).toBeNull();
  });

  test<CustomTestContext>("rejects bookmarks of other users", async ({
    apiCallers,
    db,
  }) => {
    const otherId = (await apiCallers[1].users.whoami()).id;
    const bookmarkId = await createBookmark(db, otherId);
    await expect(
      apiCallers[0].basal.rate({ bookmarkId, rating: 1 }),
    ).rejects.toThrow(/Bookmark not found/);
  });
});

describe("basal.updateSettings", () => {
  test<CustomTestContext>("defaults and clamping", async ({ apiCallers }) => {
    const api = apiCallers[0].basal;
    fakeClient();
    const before = await api.status();
    expect(before.settings).toEqual({
      autoArchive: false,
      archiveThreshold: 0.34,
      minConfidence: 0.9,
      maxItems: 50,
    });
    const next = await api.updateSettings({
      archiveThreshold: 5,
      minConfidence: -1,
      maxItems: 1000,
    });
    expect(next).toEqual({
      autoArchive: false,
      archiveThreshold: 2,
      minConfidence: 0,
      maxItems: 200,
    });
    expect(
      await api.updateSettings({ autoArchive: true, maxItems: 0 }),
    ).toEqual({
      autoArchive: true,
      archiveThreshold: 2,
      minConfidence: 0,
      maxItems: 1,
    });
  });
});

describe("basal.train", () => {
  test<CustomTestContext>("refuses under 20 ratings", async ({
    apiCallers,
    db,
  }) => {
    const userId = (await apiCallers[0].users.whoami()).id;
    for (let i = 0; i < 19; i++) {
      const id = await createBookmark(db, userId);
      await apiCallers[0].basal.rate({ bookmarkId: id, rating: 1 });
    }
    await expect(apiCallers[0].basal.train()).rejects.toThrow(
      /Za mało ocen: 19/,
    );
    expect(await db.select().from(basalJobsTable)).toHaveLength(0);
  });

  test<CustomTestContext>("trains, activates the calibration and marks old scores stale", async ({
    apiCallers,
    db,
  }) => {
    const userId = (await apiCallers[0].users.whoami()).id;
    const api = apiCallers[0].basal;
    const { trainCalls } = fakeClient();
    for (let i = 0; i < 21; i++) {
      const id = await createBookmark(db, userId);
      await api.rate({ bookmarkId: id, rating: (i % 3) as 0 | 1 | 2 });
    }
    // One rating without usable text is skipped.
    const titleOnly = await createBookmark(db, userId, { html: null });
    await api.rate({ bookmarkId: titleOnly, rating: 0 });

    await db.insert(basalCalibrationsTable).values({
      id: "cal-old",
      userId,
      model: "mini",
      mode: "fit",
      targets: [],
      metrics: {},
      path: "/old",
      active: true,
    });
    const scoredBookmark = await createBookmark(db, userId);
    await db.insert(basalScoresTable).values({
      userId,
      bookmarkId: scoredBookmark,
      expectedLevel: 1,
      label: "sredni",
      probabilities: { slaby: 0, sredni: 1, ciekawy: 0 },
      confidence: 1,
      model: "mini",
      calibrationId: "cal-old",
    });

    const { jobId, warnings } = await api.train();
    expect(warnings).toHaveLength(1);
    const job = await waitForJob(apiCallers[0], jobId);
    expect(job.status).toBe("success");
    expect(job.result).toMatchObject({
      calibrationId: "cal-new",
      labelled: 21,
      skipped: 1,
    });
    expect(trainCalls[0]).toHaveLength(21);
    const line = JSON.parse(trainCalls[0][0]) as {
      group: string;
      questions: { usefulness: { gold: number } };
    };
    expect(line.group).toBe("domain:example.com");

    const cals = await db
      .select()
      .from(basalCalibrationsTable)
      .where(eq(basalCalibrationsTable.userId, userId));
    expect(cals.find((c) => c.id === "cal-new")?.active).toBe(true);
    expect(cals.find((c) => c.id === "cal-old")?.active).toBe(false);

    const status = await api.status();
    expect(status.activeCalibration?.id).toBe("cal-new");
    expect(status.counts.stale).toBe(1);
    // The old score is kept as is.
    const [score] = await db.select().from(basalScoresTable);
    expect(score.calibrationId).toBe("cal-old");
  });
});

describe("basal score job", () => {
  test<CustomTestContext>("queued -> running -> success", async ({
    apiCallers,
    db,
  }) => {
    const userId = (await apiCallers[0].users.whoami()).id;
    const api = apiCallers[0].basal;
    for (let i = 0; i < 12; i++) {
      await createBookmark(db, userId);
    }
    const startGate = deferred();
    const scoreGate = deferred();
    const { scoredIds } = fakeClient({ gate: scoreGate.promise });
    basalJobsTestSeam.setBeforeRun(() => startGate.promise);

    const { jobId } = await api.scoreIncoming();
    expect((await api.job({ id: jobId })).status).toBe("queued");
    expect((await api.status()).runningJob?.id).toBe(jobId);

    await expect(api.scoreIncoming()).rejects.toThrow(/już w toku/);
    await expect(apiCallers[1].basal.scoreIncoming()).rejects.toThrow(
      /już w toku/,
    );

    startGate.resolve();
    for (let i = 0; i < 50; i++) {
      if ((await api.job({ id: jobId })).status === "running") break;
      await new Promise((r) => setImmediate(r));
    }
    expect((await api.job({ id: jobId })).status).toBe("running");

    scoreGate.resolve();
    const job = await waitForJob(apiCallers[0], jobId);
    expect(job.status).toBe("success");
    expect(job.total).toBe(12);
    expect(job.processed).toBe(12);
    expect(job.finishedAt).not.toBeNull();
    expect(job.result).toMatchObject({
      scored: 12,
      archived: 0,
      skippedTitleOnly: 0,
      failedBatches: 0,
      errors: [],
      mock: false,
    });
    expect(scoredIds).toHaveLength(12);
    expect(await db.select().from(basalScoresTable)).toHaveLength(12);
    expect((await api.status()).runningJob).toBeNull();
  });

  test<CustomTestContext>("never re-scores rated or scored bookmarks", async ({
    apiCallers,
    db,
  }) => {
    const userId = (await apiCallers[0].users.whoami()).id;
    const otherId = (await apiCallers[1].users.whoami()).id;
    const api = apiCallers[0].basal;
    const rated = await createBookmark(db, userId);
    const fresh = await createBookmark(db, userId);
    const archived = await createBookmark(db, userId);
    // Title-only: skipped and counted, never sent to the bridge.
    await createBookmark(db, userId, { html: null });
    await db
      .update(bookmarks)
      .set({ archived: true })
      .where(eq(bookmarks.id, archived));
    await createBookmark(db, otherId);
    await api.rate({ bookmarkId: rated, rating: 2 });

    const first = fakeClient();
    const job1 = await waitForJob(
      apiCallers[0],
      (await api.scoreIncoming()).jobId,
    );
    expect(first.scoredIds).toEqual([fresh]);
    expect(job1.result).toMatchObject({ scored: 1, skippedTitleOnly: 1 });

    const second = fakeClient();
    const job2 = await waitForJob(
      apiCallers[0],
      (await api.scoreIncoming()).jobId,
    );
    expect(second.scoredIds).toEqual([]);
    expect(job2.status).toBe("success");
    expect(job2.result).toMatchObject({ scored: 0 });
  });

  test<CustomTestContext>("bridge unavailable fails the job with a clear error", async ({
    apiCallers,
    db,
  }) => {
    const userId = (await apiCallers[0].users.whoami()).id;
    await createBookmark(db, userId);
    const { BasalClient } = await import("@karakeep/shared/basal/client");
    basalJobsTestSeam.setClientFactory(
      () =>
        new BasalClient({
          baseUrl: "http://bridge.invalid:8010",
          mock: false,
          fetchImpl: () => Promise.reject(new TypeError("fetch failed")),
        }),
    );
    const api = apiCallers[0].basal;
    const job = await waitForJob(
      apiCallers[0],
      (await api.scoreIncoming()).jobId,
    );
    expect(job.status).toBe("failure");
    expect(job.error).toContain("http://bridge.invalid:8010");
    const status = await api.status();
    expect(status.bridge.ok).toBe(false);
    expect(status.bridge.error).toContain("http://bridge.invalid:8010");
    expect(status.mock).toBe(false);
  });

  test.each([
    { autoArchive: true, slaby: 0.95, archived: true },
    { autoArchive: true, slaby: 0.85, archived: false },
    { autoArchive: false, slaby: 0.95, archived: false },
  ])(
    "auto-archive flag=$autoArchive p(slaby)=$slaby -> $archived",
    async ({ autoArchive, slaby, archived }) => {
      const ctx = {} as CustomTestContext;
      await defaultBeforeEach(true)(ctx);
      const { apiCallers, db } = ctx;
      const userId = (await apiCallers[0].users.whoami()).id;
      const api = apiCallers[0].basal;
      await api.updateSettings({ autoArchive, minConfidence: 0.9 });
      const id = await createBookmark(db, userId);
      fakeClient({
        probabilities: () => ({
          slaby,
          sredni: 1 - slaby,
          ciekawy: 0,
        }),
      });
      const job = await waitForJob(
        apiCallers[0],
        (await api.scoreIncoming()).jobId,
      );
      expect(job.result).toMatchObject({ archived: archived ? 1 : 0 });

      const b = await db.query.bookmarks.findFirst({
        where: eq(bookmarks.id, id),
      });
      expect(b?.archived).toBe(archived);
      const tag = await db.query.bookmarkTags.findFirst({
        where: and(
          eq(bookmarkTags.userId, userId),
          eq(bookmarkTags.name, BASAL_WEAK_TAG),
        ),
      });
      const attached = tag
        ? await db
            .select()
            .from(tagsOnBookmarks)
            .where(eq(tagsOnBookmarks.tagId, tag.id))
        : [];
      expect(attached.length).toBe(archived ? 1 : 0);
      // Never deleted.
      expect(b).toBeDefined();
    },
  );
});

describe("basal.feedQuality", () => {
  test<CustomTestContext>("aggregates scores per feed", async ({
    apiCallers,
    db,
  }) => {
    const userId = (await apiCallers[0].users.whoami()).id;
    const otherId = (await apiCallers[1].users.whoami()).id;
    const [feed] = await db
      .insert(rssFeedsTable)
      .values({ userId, name: "Weak feed", url: "https://weak/rss" })
      .returning();
    const [empty] = await db
      .insert(rssFeedsTable)
      .values({ userId, name: "Empty feed", url: "https://empty/rss" })
      .returning();
    await db
      .insert(rssFeedsTable)
      .values({ userId: otherId, name: "Foreign", url: "https://x/rss" });

    // 10 scored bookmarks: 6 at 0.2 (weak), 4 at 1.5 -> mean 0.72.
    for (let i = 0; i < 10; i++) {
      const id = await createBookmark(db, userId);
      await db
        .insert(rssFeedImportsTable)
        .values({ rssFeedId: feed.id, entryId: `e${i}`, bookmarkId: id });
      await db.insert(basalScoresTable).values({
        userId,
        bookmarkId: id,
        expectedLevel: i < 6 ? 0.2 : 1.5,
        label: i < 6 ? "slaby" : "sredni",
        probabilities: { slaby: 0, sredni: 0, ciekawy: 0 },
        confidence: 1,
        model: "mini",
        calibrationId: null,
      });
    }
    // An unscored import does not count.
    const unscored = await createBookmark(db, userId);
    await db
      .insert(rssFeedImportsTable)
      .values({ rssFeedId: feed.id, entryId: "u", bookmarkId: unscored });

    const result = await apiCallers[0].basal.feedQuality();
    expect(result).toHaveLength(2);
    const weak = result.find((r) => r.feedId === feed.id)!;
    expect(weak.name).toBe("Weak feed");
    expect(weak.enabled).toBe(true);
    expect(weak.scoredCount).toBe(10);
    expect(weak.meanExpectedLevel).toBeCloseTo(0.72, 5);
    expect(weak.weakShare).toBeCloseTo(0.6, 5);
    expect(weak.suggestDisable).toBe(true);

    const e = result.find((r) => r.feedId === empty.id)!;
    expect(e).toMatchObject({
      scoredCount: 0,
      meanExpectedLevel: null,
      weakShare: null,
      suggestDisable: false,
    });
  });
});
