import { useInfiniteQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { getHostRuntimeStore, isHostRuntimeConnected, useHosts } from "@/runtime/host-runtime";
import { useHostFeatureMap } from "@/runtime/host-features";
import type { HistorySortMode } from "@/stores/history-view-store";
import {
  dedupeAndSortHistoryAgents,
  filterHistoryAgents,
  type HistoryServerQuery,
} from "./history-view-model";
import { agentHistoryQueryKey, allAgentHistoryQueryKey } from "./agent-history-query-key";
import {
  fetchAgentHistoryBatch,
  getNextAgentHistoryPageParam,
  type AgentHistoryBatchPage,
  type AgentHistoryCursorByServerId,
  type AgentHistoryHost,
} from "./agent-history-fetch";
export {
  fetchAgentHistoryBatch,
  fetchAgentHistoryPage,
  type AgentHistoryClient,
  type AgentHistoryHost,
  type AgentHistoryPage,
} from "./agent-history-fetch";

const DEFAULT_AGENT_HISTORY_QUERY: HistoryServerQuery = {
  filter: { archiveState: "all", includeArchived: true },
  sort: [
    { key: "pinned", direction: "desc" },
    { key: "updated_at", direction: "desc" },
  ],
};

export interface AgentHistoryResult {
  agents: AggregatedAgent[];
  isLoading: boolean;
  isInitialLoad: boolean;
  isRevalidating: boolean;
  isError: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  refreshAll: () => Promise<void>;
  loadMore: () => void;
}

export function useAgentHistory(options: {
  serverIds?: readonly string[];
  query?: HistoryServerQuery;
  sortMode?: HistorySortMode;
  enabled?: boolean;
}): AgentHistoryResult {
  const { t } = useTranslation();
  const daemons = useHosts();
  const runtime = getHostRuntimeStore();
  const runtimeVersion = useSyncExternalStore(
    (onStoreChange) => runtime.subscribeAll(onStoreChange),
    () => runtime.getVersion(),
    () => runtime.getVersion(),
  );
  const requestedServerIds = useMemo(() => {
    const normalized = [
      ...new Set((options.serverIds ?? []).map((value) => value.trim()).filter(Boolean)),
    ];
    return normalized.length > 0 ? normalized.sort() : null;
  }, [options.serverIds]);
  const query = options.query ?? DEFAULT_AGENT_HISTORY_QUERY;
  const sortMode = options.sortMode ?? "recency";
  const enabled = options.enabled ?? true;
  const candidateServerIds = useMemo(
    () => requestedServerIds ?? daemons.map((daemon) => daemon.serverId),
    [daemons, requestedServerIds],
  );
  const pinningFeatureByServerId = useHostFeatureMap(candidateServerIds, "agentPinning");
  const targetHosts = useMemo(() => {
    void runtimeVersion;
    const serverLabelById = new Map(daemons.map((daemon) => [daemon.serverId, daemon.label]));
    const hosts: AgentHistoryHost[] = [];

    for (const targetServerId of candidateServerIds) {
      const snapshot = runtime.getSnapshot(targetServerId);
      const client = runtime.getClient(targetServerId);
      if (!client || !isHostRuntimeConnected(snapshot)) {
        continue;
      }
      hosts.push({
        serverId: targetServerId,
        serverLabel: serverLabelById.get(targetServerId) ?? targetServerId,
        client,
        supportsPinning: pinningFeatureByServerId.get(targetServerId) === true,
      });
    }

    return hosts;
  }, [candidateServerIds, daemons, pinningFeatureByServerId, runtime, runtimeVersion]);
  const targetServerIds = useMemo(() => targetHosts.map((host) => host.serverId), [targetHosts]);
  const pinningServerIds = useMemo(
    () => targetHosts.filter((host) => host.supportsPinning).map((host) => host.serverId),
    [targetHosts],
  );
  const queryKey = useMemo(
    () =>
      targetServerIds.length === 1
        ? agentHistoryQueryKey(targetServerIds[0] ?? null, query, pinningServerIds.length === 1)
        : allAgentHistoryQueryKey(targetServerIds, query, pinningServerIds),
    [pinningServerIds, query, targetServerIds],
  );
  const serverLabelById = useMemo(
    () => new Map(daemons.map((daemon) => [daemon.serverId, daemon.label])),
    [daemons],
  );

  const historyQuery = useInfiniteQuery<
    AgentHistoryBatchPage,
    Error,
    { pages: AgentHistoryBatchPage[] },
    readonly unknown[],
    AgentHistoryCursorByServerId | null
  >({
    queryKey,
    enabled: Boolean(enabled && targetHosts.length > 0),
    staleTime: 30_000,
    initialPageParam: null,
    getNextPageParam: getNextAgentHistoryPageParam,
    queryFn: async ({ pageParam }) => {
      if (targetHosts.length === 0) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      return fetchAgentHistoryBatch({
        hosts: targetHosts,
        cursorByServerId: pageParam,
        query,
        sortMode,
      });
    },
  });
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isError,
    isFetching,
    isFetchingNextPage,
    isLoading,
    refetch,
  } = historyQuery;

  const refreshAll = useCallback(async () => {
    if (!enabled || targetHosts.length === 0) {
      return;
    }
    await refetch();
  }, [enabled, refetch, targetHosts.length]);

  const loadMore = useCallback(() => {
    if (!enabled || targetHosts.length === 0 || !hasNextPage || isFetchingNextPage) {
      return;
    }
    void fetchNextPage();
  }, [enabled, fetchNextPage, hasNextPage, isFetchingNextPage, targetHosts.length]);

  const agents = useMemo(() => {
    const historyAgents = (data?.pages ?? []).flatMap((page) => page.agents);
    const labelledAgents = historyAgents.map((agent) =>
      Object.assign({}, agent, {
        serverLabel: serverLabelById.get(agent.serverId) ?? agent.serverLabel,
      }),
    );
    const filteredAgents = filterHistoryAgents(labelledAgents, query.filter);
    return dedupeAndSortHistoryAgents(filteredAgents, sortMode);
  }, [data?.pages, query.filter, serverLabelById, sortMode]);
  const isInitialLoad = isLoading && agents.length === 0;
  const isRevalidating = isFetching && !isFetchingNextPage && agents.length > 0;

  return {
    agents,
    isLoading,
    isInitialLoad,
    isRevalidating,
    isError,
    hasMore: hasNextPage,
    isLoadingMore: isFetchingNextPage,
    refreshAll,
    loadMore,
  };
}
