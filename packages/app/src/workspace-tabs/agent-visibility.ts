import type { Agent } from "@/stores/session-store";
import type { WorkspaceTabSnapshot } from "@/stores/workspace-layout-actions";
import { isWorkspaceRootAgent } from "@/subagents/policies";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";

export interface WorkspaceAgentVisibility {
  activeAgentIds: Set<string>;
  autoOpenAgentIds: Set<string>;
  otherWorkspaceAgentIds: Set<string>;
}

function agentBelongsToWorkspace(agent: Agent, workspaceId: string): boolean {
  return normalizeWorkspaceOpaqueId(agent.workspaceId) === workspaceId;
}

export function deriveWorkspaceAgentVisibility(input: {
  sessionAgents: Map<string, Agent> | undefined;
  agentDetails?: Map<string, Agent> | undefined;
  workspaceId: string | null | undefined;
}): WorkspaceAgentVisibility {
  const { sessionAgents, agentDetails } = input;
  const workspaceId = normalizeWorkspaceOpaqueId(input.workspaceId);
  if ((!sessionAgents && !agentDetails) || !workspaceId) {
    return {
      activeAgentIds: new Set<string>(),
      autoOpenAgentIds: new Set<string>(),
      otherWorkspaceAgentIds: new Set<string>(),
    };
  }

  const activeAgentIds = new Set<string>();
  const autoOpenAgentIds = new Set<string>();
  const otherWorkspaceAgentIds = new Set<string>();
  const agentsById = new Map<string, Agent>([
    ...(agentDetails?.entries() ?? []),
    ...(sessionAgents?.entries() ?? []),
  ]);
  for (const agent of agentsById.values()) {
    const ownerId = normalizeWorkspaceOpaqueId(agent.workspaceId);
    if (ownerId && ownerId !== workspaceId) {
      otherWorkspaceAgentIds.add(agent.id);
    }
  }
  for (const agent of sessionAgents?.values() ?? []) {
    if (!agentBelongsToWorkspace(agent, workspaceId)) {
      continue;
    }
    if (!agent.archivedAt) {
      activeAgentIds.add(agent.id);
      const parentAgent = agent.parentAgentId ? agentsById.get(agent.parentAgentId) : undefined;
      if (isWorkspaceRootAgent(agent, parentAgent)) {
        autoOpenAgentIds.add(agent.id);
      }
    }
  }
  return { activeAgentIds, autoOpenAgentIds, otherWorkspaceAgentIds };
}

export function buildWorkspaceTabSnapshot(input: {
  agentVisibility: WorkspaceAgentVisibility;
  agentsHydrated: boolean;
  terminalsHydrated: boolean;
  knownTerminalIds: Iterable<string>;
  standaloneTerminalIds: Iterable<string>;
  hasActivePendingTerminalCreate: boolean;
  hasActivePendingDraftCreate: boolean;
}): WorkspaceTabSnapshot {
  return {
    agentsHydrated: input.agentsHydrated,
    terminalsHydrated: input.terminalsHydrated,
    activeAgentIds: input.agentVisibility.activeAgentIds,
    autoOpenAgentIds: input.agentVisibility.autoOpenAgentIds,
    otherWorkspaceAgentIds: input.agentVisibility.otherWorkspaceAgentIds,
    knownTerminalIds: input.knownTerminalIds,
    standaloneTerminalIds: input.standaloneTerminalIds,
    hasActivePendingTerminalCreate: input.hasActivePendingTerminalCreate,
    hasActivePendingDraftCreate: input.hasActivePendingDraftCreate,
  };
}

export function workspaceAgentVisibilityEqual(
  a: WorkspaceAgentVisibility,
  b: WorkspaceAgentVisibility,
): boolean {
  return (
    setsEqual(a.activeAgentIds, b.activeAgentIds) &&
    setsEqual(a.autoOpenAgentIds, b.autoOpenAgentIds) &&
    setsEqual(a.otherWorkspaceAgentIds, b.otherWorkspaceAgentIds)
  );
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const item of a) {
    if (!b.has(item)) {
      return false;
    }
  }
  return true;
}

// Prune agent tabs that are no longer active once agents are hydrated.
// Archived agents get pruned so that archiving on one client closes the tab on all clients.
export function shouldPruneWorkspaceAgentTab(input: {
  agentId: string;
  agentsHydrated: boolean;
  activeAgentIds: Set<string>;
}): boolean {
  if (!input.agentId.trim()) {
    return false;
  }
  if (!input.agentsHydrated) {
    return false;
  }
  return !input.activeAgentIds.has(input.agentId);
}
