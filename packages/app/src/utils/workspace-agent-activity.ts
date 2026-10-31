import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import { isWorkspaceRootAgent } from "@/subagents/policies";
import { deriveSidebarStateBucket } from "./sidebar-agent-state";

/**
 * Three numbers, all measured over the same set of root agents: finished-but-not-opened
 * (`unread`), running right now (`running`), and finished-and-already-opened (`read`). The
 * sidebar hides any of them that is zero, so a row only shows what is actually outstanding.
 */
export interface WorkspaceAgentStatusCounts {
  unread: number;
  running: number;
  read: number;
}

export interface WorkspaceAgentActivity {
  agentId: string;
  status: WorkspaceDescriptor["status"];
  enteredAt: Date | null;
  statusCounts: WorkspaceAgentStatusCounts;
}

function workspaceAgentStatus(agent: Agent): Agent["status"] {
  if (agent.turn.phase === "open") return "running";
  return agent.status === "running" ? "idle" : agent.status;
}

function countAgentStatus(
  countsByWorkspaceId: Map<string, WorkspaceAgentStatusCounts>,
  agent: Agent,
  status: WorkspaceDescriptor["status"],
): WorkspaceAgentStatusCounts {
  const workspaceId = agent.workspaceId;
  if (!workspaceId) throw new Error("Agent workspace is required for status counts");
  const statusCounts = countsByWorkspaceId.get(workspaceId) ?? { unread: 0, running: 0, read: 0 };
  if (status === "running") {
    statusCounts.running += 1;
  } else if (agent.status !== "initializing") {
    // attention = finished and not opened yet; plain done = already looked at.
    if (status === "attention") statusCounts.unread += 1;
    else if (status === "done") statusCounts.read += 1;
  }
  countsByWorkspaceId.set(workspaceId, statusCounts);
  return statusCounts;
}

function isSameActivity(
  previous: WorkspaceAgentActivity,
  activity: WorkspaceAgentActivity,
): boolean {
  return (
    previous.agentId === activity.agentId &&
    previous.status === activity.status &&
    previous.statusCounts.unread === activity.statusCounts.unread &&
    previous.statusCounts.running === activity.statusCounts.running &&
    previous.statusCounts.read === activity.statusCounts.read
  );
}

export function buildWorkspaceAgentActivityIndex(
  agents: ReadonlyMap<string, Agent>,
  previous?: ReadonlyMap<string, WorkspaceAgentActivity>,
): Map<string, WorkspaceAgentActivity> {
  const activityByWorkspaceId = new Map<string, WorkspaceAgentActivity>();
  const latestActivityAtByWorkspaceId = new Map<string, Date>();
  const statusCountsByWorkspaceId = new Map<string, WorkspaceAgentStatusCounts>();

  for (const agent of agents.values()) {
    const parentAgent = agent.parentAgentId ? agents.get(agent.parentAgentId) : undefined;
    if (agent.archivedAt || !agent.workspaceId || !isWorkspaceRootAgent(agent, parentAgent)) {
      continue;
    }

    const status = deriveSidebarStateBucket({
      status: workspaceAgentStatus(agent),
      pendingPermissionCount: agent.pendingPermissions.length,
      requiresAttention: agent.requiresAttention,
      attentionReason: agent.attentionReason,
    });
    const statusCounts = countAgentStatus(statusCountsByWorkspaceId, agent, status);

    const enteredAt = agent.attentionTimestamp ?? agent.updatedAt;
    const latestActivityAt = latestActivityAtByWorkspaceId.get(agent.workspaceId);
    if (latestActivityAt && enteredAt <= latestActivityAt) {
      continue;
    }
    latestActivityAtByWorkspaceId.set(agent.workspaceId, enteredAt);

    activityByWorkspaceId.set(agent.workspaceId, {
      agentId: agent.id,
      status,
      enteredAt,
      statusCounts,
    });
  }

  for (const [workspaceId, activity] of activityByWorkspaceId) {
    const previousActivity = previous?.get(workspaceId);
    if (previousActivity && isSameActivity(previousActivity, activity)) {
      activityByWorkspaceId.set(workspaceId, previousActivity);
    }
  }

  if (previous && areWorkspaceAgentActivityIndexesIdentical(previous, activityByWorkspaceId)) {
    return previous instanceof Map ? previous : new Map(previous);
  }
  return activityByWorkspaceId;
}

function areWorkspaceAgentActivityIndexesIdentical(
  previous: ReadonlyMap<string, WorkspaceAgentActivity>,
  next: ReadonlyMap<string, WorkspaceAgentActivity>,
): boolean {
  if (previous.size !== next.size) {
    return false;
  }
  for (const [workspaceId, activity] of next) {
    if (previous.get(workspaceId) !== activity) {
      return false;
    }
  }
  return true;
}
