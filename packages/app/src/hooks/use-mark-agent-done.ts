import { useCallback } from "react";
import { useToast } from "@/contexts/toast-context";
import { i18n } from "@/i18n/i18next";
import { useHostFeature } from "@/runtime/host-features";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

export function useMarkAgentDone(serverId: string | undefined) {
  const supported = useHostFeature(serverId, "agentFollowUp");
  const toast = useToast();
  const markDone = useCallback(
    async (agentId: string, resultId: string) => {
      try {
        const client = serverId && getHostRuntimeStore().getClient(serverId);
        if (!client) throw new Error(i18n.t("workspace.terminal.hostDisconnected"));
        await client.markAgentDone(agentId, resultId);
        return true;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    [serverId, toast],
  );
  return supported ? markDone : null;
}
