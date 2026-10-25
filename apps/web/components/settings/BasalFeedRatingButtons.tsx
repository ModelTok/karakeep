"use client";

import type { BasalRatingValue } from "@/lib/basal/bookmarkState";
import type React from "react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useTranslation } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useTRPC } from "@karakeep/shared-react/trpc";

const RATING_OPTIONS = [
  { value: 0, key: "basal.rating.slaby" },
  { value: 1, key: "basal.rating.sredni" },
  { value: 2, key: "basal.rating.ciekawy" },
] as const;

function useBasalRateFeedMutation(opts?: { onError?: () => void }) {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  return useMutation(
    api.basal.rateFeed.mutationOptions({
      onError: () => {
        toast({ variant: "destructive", description: t("basal.rating.error") });
        opts?.onError?.();
      },
      onSettled: async () => {
        await Promise.all([
          queryClient.invalidateQueries(api.basal.feedQuality.pathFilter()),
          queryClient.invalidateQueries(api.basal.feedRatings.pathFilter()),
          queryClient.invalidateQueries(api.basal.status.pathFilter()),
        ]);
      },
    }),
  );
}

export default function BasalFeedRatingButtons({
  feedId,
  rating,
  className,
  showLabel = false,
}: {
  feedId: string;
  rating: BasalRatingValue | null;
  className?: string;
  showLabel?: boolean;
}) {
  const { t } = useTranslation();
  const [localRating, setLocalRating] = useState(rating);

  useEffect(() => {
    setLocalRating(rating);
  }, [rating]);

  const { mutate } = useBasalRateFeedMutation({
    onError: () => setLocalRating(rating),
  });

  const onClick = (
    e: React.MouseEvent<HTMLButtonElement>,
    value: BasalRatingValue,
  ) => {
    // The feed row is focusable and owns a Delete shortcut; keep the click here.
    e.stopPropagation();
    e.preventDefault();
    const next = localRating === value ? null : value;
    setLocalRating(next);
    mutate({ feedId, rating: next });
  };

  return (
    <div
      className={cn("flex items-center gap-1", className)}
      role="group"
      aria-label={t("basal.feed.your_rating")}
    >
      {showLabel && (
        <span className="text-xs text-muted-foreground">
          {t("basal.feed.your_rating")}
        </span>
      )}
      {RATING_OPTIONS.map(({ value, key }) => {
        const active = localRating === value;
        const button = (
          <Button
            key={value}
            type="button"
            variant={active ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={active}
            className="h-7 rounded-full px-2 text-xs"
            onClick={(e) => onClick(e, value)}
          >
            {t(key)}
          </Button>
        );
        if (!active) {
          return button;
        }
        return (
          <Tooltip key={value}>
            <TooltipTrigger asChild>{button}</TooltipTrigger>
            <TooltipContent>{t("basal.rating.clear_hint")}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
