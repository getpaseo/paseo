export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";
export const EXTERNAL_WAIT_ID_LABEL = "paseo.external-wait-id";

export interface AgentLabelSource {
  labels?: Record<string, unknown> | null;
}

export function getParentAgentIdFromLabels(labels: Record<string, unknown> | null | undefined) {
  const parentAgentId = labels?.[PARENT_AGENT_ID_LABEL];
  return typeof parentAgentId === "string" && parentAgentId.trim().length > 0
    ? parentAgentId.trim()
    : null;
}

export function getExternalWaitIdFromLabels(labels: Record<string, unknown> | null | undefined) {
  const waitId = labels?.[EXTERNAL_WAIT_ID_LABEL];
  return typeof waitId === "string" && waitId.trim().length > 0 ? waitId.trim() : null;
}

export function isDelegatedAgent(agent: AgentLabelSource): boolean {
  return getParentAgentIdFromLabels(agent.labels) !== null;
}
