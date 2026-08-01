import { useCallback, useMemo } from "react";
import { i18n } from "@/i18n/i18next";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

export interface MarkWorkspaceAttentionController {
  hasMarkableAttention: boolean;
  markAttention: () => Promise<void>;
}

export function useMarkWorkspaceAttention({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}): MarkWorkspaceAttentionController {
  const hasMarkableAttention = useSessionStore((state) => {
    const workspace = state.sessions[serverId]?.workspaces.get(workspaceId);
    return workspace?.status === "done";
  });

  const markAttention = useCallback(async () => {
    if (!hasMarkableAttention) {
      return;
    }
    const client = getHostRuntimeStore().getClient(serverId);
    if (!client) {
      throw new Error(i18n.t("workspace.terminal.hostDisconnected"));
    }
    await client.markWorkspaceAttention(workspaceId);
  }, [hasMarkableAttention, serverId, workspaceId]);

  return useMemo(
    () => ({ hasMarkableAttention, markAttention }),
    [markAttention, hasMarkableAttention],
  );
}
