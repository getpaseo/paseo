import type {
  DaemonClient,
  FetchAgentHistoryOptions,
  FetchAgentHistoryPageInfo,
} from "@getpaseo/client/internal/daemon-client";
import type { AgentSearchMatch } from "@getpaseo/protocol/messages";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { getHostRuntimeStore, isHostRuntimeConnected, useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { buildAgentDirectoryState } from "@/utils/agent-directory-sync";
import { agentHistoryQueryKey, allAgentHistoryQueryKey } from "./agent-history-query-key";

const AGENT_HISTORY_PAGE_LIMIT = 200;
const AGENT_HISTORY_SORT: NonNullable<FetchAgentHistoryOptions["sort"]> = [
  { key: "updated_at", direction: "desc" },
];
const AGENT_HISTORY_ALL_HOSTS_FAILED_MESSAGE = "No connected hosts could load agent history";

export interface AgentHistoryResult {
  agents: AggregatedAgent[];
  isLoading: boolean;
  isInitialLoad: boolean;
  isRevalidating: boolean;
  isError: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  /** False when any target host predates search; the screen hides the field. */
  isSearchSupported: boolean;
  /** More sessions matched than the ranked page holds. Narrow the query. */
  isSearchTruncated: boolean;
  /** Where the query matched each row, keyed by `serverId:agentId`. */
  searchMatchesByAgentKey: Record<string, AgentSearchMatch[]>;
  /** Hosts that failed while others succeeded. The list still renders. */
  hostErrors: AgentHistoryHostError[];
  refreshAll: () => Promise<void>;
  loadMore: () => void;
}

export interface AgentHistoryPage {
  agents: AggregatedAgent[];
  /**
   * Relevance of each agent to the request's search, keyed by `serverId:agentId`
   * because that pair — not the bare agent id — is what identifies a row across
   * hosts. Empty without a query. Each host ranks only its own sessions, so
   * merging several of them into one list needs the scores rather than each
   * host's row order.
   */
  searchScoreByAgentKey: Record<string, number>;
  /** Where the query matched in each row, keyed like `searchScoreByAgentKey`. */
  searchMatchesByAgentKey: Record<string, AgentSearchMatch[]>;
  pageInfo: FetchAgentHistoryPageInfo;
  /** More matched this host's query than its page could hold. */
  isSearchTruncated: boolean;
}

/** Identity of a history row. A bare agent id belongs to exactly one host. */
export function agentHistoryRowKey(agent: { serverId: string; id: string }): string {
  return `${agent.serverId}:${agent.id}`;
}

export type AgentHistoryClient = Pick<DaemonClient, "fetchAgentHistory">;

/**
 * A host that could not be reached while at least one other could. Its sessions
 * are missing from the list, which under a query means "no matches" would be a
 * claim the app cannot make.
 */
export interface AgentHistoryHostError {
  serverId: string;
  serverName: string;
}

export interface AgentHistoryHost {
  serverId: string;
  serverLabel: string;
  client: AgentHistoryClient;
}

interface AgentHistoryBatchPage {
  agents: AggregatedAgent[];
  searchScoreByAgentKey: Record<string, number>;
  searchMatchesByAgentKey: Record<string, AgentSearchMatch[]>;
  pageInfoByServerId: Record<string, FetchAgentHistoryPageInfo>;
  hostErrors: AgentHistoryHostError[];
  /** Set only under a query: more sessions matched than this page can hold. */
  isSearchTruncated?: boolean;
}

/** Sorts unmatched rows last so a page missing scores keeps its own order. */
const UNRANKED = Number.POSITIVE_INFINITY;

type AgentHistoryCursorByServerId = Record<string, string | null>;

export async function fetchAgentHistoryPage(input: {
  client: AgentHistoryClient;
  serverId: string;
  cursor: string | null;
  search?: string;
}): Promise<AgentHistoryPage> {
  const payload = await input.client.fetchAgentHistory({
    ...(input.search ? { search: input.search } : {}),
    sort: AGENT_HISTORY_SORT,
    page: input.cursor
      ? { limit: AGENT_HISTORY_PAGE_LIMIT, cursor: input.cursor }
      : { limit: AGENT_HISTORY_PAGE_LIMIT },
  });

  const { agents } = buildAgentDirectoryState({
    serverId: input.serverId,
    entries: payload.entries,
  });
  const searchScoreByAgentKey: Record<string, number> = {};
  const searchMatchesByAgentKey: Record<string, AgentSearchMatch[]> = {};
  for (const entry of payload.entries) {
    const key = agentHistoryRowKey({ serverId: input.serverId, id: entry.agent.id });
    if (entry.searchScore !== undefined) {
      searchScoreByAgentKey[key] = entry.searchScore;
    }
    if (entry.searchMatches && entry.searchMatches.length > 0) {
      searchMatchesByAgentKey[key] = entry.searchMatches;
    }
  }

  return {
    searchScoreByAgentKey,
    searchMatchesByAgentKey,
    isSearchTruncated: payload.searchTruncated === true,
    agents: Array.from(agents.values(), (agent) => ({
      id: agent.id,
      serverId: input.serverId,
      serverLabel: input.serverId,
      title: agent.title ?? null,
      status: agent.status,
      lastActivityAt: agent.lastActivityAt,
      cwd: agent.cwd,
      workspaceId: agent.workspaceId,
      provider: agent.provider,
      pendingPermissionCount: agent.pendingPermissions.length,
      requiresAttention: agent.requiresAttention,
      attentionReason: agent.attentionReason,
      attentionTimestamp: agent.attentionTimestamp ?? null,
      archivedAt: agent.archivedAt ?? null,
      createdAt: agent.createdAt,
      labels: agent.labels,
      projectPlacement: agent.projectPlacement,
    })),
    pageInfo: payload.pageInfo,
  };
}

function sortByLatestActivity(agents: AggregatedAgent[]): AggregatedAgent[] {
  return [...agents].sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
}

/**
 * Relevance first, recency to break ties. A search result list ordered by time
 * would bury the row the user described in favour of the row they last touched.
 *
 * Truncating the merge back to one page's worth is what makes the merged list
 * globally correct: the best N matches overall are always contained in the
 * union of each host's own best N, so keeping more than N here would be showing
 * rows that a further host could still outrank.
 */
function mergeByRelevance(
  agents: AggregatedAgent[],
  searchScoreByAgentKey: Record<string, number>,
  limit: number,
): AggregatedAgent[] {
  return [...agents]
    .sort((a, b) => {
      const scoreA = searchScoreByAgentKey[agentHistoryRowKey(a)] ?? UNRANKED;
      const scoreB = searchScoreByAgentKey[agentHistoryRowKey(b)] ?? UNRANKED;
      if (scoreA !== scoreB) return scoreA - scoreB;
      return b.lastActivityAt.getTime() - a.lastActivityAt.getTime();
    })
    .slice(0, limit);
}

/**
 * Which hosts are missing from the list the user is looking at.
 *
 * Failures are collected across every loaded page, not just the newest: a host
 * that rejects page one contributes no cursor and is never asked again, so a
 * later page carries no error of its own while that host's history is still
 * absent. A refetch replaces every page, which is what clears an error that has
 * healed.
 */
export function collectAgentHistoryHostErrors(input: {
  pages: readonly Pick<AgentHistoryBatchPage, "hostErrors">[];
  unreachableHosts: readonly AgentHistoryHostError[];
}): AgentHistoryHostError[] {
  const byServerId = new Map<string, AgentHistoryHostError>();
  for (const error of input.unreachableHosts) {
    byServerId.set(error.serverId, error);
  }
  for (const page of input.pages) {
    for (const error of page.hostErrors) {
      byServerId.set(error.serverId, error);
    }
  }
  return [...byServerId.values()];
}

function getNextAgentHistoryPageParam(
  page: AgentHistoryBatchPage,
): AgentHistoryCursorByServerId | null {
  const cursorByServerId: AgentHistoryCursorByServerId = {};
  for (const [serverId, pageInfo] of Object.entries(page.pageInfoByServerId)) {
    if (pageInfo.hasMore && pageInfo.nextCursor) {
      cursorByServerId[serverId] = pageInfo.nextCursor;
    }
  }

  return Object.keys(cursorByServerId).length > 0 ? cursorByServerId : null;
}

export async function fetchAgentHistoryBatch(input: {
  hosts: readonly AgentHistoryHost[];
  cursorByServerId: AgentHistoryCursorByServerId | null;
  search?: string;
}): Promise<AgentHistoryBatchPage> {
  const cursorByServerId = input.cursorByServerId ?? {};
  const hasCursorFilter = Object.keys(cursorByServerId).length > 0;
  const hostsToFetch = hasCursorFilter
    ? input.hosts.filter((host) => Object.hasOwn(cursorByServerId, host.serverId))
    : input.hosts;

  const settledPages = await Promise.allSettled(
    hostsToFetch.map(async (host) => {
      const page = await fetchAgentHistoryPage({
        client: host.client,
        serverId: host.serverId,
        cursor: cursorByServerId[host.serverId] ?? null,
        ...(input.search ? { search: input.search } : {}),
      });
      return { host, page };
    }),
  );
  const pages = settledPages.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  if (pages.length === 0) {
    throw new Error(AGENT_HISTORY_ALL_HOSTS_FAILED_MESSAGE);
  }
  // allSettled preserves order, so a rejection still names the host it came
  // from. Losing that name is what would let the list quietly under-report.
  const hostErrors = settledPages.flatMap((result, index) =>
    result.status === "rejected"
      ? [
          {
            serverId: hostsToFetch[index].serverId,
            serverName: hostsToFetch[index].serverLabel,
          },
        ]
      : [],
  );

  const agents = pages.flatMap(({ host, page }) =>
    page.agents.map((agent) => Object.assign({}, agent, { serverLabel: host.serverLabel })),
  );
  const pageInfoByServerId = Object.fromEntries(
    pages.map(({ host, page }) => [host.serverId, page.pageInfo]),
  );
  const searchScoreByAgentKey = Object.assign(
    {},
    ...pages.map(({ page }) => page.searchScoreByAgentKey),
  ) as Record<string, number>;
  const searchMatchesByAgentKey = Object.assign(
    {},
    ...pages.map(({ page }) => page.searchMatchesByAgentKey),
  ) as Record<string, AgentSearchMatch[]>;
  // Truncation has two independent sources: one host overflowed its own page,
  // or several hosts each fit but their union does not. Two hosts returning 150
  // matches apiece are both complete and still add up to more than the merge
  // can show.
  const truncated =
    pages.some(({ page }) => page.isSearchTruncated) || agents.length > AGENT_HISTORY_PAGE_LIMIT;

  return {
    agents: input.search
      ? mergeByRelevance(agents, searchScoreByAgentKey, AGENT_HISTORY_PAGE_LIMIT)
      : sortByLatestActivity(agents),
    searchScoreByAgentKey,
    searchMatchesByAgentKey,
    pageInfoByServerId,
    hostErrors,
    ...(input.search ? { isSearchTruncated: truncated } : {}),
  };
}

export function useAgentHistory(options: {
  serverId?: string | null;
  enabled?: boolean;
  search?: string;
}): AgentHistoryResult {
  const { t } = useTranslation();
  const daemons = useHosts();
  const runtime = getHostRuntimeStore();
  const runtimeVersion = useSyncExternalStore(
    (onStoreChange) => runtime.subscribeAll(onStoreChange),
    () => runtime.getVersion(),
    () => runtime.getVersion(),
  );
  const serverId = useMemo(() => {
    const value = options.serverId;
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  }, [options.serverId]);
  const enabled = options.enabled ?? true;
  // A host the user asked about splits two ways: one this fetch can reach, and
  // one whose sessions will be missing from the answer. Both come out of here,
  // because dropping the unreachable ones silently is what lets the list — and
  // worse, "No sessions match" — overstate what was actually searched.
  const { targetHosts, unreachableHosts } = useMemo(() => {
    void runtimeVersion;
    const serverLabelById = new Map(daemons.map((daemon) => [daemon.serverId, daemon.label]));
    const serverIds = serverId ? [serverId] : daemons.map((daemon) => daemon.serverId);
    const hosts: AgentHistoryHost[] = [];
    const unreachable: AgentHistoryHostError[] = [];

    for (const targetServerId of serverIds) {
      const snapshot = runtime.getSnapshot(targetServerId);
      const client = runtime.getClient(targetServerId);
      const serverName = serverLabelById.get(targetServerId) ?? targetServerId;
      if (!client || !isHostRuntimeConnected(snapshot)) {
        unreachable.push({ serverId: targetServerId, serverName });
        continue;
      }
      hosts.push({ serverId: targetServerId, serverLabel: serverName, client });
    }

    return { targetHosts: hosts, unreachableHosts: unreachable };
  }, [daemons, runtime, runtimeVersion, serverId]);
  const targetServerIds = useMemo(() => targetHosts.map((host) => host.serverId), [targetHosts]);
  // One gate, checked before the field is offered: a fleet where any host
  // predates search has no search, rather than a list that silently omits that
  // host's sessions.
  const isSearchSupported = useSessionStore(
    useCallback(
      (state) =>
        targetServerIds.length > 0 &&
        targetServerIds.every(
          (id) => state.sessions[id]?.serverInfo?.features?.agentHistorySearch === true,
        ),
      [targetServerIds],
    ),
  );
  const search = useMemo(() => {
    const trimmed = options.search?.trim() ?? "";
    return isSearchSupported ? trimmed : "";
  }, [isSearchSupported, options.search]);
  const queryKey = useMemo(
    () => [
      ...(serverId ? agentHistoryQueryKey(serverId) : allAgentHistoryQueryKey(targetServerIds)),
      search,
    ],
    [search, serverId, targetServerIds],
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
        ...(search ? { search } : {}),
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
    const pages = data?.pages ?? [];
    const historyAgents = pages.flatMap((page) => page.agents);
    const labelledAgents = historyAgents.map((agent) =>
      Object.assign({}, agent, {
        serverLabel: serverLabelById.get(agent.serverId) ?? agent.serverLabel,
      }),
    );
    if (!search) {
      return sortByLatestActivity(labelledAgents);
    }
    // A searched query never has a second page, so this is re-merging one page
    // after relabelling rather than stitching a stream back together.
    const searchScoreByAgentKey = Object.assign(
      {},
      ...pages.map((page) => page.searchScoreByAgentKey),
    ) as Record<string, number>;
    return mergeByRelevance(labelledAgents, searchScoreByAgentKey, AGENT_HISTORY_PAGE_LIMIT);
  }, [data?.pages, search, serverLabelById]);
  const isInitialLoad = isLoading && agents.length === 0;
  const isRevalidating = isFetching && !isFetchingNextPage && agents.length > 0;
  const isSearchTruncated = Boolean(search && data?.pages.some((page) => page.isSearchTruncated));
  const searchMatchesByAgentKey = useMemo(
    () =>
      Object.assign(
        {},
        ...(data?.pages ?? []).map((page) => page.searchMatchesByAgentKey),
      ) as Record<string, AgentSearchMatch[]>,
    [data?.pages],
  );
  const hostErrors = useMemo(
    () => collectAgentHistoryHostErrors({ pages: data?.pages ?? [], unreachableHosts }),
    [data?.pages, unreachableHosts],
  );

  return {
    agents,
    isLoading,
    isInitialLoad,
    isRevalidating,
    isError,
    // Under a query the daemon returns the best matches and no cursor, so the
    // list is complete as far as it goes and "Load more" would be a lie.
    hasMore: search ? false : hasNextPage,
    isLoadingMore: isFetchingNextPage,
    isSearchSupported,
    isSearchTruncated,
    searchMatchesByAgentKey,
    hostErrors,
    refreshAll,
    loadMore,
  };
}
