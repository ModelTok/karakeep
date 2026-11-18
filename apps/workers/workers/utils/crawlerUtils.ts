export function truncateUrl(url: string): string {
  return url.length > 100 ? url.slice(0, 100) + "..." : url;
}

/**
 * Redact sensitive query parameters (e.g., tokens) from a URL for safe logging.
 */
export function redactUrlCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of parsed.searchParams.keys()) {
      parsed.searchParams.set(key, "REDACTED");
    }
    if (parsed.username) {
      parsed.username = "REDACTED";
    }
    if (parsed.password) {
      parsed.password = "REDACTED";
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Normalize a Content-Type header by stripping parameters (e.g., charset)
 * and lowercasing the media type, so comparisons against supported types work.
 */
export function normalizeContentType(header: string | null): string | null {
  if (!header) {
    return null;
  }
  return header.split(";", 1)[0]!.trim().toLowerCase();
}

/** How long a feed entry's page may keep answering "not found" before it is given up on. */
export const DEAD_FEED_PAGE_GRACE_MS = 60 * 60 * 1000;
/** How long to wait before looking again while the page is still inside the grace period. */
export const DEAD_FEED_PAGE_RETRY_MS = 15 * 60 * 1000;

/**
 * What to do with a freshly crawled page that says "not found" or "gone".
 *
 * Only articles that arrived from an RSS feed are ever discarded: the user did
 * not pick them one by one, and the feed has since withdrawn them (or the feed
 * links to a page that never existed), so keeping a bookmark of an error page
 * is just noise. A feed sometimes lists an entry a little before its page is
 * live, so a young bookmark is looked at again later instead.
 */
export function deadFeedPageAction(opts: {
  source: string | null;
  statusCode: number | null;
  ageMs: number;
}): "keep" | "retry-later" | "discard" {
  if (opts.source !== "rss") {
    return "keep";
  }
  if (opts.statusCode !== 404 && opts.statusCode !== 410) {
    return "keep";
  }
  return opts.ageMs < DEAD_FEED_PAGE_GRACE_MS ? "retry-later" : "discard";
}

export function shouldRetryCrawlStatusCode(statusCode: number | null): boolean {
  if (statusCode === null) {
    return false;
  }
  return statusCode === 403 || statusCode === 429 || statusCode >= 500;
}

/**
 * Turns the browser's own user agent into the one a regular (non-headless)
 * Chrome of the same version and platform would send: drops the "Headless"
 * marker and applies Chrome's user-agent reduction (minor version zeroed).
 */
export function normalizeBrowserUserAgent(userAgent: string): string {
  return userAgent
    .replace("HeadlessChrome/", "Chrome/")
    .replace(/Chrome\/(\d+)\.[\d.]+/, "Chrome/$1.0.0.0");
}
