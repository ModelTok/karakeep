import type { BasalLabel, BasalProbabilities } from "./types";
import { BASAL_LABELS } from "./types";

// The single question shared by scoring and training. The bridge scores with
// the same rubric that dataset.ts writes into every labelled request.
export const USEFULNESS_QUESTION = {
  type: "score",
  instructions:
    "Jak wartościowy jest ten materiał dla Pawła (AEC/BIM/HVAC, AI, narzędzia inżynierskie)?",
  criteria: [
    "slaby - materiał nieprzydatny, poza obszarem zainteresowań albo bez konkretów.",
    "sredni - materiał w temacie, ale ogólny lub mało nowy; można przejrzeć.",
    "ciekawy - konkretny, nowy materiał warty przeczytania albo wypróbowania.",
  ],
} as const;

export interface BasalDecisionSettings {
  autoArchive: boolean;
  archiveThreshold: number;
  minConfidence: number;
}

/**
 * Returns the argmax label.
 *
 * Tie-breaking rule (deterministic): on equal probabilities the higher-value
 * label wins (ciekawy > sredni > slaby), so a tie can never push a bookmark
 * towards auto-archiving.
 */
export function labelFromAnswer(probabilities: BasalProbabilities): BasalLabel {
  let best: BasalLabel = BASAL_LABELS[BASAL_LABELS.length - 1];
  for (let i = BASAL_LABELS.length - 2; i >= 0; i--) {
    const label = BASAL_LABELS[i];
    if (probabilities[label] > probabilities[best]) {
      best = label;
    }
  }
  return best;
}

/** Probability-weighted rating in 0..2. */
export function expectedLevelFromProbabilities(
  probabilities: BasalProbabilities,
): number {
  return probabilities.sredni + 2 * probabilities.ciekawy;
}

/**
 * Auto-archive only when the user enabled it, the model says "slaby" and it is
 * at least `minConfidence` sure about it. `expectedLevel` is accepted for
 * callers that log the full decision input but does not affect the outcome;
 * `archiveThreshold` is used by `isWeakByThreshold` for reporting only.
 */
export function shouldAutoArchive(input: {
  label: BasalLabel;
  probabilities: BasalProbabilities;
  expectedLevel: number;
  settings: BasalDecisionSettings;
}): boolean {
  return (
    input.settings.autoArchive &&
    input.label === "slaby" &&
    input.probabilities.slaby >= input.settings.minConfidence
  );
}

export function isWeakByThreshold(
  expectedLevel: number,
  archiveThreshold: number,
): boolean {
  return expectedLevel < archiveThreshold;
}

/**
 * A score is stale when a calibration is active and the score was produced
 * under a different one (or without any). Without an active calibration
 * nothing is considered stale.
 */
export function isScoreStale(
  scoreCalibrationId: string | null,
  activeCalibrationId: string | null,
): boolean {
  return (
    activeCalibrationId !== null && scoreCalibrationId !== activeCalibrationId
  );
}
