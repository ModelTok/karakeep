import { afterEach, describe, expect, test, vi } from "vitest";

import {
  BASAL_SCORE_PER_DECISION_TIMEOUT_MS,
  BASAL_SCORE_TIMEOUT_MS,
  BasalBridgeError,
  BasalClient,
  BasalUnavailableError,
  mockProbabilities,
  scoreTimeoutForBatch,
} from "./client";
import {
  buildDataset,
  buildFeedLabelledRequest,
  buildLabelledRequest,
  groupFor,
} from "./dataset";
import {
  FEED_VALUE_QUESTION,
  isScoreStale,
  isWeakByThreshold,
  labelFromAnswer,
  shouldAutoArchive,
  USEFULNESS_QUESTION,
} from "./decision";
import {
  BASAL_FEED_HEADLINE_COUNT,
  BASAL_FEED_STATE_KIND,
  BASAL_FEED_VIDEO_COUNT,
  BASAL_FEED_VIDEO_TRANSCRIPT_CHARS,
  BASAL_STATE_CHAR_CAP,
  BASAL_TRAIN_STATE_CHAR_CAP,
  buildBasalFeedState,
  buildBasalState,
  capTrainState,
  isYoutubeVideoUrl,
} from "./state";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("BasalClient errors", () => {
  test("score budget grows with the batch and stays under the cap", () => {
    // The bridge scores one /score request sequentially, so a 10-item batch
    // needs 10 x the per-decision budget (the undici dispatcher uses it as
    // its headers timeout, Node's global fetch would cap it at 300 s).
    expect(scoreTimeoutForBatch(1)).toBe(BASAL_SCORE_PER_DECISION_TIMEOUT_MS);
    expect(scoreTimeoutForBatch(10)).toBe(
      10 * BASAL_SCORE_PER_DECISION_TIMEOUT_MS,
    );
    expect(scoreTimeoutForBatch(50)).toBe(BASAL_SCORE_TIMEOUT_MS);
  });

  test("unreachable base URL -> BasalUnavailableError with URL", async () => {
    vi.stubEnv("BASAL_MOCK", "");
    // Port 9 on localhost is (almost) never listening; fetch fails to connect.
    const client = new BasalClient({ baseUrl: "http://127.0.0.1:9" });
    const err = await client.health().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BasalUnavailableError);
    expect((err as Error).message).toContain("http://127.0.0.1:9");
  });

  test("injected fetch rejection -> BasalUnavailableError", async () => {
    const client = new BasalClient({
      baseUrl: "http://bridge.test:8010/",
      mock: false,
      fetchImpl: () => Promise.reject(new TypeError("fetch failed")),
    });
    const err = await client.score([{ id: "a", state: "x" }]).catch((e) => e);
    expect(err).toBeInstanceOf(BasalUnavailableError);
    expect((err as Error).message).toContain("http://bridge.test:8010");
  });

  test("timeout -> BasalUnavailableError", async () => {
    const abort = new Error("timed out");
    abort.name = "TimeoutError";
    const client = new BasalClient({
      baseUrl: "http://bridge.test",
      mock: false,
      fetchImpl: () => Promise.reject(abort),
    });
    const err = await client.train(["{}"]).catch((e) => e);
    expect(err).toBeInstanceOf(BasalUnavailableError);
    expect((err as Error).message).toContain("no response within 3600 s");
  });

  test("500 -> BasalBridgeError with status and body excerpt", async () => {
    const client = new BasalClient({
      baseUrl: "http://bridge.test",
      mock: false,
      fetchImpl: () =>
        Promise.resolve(new Response("engine exploded", { status: 500 })),
    });
    const err = await client.health().catch((e) => e);
    expect(err).toBeInstanceOf(BasalBridgeError);
    expect((err as BasalBridgeError).status).toBe(500);
    expect((err as BasalBridgeError).bodyExcerpt).toBe("engine exploded");
    expect((err as Error).message).toContain("500");
  });

  test("invalid payload -> BasalBridgeError", async () => {
    const client = new BasalClient({
      baseUrl: "http://bridge.test",
      mock: false,
      fetchImpl: () => Promise.resolve(Response.json({ results: [{ id: 1 }] })),
    });
    await expect(client.score([])).rejects.toBeInstanceOf(BasalBridgeError);
  });

  test("passes body and parses a valid score response", async () => {
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(init!.body as string) as {
          items: { id: string }[];
        };
        return Promise.resolve(
          Response.json({
            results: body.items.map((i) => ({
              id: i.id,
              score: 1,
              label: "sredni",
              probabilities: { slaby: 0.1, sredni: 0.8, ciekawy: 0.1 },
              confidence: 0.8,
              model: "mini",
              calibration_id: "cal",
              latency_ms: 12,
            })),
          }),
        );
      },
    );
    const client = new BasalClient({
      baseUrl: "http://bridge.test",
      mock: false,
      fetchImpl,
    });
    const res = await client.score([{ id: "b1", state: "s" }]);
    expect(fetchImpl.mock.calls[0][0]).toBe("http://bridge.test/score");
    expect(res.results[0].id).toBe("b1");
    expect(res.mock).toBeUndefined();
    expect(JSON.parse(fetchImpl.mock.calls[0][1]!.body as string)).toEqual({
      items: [{ id: "b1", state: "s" }],
    });
  });

  test("score sends question and questionName when provided", async () => {
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, _init?: RequestInit) =>
        Promise.resolve(Response.json({ results: [] })),
    );
    const client = new BasalClient({
      baseUrl: "http://bridge.test",
      mock: false,
      fetchImpl,
    });
    const question = {
      type: FEED_VALUE_QUESTION.type,
      instructions: FEED_VALUE_QUESTION.instructions,
      criteria: [...FEED_VALUE_QUESTION.criteria],
    };
    await client.score([{ id: "f1", state: "Feed: X" }], {
      question,
      questionName: "feed_value",
    });
    await client.score([{ id: "f2", state: "Feed: Y" }], {
      questionName: "feed_value",
    });
    const bodies = fetchImpl.mock.calls.map(
      (call) => JSON.parse(call[1]!.body as string) as unknown,
    );
    expect(bodies[0]).toEqual({
      items: [{ id: "f1", state: "Feed: X" }],
      question,
      questionName: "feed_value",
    });
    expect(bodies[1]).toEqual({
      items: [{ id: "f2", state: "Feed: Y" }],
      questionName: "feed_value",
    });
  });

  // Regression: the real bridge reports automated_share as a per-target map,
  // not a number. Rejecting it would fail every real calibration job.
  test("train accepts the real bridge report shape", async () => {
    const bridgeReport = {
      accuracy: 0.917,
      ece: 0.536,
      decisions: 12,
      fit: { decisions: 8 },
      cert: { decisions: 4 },
      automated_share: {
        "0.05": { coverage: "0%", error: "0%" },
      },
      thresholds: {},
      raw: "score ...",
    };
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          calibration_id: "abc123",
          path: "/tmp/abc123.json",
          report: bridgeReport,
        }),
      ),
    );
    const client = new BasalClient({
      baseUrl: "http://bridge.test",
      mock: false,
      fetchImpl,
    });
    const res = await client.train([JSON.stringify({ id: "a" })]);
    expect(res.calibration_id).toBe("abc123");
    expect(res.report.decisions).toBe(12);
    expect(res.report.automated_share).toEqual(bridgeReport.automated_share);
  });
});

describe("BasalClient mock", () => {
  test("BASAL_MOCK is read at call time and results are deterministic", async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error("must not call")));
    const client = new BasalClient({ baseUrl: "http://x", fetchImpl });
    vi.stubEnv("BASAL_MOCK", "1");
    const a = await client.score([
      { id: "1", state: "hello" },
      { id: "2", state: "hello" },
    ]);
    const b = await client.score([{ id: "1", state: "hello" }]);
    expect(a.mock).toBe(true);
    expect(a.results[0]).toEqual(b.results[0]);
    expect(a.results[0]).not.toEqual({ ...a.results[1], id: "1" });
    const p = a.results[0].probabilities;
    expect(p.slaby + p.sredni + p.ciekawy).toBeCloseTo(1, 3);
    expect(a.results[0].label).toBe(labelFromAnswer(p));
    expect((await client.health()).mock).toBe(true);
    expect((await client.train(["{}"])).mock).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();

    vi.stubEnv("BASAL_MOCK", "0");
    await expect(client.health()).rejects.toThrow();
  });

  test("mockProbabilities depends on id + state", () => {
    expect(mockProbabilities("a", "b")).toEqual(mockProbabilities("a", "b"));
    expect(mockProbabilities("a", "b")).not.toEqual(
      mockProbabilities("a", "c"),
    );
  });
});

describe("buildBasalState", () => {
  const base = {
    title: "BIM w praktyce",
    url: "https://www.example.com/a",
    domain: "example.com",
    tags: ["bim", "revit"],
  };

  test("title_only when there is no text, summary or description", () => {
    const s = buildBasalState({ ...base, feedName: "Feed X" });
    expect(s.stateKind).toBe("title_only");
    expect(s.state).toContain("Tytuł: BIM w praktyce");
    expect(s.state).toContain("Domena: example.com");
    expect(s.state).toContain("Feed: Feed X");
    expect(s.state).toContain("Tagi: bim, revit");
    expect(s.state).not.toContain("Treść:");
    expect(s.chars).toBe(s.state.length);
  });

  test("full when only a description exists", () => {
    const s = buildBasalState({ ...base, description: "Opis artykułu" });
    expect(s.stateKind).toBe("full");
    expect(s.state).toContain("Opis: Opis artykułu");
  });

  test("full with summary, whitespace-only text does not count", () => {
    expect(buildBasalState({ ...base, text: "   \n " }).stateKind).toBe(
      "title_only",
    );
    expect(buildBasalState({ ...base, summary: "sum" }).stateKind).toBe("full");
  });

  test("truncates to BASAL_STATE_CHAR_CAP", () => {
    const s = buildBasalState({ ...base, text: "a".repeat(50_000) });
    expect(BASAL_STATE_CHAR_CAP).toBe(12000);
    expect(s.chars).toBe(BASAL_STATE_CHAR_CAP);
    expect(s.state.length).toBe(BASAL_STATE_CHAR_CAP);
    expect(s.state.startsWith("Tytuł:")).toBe(true);
    expect(s.state).toContain("Treść: aaa");
  });
});

describe("buildBasalFeedState", () => {
  test("formats name, url, description and headlines", () => {
    const s = buildBasalFeedState({
      name: "  BIM   Blog ",
      url: "https://bim.example.com/feed",
      description: "Nowości\n o  BIM",
      headlines: ["Revit 2027", "   ", "IFC  5\nwydane"],
    });
    expect(s.state).toBe(
      [
        "Feed: BIM Blog",
        "URL: https://bim.example.com/feed",
        "Opis: Nowości o BIM",
        "Ostatnie nagłówki:",
        "- Revit 2027",
        "- IFC 5 wydane",
      ].join("\n"),
    );
    expect(s.chars).toBe(s.state.length);
    expect(BASAL_FEED_STATE_KIND).toBe("feed_summary");
  });

  test("omits empty description and headline block", () => {
    const s = buildBasalFeedState({
      name: "Feed X",
      url: "https://x.example.com",
      description: null,
      headlines: [],
    });
    expect(s.state).toBe("Feed: Feed X\nURL: https://x.example.com");
  });

  test("keeps only the first BASAL_FEED_HEADLINE_COUNT headlines", () => {
    const headlines = Array.from({ length: 15 }, (_, i) => `H${i + 1}`);
    const s = buildBasalFeedState({ name: "F", url: "u", headlines });
    expect(BASAL_FEED_HEADLINE_COUNT).toBe(10);
    const listed = s.state.split("\n").filter((l) => l.startsWith("- "));
    expect(listed).toHaveLength(BASAL_FEED_HEADLINE_COUNT);
    expect(listed[0]).toBe("- H1");
    expect(listed[9]).toBe("- H10");
    expect(s.state).not.toContain("H11");
  });

  test("truncates to BASAL_STATE_CHAR_CAP", () => {
    const s = buildBasalFeedState({
      name: "F",
      url: "u",
      description: "d".repeat(50_000),
      headlines: ["h"],
    });
    expect(s.chars).toBe(BASAL_STATE_CHAR_CAP);
    expect(s.state.startsWith("Feed: F\nURL: u\nOpis: ddd")).toBe(true);
  });

  test("appends transcripts of the newest videos", () => {
    const s = buildBasalFeedState({
      name: "YT feed",
      url: "https://www.youtube.com/feeds/videos.xml?channel_id=x",
      headlines: ["Odcinek 3"],
      videos: [
        { title: "Odcinek 2", transcript: "Pierwsza fraza transkryptu." },
        { title: null, transcript: "Druga transkrypcja." },
      ],
    });
    expect(s.state).toBe(
      [
        "Feed: YT feed",
        "URL: https://www.youtube.com/feeds/videos.xml?channel_id=x",
        "Ostatnie nagłówki:",
        "- Odcinek 3",
        "Transkrypcje najnowszych filmów:",
        "- Odcinek 2: Pierwsza fraza transkryptu.",
        "- Druga transkrypcja.",
      ].join("\n"),
    );
  });

  test("caps each transcript at BASAL_FEED_VIDEO_TRANSCRIPT_CHARS", () => {
    const s = buildBasalFeedState({
      name: "F",
      url: "u",
      headlines: [],
      videos: [{ title: "V", transcript: "x".repeat(10_000) }],
    });
    const line = s.state.split("\n").find((l) => l.startsWith("- V: "));
    expect(line).toBe(`- V: ${"x".repeat(BASAL_FEED_VIDEO_TRANSCRIPT_CHARS)}`);
  });

  test("keeps only the first BASAL_FEED_VIDEO_COUNT videos", () => {
    const videos = Array.from({ length: 5 }, (_, i) => ({
      title: `V${i + 1}`,
      transcript: `T${i + 1}`,
    }));
    const s = buildBasalFeedState({
      name: "F",
      url: "u",
      headlines: [],
      videos,
    });
    const listed = s.state.split("\n").filter((l) => l.startsWith("- V"));
    expect(BASAL_FEED_VIDEO_COUNT).toBe(2);
    expect(listed).toEqual(["- V1: T1", "- V2: T2"]);
    expect(s.state).not.toContain("V3");
  });

  test("keeps the headline-only state when the feed has no videos", () => {
    const withEmpty = buildBasalFeedState({
      name: "F",
      url: "u",
      headlines: ["H1"],
      videos: [],
    });
    const withoutVideos = buildBasalFeedState({
      name: "F",
      url: "u",
      headlines: ["H1"],
    });
    expect(withEmpty.state).toBe(withoutVideos.state);
    expect(withEmpty.state).not.toContain("Transkrypcje");
  });

  test("state with transcripts is deterministic for the same input", () => {
    const input = {
      name: "F",
      url: "u",
      headlines: ["H1", "H2"],
      videos: [
        { title: "V1", transcript: "To samo wejście." },
        { title: "V2", transcript: "Drugie wejście." },
      ],
    };
    expect(buildBasalFeedState(input).state).toBe(
      buildBasalFeedState(input).state,
    );
  });
});

describe("isYoutubeVideoUrl", () => {
  test("matches youtube.com watch and youtu.be URLs", () => {
    expect(isYoutubeVideoUrl("https://www.youtube.com/watch?v=abc123")).toBe(
      true,
    );
    expect(isYoutubeVideoUrl("https://youtu.be/abc123")).toBe(true);
    expect(isYoutubeVideoUrl("https://m.youtube.com/watch?v=abc123")).toBe(
      true,
    );
  });

  test("rejects unrelated URLs", () => {
    expect(isYoutubeVideoUrl("https://example.com/watch?v=abc123")).toBe(false);
    expect(isYoutubeVideoUrl("https://www.youtube.com/feeds/videos.xml")).toBe(
      false,
    );
  });
});

describe("dataset", () => {
  test("training states are capped independently of scoring states", () => {
    expect(BASAL_TRAIN_STATE_CHAR_CAP).toBeLessThan(BASAL_STATE_CHAR_CAP);
    const long = "x".repeat(BASAL_TRAIN_STATE_CHAR_CAP + 500);
    expect(capTrainState(long).length).toBe(BASAL_TRAIN_STATE_CHAR_CAP + 1);
    expect(capTrainState(long).endsWith("…")).toBe(true);
    expect(capTrainState("krótki")).toBe("krótki");

    const request = buildLabelledRequest({
      id: "b1",
      group: "g",
      state: long,
      rating: 1,
    });
    expect(request.state.length).toBe(BASAL_TRAIN_STATE_CHAR_CAP + 1);
    const feedRequest = buildFeedLabelledRequest({
      id: "feed:f1",
      group: "feed:f1",
      state: long,
      rating: 0,
    });
    expect(feedRequest.state.length).toBe(BASAL_TRAIN_STATE_CHAR_CAP + 1);
  });

  test("buildLabelledRequest uses the shared question and gold rating", () => {
    const r = buildLabelledRequest({
      id: "b1",
      group: "feed:f1",
      state: "s",
      rating: 2,
    });
    expect(r).toEqual({
      id: "b1",
      group: "feed:f1",
      state: "s",
      questions: {
        usefulness: {
          type: "score",
          instructions: USEFULNESS_QUESTION.instructions,
          criteria: [...USEFULNESS_QUESTION.criteria],
          gold: 2,
        },
      },
    });
    expect(r.questions.usefulness.criteria).toHaveLength(3);
    expect(r.questions.usefulness.criteria[0].startsWith("slaby - ")).toBe(
      true,
    );
  });

  test("buildDataset maps gold and skips title_only", () => {
    const { lines, skipped } = buildDataset([
      { id: "1", group: "g", state: "a", stateKind: "full", rating: 0 },
      { id: "2", group: "g", state: "b", stateKind: "title_only", rating: 1 },
      { id: "3", group: "g", state: "c", stateKind: "full", rating: 1 },
      { id: "4", group: "g", state: "d", stateKind: "title_only", rating: 2 },
    ]);
    expect(skipped).toBe(2);
    expect(lines).toHaveLength(2);
    const parsed = lines.map(
      (l) =>
        JSON.parse(l) as {
          id: string;
          questions: { usefulness: { gold: number } };
        },
    );
    expect(parsed.map((p) => [p.id, p.questions.usefulness.gold])).toEqual([
      ["1", 0],
      ["3", 1],
    ]);
  });

  test("buildLabelledRequest adds feed_value only with a feedRating", () => {
    const base = { id: "b1", group: "feed:f1", state: "s", rating: 1 as const };
    expect(buildLabelledRequest(base).questions.feed_value).toBeUndefined();
    expect(
      buildLabelledRequest({ ...base, feedRating: null }).questions,
    ).not.toHaveProperty("feed_value");
    const r = buildLabelledRequest({ ...base, feedRating: 0 });
    expect(r.questions.usefulness.gold).toBe(1);
    expect(r.questions.feed_value).toEqual({
      type: "score",
      instructions: FEED_VALUE_QUESTION.instructions,
      criteria: [...FEED_VALUE_QUESTION.criteria],
      gold: 0,
    });
  });

  test("buildFeedLabelledRequest carries only feed_value", () => {
    const r = buildFeedLabelledRequest({
      id: "feed:f1",
      group: "feed:f1",
      state: "Feed: X",
      rating: 2,
    });
    expect(r).toEqual({
      id: "feed:f1",
      group: "feed:f1",
      state: "Feed: X",
      questions: {
        feed_value: {
          type: "score",
          instructions: FEED_VALUE_QUESTION.instructions,
          criteria: [...FEED_VALUE_QUESTION.criteria],
          gold: 2,
        },
      },
    });
    expect(Object.keys(r.questions)).toEqual(["feed_value"]);
  });

  test("buildDataset counts articles, feed questions and standalone feeds", () => {
    const result = buildDataset(
      [
        {
          id: "1",
          group: "feed:f1",
          state: "a",
          stateKind: "full",
          rating: 0,
          feedRating: 2,
        },
        {
          id: "2",
          group: "feed:f1",
          state: "b",
          stateKind: "title_only",
          rating: 1,
          feedRating: 2,
        },
        {
          id: "3",
          group: "domain:x",
          state: "c",
          stateKind: "full",
          rating: 1,
        },
      ],
      [{ id: "feed:f1", group: "feed:f1", state: "Feed: F1", rating: 2 }],
    );
    expect(result.articles).toBe(2);
    expect(result.feedQuestions).toBe(1);
    expect(result.standaloneFeeds).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.lines).toHaveLength(3);
    const parsed = result.lines.map(
      (l) =>
        JSON.parse(l) as {
          id: string;
          questions: Record<string, { gold: number }>;
        },
    );
    expect(parsed.map((p) => p.id)).toEqual(["1", "3", "feed:f1"]);
    expect(parsed[0].questions.feed_value.gold).toBe(2);
    expect(parsed[1].questions).not.toHaveProperty("feed_value");
    expect(Object.keys(parsed[2].questions)).toEqual(["feed_value"]);
  });

  test("buildDataset without feed entries keeps zero feed counts", () => {
    const result = buildDataset([
      { id: "1", group: "g", state: "a", stateKind: "full", rating: 0 },
    ]);
    expect(result).toMatchObject({
      articles: 1,
      feedQuestions: 0,
      standaloneFeeds: 0,
      skipped: 0,
    });
  });

  test("groupFor prefers feed over domain", () => {
    expect(groupFor({ feedId: "f1", domain: "example.com" })).toBe("feed:f1");
    expect(groupFor({ feedId: null, domain: "example.com" })).toBe(
      "domain:example.com",
    );
    expect(groupFor({ domain: "example.com" })).toBe("domain:example.com");
  });
});

describe("decision", () => {
  const strongWeak = { slaby: 0.95, sredni: 0.04, ciekawy: 0.01 };
  const settings = {
    autoArchive: true,
    archiveThreshold: 0.34,
    minConfidence: 0.9,
  };

  test.each([
    // autoArchive, label, p(slaby), minConfidence, expected
    [true, "slaby", 0.95, 0.9, true],
    [true, "slaby", 0.9, 0.9, true],
    [true, "slaby", 0.89, 0.9, false],
    [false, "slaby", 0.95, 0.9, false],
    [true, "sredni", 0.95, 0.9, false],
    [true, "ciekawy", 0.95, 0.9, false],
    [false, "sredni", 0.5, 0.9, false],
    [true, "slaby", 0.5, 0.0, true],
  ] as const)(
    "shouldAutoArchive(flag=%s, label=%s, p=%s, min=%s) = %s",
    (autoArchive, label, p, minConfidence, expected) => {
      expect(
        shouldAutoArchive({
          label,
          probabilities: { slaby: p, sredni: 1 - p, ciekawy: 0 },
          expectedLevel: 1 - p,
          settings: { ...settings, autoArchive, minConfidence },
        }),
      ).toBe(expected);
    },
  );

  test("shouldAutoArchive ignores expectedLevel and archiveThreshold", () => {
    expect(
      shouldAutoArchive({
        label: "slaby",
        probabilities: strongWeak,
        expectedLevel: 1.9,
        settings: { ...settings, archiveThreshold: 0 },
      }),
    ).toBe(true);
  });

  test("isWeakByThreshold is strict", () => {
    expect(isWeakByThreshold(0.2, 0.34)).toBe(true);
    expect(isWeakByThreshold(0.34, 0.34)).toBe(false);
    expect(isWeakByThreshold(1, 0.34)).toBe(false);
  });

  test("labelFromAnswer picks argmax", () => {
    expect(labelFromAnswer(strongWeak)).toBe("slaby");
    expect(labelFromAnswer({ slaby: 0.1, sredni: 0.7, ciekawy: 0.2 })).toBe(
      "sredni",
    );
    expect(labelFromAnswer({ slaby: 0.1, sredni: 0.2, ciekawy: 0.7 })).toBe(
      "ciekawy",
    );
  });

  test("labelFromAnswer ties go to the higher-value label", () => {
    expect(labelFromAnswer({ slaby: 0.5, sredni: 0.5, ciekawy: 0 })).toBe(
      "sredni",
    );
    expect(labelFromAnswer({ slaby: 0.5, sredni: 0, ciekawy: 0.5 })).toBe(
      "ciekawy",
    );
    expect(labelFromAnswer({ slaby: 0, sredni: 0.5, ciekawy: 0.5 })).toBe(
      "ciekawy",
    );
    expect(
      labelFromAnswer({ slaby: 1 / 3, sredni: 1 / 3, ciekawy: 1 / 3 }),
    ).toBe("ciekawy");
  });

  test("isScoreStale", () => {
    expect(isScoreStale(null, null)).toBe(false);
    expect(isScoreStale("a", null)).toBe(false);
    expect(isScoreStale("a", "a")).toBe(false);
    expect(isScoreStale("a", "b")).toBe(true);
    expect(isScoreStale(null, "b")).toBe(true);
  });
});
