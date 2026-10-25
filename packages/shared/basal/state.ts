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
  if (state.length > BASAL_STATE_CHAR_CAP) {
    state = state.slice(0, BASAL_STATE_CHAR_CAP);
  }

  const stateKind: BasalStateKind =
    text || summary || description ? "full" : "title_only";

  return { state, stateKind, chars: state.length };
}

/** Hostname without a leading "www.", or "" for unparsable URLs. */
export function domainFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
