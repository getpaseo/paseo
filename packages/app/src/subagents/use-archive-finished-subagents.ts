import { useCallback } from "react";
import { useToast } from "@/contexts/toast-context";
import { i18n } from "@/i18n/i18next";
import { useSessionStore } from "@/stores/session-store";
import { toErrorMessage } from "@/utils/error-messages";

export interface UseArchiveFinishedSubagentsInput {
  serverId: string;
  parentAgentId: string;
}

export function useArchiveFinishedSubagents({
  serverId,
  parentAgentId,
}: UseArchiveFinishedSubagentsInput): () => void {
  const toast = useToast();

  return useCallback(() => {
    const client = useSessionStore.getState().sessions[serverId]?.client;
    if (!client) {
      toast.error(i18n.t("workspaceSetup.errors.hostDisconnected"));
      return;
    }
    void client.archiveFinishedSubagents(parentAgentId).catch((error) => {
      toast.error(toErrorMessage(error));
    });
  }, [parentAgentId, serverId, toast]);
}
