import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { PullRequestReviewThreadsResponse } from "@getpaseo/protocol/messages";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useCheckoutPrStatusQuery } from "@/git/use-pr-status-query";
import { extractPrRepoIdentity, type PrRepoIdentity } from "@/hooks/use-pr-pane-data";
import { prReviewThreadsQueryKey } from "@/git/query-keys";

type PullRequestReviewThreadsPayload = PullRequestReviewThreadsResponse["payload"];
export type PullRequestReviewThread = PullRequestReviewThreadsPayload["threads"][number];
export type PullRequestReviewThreadsError = NonNullable<PullRequestReviewThreadsPayload["error"]>;

export interface ReviewThreadFileGroup {
  path: string;
  threads: PullRequestReviewThread[];
}

export interface UsePrReviewThreadsQueryOptions {
  serverId: string;
  cwd: string;
  enabled?: boolean;
}

export interface PrReviewThreadsState {
  threads: PullRequestReviewThread[];
  groups: ReviewThreadFileGroup[];
  prNumber: number | null;
  capabilitySupported: boolean;
  githubFeaturesEnabled: boolean;
  isLoading: boolean;
  isRefreshing: boolean;
  payloadError: PullRequestReviewThreadsError | null;
  error: Error | null;
}

export interface UsePrReviewThreadsQueryResult extends PrReviewThreadsState {
  refetch: () => void;
}

export function selectActionableReviewThreads(
  threads: readonly PullRequestReviewThread[],
): PullRequestReviewThread[] {
  return threads.filter((thread) => !thread.isResolved && !thread.isOutdated);
}

export function groupReviewThreadsByFile(
  threads: readonly PullRequestReviewThread[],
): ReviewThreadFileGroup[] {
  const groups: ReviewThreadFileGroup[] = [];
  const indexByPath = new Map<string, number>();
  for (const thread of threads) {
    const existing = indexByPath.get(thread.path);
    if (existing === undefined) {
      indexByPath.set(thread.path, groups.length);
      groups.push({ path: thread.path, threads: [thread] });
    } else {
      groups[existing].threads.push(thread);
    }
  }
  return groups;
}

export interface ShouldFetchReviewThreadsArgs {
  hasClient: boolean;
  isConnected: boolean;
  enabled: boolean;
  capabilitySupported: boolean;
  cwd: string;
  identity: PrRepoIdentity;
}

export function shouldFetchReviewThreadsFrom({
  hasClient,
  isConnected,
  enabled,
  capabilitySupported,
  cwd,
  identity,
}: ShouldFetchReviewThreadsArgs): boolean {
  return (
    hasClient &&
    isConnected &&
    enabled &&
    capabilitySupported &&
    !!cwd &&
    identity.prNumber !== null &&
    identity.repoOwner !== null &&
    identity.repoName !== null
  );
}

export interface SelectReviewThreadsStateInput {
  capabilitySupported: boolean;
  prNumber: number | null;
  shouldFetch: boolean;
  payload: PullRequestReviewThreadsPayload | undefined;
  queryError: Error | null;
  isLoading: boolean;
  isFetching: boolean;
}

export function selectReviewThreadsState(
  input: SelectReviewThreadsStateInput,
): PrReviewThreadsState {
  const actionable = input.payload ? selectActionableReviewThreads(input.payload.threads) : [];
  return {
    threads: actionable,
    groups: groupReviewThreadsByFile(actionable),
    prNumber: input.prNumber,
    capabilitySupported: input.capabilitySupported,
    githubFeaturesEnabled: input.payload?.githubFeaturesEnabled ?? true,
    isLoading: input.shouldFetch && input.isLoading && input.payload === undefined,
    isRefreshing: input.isFetching && !input.isLoading,
    payloadError: input.payload?.error ?? null,
    error: input.queryError,
  };
}

// __APPEND_HERE__

export function usePrReviewThreadsQuery({
  serverId,
  cwd,
  enabled = true,
}: UsePrReviewThreadsQueryOptions): UsePrReviewThreadsQueryResult {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const capabilitySupported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.prReviewThreads === true,
  );

  const checkoutPrStatus = useCheckoutPrStatusQuery({ serverId, cwd, enabled });
  const identity = extractPrRepoIdentity(checkoutPrStatus.status);

  const shouldFetch = shouldFetchReviewThreadsFrom({
    hasClient: !!client,
    isConnected,
    enabled,
    capabilitySupported,
    cwd,
    identity,
  });

  const query = useQuery<PullRequestReviewThreadsPayload>({
    queryKey: useMemo(
      () => prReviewThreadsQueryKey({ serverId, cwd, prNumber: identity.prNumber }),
      [serverId, cwd, identity.prNumber],
    ),
    queryFn: async () => {
      if (
        !client ||
        identity.prNumber === null ||
        identity.repoOwner === null ||
        identity.repoName === null
      ) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      return client.pullRequestReviewThreads({
        cwd,
        prNumber: identity.prNumber,
        repoOwner: identity.repoOwner,
        repoName: identity.repoName,
      });
    },
    enabled: shouldFetch,
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
  });

  const state = selectReviewThreadsState({
    capabilitySupported,
    prNumber: identity.prNumber,
    shouldFetch,
    payload: query.data,
    queryError: query.error,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
  });

  return {
    ...state,
    refetch: () => {
      void query.refetch();
    },
  };
}
