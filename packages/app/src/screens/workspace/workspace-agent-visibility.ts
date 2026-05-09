import type { Agent } from "@/stores/session-store";
import { shouldAutoOpenAgentTab } from "@/subagents/policies";
import { normalizeWorkspacePath } from "@/utils/workspace-identity";

function normalizeWorkspaceId(value: string | null | undefined): string {
  return normalizeWorkspacePath(value) ?? "";
}

export interface WorkspaceAgentVisibility {
  activeAgentIds: Set<string>;
  autoOpenAgentIds: Set<string>;
  knownAgentIds: Set<string>;
}

export function deriveWorkspaceAgentVisibility(input: {
  sessionAgents: Map<string, Agent> | undefined;
  agentDetails?: Map<string, Agent> | undefined;
  workspaceDirectory: string | null | undefined;
}): WorkspaceAgentVisibility {
  const { sessionAgents, agentDetails, workspaceDirectory } = input;
  const normalizedWorkspaceDirectory = normalizeWorkspaceId(workspaceDirectory);
  if ((!sessionAgents && !agentDetails) || !normalizedWorkspaceDirectory) {
    return {
      activeAgentIds: new Set<string>(),
      autoOpenAgentIds: new Set<string>(),
      knownAgentIds: new Set<string>(),
    };
  }

  const activeAgentIds = new Set<string>();
  const autoOpenAgentIds = new Set<string>();
  const knownAgentIds = new Set<string>();
  for (const agent of sessionAgents?.values() ?? []) {
    if (normalizeWorkspaceId(agent.cwd) !== normalizedWorkspaceDirectory) {
      continue;
    }
    knownAgentIds.add(agent.id);
    if (!agent.archivedAt) {
      activeAgentIds.add(agent.id);
      if (shouldAutoOpenAgentTab(agent)) {
        autoOpenAgentIds.add(agent.id);
      }
    }
  }
  for (const agent of agentDetails?.values() ?? []) {
    if (normalizeWorkspaceId(agent.cwd) !== normalizedWorkspaceDirectory) {
      continue;
    }
    knownAgentIds.add(agent.id);
  }

  return { activeAgentIds, autoOpenAgentIds, knownAgentIds };
}

export function workspaceAgentVisibilityEqual(
  a: WorkspaceAgentVisibility,
  b: WorkspaceAgentVisibility,
): boolean {
  return (
    setsEqual(a.activeAgentIds, b.activeAgentIds) &&
    setsEqual(a.autoOpenAgentIds, b.autoOpenAgentIds) &&
    setsEqual(a.knownAgentIds, b.knownAgentIds)
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
