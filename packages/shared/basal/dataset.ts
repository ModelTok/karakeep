import type { BasalQuestion } from "./decision";
import type { BasalStateKind } from "./state";
import type { BasalRating } from "./types";
import { FEED_VALUE_QUESTION, USEFULNESS_QUESTION } from "./decision";

export interface BasalLabelledQuestion extends BasalQuestion {
  gold: BasalRating;
}

// Article request: always usefulness, optionally feed_value.
export interface BasalArticleLabelledRequest {
  id: string;
  group: string;
  state: string;
  questions: {
    usefulness: BasalLabelledQuestion;
    feed_value?: BasalLabelledQuestion;
  };
}

// Standalone feed request: only feed_value.
export interface BasalFeedLabelledRequest {
  id: string;
  group: string;
  state: string;
  questions: {
    feed_value: BasalLabelledQuestion;
  };
}

export type BasalLabelledRequest =
  | BasalArticleLabelledRequest
  | BasalFeedLabelledRequest;

function labelledQuestion(
  question: typeof USEFULNESS_QUESTION | typeof FEED_VALUE_QUESTION,
  gold: BasalRating,
): BasalLabelledQuestion {
  return {
    type: question.type,
    instructions: question.instructions,
    criteria: [...question.criteria],
    gold,
  };
}

/**
 * Article request. `feedRating` adds a feed_value question so the article
 * state also teaches the feed-level rubric.
 */
export function buildLabelledRequest(input: {
  id: string;
  group: string;
  state: string;
  rating: BasalRating;
  feedRating?: BasalRating | null;
}): BasalArticleLabelledRequest {
  const questions: BasalArticleLabelledRequest["questions"] = {
    usefulness: labelledQuestion(USEFULNESS_QUESTION, input.rating),
  };
  if (input.feedRating !== undefined && input.feedRating !== null) {
    questions.feed_value = labelledQuestion(
      FEED_VALUE_QUESTION,
      input.feedRating,
    );
  }
  return {
    id: input.id,
    group: input.group,
    state: input.state,
    questions,
  };
}

/** Standalone feed request: the state is a feed summary, not an article. */
export function buildFeedLabelledRequest(input: {
  id: string;
  group: string;
  state: string;
  rating: BasalRating;
}): BasalFeedLabelledRequest {
  return {
    id: input.id,
    group: input.group,
    state: input.state,
    questions: {
      feed_value: labelledQuestion(FEED_VALUE_QUESTION, input.rating),
    },
  };
}

export interface BasalDatasetEntry {
  id: string;
  group: string;
  state: string;
  stateKind: BasalStateKind;
  rating: BasalRating;
  feedRating?: BasalRating | null;
}

export interface BasalFeedDatasetEntry {
  id: string;
  group: string;
  state: string;
  rating: BasalRating;
}

/**
 * Builds the JSONL lines for /train. Article entries without usable text
 * (`title_only`) are skipped and counted. Feed entries are always written: a
 * feed summary is usable text by construction.
 */
export function buildDataset(
  entries: BasalDatasetEntry[],
  feedEntries: BasalFeedDatasetEntry[] = [],
): {
  lines: string[];
  skipped: number;
  articles: number;
  feedQuestions: number;
  standaloneFeeds: number;
} {
  const lines: string[] = [];
  let skipped = 0;
  let articles = 0;
  let feedQuestions = 0;
  for (const entry of entries) {
    if (entry.stateKind === "title_only") {
      skipped++;
      continue;
    }
    const request = buildLabelledRequest({
      id: entry.id,
      group: entry.group,
      state: entry.state,
      rating: entry.rating,
      feedRating: entry.feedRating,
    });
    lines.push(JSON.stringify(request));
    articles++;
    if (request.questions.feed_value) {
      feedQuestions++;
    }
  }
  for (const entry of feedEntries) {
    lines.push(JSON.stringify(buildFeedLabelledRequest(entry)));
  }
  return {
    lines,
    skipped,
    articles,
    feedQuestions,
    standaloneFeeds: feedEntries.length,
  };
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
