import type { Agent, SessionState, useSessionStore } from "@/stores/session-store";
import type { WorkspaceTab } from "@/workspace-tabs/model";

const NO_PENDING_AGENT_IDS: ReadonlySet<string> = new Set();

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

type SessionStoreSnapshot = ReturnType<typeof useSessionStore.getState>;

// Session-store selectors run on every store update, including stream ticks that leave the agent
// maps untouched. Reuse the previous key until one of those maps changes, so the hook's
// subscriber stays O(1) per update and re-renders only when the set of tabs needing the label
// changes.
export function createAgentTabsNeedingOpenLabelKeySelector(input: {
  serverId: string;
  tabs: WorkspaceTab[];
  label: string;
}): (state: SessionStoreSnapshot) => string {
  let previousAgents: SessionState["agents"] | undefined;
  let previousAgentDetails: SessionState["agentDetails"] | undefined;
  let previousKey: string | null = null;

  return (state) => {
    const session = state.sessions[input.serverId];
    const agents = session?.agents;
    const agentDetails = session?.agentDetails;
    if (
      previousKey !== null &&
      agents === previousAgents &&
      agentDetails === previousAgentDetails
    ) {
      return previousKey;
    }
    previousAgents = agents;
    previousAgentDetails = agentDetails;
    previousKey = getAgentTabsNeedingOpenLabel({
      tabs: input.tabs,
      getAgent: (agentId) => agents?.get(agentId) ?? agentDetails?.get(agentId),
      label: input.label,
      pendingAgentIds: NO_PENDING_AGENT_IDS,
    }).join("\n");
    return previousKey;
  };
}
