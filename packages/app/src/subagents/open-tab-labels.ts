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
