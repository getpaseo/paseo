import { useMemo } from "react";
import type { CheckoutPipeline } from "@getpaseo/protocol/messages";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { prPanePipelineQueryKey } from "./query-keys";

/** Poll cadence for an in-progress pipeline; finished pipelines are immutable. */
const LIVE_PIPELINE_REFETCH_MS = 15_000;
const FINISHED_PIPELINE_STALE_MS = 24 * 60 * 60 * 1_000;

export interface UseGitLabPipelineOptions {
  serverId: string;
  cwd: string;
  pipelineId: number | null;
  /** MR iid, so the fetch resolves a fork/detached head pipeline correctly. */
  changeRequestNumber: number;
  enabled: boolean;
  /** True while the pipeline is still running, so jobs keep refreshing. */
  live: boolean;
}

export interface UseGitLabPipelineResult {
  pipeline: CheckoutPipeline | null;
  isLoading: boolean;
  isFetching: boolean;
  /**
   * True while the query is serving the previous change request's data as a
   * placeholder after the query key changed (keepPreviousData). Callers use it
   * to avoid rendering a stale job breakdown for the newly selected MR.
   */
  isPlaceholderData: boolean;
  error: Error | null;
}

/**
 * Fetches a GitLab pipeline through the existing forge-routed check-details RPC.
 * The pipeline id is carried in checkRunId; GitLab resolves its project from cwd.
 */
export function useGitLabPipeline({
  serverId,
  cwd,
  pipelineId,
  changeRequestNumber,
  enabled,
  live,
}: UseGitLabPipelineOptions): UseGitLabPipelineResult {
  const daemonClient = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const shouldFetch = enabled && !!daemonClient && isConnected && !!cwd && pipelineId !== null;

  const query = useFetchQuery<CheckoutPipeline | null>({
    queryKey: useMemo(
      () => prPanePipelineQueryKey({ serverId, cwd, pipelineId, changeRequestNumber }),
      [serverId, cwd, pipelineId, changeRequestNumber],
    ),
    queryFn: async () => {
      if (!daemonClient || pipelineId === null) {
        return null;
      }
      const payload = await daemonClient.checkoutForgeGetCheckDetails({
        cwd,
        checkRunId: pipelineId,
        changeRequestNumber,
      });
      // A failed fetch must surface as a query error so the section shows its
      // error state; null is reserved for a successful response with no pipeline.
      if (!payload.success) {
        throw new Error(payload.error?.message ?? "Could not load pipeline jobs");
      }
      return payload.details?.pipeline ?? null;
    },
    enabled: shouldFetch,
    dataShape: "list",
    staleTimeMs: live ? 0 : FINISHED_PIPELINE_STALE_MS,
    refetchInterval: live && shouldFetch ? LIVE_PIPELINE_REFETCH_MS : false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });

  return {
    pipeline: query.data ?? null,
    isLoading: shouldFetch && query.isLoading,
    isFetching: query.isFetching,
    isPlaceholderData: query.isPlaceholderData,
    error: query.error,
  };
}
