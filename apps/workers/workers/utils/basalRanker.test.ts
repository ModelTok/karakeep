import { describe, expect, test, vi } from "vitest";

import type { DigestItem } from "./digestFormatter";
import {
  buildProfileText,
  buildRankRequest,
  candidateText,
  orderByScore,
  parseRankResponse,
  profileMode,
  rankWithBasal,
  selectPicks,
} from "./basalRanker";

const item = (
  id: number,
  title: string,
  domain = "example.com",
  summary: string | null = null,
): DigestItem => ({
  id,
  title,
  url: `https://${domain}/${id}`,
  domain,
  summary,
  tags: [],
});

const entry = (title: string, domain = "example.com") => ({ title, domain });

describe("profileMode", () => {
  test("uses favourites when there are any", () => {
    expect(
      profileMode({ favourites: [entry("a")], archived: [entry("b")] }),
    ).toBe("interest");
    expect(profileMode({ favourites: [entry("a")], archived: [] })).toBe(
      "interest",
    );
  });

  test("falls back to avoiding what was archived when there are no favourites", () => {
    expect(profileMode({ favourites: [], archived: [entry("b")] })).toBe(
      "avoid",
    );
  });

  test("has nothing to go on without either", () => {
    expect(profileMode({ favourites: [], archived: [] })).toBeNull();
  });
});

describe("buildProfileText", () => {
  test("lists favourites as interests and archived items as not interesting", () => {
    const text = buildProfileText(
      {
        favourites: [entry("SmolLM3", "huggingface.co")],
        archived: [entry("GTA 6 preload", "promptowy.com")],
      },
      "interest",
    );
    expect(text).toContain("FAVOURITED");
    expect(text).toContain("1. SmolLM3 (huggingface.co)");
    expect(text).toContain("ARCHIVED");
    expect(text).toContain("1. GTA 6 preload (promptowy.com)");
  });

  test("avoid mode mentions only the archived items", () => {
    const text = buildProfileText(
      { favourites: [], archived: [entry("GTA 6 preload", "promptowy.com")] },
      "avoid",
    );
    expect(text).not.toContain("FAVOURITED");
    expect(text).toContain("archives articles they are not interested in");
    expect(text).toContain("GTA 6 preload");
  });

  test("keeps the profile short enough for a small model's context", () => {
    const many = Array.from({ length: 200 }, (_, i) => entry(`title ${i}`));
    const text = buildProfileText(
      { favourites: many, archived: many },
      "interest",
    );
    const lines = text.split("\n").filter((l) => /^\d+\. /.test(l));
    expect(lines.length).toBeLessThanOrEqual(30 + 40);
    expect(text).toContain("title 0");
    expect(text).not.toContain("title 199");
  });

  test("trims very long titles and flattens whitespace", () => {
    const text = buildProfileText(
      { favourites: [entry(`${"word ".repeat(80)}\n\nend`)], archived: [] },
      "interest",
    );
    const line = text.split("\n").find((l) => l.startsWith("1. "))!;
    expect(line.length).toBeLessThanOrEqual(130);
    expect(line).not.toContain("\n");
  });
});

describe("candidateText", () => {
  test("is the title, the domain and a short note", () => {
    const text = candidateText(
      item(1, "Postgres 19", "snowflake.com", "A".repeat(400)),
    );
    expect(text.startsWith("Postgres 19 (snowflake.com). ")).toBe(true);
    expect(text.length).toBeLessThan(220);
  });

  test("copes with a missing note", () => {
    expect(candidateText(item(2, "No note", "a.com"))).toBe("No note (a.com).");
  });
});

describe("buildRankRequest", () => {
  const profile = { favourites: [entry("fav")], archived: [entry("arch")] };

  test("asks one rank question over the candidates, keyed by item id", () => {
    const req = buildRankRequest(
      profile,
      "interest",
      [item(3, "x"), item(5, "y")],
      {
        chunk: 40,
      },
    );
    const q = req.questions.best;
    expect(q.type).toBe("rank");
    expect(q.top).toBe(0);
    expect(q.chunk).toBe(40);
    expect(q.candidates.map((c) => c.key)).toEqual(["3", "5"]);
    expect(q.instructions).toContain("{candidate}");
    expect(q.instructions).toContain("interested");
    expect(req.state).toContain("fav");
  });

  test("avoid mode asks about archiving instead", () => {
    const req = buildRankRequest(
      { favourites: [], archived: [entry("arch")] },
      "avoid",
      [item(1, "x")],
      { chunk: 40 },
    );
    expect(req.questions.best.instructions).toContain("archives");
  });
});

describe("parseRankResponse", () => {
  const body = (ranking: { key: string; score: number }[]) => ({
    answers: { best: { type: "rank", ranking } },
  });

  test("interest mode keeps the score as is", () => {
    const m = parseRankResponse(
      body([
        { key: "2", score: 0.8 },
        { key: "1", score: 0.1 },
      ]),
      "interest",
    )!;
    expect(m.get(2)).toBeCloseTo(0.8);
    expect(m.get(1)).toBeCloseTo(0.1);
  });

  test("avoid mode flips it: a likely-archived article scores low", () => {
    const m = parseRankResponse(body([{ key: "7", score: 0.9 }]), "avoid")!;
    expect(m.get(7)).toBeCloseTo(0.1);
  });

  test("rejects anything that is not a ranking", () => {
    expect(parseRankResponse({}, "interest")).toBeNull();
    expect(parseRankResponse({ answers: {} }, "interest")).toBeNull();
    expect(parseRankResponse(null, "interest")).toBeNull();
    expect(
      parseRankResponse(body([{ key: "x", score: 0.5 }]), "interest"),
    ).toBeNull();
  });
});

describe("rankWithBasal", () => {
  const profile = { favourites: [entry("fav")], archived: [] };
  const items = [item(1, "a"), item(2, "b")];
  const cfg = { url: "http://host:8000/", timeoutMs: 5000, chunk: 40 };
  const ok = (ranking: { key: string; score: number }[]) =>
    vi.fn(
      async () =>
        new Response(JSON.stringify({ answers: { best: { ranking } } }), {
          status: 200,
        }),
    );

  test("returns scores keyed by item id", async () => {
    const fetchImpl = ok([
      { key: "1", score: 0.2 },
      { key: "2", score: 0.7 },
    ]);
    const scores = await rankWithBasal(cfg, profile, items, { fetchImpl });
    expect(scores?.get(2)).toBeCloseTo(0.7);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://host:8000/v1/systemone");
    expect(init.method).toBe("POST");
  });

  test("sends the API key when there is one", async () => {
    const fetchImpl = ok([{ key: "1", score: 0.2 }]);
    await rankWithBasal({ ...cfg, apiKey: "secret" }, profile, items, {
      fetchImpl,
    });
    const init = (
      fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    )[1];
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer secret",
    );
  });

  test("a server that is down, slow or wrong gives null, never an error", async () => {
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(
      await rankWithBasal(cfg, profile, items, { fetchImpl: down }),
    ).toBeNull();
    const bad = vi.fn(async () => new Response("nope", { status: 503 }));
    expect(
      await rankWithBasal(cfg, profile, items, { fetchImpl: bad }),
    ).toBeNull();
    const garbage = vi.fn(
      async () => new Response("{not json", { status: 200 }),
    );
    expect(
      await rankWithBasal(cfg, profile, items, { fetchImpl: garbage }),
    ).toBeNull();
  });

  test("skips the call when there is no taste signal or nothing to rank", async () => {
    const fetchImpl = ok([]);
    expect(
      await rankWithBasal(cfg, { favourites: [], archived: [] }, items, {
        fetchImpl,
      }),
    ).toBeNull();
    expect(await rankWithBasal(cfg, profile, [], { fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("selectPicks and orderByScore", () => {
  const items = [item(1, "a"), item(2, "b"), item(3, "c"), item(4, "d")];
  const scores = new Map([
    [1, 0.2],
    [2, 0.9],
    [3, 0.5],
    [4, 0.9],
  ]);

  test("picks the best n, breaking ties by the earlier article", () => {
    expect(selectPicks(items, scores, 3).map((i) => i.id)).toEqual([2, 4, 3]);
  });

  test("can leave articles out", () => {
    expect(
      selectPicks(items, scores, 2, new Set([2])).map((i) => i.id),
    ).toEqual([4, 3]);
  });

  test("an unscored article ranks last", () => {
    const partial = new Map([[3, 0.4]]);
    expect(selectPicks(items, partial, 4).map((i) => i.id)).toEqual([
      3, 1, 2, 4,
    ]);
  });

  test("orders every article by score, best first", () => {
    expect(orderByScore(items, scores).map((i) => i.id)).toEqual([2, 4, 3, 1]);
  });

  test("n of zero picks nothing", () => {
    expect(selectPicks(items, scores, 0)).toEqual([]);
  });
});
