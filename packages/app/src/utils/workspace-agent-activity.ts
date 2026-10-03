import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import { isWorkspaceRootAgent } from "@/subagents/policies";
import { deriveSidebarStateBucket } from "./sidebar-agent-state";

export interface WorkspaceAgentActivity {
  agentId: string;
  status: WorkspaceDescriptor["status"];
  enteredAt: Date | null;
  /**
   * Most recent activity across the workspace's root agents, independent of which agent currently
   * holds the status bucket. Backs recency ordering in the sidebar.
   */
  lastActivityAt: Date | null;
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
  const latestActivityAtByWorkspaceId = new Map<string, Date>();
  // Recency reads `lastActivityAt` while the status bucket reads `attentionTimestamp ??
  // updatedAt`: they answer different questions, so one index pass keeps two timestamps.
  const latestRecencyAtByWorkspaceId = new Map<string, Date>();

  for (const agent of agents.values()) {
    accumulateWorkspaceAgentActivity(agent, agents, {
      activityByWorkspaceId,
      latestActivityAtByWorkspaceId,
      latestRecencyAtByWorkspaceId,
    });
  }

  for (const [workspaceId, activity] of activityByWorkspaceId) {
    activity.lastActivityAt = latestRecencyAtByWorkspaceId.get(workspaceId) ?? null;
    const previousActivity = previous?.get(workspaceId);
    if (
      previousActivity?.agentId === activity.agentId &&
      previousActivity.status === activity.status &&
      previousActivity.lastActivityAt?.getTime() === activity.lastActivityAt?.getTime()
    ) {
      activityByWorkspaceId.set(workspaceId, previousActivity);
    }
  }

  if (previous && areWorkspaceAgentActivityIndexesIdentical(previous, activityByWorkspaceId)) {
    return previous instanceof Map ? previous : new Map(previous);
  }
  return activityByWorkspaceId;
}

function accumulateWorkspaceAgentActivity(
  agent: Agent,
  agents: ReadonlyMap<string, Agent>,
  index: {
    activityByWorkspaceId: Map<string, WorkspaceAgentActivity>;
    latestActivityAtByWorkspaceId: Map<string, Date>;
    latestRecencyAtByWorkspaceId: Map<string, Date>;
  },
): void {
  const parentAgent = agent.parentAgentId ? agents.get(agent.parentAgentId) : undefined;
  if (agent.archivedAt || !agent.workspaceId || !isWorkspaceRootAgent(agent, parentAgent)) {
    return;
  }

  const latestRecencyAt = index.latestRecencyAtByWorkspaceId.get(agent.workspaceId);
  if (!latestRecencyAt || agent.lastActivityAt > latestRecencyAt) {
    index.latestRecencyAtByWorkspaceId.set(agent.workspaceId, agent.lastActivityAt);
  }

  const enteredAt = agent.attentionTimestamp ?? agent.updatedAt;
  const latestActivityAt = index.latestActivityAtByWorkspaceId.get(agent.workspaceId);
  if (latestActivityAt && enteredAt <= latestActivityAt) {
    return;
  }
  index.latestActivityAtByWorkspaceId.set(agent.workspaceId, enteredAt);

  const status = deriveSidebarStateBucket({
    status: workspaceAgentStatus(agent),
    pendingPermissionCount: agent.pendingPermissions.length,
    requiresAttention: agent.requiresAttention,
    attentionReason: agent.attentionReason,
  });
  index.activityByWorkspaceId.set(agent.workspaceId, {
    agentId: agent.id,
    status,
    enteredAt,
    lastActivityAt: null,
  });
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
