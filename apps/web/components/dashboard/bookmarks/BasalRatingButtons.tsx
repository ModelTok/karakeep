"use client";

import type { BasalRatingValue } from "@/lib/basal/bookmarkState";
import type React from "react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useBasalRateMutation } from "@/lib/basal/bookmarkState";
import { useTranslation } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

const RATING_OPTIONS = [
  { value: 0, key: "basal.rating.slaby" },
  { value: 1, key: "basal.rating.sredni" },
  { value: 2, key: "basal.rating.ciekawy" },
] as const;

export default function BasalRatingButtons({
  bookmarkId,
  rating,
  className,
  showLabel = false,
}: {
  bookmarkId: string;
  rating: BasalRatingValue | null;
  className?: string;
  showLabel?: boolean;
}) {
  const { t } = useTranslation();
  const [localRating, setLocalRating] = useState(rating);

  useEffect(() => {
    setLocalRating(rating);
  }, [rating]);

  const { mutate } = useBasalRateMutation({
    onError: () => setLocalRating(rating),
  });

  const onClick = (
    e: React.MouseEvent<HTMLButtonElement>,
    value: BasalRatingValue,
  ) => {
    // The buttons live inside cards and links; never let the click navigate.
    e.stopPropagation();
    e.preventDefault();
    const next = localRating === value ? null : value;
    setLocalRating(next);
    mutate({ bookmarkId, rating: next });
  };

  return (
    <div
      className={cn("flex items-center gap-1", className)}
      role="group"
      aria-label={t("basal.rating.label")}
    >
      {showLabel && (
        <span className="text-xs text-muted-foreground">
          {t("basal.rating.label")}
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
