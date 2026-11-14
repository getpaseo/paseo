import { planTimelineTailFetch } from "@/timeline/timeline-sync-plan";
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
import { hostSupportsFeature } from "@/runtime/host-features";

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
    mutationFn: async ({ mode }: RewindAgentInput) => {
      if (!input.client || !input.agentId || !input.messageId) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      await input.client.rewindAgent(input.agentId, input.messageId, mode);
      // COMPAT(timelineRewindOperations): added in v0.14.1, remove after 2027-05-10. A daemon with
      // the feature delivers the rewind on the live timeline; an older one replaced the timeline
      // and this client has to read it again.
      const appliesLive =
        input.serverId !== undefined &&
        hostSupportsFeature(
          useSessionStore.getState().sessions[input.serverId]?.serverInfo,
          "timelineRewindOperations",
        );
      if (mode !== "files" && !appliesLive) {
        const cursor = input.serverId
          ? useSessionStore
              .getState()
              .sessions[input.serverId]?.agentTimelineCursor.get(input.agentId)
          : undefined;
        if (!input.serverId) throw new Error(t("common.errors.daemonClientUnavailable"));
        await getHostRuntimeStore().fetchAgentTimeline(input.serverId, input.agentId, {
          ...planTimelineTailFetch(),
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
    onError: (error) => {
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
