import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useSessionStore } from "@/stores/session-store";
import { agentHistoryQueryKey } from "./agent-history-query-key";
import {
  ARCHIVE_AGENT_PENDING_QUERY_KEY,
  clearArchiveAgentPending,
  markAgentArchivedInHistoryCache,
  removeAgentFromCachedLists,
  selectPendingArchiveAgentIds,
  setAgentArchiving,
  toArchiveKey,
  type AgentHistoryQueryData,
  type AgentsListQueryData,
  type ArchiveAgentInput,
  type ArchiveAgentPendingState,
} from "./use-archive-agent.pure";

export {
  ARCHIVE_AGENT_PENDING_QUERY_KEY,
  clearArchiveAgentPending,
} from "./use-archive-agent.pure";
export type { ArchiveAgentInput } from "./use-archive-agent.pure";

export interface ArchivedAgentCloseResult {
  agentId: string;
  archivedAt: string;
}

interface ArchivedAgentListCacheSnapshot {
  sidebarAgentsList: AgentsListQueryData | undefined;
  allAgents: AgentsListQueryData | undefined;
  agentHistory: AgentHistoryQueryData | undefined;
}

interface ArchiveAgentMutationContext {
  agent: ReturnType<typeof getStoredAgentSnapshot>;
  lists: ArchivedAgentListCacheSnapshot;
}

function getStoredAgentSnapshot(input: ArchiveAgentInput) {
  return useSessionStore.getState().sessions[input.serverId]?.agents.get(input.agentId);
}

function restoreAgentSnapshot(
  input: ArchiveAgentInput & { agent: ReturnType<typeof getStoredAgentSnapshot> },
): void {
  const setAgents = useSessionStore.getState().setAgents;
  setAgents(input.serverId, (prev) => {
    const hasAgent = prev.has(input.agentId);
    if (!input.agent) {
      if (!hasAgent) {
        return prev;
      }
      const next = new Map(prev);
      next.delete(input.agentId);
      return next;
    }

    const current = prev.get(input.agentId);
    if (current === input.agent) {
      return prev;
    }

    const next = new Map(prev);
    next.set(input.agentId, input.agent);
    return next;
  });
}

function getArchivedAgentListCacheSnapshot(
  queryClient: QueryClient,
  serverId: string,
): ArchivedAgentListCacheSnapshot {
  return {
    sidebarAgentsList: queryClient.getQueryData<AgentsListQueryData | undefined>([
      "sidebarAgentsList",
      serverId,
    ]),
    allAgents: queryClient.getQueryData<AgentsListQueryData | undefined>(["allAgents", serverId]),
    agentHistory: queryClient.getQueryData<AgentHistoryQueryData | undefined>(
      agentHistoryQueryKey(serverId),
    ),
  };
}

function restoreCachedQuerySnapshot(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  snapshot: unknown,
): void {
  if (snapshot === undefined) {
    queryClient.removeQueries({ queryKey, exact: true });
    return;
  }
  queryClient.setQueryData(queryKey, snapshot);
}

function restoreArchivedAgentListCacheSnapshot(
  queryClient: QueryClient,
  serverId: string,
  snapshot: ArchivedAgentListCacheSnapshot,
): void {
  restoreCachedQuerySnapshot(
    queryClient,
    ["sidebarAgentsList", serverId],
    snapshot.sidebarAgentsList,
  );
  restoreCachedQuerySnapshot(queryClient, ["allAgents", serverId], snapshot.allAgents);
  restoreCachedQuerySnapshot(queryClient, agentHistoryQueryKey(serverId), snapshot.agentHistory);
}

function markAgentArchivedInStore(input: ArchiveAgentInput & { archivedAt: string }): void {
  const archivedAt = new Date(input.archivedAt);
  if (Number.isNaN(archivedAt.getTime())) {
    return;
  }

  const setAgents = useSessionStore.getState().setAgents;
  setAgents(input.serverId, (prev) => {
    const existing = prev.get(input.agentId);
    if (!existing) {
      return prev;
    }
    if (existing.archivedAt && existing.archivedAt.getTime() === archivedAt.getTime()) {
      return prev;
    }
    const next = new Map(prev);
    next.set(input.agentId, {
      ...existing,
      archivedAt,
    });
    return next;
  });
}

interface ApplyArchivedAgentCloseResultsInput {
  queryClient: QueryClient;
  serverId: string;
  results: ArchivedAgentCloseResult[];
  invalidateQueries?: boolean;
}

export function applyArchivedAgentCloseResults(input: ApplyArchivedAgentCloseResultsInput): void {
  if (input.results.length === 0) {
    return;
  }

  for (const result of input.results) {
    markAgentArchivedInStore({
      serverId: input.serverId,
      agentId: result.agentId,
      archivedAt: result.archivedAt,
    });
    removeAgentFromCachedLists(input.queryClient, {
      serverId: input.serverId,
      agentId: result.agentId,
    });
    markAgentArchivedInHistoryCache(input.queryClient, {
      serverId: input.serverId,
      agentId: result.agentId,
      archivedAt: result.archivedAt,
    });
  }

  if (input.invalidateQueries ?? true) {
    void input.queryClient.invalidateQueries({
      queryKey: ["sidebarAgentsList", input.serverId],
    });
    void input.queryClient.invalidateQueries({
      queryKey: ["allAgents", input.serverId],
    });
    void input.queryClient.invalidateQueries({
      queryKey: agentHistoryQueryKey(input.serverId),
    });
  }
}

function useArchiveAgentPendingQuery() {
  return useQuery({
    queryKey: ARCHIVE_AGENT_PENDING_QUERY_KEY,
    queryFn: async (): Promise<ArchiveAgentPendingState> => ({}),
    initialData: {} as ArchiveAgentPendingState,
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

export function usePendingArchiveAgentIds(serverId: string): ReadonlySet<string> {
  const pendingQuery = useArchiveAgentPendingQuery();
  return useMemo(
    () => selectPendingArchiveAgentIds(pendingQuery.data ?? {}, serverId),
    [pendingQuery.data, serverId],
  );
}

export function useArchiveAgent() {
  const queryClient = useQueryClient();

  const pendingQuery = useArchiveAgentPendingQuery();

  const archiveMutation = useMutation({
    mutationFn: async (input: ArchiveAgentInput): Promise<{ archivedAt: string }> => {
      const client = useSessionStore.getState().sessions[input.serverId]?.client ?? null;
      if (!client) {
        throw new Error("Daemon client not available");
      }
      return await client.archiveAgent(input.agentId);
    },
    onMutate: (input) => {
      const context: ArchiveAgentMutationContext = {
        agent: getStoredAgentSnapshot(input),
        lists: getArchivedAgentListCacheSnapshot(queryClient, input.serverId),
      };
      const archivedAt = new Date().toISOString();

      applyArchivedAgentCloseResults({
        queryClient,
        serverId: input.serverId,
        results: [{ agentId: input.agentId, archivedAt }],
        invalidateQueries: false,
      });
      setAgentArchiving({
        queryClient,
        serverId: input.serverId,
        agentId: input.agentId,
        isArchiving: true,
      });
      return context;
    },
    onSuccess: (result, input) => {
      markAgentArchivedInStore({
        serverId: input.serverId,
        agentId: input.agentId,
        archivedAt: result.archivedAt,
      });
    },
    onError: (_error, input, context) => {
      if (!context) {
        return;
      }
      restoreAgentSnapshot({
        serverId: input.serverId,
        agentId: input.agentId,
        agent: context.agent,
      });
      restoreArchivedAgentListCacheSnapshot(queryClient, input.serverId, context.lists);
    },
    onSettled: (_result, _error, input) => {
      clearArchiveAgentPending({
        queryClient,
        serverId: input.serverId,
        agentId: input.agentId,
      });
      void queryClient.invalidateQueries({
        queryKey: ["sidebarAgentsList", input.serverId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["allAgents", input.serverId],
      });
      void queryClient.invalidateQueries({
        queryKey: agentHistoryQueryKey(input.serverId),
      });
    },
  });

  const archiveMutateAsync = archiveMutation.mutateAsync;

  const archiveAgent = useCallback(
    async (input: ArchiveAgentInput): Promise<void> => {
      await archiveMutateAsync(input);
    },
    [archiveMutateAsync],
  );

  const isArchivingAgent = useCallback(
    (input: ArchiveAgentInput): boolean => {
      const key = toArchiveKey(input);
      if (!key) {
        return false;
      }
      return (pendingQuery.data ?? {})[key] ?? false;
    },
    [pendingQuery.data],
  );

  return {
    archiveAgent,
    isArchivingAgent,
  };
}
