import { describe, expect, it } from "vitest";

import {
  DEAD_FEED_PAGE_GRACE_MS,
  deadFeedPageAction,
  normalizeBrowserUserAgent,
} from "./crawlerUtils";

describe("normalizeBrowserUserAgent", () => {
  it("drops the headless marker and reduces the version", () => {
    expect(
      normalizeBrowserUserAgent(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/154.0.8037.57 Safari/537.36",
      ),
    ).toBe(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
    );
  });

  it("reduces the full version that headless-shell reports", () => {
    expect(
      normalizeBrowserUserAgent(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.7922.47 Safari/537.36",
      ),
    ).toBe(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
    );
  });

  it("keeps an already reduced user agent and its platform unchanged", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";
    expect(normalizeBrowserUserAgent(ua)).toBe(ua);
  });
});

describe("deadFeedPageAction", () => {
  const old = DEAD_FEED_PAGE_GRACE_MS + 1;
  const fresh = 60 * 1000;

  it("discards an old RSS article whose page is not found or gone", () => {
    for (const statusCode of [404, 410]) {
      expect(
        deadFeedPageAction({ source: "rss", statusCode, ageMs: old }),
      ).toBe("discard");
    }
  });

  it("looks again later at a fresh RSS article, in case the page is not live yet", () => {
    expect(
      deadFeedPageAction({ source: "rss", statusCode: 404, ageMs: fresh }),
    ).toBe("retry-later");
  });

  it("never discards bookmarks the user saved themselves", () => {
    for (const source of ["web", "extension", "import", "api", "cli", null]) {
      expect(
        deadFeedPageAction({ source, statusCode: 404, ageMs: old }),
      ).toBe("keep");
    }
  });

  it("keeps RSS articles that load, or fail for another reason", () => {
    for (const statusCode of [200, 301, 403, 429, 500, 503, null]) {
      expect(
        deadFeedPageAction({ source: "rss", statusCode, ageMs: old }),
      ).toBe("keep");
    }
  });
});
