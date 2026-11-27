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
  // COMPAT(agentFollowUp): added in v0.17.2, remove legacy sidebar action after 2027-05-22.
  const supportsChatReview = useHostFeature(serverId, "agentFollowUp");
  const supportsWorkspaceUnread = useHostFeature(serverId, "workspaceMarkUnread");
  const observed = useWorkspaceFields(serverId, workspaceId, (workspace) => ({
    status: workspace.status,
    attentionKeys: workspace.attentionKeys,
    reviewResults: workspace.reviewResults,
  }));
  const hasClearableAttention =
    observed != null &&
    (supportsChatReview
      ? Object.keys(observed.attentionKeys ?? {}).length > 0
      : observed.status === "attention" || observed.status === "failed");
  const canMarkUnread =
    !supportsChatReview && supportsWorkspaceUnread && observed?.status === "done";

  const clearAttention = useCallback(async () => {
    if (!hasClearableAttention) {
      return;
    }
    const client = getHostRuntimeStore().getClient(serverId);
    if (!client) {
      throw new Error(i18n.t("workspace.terminal.hostDisconnected"));
    }
    await client.clearWorkspaceAttention(
      workspaceId,
      supportsChatReview
        ? {
            observedAttentionKeys: observed.attentionKeys ?? {},
            observedResultIds: observed.reviewResults?.map((result) => result.id) ?? [],
          }
        : undefined,
    );
  }, [hasClearableAttention, serverId, workspaceId, observed, supportsChatReview]);

  const markUnread = useCallback(async () => {
    if (canMarkUnread) await markWorkspaceUnread(serverId, workspaceId);
  }, [canMarkUnread, serverId, workspaceId]);

  return useMemo(
    () => ({ hasClearableAttention, canMarkUnread, clearAttention, markUnread }),
    [hasClearableAttention, canMarkUnread, clearAttention, markUnread],
  );
}
