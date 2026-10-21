export interface DigestRow {
  title: string | null;
  url: string;
  summary: string | null;
  tags: string[];
}

export interface DigestItem {
  // 1-based id the model cites as [#id]
  id: number;
  title: string;
  url: string;
  domain: string;
  summary: string | null;
  tags: string[];
}

const SUMMARY_CHARS_FOR_PROMPT = 280;
const SUMMARY_CHARS_FALLBACK = 160;
const FALLBACK_HIGHLIGHTS = 8;
const ALSO_SAVED_LIMIT = 25;

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Canonical form of a URL for spotting the same page saved twice. */
export function normaliseUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|ref$|ref_src$)/i.test(key)) {
        u.searchParams.delete(key);
      }
    }
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.hostname.replace(/^www\./, "").toLowerCase()}${path}${u.search}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

function normaliseTitle(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function cleanTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim();
}

/**
 * Keep whole sentences up to `maxChars`; if even the first one is too long,
 * cut it at a word boundary.
 */
export function condense(text: string | null, maxChars: number): string | null {
  const flat = text?.replace(/\s+/g, " ").trim();
  if (!flat) {
    return null;
  }
  if (flat.length <= maxChars) {
    return flat;
  }
  let out = "";
  for (const sentence of flat.split(/(?<=[.!?])\s+/)) {
    const next = out ? `${out} ${sentence}` : sentence;
    if (next.length > maxChars) {
      break;
    }
    out = next;
  }
  if (out) {
    return out;
  }
  const cut = flat.slice(0, maxChars - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxChars / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Drop repeats (same page or same title saved twice, merging their tags) and
 * number what is left.
 */
export function prepareDigestItems(rows: DigestRow[]): DigestItem[] {
  const seen = new Map<string, DigestItem>();
  const items: DigestItem[] = [];

  for (const row of rows) {
    const title = cleanTitle(row.title ?? "") || row.url;
    const urlKey = normaliseUrl(row.url);
    const titleKey = row.title ? `t:${normaliseTitle(title)}` : null;

    const existing =
      seen.get(urlKey) ?? (titleKey ? seen.get(titleKey) : undefined);
    if (existing) {
      existing.tags = [...new Set([...existing.tags, ...row.tags])];
      existing.summary ??= row.summary;
      continue;
    }

    const item: DigestItem = {
      id: items.length + 1,
      title,
      url: row.url,
      domain: getDomain(row.url),
      summary: row.summary,
      tags: [...new Set(row.tags)],
    };
    items.push(item);
    seen.set(urlKey, item);
    if (titleKey) {
      seen.set(titleKey, item);
    }
  }
  return items;
}

/** One compact line per item for the prompt. */
export function formatItemForPrompt(item: DigestItem): string {
  const parts = [`[#${item.id}] ${item.title} (${item.domain})`];
  if (item.tags.length > 0) {
    parts.push(`tags: ${item.tags.slice(0, 5).join(", ")}`);
  }
  const summary = condense(item.summary, SUMMARY_CHARS_FOR_PROMPT);
  if (summary) {
    parts.push(summary);
  }
  return parts.join(" | ");
}

/** Target length scales gently with the amount saved, but stays short. */
export function digestWordBudget(itemCount: number): number {
  return Math.min(450, Math.max(150, 120 + 12 * itemCount));
}

function link(text: string, url: string): string {
  const safe = text.replace(/[[\]]/g, "");
  return `[${safe}](${url.replace(/\)/g, "%29")})`;
}

function stripCodeFence(text: string): string {
  const match = text.trim().match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/);
  return (match ? match[1] : text).trim();
}

const CITATION_RUN = /(?:\[#\d+\]\s*)+/g;

/**
 * Replace the model's [#id] citations with real links: a bullet that opens
 * with a citation becomes a bold title link, any other run of citations becomes
 * "(domain, domain)". Ids the model made up are dropped.
 */
function resolveCitations(
  body: string,
  byId: Map<number, DigestItem>,
  cited: Set<number>,
): string {
  const idsIn = (run: string) =>
    [...run.matchAll(/\[#(\d+)\]/g)]
      .map((m) => byId.get(Number(m[1])))
      .filter((i): i is DigestItem => i !== undefined);

  const inline = (text: string) =>
    text
      .replace(CITATION_RUN, (run) => {
        const found = idsIn(run);
        found.forEach((i) => cited.add(i.id));
        if (found.length === 0) {
          return "";
        }
        return `(${found.map((i) => link(i.domain, i.url)).join(", ")}) `;
      })
      .replace(/\s+([.,;:!?])/g, "$1")
      .replace(/\s+$/, "");

  return body
    .split("\n")
    .map((line) => {
      const bullet = line.match(/^(\s*[-*]\s+)((?:\[#\d+\]\s*)+)(.*)$/);
      if (!bullet) {
        return inline(line);
      }
      const [first, ...others] = idsIn(bullet[2]);
      if (!first) {
        return bullet[1] + inline(bullet[3]);
      }
      cited.add(first.id);
      others.forEach((i) => cited.add(i.id));
      const reason = inline(bullet[3].replace(/^[\s—–:-]+/, ""));
      const title = `**${link(first.title, first.url)}**`;
      return `${bullet[1]}${title}${reason ? ` — ${reason}` : ""}`;
    })
    .join("\n");
}

function alsoSaved(items: DigestItem[]): string {
  if (items.length === 0) {
    return "";
  }
  const shown = items
    .slice(0, ALSO_SAVED_LIMIT)
    .map((i) => `- ${link(i.title, i.url)}`);
  if (items.length > ALSO_SAVED_LIMIT) {
    shown.push(
      `- …and ${items.length - ALSO_SAVED_LIMIT} more saved this week.`,
    );
  }
  return `## Also saved\n\n${shown.join("\n")}`;
}

function plainFallback(items: DigestItem[]): string {
  const highlights = items.slice(0, FALLBACK_HIGHLIGHTS);
  const lines = highlights.map((item) => {
    const summary = condense(item.summary, SUMMARY_CHARS_FALLBACK);
    return `- ${link(item.title, item.url)}${summary ? ` — ${summary}` : ""}`;
  });
  const parts = [
    `${items.length} ${items.length === 1 ? "link" : "links"} saved this week.`,
    lines.join("\n"),
  ];
  const rest = alsoSaved(items.slice(FALLBACK_HIGHLIGHTS));
  if (rest) {
    parts.push(rest);
  }
  return parts.join("\n\n");
}

/**
 * Final markdown for the digest bookmark. `modelOutput` is the editor-style
 * briefing from the LLM (or null when inference is unavailable or failed); we
 * resolve its citations and append anything it did not cite as a compact
 * "Also saved" list so nothing is lost.
 */
export function renderDigest(
  modelOutput: string | null,
  items: DigestItem[],
): string {
  if (!modelOutput) {
    return plainFallback(items);
  }

  const byId = new Map(items.map((i) => [i.id, i]));
  const cited = new Set<number>();
  const body = resolveCitations(
    stripCodeFence(modelOutput),
    byId,
    cited,
  ).trim();

  // No usable citations means the model ignored the format; don't ship it.
  if (cited.size === 0 || body.length < 40) {
    return plainFallback(items);
  }

  const uncited = items.filter((i) => !cited.has(i.id));
  const rest = alsoSaved(uncited);
  return rest ? `${body}\n\n${rest}` : body;
}
