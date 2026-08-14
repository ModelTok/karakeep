import * as fs from "node:fs/promises";
import * as os from "os";
import * as path from "path";
import { execa } from "execa";

import logger from "@karakeep/shared/logger";
import { escapeHtml } from "@karakeep/shared/utils/htmlUtils";

const YOUTUBE_URL_RE = /(?:youtube\.com\/watch\?v=|youtu\.be\/)/;
const MAX_TRANSCRIPT_CHARS = 20000;
const TMP_FOLDER = path.join(os.tmpdir(), "yt_transcripts");

const TIMESTAMP_RE = /^\d{2}:\d{2}:\d{2},\d{3} --> /;
const INDEX_RE = /^\d+$/;

export function isYoutubeVideoUrl(url: string): boolean {
  return YOUTUBE_URL_RE.test(url);
}

/**
 * Wraps a transcript in a collapsible <details>/<summary> block (native,
 * no JS) with its contents HTML-escaped, so it's safe to concatenate
 * directly into `readableContent.content`, which is later rendered
 * client-side via `dangerouslySetInnerHTML` with no further sanitization
 * pass.
 *
 * Escaping is needed even though parseSrt() already strips inline `<...>`
 * tags: it does so per caption line, with a regex, before joining lines with
 * a space. A transcript file crafted by the video's own uploader (yt-dlp
 * reads `--write-subs`, i.e. subtitles authored by whoever uploaded the
 * video) can split a tag across two consecutive caption lines - e.g. one
 * line ending in `<img src=x onerror=alert(1)` and the next starting with
 * `>` - so neither line matches the per-line tag regex, but the tag becomes
 * whole once the lines are joined. escapeHtml() renders any such surviving
 * angle brackets (and other HTML metacharacters) inert regardless of how
 * they got there.
 */
export function toSafeTranscriptHtml(transcript: string): string {
  return (
    `<details style="margin-top:1.5em;border:1px solid rgba(128,128,128,0.35);border-radius:6px;padding:0.5em 0.75em;">` +
    `<summary style="cursor:pointer;font-weight:600;">Transkrypcja YouTube</summary>` +
    `<p style="margin-top:0.75em;">${escapeHtml(transcript)}</p>` +
    `</details>`
  );
}

export function parseSrt(raw: string): string {
  const lines: string[] = [];
  let prev: string | null = null;
  for (let line of raw.split("\n")) {
    line = line.trim();
    if (!line || INDEX_RE.test(line) || TIMESTAMP_RE.test(line)) {
      continue;
    }
    line = line.replace(/<[^>]+>/g, "");
    if (line === prev) {
      continue;
    }
    lines.push(line);
    prev = line;
  }
  return lines.join(" ").slice(0, MAX_TRANSCRIPT_CHARS);
}

/**
 * Fetches only the subtitles for a YouTube video via yt-dlp
 * (--skip-download, independent of CRAWLER_VIDEO_DOWNLOAD/
 * CRAWLER_YTDLP_ARGS). Returns null if no captions are available -
 * this is a normal outcome (many videos have none), not an error.
 */
export async function fetchYoutubeTranscript(
  url: string,
  jobId: string,
): Promise<string | null> {
  const outputTemplate = path.join(TMP_FOLDER, jobId);
  let transcript: string | null = null;

  // Everything from mkdir through parseSrt is one guarded sequence: a
  // missing/unreadable transcript (no captions, yt-dlp failure mid-way,
  // fs errors) is a normal crawl outcome, never allowed to throw out of
  // this function. Whatever yt-dlp wrote to TMP_FOLDER for this jobId -
  // even a partial result left behind by a failure part-way through
  // (e.g. one language's .srt written before a later error) - is always
  // cleaned up in the finally below, regardless of where things failed.
  try {
    await fs.mkdir(TMP_FOLDER, { recursive: true });

    try {
      await execa("yt-dlp", [
        "--skip-download",
        "--write-auto-subs",
        "--write-subs",
        "--sub-langs",
        "pl,en",
        "--sub-format",
        "srt",
        "-o",
        outputTemplate,
        url,
      ]);
    } catch (e) {
      // yt-dlp requests both languages in one invocation and exits non-zero
      // if EITHER fails (e.g. YouTube rate-limits or lacks captions for one
      // language) even when the other was already written to disk
      // successfully. Don't give up here - fall through to check
      // TMP_FOLDER for whatever did land before treating this as a total
      // failure.
      logger.info(
        `[Crawler][${jobId}] yt-dlp exited non-zero for "${url}" (checking for a partially-written transcript before giving up): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }

    const files = await fs.readdir(TMP_FOLDER);
    const srtFile =
      files.find((f) => f.startsWith(jobId) && f.endsWith(".pl.srt")) ??
      files.find((f) => f.startsWith(jobId) && f.endsWith(".srt"));

    if (srtFile) {
      const raw = await fs.readFile(path.join(TMP_FOLDER, srtFile), "utf8");
      transcript = parseSrt(raw);
    }
  } catch (e) {
    logger.info(
      `[Crawler][${jobId}] Unexpected error fetching YouTube transcript for "${url}": ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  } finally {
    try {
      const files = await fs.readdir(TMP_FOLDER);
      const cleanupFiles = files.filter((f) => f.startsWith(jobId));
      await Promise.all(
        cleanupFiles.map((f) =>
          fs.rm(path.join(TMP_FOLDER, f)).catch((e) => {
            logger.info(
              `[Crawler][${jobId}] Failed to clean up temp yt-dlp file "${f}": ${
                e instanceof Error ? e.message : String(e)
              }`,
            );
          }),
        ),
      );
    } catch {
      // TMP_FOLDER missing/unreadable (e.g. mkdir itself failed) - nothing
      // to clean up.
    }
  }

  return transcript;
}
