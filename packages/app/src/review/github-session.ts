import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { PullRequestTimelineResponse } from "@getpaseo/protocol/messages";
import { useToast } from "@/contexts/toast-context";
import { useFetchQuery } from "@/data/query";
import {
  extractPrRepoIdentity,
  fetchPrPaneTimelinePage,
  isUnsupportedTimelineError,
  shouldFetchTimelineFrom,
  type PrRepoIdentity,
} from "@/git/pull-request-panel/use-data";
import { prPaneTimelineQueryKey } from "@/git/pull-request-panel/query-keys";
import { useCheckoutPrStatusQuery } from "@/git/use-pr-status-query";
import type { ParsedDiffFile } from "@/git/use-diff-query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { githubPendingReviewKey, useGithubPendingReviewStore } from "./github-pending";
import {
  collectVisibleReviewTargetKeys,
  mapGithubReviewOverlay,
  type GithubReviewOverlay,
} from "./github-threads";
import type { ReviewDraftSide } from "./state";

type PullRequestTimeline = PullRequestTimelineResponse["payload"];

export interface GithubReviewWriteTarget {
  filePath: string;
  side: ReviewDraftSide;
  lineNumber: number;
}

export interface GithubReviewSession {
  overlay: GithubReviewOverlay;
  canWrite: boolean;
  identity: {
    cwd: string;
    prNumber: number;
    repoOwner: string;
    repoName: string;
  } | null;
  pendingCount: number;
  publishComment: (target: GithubReviewWriteTarget, body: string) => Promise<void>;
  startReview: (target: GithubReviewWriteTarget, body: string) => Promise<void>;
  reply: (threadId: string, body: string) => Promise<void>;
  submit: (event: "comment" | "approve" | "request_changes") => Promise<void>;
  cancelPending: () => Promise<void>;
}

export function useGithubReviewSession(input: {
  serverId: string;
  cwd: string;
  files: readonly ParsedDiffFile[];
  enabled: boolean;
}): GithubReviewSession {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const daemonClient = useHostRuntimeClient(input.serverId);
  const isConnected = useHostRuntimeIsConnected(input.serverId);
  const canWrite = useSessionStore(
    (state) => state.sessions[input.serverId]?.serverInfo?.features?.githubPrReviewWrite === true,
  );
  const checkoutPrStatus = useCheckoutPrStatusQuery({
    serverId: input.serverId,
    cwd: input.cwd,
    enabled: input.enabled,
  });
  const identity = extractPrRepoIdentity(checkoutPrStatus.status);
  const pendingKey =
    identity.prNumber === null
      ? null
      : githubPendingReviewKey({
          serverId: input.serverId,
          cwd: input.cwd,
          prNumber: identity.prNumber,
        });
  const pending = useGithubPendingReviewStore((state) =>
    pendingKey ? (state.pending[pendingKey] ?? null) : null,
  );
  const setPending = useGithubPendingReviewStore((state) => state.setPending);
  const shouldFetchTimeline = shouldFetchTimelineFrom({
    hasClient: !!daemonClient,
    isConnected,
    timelineEnabled: input.enabled,
    githubFeaturesEnabled: checkoutPrStatus.githubFeaturesEnabled,
    cwd: input.cwd,
    identity,
    timelineUnsupported: false,
  });
  const timelineQueryKey = useMemo(
    () =>
      prPaneTimelineQueryKey({
        serverId: input.serverId,
        cwd: input.cwd,
        prNumber: identity.prNumber,
      }),
    [input.serverId, input.cwd, identity.prNumber],
  );
  const timelineQuery = useFetchQuery<PullRequestTimeline>({
    queryKey: timelineQueryKey,
    queryFn: async () => {
      if (
        !daemonClient ||
        identity.prNumber === null ||
        identity.repoOwner === null ||
        identity.repoName === null
      ) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      return fetchPrPaneTimelinePage({
        client: daemonClient,
        registry: { has: () => false, add: () => {} },
        serverId: input.serverId,
        cwd: input.cwd,
        prNumber: identity.prNumber,
        repoOwner: identity.repoOwner,
        repoName: identity.repoName,
      });
    },
    enabled: shouldFetchTimeline,
    dataShape: "list",
    immutableWhen: () => true,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: (failureCount, error) => !isUnsupportedTimelineError(error) && failureCount < 3,
  });
  const visibleTargetKeys = useMemo(
    () => collectVisibleReviewTargetKeys(input.files),
    [input.files],
  );
  const overlay = useMemo(
    () =>
      mapGithubReviewOverlay({
        items: timelineQuery.data?.items ?? [],
        visibleTargetKeys,
      }),
    [timelineQuery.data?.items, visibleTargetKeys],
  );
  const writeIdentity = completeIdentity(input.cwd, identity);

  const refreshTimeline = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: prPaneTimelineQueryKey({
        serverId: input.serverId,
        cwd: input.cwd,
        prNumber: identity.prNumber,
      }),
    });
  }, [identity.prNumber, input.cwd, input.serverId, queryClient]);

  const reportWriteError = useCallback(
    (error: unknown) => {
      if (isUnsupportedWriteError(error)) {
        toast.error(t("review.github.updateHost"));
        return;
      }
      toast.error(error instanceof Error ? error.message : String(error));
    },
    [t, toast],
  );

  const publishComment = useCallback(
    async (target: GithubReviewWriteTarget, body: string) => {
      if (!daemonClient || !writeIdentity || !canWrite) {
        toast.error(t("review.github.updateHost"));
        return;
      }
      try {
        const result = await daemonClient.checkoutGithubReviewComment({
          ...writeIdentity,
          path: target.filePath,
          side: target.side,
          line: target.lineNumber,
          body,
        });
        if (!result.success) throw new Error(result.error?.message ?? "Failed to post comment");
        await refreshTimeline();
      } catch (error) {
        reportWriteError(error);
        throw error;
      }
    },
    [canWrite, daemonClient, refreshTimeline, reportWriteError, t, toast, writeIdentity],
  );

  const startReview = useCallback(
    async (target: GithubReviewWriteTarget, body: string) => {
      if (!daemonClient || !writeIdentity || !canWrite || !pendingKey) {
        toast.error(t("review.github.updateHost"));
        return;
      }
      try {
        const result = await daemonClient.checkoutGithubReviewDraft({
          ...writeIdentity,
          path: target.filePath,
          side: target.side,
          line: target.lineNumber,
          body,
          ...(pending?.reviewId ? { reviewId: pending.reviewId } : {}),
        });
        if (!result.success) throw new Error(result.error?.message ?? "Failed to start review");
        const reviewId = result.reviewId ?? pending?.reviewId;
        if (reviewId) {
          setPending(pendingKey, { reviewId, count: (pending?.count ?? 0) + 1 });
        }
        await refreshTimeline();
      } catch (error) {
        reportWriteError(error);
        throw error;
      }
    },
    [
      canWrite,
      daemonClient,
      pending,
      pendingKey,
      refreshTimeline,
      reportWriteError,
      setPending,
      t,
      toast,
      writeIdentity,
    ],
  );

  const reply = useCallback(
    async (threadId: string, body: string) => {
      if (!daemonClient || !writeIdentity || !canWrite) {
        toast.error(t("review.github.updateHost"));
        return;
      }
      try {
        const result = await daemonClient.checkoutGithubReviewReply({
          ...writeIdentity,
          threadId,
          body,
        });
        if (!result.success) throw new Error(result.error?.message ?? "Failed to reply");
        await refreshTimeline();
      } catch (error) {
        reportWriteError(error);
        throw error;
      }
    },
    [canWrite, daemonClient, refreshTimeline, reportWriteError, t, toast, writeIdentity],
  );

  const submit = useCallback(
    async (event: "comment" | "approve" | "request_changes") => {
      if (!daemonClient || !writeIdentity || !canWrite || !pendingKey || !pending) return;
      try {
        const result = await daemonClient.checkoutGithubReviewSubmit({
          ...writeIdentity,
          reviewId: pending.reviewId,
          event,
        });
        if (!result.success) throw new Error(result.error?.message ?? "Failed to submit review");
        setPending(pendingKey, null);
        await refreshTimeline();
      } catch (error) {
        reportWriteError(error);
        throw error;
      }
    },
    [
      canWrite,
      daemonClient,
      pending,
      pendingKey,
      refreshTimeline,
      reportWriteError,
      setPending,
      writeIdentity,
    ],
  );

  const cancelPending = useCallback(async () => {
    if (!daemonClient || !writeIdentity || !canWrite || !pendingKey || !pending) return;
    try {
      const result = await daemonClient.checkoutGithubReviewCancel({
        ...writeIdentity,
        reviewId: pending.reviewId,
      });
      if (!result.success) throw new Error(result.error?.message ?? "Failed to cancel review");
      setPending(pendingKey, null);
      await refreshTimeline();
    } catch (error) {
      reportWriteError(error);
      throw error;
    }
  }, [
    canWrite,
    daemonClient,
    pending,
    pendingKey,
    refreshTimeline,
    reportWriteError,
    setPending,
    writeIdentity,
  ]);

  return {
    overlay,
    canWrite: canWrite && writeIdentity !== null,
    identity: writeIdentity,
    pendingCount: pending?.count ?? 0,
    publishComment,
    startReview,
    reply,
    submit,
    cancelPending,
  };
}

function completeIdentity(
  cwd: string,
  identity: PrRepoIdentity,
): { cwd: string; prNumber: number; repoOwner: string; repoName: string } | null {
  if (identity.prNumber === null || identity.repoOwner === null || identity.repoName === null) {
    return null;
  }
  return {
    cwd,
    prNumber: identity.prNumber,
    repoOwner: identity.repoOwner,
    repoName: identity.repoName,
  };
}

function isUnsupportedWriteError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const rpcError = error as Error & { code?: unknown; requestType?: unknown };
  return (
    error.name.toLowerCase() === "daemonrpcerror" &&
    rpcError.code === "unknown_schema" &&
    typeof rpcError.requestType === "string" &&
    rpcError.requestType.startsWith("checkout.github.review.")
  );
}
