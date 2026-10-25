"use client";

import { useBasalBookmarkState } from "@/lib/basal/bookmarkState";
import { cn } from "@/lib/utils";

import BasalRatingButtons from "./BasalRatingButtons";
import BasalScoreBadge from "./BasalScoreBadge";

export default function BasalBookmarkControls({
  bookmarkId,
  className,
  showLabel,
}: {
  bookmarkId: string;
  className?: string;
  showLabel?: boolean;
}) {
  const { rating, score } = useBasalBookmarkState(bookmarkId);
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <BasalRatingButtons
        bookmarkId={bookmarkId}
        rating={rating}
        showLabel={showLabel}
      />
      {score && <BasalScoreBadge score={score} />}
    </div>
  );
}
