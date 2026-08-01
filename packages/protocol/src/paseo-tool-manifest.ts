/**
 * Declarative metadata for the Paseo tools exposed to agents. This is shared
 * UI metadata, not a wire contract; tool IDs intentionally remain open
 * strings in provider configuration.
 */

export type PaseoToolManifestGroup =
  | "Workspaces"
  | "Agents"
  | "Terminals"
  | "Schedules"
  | "Providers"
  | "Browser";

export interface PaseoToolManifestEntry {
  id: string;
  label: string;
  description: string;
  group: PaseoToolManifestGroup;
  browser?: boolean;
}

export const PASEO_TOOL_MANIFEST = [
  {
    id: "create_workspace",
    label: "Create workspace",
    description:
      "Create a workspace using an existing local checkout or a new Paseo-managed worktree.",
    group: "Workspaces",
  },
  {
    id: "list_workspaces",
    label: "List workspaces",
    description: "List active workspaces.",
    group: "Workspaces",
  },
  {
    id: "archive_workspace",
    label: "Archive workspace",
    description: "Archive a workspace and everything it owns.",
    group: "Workspaces",
  },
  {
    id: "rename_workspace",
    label: "Rename workspace",
    description:
      "Rename a workspace by setting its user-visible title. Omit workspaceId to rename your current workspace.",
    group: "Workspaces",
  },
  {
    id: "list_workspace_scripts",
    label: "List workspace scripts",
    description:
      "List configured workspace scripts and their lifecycle, service port, proxy URL, health, and terminal ID.",
    group: "Workspaces",
  },
  {
    id: "start_workspace_script",
    label: "Start workspace script",
    description:
      "Start one configured workspace script through Paseo's managed workspace-script launcher.",
    group: "Workspaces",
  },
  {
    id: "stop_workspace_script",
    label: "Stop workspace script",
    description: "Stop a running workspace script through its supervised terminal lifecycle.",
    group: "Workspaces",
  },
  {
    id: "create_agent",
    label: "Create agent",
    description:
      "Create an agent. Agent-scoped creation defaults to your workspace and creates your subagent. Top-level creation without workspaceId creates a new local workspace. Requires provider/model (for example codex/gpt-5.4) and an initial prompt. Do not guess; call list_providers and list_models first if uncertain.",
    group: "Agents",
  },
  {
    id: "send_agent_prompt",
    label: "Send agent prompt",
    description:
      "Send a task to a running agent. Agent-scoped callers run in background by default; top-level callers wait by default.",
    group: "Agents",
  },
  {
    id: "get_agent_status",
    label: "Get agent status",
    description:
      "Return the latest snapshot for an agent, including lifecycle state, capabilities, and pending permissions.",
    group: "Agents",
  },
  {
    id: "list_agents",
    label: "List agents",
    description: "List recent agents as compact metadata.",
    group: "Agents",
  },
  {
    id: "cancel_agent",
    label: "Cancel agent run",
    description: "Abort the agent's current run but keep the agent alive for future tasks.",
    group: "Agents",
  },
  {
    id: "archive_agent",
    label: "Archive agent",
    description:
      "Archive an agent (soft-delete). The agent is interrupted if running and removed from the active list.",
    group: "Agents",
  },
  {
    id: "kill_agent",
    label: "Kill agent",
    description: "Terminate an agent session permanently.",
    group: "Agents",
  },
  {
    id: "update_agent",
    label: "Update agent",
    description: "Update an agent name, labels, and/or runtime settings.",
    group: "Agents",
  },
  {
    id: "get_agent_activity",
    label: "Get agent activity",
    description: "Return recent agent timeline entries as a curated summary.",
    group: "Agents",
  },
  {
    id: "set_agent_mode",
    label: "Set agent session mode",
    description:
      "Switch the agent's session mode (plan, bypassPermissions, read-only, auto, etc.).",
    group: "Agents",
  },
  {
    id: "list_pending_permissions",
    label: "List pending permissions",
    description:
      "Return all pending permission requests across all agents with the normalized payloads.",
    group: "Agents",
  },
  {
    id: "respond_to_permission",
    label: "Respond to permission",
    description:
      "Approve or deny a pending permission request with an AgentManager-compatible response payload.",
    group: "Agents",
  },
  {
    id: "list_terminals",
    label: "List terminals",
    description: "List terminals for a working directory or across all working directories.",
    group: "Terminals",
  },
  {
    id: "create_terminal",
    label: "Create terminal",
    description: "Create a terminal session for a working directory.",
    group: "Terminals",
  },
  {
    id: "kill_terminal",
    label: "Kill terminal",
    description: "Kill an existing terminal session.",
    group: "Terminals",
  },
  {
    id: "capture_terminal",
    label: "Capture terminal",
    description: "Capture plain-text terminal output lines from a terminal session.",
    group: "Terminals",
  },
  {
    id: "send_terminal_keys",
    label: "Send terminal keys",
    description: "Send literal text or special key tokens to a terminal session.",
    group: "Terminals",
  },
  {
    id: "create_schedule",
    label: "Create schedule",
    description: "Create a recurring schedule that starts a new agent on a cron cadence.",
    group: "Schedules",
  },
  {
    id: "create_heartbeat",
    label: "Create heartbeat",
    description: "Create a recurring heartbeat that sends you a prompt on a cron cadence.",
    group: "Schedules",
  },
  {
    id: "delete_heartbeat",
    label: "Delete heartbeat",
    description: "Delete one of your heartbeats.",
    group: "Schedules",
  },
  {
    id: "list_schedules",
    label: "List schedules",
    description: "List all schedules managed by the daemon.",
    group: "Schedules",
  },
  {
    id: "inspect_schedule",
    label: "Inspect schedule",
    description: "Inspect a schedule and its run history.",
    group: "Schedules",
  },
  {
    id: "pause_schedule",
    label: "Pause schedule",
    description: "Pause an active schedule.",
    group: "Schedules",
  },
  {
    id: "resume_schedule",
    label: "Resume schedule",
    description: "Resume a paused schedule.",
    group: "Schedules",
  },
  {
    id: "delete_schedule",
    label: "Delete schedule",
    description: "Delete a schedule permanently.",
    group: "Schedules",
  },
  {
    id: "update_schedule",
    label: "Update schedule",
    description:
      "Update an existing schedule. Only provided fields are changed; omitted fields remain unchanged.",
    group: "Schedules",
  },
  {
    id: "schedule_logs",
    label: "Schedule logs",
    description: "Get the run history (logs) for a schedule.",
    group: "Schedules",
  },
  {
    id: "run_schedule_once",
    label: "Run schedule once",
    description: "Run a schedule immediately without changing its cron cadence.",
    group: "Schedules",
  },
  {
    id: "list_providers",
    label: "List providers",
    description: "List configured agent providers, availability, and their modes.",
    group: "Providers",
  },
  {
    id: "list_models",
    label: "List models",
    description: "List models for an agent provider.",
    group: "Providers",
  },
  {
    id: "inspect_provider",
    label: "Inspect provider",
    description:
      "Inspect compact provider capabilities for orchestration, including modes and draft feature settings. Use list_models for the full model list.",
    group: "Providers",
  },
  {
    id: "browser_list_tabs",
    label: "List browser tabs",
    description:
      "List open Paseo browser tabs for this agent's workspace across connected browser automation hosts. Use returned browserId values with tab-scoped tools.",
    group: "Browser",
    browser: true,
  },
  {
    id: "browser_new_tab",
    label: "Create browser tab",
    description:
      "Create a new Paseo browser tab in this agent's workspace on the most recently connected browser automation host, opened in the background without switching the user's view. Pass an http(s) URL or a scheme-less host URL, which is treated as http; the returned browserId is used by tab-scoped tools.",
    group: "Browser",
    browser: true,
  },
  {
    id: "browser_snapshot",
    label: "Snapshot browser page",
    description:
      "Return a model-readable snapshot of a Paseo browser tab. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes.",
    group: "Browser",
    browser: true,
  },
  {
    id: "browser_click",
    label: "Click browser element",
    description:
      "Click an element in a Paseo browser tab. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes.",
    group: "Browser",
    browser: true,
  },
  {
    id: "browser_fill",
    label: "Fill browser element",
    description:
      "Fill an input-like element in a Paseo browser tab. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes.",
    group: "Browser",
    browser: true,
  },
  {
    id: "browser_wait",
    label: "Wait for browser condition",
    description:
      "Wait until a Paseo browser tab contains text or reaches a URL fragment. Use browserId from browser_new_tab or browser_list_tabs; waits up to 5s by default on the browser host.",
    group: "Browser",
    browser: true,
  },
  {
    id: "browser_type",
    label: "Type into browser",
    description:
      "Type text into an element, or into the focused element when ref is omitted. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes.",
    group: "Browser",
    browser: true,
  },
  {
    id: "browser_keypress",
    label: "Press browser key",
    description:
      "Dispatch a keypress to an element, or to the focused element when ref is omitted. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes.",
    group: "Browser",
    browser: true,
  },
  {
    id: "browser_navigate",
    label: "Navigate browser",
    description:
      "Navigate a Paseo browser tab to a URL. Use browserId from browser_new_tab or browser_list_tabs; pass an http(s) URL or a scheme-less host URL, which is treated as http.",
    group: "Browser",
    browser: true,
  },
  {
    id: "browser_back",
    label: "Browser back",
    description:
      "Go back in a Paseo browser tab. Use browserId from browser_new_tab or browser_list_tabs.",
    group: "Browser",
    browser: true,
  },
  {
    id: "browser_forward",
    label: "Browser forward",
    description:
      "Go forward in a Paseo browser tab. Use browserId from browser_new_tab or browser_list_tabs.",
    group: "Browser",
    browser: true,
  },
  {
    id: "browser_reload",
    label: "Browser reload",
    description:
      "Reload a Paseo browser tab. Use browserId from browser_new_tab or browser_list_tabs.",
    group: "Browser",
    browser: true,
  },
  {
    id: "browser_screenshot",
    label: "Capture browser screenshot",
    description:
      "Capture a PNG screenshot of a Paseo browser tab. Use browserId from browser_new_tab or browser_list_tabs. Set fullPage to true to capture the full page.",
    group: "Browser",
    browser: true,
  },
  {
    id: "browser_upload",
    label: "Upload files in browser",
    description:
      "Set workspace files on a file input in a Paseo browser tab. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes.",
    group: "Browser",
    browser: true,
  },
  {
    id: "browser_hover",
    label: "Hover browser element",
    description:
      "Hover an element in a Paseo browser tab. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes.",
    group: "Browser",
    browser: true,
  },
  {
    id: "browser_select",
    label: "Select browser option",
    description:
      "Set a select element in a Paseo browser tab to a value. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes.",
    group: "Browser",
    browser: true,
  },
  {
    id: "browser_drag",
    label: "Drag browser element",
    description:
      "Drag one element onto another in a Paseo browser tab. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes.",
    group: "Browser",
    browser: true,
  },
  {
    id: "browser_logs",
    label: "Read browser logs",
    description:
      "Read recent console messages and browser performance network entries for a Paseo browser tab. Use browserId from browser_new_tab or browser_list_tabs; maxEntries defaults to 50.",
    group: "Browser",
    browser: true,
  },
  {
    id: "browser_evaluate",
    label: "Evaluate browser JavaScript",
    description:
      "Evaluate a JavaScript function in a Paseo browser tab. Use browserId from browser_new_tab or browser_list_tabs; when ref is provided, refs come from the latest browser_snapshot and the resolved element is passed as the first argument.",
    group: "Browser",
    browser: true,
  },
  {
    id: "browser_scroll",
    label: "Scroll browser",
    description:
      "Scroll a Paseo browser tab by deltaX/deltaY CSS pixels. Use browserId from browser_new_tab or browser_list_tabs; optional ref comes from the latest browser_snapshot and centers the wheel input over that element.",
    group: "Browser",
    browser: true,
  },
  {
    id: "browser_resize",
    label: "Resize browser viewport",
    description:
      "Resize a Paseo browser tab's resident webview viewport. Use browserId from browser_new_tab or browser_list_tabs.",
    group: "Browser",
    browser: true,
  },
  {
    id: "browser_close_tab",
    label: "Close browser tab",
    description:
      "Close a Paseo browser tab, remove its resident webview, and unregister it from the browser automation host. Use browserId from browser_new_tab or browser_list_tabs.",
    group: "Browser",
    browser: true,
  },
] as const satisfies readonly PaseoToolManifestEntry[];
