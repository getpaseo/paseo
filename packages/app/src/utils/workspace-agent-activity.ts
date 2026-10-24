import type { ProviderSubagentDescriptorPayload } from "@getpaseo/protocol/messages";
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
  providerSubagents?: Iterable<
    Pick<ProviderSubagentDescriptorPayload, "parentAgentId" | "status" | "updatedAt">
  >,
): Map<string, WorkspaceAgentActivity> {
  const activityByWorkspaceId = new Map<string, WorkspaceAgentActivity>();
  const latestActivityAtByWorkspaceId = new Map<string, Date>();

  for (const agent of agents.values()) {
    const parentAgent = agent.parentAgentId ? agents.get(agent.parentAgentId) : undefined;
    if (agent.archivedAt || !agent.workspaceId || !isWorkspaceRootAgent(agent, parentAgent)) {
      continue;
    }

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

  rollUpRunningDescendantWorkspaces(agents, activityByWorkspaceId, providerSubagents);

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

// A running descendant marks every ancestor workspace running, not just the
// workspace it lives in. Same-workspace children land on the shared workspace
// like the daemon's contribution; children in another workspace (which count
// as their own workspace root) also roll up to the ancestor workspaces so a
// subagent keeps the parent's workspace spinning. Running never overrides
// needs_input or failed.
function rollUpRunningDescendantWorkspaces(
  agents: ReadonlyMap<string, Agent>,
  activityByWorkspaceId: Map<string, WorkspaceAgentActivity>,
  providerSubagents?: Iterable<
    Pick<ProviderSubagentDescriptorPayload, "parentAgentId" | "status" | "updatedAt">
  >,
): void {
  const markAncestorWorkspacesRunning = (first: Agent | undefined, enteredAt: Date) => {
    let hops = 0;
    for (
      let ancestor = first;
      ancestor && hops < 9;
      ancestor = ancestor.parentAgentId ? agents.get(ancestor.parentAgentId) : undefined
    ) {
      hops += 1;
      if (!ancestor.workspaceId) continue;
      const existing = activityByWorkspaceId.get(ancestor.workspaceId);
      if (existing && existing.status !== "attention" && existing.status !== "done") continue;
      activityByWorkspaceId.set(ancestor.workspaceId, {
        agentId: ancestor.id,
        status: "running",
        enteredAt,
      });
    }
  };

  for (const agent of agents.values()) {
    if (agent.archivedAt || !agent.workspaceId || !agent.parentAgentId) {
      continue;
    }
    if (agent.status !== "running" && agent.turn.phase !== "open") {
      continue;
    }
    markAncestorWorkspacesRunning(agents.get(agent.parentAgentId), agent.updatedAt);
  }
  if (providerSubagents) {
    for (const subagent of providerSubagents) {
      if (subagent.status !== "running") continue;
      markAncestorWorkspacesRunning(
        agents.get(subagent.parentAgentId),
        new Date(subagent.updatedAt),
      );
    }
  }
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
