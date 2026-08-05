import { eq } from "drizzle-orm";
import { workerStatsCounter } from "metrics";
import { withWorkerEventLog, withWorkerTracing } from "workerTracing";

import { db } from "@karakeep/db";
import { bookmarkLinks } from "@karakeep/db/schema";
import {
  addLogFields,
  EmbeddingsQueue,
  OpenAIQueue,
  triggerSearchReindex,
  TranscriptionQueue,
  ZTranscriptionRequest,
  ztranscriptionRequestSchema,
} from "@karakeep/shared-server";
import { readAsset } from "@karakeep/shared/assetdb";
import serverConfig from "@karakeep/shared/config";
import logger from "@karakeep/shared/logger";
import {
  DequeuedJob,
  EnqueueOptions,
  getQueueClient,
} from "@karakeep/shared/queueing";

export class TranscriptionWorker {
  static async build() {
    logger.info("Starting transcription worker ...");

    return (await getQueueClient())!.createRunner<ZTranscriptionRequest>(
      TranscriptionQueue,
      {
        run: withWorkerTracing(
          "transcriptionWorker.run",
          withWorkerEventLog("transcriptionWorker.run", runWorker),
        ),
        onComplete: async (job) => {
          workerStatsCounter.labels("transcription", "completed").inc();
          const jobId = job.id;
          logger.info(
            `[Transcription][${jobId}] Transcription completed successfully`,
          );
          return Promise.resolve();
        },
        onError: async (job) => {
          workerStatsCounter.labels("transcription", "failed").inc();
          if (job.numRetriesLeft == 0) {
            workerStatsCounter
              .labels("transcription", "failed_permanent")
              .inc();
          }
          const jobId = job.id;
          logger.error(
            `[Transcription][${jobId}] Transcription job failed: ${job.error}`,
          );
          return Promise.resolve();
        },
      },
      {
        pollIntervalMs: 1000,
        timeoutSecs: serverConfig.transcription.jobTimeoutSec,
        concurrency: serverConfig.transcription.numWorkers,
        validator: ztranscriptionRequestSchema,
      },
    );
  }
}

async function setTranscriptionStatus(
  bookmarkId: string,
  status: "success" | "failure",
  transcript?: string,
) {
  await db
    .update(bookmarkLinks)
    .set({
      transcriptionStatus: status,
      ...(transcript !== undefined ? { transcript } : {}),
    })
    .where(eq(bookmarkLinks.id, bookmarkId));
}

async function runWorker(job: DequeuedJob<ZTranscriptionRequest>) {
  const jobId = job.id;
  const { bookmarkId, userId, assetId } = job.data;

  addLogFields<"transcriptionWorker.run">({ "bookmark.id": bookmarkId });

  logger.info(
    `[Transcription][${jobId}] Starting transcription for bookmark "${bookmarkId}"`,
  );

  let asset: Buffer;
  try {
    ({ asset } = await readAsset({ userId, assetId }));
  } catch (e) {
    logger.error(
      `[Transcription][${jobId}] Failed to read video asset "${assetId}": ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    await setTranscriptionStatus(bookmarkId, "failure");
    return;
  }

  const form = new FormData();
  form.append("audio_file", new Blob([new Uint8Array(asset)]), "video.mp4");

  const url = new URL(
    `${serverConfig.transcription.apiUrl.replace(/\/$/, "")}/asr`,
  );
  url.searchParams.set("output", "txt");
  if (serverConfig.transcription.language) {
    url.searchParams.set("language", serverConfig.transcription.language);
  }

  let transcript: string;
  try {
    const resp = await fetch(url, {
      method: "POST",
      body: form,
      signal: job.abortSignal,
    });
    if (!resp.ok) {
      throw new Error(
        `ASR service returned ${resp.status}: ${await resp.text()}`,
      );
    }
    transcript = (await resp.text()).trim();
  } catch (e) {
    logger.error(
      `[Transcription][${jobId}] Failed to transcribe video for bookmark "${bookmarkId}": ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    await setTranscriptionStatus(bookmarkId, "failure");
    return;
  }

  if (!transcript) {
    logger.info(
      `[Transcription][${jobId}] Empty transcript for bookmark "${bookmarkId}", skipping`,
    );
    await setTranscriptionStatus(bookmarkId, "failure");
    return;
  }

  await setTranscriptionStatus(bookmarkId, "success", transcript);

  logger.info(
    `[Transcription][${jobId}] Saved transcript (${transcript.length} chars) for bookmark "${bookmarkId}", re-triggering tagging/summarization/search`,
  );

  // Re-run the same fan-out crawlerWorker does after a fresh crawl, so the
  // transcript actually gets used now that it exists.
  const enqueueOpts: EnqueueOptions = {
    priority: job.priority,
    groupId: userId,
  };

  if (serverConfig.embedding.enableAutoIndexing) {
    await EmbeddingsQueue.enqueue(
      {
        bookmarkId,
        type: "embed",
        runTaggingOnComplete: true,
      },
      enqueueOpts,
    );
  } else {
    await OpenAIQueue.enqueue(
      {
        bookmarkId,
        type: "tag",
      },
      enqueueOpts,
    );
  }
  await OpenAIQueue.enqueue(
    {
      bookmarkId,
      type: "summarize",
    },
    enqueueOpts,
  );
  await triggerSearchReindex(bookmarkId, enqueueOpts);
}
