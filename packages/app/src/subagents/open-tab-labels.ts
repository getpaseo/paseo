import type { Agent, SessionState } from "@/stores/session-store";
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

/**
 * Store selector form: the open tabs still needing the label, joined into a string so a
 * subscriber re-renders only when that set changes, not on every agent update.
 */
export function selectAgentTabsNeedingOpenLabelKey(input: {
  session: Pick<SessionState, "agents" | "agentDetails"> | undefined;
  tabs: WorkspaceTab[];
  label: string;
  pendingAgentIds: ReadonlySet<string>;
}): string {
  const { session } = input;
  if (!session) return "";
  return getAgentTabsNeedingOpenLabel({
    tabs: input.tabs,
    getAgent: (agentId) => session.agents.get(agentId) ?? session.agentDetails.get(agentId),
    label: input.label,
    pendingAgentIds: input.pendingAgentIds,
  }).join("\n");
}
