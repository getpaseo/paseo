import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { getAttentionKey } from "@getpaseo/protocol/agent-state-bucket";
import { useCallback, useMemo } from "react";
import { useShallow } from "zustand/shallow";
import { useToast } from "@/contexts/toast-context";
import { useMarkAgentDone } from "@/hooks/use-mark-agent-done";
import { i18n } from "@/i18n/i18next";
import { useHostFeature } from "@/runtime/host-features";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import { useSessionStore } from "@/stores/session-store";
import { findPaneById, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";

export interface AgentTabReviewActions {
  markAsRead?: () => void;
  markAsUnread?: () => void;
  markDone?: () => void;
  markForFollowUp?: () => void;
}

export function useAgentTabReviewActions({
  serverId,
  workspaceId,
  tab,
}: {
  serverId: string;
  workspaceId: string;
  tab: WorkspaceTabDescriptor;
}): AgentTabReviewActions {
  const agentId = tab.target.kind === "agent" ? tab.target.agentId : undefined;
  const tabId = tab.tabId;
  const markDone = useMarkAgentDone(serverId);
  // COMPAT(agentMarkUnread): added in v0.17.2, remove gate after 2027-05-25.
  const supportsUnread = useHostFeature(serverId, "agentMarkUnread");
  // COMPAT(agentRestoreFollowUp): added in v0.17.2, remove gate after 2027-05-25.
  const supportsFollowUp = useHostFeature(serverId, "agentRestoreFollowUp");
  const { resultId, reopenableResultId, readAttentionKey, canMarkUnread } = useSessionStore(
    useShallow((state) => {
      const session = state.sessions[serverId];
      const agent = agentId && (session?.agents.get(agentId) ?? session?.agentDetails.get(agentId));
      const settled =
        agent && (agent.status === "idle" || agent.status === "closed" || agent.status === "error");
      if (!settled || agent.archivedAt) return { canMarkUnread: false };
      const hasPendingPermissions = agent.pendingPermissions.length > 0;
      const canMarkRead =
        agent.requiresAttention && agent.attentionReason !== "permission" && !hasPendingPermissions;
      return {
        resultId: agent.reviewResult?.id,
        reopenableResultId: agent.reopenableReviewResultId,
        readAttentionKey: canMarkRead
          ? getAttentionKey({
              attentionReason: agent.attentionReason,
              attentionTimestamp: agent.attentionTimestamp?.toISOString(),
              reviewResult: agent.reviewResult,
            })
          : undefined,
        canMarkUnread: !agent.requiresAttention && !hasPendingPermissions,
      };
    }),
  );
  const toast = useToast();
  const run = useCallback(
    async (action: (client: DaemonClient) => Promise<void>) => {
      try {
        const client = getHostRuntimeStore().getClient(serverId);
        if (!client) throw new Error(i18n.t("workspace.terminal.hostDisconnected"));
        await action(client);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    },
    [serverId, toast],
  );

  return useMemo(
    () => ({
      markAsRead:
        agentId && readAttentionKey !== undefined
          ? () => void run((client) => client.clearAgentAttention(agentId, readAttentionKey))
          : undefined,
      markAsUnread:
        agentId && supportsUnread && canMarkUnread
          ? () => {
              void run(async (client) => {
                const workspaceKey = `${serverId}:${workspaceId}`;
                const store = useWorkspaceLayoutStore.getState();
                const layout = store.layoutByWorkspace[workspaceKey];
                const focusedPane = layout && findPaneById(layout.root, layout.focusedPaneId);
                // Stop viewing this chat before bringing back its unread indicator.
                const focusToken =
                  focusedPane?.focusedTabId === tabId ? store.unfocusPane(workspaceKey) : null;
                try {
                  await client.markAgentUnread(agentId);
                } catch (error) {
                  if (focusToken) store.restorePaneFocus(workspaceKey, focusToken);
                  throw error;
                }
              });
            }
          : undefined,
      markDone:
        agentId && resultId && markDone ? () => void markDone(agentId, resultId) : undefined,
      markForFollowUp:
        agentId && reopenableResultId && supportsFollowUp
          ? () => void run((client) => client.markAgentForFollowUp(agentId, reopenableResultId))
          : undefined,
    }),
    [
      agentId,
      canMarkUnread,
      markDone,
      readAttentionKey,
      reopenableResultId,
      resultId,
      run,
      serverId,
      supportsFollowUp,
      supportsUnread,
      tabId,
      workspaceId,
    ],
  );
}
