import { afterEach, describe, expect, test, vi } from "vitest";

import {
  BasalBridgeError,
  BasalClient,
  BasalUnavailableError,
  mockProbabilities,
} from "./client";
import { buildDataset, buildLabelledRequest, groupFor } from "./dataset";
import {
  isScoreStale,
  isWeakByThreshold,
  labelFromAnswer,
  shouldAutoArchive,
  USEFULNESS_QUESTION,
} from "./decision";
import { BASAL_STATE_CHAR_CAP, buildBasalState } from "./state";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("BasalClient errors", () => {
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
    expect((err as Error).message).toContain("no response within 1800 s");
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

describe("dataset", () => {
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
