import type { Agent } from "@/stores/session-store";
import { normalizeWorkspaceIdentity } from "@/utils/workspace-identity";

function normalizeWorkspaceId(value: string | null | undefined): string {
  return normalizeWorkspaceIdentity(value) ?? "";
}

export interface WorkspaceAgentVisibility {
  activeAgentIds: Set<string>;
  knownAgentIds: Set<string>;
}

export function deriveWorkspaceAgentVisibility(input: {
  sessionAgents: Map<string, Agent> | undefined;
  workspaceId: string;
}): WorkspaceAgentVisibility {
  const { sessionAgents, workspaceId } = input;
  const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
  if (!sessionAgents || !workspaceId) {
    return {
      activeAgentIds: new Set<string>(),
      knownAgentIds: new Set<string>(),
    };
  }

  const activeAgentIds = new Set<string>();
  const knownAgentIds = new Set<string>();
  for (const agent of sessionAgents.values()) {
    if (normalizeWorkspaceId(agent.cwd) !== normalizedWorkspaceId) {
      continue;
    }
    knownAgentIds.add(agent.id);
    if (!agent.archivedAt) {
      activeAgentIds.add(agent.id);
    }
  }

  return { activeAgentIds, knownAgentIds };
}

export function workspaceAgentVisibilityEqual(
  a: WorkspaceAgentVisibility,
  b: WorkspaceAgentVisibility,
): boolean {
  return (
    setsEqual(a.activeAgentIds, b.activeAgentIds) && setsEqual(a.knownAgentIds, b.knownAgentIds)
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

// Prune agent tabs that are unknown (deleted) or archived.
// Archived agents get pruned so that archiving on one client closes the tab on all clients.
export function shouldPruneWorkspaceAgentTab(input: {
  agentId: string;
  agentsHydrated: boolean;
  knownAgentIds: Set<string>;
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
