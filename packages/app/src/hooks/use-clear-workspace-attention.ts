import { useCallback, useMemo } from "react";
import { i18n } from "@/i18n/i18next";
import { getHostClient } from "@/runtime/host-runtime";
import { useWorkspaceFields } from "@/stores/session-store-hooks";

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
  const hasClearableAttention =
    useWorkspaceFields(
      serverId,
      workspaceId,
      (workspace) => workspace.status === "attention" || workspace.status === "failed",
    ) ?? false;

  const clearAttention = useCallback(async () => {
    if (!hasClearableAttention) {
      return;
    }
    const client = getHostClient(serverId);
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
