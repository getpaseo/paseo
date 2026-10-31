import { getWorkspaceStateBucketPriority } from "@getpaseo/protocol/agent-state-bucket";
import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import { isWorkspaceRootAgent } from "@/subagents/policies";
import { deriveSidebarStateBucket } from "./sidebar-agent-state";

export interface WorkspaceAgentActivity {
  agentId: string;
  status: WorkspaceDescriptor["status"];
  enteredAt: Date | null;
}

function workspaceAgentStatus(agent: Agent): Agent["status"] {
  if (agent.turn.phase === "open") return "running";
  return agent.status === "running" ? "idle" : agent.status;
}

export function buildWorkspaceAgentActivityIndex(
  agents: ReadonlyMap<string, Agent>,
  previous?: ReadonlyMap<string, WorkspaceAgentActivity>,
): Map<string, WorkspaceAgentActivity> {
  const activityByWorkspaceId = new Map<string, WorkspaceAgentActivity>();

  for (const agent of agents.values()) {
    const parentAgent = agent.parentAgentId ? agents.get(agent.parentAgentId) : undefined;
    if (agent.archivedAt || !agent.workspaceId || !isWorkspaceRootAgent(agent, parentAgent)) {
      continue;
    }

    const candidate: WorkspaceAgentActivity = {
      agentId: agent.id,
      status: deriveSidebarStateBucket({
        status: workspaceAgentStatus(agent),
        pendingPermissionCount: agent.pendingPermissions.length,
        requiresAttention: agent.requiresAttention,
        attentionReason: agent.attentionReason,
      }),
      enteredAt: agent.attentionTimestamp ?? agent.updatedAt,
    };
    const current = activityByWorkspaceId.get(agent.workspaceId);
    if (!current || outranksWorkspaceAgentActivity(candidate, current)) {
      activityByWorkspaceId.set(agent.workspaceId, candidate);
    }
  }

  for (const [workspaceId, activity] of activityByWorkspaceId) {
    const previousActivity = previous?.get(workspaceId);
    if (
      previousActivity?.agentId === activity.agentId &&
      previousActivity.status === activity.status
    ) {
      activityByWorkspaceId.set(workspaceId, previousActivity);
    }
  }

  if (previous && areWorkspaceAgentActivityIndexesIdentical(previous, activityByWorkspaceId)) {
    return previous instanceof Map ? previous : new Map(previous);
  }
  return activityByWorkspaceId;
}

// The most urgent agent stands for its workspace, using the server's bucket priority for
// workspace rows; the most recent activity breaks a tie.
function outranksWorkspaceAgentActivity(
  candidate: WorkspaceAgentActivity,
  current: WorkspaceAgentActivity,
): boolean {
  const rankDelta =
    getWorkspaceStateBucketPriority(candidate.status) -
    getWorkspaceStateBucketPriority(current.status);
  if (rankDelta !== 0) {
    return rankDelta < 0;
  }
  return (candidate.enteredAt?.getTime() ?? 0) > (current.enteredAt?.getTime() ?? 0);
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
