import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import { deriveSidebarStateBucket } from "./sidebar-agent-state";

export interface WorkspaceAgentActivity {
  status: WorkspaceDescriptor["status"];
  enteredAt: Date | null;
}

export function buildWorkspaceAgentActivityIndex(
  agents: ReadonlyMap<string, Agent>,
): Map<string, WorkspaceAgentActivity> {
  const activityByWorkspaceId = new Map<string, WorkspaceAgentActivity>();

  for (const agent of agents.values()) {
    if (agent.archivedAt || agent.parentAgentId || !agent.workspaceId) {
      continue;
    }

    const enteredAt = agent.attentionTimestamp ?? agent.updatedAt;
    const current = activityByWorkspaceId.get(agent.workspaceId);
    if (current && enteredAt <= (current.enteredAt ?? new Date(0))) {
      continue;
    }

    activityByWorkspaceId.set(agent.workspaceId, {
      status: deriveSidebarStateBucket({
        status: agent.status,
        pendingPermissionCount: agent.pendingPermissions.length,
        requiresAttention: agent.requiresAttention,
        attentionReason: agent.attentionReason,
      }),
      enteredAt,
    });
  }

  return activityByWorkspaceId;
}
