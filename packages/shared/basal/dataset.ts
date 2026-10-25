import type { BasalStateKind } from "./state";
import type { BasalRating } from "./types";
import { USEFULNESS_QUESTION } from "./decision";

export interface BasalLabelledRequest {
  id: string;
  group: string;
  state: string;
  questions: {
    usefulness: {
      type: typeof USEFULNESS_QUESTION.type;
      instructions: string;
      criteria: string[];
      gold: BasalRating;
    };
  };
}

export function buildLabelledRequest(input: {
  id: string;
  group: string;
  state: string;
  rating: BasalRating;
}): BasalLabelledRequest {
  return {
    id: input.id,
    group: input.group,
    state: input.state,
    questions: {
      usefulness: {
        type: USEFULNESS_QUESTION.type,
        instructions: USEFULNESS_QUESTION.instructions,
        criteria: [...USEFULNESS_QUESTION.criteria],
        gold: input.rating,
      },
    },
  };
}

export interface BasalDatasetEntry {
  id: string;
  group: string;
  state: string;
  stateKind: BasalStateKind;
  rating: BasalRating;
}

/**
 * Builds the JSONL lines for /train. Entries without usable text
 * (`title_only`) are skipped and counted.
 */
export function buildDataset(entries: BasalDatasetEntry[]): {
  lines: string[];
  skipped: number;
} {
  const lines: string[] = [];
  let skipped = 0;
  for (const entry of entries) {
    if (entry.stateKind === "title_only") {
      skipped++;
      continue;
    }
    lines.push(
      JSON.stringify(
        buildLabelledRequest({
          id: entry.id,
          group: entry.group,
          state: entry.state,
          rating: entry.rating,
        }),
      ),
    );
  }
  return { lines, skipped };
}

/**
 * Split group for a bookmark: the RSS feed when it came from one, otherwise
 * its domain. Keeps one source on a single side of the FIT/CERT split.
 */
export function groupFor(input: {
  feedId?: string | null;
  domain: string;
}): string {
  if (input.feedId) {
    return `feed:${input.feedId}`;
  }
  return `domain:${input.domain}`;
}
