import { useCallback, useMemo } from "react";
import { i18n } from "@/i18n/i18next";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

export interface ClearWorkspaceAttentionController {
  hasClearableAttention: boolean;
  clearAttention: () => Promise<void>;
}

export function useClearWorkspaceAttention({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}): ClearWorkspaceAttentionController {
  const hasClearableAttention = useSessionStore((state) => {
    const workspace = state.sessions[serverId]?.workspaces.get(workspaceId);
    return workspace?.status === "attention" || workspace?.status === "failed";
  });

  const clearAttention = useCallback(async () => {
    if (!hasClearableAttention) {
      return;
    }
    const client = getHostRuntimeStore().getClient(serverId);
    if (!client) {
      throw new Error(i18n.t("workspace.terminal.hostDisconnected"));
    }
    await client.clearWorkspaceAttention(workspaceId);
  }, [hasClearableAttention, serverId, workspaceId]);

  return useMemo(
    () => ({ hasClearableAttention, clearAttention }),
    [clearAttention, hasClearableAttention],
  );
}
