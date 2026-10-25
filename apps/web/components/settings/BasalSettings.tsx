"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ActionButton } from "@/components/ui/action-button";
import FormattedDate from "@/components/ui/formatted-date";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { FullPageSpinner } from "@/components/ui/full-page-spinner";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTranslation } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle, Circle, Save } from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { useTRPC } from "@karakeep/shared-react/trpc";

import BasalFeedRatingButtons from "./BasalFeedRatingButtons";
import { BasalFeedArticleMeanCell, BasalFeedScoreCell } from "./FeedSettings";
import { SettingsPage, SettingsSection } from "./SettingsPage";

// Must match BASAL_MIN_RATINGS in packages/trpc (train rejects fewer).
const MIN_TRAIN_RATINGS = 20;
const MILESTONES = [
  { count: 50, key: "settings.basal.milestone_50" },
  { count: 85, key: "settings.basal.milestone_85" },
  { count: 430, key: "settings.basal.milestone_430" },
] as const;
const MILESTONE_MAX = 430;
const JOB_POLL_INTERVAL_MS = 2000;

const JOB_TYPE_KEYS = {
  score: "settings.basal.job_type_score",
  score_feeds: "settings.basal.job_type_score_feeds",
  train: "settings.basal.job_type_train",
} as const;

type JobStatus = "queued" | "running" | "success" | "failure";

function isJobActive(status: JobStatus | undefined) {
  return status === "queued" || status === "running";
}

const zBasalSettingsForm = z.object({
  autoArchive: z.boolean(),
  archiveThreshold: z.number().min(0).max(2),
  minConfidence: z.number().min(0).max(1),
  maxItems: z.number().int().min(1).max(200),
});
type BasalSettingsForm = z.infer<typeof zBasalSettingsForm>;

function formatMetric(value: unknown): string {
  if (value === null || value === undefined) {
    return "—";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(3);
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

// Renders scalars inline and one level of nested records as key/value lines.
function MetricValue({ value }: { value: unknown }) {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      return <span>—</span>;
    }
    return (
      <ul className="space-y-0.5">
        {entries.map(([key, inner]) => (
          <li key={key} className="font-mono text-xs">
            <span className="text-muted-foreground">{key}:</span>{" "}
            {inner !== null &&
            typeof inner === "object" &&
            !Array.isArray(inner)
              ? Object.entries(inner as Record<string, unknown>)
                  .map(([k, v]) => `${k} ${formatMetric(v)}`)
                  .join(", ")
              : formatMetric(inner)}
          </li>
        ))}
      </ul>
    );
  }
  return <span>{formatMetric(value)}</span>;
}

function StatusRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}

function BasalSettingsFormSection({
  settings,
}: {
  settings: BasalSettingsForm;
}) {
  const api = useTRPC();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const form = useForm<BasalSettingsForm>({
    resolver: zodResolver(zBasalSettingsForm),
    defaultValues: settings,
  });

  const { autoArchive, archiveThreshold, minConfidence, maxItems } = settings;
  useEffect(() => {
    form.reset({ autoArchive, archiveThreshold, minConfidence, maxItems });
  }, [autoArchive, archiveThreshold, minConfidence, maxItems]);

  const { mutate: updateSettings, isPending } = useMutation(
    api.basal.updateSettings.mutationOptions({
      onSuccess: () => {
        toast({ description: t("settings.basal.saved") });
        queryClient.invalidateQueries(api.basal.status.pathFilter());
      },
      onError: (error) => {
        toast({ variant: "destructive", description: error.message });
      },
    }),
  );

  const numberField = (
    name: "archiveThreshold" | "minConfidence" | "maxItems",
    label: string,
    step: string,
  ) => (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input
              type="number"
              step={step}
              {...field}
              value={Number.isNaN(field.value) ? "" : field.value}
              onChange={(e) => field.onChange(e.target.valueAsNumber)}
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );

  return (
    <SettingsSection title={t("settings.basal.settings_title")}>
      <Form {...form}>
        <form
          className="flex flex-col gap-4"
          onSubmit={form.handleSubmit((value) => updateSettings(value))}
        >
          <FormField
            control={form.control}
            name="autoArchive"
            render={({ field }) => (
              <FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
                <div className="space-y-0.5">
                  <FormLabel>{t("settings.basal.auto_archive")}</FormLabel>
                  <FormDescription>
                    {t("settings.basal.auto_archive_hint")}
                  </FormDescription>
                </div>
                <FormControl>
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                </FormControl>
              </FormItem>
            )}
          />
          {numberField(
            "archiveThreshold",
            t("settings.basal.archive_threshold"),
            "0.05",
          )}
          {numberField(
            "minConfidence",
            t("settings.basal.min_confidence"),
            "0.01",
          )}
          {numberField("maxItems", t("settings.basal.max_items"), "1")}
          <div>
            <ActionButton type="submit" loading={isPending}>
              <Save className="mr-2 size-4" />
              {t("settings.basal.save")}
            </ActionButton>
          </div>
        </form>
      </Form>
    </SettingsSection>
  );
}

export default function BasalSettings() {
  const api = useTRPC();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [jobId, setJobId] = useState<string | null>(null);
  const handledJobRef = useRef<string | null>(null);

  const {
    data: status,
    isLoading,
    error,
  } = useQuery(api.basal.status.queryOptions());
  const { data: feedQuality } = useQuery(api.basal.feedQuality.queryOptions());

  // Pick up a job that was already running when the page opened.
  const runningJobId = status?.runningJob?.id;
  useEffect(() => {
    if (!jobId && runningJobId) {
      setJobId(runningJobId);
    }
  }, [jobId, runningJobId]);

  const { data: job } = useQuery(
    api.basal.job.queryOptions(
      { id: jobId ?? "" },
      {
        enabled: jobId !== null,
        refetchInterval: (query) =>
          isJobActive(query.state.data?.status) ? JOB_POLL_INTERVAL_MS : false,
      },
    ),
  );

  useEffect(() => {
    if (!job || isJobActive(job.status) || handledJobRef.current === job.id) {
      return;
    }
    handledJobRef.current = job.id;
    const invalidations = [
      queryClient.invalidateQueries(api.basal.status.pathFilter()),
    ];
    if (job.status === "success") {
      invalidations.push(
        queryClient.invalidateQueries(api.basal.feedQuality.pathFilter()),
        queryClient.invalidateQueries(
          api.basal.ratingsForBookmarks.pathFilter(),
        ),
      );
    }
    void Promise.all(invalidations);
  }, [job]);

  const onJobStarted = ({ jobId: id }: { jobId: string }) => {
    handledJobRef.current = null;
    setJobId(id);
  };
  const onJobStartError = (error: { message: string }) => {
    toast({ variant: "destructive", description: error.message });
  };

  const { mutate: train, isPending: isTrainStarting } = useMutation(
    api.basal.train.mutationOptions({
      onSuccess: (data) => {
        onJobStarted(data);
        for (const warning of data.warnings) {
          toast({ description: warning });
        }
      },
      onError: onJobStartError,
    }),
  );
  const { mutate: scoreIncoming, isPending: isScoreStarting } = useMutation(
    api.basal.scoreIncoming.mutationOptions({
      onSuccess: onJobStarted,
      onError: onJobStartError,
    }),
  );
  const { mutate: scoreFeeds, isPending: isScoreFeedsStarting } = useMutation(
    api.basal.scoreFeeds.mutationOptions({
      onSuccess: onJobStarted,
      onError: onJobStartError,
    }),
  );

  if (isLoading) {
    return <FullPageSpinner />;
  }
  if (error || !status) {
    return (
      <SettingsPage
        title={t("settings.basal.title")}
        description={t("settings.basal.description")}
      >
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>{t("settings.basal.unavailable")}</AlertTitle>
          <AlertDescription>{error?.message}</AlertDescription>
        </Alert>
      </SettingsPage>
    );
  }

  const { bridge, counts, activeCalibration } = status;
  const totalRatings = counts.ratings + counts.feedRatings;
  // A finished job polled here can be newer than the cached status.
  const jobBusy = job ? isJobActive(job.status) : status.runningJob !== null;
  const starting = isTrainStarting || isScoreStarting || isScoreFeedsStarting;
  const busy = jobBusy || starting;
  const notEnoughRatings = totalRatings < MIN_TRAIN_RATINGS;
  const busyReason =
    job && isJobActive(job.status)
      ? t("settings.basal.job_running", {
          processed: job.processed,
          total: job.total,
        })
      : status.runningJob
        ? t("settings.basal.job_running", {
            processed: status.runningJob.processed,
            total: status.runningJob.total,
          })
        : null;
  const metrics = activeCalibration?.metrics as
    | Record<string, unknown>
    | null
    | undefined;

  return (
    <SettingsPage
      title={t("settings.basal.title")}
      description={t("settings.basal.description")}
    >
      {status.mock && (
        <Alert className="border-yellow-500/60 bg-yellow-500/10">
          <AlertTriangle className="size-4" />
          <AlertDescription className="font-medium">
            {t("settings.basal.mock_badge")}
          </AlertDescription>
        </Alert>
      )}

      <SettingsSection title={t("settings.basal.status_title")}>
        {!bridge.ok && (
          <Alert variant="destructive">
            <AlertTriangle className="size-4" />
            <AlertTitle>{t("settings.basal.unavailable")}</AlertTitle>
            <AlertDescription>
              {t("settings.basal.unavailable_hint", { url: bridge.baseUrl })}
            </AlertDescription>
          </Alert>
        )}
        <div className="space-y-2">
          <StatusRow label={t("settings.basal.bridge")}>
            <span
              className={cn(
                "inline-flex items-center gap-1",
                bridge.ok ? "text-green-600" : "text-destructive",
              )}
            >
              {bridge.ok ? (
                <CheckCircle className="size-4" />
              ) : (
                <AlertTriangle className="size-4" />
              )}
              <span className="font-mono text-xs">{bridge.baseUrl}</span>
            </span>
          </StatusRow>
          <StatusRow label={t("settings.basal.model")}>
            {bridge.model || "—"}
          </StatusRow>
          <StatusRow label={t("settings.basal.mode")}>
            {bridge.mode || "—"}
          </StatusRow>
          <StatusRow label={t("settings.basal.engine_version")}>
            {bridge.engineVersion || "—"}
          </StatusRow>
          <StatusRow label={t("settings.basal.active_calibration")}>
            {activeCalibration ? (
              <span className="inline-flex items-center gap-2">
                <FormattedDate date={activeCalibration.createdAt} />
                <span className="font-mono text-xs text-muted-foreground">
                  {activeCalibration.id.slice(0, 8)}
                </span>
              </span>
            ) : (
              <span className="text-muted-foreground">
                {t("settings.basal.no_calibration")}
              </span>
            )}
          </StatusRow>
        </div>
      </SettingsSection>

      <SettingsSection title={t("settings.basal.ratings_title")}>
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <span className="font-medium">
            {t("settings.basal.ratings_total", { count: totalRatings })}
          </span>
          <span className="text-muted-foreground">
            {t("settings.basal.ratings_articles", { count: counts.ratings })}
          </span>
          <span className="text-muted-foreground">
            {t("settings.basal.ratings_feeds", { count: counts.feedRatings })}
          </span>
        </div>
        <div className="space-y-2">
          <Progress
            className="h-2"
            value={Math.min(totalRatings / MILESTONE_MAX, 1) * 100}
          />
          <p className="text-xs text-muted-foreground">
            {t("settings.basal.milestone_hint")}
          </p>
        </div>
        <ul className="space-y-1.5">
          {MILESTONES.map(({ count, key }) => {
            const reached = totalRatings >= count;
            return (
              <li key={count} className="flex items-center gap-2 text-sm">
                {reached ? (
                  <CheckCircle className="size-4 text-green-600" />
                ) : (
                  <Circle className="size-4 text-muted-foreground" />
                )}
                <span>{t(key)}</span>
                <span className="text-xs text-muted-foreground">
                  {reached
                    ? t("settings.basal.milestone_reached")
                    : t("settings.basal.milestone_missing", {
                        count: count - totalRatings,
                      })}
                </span>
              </li>
            );
          })}
        </ul>
      </SettingsSection>

      <SettingsSection title={t("settings.basal.actions_title")}>
        <div className="flex flex-wrap items-start gap-4">
          <div className="max-w-sm space-y-1">
            <ActionButton
              loading={isTrainStarting}
              disabled={busy || notEnoughRatings}
              onClick={() => train()}
            >
              {t("settings.basal.train")}
            </ActionButton>
            <p className="text-xs text-muted-foreground">
              {t("settings.basal.train_hint")}
            </p>
            {notEnoughRatings && (
              <p className="text-xs text-muted-foreground">
                {t("settings.basal.not_enough_ratings")}
              </p>
            )}
          </div>
          <ActionButton
            variant="secondary"
            loading={isScoreStarting}
            disabled={busy}
            onClick={() => scoreIncoming()}
          >
            {t("settings.basal.score_incoming")}
          </ActionButton>
          <ActionButton
            variant="secondary"
            loading={isScoreFeedsStarting}
            disabled={busy}
            onClick={() => scoreFeeds()}
          >
            {t("settings.basal.score_feeds")}
          </ActionButton>
        </div>
        {busyReason && (
          <p className="text-sm text-muted-foreground">{busyReason}</p>
        )}
        {job && (
          <div
            className={cn(
              "rounded-md border p-3 text-sm",
              job.status === "failure" &&
                "border-destructive/50 text-destructive",
            )}
          >
            <div className="font-medium">{t(JOB_TYPE_KEYS[job.type])}</div>
            {isJobActive(job.status) ? (
              <div className="mt-2 space-y-1">
                <Progress
                  className="h-2"
                  value={job.total > 0 ? (job.processed / job.total) * 100 : 0}
                />
                <span className="text-xs text-muted-foreground">
                  {t("settings.basal.job_running", {
                    processed: job.processed,
                    total: job.total,
                  })}
                </span>
              </div>
            ) : job.status === "success" ? (
              <span className="text-green-600">
                {t("settings.basal.job_success")}
              </span>
            ) : (
              <span>
                {t("settings.basal.job_failed", { error: job.error ?? "—" })}
              </span>
            )}
          </div>
        )}
      </SettingsSection>

      <SettingsSection title={t("settings.basal.last_report")}>
        {metrics ? (
          <div className="space-y-2">
            <StatusRow label={t("settings.basal.accuracy")}>
              <MetricValue value={metrics.accuracy} />
            </StatusRow>
            <StatusRow label={t("settings.basal.ece")}>
              <MetricValue value={metrics.ece} />
            </StatusRow>
            <StatusRow label={t("settings.basal.decisions")}>
              <MetricValue value={metrics.decisions} />
            </StatusRow>
            <StatusRow label={t("settings.basal.automated_share")}>
              <MetricValue value={metrics.automated_share} />
            </StatusRow>
            <StatusRow label={t("settings.basal.thresholds")}>
              <MetricValue value={metrics.thresholds} />
            </StatusRow>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("settings.basal.no_calibration")}
          </p>
        )}
      </SettingsSection>

      <BasalSettingsFormSection settings={status.settings} />

      <SettingsSection title={t("settings.basal.feeds_title")}>
        {!feedQuality || feedQuality.length === 0 ? (
          <p className="rounded-md bg-muted p-3 text-center text-sm text-muted-foreground">
            {t("settings.basal.feeds_empty")}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("common.name")}</TableHead>
                <TableHead>{t("basal.feed.your_rating")}</TableHead>
                <TableHead>{t("basal.feed.basal_score")}</TableHead>
                <TableHead>{t("basal.feed.article_mean")}</TableHead>
                <TableHead>{t("basal.feed.quality")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {feedQuality.map((row) => (
                <TableRow key={row.feedId}>
                  <TableCell
                    className={cn(!row.enabled && "text-muted-foreground")}
                  >
                    {row.name}
                  </TableCell>
                  <TableCell>
                    <BasalFeedRatingButtons
                      feedId={row.feedId}
                      rating={row.userRating}
                    />
                  </TableCell>
                  <TableCell>
                    <BasalFeedScoreCell quality={row} />
                  </TableCell>
                  <TableCell>
                    <BasalFeedArticleMeanCell quality={row} />
                  </TableCell>
                  <TableCell className="text-sm">
                    {row.weakShare !== null ? (
                      `${Math.round(row.weakShare * 100)}%`
                    ) : (
                      <span className="text-muted-foreground">
                        {t("basal.feed.no_data")}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SettingsSection>
    </SettingsPage>
  );
}
