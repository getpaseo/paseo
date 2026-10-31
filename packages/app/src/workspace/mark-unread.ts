import { i18n } from "@/i18n/i18next";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { findPaneById, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";

/** Magic label consumed by the daemon `update_agent_request` interceptor. */
export const MARK_AGENT_UNREAD_LABEL = "paseo.markUnread";

interface AgentTabAttentionSnapshot {
  status?: string | null;
  requiresAttention?: boolean | null;
  attentionReason?: "finished" | "error" | "permission" | null;
  pendingPermissions?: { length: number } | { size: number } | null;
  archivedAt?: Date | string | null;
}

export function canMarkAgentTabUnread(
  agent: AgentTabAttentionSnapshot | null | undefined,
): boolean {
  if (!agent || agent.archivedAt) {
    return false;
  }
  const pending = agent.pendingPermissions;
  let pendingCount = 0;
  if (pending != null) {
    pendingCount = "length" in pending ? pending.length : pending.size;
  }
  if (pendingCount > 0) {
    return false;
  }
  if (agent.requiresAttention === true) {
    return agent.attentionReason === "finished" || agent.attentionReason === "error";
  }
  return agent.status === "idle" || agent.status === "closed";
}

export async function markAgentTabUnread(input: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  tabId: string;
}): Promise<void> {
  const client = getHostRuntimeStore().getClient(input.serverId);
  if (!client) {
    throw new Error(i18n.t("workspace.terminal.hostDisconnected"));
  }

  const workspaceKey = `${input.serverId}:${input.workspaceId}`;
  const layout = useWorkspaceLayoutStore.getState();
  const workspaceLayout = layout.layoutByWorkspace[workspaceKey];
  const focusedPane = workspaceLayout?.focusedPaneId
    ? findPaneById(workspaceLayout.root, workspaceLayout.focusedPaneId)
    : null;
  const isFocusedTab = focusedPane?.focusedTabId === input.tabId;
  // End viewing before restoring attention so agent-blur does not consume the mark.
  const focusToken = isFocusedTab ? layout.unfocusPane(workspaceKey) : null;
  try {
    await client.updateAgent(input.agentId, { labels: { [MARK_AGENT_UNREAD_LABEL]: "1" } });
  } catch (error) {
    if (focusToken) {
      layout.restorePaneFocus(workspaceKey, focusToken);
    }
    throw error;
  }
}

export async function markWorkspaceUnread(serverId: string, workspaceId: string): Promise<void> {
  const client = getHostRuntimeStore().getClient(serverId);
  if (!client) {
    throw new Error(i18n.t("workspace.terminal.hostDisconnected"));
  }

  const workspaceKey = `${serverId}:${workspaceId}`;
  const layout = useWorkspaceLayoutStore.getState();
  // End viewing before restoring attention. The next pane focus reads it normally;
  // leaving the workspace must not consume the mark the user just made.
  const focusToken = layout.layoutByWorkspace[workspaceKey]?.focusedPaneId
    ? layout.unfocusPane(workspaceKey)
    : null;
  try {
    await client.markWorkspaceUnread(workspaceId);
  } catch (error) {
    if (focusToken) {
      layout.restorePaneFocus(workspaceKey, focusToken);
    }
    throw error;
  }
}
