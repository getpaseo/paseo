import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useSessionStore } from "@/stores/session-store";

export const ARCHIVE_AGENT_PENDING_QUERY_KEY = ["archive-agent-pending"] as const;

export interface ArchiveAgentInput {
  serverId: string;
  agentId: string;
}

type ArchiveAgentPendingState = Record<string, true>;

interface SetAgentArchivingInput extends ArchiveAgentInput {
  queryClient: QueryClient;
  isArchiving: boolean;
}

interface IsAgentArchivingInput extends ArchiveAgentInput {
  queryClient: QueryClient;
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
  return (
    queryClient.getQueryData<ArchiveAgentPendingState>(
      ARCHIVE_AGENT_PENDING_QUERY_KEY
    ) ?? {}
  );
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
    }
  );
}

function isAgentArchiving(input: IsAgentArchivingInput): boolean {
  const key = toArchiveKey(input);
  if (!key) {
    return false;
  }
  return Boolean(readPendingState(input.queryClient)[key]);
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
    mutationFn: async (input: ArchiveAgentInput) => {
      const client = useSessionStore.getState().sessions[input.serverId]?.client ?? null;
      if (!client) {
        throw new Error("Daemon client not available");
      }
      await client.archiveAgent(input.agentId);
    },
    onMutate: (input) => {
      setAgentArchiving({
        queryClient,
        serverId: input.serverId,
        agentId: input.agentId,
        isArchiving: true,
      });
    },
    onError: (_error, input) => {
      clearArchiveAgentPending({
        queryClient,
        serverId: input.serverId,
        agentId: input.agentId,
      });
    },
  });

  const archiveAgent = useCallback(
    async (input: ArchiveAgentInput): Promise<void> => {
      if (
        isAgentArchiving({
          queryClient,
          serverId: input.serverId,
          agentId: input.agentId,
        })
      ) {
        return;
      }
      await archiveMutation.mutateAsync(input);
    },
    [archiveMutation, queryClient]
  );

  const isArchivingAgent = useCallback(
    (input: ArchiveAgentInput): boolean => {
      const key = toArchiveKey(input);
      if (!key) {
        return false;
      }
      return Boolean((pendingQuery.data ?? {})[key]);
    },
    [pendingQuery.data]
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
};
