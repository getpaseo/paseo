import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import { isWorkspaceRootAgent } from "@/subagents/policies";
import { deriveSidebarStateBucket } from "./sidebar-agent-state";

export interface WorkspaceAgentActivity {
  agentId: string;
  status: WorkspaceDescriptor["status"];
  enteredAt: Date | null;
  activityAt: Date;
}

function isActiveWorkspaceRootAgent(agent: Agent, agents: ReadonlyMap<string, Agent>): boolean {
  const parentAgent = agent.parentAgentId ? agents.get(agent.parentAgentId) : undefined;
  return Boolean(
    !agent.archivedAt && agent.workspaceId && isWorkspaceRootAgent(agent, parentAgent),
  );
}

function reconcileWorkspaceAgentActivity(
  activity: WorkspaceAgentActivity,
  latestActivityAt: Date,
  previous: WorkspaceAgentActivity | undefined,
): WorkspaceAgentActivity {
  const enteredAt =
    previous?.agentId === activity.agentId && previous.status === activity.status
      ? previous.enteredAt
      : activity.enteredAt;
  if (
    previous?.agentId === activity.agentId &&
    previous.status === activity.status &&
    previous.enteredAt === enteredAt &&
    previous.activityAt.getTime() === latestActivityAt.getTime()
  ) {
    return previous;
  }
  return { ...activity, enteredAt, activityAt: latestActivityAt };
}

export function buildWorkspaceAgentActivityIndex(
  agents: ReadonlyMap<string, Agent>,
  previous?: ReadonlyMap<string, WorkspaceAgentActivity>,
): Map<string, WorkspaceAgentActivity> {
  const activityByWorkspaceId = new Map<string, WorkspaceAgentActivity>();
  const latestStatusAtByWorkspaceId = new Map<string, Date>();
  const latestActivityAtByWorkspaceId = new Map<string, Date>();

  for (const agent of agents.values()) {
    if (!isActiveWorkspaceRootAgent(agent, agents) || !agent.workspaceId) {
      continue;
    }

    const latestActivityAt = latestActivityAtByWorkspaceId.get(agent.workspaceId);
    if (!latestActivityAt || agent.lastActivityAt > latestActivityAt) {
      latestActivityAtByWorkspaceId.set(agent.workspaceId, agent.lastActivityAt);
    }

    const enteredAt = agent.attentionTimestamp ?? agent.updatedAt;
    const latestStatusAt = latestStatusAtByWorkspaceId.get(agent.workspaceId);
    if (latestStatusAt && enteredAt <= latestStatusAt) {
      continue;
    }
    latestStatusAtByWorkspaceId.set(agent.workspaceId, enteredAt);

    const status = deriveSidebarStateBucket({
      status: agent.status,
      pendingPermissionCount: agent.pendingPermissions.length,
      requiresAttention: agent.requiresAttention,
      attentionReason: agent.attentionReason,
    });
    activityByWorkspaceId.set(agent.workspaceId, {
      agentId: agent.id,
      status,
      enteredAt,
      activityAt: agent.lastActivityAt,
    });
  }

  for (const [workspaceId, activity] of activityByWorkspaceId) {
    activityByWorkspaceId.set(
      workspaceId,
      reconcileWorkspaceAgentActivity(
        activity,
        latestActivityAtByWorkspaceId.get(workspaceId) ?? activity.activityAt,
        previous?.get(workspaceId),
      ),
    );
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
