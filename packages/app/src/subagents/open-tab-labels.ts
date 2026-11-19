import type { Agent } from "@/stores/session-store";
import type { WorkspaceTab } from "@/workspace-tabs/model";

export function getAgentTabsNeedingOpenLabel(input: {
  tabs: WorkspaceTab[];
  getAgent: (agentId: string) => Agent | null | undefined;
  label: string;
  pendingAgentIds: ReadonlySet<string>;
}): string[] {
  const agentIds = new Set<string>();
  for (const tab of input.tabs) {
    if (tab.target.kind !== "agent") {
      continue;
    }
    const agent = input.getAgent(tab.target.agentId);
    if (
      agent?.parentAgentId &&
      agent.labels[input.label] !== "true" &&
      !input.pendingAgentIds.has(agent.id)
    ) {
      agentIds.add(agent.id);
    }
  }
  return [...agentIds];
}

interface OpenTabAgentSource {
  sessions: Record<
    string,
    { agents: ReadonlyMap<string, Agent>; agentDetails: ReadonlyMap<string, Agent> } | undefined
  >;
}

/**
 * The agents behind the given open tabs, in tab order. Compared element by element, this changes
 * only when one of those agents changes, not on updates to other agents on the host.
 */
export function selectOpenTabAgents(
  state: OpenTabAgentSource,
  input: { serverId: string; agentIds: readonly string[] },
): (Agent | null)[] {
  const session = state.sessions[input.serverId];
  return input.agentIds.map(
    (agentId) => session?.agents.get(agentId) ?? session?.agentDetails.get(agentId) ?? null,
  );
}
