import { useCallback, useMemo } from "react";
import { i18n } from "@/i18n/i18next";
import { useHostFeature } from "@/runtime/host-features";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import { markWorkspaceUnread } from "@/workspace/mark-unread";

export interface WorkspaceReadStateController {
  hasClearableAttention: boolean;
  canMarkUnread: boolean;
  clearAttention: () => Promise<void>;
  markUnread: () => Promise<void>;
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
  const supportsMarkUnread = useHostFeature(serverId, "workspaceMarkUnread");
  const hasClearableAttention = observed?.status === "attention" || observed?.status === "failed";
  const canMarkUnread = supportsMarkUnread && observed?.status === "done";

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

  const markUnread = useCallback(async () => {
    if (!canMarkUnread) {
      return;
    }
    await markWorkspaceUnread(serverId, workspaceId);
  }, [canMarkUnread, serverId, workspaceId]);

  return useMemo(
    () => ({ hasClearableAttention, canMarkUnread, clearAttention, markUnread }),
    [canMarkUnread, clearAttention, hasClearableAttention, markUnread],
  );
}
