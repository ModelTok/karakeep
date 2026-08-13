import { describe, expect, test } from "vitest";

import { isYoutubeVideoUrl, parseSrt } from "./youtubeTranscript";

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
});
