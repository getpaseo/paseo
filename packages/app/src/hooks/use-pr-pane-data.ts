import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type {
  CheckoutPrStatusResponse,
  PullRequestTimelineResponse,
} from "@server/shared/messages";
import { mapPrPaneData, type PrPaneData } from "@/git/pr-pane-data";
import { useCheckoutPrStatusQuery } from "@/git/use-pr-status-query";

type CheckoutPrStatusPayloadError = CheckoutPrStatusResponse["payload"]["error"];
type PullRequestTimeline = PullRequestTimelineResponse["payload"];

const unsupportedTimelineKeys = new Set<string>();

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

interface PrRepoIdentity {
  prNumber: number | null;
  repoOwner: string | null;
  repoName: string | null;
}

function extractPrRepoIdentity(status: CheckoutPrStatusLike): PrRepoIdentity {
  const prNumber = status?.number ?? null;
  const repoOwner = status?.repoOwner && status.repoOwner.length > 0 ? status.repoOwner : null;
  const repoName = status?.repoName && status.repoName.length > 0 ? status.repoName : null;
  return { prNumber, repoOwner, repoName };
}

type CheckoutPrStatusLike = ReturnType<typeof useCheckoutPrStatusQuery>["status"];

interface ShouldFetchTimelineArgs {
  daemonClient: unknown;
  isConnected: boolean;
  timelineEnabled: boolean;
  githubFeaturesEnabled: boolean;
  cwd: string;
  identity: PrRepoIdentity;
  timelineUnsupported: boolean;
}

function shouldFetchTimelineFrom({
  daemonClient,
  isConnected,
  timelineEnabled,
  githubFeaturesEnabled,
  cwd,
  identity,
  timelineUnsupported,
}: ShouldFetchTimelineArgs): boolean {
  return (
    !!daemonClient &&
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
  const { prNumber, repoOwner, repoName } = extractPrRepoIdentity(status);
  const githubFeaturesEnabled = checkoutPrStatus.githubFeaturesEnabled;
  const unsupportedKey =
    prNumber === null ? null : timelineUnsupportedKey({ serverId, cwd, prNumber });
  const timelineUnsupported = unsupportedKey ? unsupportedTimelineKeys.has(unsupportedKey) : false;
  const shouldFetchTimeline = shouldFetchTimelineFrom({
    daemonClient,
    isConnected,
    timelineEnabled,
    githubFeaturesEnabled,
    cwd,
    identity: { prNumber, repoOwner, repoName },
    timelineUnsupported,
  });

  const timelineQuery = useQuery<PullRequestTimeline>({
    queryKey: prPaneTimelineQueryKey({ serverId, cwd, prNumber }),
    queryFn: async () => {
      if (!daemonClient || prNumber === null || repoOwner === null || repoName === null) {
        throw new Error("Daemon client not available");
      }

      try {
        return await daemonClient.pullRequestTimeline({
          cwd,
          prNumber,
          repoOwner,
          repoName,
        });
      } catch (error) {
        if (unsupportedKey && isUnsupportedTimelineError(error)) {
          unsupportedTimelineKeys.add(unsupportedKey);
        }
        throw error;
      }
    },
    enabled: shouldFetchTimeline,
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
    retry: (failureCount, error) => !isUnsupportedTimelineError(error) && failureCount < 3,
  });

  const data =
    prNumber === null || !timelineEnabled ? null : mapPrPaneData(status, timelineQuery.data);
  const statusRefreshing = checkoutPrStatus.isFetching && !checkoutPrStatus.isLoading;
  const timelineRefreshing = timelineQuery.isFetching && !timelineQuery.isLoading;

  return {
    data,
    prNumber,
    isLoading:
      checkoutPrStatus.isLoading ||
      (shouldFetchTimeline && timelineQuery.isLoading && timelineQuery.data === undefined),
    isRefreshing: statusRefreshing || timelineRefreshing,
    error: firstNonSuppressedError({
      statusPayloadError: checkoutPrStatus.payloadError,
      statusError: checkoutPrStatus.error,
      timelineError: timelineQuery.error,
      timelinePayloadError: timelineQuery.data?.error ?? null,
    }),
    githubFeaturesEnabled,
  };
}

export function prPaneTimelineQueryKey({
  serverId,
  cwd,
  prNumber,
}: {
  serverId: string;
  cwd: string;
  prNumber: number | null;
}) {
  return ["prPaneTimeline", serverId, cwd, prNumber] as const;
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

function timelineUnsupportedKey({
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

function isUnsupportedTimelineError(error: unknown): boolean {
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
