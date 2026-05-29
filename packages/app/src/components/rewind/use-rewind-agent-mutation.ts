import { useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import { useToast } from "@/contexts/toast-context";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { RewindMode } from "./use-rewind-capabilities";
import { useRewindComposerRestore } from "./composer-restore";
import { useSessionStore } from "@/stores/session-store";
import { shouldRestoreComposerForRewindMode } from "./rewind-mode";
import { clearOptimisticUserMessages } from "@/types/stream";

interface UseRewindAgentMutationInput {
  serverId?: string;
  agentId?: string;
  messageId?: string;
  client?: DaemonClient | null;
}

interface RewindAgentInput {
  mode: RewindMode;
  rewoundText: string;
}

export function useRewindAgentMutation(input: UseRewindAgentMutationInput): {
  rewindAgent: (input: RewindAgentInput) => Promise<void>;
  isPending: boolean;
} {
  const toast = useToast();
  const composerRestore = useRewindComposerRestore();
  const { isPending, mutateAsync } = useMutation({
    mutationFn: async ({ mode }: RewindAgentInput) => {
      if (!input.client || !input.agentId || !input.messageId) {
        throw new Error("Daemon client not available");
      }
      await input.client.rewindAgent(input.agentId, input.messageId, mode);
      if (mode !== "files") {
        if (input.serverId) {
          const session = useSessionStore.getState().sessions[input.serverId];
          useSessionStore.getState().setAgentStreamState(input.serverId, input.agentId, {
            tail: clearOptimisticUserMessages(session?.agentStreamTail.get(input.agentId) ?? []),
            head: clearOptimisticUserMessages(session?.agentStreamHead.get(input.agentId) ?? []),
          });
        }
        const cursor = input.serverId
          ? useSessionStore
              .getState()
              .sessions[input.serverId]?.agentTimelineCursor.get(input.agentId)
          : undefined;
        await input.client.fetchAgentTimeline(input.agentId, {
          direction: "tail",
          projection: "canonical",
          ...(cursor ? { cursor: { epoch: cursor.epoch, seq: cursor.endSeq } } : {}),
        });
      }
    },
    onSuccess: (_data, variables) => {
      if (!shouldRestoreComposerForRewindMode(variables.mode)) {
        return;
      }
      composerRestore?.restoreTextIfComposerEmpty(variables.rewoundText);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to rewind agent");
    },
  });

  const rewindAgent = useCallback(
    async (rewindInput: RewindAgentInput) => {
      if (isPending) {
        return;
      }
      await mutateAsync(rewindInput);
    },
    [isPending, mutateAsync],
  );

  return {
    rewindAgent,
    isPending,
  };
}
