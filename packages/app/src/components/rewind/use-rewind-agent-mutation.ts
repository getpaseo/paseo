import { useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import { useToast } from "@/contexts/toast-context";
import type { DaemonClient } from "@server/client/daemon-client";
import type { RewindMode } from "./use-rewind-capabilities";

interface UseRewindAgentMutationInput {
  agentId?: string;
  messageId?: string;
  client?: DaemonClient | null;
}

interface RewindAgentInput {
  mode: RewindMode;
}

export function useRewindAgentMutation(input: UseRewindAgentMutationInput): {
  rewindAgent: (mode: RewindMode) => void;
  isPending: boolean;
} {
  const toast = useToast();
  const { isPending, mutate } = useMutation({
    mutationFn: async ({ mode }: RewindAgentInput) => {
      if (!input.client || !input.agentId || !input.messageId) {
        throw new Error("Daemon client not available");
      }
      await input.client.rewindAgent(input.agentId, input.messageId, mode);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to rewind agent");
    },
  });

  const rewindAgent = useCallback(
    (mode: RewindMode) => {
      if (isPending) {
        return;
      }
      mutate({ mode });
    },
    [isPending, mutate],
  );

  return {
    rewindAgent,
    isPending,
  };
}
