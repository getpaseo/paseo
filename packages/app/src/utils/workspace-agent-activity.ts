import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import { isWorkspaceRootAgent } from "@/subagents/policies";
import { deriveSidebarStateBucket } from "./sidebar-agent-state";

export interface WorkspaceAgentActivity {
  agentId: string;
  status: WorkspaceDescriptor["status"];
  enteredAt: Date | null;
  /** Earliest time any root agent of the workspace will wake on its own. */
  nextWakeAt: string | null;
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
  const nextWakeAtByWorkspaceId = new Map<string, string>();

  for (const agent of agents.values()) {
    const parentAgent = agent.parentAgentId ? agents.get(agent.parentAgentId) : undefined;
    if (
      agent.archivedAt ||
      agent.background ||
      !agent.workspaceId ||
      !isWorkspaceRootAgent(agent, parentAgent)
    ) {
      continue;
    }

    keepEarliestWake(nextWakeAtByWorkspaceId, agent.workspaceId, agent.backgroundWork?.nextWakeAt);

    const enteredAt = agent.attentionTimestamp ?? agent.updatedAt;
    const latestActivityAt = latestActivityAtByWorkspaceId.get(agent.workspaceId);
    if (latestActivityAt && enteredAt <= latestActivityAt) {
      continue;
    }
    latestActivityAtByWorkspaceId.set(agent.workspaceId, enteredAt);

    const status = deriveSidebarStateBucket({
      status: workspaceAgentStatus(agent),
      backgroundWork: agent.backgroundWork,
      pendingPermissionCount: agent.pendingPermissions.length,
      requiresAttention: agent.requiresAttention,
      attentionReason: agent.attentionReason,
    });
    activityByWorkspaceId.set(agent.workspaceId, {
      agentId: agent.id,
      status,
      enteredAt,
      nextWakeAt: null,
    });
  }

  for (const [workspaceId, activity] of activityByWorkspaceId) {
    activity.nextWakeAt = nextWakeAtByWorkspaceId.get(workspaceId) ?? null;
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

function keepEarliestWake(
  wakes: Map<string, string>,
  workspaceId: string,
  nextWakeAt: string | undefined,
): void {
  if (!nextWakeAt) return;
  const earliest = wakes.get(workspaceId);
  if (!earliest || Date.parse(nextWakeAt) < Date.parse(earliest)) {
    wakes.set(workspaceId, nextWakeAt);
  }
}

function isSameActivity(previous: WorkspaceAgentActivity, next: WorkspaceAgentActivity): boolean {
  return (
    previous.agentId === next.agentId &&
    previous.status === next.status &&
    previous.nextWakeAt === next.nextWakeAt
  );
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
