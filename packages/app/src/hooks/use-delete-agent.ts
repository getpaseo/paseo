import { useCallback } from "react";
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useSessionStore } from "@/stores/session-store";
import { agentHistoryQueryKey, allAgentHistoryQueryRootKey } from "./agent-history-query-key";
import {
  removeAgentFromCachedLists,
  type AgentHistoryQueryData,
  type ArchiveAgentInput,
} from "./use-archive-agent";

export type DeleteAgentInput = ArchiveAgentInput;

function removeAgentFromHistoryPayload<T extends AgentHistoryQueryData | undefined>(
  payload: T,
  input: DeleteAgentInput,
): T {
  if (!payload || !Array.isArray(payload.pages) || !input.agentId) {
    return payload;
  }

  let changed = false;
  const pages = payload.pages.map((page) => {
    if (!Array.isArray(page.agents)) {
      return page;
    }
    const agents = page.agents.filter((agent) => {
      if (agent.id !== input.agentId) {
        return true;
      }
      if (agent.serverId != null && agent.serverId !== input.serverId) {
        return true;
      }
      changed = true;
      return false;
    });
    return agents.length === page.agents.length ? page : { ...page, agents };
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

function applyDeletedAgent(queryClient: QueryClient, input: DeleteAgentInput): void {
  removeAgentFromStore(input);
  removeAgentFromCachedLists(queryClient, input);
  removeAgentFromHistoryCache(queryClient, input);
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
      applyDeletedAgent(queryClient, input);
    },
    onSettled: (_result, _error, input) => {
      void queryClient.invalidateQueries({
        queryKey: ["sidebarAgentsList", input.serverId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["allAgents", input.serverId],
      });
      void queryClient.invalidateQueries({
        queryKey: agentHistoryQueryKey(input.serverId),
      });
      void queryClient.invalidateQueries({
        queryKey: allAgentHistoryQueryRootKey(),
      });
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

export const __private__ = {
  removeAgentFromHistoryPayload,
  removeAgentFromHistoryCache,
  applyDeletedAgent,
};
