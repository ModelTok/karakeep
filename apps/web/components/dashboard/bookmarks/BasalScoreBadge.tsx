"use client";

import type { BasalBookmarkState } from "@/lib/basal/bookmarkState";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useTranslation } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

const LABEL_KEYS = {
  slaby: "basal.rating.slaby",
  sredni: "basal.rating.sredni",
  ciekawy: "basal.rating.ciekawy",
} as const;

function isKnownLabel(label: string): label is keyof typeof LABEL_KEYS {
  return Object.hasOwn(LABEL_KEYS, label);
}

const confidenceFormat = new Intl.NumberFormat("pl-PL", {
  maximumFractionDigits: 2,
});

export default function BasalScoreBadge({
  score,
  className,
}: {
  score: BasalBookmarkState["score"];
  className?: string;
}) {
  const { t } = useTranslation();
  if (!score) {
    return null;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className={cn(
            "gap-1 whitespace-nowrap text-xs",
            score.stale && "border-dashed text-muted-foreground opacity-70",
            className,
          )}
        >
          <span>
            {isKnownLabel(score.label)
              ? t(LABEL_KEYS[score.label])
              : score.label}
          </span>
          <span className="font-normal">
            {confidenceFormat.format(score.confidence)}
          </span>
          {score.stale && <span aria-hidden>!</span>}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="flex flex-col gap-0.5 text-xs">
        <span className="font-semibold">{t("basal.score.tooltip_title")}</span>
        <span>
          {t("basal.score.model")}: {score.model}
        </span>
        <span>
          {t("basal.score.calibration")}: {score.calibrationId ?? "—"}
        </span>
        <span>
          {t("basal.score.expected_level")}: {score.expectedLevel.toFixed(2)}
        </span>
        {score.stale && (
          <span className="text-muted-foreground">
            {t("basal.score.stale")}
          </span>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
