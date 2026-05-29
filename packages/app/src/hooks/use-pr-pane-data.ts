import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type {
  CheckoutPrStatusResponse,
  PullRequestTimelineResponse,
} from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { mapPrPaneData, type PrPaneData } from "@/git/pr-pane-data";
import { useCheckoutPrStatusQuery } from "@/git/use-pr-status-query";
import { prPaneTimelineQueryKey } from "@/git/query-keys";

type CheckoutPrStatus = CheckoutPrStatusResponse["payload"]["status"];
type CheckoutPrStatusPayloadError = CheckoutPrStatusResponse["payload"]["error"];
type PullRequestTimeline = PullRequestTimelineResponse["payload"];

export interface UsePrPaneDataOptions {
  serverId: string;
  cwd: string;
  enabled?: boolean;
  timelineEnabled?: boolean;
}

export interface UsePrPaneDataResult {
  data: PrPaneData | null;
  prNumber: number | null;
  isLoading: boolean;
  isRefreshing: boolean;
  error: Error | null;
  githubFeaturesEnabled: boolean;
}

export interface PrRepoIdentity {
  prNumber: number | null;
  repoOwner: string | null;
  repoName: string | null;
}

export function extractPrRepoIdentity(status: CheckoutPrStatus | null): PrRepoIdentity {
  const prNumber = status?.number ?? null;
  const repoOwner = status?.repoOwner && status.repoOwner.length > 0 ? status.repoOwner : null;
  const repoName = status?.repoName && status.repoName.length > 0 ? status.repoName : null;
  return { prNumber, repoOwner, repoName };
}

export interface ShouldFetchTimelineArgs {
  hasClient: boolean;
  isConnected: boolean;
  timelineEnabled: boolean;
  githubFeaturesEnabled: boolean;
  cwd: string;
  identity: PrRepoIdentity;
  timelineUnsupported: boolean;
}

export function shouldFetchTimelineFrom({
  hasClient,
  isConnected,
  timelineEnabled,
  githubFeaturesEnabled,
  cwd,
  identity,
  timelineUnsupported,
}: ShouldFetchTimelineArgs): boolean {
  return (
    hasClient &&
    isConnected &&
    timelineEnabled &&
    githubFeaturesEnabled &&
    !!cwd &&
    identity.prNumber !== null &&
    identity.repoOwner !== null &&
    identity.repoName !== null &&
    !timelineUnsupported
  );
}

export type PrPaneTimelineClient = Pick<DaemonClient, "pullRequestTimeline">;

export interface UnsupportedTimelineRegistry {
  has(key: string): boolean;
  add(key: string): void;
}

export function unsupportedTimelineKey({
  serverId,
  cwd,
  prNumber,
}: {
  serverId: string;
  cwd: string;
  prNumber: number;
}): string {
  return `${serverId}\0${cwd}\0${prNumber}`;
}

export function createInMemoryUnsupportedTimelineRegistry(): UnsupportedTimelineRegistry {
  const keys = new Set<string>();
  return {
    has: (key) => keys.has(key),
    add: (key) => {
      keys.add(key);
    },
  };
}

const defaultUnsupportedTimelineRegistry = createInMemoryUnsupportedTimelineRegistry();

export interface FetchPrPaneTimelinePageInput {
  client: PrPaneTimelineClient;
  registry: UnsupportedTimelineRegistry;
  serverId: string;
  cwd: string;
  prNumber: number;
  repoOwner: string;
  repoName: string;
}

export async function fetchPrPaneTimelinePage(
  input: FetchPrPaneTimelinePageInput,
): Promise<PullRequestTimeline> {
  try {
    return await input.client.pullRequestTimeline({
      cwd: input.cwd,
      prNumber: input.prNumber,
      repoOwner: input.repoOwner,
      repoName: input.repoName,
    });
  } catch (error) {
    if (isUnsupportedTimelineError(error)) {
      input.registry.add(
        unsupportedTimelineKey({
          serverId: input.serverId,
          cwd: input.cwd,
          prNumber: input.prNumber,
        }),
      );
    }
    throw error;
  }
}

export interface SelectPrPaneStateInput {
  status: CheckoutPrStatus | null;
  statusPayloadError: CheckoutPrStatusPayloadError;
  statusError: Error | null;
  statusIsLoading: boolean;
  statusIsFetching: boolean;
  githubFeaturesEnabled: boolean;
  timelineEnabled: boolean;
  shouldFetchTimeline: boolean;
  timelinePayload: PullRequestTimeline | undefined;
  timelineError: Error | null;
  timelineIsLoading: boolean;
  timelineIsFetching: boolean;
}

export function selectPrPaneState(input: SelectPrPaneStateInput): UsePrPaneDataResult {
  const identity = extractPrRepoIdentity(input.status);
  const data =
    identity.prNumber === null || !input.timelineEnabled
      ? null
      : mapPrPaneData(input.status, input.timelinePayload);
  const statusRefreshing = input.statusIsFetching && !input.statusIsLoading;
  const timelineRefreshing = input.timelineIsFetching && !input.timelineIsLoading;

  return {
    data,
    prNumber: identity.prNumber,
    isLoading:
      input.statusIsLoading ||
      (input.shouldFetchTimeline && input.timelineIsLoading && input.timelinePayload === undefined),
    isRefreshing: statusRefreshing || timelineRefreshing,
    error: firstNonSuppressedError({
      statusPayloadError: input.statusPayloadError,
      statusError: input.statusError,
      timelineError: input.timelineError,
      timelinePayloadError: input.timelinePayload?.error ?? null,
    }),
    githubFeaturesEnabled: input.githubFeaturesEnabled,
  };
}

export function usePrPaneData({
  serverId,
  cwd,
  enabled = true,
  timelineEnabled = enabled,
}: UsePrPaneDataOptions): UsePrPaneDataResult {
  const daemonClient = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const checkoutPrStatus = useCheckoutPrStatusQuery({ serverId, cwd, enabled });
  const status = checkoutPrStatus.status;
  const identity = extractPrRepoIdentity(status);
  const githubFeaturesEnabled = checkoutPrStatus.githubFeaturesEnabled;
  const registry = defaultUnsupportedTimelineRegistry;
  const unsupportedKey =
    identity.prNumber === null
      ? null
      : unsupportedTimelineKey({ serverId, cwd, prNumber: identity.prNumber });
  const timelineUnsupported = unsupportedKey ? registry.has(unsupportedKey) : false;
  const shouldFetchTimeline = shouldFetchTimelineFrom({
    hasClient: !!daemonClient,
    isConnected,
    timelineEnabled,
    githubFeaturesEnabled,
    cwd,
    identity,
    timelineUnsupported,
  });

  const timelineQuery = useQuery<PullRequestTimeline>({
    queryKey: useMemo(
      () => prPaneTimelineQueryKey({ serverId, cwd, prNumber: identity.prNumber }),
      [serverId, cwd, identity.prNumber],
    ),
    queryFn: async () => {
      if (
        !daemonClient ||
        identity.prNumber === null ||
        identity.repoOwner === null ||
        identity.repoName === null
      ) {
        throw new Error("Daemon client not available");
      }
      return fetchPrPaneTimelinePage({
        client: daemonClient,
        registry,
        serverId,
        cwd,
        prNumber: identity.prNumber,
        repoOwner: identity.repoOwner,
        repoName: identity.repoName,
      });
    },
    enabled: shouldFetchTimeline,
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
    retry: (failureCount, error) => !isUnsupportedTimelineError(error) && failureCount < 3,
  });

  return selectPrPaneState({
    status,
    statusPayloadError: checkoutPrStatus.payloadError,
    statusError: checkoutPrStatus.error,
    statusIsLoading: checkoutPrStatus.isLoading,
    statusIsFetching: checkoutPrStatus.isFetching,
    githubFeaturesEnabled,
    timelineEnabled,
    shouldFetchTimeline,
    timelinePayload: timelineQuery.data,
    timelineError: timelineQuery.error,
    timelineIsLoading: timelineQuery.isLoading,
    timelineIsFetching: timelineQuery.isFetching,
  });
}

function firstNonSuppressedError({
  statusPayloadError,
  statusError,
  timelineError,
  timelinePayloadError,
}: {
  statusPayloadError: CheckoutPrStatusPayloadError;
  statusError: Error | null;
  timelineError: Error | null;
  timelinePayloadError: PullRequestTimeline["error"];
}): Error | null {
  if (statusPayloadError) {
    return new Error(statusPayloadError.message || "Unable to load pull request status");
  }

  if (statusError) {
    return statusError;
  }

  if (timelineError && !isUnsupportedTimelineError(timelineError)) {
    return timelineError;
  }

  if (timelinePayloadError) {
    return new Error(timelinePayloadError.message || "Unable to load pull request activity");
  }

  return null;
}

export function isUnsupportedTimelineError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const name = error.name.toLowerCase();
  const rpcError = error as Error & { code?: unknown; requestType?: unknown };

  if (
    name === "daemonrpcerror" &&
    rpcError.code === "unknown_schema" &&
    rpcError.requestType === "pull_request_timeline_request"
  ) {
    return true;
  }

  return false;
}
