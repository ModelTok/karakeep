import type { z } from "zod";

import type {
  BasalHealth,
  BasalProbabilities,
  BasalScoreItem,
  BasalScoreResponse,
  BasalTrainResponse,
} from "./types";
import type { BasalQuestion, BasalQuestionName } from "./decision";
import { expectedLevelFromProbabilities, labelFromAnswer } from "./decision";
import {
  zBasalHealth,
  zBasalScoreResponse,
  zBasalTrainResponse,
} from "./types";

export const BASAL_DEFAULT_BRIDGE_URL = "http://host.docker.internal:8010";
export const BASAL_HEALTH_TIMEOUT_MS = 10_000;
export const BASAL_SCORE_TIMEOUT_MS = 180_000;
export const BASAL_TRAIN_TIMEOUT_MS = 1_800_000;

const BODY_EXCERPT_CHARS = 500;

/** The bridge could not be reached (connect failure, DNS, timeout). */
export class BasalUnavailableError extends Error {
  readonly baseUrl: string;
  constructor(baseUrl: string, reason: string) {
    super(`Basal bridge at ${baseUrl} is unavailable: ${reason}`);
    this.name = "BasalUnavailableError";
    this.baseUrl = baseUrl;
  }
}

/** The bridge answered with a non-2xx status or an unparsable body. */
export class BasalBridgeError extends Error {
  readonly status: number;
  readonly bodyExcerpt: string;
  constructor(status: number, bodyExcerpt: string, message?: string) {
    super(
      message ??
        `Basal bridge responded with HTTP ${status}: ${bodyExcerpt || "(empty body)"}`,
    );
    this.name = "BasalBridgeError";
    this.status = status;
    this.bodyExcerpt = bodyExcerpt;
  }
}

export interface BasalClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  // Overrides BASAL_MOCK. When undefined the env var is read on every call.
  mock?: boolean;
}

/** BASAL_MOCK accepts "1" or "true". Read at call time, not module load. */
export function isBasalMockEnabled(): boolean {
  const value = process.env.BASAL_MOCK?.trim().toLowerCase();
  return value === "1" || value === "true";
}

// FNV-1a, 32 bit. Deterministic and dependency free.
function hash32(input: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Deterministic fake probabilities derived from a hash of `id + state`. */
export function mockProbabilities(
  id: string,
  state: string,
): BasalProbabilities {
  const key = id + state;
  const raw = [
    hash32(key, 0x811c9dc5),
    hash32(key, 0x01000193),
    hash32(key, 0x9e3779b9),
  ].map((h) => (h % 1000) + 1);
  const sum = raw[0] + raw[1] + raw[2];
  const slaby = round4(raw[0] / sum);
  const sredni = round4(raw[1] / sum);
  return { slaby, sredni, ciekawy: round4(1 - slaby - sredni) };
}

export class BasalClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly mockOverride: boolean | undefined;

  constructor(opts: BasalClientOptions = {}) {
    const base =
      opts.baseUrl ?? process.env.BASAL_BRIDGE_URL ?? BASAL_DEFAULT_BRIDGE_URL;
    this.baseUrl = base.replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
    this.mockOverride = opts.mock;
  }

  isMock(): boolean {
    return this.mockOverride ?? isBasalMockEnabled();
  }

  async health(): Promise<BasalHealth> {
    if (this.isMock()) {
      return {
        ok: true,
        model: "mock",
        mode: "mock",
        calibration_id: null,
        engine_version: "mock",
        mock: true,
      };
    }
    return this.request(
      "GET",
      "/health",
      undefined,
      BASAL_HEALTH_TIMEOUT_MS,
      zBasalHealth,
    );
  }

  /**
   * Without `opts` the bridge falls back to its own usefulness question.
   * `questionName` selects the answer key used by /v1/systemone.
   */
  async score(
    items: BasalScoreItem[],
    opts: { question?: BasalQuestion; questionName?: BasalQuestionName } = {},
  ): Promise<BasalScoreResponse> {
    if (this.isMock()) {
      return {
        mock: true,
        results: items.map((item) => {
          const probabilities = mockProbabilities(item.id, item.state);
          return {
            id: item.id,
            score: round4(expectedLevelFromProbabilities(probabilities)),
            label: labelFromAnswer(probabilities),
            probabilities,
            confidence: Math.max(
              probabilities.slaby,
              probabilities.sredni,
              probabilities.ciekawy,
            ),
            model: "mock",
            calibration_id: null,
            latency_ms: 0,
          };
        }),
      };
    }
    return this.request(
      "POST",
      "/score",
      {
        items,
        ...(opts.question ? { question: opts.question } : {}),
        ...(opts.questionName ? { questionName: opts.questionName } : {}),
      },
      BASAL_SCORE_TIMEOUT_MS,
      zBasalScoreResponse,
    );
  }

  /** `requests` holds one JSON-encoded /v1/systemone request per element. */
  async train(requests: string[]): Promise<BasalTrainResponse> {
    if (this.isMock()) {
      const id = hash32(requests.join("\n")).toString(16).padStart(8, "0");
      return {
        calibration_id: `mock-${id}`,
        path: `mock://calibrations/mock-${id}.json`,
        report: {
          accuracy: null,
          ece: null,
          decisions: requests.length,
          automated_share: null,
          thresholds: {},
        },
        mock: true,
      };
    }
    return this.request(
      "POST",
      "/train",
      { requests },
      BASAL_TRAIN_TIMEOUT_MS,
      zBasalTrainResponse,
    );
  }

  private async request<T extends z.ZodTypeAny>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    timeoutMs: number,
    schema: T,
  ): Promise<z.infer<T>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers:
          body === undefined
            ? undefined
            : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const err = e as Error;
      const reason =
        err.name === "TimeoutError" || err.name === "AbortError"
          ? `no response within ${Math.round(timeoutMs / 1000)} s`
          : describeNetworkError(err);
      throw new BasalUnavailableError(this.baseUrl, reason);
    }

    let text: string;
    try {
      text = await response.text();
    } catch (e) {
      throw new BasalUnavailableError(
        this.baseUrl,
        `failed reading response: ${(e as Error).message}`,
      );
    }

    if (!response.ok) {
      throw new BasalBridgeError(
        response.status,
        text.slice(0, BODY_EXCERPT_CHARS),
      );
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new BasalBridgeError(
        response.status,
        text.slice(0, BODY_EXCERPT_CHARS),
        `Basal bridge returned invalid JSON for ${path}`,
      );
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new BasalBridgeError(
        response.status,
        text.slice(0, BODY_EXCERPT_CHARS),
        `Basal bridge returned an unexpected payload for ${path}: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  }
}

function describeNetworkError(err: Error): string {
  // undici wraps the socket error in `cause` (ECONNREFUSED, ENOTFOUND, ...).
  const cause = (err as Error & { cause?: { code?: string; message?: string } })
    .cause;
  if (cause?.code) {
    return `${err.message} (${cause.code})`;
  }
  return err.message;
}

export function createBasalClient(opts: BasalClientOptions = {}): BasalClient {
  return new BasalClient(opts);
}
