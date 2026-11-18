/** Languages a reader can pick for their digest. */
export type DigestLanguage = "en" | "pl";

/** The fixed words the digest adds around the model's briefing. */
export interface DigestLabels {
  pickedForYou: string;
  alsoSaved: string;
  /** Joins the two dates of a multi-day digest title: "2026-11-14 to 2026-11-16". */
  to: string;
  savedSinceLast: (count: number) => string;
  andMoreSaved: (count: number) => string;
}

/** Polish has three plural forms: 1 link, 2-4 linki, 5+ linków (and 12-14, 22-24 ... as appropriate). */
function polishPlural(n: number, one: string, few: string, many: string) {
  if (n === 1) {
    return one;
  }
  const lastDigit = n % 10;
  const lastTwo = n % 100;
  return lastDigit >= 2 && lastDigit <= 4 && (lastTwo < 12 || lastTwo > 14)
    ? few
    : many;
}

export const EN_LABELS: DigestLabels = {
  pickedForYou: "Picked for you",
  alsoSaved: "Also saved",
  to: "to",
  savedSinceLast: (n) =>
    `${n} ${n === 1 ? "link" : "links"} saved since the last digest.`,
  andMoreSaved: (n) => `…and ${n} more saved.`,
};

export const PL_LABELS: DigestLabels = {
  pickedForYou: "Wybrane dla Ciebie",
  alsoSaved: "Zapisane także",
  to: "do",
  savedSinceLast: (n) =>
    `Od ostatniego przeglądu zapisano ${n} ${polishPlural(n, "link", "linki", "linków")}.`,
  andMoreSaved: (n) => `…i ${n} więcej zapisanych.`,
};

export function labelsFor(language: DigestLanguage): DigestLabels {
  return language === "pl" ? PL_LABELS : EN_LABELS;
}

const PROMPT_LANGUAGE: Record<DigestLanguage, string> = {
  en: "English",
  pl: "Polish",
};

/**
 * The language the digest is written in. An explicit choice wins; otherwise the
 * digest follows the AI "inference language" setting, as it did before the
 * choice existed. The fixed words are Polish only when that language is Polish.
 */
export function resolveDigestLanguage(
  digestLanguage: DigestLanguage | null | undefined,
  inferredTagLang: string,
): { promptLanguage: string; labels: DigestLabels } {
  if (digestLanguage) {
    return {
      promptLanguage: PROMPT_LANGUAGE[digestLanguage],
      labels: labelsFor(digestLanguage),
    };
  }
  const isPolish = /^(pl|pol|polish|polski)\b/i.test(inferredTagLang.trim());
  return {
    promptLanguage: inferredTagLang,
    labels: labelsFor(isPolish ? "pl" : "en"),
  };
}
