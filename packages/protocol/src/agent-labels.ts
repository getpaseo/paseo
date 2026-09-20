export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";
export const AUTO_OPEN_AGENT_TAB_LABEL = "paseo.auto-open-agent-tab";

export interface AgentLabelSource {
  labels?: Record<string, unknown> | null;
}

export function getParentAgentIdFromLabels(labels: Record<string, unknown> | null | undefined) {
  const parentAgentId = labels?.[PARENT_AGENT_ID_LABEL];
  return typeof parentAgentId === "string" && parentAgentId.trim().length > 0
    ? parentAgentId.trim()
    : null;
}

export function isDelegatedAgent(agent: AgentLabelSource): boolean {
  return getParentAgentIdFromLabels(agent.labels) !== null;
}

export function shouldAutoOpenAgentTab(agent: AgentLabelSource): boolean {
  return agent.labels?.[AUTO_OPEN_AGENT_TAB_LABEL] === "true";
}
