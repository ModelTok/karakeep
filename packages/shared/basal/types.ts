import { z } from "zod";

// Labels used by the bridge and stored in basalScores.label. Ordered by value,
// so the index of a label equals its numeric rating.
export const BASAL_LABELS = ["slaby", "sredni", "ciekawy"] as const;

export const zBasalLabel = z.enum(BASAL_LABELS);
export type BasalLabel = z.infer<typeof zBasalLabel>;

// User rating stored in basalRatings.rating: 0 = slaby, 1 = sredni, 2 = ciekawy.
export const zBasalRating = z.union([z.literal(0), z.literal(1), z.literal(2)]);
export type BasalRating = z.infer<typeof zBasalRating>;

export function ratingToLabel(rating: BasalRating): BasalLabel {
  return BASAL_LABELS[rating];
}

export function labelToRating(label: BasalLabel): BasalRating {
  return BASAL_LABELS.indexOf(label) as BasalRating;
}

export const zBasalProbabilities = z.object({
  slaby: z.number(),
  sredni: z.number(),
  ciekawy: z.number(),
});
export type BasalProbabilities = z.infer<typeof zBasalProbabilities>;

// GET /health
export const zBasalHealth = z.object({
  ok: z.boolean(),
  model: z.string(),
  mode: z.string(),
  calibration_id: z.string().nullable(),
  engine_version: z.string(),
  error: z.string().optional(),
  // Only set by the client when BASAL_MOCK is active, never by the bridge.
  mock: z.boolean().optional(),
});
export type BasalHealth = z.infer<typeof zBasalHealth>;

// Question sent with POST /score; mirrors BasalQuestion in decision.ts.
export const zBasalQuestion = z.object({
  type: z.literal("score"),
  instructions: z.string(),
  criteria: z.array(z.string()),
});

export const zBasalQuestionName = z.enum(["usefulness", "feed_value"]);

// POST /score
export const zBasalScoreItem = z.object({
  id: z.string(),
  state: z.string(),
});
export type BasalScoreItem = z.infer<typeof zBasalScoreItem>;

export const zBasalScoreResult = z.object({
  id: z.string(),
  // Expected level in 0..2 (probability-weighted rating).
  score: z.number(),
  label: zBasalLabel,
  probabilities: zBasalProbabilities,
  confidence: z.number(),
  model: z.string(),
  calibration_id: z.string().nullable(),
  latency_ms: z.number(),
});
export type BasalScoreResult = z.infer<typeof zBasalScoreResult>;

// Feed-level score result: the item id is the RSS feed id.
export const zBasalFeedScoreResult = zBasalScoreResult
  .omit({ id: true })
  .extend({ feedId: z.string() });
export type BasalFeedScoreResult = z.infer<typeof zBasalFeedScoreResult>;

export function toFeedScoreResult(
  result: BasalScoreResult,
  feedId: string,
): BasalFeedScoreResult {
  const { id: _id, ...rest } = result;
  return { ...rest, feedId };
}

export const zBasalScoreResponse = z.object({
  results: z.array(zBasalScoreResult),
  mock: z.boolean().optional(),
});
export type BasalScoreResponse = z.infer<typeof zBasalScoreResponse>;

// POST /train
export const zBasalTrainReport = z.object({
  accuracy: z.number().nullable(),
  ece: z.number().nullable(),
  decisions: z.number(),
  automated_share: z.number().nullable(),
  thresholds: z.record(z.string(), z.unknown()),
  raw: z.string().optional(),
});
export type BasalTrainReport = z.infer<typeof zBasalTrainReport>;

export const zBasalTrainResponse = z.object({
  calibration_id: z.string(),
  path: z.string(),
  report: zBasalTrainReport,
  // Only set by the client when BASAL_MOCK is active, never by the bridge.
  mock: z.boolean().optional(),
});
export type BasalTrainResponse = z.infer<typeof zBasalTrainResponse>;

// Shape persisted in basalScores (minus ids and timestamps).
export const zBasalStoredScore = z.object({
  expectedLevel: z.number(),
  label: zBasalLabel,
  probabilities: zBasalProbabilities,
  confidence: z.number(),
  model: z.string(),
  calibrationId: z.string().nullable(),
});
export type BasalStoredScore = z.infer<typeof zBasalStoredScore>;

export const zBasalFeedStoredScore = zBasalStoredScore.extend({
  stateKind: z.string(),
});
export type BasalFeedStoredScore = z.infer<typeof zBasalFeedStoredScore>;

export function toStoredScore(result: BasalScoreResult): BasalStoredScore {
  return {
    expectedLevel: result.score,
    label: result.label,
    probabilities: result.probabilities,
    confidence: result.confidence,
    model: result.model,
    calibrationId: result.calibration_id,
  };
}
