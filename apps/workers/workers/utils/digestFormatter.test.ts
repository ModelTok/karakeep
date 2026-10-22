import { describe, expect, test } from "vitest";

import {
  condense,
  digestTitle,
  digestWindowStart,
  digestWordBudget,
  formatItemForPrompt,
  isFailedCrawlNote,
  normaliseUrl,
  prepareDigestItems,
  renderDigest,
  shouldWriteBriefing,
  worthBriefing,
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

describe("digestWindowStart", () => {
  const now = new Date("2026-10-22T06:05:00Z");
  const hours = (h: number) => new Date(now.getTime() - h * 60 * 60 * 1000);

  test("starts at the previous digest so nothing is missed or repeated", () => {
    expect(digestWindowStart(hours(23.9), now)).toEqual(hours(23.9));
    expect(digestWindowStart(hours(25), now)).toEqual(hours(25));
  });

  test("defaults to the last 24 hours when there has been no digest", () => {
    expect(digestWindowStart(null, now)).toEqual(hours(24));
  });

  test("never reaches back more than 7 days after a long gap", () => {
    expect(digestWindowStart(hours(24 * 30), now)).toEqual(hours(24 * 7));
  });
});

describe("digestTitle", () => {
  test("uses one date when the window is within a day", () => {
    expect(
      digestTitle(
        "Prasówka",
        new Date("2026-10-21T06:01:00Z"),
        new Date("2026-10-22T06:04:00Z"),
      ),
    ).toBe("Prasówka — 2026-10-22");
  });

  test("shows a range after a catch-up covering several days", () => {
    expect(
      digestTitle(
        "Prasówka",
        new Date("2026-10-19T06:00:00Z"),
        new Date("2026-10-22T06:04:00Z"),
      ),
    ).toBe("Prasówka — 2026-10-19 to 2026-10-22");
  });
});

describe("isFailedCrawlNote", () => {
  // Openings of real stored notes for pages that never loaded.
  const failed = [
    "This page is experiencing technical difficulties and cannot be loaded. It is recommended to reload.",
    "This page appears to be an error message, indicating that the content could not be loaded.",
    'There is no content provided to summarize. The page appears to be an error message with a "404 Not Found" error.',
    "This page is not loading due to technical issues, and the content cannot be viewed.",
    "The page couldn't load, and an error message appeared, prompting the user to try reloading.",
    "This article is not available to load due to technical issues, and it cannot be accessed.",
    "The provided content appears to be a broken webpage, specifically the OpenAI GPT-6 Astra page.",
    "This page is temporarily unavailable and cannot be loaded, with an option to reload.",
    "Summary: The given content is a page that failed to load. It invites users to reload the page.",
    "This page is unable to load, suggesting a technical issue with the content's access.",
    "This webpage experienced technical difficulties and was unable to load its content.",
    "Unfortunately, the content couldn't be loaded. The page couldn't be reloaded or accessed.",
    "The content provided is an error page indicating that the blog post cannot be found.",
    // Wordings found by auditing the stored notes for ones the first patterns missed.
    "This page appears to be a failed load attempt, and users are advised to try reloading the page.",
    "This page appears to be a loading error, resulting in a failure to load content.",
    "This page appears to be a technical issue, preventing users from loading its content.",
    "The provided content is a broken link to an OpenAI page. The content itself is unavailable due to a loading error.",
    "There is no summary or content provided for the given text. The text appears to be a basic webpage template.",
    "This webpage appears to be having issues loading, resulting in a blank content page.",
    "This page appears to be a failed attempt to load content. The user is prompted to reload the page.",
    "Unfortunately, the provided content is a failed load page and does not contain a summary.",
    "This page appears to be loading issues, preventing the content from being displayed.",
    "The content is a technical error page that prevents the page from loading. The user is advised to reload.",
  ];
  test.each(failed)("recognises a failed page: %s", (note) => {
    expect(isFailedCrawlNote(note)).toBe(true);
  });

  const fine = [
    "Learn how OpenAI built ChatGPT's LLM-powered ad stack to understand conversational intent and keep ads separate from answers.",
    "This article explains how to fix technical issues in Kubernetes clusters and handle 404 errors gracefully.",
    "A walkthrough of building a retry policy for services that fail to respond when a dependency is down.",
    "NVIDIA Kumo Forecast merges pretrained Transformer representations with historical pattern retrieval.",
    "The SWE-Lancer benchmark is a dataset of 1,400 freelance software engineering tasks valued at $1 million.",
    "This report provides 10 mechanisms to improve the verifiability of claims made about AI systems.",
    // Real articles that merely mention an error message (found auditing the stored notes).
    "An OpenAI account was used to generate a fake error message claiming a Russian troll had used up its credits, which went viral.",
    "This is a technical article about a bug found in a Kubernetes-based application. The bug caused the application to crash with a specific type of error message.",
  ];
  test.each(fine)("leaves a normal note alone: %s", (note) => {
    expect(isFailedCrawlNote(note)).toBe(false);
  });

  test("treats a missing note as not failed", () => {
    expect(isFailedCrawlNote(null)).toBe(false);
    expect(isFailedCrawlNote("")).toBe(false);
  });

  test("only looks at the opening, so a long article mentioning errors later is kept", () => {
    const note = `${"A long and useful summary of a deployment guide. ".repeat(8)}Section 9 covers the error page for 404 handling.`;
    expect(isFailedCrawlNote(note)).toBe(false);
  });
});

describe("worthBriefing and failed pages", () => {
  const items = prepareDigestItems([
    row("Good post", "https://a.com/1", "A real summary of the post."),
    row(
      "Bio agents",
      "https://b.com/2",
      "This page is experiencing technical difficulties and cannot be loaded.",
    ),
    row("Title only", "https://c.com/3", null),
  ]);

  test("keeps real notes and title-only items, drops failed pages", () => {
    expect(items.filter(worthBriefing).map((i) => i.title)).toEqual([
      "Good post",
      "Title only",
    ]);
  });

  test("a failed page is still listed under Also saved when the model never saw it", () => {
    const out = renderDigest(
      "A solid overview of the week [#1] and what matters in it.",
      items,
    );
    expect(out).toContain("- [Bio agents](https://b.com/2)");
  });

  test("the plain digest does not print a failed page's error note", () => {
    const out = renderDigest(null, items);
    expect(out).toContain("[Bio agents](https://b.com/2)");
    expect(out).not.toContain("technical difficulties");
    expect(out).toContain("A real summary of the post.");
  });
});

describe("shouldWriteBriefing", () => {
  test("only asks the model for a briefing when there is enough to synthesise", () => {
    expect(shouldWriteBriefing(3)).toBe(false);
    expect(shouldWriteBriefing(4)).toBe(true);
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
    expect(out).toContain("3 links saved since the last digest.");
    expect(out).toContain("- [Alpha](https://a.com/1) — Alpha summary.");
  });

  // The cases below are real failure shapes seen from small local models.
  test("drops an item list the model appended after the briefing", () => {
    const out = renderDigest(
      [
        "A solid overview of the week [#1].",
        "",
        "## Things",
        "Beta matters here [#2].",
        "",
        "**Unread Items:**",
        "",
        "[#1] Alpha",
        "[#3] Gamma",
      ].join("\n"),
      items,
    );
    expect(out).not.toContain("Unread");
    expect(out).not.toContain("Alpha\n");
    expect(out).toContain("## Also saved\n\n- [Gamma](https://c.com/3)");
  });

  test("keeps a Read-first list that happens to end the briefing", () => {
    const out = renderDigest(
      [
        "A solid overview of the week and what matters in it.",
        "",
        "## Read first",
        "- [#1] The clearest explainer.",
        "- [#2] The best counterpoint.",
      ].join("\n"),
      items,
    );
    expect(out).toContain(
      "- **[Alpha](https://a.com/1)** — The clearest explainer.",
    );
    expect(out).toContain(
      "- **[Beta](https://b.com/2)** — The best counterpoint.",
    );
  });

  test("turns bold-wrapped citations in bullets into title links", () => {
    const out = renderDigest(
      [
        "A solid overview of the week and what matters in it.",
        "",
        "## Read first",
        "- **[#1] Alpha:** The clearest explainer.",
        "*   **[#2]** The best counterpoint.",
      ].join("\n"),
      items,
    );
    expect(out).toContain(
      "- **[Alpha](https://a.com/1)** — The clearest explainer.",
    );
    expect(out).toContain(
      "*   **[Beta](https://b.com/2)** — The best counterpoint.",
    );
    expect(out).not.toContain("[#");
  });

  test("drops a title and (domain) echoed back after the citation", () => {
    const out = renderDigest(
      [
        "A solid overview of the week and what matters in it.",
        "",
        "## Read first",
        "- [#1] Alpha (a.com) The clearest explainer.",
      ].join("\n"),
      items,
    );
    expect(out).toContain(
      "- **[Alpha](https://a.com/1)** — The clearest explainer.",
    );
  });

  test("drops a title or overview heading the prompt did not ask for", () => {
    for (const first of [
      "**Weekly Briefing: AI footprint**",
      "## Overview",
      "## Key Takeaway",
    ]) {
      const out = renderDigest(
        `${first}\n\nA solid overview of the week [#1] and what matters in it.`,
        items,
      );
      expect(out.startsWith("A solid overview")).toBe(true);
    }
  });

  test("drops a generic closing section", () => {
    const out = renderDigest(
      [
        "A solid overview of the week [#1] and what matters in it.",
        "",
        "## Things",
        "Beta matters here [#2].",
        "",
        "## Conclusion",
        "The week shows rapid progress. We must act responsibly.",
      ].join("\n"),
      items,
    );
    expect(out).not.toContain("Conclusion");
    expect(out).not.toContain("act responsibly");
    expect(out).toContain("## Things");
  });

  test("falls back when the model writes far more than the word budget", () => {
    const rambling = `Alpha is covered [#1]. ${"More words here. ".repeat(100)}`;
    const out = renderDigest(rambling, items, 50);
    expect(out).toContain("3 links saved since the last digest.");
  });

  test("falls back when most citations are invented ids", () => {
    const out = renderDigest(
      "Overview of the week [#40] with several claims [#41][#42] and one real one [#1].",
      items,
    );
    expect(out).toContain("3 links saved since the last digest.");
  });

  test("uses the plain digest without model output, capped with an also-saved list", () => {
    const many = prepareDigestItems(
      Array.from({ length: 40 }, (_, i) =>
        row(`Item ${i}`, `https://example.com/${i}`),
      ),
    );
    const out = renderDigest(null, many);
    expect(out).toContain("40 links saved since the last digest.");
    expect(out).toContain("## Also saved");
    expect(out).toContain("…and 7 more saved.");
  });
});
