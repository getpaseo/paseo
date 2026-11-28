import type { MutableDaemonConfig, MutableDaemonToolGroups } from "@getpaseo/protocol/messages";
import { DEFAULT_DAEMON_TOOL_GROUPS, type BuiltInToolGroup } from "@getpaseo/protocol/tool-groups";

export type ResolvedDaemonToolGroups = Record<BuiltInToolGroup, boolean>;

export interface ResolvedDaemonToolsConfig {
  enabled: boolean;
  groups: ResolvedDaemonToolGroups;
}

export const VOICE_REQUIRES_TOOLS_REASON_CODE = "tools_disabled" as const;
export const VOICE_REQUIRES_TOOLS_MESSAGE =
  "Voice mode requires agent tools. Turn on Enable tools in Settings > Tools.";

export function normalizeDaemonToolGroups(
  groups?: MutableDaemonToolGroups,
  legacyBrowserEnabled?: boolean,
): ResolvedDaemonToolGroups {
  return {
    orchestration: groups?.orchestration ?? DEFAULT_DAEMON_TOOL_GROUPS.orchestration,
    schedules: groups?.schedules ?? DEFAULT_DAEMON_TOOL_GROUPS.schedules,
    changeRequests: groups?.changeRequests ?? DEFAULT_DAEMON_TOOL_GROUPS.changeRequests,
    // COMPAT(legacyBrowserToolsConfig): added in v0.18.2, remove after 2027-06-01.
    browser: groups?.browser ?? legacyBrowserEnabled ?? DEFAULT_DAEMON_TOOL_GROUPS.browser,
  };
}

export function resolveDaemonToolsFromMutableConfig(
  config: Pick<MutableDaemonConfig, "tools" | "mcp" | "browserTools">,
): ResolvedDaemonToolsConfig {
  // COMPAT(legacyToolsConfig): added in v0.18.2, remove after 2027-06-01.
  const enabled =
    config.tools?.enabled ??
    (config.mcp.enabled !== false && config.mcp.injectIntoAgents !== false);
  const groups = normalizeDaemonToolGroups(config.tools?.groups, config.browserTools?.enabled);
  return { enabled, groups };
}

export function resolveDaemonToolsFromConfigOptions(options: {
  tools?: { enabled?: boolean; groups?: MutableDaemonToolGroups };
  mcpEnabled?: boolean;
  mcpInjectIntoAgents?: boolean;
  browserToolsEnabled?: boolean;
}): ResolvedDaemonToolsConfig {
  // COMPAT(legacyToolsConfig): added in v0.18.2, remove after 2027-06-01.
  const enabled =
    options.tools?.enabled ??
    (options.mcpEnabled !== false && options.mcpInjectIntoAgents !== false);
  const groups = normalizeDaemonToolGroups(options.tools?.groups, options.browserToolsEnabled);
  return { enabled, groups };
}
