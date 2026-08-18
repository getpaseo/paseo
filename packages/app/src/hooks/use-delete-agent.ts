import { useCallback } from "react";
import {
  useMutation,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useSessionStore } from "@/stores/session-store";
import { agentHistoryQueryKey, allAgentHistoryQueryRootKey } from "./agent-history-query-key";
import {
  type AgentHistoryQueryData,
  getStoredAgentSnapshot,
  removeAgentFromCachedLists,
  restoreAgentSnapshot,
} from "./use-archive-agent";

export interface DeleteAgentInput {
  serverId: string;
  agentId: string;
}

/**
 * Removes an agent from the agent-history query payload entirely (unlike
 * archiving, which rewrites the entry with an `archivedAt` marker).
 */
export function removeAgentFromHistoryPayload<T extends AgentHistoryQueryData | undefined>(
  payload: T,
  input: DeleteAgentInput,
): T {
  if (!payload || !Array.isArray(payload.pages)) {
    return payload;
  }

  let changed = false;
  const pages = payload.pages.map((page) => {
    if (!Array.isArray(page.agents)) {
      return page;
    }

    const filtered = page.agents.filter(
      (agent) =>
        agent.id !== input.agentId || (agent.serverId != null && agent.serverId !== input.serverId),
    );
    if (filtered.length === page.agents.length) {
      return page;
    }
    changed = true;
    return { ...page, agents: filtered };
  });

  return changed ? ({ ...payload, pages } as T) : payload;
}

export function removeAgentFromHistoryCache(
  queryClient: QueryClient,
  input: DeleteAgentInput,
): void {
  queryClient.setQueryData<AgentHistoryQueryData | undefined>(
    agentHistoryQueryKey(input.serverId),
    (current) => removeAgentFromHistoryPayload(current, input),
  );
  queryClient.setQueriesData<AgentHistoryQueryData | undefined>(
    { queryKey: allAgentHistoryQueryRootKey() },
    (current) => removeAgentFromHistoryPayload(current, input),
  );
}

function removeAgentFromStore(input: DeleteAgentInput): void {
  const setAgents = useSessionStore.getState().setAgents;
  setAgents(input.serverId, (prev) => {
    if (!prev.has(input.agentId)) {
      return prev;
    }
    const next = new Map(prev);
    next.delete(input.agentId);
    return next;
  });
}

interface DeleteAgentListCacheSnapshot {
  sidebarAgentsList: AgentHistoryQueryData | undefined;
  allAgents: AgentHistoryQueryData | undefined;
  agentHistory: AgentHistoryQueryData | undefined;
  allAgentHistory: Array<[QueryKey, AgentHistoryQueryData | undefined]>;
}

function getDeleteCacheSnapshot(
  queryClient: QueryClient,
  serverId: string,
): DeleteAgentListCacheSnapshot {
  return {
    sidebarAgentsList: queryClient.getQueryData<AgentHistoryQueryData | undefined>([
      "sidebarAgentsList",
      serverId,
    ]),
    allAgents: queryClient.getQueryData<AgentHistoryQueryData | undefined>(["allAgents", serverId]),
    agentHistory: queryClient.getQueryData<AgentHistoryQueryData | undefined>(
      agentHistoryQueryKey(serverId),
    ),
    allAgentHistory: queryClient.getQueriesData<AgentHistoryQueryData | undefined>({
      queryKey: allAgentHistoryQueryRootKey(),
    }),
  };
}

function restoreCacheSnapshot(
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

function restoreDeleteCacheSnapshot(
  queryClient: QueryClient,
  serverId: string,
  snapshot: DeleteAgentListCacheSnapshot,
): void {
  restoreCacheSnapshot(queryClient, ["sidebarAgentsList", serverId], snapshot.sidebarAgentsList);
  restoreCacheSnapshot(queryClient, ["allAgents", serverId], snapshot.allAgents);
  restoreCacheSnapshot(queryClient, agentHistoryQueryKey(serverId), snapshot.agentHistory);
  for (const [queryKey, querySnapshot] of snapshot.allAgentHistory) {
    restoreCacheSnapshot(queryClient, queryKey, querySnapshot);
  }
}

interface DeleteAgentMutationContext {
  agent: ReturnType<typeof getStoredAgentSnapshot>;
  lists: DeleteAgentListCacheSnapshot;
}

export function useDeleteAgent() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const deleteMutation = useMutation({
    mutationFn: async (input: DeleteAgentInput): Promise<void> => {
      const client = useSessionStore.getState().sessions[input.serverId]?.client ?? null;
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      await client.deleteAgent(input.agentId);
    },
    onMutate: (input) => {
      const context: DeleteAgentMutationContext = {
        agent: getStoredAgentSnapshot(input),
        lists: getDeleteCacheSnapshot(queryClient, input.serverId),
      };

      removeAgentFromStore(input);
      removeAgentFromCachedLists(queryClient, input);
      removeAgentFromHistoryCache(queryClient, input);
      return context;
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
      restoreDeleteCacheSnapshot(queryClient, input.serverId, context.lists);
    },
    onSettled: (_result, _error, input) => {
      void queryClient.invalidateQueries({ queryKey: ["sidebarAgentsList", input.serverId] });
      void queryClient.invalidateQueries({ queryKey: ["allAgents", input.serverId] });
      void queryClient.invalidateQueries({ queryKey: agentHistoryQueryKey(input.serverId) });
      void queryClient.invalidateQueries({ queryKey: allAgentHistoryQueryRootKey() });
    },
  });

  const deleteMutateAsync = deleteMutation.mutateAsync;

  const deleteAgent = useCallback(
    async (input: DeleteAgentInput): Promise<void> => {
      await deleteMutateAsync(input);
    },
    [deleteMutateAsync],
  );

  return {
    deleteAgent,
  };
}
