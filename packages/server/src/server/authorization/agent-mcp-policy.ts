import type { ProviderPaseoToolsPolicy } from "@getpaseo/protocol/provider-config";
import type { DaemonCredentialPrincipal } from "../auth.js";
import type { DaemonPermission } from "./index.js";

/**
 * Agent MCP tools that need more than `workspace.write`. A scoped credential must
 * hold `workspace.write` to use the endpoint at all; these tools are hidden unless
 * it also holds the listed permission, matching the WebSocket RPC classification.
 */
const AGENT_MCP_TOOL_PERMISSIONS: Readonly<Record<string, DaemonPermission>> = {
  create_schedule: "automation.manage",
  update_schedule: "automation.manage",
  delete_schedule: "automation.manage",
  pause_schedule: "automation.manage",
  resume_schedule: "automation.manage",
  run_schedule_once: "automation.manage",
  create_heartbeat: "automation.manage",
  delete_heartbeat: "automation.manage",
  create_workspace: "workspace.manage",
  archive_workspace: "workspace.manage",
  rename_workspace: "workspace.manage",
};

export type AgentMcpAccess =
  | { kind: "owner" }
  | { kind: "denied" }
  | { kind: "scoped"; toolPolicy: ProviderPaseoToolsPolicy; deniedModes: readonly string[] };

export function resolveAgentMcpAccess(principal: DaemonCredentialPrincipal): AgentMcpAccess {
  if (principal.principalId === "owner") return { kind: "owner" };
  if (!principal.permissions.includes("workspace.write")) return { kind: "denied" };
  const disabledTools = Object.entries(AGENT_MCP_TOOL_PERMISSIONS)
    .filter(([, permission]) => !principal.permissions.includes(permission))
    .map(([tool]) => tool);
  return {
    kind: "scoped",
    toolPolicy: { disabledTools },
    deniedModes: principal.deniedModes ?? [],
  };
}

export function mergePaseoToolPolicies(
  base: ProviderPaseoToolsPolicy | undefined,
  restriction: ProviderPaseoToolsPolicy | undefined,
): ProviderPaseoToolsPolicy | undefined {
  if (!restriction) return base;
  if (!base) return restriction;
  return {
    ...base,
    disabledTools: [...(base.disabledTools ?? []), ...(restriction.disabledTools ?? [])],
  };
}
