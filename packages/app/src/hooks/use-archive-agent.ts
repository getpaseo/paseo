import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useSessionStore } from "@/stores/session-store";
import { agentHistoryQueryKey } from "./agent-history-query-key";

export const ARCHIVE_AGENT_PENDING_QUERY_KEY = ["archive-agent-pending"] as const;

export interface ArchiveAgentInput {
  serverId: string;
  agentId: string;
}

export interface ArchivedAgentCloseResult {
  agentId: string;
  archivedAt: string;
}

type ArchiveAgentPendingState = Record<string, true>;

interface SetAgentArchivingInput extends ArchiveAgentInput {
  queryClient: QueryClient;
  isArchiving: boolean;
}

interface IsAgentArchivingInput extends ArchiveAgentInput {
  queryClient: QueryClient;
}

interface AgentsListQueryData {
  entries?: Array<{ agent?: { id?: string | null } | null } | null>;
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

interface AgentHistoryQueryAgent {
  id?: string | null;
  archivedAt?: Date | null;
}

interface AgentHistoryQueryPage {
  agents?: AgentHistoryQueryAgent[];
}

interface AgentHistoryQueryData {
  pages?: AgentHistoryQueryPage[];
}

function toArchiveKey(input: ArchiveAgentInput): string {
  const serverId = input.serverId.trim();
  const agentId = input.agentId.trim();
  if (!serverId || !agentId) {
    return "";
  }
  return `${serverId}:${agentId}`;
}

function readPendingState(queryClient: QueryClient): ArchiveAgentPendingState {
  return queryClient.getQueryData<ArchiveAgentPendingState>(ARCHIVE_AGENT_PENDING_QUERY_KEY) ?? {};
}

function setAgentArchiving(input: SetAgentArchivingInput): void {
  const key = toArchiveKey(input);
  if (!key) {
    return;
  }

  input.queryClient.setQueryData<ArchiveAgentPendingState>(
    ARCHIVE_AGENT_PENDING_QUERY_KEY,
    (current) => {
      const state = current ?? {};
      if (input.isArchiving) {
        if (state[key]) {
          return state;
        }
        return { ...state, [key]: true };
      }

      if (!state[key]) {
        return state;
      }

      const next = { ...state };
      delete next[key];
      return next;
    },
  );
}

function isAgentArchiving(input: IsAgentArchivingInput): boolean {
  const key = toArchiveKey(input);
  if (!key) {
    return false;
  }
  return readPendingState(input.queryClient)[key] ?? false;
}

function removeAgentFromListPayload<T extends AgentsListQueryData | undefined>(
  payload: T,
  agentId: string,
): T {
  if (!payload || !Array.isArray(payload.entries) || !agentId) {
    return payload;
  }
  const filtered = payload.entries.filter((entry) => entry?.agent?.id !== agentId);
  if (filtered.length === payload.entries.length) {
    return payload;
  }
  return {
    ...payload,
    entries: filtered,
  } as T;
}

function removeAgentFromCachedLists(queryClient: QueryClient, input: ArchiveAgentInput): void {
  const agentId = input.agentId.trim();
  if (!agentId) {
    return;
  }

  queryClient.setQueryData<AgentsListQueryData | undefined>(
    ["sidebarAgentsList", input.serverId],
    (current) => removeAgentFromListPayload(current, agentId),
  );
  queryClient.setQueryData<AgentsListQueryData | undefined>(
    ["allAgents", input.serverId],
    (current) => removeAgentFromListPayload(current, agentId),
  );
}

function markAgentArchivedInHistoryPayload<T extends AgentHistoryQueryData | undefined>(
  payload: T,
  input: ArchiveAgentInput & { archivedAt: string },
): T {
  if (!payload || !Array.isArray(payload.pages) || !input.agentId) {
    return payload;
  }

  const archivedAt = new Date(input.archivedAt);
  if (Number.isNaN(archivedAt.getTime())) {
    return payload;
  }

  let changed = false;
  const pages = payload.pages.map((page) => {
    if (!Array.isArray(page.agents)) {
      return page;
    }

    let pageChanged = false;
    const agents = page.agents.map((agent) => {
      if (agent.id !== input.agentId) {
        return agent;
      }
      pageChanged = true;
      changed = true;
      return {
        ...agent,
        archivedAt,
      };
    });

    return pageChanged ? { ...page, agents } : page;
  });

  return changed ? ({ ...payload, pages } as T) : payload;
}

function markAgentArchivedInHistoryCache(
  queryClient: QueryClient,
  input: ArchiveAgentInput & { archivedAt: string },
): void {
  queryClient.setQueryData<AgentHistoryQueryData | undefined>(
    agentHistoryQueryKey(input.serverId),
    (current) => markAgentArchivedInHistoryPayload(current, input),
  );
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

export function clearArchiveAgentPending(input: IsAgentArchivingInput): void {
  setAgentArchiving({
    ...input,
    isArchiving: false,
  });
}

export function useArchiveAgent() {
  const queryClient = useQueryClient();

  const pendingQuery = useQuery({
    queryKey: ARCHIVE_AGENT_PENDING_QUERY_KEY,
    queryFn: async (): Promise<ArchiveAgentPendingState> => ({}),
    initialData: {} as ArchiveAgentPendingState,
    staleTime: Infinity,
    gcTime: Infinity,
  });

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

export const __private__ = {
  toArchiveKey,
  readPendingState,
  setAgentArchiving,
  isAgentArchiving,
  removeAgentFromListPayload,
  markAgentArchivedInHistoryPayload,
};
