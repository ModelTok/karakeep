import { describe, expect, it } from "vitest";

import { digestTitle, renderDigest } from "./digestFormatter";
import {
  EN_LABELS,
  labelsFor,
  PL_LABELS,
  resolveDigestLanguage,
} from "./digestLabels";

describe("resolveDigestLanguage", () => {
  it("lets an explicit choice win over the AI inference language", () => {
    const pl = resolveDigestLanguage("pl", "english");
    expect(pl.promptLanguage).toBe("Polish");
    expect(pl.labels).toBe(PL_LABELS);

    const en = resolveDigestLanguage("en", "polish");
    expect(en.promptLanguage).toBe("English");
    expect(en.labels).toBe(EN_LABELS);
  });

  it("follows the inference language when nothing is chosen", () => {
    const fallback = resolveDigestLanguage(null, "german");
    expect(fallback.promptLanguage).toBe("german");
    expect(fallback.labels).toBe(EN_LABELS);
    expect(resolveDigestLanguage(undefined, "english").labels).toBe(EN_LABELS);
  });

  it("uses the Polish fixed words when the inference language is Polish", () => {
    for (const lang of ["Polish", "polish", "pl", "Polski"]) {
      const r = resolveDigestLanguage(null, lang);
      expect(r.promptLanguage).toBe(lang);
      expect(r.labels).toBe(PL_LABELS);
    }
  });
});

describe("Polish labels", () => {
  it("picks the right plural of 'link'", () => {
    const s = (n: number) => PL_LABELS.savedSinceLast(n);
    expect(s(1)).toBe("Od ostatniego przeglądu zapisano 1 link.");
    for (const n of [2, 3, 4, 22, 23, 24, 102]) {
      expect(s(n)).toContain(`${n} linki.`);
    }
    for (const n of [0, 5, 11, 12, 13, 14, 15, 21, 25, 112]) {
      expect(s(n)).toContain(`${n} linków.`);
    }
  });

  it("falls back to English for an unknown language", () => {
    expect(labelsFor("en")).toBe(EN_LABELS);
  });
});

describe("a Polish digest", () => {
  const items = [1, 2, 3].map((id) => ({
    id,
    title: `Artykuł ${id}`,
    url: `https://example.com/${id}`,
    domain: "example.com",
    summary: null,
    tags: [],
  }));

  it("titles a multi-day digest with 'do' instead of 'to'", () => {
    const title = digestTitle(
      "Prasówka",
      new Date("2026-11-14T06:00:00Z"),
      new Date("2026-11-16T06:00:00Z"),
      PL_LABELS,
    );
    expect(title).toBe("Prasówka — 2026-11-14 do 2026-11-16");
  });

  it("keeps English headings by default", () => {
    const out = renderDigest(null, items, undefined, [items[0]]);
    expect(out).toContain("## Picked for you");
    expect(out).toContain("## Also saved");
    expect(out).toContain("3 links saved since the last digest.");
  });

  it("uses Polish headings in the plain digest", () => {
    const out = renderDigest(null, items, undefined, [items[0]], PL_LABELS);
    expect(out).toContain("## Wybrane dla Ciebie");
    expect(out).toContain("## Zapisane także");
    expect(out).toContain("Od ostatniego przeglądu zapisano 3 linki.");
    expect(out).not.toContain("Picked for you");
  });
});
