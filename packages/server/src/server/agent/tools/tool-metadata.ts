import {
  BUILTIN_TOOL_GROUPS,
  type BuiltInToolGroup,
  type DaemonPermission,
} from "@getpaseo/protocol/messages";
import type { PaseoToolGroup, PaseoToolScope } from "./types.js";

export interface PaseoToolMetadata {
  readonly group: PaseoToolGroup;
  readonly scope: PaseoToolScope;
  readonly permission: DaemonPermission;
}

const BUILTIN_TOOL_GROUP_SET: ReadonlySet<string> = new Set(BUILTIN_TOOL_GROUPS);

export function isBuiltInToolGroup(group: PaseoToolGroup): group is BuiltInToolGroup {
  return BUILTIN_TOOL_GROUP_SET.has(group);
}

export function isToolAllowedInScope(
  toolScope: PaseoToolScope,
  catalogScope: "agent" | "top-level",
): boolean {
  return toolScope === "both" || toolScope === catalogScope;
}

export const BUILTIN_TOOL_METADATA = {
  // Voice (internal session-attached)
  speak: { group: "voice", scope: "agent", permission: "workspace.write" },

  // Browser automation (opt-in group, bound to agent workspace)
  browser_list_hosts: { group: "browser", scope: "agent", permission: "workspace.read" },
  browser_list_tabs: { group: "browser", scope: "agent", permission: "workspace.read" },
  browser_new_tab: { group: "browser", scope: "agent", permission: "workspace.write" },
  browser_snapshot: { group: "browser", scope: "agent", permission: "workspace.read" },
  browser_click: { group: "browser", scope: "agent", permission: "workspace.write" },
  browser_fill: { group: "browser", scope: "agent", permission: "workspace.write" },
  browser_wait: { group: "browser", scope: "agent", permission: "workspace.read" },
  browser_type: { group: "browser", scope: "agent", permission: "workspace.write" },
  browser_keypress: { group: "browser", scope: "agent", permission: "workspace.write" },
  browser_navigate: { group: "browser", scope: "agent", permission: "workspace.write" },
  browser_back: { group: "browser", scope: "agent", permission: "workspace.write" },
  browser_forward: { group: "browser", scope: "agent", permission: "workspace.write" },
  browser_reload: { group: "browser", scope: "agent", permission: "workspace.write" },
  browser_screenshot: { group: "browser", scope: "agent", permission: "workspace.read" },
  browser_upload: { group: "browser", scope: "agent", permission: "workspace.write" },
  browser_hover: { group: "browser", scope: "agent", permission: "workspace.write" },
  browser_select: { group: "browser", scope: "agent", permission: "workspace.write" },
  browser_drag: { group: "browser", scope: "agent", permission: "workspace.write" },
  browser_logs: { group: "browser", scope: "agent", permission: "workspace.read" },
  browser_evaluate: { group: "browser", scope: "agent", permission: "workspace.write" },
  browser_scroll: { group: "browser", scope: "agent", permission: "workspace.write" },
  browser_resize: { group: "browser", scope: "agent", permission: "workspace.write" },
  browser_close_tab: { group: "browser", scope: "agent", permission: "workspace.write" },

  // Orchestration (hosts, workspaces, agents, prompts, permissions, providers, scripts, terminals)
  list_hosts: { group: "orchestration", scope: "both", permission: "daemon.read" },
  create_workspace: { group: "orchestration", scope: "both", permission: "workspace.manage" },
  list_workspaces: { group: "orchestration", scope: "both", permission: "workspace.read" },
  archive_workspace: { group: "orchestration", scope: "both", permission: "workspace.manage" },
  rename_workspace: { group: "orchestration", scope: "both", permission: "workspace.manage" },
  update_workspace: { group: "orchestration", scope: "both", permission: "workspace.manage" },
  create_agent: { group: "orchestration", scope: "both", permission: "workspace.write" },
  send_agent_prompt: { group: "orchestration", scope: "both", permission: "workspace.write" },
  get_agent_status: { group: "orchestration", scope: "both", permission: "workspace.read" },
  get_agent_activity: { group: "orchestration", scope: "both", permission: "workspace.read" },
  list_agents: { group: "orchestration", scope: "both", permission: "workspace.read" },
  cancel_agent: { group: "orchestration", scope: "both", permission: "workspace.write" },
  archive_agent: { group: "orchestration", scope: "both", permission: "workspace.write" },
  kill_agent: { group: "orchestration", scope: "both", permission: "workspace.write" },
  update_agent: { group: "orchestration", scope: "both", permission: "workspace.write" },
  set_agent_mode: { group: "orchestration", scope: "both", permission: "workspace.write" },
  list_pending_permissions: { group: "orchestration", scope: "both", permission: "workspace.read" },
  respond_to_permission: { group: "orchestration", scope: "both", permission: "workspace.write" },
  list_providers: { group: "orchestration", scope: "both", permission: "daemon.read" },
  list_models: { group: "orchestration", scope: "both", permission: "daemon.read" },
  list_profiles: { group: "orchestration", scope: "both", permission: "daemon.read" },
  inspect_provider: { group: "orchestration", scope: "both", permission: "daemon.read" },
  list_workspace_scripts: { group: "orchestration", scope: "both", permission: "workspace.read" },
  start_workspace_script: { group: "orchestration", scope: "both", permission: "workspace.write" },
  stop_workspace_script: { group: "orchestration", scope: "both", permission: "workspace.write" },
  list_terminals: { group: "orchestration", scope: "both", permission: "workspace.read" },
  create_terminal: { group: "orchestration", scope: "both", permission: "workspace.write" },
  kill_terminal: { group: "orchestration", scope: "both", permission: "workspace.write" },
  capture_terminal: { group: "orchestration", scope: "both", permission: "workspace.read" },
  send_terminal_keys: { group: "orchestration", scope: "both", permission: "workspace.write" },

  // Schedules & agent-scoped heartbeats
  create_schedule: { group: "schedules", scope: "both", permission: "automation.manage" },
  create_heartbeat: { group: "schedules", scope: "agent", permission: "automation.manage" },
  delete_heartbeat: { group: "schedules", scope: "agent", permission: "automation.manage" },
  list_schedules: { group: "schedules", scope: "both", permission: "automation.manage" },
  inspect_schedule: { group: "schedules", scope: "both", permission: "automation.manage" },
  pause_schedule: { group: "schedules", scope: "both", permission: "automation.manage" },
  resume_schedule: { group: "schedules", scope: "both", permission: "automation.manage" },
  delete_schedule: { group: "schedules", scope: "both", permission: "automation.manage" },
  update_schedule: { group: "schedules", scope: "both", permission: "automation.manage" },
  schedule_logs: { group: "schedules", scope: "both", permission: "automation.manage" },
  run_schedule_once: { group: "schedules", scope: "both", permission: "automation.manage" },

  // Change request watching (PR/MR subscriptions)
  subscribe_change_request: {
    group: "changeRequests",
    scope: "agent",
    permission: "workspace.read",
  },
  unsubscribe_change_request: {
    group: "changeRequests",
    scope: "agent",
    permission: "workspace.read",
  },
} as const satisfies Record<string, PaseoToolMetadata>;

export type BuiltInToolName = keyof typeof BUILTIN_TOOL_METADATA;
