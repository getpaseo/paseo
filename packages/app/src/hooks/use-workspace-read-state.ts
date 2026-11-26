import { useCallback, useMemo } from "react";
import { i18n } from "@/i18n/i18next";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useWorkspaceFields } from "@/stores/session-store-hooks";

export interface WorkspaceReadStateController {
  hasClearableAttention: boolean;
  clearAttention: () => Promise<void>;
}

export function useWorkspaceReadState({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}): WorkspaceReadStateController {
  const observed = useWorkspaceFields(serverId, workspaceId, (workspace) => ({
    status: workspace.status,
    attentionKeys: workspace.attentionKeys,
    reviewResults: workspace.reviewResults,
  }));
  const hasClearableAttention = observed?.status === "attention" || observed?.status === "failed";

  const clearAttention = useCallback(async () => {
    if (!hasClearableAttention) {
      return;
    }
    const client = getHostRuntimeStore().getClient(serverId);
    if (!client) {
      throw new Error(i18n.t("workspace.terminal.hostDisconnected"));
    }
    await client.clearWorkspaceAttention(workspaceId, {
      observedAttentionKeys: observed.attentionKeys ?? {},
      observedResultIds: observed.reviewResults?.map((result) => result.id) ?? [],
    });
  }, [hasClearableAttention, serverId, workspaceId, observed]);

  return useMemo(
    () => ({ hasClearableAttention, clearAttention }),
    [clearAttention, hasClearableAttention],
  );
}
