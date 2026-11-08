import type { AgentAddress } from "./addresses.js";
export const PARENT_SERVER_ID_LABEL = "paseo.parent-server-id";
export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";
/** Set on a chat started with a team from daemon.teams; the value is the team name. */
export const AGENT_TEAM_LABEL = "paseo.team";
/** Free-form role a team chat sets on a helper through create_agent labels. */
export const AGENT_TEAM_ROLE_LABEL = "paseo.team-role";
const OPEN_AGENT_TAB_LABEL_PREFIX = "paseo.open-agent-tab.";

export function getOpenAgentTabLabel(clientId: string): string {
  return `${OPEN_AGENT_TAB_LABEL_PREFIX}${clientId}`;
}

export function isOpenAgentTabLabel(label: string): boolean {
  return label.startsWith(OPEN_AGENT_TAB_LABEL_PREFIX);
}

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

export function hasOpenAgentTab(labels: Record<string, unknown> | null | undefined): boolean {
  return Object.entries(labels ?? {}).some(
    ([label, value]) => isOpenAgentTabLabel(label) && value === "true",
  );
}

// Absent parent server label means the same host.
export function getParentAddressFromLabels(
  labels: Record<string, unknown> | null | undefined,
  serverId: string,
): AgentAddress | null {
  const agentId = getParentAgentIdFromLabels(labels);
  if (!agentId) return null;
  const parentServerId = labels?.[PARENT_SERVER_ID_LABEL];
  return {
    serverId:
      typeof parentServerId === "string" && parentServerId.trim()
        ? parentServerId.trim()
        : serverId,
    agentId,
  };
}
export function parentAddressLabels(parent: AgentAddress): Record<string, string> {
  return { [PARENT_AGENT_ID_LABEL]: parent.agentId, [PARENT_SERVER_ID_LABEL]: parent.serverId };
}
