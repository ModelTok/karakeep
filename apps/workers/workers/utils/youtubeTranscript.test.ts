import * as fs from "node:fs/promises";
import * as os from "os";
import * as path from "path";
import { execa } from "execa";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  fetchYoutubeTranscript,
  isYoutubeVideoUrl,
  parseSrt,
  toSafeTranscriptHtml,
} from "./youtubeTranscript";

vi.mock("execa", () => ({ execa: vi.fn() }));

const mockedExeca = execa as unknown as ReturnType<typeof vi.fn>;
const TMP_FOLDER = path.join(os.tmpdir(), "yt_transcripts");

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
  const DETAILS_OPEN =
    '<details style="margin-top:1.5em;border:1px solid rgba(128,128,128,0.35);border-radius:6px;padding:0.5em 0.75em;"><summary style="cursor:pointer;font-weight:600;">Transkrypcja YouTube</summary>';
  const DETAILS_CLOSE = "</details>";

  test("escapes HTML metacharacters so a split-tag payload can't execute", () => {
    const maliciousTranscript = "<img src=x onerror=alert(1) >";
    expect(toSafeTranscriptHtml(maliciousTranscript)).toBe(
      `${DETAILS_OPEN}<p style="margin-top:0.75em;">&lt;img src=x onerror=alert(1) &gt;</p>${DETAILS_CLOSE}`,
    );
  });

  test("escapes ampersands and quotes as well as angle brackets", () => {
    expect(toSafeTranscriptHtml(`Tom & Jerry's "great" show`)).toBe(
      `${DETAILS_OPEN}<p style="margin-top:0.75em;">Tom &amp; Jerry&#x27;s &quot;great&quot; show</p>${DETAILS_CLOSE}`,
    );
  });

  test("wraps plain transcripts in a collapsible details/summary block unchanged otherwise", () => {
    expect(toSafeTranscriptHtml("Hello there.")).toBe(
      `${DETAILS_OPEN}<p style="margin-top:0.75em;">Hello there.</p>${DETAILS_CLOSE}`,
    );
  });
});

describe("fetchYoutubeTranscript", () => {
  afterEach(async () => {
    await fs.rm(TMP_FOLDER, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  test("recovers a partial transcript when yt-dlp exits non-zero after writing one language's subtitles", async () => {
    // Reproduces a real production failure: yt-dlp requests pl+en in one
    // call, pl is written successfully, en then hits YouTube's rate limit
    // (HTTP 429) and the whole process exits non-zero - even though a
    // usable transcript was already on disk.
    const jobId = "test-job-partial";
    mockedExeca.mockImplementation(async () => {
      await fs.mkdir(TMP_FOLDER, { recursive: true });
      await fs.writeFile(
        path.join(TMP_FOLDER, `${jobId}.pl.srt`),
        "1\n00:00:00,000 --> 00:00:02,000\nCzesc swiat.\n",
      );
      throw new Error(
        "Command failed with exit code 1: ... HTTP Error 429: Too Many Requests",
      );
    });

    const transcript = await fetchYoutubeTranscript(
      "https://youtu.be/abc123",
      jobId,
    );

    expect(transcript).toBe("Czesc swiat.");
  });

  test("returns null when yt-dlp fails with no subtitle files written at all", async () => {
    const jobId = "test-job-total-failure";
    mockedExeca.mockRejectedValue(new Error("network error"));

    const transcript = await fetchYoutubeTranscript(
      "https://youtu.be/abc123",
      jobId,
    );

    expect(transcript).toBeNull();
  });

  test("cleans up every temp file for the job after a partial-recovery success", async () => {
    const jobId = "test-job-cleanup";
    mockedExeca.mockImplementation(async () => {
      await fs.mkdir(TMP_FOLDER, { recursive: true });
      await fs.writeFile(
        path.join(TMP_FOLDER, `${jobId}.pl.srt`),
        "1\n00:00:00,000 --> 00:00:02,000\nCzesc swiat.\n",
      );
      throw new Error("Command failed with exit code 1");
    });

    await fetchYoutubeTranscript("https://youtu.be/abc123", jobId);

    const remaining = await fs.readdir(TMP_FOLDER).catch(() => []);
    expect(remaining.filter((f) => f.startsWith(jobId))).toEqual([]);
  });
});
