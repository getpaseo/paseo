import { useCallback, useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  Assistant,
  AssistantCreateInput,
  AssistantUpdateInput,
} from "@getpaseo/protocol/messages";
import { assistantsQueryKey } from "@/data/assistants";
import { useReplicaQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

export interface UseAssistantsResult {
  assistants: Assistant[];
  isLoading: boolean;
  isConnected: boolean;
  error: Error | null;
  createAssistant: (input: AssistantCreateInput) => Promise<Assistant>;
  updateAssistant: (input: AssistantUpdateInput) => Promise<Assistant>;
  deleteAssistant: (id: string) => Promise<void>;
  isMutating: boolean;
  mutationError: Error | null;
}

function requireAssistant(assistant: Assistant | null, fallback: string): Assistant {
  if (!assistant) {
    throw new Error(fallback);
  }
  return assistant;
}

export interface UseAssistantsOptions {
  enabled?: boolean;
}

export function useAssistants(
  serverId: string,
  options: UseAssistantsOptions = {},
): UseAssistantsResult {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => assistantsQueryKey(serverId), [serverId]);

  const query = useReplicaQuery({
    queryKey,
    pushEvent: "assistant.changed",
    enabled: Boolean((options.enabled ?? true) && client && isConnected),
    queryFn: async () => {
      if (!client) {
        throw new Error("Host is disconnected");
      }
      const result = await client.listAssistants();
      if (result.error) {
        throw new Error(result.error);
      }
      return result.assistants;
    },
  });

  const mutation = useMutation({
    mutationFn: async (operation: () => Promise<Assistant[]>) => operation(),
    onSuccess: (assistants) => {
      queryClient.setQueryData(queryKey, assistants);
    },
  });

  const createAssistant = useCallback(
    async (input: AssistantCreateInput) => {
      if (!client) {
        return Promise.reject(new Error("Host is disconnected"));
      }
      return mutation
        .mutateAsync(async () => {
          const result = await client.createAssistant(input);
          if (result.error) {
            throw new Error(result.error);
          }
          const assistant = requireAssistant(result.assistant, "Assistant is unavailable");
          return [...(query.data ?? []), assistant];
        })
        .then((assistants) => assistants[assistants.length - 1]!);
    },
    [client, mutation, query.data],
  );

  const updateAssistant = useCallback(
    async (input: AssistantUpdateInput) => {
      if (!client) {
        return Promise.reject(new Error("Host is disconnected"));
      }
      return mutation
        .mutateAsync(async () => {
          const result = await client.updateAssistant(input);
          if (result.error) {
            throw new Error(result.error);
          }
          const assistant = requireAssistant(result.assistant, "Assistant is unavailable");
          return (query.data ?? []).map((entry) => (entry.id === assistant.id ? assistant : entry));
        })
        .then((assistants) =>
          requireAssistant(
            assistants.find((entry) => entry.id === input.id) ?? null,
            "Assistant is unavailable",
          ),
        );
    },
    [client, mutation, query.data],
  );

  const deleteAssistant = useCallback(
    async (id: string) => {
      if (!client) {
        return Promise.reject(new Error("Host is disconnected"));
      }
      await mutation.mutateAsync(async () => {
        const result = await client.deleteAssistant({ id });
        if (result.error) {
          throw new Error(result.error);
        }
        return (query.data ?? []).filter((assistant) => assistant.id !== id);
      });
    },
    [client, mutation, query.data],
  );

  return {
    assistants: query.data ?? [],
    isLoading: query.isLoading,
    isConnected,
    error: query.error,
    createAssistant,
    updateAssistant,
    deleteAssistant,
    isMutating: mutation.isPending,
    mutationError: mutation.error,
  };
}
