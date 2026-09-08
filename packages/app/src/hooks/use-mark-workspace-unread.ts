import { useCallback, useMemo } from "react";
import { i18n } from "@/i18n/i18next";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { useSessionStore } from "@/stores/session-store";

export interface MarkWorkspaceUnreadController {
  canMarkUnread: boolean;
  markUnread: () => Promise<void>;
}

export function useMarkWorkspaceUnread({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}): MarkWorkspaceUnreadController {
  const hasAttention = useSessionStore((state) => {
    const workspace = state.sessions[serverId]?.workspaces.get(workspaceId);
    return workspace?.status === "attention" || workspace?.status === "failed";
  });
  const supportsMarkUnread = useHostFeature(serverId, "workspaceMarkUnread");
  // Mark as unread is only meaningful on workspaces without pending
  // attention; attention already implies unread.
  const canMarkUnread = supportsMarkUnread && !hasAttention;

  const markUnread = useCallback(async () => {
    if (!canMarkUnread) {
      return;
    }
    const client = getHostRuntimeStore().getClient(serverId);
    if (!client) {
      throw new Error(i18n.t("workspace.terminal.hostDisconnected"));
    }
    await client.markWorkspaceUnread(workspaceId);
  }, [canMarkUnread, serverId, workspaceId]);

  return useMemo(() => ({ canMarkUnread, markUnread }), [canMarkUnread, markUnread]);
}
