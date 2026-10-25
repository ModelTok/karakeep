"use client";

import type { ReactNode } from "react";
import { createContext, useContext, useMemo } from "react";
import { toast } from "@/components/ui/sonner";
import { useTranslation } from "@/lib/i18n/client";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { useTRPC } from "@karakeep/shared-react/trpc";

export type BasalRatingValue = 0 | 1 | 2;

export interface BasalBookmarkState {
  rating: BasalRatingValue | null;
  score: {
    label: string;
    confidence: number;
    expectedLevel: number;
    model: string;
    calibrationId: string | null;
    stale: boolean;
  } | null;
}

export const BASAL_EMPTY_STATE: BasalBookmarkState = {
  rating: null,
  score: null,
};

// Must match RATINGS_FOR_BOOKMARKS_CAP in packages/trpc/routers/basal.ts.
// Infinite scroll can accumulate more ids than one request accepts.
const RATINGS_CHUNK_SIZE = 200;

const RATINGS_QUERY_OPTIONS = {
  staleTime: 30_000,
  refetchOnWindowFocus: false,
} as const;

// To refresh ratings and scores after a change, invalidate
// api.basal.ratingsForBookmarks.pathFilter() (see useBasalRateMutation).

interface BasalBookmarkStateContextValue {
  states: Record<string, BasalBookmarkState>;
}

const BasalBookmarkStateContext =
  createContext<BasalBookmarkStateContextValue | null>(null);

// Module-level so useQueries keeps the combined value stable between renders.
function combineRatingResults(
  results: { data?: Record<string, BasalBookmarkState> }[],
): BasalBookmarkStateContextValue {
  const states: Record<string, BasalBookmarkState> = {};
  for (const { data } of results) {
    if (data) {
      Object.assign(states, data);
    }
  }
  return { states };
}

export function BasalBookmarkStateProvider({
  ids,
  children,
}: {
  ids: string[];
  children: ReactNode;
}) {
  const api = useTRPC();
  const chunks = useMemo(() => {
    const out: string[][] = [];
    for (let i = 0; i < ids.length; i += RATINGS_CHUNK_SIZE) {
      out.push(ids.slice(i, i + RATINGS_CHUNK_SIZE));
    }
    return out;
  }, [ids]);

  const value = useQueries({
    queries: chunks.map((chunk) =>
      api.basal.ratingsForBookmarks.queryOptions(
        { ids: chunk },
        { ...RATINGS_QUERY_OPTIONS, enabled: chunk.length > 0 },
      ),
    ),
    combine: combineRatingResults,
  });

  return (
    <BasalBookmarkStateContext.Provider value={value}>
      {children}
    </BasalBookmarkStateContext.Provider>
  );
}

export function useBasalBookmarkState(bookmarkId: string): BasalBookmarkState {
  const api = useTRPC();
  const context = useContext(BasalBookmarkStateContext);
  // Outside a provider (e.g. the preview page) fetch this bookmark alone.
  const { data } = useQuery(
    api.basal.ratingsForBookmarks.queryOptions(
      { ids: [bookmarkId] },
      { ...RATINGS_QUERY_OPTIONS, enabled: context === null },
    ),
  );
  if (context) {
    return context.states[bookmarkId] ?? BASAL_EMPTY_STATE;
  }
  return data?.[bookmarkId] ?? BASAL_EMPTY_STATE;
}

export function useBasalRateMutation(opts?: {
  onSuccess?: () => void;
  onError?: () => void;
}) {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  return useMutation(
    api.basal.rate.mutationOptions({
      onSuccess: () => {
        opts?.onSuccess?.();
      },
      onError: () => {
        toast({ variant: "destructive", description: t("basal.rating.error") });
        opts?.onError?.();
      },
      onSettled: async () => {
        await Promise.all([
          queryClient.invalidateQueries(
            api.basal.ratingsForBookmarks.pathFilter(),
          ),
          queryClient.invalidateQueries(api.basal.status.pathFilter()),
        ]);
      },
    }),
  );
}
