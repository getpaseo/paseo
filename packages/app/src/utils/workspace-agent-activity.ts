import type { Agent } from "@/stores/session-store";
import { isWorkspaceRootAgent } from "@/subagents/policies";
import { getSubagentActivityIndex, type SubagentActivity } from "./subagent-activity";
import {
  deriveSidebarStateBucket,
  getSidebarStateBucketPriority,
  type SidebarStateBucket,
} from "./sidebar-agent-state";

export interface WorkspaceAgentActivity {
  agentId: string;
  status: SidebarStateBucket;
  enteredAt: Date | null;
}

function workspaceAgentStatus(agent: Agent): Agent["status"] {
  if (agent.turn.phase === "open") return "running";
  return agent.status === "running" ? "idle" : agent.status;
}

function workspaceRootActivity(input: {
  agent: Agent;
  subagentActivity: SubagentActivity;
}): SidebarStateBucket {
  return deriveSidebarStateBucket({
    status: workspaceAgentStatus(input.agent),
    pendingPermissionCount: input.agent.pendingPermissions.length,
    requiresAttention: input.agent.requiresAttention,
    attentionReason: input.agent.attentionReason,
    subagentActivity: input.subagentActivity,
  });
}

export function buildWorkspaceAgentActivityIndex(
  agents: ReadonlyMap<string, Agent>,
  previous?: ReadonlyMap<string, WorkspaceAgentActivity>,
): Map<string, WorkspaceAgentActivity> {
  const activityByWorkspaceId = new Map<string, WorkspaceAgentActivity>();
  // One derived index for the whole pass, shared with any concurrent panel selector over the
  // same directory reference.
  const { descendantsByAgentId } = getSubagentActivityIndex(agents);

  for (const agent of agents.values()) {
    const parentAgent = agent.parentAgentId ? agents.get(agent.parentAgentId) : undefined;
    if (agent.archivedAt || !agent.workspaceId || !isWorkspaceRootAgent(agent, parentAgent)) {
      continue;
    }

    const status = workspaceRootActivity({
      agent,
      subagentActivity: descendantsByAgentId.get(agent.id) ?? "none",
    });
    const enteredAt = agent.attentionTimestamp ?? agent.updatedAt;

    // A workspace can hold several root agents. Fold them by urgency the way the daemon's
    // aggregate does, newest first only within a bucket: a newer done root must not hide an
    // older one waiting on a subagent, which the server cannot see.
    const existing = activityByWorkspaceId.get(agent.workspaceId);
    if (existing && !shouldReplaceWorkspaceActivity({ existing, status, enteredAt })) {
      continue;
    }

    activityByWorkspaceId.set(agent.workspaceId, {
      agentId: agent.id,
      status,
      enteredAt,
    });
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

function shouldReplaceWorkspaceActivity(input: {
  existing: WorkspaceAgentActivity;
  status: SidebarStateBucket;
  enteredAt: Date;
}): boolean {
  const existingPriority = getSidebarStateBucketPriority(input.existing.status);
  const nextPriority = getSidebarStateBucketPriority(input.status);
  if (nextPriority !== existingPriority) {
    return nextPriority < existingPriority;
  }
  return !input.existing.enteredAt || input.enteredAt > input.existing.enteredAt;
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
