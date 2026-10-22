import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import { isWorkspaceRootAgent } from "@/subagents/policies";
import { deriveSidebarStateBucket } from "./sidebar-agent-state";

export interface WorkspaceAgentActivity {
  agentId: string;
  status: WorkspaceDescriptor["status"];
  enteredAt: Date | null;
  lastStartedAt?: Date | null;
  hasRunningAgent?: boolean;
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
  const latestStartByWorkspaceId = new Map<string, Date>();
  const runningWorkspaces = new Set<string>();

  for (const agent of agents.values()) {
    const parentAgent = agent.parentAgentId ? agents.get(agent.parentAgentId) : undefined;
    if (agent.archivedAt || !agent.workspaceId || !isWorkspaceRootAgent(agent, parentAgent)) {
      continue;
    }

    // User submissions survive turn completion and cold hydration. Assistant output
    // must not advance start-based sorting.
    recordLatestTimestamp(latestStartByWorkspaceId, agent.workspaceId, agent.lastUserMessageAt);
    if (workspaceAgentStatus(agent) === "running") runningWorkspaces.add(agent.workspaceId);

    const enteredAt = agent.attentionTimestamp ?? agent.updatedAt;
    const latestActivityAt = latestActivityAtByWorkspaceId.get(agent.workspaceId);
    if (latestActivityAt && enteredAt <= latestActivityAt) {
      continue;
    }
    latestActivityAtByWorkspaceId.set(agent.workspaceId, enteredAt);

    const status = deriveSidebarStateBucket({
      status: workspaceAgentStatus(agent),
      pendingPermissionCount: agent.pendingPermissions.length,
      requiresAttention: agent.requiresAttention,
      attentionReason: agent.attentionReason,
    });
    activityByWorkspaceId.set(agent.workspaceId, {
      agentId: agent.id,
      status,
      enteredAt,
    });
  }

  for (const [workspaceId, activity] of activityByWorkspaceId) {
    activity.lastStartedAt = latestStartByWorkspaceId.get(workspaceId) ?? null;
    activity.hasRunningAgent = runningWorkspaces.has(workspaceId);
    activityByWorkspaceId.set(
      workspaceId,
      preserveWorkspaceStatusEntry(activity, previous?.get(workspaceId)),
    );
  }

  if (previous && areWorkspaceAgentActivityIndexesIdentical(previous, activityByWorkspaceId)) {
    return previous instanceof Map ? previous : new Map(previous);
  }
  return activityByWorkspaceId;
}

function recordLatestTimestamp(
  index: Map<string, Date>,
  workspaceId: string,
  value: Date | null,
): void {
  const previous = index.get(workspaceId);
  if (value && (!previous || value > previous)) index.set(workspaceId, value);
}

function preserveWorkspaceStatusEntry(
  activity: WorkspaceAgentActivity,
  previous: WorkspaceAgentActivity | undefined,
): WorkspaceAgentActivity {
  if (previous?.agentId !== activity.agentId || previous.status !== activity.status)
    return activity;
  if (previous.lastStartedAt?.getTime() === activity.lastStartedAt?.getTime())
    activity.lastStartedAt = previous.lastStartedAt;
  if (
    previous.lastStartedAt === activity.lastStartedAt &&
    previous.hasRunningAgent === activity.hasRunningAgent
  )
    return previous;
  return { ...activity, enteredAt: previous.enteredAt };
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
