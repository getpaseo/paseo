import { getOpenAgentTabLabel } from "@getpaseo/protocol/agent-labels";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";

export interface OpenAgentTabAgent {
  id: string;
  parentAgentId: string | null;
  workspaceId?: string;
}

export interface OpenAgentTabDeps<T> {
  getAgent: (
    agentId: string,
  ) => OpenAgentTabAgent | null | undefined | Promise<OpenAgentTabAgent | null | undefined>;
  getClientId: () => Promise<string>;
  markOpen: (agentId: string, label: string) => Promise<void>;
  open: () => T;
}

function isSameWorkspaceChild(
  agent: OpenAgentTabAgent,
  parent: OpenAgentTabAgent | null | undefined,
): boolean {
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
  const agent = await deps.getAgent(agentId);
  const parent = agent?.parentAgentId ? await deps.getAgent(agent.parentAgentId) : null;
  if (agent && isSameWorkspaceChild(agent, parent)) {
    const clientId = await deps.getClientId();
    await deps.markOpen(agentId, getOpenAgentTabLabel(clientId));
  }
  return deps.open();
}
