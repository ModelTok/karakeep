import { describe, expect, test } from "vitest";

import {
  isYoutubeVideoUrl,
  parseSrt,
  toSafeTranscriptHtml,
} from "./youtubeTranscript";

describe("isYoutubeVideoUrl", () => {
  test("matches youtube.com watch URLs", () => {
    expect(isYoutubeVideoUrl("https://www.youtube.com/watch?v=abc123")).toBe(
      true,
    );
  });

  test("matches youtu.be short URLs", () => {
    expect(isYoutubeVideoUrl("https://youtu.be/abc123")).toBe(true);
  });

  test("does not match unrelated URLs", () => {
    expect(isYoutubeVideoUrl("https://example.com/watch?v=abc123")).toBe(false);
  });
});

describe("parseSrt", () => {
  test("strips sequence numbers and timestamps", () => {
    const srt = `1
00:00:00,000 --> 00:00:02,000
Hello there.

2
00:00:02,000 --> 00:00:04,000
This is a test.
`;
    expect(parseSrt(srt)).toBe("Hello there. This is a test.");
  });

  test("deduplicates consecutive repeated lines (auto-caption artifact)", () => {
    const srt = `1
00:00:00,000 --> 00:00:02,000
Same line.

2
00:00:02,000 --> 00:00:04,000
Same line.

3
00:00:04,000 --> 00:00:06,000
Different line.
`;
    expect(parseSrt(srt)).toBe("Same line. Different line.");
  });

  test("strips inline markup tags", () => {
    const srt = `1
00:00:00,000 --> 00:00:02,000
<b>Bold</b> text.
`;
    expect(parseSrt(srt)).toBe("Bold text.");
  });

  test("truncates to MAX_TRANSCRIPT_CHARS", () => {
    const longLine = "x".repeat(25000);
    const srt = `1\n00:00:00,000 --> 00:00:02,000\n${longLine}\n`;
    expect(parseSrt(srt).length).toBe(20000);
  });

  test("does not let a tag split across two caption lines survive as a real tag", () => {
    // parseSrt's tag stripping regex runs per-line, before lines are
    // joined with a space. A transcript file (author-controlled, since
    // yt-dlp's --write-subs reads captions uploaded by the video's own
    // owner) can exploit that by splitting a tag across two lines so
    // neither line matches the regex on its own.
    const srt = `1
00:00:00,000 --> 00:00:02,000
<img src=x onerror=alert(1)

2
00:00:02,000 --> 00:00:04,000
>
`;
    const parsed = parseSrt(srt);
    // The regex alone can't catch this - the joined string still
    // contains a live-looking tag at this stage.
    expect(parsed).toBe("<img src=x onerror=alert(1) >");
  });
});

describe("toSafeTranscriptHtml", () => {
  test("escapes HTML metacharacters so a split-tag payload can't execute", () => {
    const maliciousTranscript = "<img src=x onerror=alert(1) >";
    expect(toSafeTranscriptHtml(maliciousTranscript)).toBe(
      "<p>&lt;img src=x onerror=alert(1) &gt;</p>",
    );
  });

  test("escapes ampersands and quotes as well as angle brackets", () => {
    expect(toSafeTranscriptHtml(`Tom & Jerry's "great" show`)).toBe(
      "<p>Tom &amp; Jerry&#x27;s &quot;great&quot; show</p>",
    );
  });

  test("wraps plain transcripts in a paragraph tag unchanged otherwise", () => {
    expect(toSafeTranscriptHtml("Hello there.")).toBe("<p>Hello there.</p>");
  });
});
