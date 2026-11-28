import {
  BUILTIN_TOOL_GROUPS,
  DEFAULT_DAEMON_TOOL_GROUPS,
  type BuiltInToolGroup,
  type MutableDaemonConfig,
  type MutableDaemonConfigPatch,
} from "@getpaseo/protocol/messages";

export type AgentToolGroupId = BuiltInToolGroup;
export type AgentToolGroupsState = Record<AgentToolGroupId, boolean>;

export const AGENT_TOOL_GROUP_ORDER: readonly AgentToolGroupId[] = BUILTIN_TOOL_GROUPS;
export const DEFAULT_AGENT_TOOL_GROUPS: AgentToolGroupsState = { ...DEFAULT_DAEMON_TOOL_GROUPS };

export interface ResolvedAgentToolsState {
  enabled: boolean;
  groups: AgentToolGroupsState;
  supportsGroupControls: boolean;
}

export function isHostAgentToolsEnabled(config: MutableDaemonConfig | null | undefined): boolean {
  if (!config) return true;
  // COMPAT(daemonToolsConfig): added in v0.18.2, remove after 2027-06-01.
  return config.tools?.enabled ?? config.mcp.injectIntoAgents !== false;
}

export function resolveAgentToolsState(input: {
  config: MutableDaemonConfig | null | undefined;
  supportsToolsConfig: boolean;
}): ResolvedAgentToolsState {
  const { config, supportsToolsConfig } = input;
  const enabled = isHostAgentToolsEnabled(config);
  const groups: AgentToolGroupsState = {
    orchestration: config?.tools?.groups?.orchestration ?? DEFAULT_AGENT_TOOL_GROUPS.orchestration,
    schedules: config?.tools?.groups?.schedules ?? DEFAULT_AGENT_TOOL_GROUPS.schedules,
    changeRequests:
      config?.tools?.groups?.changeRequests ?? DEFAULT_AGENT_TOOL_GROUPS.changeRequests,
    // COMPAT(daemonToolsConfig): added in v0.18.2, remove after 2027-06-01.
    browser: config?.tools?.groups?.browser ?? config?.browserTools.enabled === true,
  };
  return {
    enabled,
    groups,
    supportsGroupControls: supportsToolsConfig,
  };
}

export function createAgentToolsMasterPatch(input: {
  enabled: boolean;
  supportsToolsConfig: boolean;
}): MutableDaemonConfigPatch {
  if (input.supportsToolsConfig) {
    return { tools: { enabled: input.enabled } };
  }
  // COMPAT(daemonToolsConfig): added in v0.18.2, remove after 2027-06-01.
  return { mcp: { injectIntoAgents: input.enabled } };
}

export function createAgentToolGroupPatch(input: {
  group: AgentToolGroupId;
  enabled: boolean;
  supportsToolsConfig: boolean;
}): MutableDaemonConfigPatch | null {
  if (input.supportsToolsConfig) {
    return { tools: { groups: { [input.group]: input.enabled } } };
  }
  // COMPAT(daemonToolsConfig): added in v0.18.2, remove after 2027-06-01.
  if (input.group === "browser") {
    return { browserTools: { enabled: input.enabled } };
  }
  return null;
}

/**
 * Setup only sets the main switch. It never writes tool groups, so the host keeps the groups saved
 * in Settings. An unknown host state is always written.
 */
export function createOnboardingAgentToolsPatch(input: {
  enabled: boolean;
  currentEnabled: boolean | null;
  supportsToolsConfig: boolean;
}): MutableDaemonConfigPatch | null {
  if (input.currentEnabled === input.enabled) return null;
  return createAgentToolsMasterPatch(input);
}
