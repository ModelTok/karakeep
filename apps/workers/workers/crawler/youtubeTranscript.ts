import * as fs from "node:fs/promises";
import * as os from "os";
import * as path from "path";
import { execa } from "execa";

import logger from "@karakeep/shared/logger";

const YOUTUBE_URL_RE = /(?:youtube\.com\/watch\?v=|youtu\.be\/)/;
const MAX_TRANSCRIPT_CHARS = 20000;
const TMP_FOLDER = path.join(os.tmpdir(), "yt_transcripts");

const TIMESTAMP_RE = /^\d{2}:\d{2}:\d{2},\d{3} --> /;
const INDEX_RE = /^\d+$/;

export function isYoutubeVideoUrl(url: string): boolean {
  return YOUTUBE_URL_RE.test(url);
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
  await fs.mkdir(TMP_FOLDER, { recursive: true });
  const outputTemplate = path.join(TMP_FOLDER, jobId);

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
    logger.info(
      `[Crawler][${jobId}] yt-dlp subtitle fetch failed for "${url}": ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return null;
  }

  // Anything from here on (listing/reading/parsing the subtitle files) must
  // never let an exception escape this function - a missing/unreadable
  // transcript is a normal outcome for the crawl, not a fatal error - and
  // whatever yt-dlp wrote to TMP_FOLDER for this jobId must always be
  // cleaned up, on every exit path.
  let cleanupFiles: string[] = [];
  try {
    const files = await fs.readdir(TMP_FOLDER);
    cleanupFiles = files.filter((f) => f.startsWith(jobId));
    const srtFile =
      files.find((f) => f.startsWith(jobId) && f.endsWith(".pl.srt")) ??
      files.find((f) => f.startsWith(jobId) && f.endsWith(".srt"));

    if (!srtFile) {
      return null;
    }

    const fullPath = path.join(TMP_FOLDER, srtFile);
    const raw = await fs.readFile(fullPath, "utf8");
    return parseSrt(raw);
  } catch (e) {
    logger.info(
      `[Crawler][${jobId}] Failed to read yt-dlp subtitle output for "${url}": ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return null;
  } finally {
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
  }
}
