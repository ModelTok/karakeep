// Upper bound for the state sent to the engine. Sized for mini's 8192-token
// context window: ~12000 characters of mostly Polish/English text stays well
// under the limit together with the question rubric and the answer.
export const BASAL_STATE_CHAR_CAP = 12000;

export interface BasalStateInput {
  title: string;
  url: string;
  domain: string;
  feedName?: string | null;
  tags: string[];
  summary?: string | null;
  description?: string | null;
  text?: string | null;
}

export type BasalStateKind = "full" | "title_only";

export interface BasalState {
  state: string;
  stateKind: BasalStateKind;
  chars: number;
}

function clean(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function cleanMultiline(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

function capState(state: string): string {
  return state.length > BASAL_STATE_CHAR_CAP
    ? state.slice(0, BASAL_STATE_CHAR_CAP)
    : state;
}

// Training states are deliberately shorter than scoring states: basal-calibrate
// re-runs every labelled request through the model before it fits anything, so a
// 12000 character state costs ~50 s per decision on the CPU-only host. The
// header (title, domain, feed, tags, description/summary) carries most of the
// signal, so a short excerpt is enough for fitting temperatures and thresholds.
export const BASAL_TRAIN_STATE_CHAR_CAP = 2500;

export function capTrainState(state: string): string {
  if (state.length <= BASAL_TRAIN_STATE_CHAR_CAP) {
    return state;
  }
  return `${state.slice(0, BASAL_TRAIN_STATE_CHAR_CAP)}…`;
}

/**
 * Builds the labelled text block the engine scores. The labels are Polish on
 * purpose: they are model input, not UI copy. Pure function.
 */
export function buildBasalState(input: BasalStateInput): BasalState {
  const title = clean(input.title);
  const domain = clean(input.domain);
  const url = clean(input.url);
  const feedName = clean(input.feedName);
  const tags = input.tags.map(clean).filter((t) => t.length > 0);
  const description = clean(input.description);
  const summary = clean(input.summary);
  const text = cleanMultiline(input.text);

  const header: string[] = [];
  header.push(`Tytuł: ${title}`);
  header.push(`Domena: ${domain}${url ? ` (${url})` : ""}`);
  if (feedName) {
    header.push(`Feed: ${feedName}`);
  }
  if (tags.length > 0) {
    header.push(`Tagi: ${tags.join(", ")}`);
  }
  const opis = [description, summary].filter((s) => s.length > 0);
  if (opis.length > 0) {
    header.push(`Opis: ${opis.join("\n")}`);
  }

  let state = header.join("\n");
  if (text) {
    state += `\nTreść: ${text}`;
  }
  state = capState(state);

  const stateKind: BasalStateKind =
    text || summary || description ? "full" : "title_only";

  return { state, stateKind, chars: state.length };
}

// Number of most recent headlines included in a feed summary.
export const BASAL_FEED_HEADLINE_COUNT = 10;
// Value stored in the stateKind column for feed scores.
export const BASAL_FEED_STATE_KIND = "feed_summary";
// Number of newest YouTube videos whose transcripts are added to a feed state.
export const BASAL_FEED_VIDEO_COUNT = 2;
// Per-video transcript excerpt length; the whole state still goes through
// BASAL_STATE_CHAR_CAP afterwards.
export const BASAL_FEED_VIDEO_TRANSCRIPT_CHARS = 3000;

export interface BasalFeedVideoInput {
  title?: string | null;
  transcript: string;
}

export interface BasalFeedStateInput {
  name: string;
  url: string;
  description?: string | null;
  headlines: string[];
  videos?: BasalFeedVideoInput[];
}

/**
 * Builds the feed summary the engine scores with the feed_value question.
 * Polish labels for the same reason as buildBasalState. Pure function.
 */
export function buildBasalFeedState(input: BasalFeedStateInput): {
  state: string;
  chars: number;
} {
  const name = clean(input.name);
  const url = clean(input.url);
  const description = clean(input.description);
  const headlines = input.headlines
    .map(clean)
    .filter((h) => h.length > 0)
    .slice(0, BASAL_FEED_HEADLINE_COUNT);
  const videos = (input.videos ?? [])
    .map((v) => ({
      title: clean(v.title),
      transcript: cleanMultiline(v.transcript).slice(
        0,
        BASAL_FEED_VIDEO_TRANSCRIPT_CHARS,
      ),
    }))
    .filter((v) => v.transcript.length > 0)
    .slice(0, BASAL_FEED_VIDEO_COUNT);

  const lines: string[] = [];
  if (name) {
    lines.push(`Feed: ${name}`);
  }
  if (url) {
    lines.push(`URL: ${url}`);
  }
  if (description) {
    lines.push(`Opis: ${description}`);
  }
  if (headlines.length > 0) {
    lines.push("Ostatnie nagłówki:");
    lines.push(...headlines.map((h) => `- ${h}`));
  }
  if (videos.length > 0) {
    lines.push("Transkrypcje najnowszych filmów:");
    lines.push(
      ...videos.map((v) =>
        v.title ? `- ${v.title}: ${v.transcript}` : `- ${v.transcript}`,
      ),
    );
  }

  const state = capState(lines.join("\n"));
  return { state, chars: state.length };
}

const YOUTUBE_VIDEO_URL_RE =
  /^(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/watch\?|youtu\.be\/)/;

/** True for youtube.com/watch and youtu.be URLs. Pure function. */
export function isYoutubeVideoUrl(url: string): boolean {
  return YOUTUBE_VIDEO_URL_RE.test(url.trim());
}

/** Hostname without a leading "www.", or "" for unparsable URLs. */
export function domainFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
