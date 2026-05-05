import type {
  DaemonClient,
  FetchAgentHistoryOptions,
  FetchAgentHistoryPageInfo,
} from "@server/client/daemon-client";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useHostRuntimeClient, useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
import { buildAgentDirectoryState } from "@/utils/agent-directory-sync";
import { agentHistoryQueryKey } from "./agent-history-query-key";

const AGENT_HISTORY_PAGE_LIMIT = 200;
const AGENT_HISTORY_SORT: NonNullable<FetchAgentHistoryOptions["sort"]> = [
  { key: "updated_at", direction: "desc" },
];

export interface AgentHistoryResult {
  agents: AggregatedAgent[];
  isLoading: boolean;
  isInitialLoad: boolean;
  isRevalidating: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  refreshAll: () => void;
  loadMore: () => void;
}

interface AgentHistoryPage {
  agents: AggregatedAgent[];
  pageInfo: FetchAgentHistoryPageInfo;
}

async function fetchAgentHistoryPage(input: {
  client: DaemonClient;
  serverId: string;
  cursor: string | null;
}): Promise<AgentHistoryPage> {
  const payload = await input.client.fetchAgentHistory({
    sort: AGENT_HISTORY_SORT,
    page: input.cursor
      ? { limit: AGENT_HISTORY_PAGE_LIMIT, cursor: input.cursor }
      : { limit: AGENT_HISTORY_PAGE_LIMIT },
  });

  const { agents } = buildAgentDirectoryState({
    serverId: input.serverId,
    entries: payload.entries,
  });

  return {
    agents: Array.from(agents.values(), (agent) => ({
      id: agent.id,
      serverId: input.serverId,
      serverLabel: input.serverId,
      title: agent.title ?? null,
      status: agent.status,
      lastActivityAt: agent.lastActivityAt,
      cwd: agent.cwd,
      provider: agent.provider,
      pendingPermissionCount: agent.pendingPermissions.length,
      requiresAttention: agent.requiresAttention,
      attentionReason: agent.attentionReason,
      attentionTimestamp: agent.attentionTimestamp ?? null,
      archivedAt: agent.archivedAt ?? null,
      createdAt: agent.createdAt,
      labels: agent.labels,
    })),
    pageInfo: payload.pageInfo,
  };
}

export function useAgentHistory(options: {
  serverId?: string | null;
  enabled?: boolean;
}): AgentHistoryResult {
  const daemons = useHosts();
  const serverId = useMemo(() => {
    const value = options.serverId;
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  }, [options.serverId]);
  const enabled = options.enabled ?? true;
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const queryKey = useMemo(() => agentHistoryQueryKey(serverId), [serverId]);
  const serverLabel = daemons.find((daemon) => daemon.serverId === serverId)?.label ?? serverId;

  const historyQuery = useInfiniteQuery<
    AgentHistoryPage,
    Error,
    { pages: AgentHistoryPage[] },
    ReturnType<typeof agentHistoryQueryKey>,
    string | null
  >({
    queryKey,
    enabled: Boolean(enabled && serverId && client && isConnected),
    staleTime: 30_000,
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      lastPage.pageInfo.hasMore ? lastPage.pageInfo.nextCursor : null,
    queryFn: async ({ pageParam }) => {
      if (!serverId || !client) {
        throw new Error("Host is not connected");
      }
      return fetchAgentHistoryPage({ client, serverId, cursor: pageParam });
    },
  });
  const { data, fetchNextPage, hasNextPage, isFetching, isFetchingNextPage, isLoading, refetch } =
    historyQuery;

  const refreshAll = useCallback(() => {
    if (!serverId || !client || !isConnected) {
      return;
    }
    void refetch();
  }, [client, isConnected, refetch, serverId]);

  const loadMore = useCallback(() => {
    if (!serverId || !client || !isConnected || !hasNextPage || isFetchingNextPage) {
      return;
    }
    void fetchNextPage();
  }, [client, fetchNextPage, hasNextPage, isConnected, isFetchingNextPage, serverId]);

  const agents = useMemo(
    () =>
      (data?.pages ?? [])
        .flatMap((page) => page.agents)
        .map((agent) =>
          Object.assign({}, agent, {
            serverLabel: serverLabel ?? agent.serverLabel,
          }),
        ),
    [data?.pages, serverLabel],
  );
  const isInitialLoad = isLoading && agents.length === 0;
  const isRevalidating = isFetching && !isFetchingNextPage && agents.length > 0;

  return {
    agents,
    isLoading,
    isInitialLoad,
    isRevalidating,
    hasMore: hasNextPage,
    isLoadingMore: isFetchingNextPage,
    refreshAll,
    loadMore,
  };
}

export const __private__ = {
  fetchAgentHistoryPage,
};
