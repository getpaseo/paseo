import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { useToast } from "@/contexts/toast-context";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { RewindMode } from "./use-rewind-capabilities";
import { useRewindComposerRestore } from "./composer-restore";
import { useSessionStore } from "@/stores/session-store";
import { shouldRestoreComposerForRewindMode } from "./rewind-mode";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

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
  const { t } = useTranslation();
  const composerRestore = useRewindComposerRestore();
  const { isPending, mutateAsync } = useMutation({
    onMutate: async ({ mode }: RewindAgentInput) => {
      if (mode !== "files" && input.serverId && input.agentId && input.messageId) {
        const session = useSessionStore.getState().sessions[input.serverId];
        const previousTail = session?.agentStreamTail.get(input.agentId);
        const previousHead = session?.agentStreamHead.get(input.agentId);

        // Optimistic truncation: slice the local stream immediately (Zed-style zero-flash)
        const expectedTruncatedTail = useSessionStore
          .getState()
          .truncateAgentStreamTailAtMessageId(input.serverId, input.agentId, input.messageId);

        return { previousTail, previousHead, expectedTruncatedTail };
      }
      return undefined;
    },
    mutationFn: async ({ mode }: RewindAgentInput) => {
      if (!input.client || !input.agentId || !input.messageId) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      await input.client.rewindAgent(input.agentId, input.messageId, mode);
      if (mode !== "files") {
        const cursor = input.serverId
          ? useSessionStore
              .getState()
              .sessions[input.serverId]?.agentTimelineCursor.get(input.agentId)
          : undefined;
        if (!input.serverId) throw new Error(t("common.errors.daemonClientUnavailable"));
        await getHostRuntimeStore().fetchAgentTimeline(input.serverId, input.agentId, {
          direction: "tail",
          projection: "projected",
          ...(cursor ? { cursor: { epoch: cursor.epoch, seq: cursor.endSeq } } : {}),
        });
      }
    },
    onSuccess: (_data, variables) => {
      if (!shouldRestoreComposerForRewindMode(variables.mode)) {
        return;
      }
      composerRestore?.completeRewind(variables.rewoundText);
    },
    onError: (error, _variables, context) => {
      // Guarded rollback: only restore if the timeline has not been updated by newer stream events
      if (input.serverId && input.agentId && context?.expectedTruncatedTail) {
        useSessionStore.getState().rollbackOptimisticStreamTruncation(
          input.serverId,
          input.agentId,
          context.expectedTruncatedTail,
          context.previousTail,
          context.previousHead,
        );
        void getHostRuntimeStore().fetchAgentTimeline(input.serverId, input.agentId, {
          direction: "tail",
          projection: "projected",
        });
      }
      toast.error(error instanceof Error ? error.message : t("rewind.errors.failed"));
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
