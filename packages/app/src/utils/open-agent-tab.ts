import { getOpenAgentTabLabel } from "@getpaseo/protocol/agent-labels";
import type { Agent } from "@/stores/session-store";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";

interface OpenAgentTabDeps<T> {
  getAgent: (agentId: string) => Agent | null | undefined;
  getClientId: () => Promise<string>;
  markOpen: (agentId: string, label: string) => Promise<void>;
  open: () => T;
}

function isSameWorkspaceChild(agent: Agent, parent: Agent | null | undefined): boolean {
  if (!agent.parentAgentId) {
    return false;
  }
  if (!parent) {
    return true;
  }
  const childWorkspaceId = normalizeWorkspaceOpaqueId(agent.workspaceId);
  const parentWorkspaceId = normalizeWorkspaceOpaqueId(parent.workspaceId);
  return !childWorkspaceId || !parentWorkspaceId || childWorkspaceId === parentWorkspaceId;
}

export async function openAgentTab<T>(agentId: string, deps: OpenAgentTabDeps<T>): Promise<T> {
  const agent = deps.getAgent(agentId);
  const parent = agent?.parentAgentId ? deps.getAgent(agent.parentAgentId) : null;
  if (agent && isSameWorkspaceChild(agent, parent)) {
    const clientId = await deps.getClientId();
    await deps.markOpen(agentId, getOpenAgentTabLabel(clientId));
  }
  return deps.open();
}
