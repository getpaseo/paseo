import type { Agent, SessionState } from "@/stores/session-store";
import type { WorkspaceTab } from "@/workspace-tabs/model";
import { getAttentionPriority } from "./agent-attention";

export function nextAttentionAgent(input: {
  sessions: Record<string, Pick<SessionState, "agents" | "workspaces">>;
  connectedServerIds: ReadonlySet<string>;
  getWorkspaceTabs: (workspaceKey: string) => WorkspaceTab[];
  current: { serverId: string; agentId: string };
}): Agent | null {
  const candidates: Agent[] = [];
  for (const [serverId, session] of Object.entries(input.sessions)) {
    if (!input.connectedServerIds.has(serverId)) continue;
    for (const agent of session.agents.values()) {
      if (!getActionableAttention(agent) || agent.archivedAt) continue;
      const workspace = agent.workspaceId && session.workspaces.get(agent.workspaceId);
      if (!workspace || workspace.archivingAt) continue;
      if (agent.parentAgentId) {
        const tabs = input.getWorkspaceTabs(`${serverId}:${workspace.id}`);
        if (!tabs.some((tab) => tab.target.kind === "agent" && tab.target.agentId === agent.id)) {
          continue;
        }
      }
      candidates.push(agent);
    }
  }
  candidates.sort((a, b) => {
    const first = getActionableAttention(a)!;
    const second = getActionableAttention(b)!;
    return (
      first.priority - second.priority ||
      first.timestamp - second.timestamp ||
      a.serverId.localeCompare(b.serverId) ||
      a.id.localeCompare(b.id)
    );
  });
  const currentIndex = candidates.findIndex(
    (agent) => agent.serverId === input.current.serverId && agent.id === input.current.agentId,
  );
  for (let offset = 1; offset <= candidates.length; offset++) {
    const agent = candidates[(currentIndex + offset) % candidates.length];
    if (agent.serverId !== input.current.serverId || agent.id !== input.current.agentId) {
      return agent;
    }
  }
  return null;
}

function getActionableAttention(agent: Agent): { priority: number; timestamp: number } | null {
  if (agent.pendingPermissions?.length) {
    return { priority: 0, timestamp: agent.updatedAt.getTime() };
  }
  if (!agent.requiresAttention) return null;
  const priority = getAttentionPriority(agent.attentionReason);
  if (priority === null) return null;
  return { priority, timestamp: agent.attentionTimestamp?.getTime() ?? Infinity };
}
