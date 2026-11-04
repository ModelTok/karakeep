import type { DigestItem } from "./digestFormatter";

/**
 * Ranks digest articles by how well they fit the reader's taste, using a Basal
 * decision server (https://github.com/rkinas/basal). Basal answers typed
 * questions with calibrated probabilities in one forward pass; its `rank` type
 * judges every candidate with one yes/no question, in batches that share the
 * reader profile.
 *
 * The taste profile is what the reader has already told us: the articles they
 * favourited (interested) and the ones they archived (not interested). Anything
 * that goes wrong here returns `null` so the digest falls back to how it worked
 * before; a recommendation engine must never cost anyone their digest.
 */

export interface TasteEntry {
  title: string;
  domain: string;
}

export interface RankProfile {
  favourites: TasteEntry[];
  archived: TasteEntry[];
}

/** "interest": rank by P(reader would favourite it). "avoid": only archived items are known, so rank by 1 - P(reader would archive it). */
export type RankMode = "interest" | "avoid";

export interface BasalConfig {
  url: string;
  apiKey?: string;
  timeoutMs: number;
  chunk: number;
}

// A small model reads the whole profile for every batch, so keep it short.
const MAX_FAVOURITES = 30;
const MAX_ARCHIVED = 40;
const TITLE_CHARS = 90;
const NOTE_CHARS = 150;

const INTEREST_QUESTION =
  "Is {candidate} an article this reader would be interested in and favourite, rather than archive?";
const AVOID_QUESTION =
  "Is {candidate} the kind of article this reader archives because they are not interested in it?";

const flat = (text: string) => text.replace(/\s+/g, " ").trim();

export function profileMode(profile: RankProfile): RankMode | null {
  if (profile.favourites.length > 0) {
    return "interest";
  }
  return profile.archived.length > 0 ? "avoid" : null;
}

function profileLines(entries: TasteEntry[], max: number): string {
  return entries
    .slice(0, max)
    .map(
      (e, i) =>
        `${i + 1}. ${flat(e.title).slice(0, TITLE_CHARS)} (${e.domain})`,
    )
    .join("\n");
}

export function buildProfileText(profile: RankProfile, mode: RankMode): string {
  if (mode === "avoid") {
    return (
      "Reader profile. This reader archives articles they are not interested in. " +
      "Articles the reader ARCHIVED (not interested):\n" +
      profileLines(profile.archived, MAX_ARCHIVED)
    );
  }
  let text =
    "Reader profile.\nArticles the reader FAVOURITED (interested, wants more like these):\n" +
    profileLines(profile.favourites, MAX_FAVOURITES);
  if (profile.archived.length > 0) {
    text +=
      "\n\nArticles the reader ARCHIVED (not interested):\n" +
      profileLines(profile.archived, MAX_ARCHIVED);
  }
  return text;
}

export function candidateText(item: DigestItem): string {
  const head = `${flat(item.title)} (${item.domain}).`;
  const note = item.summary ? flat(item.summary).slice(0, NOTE_CHARS) : "";
  return note ? `${head} ${note}` : head;
}

export function buildRankRequest(
  profile: RankProfile,
  mode: RankMode,
  items: DigestItem[],
  opts: { chunk: number },
) {
  return {
    state: buildProfileText(profile, mode),
    questions: {
      best: {
        type: "rank" as const,
        instructions: mode === "interest" ? INTEREST_QUESTION : AVOID_QUESTION,
        label: "Article",
        list_title: "Articles",
        top: 0,
        chunk: opts.chunk,
        candidates: items.map((i) => ({
          key: String(i.id),
          text: candidateText(i),
        })),
      },
    },
  };
}

/** Item id -> score, higher is a better fit, or null if the body is not a usable ranking. */
export function parseRankResponse(
  body: unknown,
  mode: RankMode,
): Map<number, number> | null {
  const ranking = (
    body as { answers?: { best?: { ranking?: unknown } } } | null
  )?.answers?.best?.ranking;
  if (!Array.isArray(ranking) || ranking.length === 0) {
    return null;
  }
  const scores = new Map<number, number>();
  for (const entry of ranking as { key?: unknown; score?: unknown }[]) {
    const id = Number(entry?.key);
    if (!Number.isInteger(id) || typeof entry?.score !== "number") {
      return null;
    }
    scores.set(id, mode === "avoid" ? 1 - entry.score : entry.score);
  }
  return scores;
}

export async function rankWithBasal(
  cfg: BasalConfig,
  profile: RankProfile,
  items: DigestItem[],
  opts: {
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    onError?: (message: string) => void;
  } = {},
): Promise<Map<number, number> | null> {
  const mode = profileMode(profile);
  if (!mode || items.length === 0) {
    return null;
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (cfg.apiKey) {
    headers.authorization = `Bearer ${cfg.apiKey}`;
  }
  const signals = [AbortSignal.timeout(cfg.timeoutMs)];
  if (opts.signal) {
    signals.push(opts.signal);
  }
  try {
    const res = await fetchImpl(`${cfg.url.replace(/\/+$/, "")}/v1/systemone`, {
      method: "POST",
      headers,
      body: JSON.stringify(
        buildRankRequest(profile, mode, items, { chunk: cfg.chunk }),
      ),
      signal: AbortSignal.any(signals),
    });
    if (!res.ok) {
      opts.onError?.(`Basal answered HTTP ${res.status}`);
      return null;
    }
    const scores = parseRankResponse(await res.json(), mode);
    if (!scores) {
      opts.onError?.("Basal's answer was not a ranking");
    }
    return scores;
  } catch (error) {
    opts.onError?.(`Basal request failed: ${error}`);
    return null;
  }
}

function byScore(scores: Map<number, number>) {
  return (a: DigestItem, b: DigestItem) =>
    (scores.get(b.id) ?? -Infinity) - (scores.get(a.id) ?? -Infinity) ||
    a.id - b.id;
}

/** Every article, best fit first (ties keep the order they were saved in). */
export function orderByScore(
  items: DigestItem[],
  scores: Map<number, number>,
): DigestItem[] {
  return [...items].sort(byScore(scores));
}

/** The n best-fitting articles, leaving out any ids in `exclude`. */
export function selectPicks(
  items: DigestItem[],
  scores: Map<number, number>,
  n: number,
  exclude = new Set<number>(),
): DigestItem[] {
  if (n <= 0) {
    return [];
  }
  return orderByScore(
    items.filter((i) => !exclude.has(i.id)),
    scores,
  ).slice(0, n);
}
