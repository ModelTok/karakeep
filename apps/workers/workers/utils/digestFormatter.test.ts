import { describe, expect, test } from "vitest";

import {
  condense,
  digestWordBudget,
  formatItemForPrompt,
  normaliseUrl,
  prepareDigestItems,
  renderDigest,
} from "./digestFormatter";

const row = (
  title: string | null,
  url: string,
  summary: string | null = null,
  tags: string[] = [],
) => ({ title, url, summary, tags });

describe("normaliseUrl", () => {
  test("ignores tracking params, fragments, www and trailing slashes", () => {
    expect(normaliseUrl("https://www.example.com/a/?utm_source=x#top")).toBe(
      normaliseUrl("https://example.com/a"),
    );
  });

  test("keeps meaningful query params", () => {
    expect(normaliseUrl("https://youtube.com/watch?v=1")).not.toBe(
      normaliseUrl("https://youtube.com/watch?v=2"),
    );
  });
});

describe("condense", () => {
  test("keeps whole sentences within the limit", () => {
    expect(condense("One. Two is a bit longer. Three.", 20)).toBe("One.");
  });

  test("cuts an over-long first sentence at a word boundary", () => {
    const out = condense("word ".repeat(100), 30)!;
    expect(out.length).toBeLessThanOrEqual(30);
    expect(out.endsWith("…")).toBe(true);
  });

  test("returns null for empty input", () => {
    expect(condense("  \n ", 50)).toBeNull();
    expect(condense(null, 50)).toBeNull();
  });
});

describe("prepareDigestItems", () => {
  test("drops repeats by URL and by title, merging tags", () => {
    const items = prepareDigestItems([
      row("Post", "https://example.com/p?utm_source=a", null, ["ai"]),
      row("Post", "https://www.example.com/p/", "Later summary.", ["llm"]),
      row("Post!", "https://mirror.org/copy", null, []),
      row("Other", "https://example.com/o"),
    ]);
    expect(items.map((i) => i.id)).toEqual([1, 2]);
    expect(items[0].tags).toEqual(["ai", "llm"]);
    expect(items[0].summary).toBe("Later summary.");
  });

  test("falls back to the URL when there is no title", () => {
    const [item] = prepareDigestItems([row(null, "https://example.com/x")]);
    expect(item.title).toBe("https://example.com/x");
    expect(item.domain).toBe("example.com");
  });
});

describe("formatItemForPrompt", () => {
  test("is a single compact line", () => {
    const [item] = prepareDigestItems([
      row("Title", "https://example.com/x", "A summary.", ["a", "b"]),
    ]);
    expect(formatItemForPrompt(item)).toBe(
      "[#1] Title (example.com) | tags: a, b | A summary.",
    );
  });
});

describe("digestWordBudget", () => {
  test("stays between 150 and 450 words", () => {
    expect(digestWordBudget(1)).toBe(150);
    expect(digestWordBudget(500)).toBe(450);
  });
});

describe("renderDigest", () => {
  const items = prepareDigestItems([
    row("Alpha", "https://a.com/1", "Alpha summary."),
    row("Beta", "https://b.com/2", "Beta summary."),
    row("Gamma", "https://c.com/3", "Gamma summary."),
  ]);

  test("resolves citations, builds title links for bullets, lists the rest", () => {
    const out = renderDigest(
      [
        "Big week for things.",
        "",
        "## Read first",
        "- [#1] The clearest explainer.",
        "",
        "## Things",
        "Alpha and beta agree on this [#1][#2]. Nothing else matters [#99].",
      ].join("\n"),
      items,
    );
    expect(out).toContain(
      "- **[Alpha](https://a.com/1)** — The clearest explainer.",
    );
    expect(out).toContain(
      "agree on this ([a.com](https://a.com/1), [b.com](https://b.com/2)).",
    );
    expect(out).not.toContain("#99");
    expect(out).toContain("## Also saved\n\n- [Gamma](https://c.com/3)");
    expect(out).not.toContain("- [Alpha](https://a.com/1)");
  });

  test("strips a wrapping code fence", () => {
    const out = renderDigest(
      "```markdown\nA solid overview sentence about the week [#1] and more words.\n```",
      items,
    );
    expect(out).not.toContain("```");
  });

  test("falls back when the model ignores the citation format", () => {
    const out = renderDigest(
      "Here is a long ramble without any citations at all, sorry.",
      items,
    );
    expect(out).toContain("3 links saved this week.");
    expect(out).toContain("- [Alpha](https://a.com/1) — Alpha summary.");
  });

  test("uses the plain digest without model output, capped with an also-saved list", () => {
    const many = prepareDigestItems(
      Array.from({ length: 40 }, (_, i) =>
        row(`Item ${i}`, `https://example.com/${i}`),
      ),
    );
    const out = renderDigest(null, many);
    expect(out).toContain("40 links saved this week.");
    expect(out).toContain("## Also saved");
    expect(out).toContain("…and 7 more saved this week.");
  });
});
