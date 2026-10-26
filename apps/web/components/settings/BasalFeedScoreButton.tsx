"use client";

import { useEffect, useRef, useState } from "react";
import { ActionButton } from "@/components/ui/action-button";
import { toast } from "@/components/ui/sonner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useTranslation } from "@/lib/i18n/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useTRPC } from "@karakeep/shared-react/trpc";

const JOB_POLL_INTERVAL_MS = 2000;

/**
 * Per-feed "score" action: runs basal.scoreFeeds for a single feed, tracks
 * the job it started and reports the outcome. Nothing runs on its own, only
 * after a click.
 */
export default function BasalFeedScoreButton({
  feedId,
  className,
}: {
  feedId: string;
  className?: string;
}) {
  const api = useTRPC();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [jobId, setJobId] = useState<string | null>(null);
  const handledJobRef = useRef<string | null>(null);

  const { data: job } = useQuery(
    api.basal.job.queryOptions(
      { id: jobId ?? "" },
      {
        enabled: jobId !== null,
        refetchInterval: (query) =>
          query.state.data?.status === "queued" ||
          query.state.data?.status === "running"
            ? JOB_POLL_INTERVAL_MS
            : false,
      },
    ),
  );

  const jobActive = job?.status === "queued" || job?.status === "running";

  useEffect(() => {
    if (!job || jobActive || handledJobRef.current === job.id) {
      return;
    }
    handledJobRef.current = job.id;
    if (job.status === "success") {
      toast({ description: t("basal.feed.scored") });
    } else {
      toast({
        variant: "destructive",
        description: t("settings.basal.job_failed", {
          error: job.error ?? "brak",
        }),
      });
    }
    void Promise.all([
      queryClient.invalidateQueries(api.basal.feedQuality.pathFilter()),
      queryClient.invalidateQueries(api.basal.status.pathFilter()),
    ]);
  }, [job, jobActive, queryClient, t, api]);

  const { mutate, isPending } = useMutation(
    api.basal.scoreFeeds.mutationOptions({
      onSuccess: ({ jobId: startedJobId }) => {
        handledJobRef.current = null;
        setJobId(startedJobId);
      },
      onError: (error) => {
        toast({ variant: "destructive", description: error.message });
      },
    }),
  );

  const loading = isPending || jobActive;

  return (
    <div className="flex items-center gap-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <ActionButton
            type="button"
            variant="outline"
            size="sm"
            className={className ?? "h-7 text-xs"}
            loading={loading}
            onClick={(e) => {
              // The feed row is focusable and owns a Delete shortcut; keep the
              // click here.
              e.stopPropagation();
              e.preventDefault();
              mutate({ feedIds: [feedId] });
            }}
          >
            {t("basal.feed.score")}
          </ActionButton>
        </TooltipTrigger>
        <TooltipContent>{t("basal.feed.score_hint")}</TooltipContent>
      </Tooltip>
      {job && jobActive && (
        <span className="text-xs text-muted-foreground">
          {t("settings.basal.job_running", {
            processed: job.processed,
            total: job.total,
          })}
        </span>
      )}
    </div>
  );
}
