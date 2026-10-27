/**
 * One entry per Paseo MCP tool: the timeline label, the context shown after it,
 * and how the expanded details lay out the call.
 *
 * Labels are fixed text so truncation never hides them. Actions read verb-first
 * ("Send message"); the context goes in the summary.
 */

type ToolInput = Readonly<Record<string, unknown>>;

/** `targetAgent` is the target agent's title when known, else its ID. */
export type PaseoToolContext = (input: ToolInput, targetAgent: string | undefined) => unknown;

export interface PaseoToolDetailSpec {
  promptField?: string;
  inputOrder?: readonly string[];
  outputFields?: readonly string[];
}

export interface PaseoToolEntry {
  label: string;
  completedLabel: string;
  context?: PaseoToolContext;
  detail?: PaseoToolDetailSpec;
}

const WORKSPACE_FIELDS = [
  "title",
  "workspaceId",
  "projectId",
  "isolation",
  "path",
  "mode",
  "worktreeSlug",
  "branchName",
  "baseBranch",
  "branch",
  "prNumber",
  "forge",
] as const;
const AGENT_FIELDS = [
  "title",
  "agentId",
  "provider",
  "workspaceId",
  "cwd",
  "sessionMode",
  "modeId",
  "background",
  "notifyOnFinish",
  "internal",
  "settings",
  "labels",
] as const;
const AUTOMATION_FIELDS = [
  "name",
  "id",
  "cron",
  "timezone",
  "provider",
  "cwd",
  "isolation",
  "maxRuns",
  "expiresIn",
  "clearExpires",
] as const;
const BROWSER_FIELDS = [
  "browserId",
  "url",
  "ref",
  "sourceRef",
  "targetRef",
  "value",
  "text",
  "key",
  "button",
  "doubleClick",
  "modifiers",
  "filePaths",
  "fullPage",
  "maxEntries",
  "timeoutMs",
  "deltaX",
  "deltaY",
  "width",
  "height",
  "function",
] as const;

const AUTOMATION_OUTPUT = ["id", "status", "nextRunAt", "expiresAt"] as const;

function field(...keys: string[]): PaseoToolContext {
  return (input) => keys.map((key) => input[key]).find(isPresent);
}

function targetAgent(): PaseoToolContext {
  return (_input, agent) => agent;
}

function fieldOrTargetAgent(key: string): PaseoToolContext {
  return (input, agent) => (isPresent(input[key]) ? input[key] : agent);
}

function workspaceContext(): PaseoToolContext {
  return (input) =>
    [input.title, input.branchName, input.branch, baseName(input.path)].find(isPresent);
}

function viewportContext(): PaseoToolContext {
  return (input) =>
    typeof input.width === "number" && typeof input.height === "number"
      ? `${input.width}×${input.height}`
      : undefined;
}

function isPresent(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === "number";
}

function baseName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.split(/[\\/]/).findLast((segment) => segment.length > 0);
}

function browser(
  label: string,
  completedLabel: string,
  context?: PaseoToolContext,
): PaseoToolEntry {
  return {
    label,
    completedLabel,
    ...(context ? { context } : {}),
    detail: { inputOrder: BROWSER_FIELDS },
  };
}

export const PASEO_TOOL_CATALOG = {
  // Agents
  create_agent: {
    label: "Create agent",
    completedLabel: "Created agent",
    context: field("title", "initialPrompt"),
    detail: {
      promptField: "initialPrompt",
      inputOrder: AGENT_FIELDS,
      outputFields: ["agentId", "status", "currentModeId", "cwd"],
    },
  },
  send_agent_prompt: {
    label: "Send message",
    completedLabel: "Sent message",
    context: field("prompt"),
    detail: {
      promptField: "prompt",
      inputOrder: AGENT_FIELDS,
      outputFields: ["status", "lastMessage", "permission"],
    },
  },
  get_agent_status: {
    label: "Check agent",
    completedLabel: "Checked agent",
    context: targetAgent(),
    detail: { inputOrder: ["agentId"] },
  },
  get_agent_activity: {
    label: "Read agent activity",
    completedLabel: "Read agent activity",
    context: targetAgent(),
    detail: { inputOrder: ["agentId", "limit"] },
  },
  list_agents: {
    label: "List agents",
    completedLabel: "Listed agents",
    detail: { inputOrder: ["cwd", "statuses", "sinceHours", "limit", "includeArchived"] },
  },
  update_agent: {
    label: "Update agent",
    completedLabel: "Updated agent",
    context: fieldOrTargetAgent("name"),
    detail: { inputOrder: AGENT_FIELDS },
  },
  set_agent_mode: {
    label: "Set agent mode",
    completedLabel: "Set agent mode",
    context: field("modeId"),
    detail: { inputOrder: ["agentId", "modeId"] },
  },
  cancel_agent: {
    label: "Cancel agent",
    completedLabel: "Canceled agent",
    context: targetAgent(),
    detail: { inputOrder: ["agentId"] },
  },
  archive_agent: {
    label: "Archive agent",
    completedLabel: "Archived agent",
    context: targetAgent(),
    detail: { inputOrder: ["agentId"] },
  },
  kill_agent: {
    label: "Kill agent",
    completedLabel: "Killed agent",
    context: targetAgent(),
    detail: { inputOrder: ["agentId"] },
  },
  list_pending_permissions: { label: "List permissions", completedLabel: "Listed permissions" },
  respond_to_permission: {
    label: "Respond to permission",
    completedLabel: "Responded to permission",
    context: targetAgent(),
    detail: { inputOrder: ["agentId", "requestId", "response"] },
  },

  // Workspaces and scripts
  create_workspace: {
    label: "Create workspace",
    completedLabel: "Created workspace",
    context: workspaceContext(),
    detail: { inputOrder: WORKSPACE_FIELDS, outputFields: ["workspaceId", "projectId"] },
  },
  list_hosts: { label: "List hosts", completedLabel: "Listed hosts" },
  list_workspaces: { label: "List workspaces", completedLabel: "Listed workspaces" },
  rename_workspace: {
    label: "Rename workspace",
    completedLabel: "Renamed workspace",
    context: field("title"),
    detail: { inputOrder: ["title", "workspaceId"] },
  },
  archive_workspace: {
    label: "Archive workspace",
    completedLabel: "Archived workspace",
    context: field("workspaceId"),
    detail: {
      inputOrder: ["workspaceId"],
      outputFields: ["workspaceId", "archivedAgentIds", "removedDirectory"],
    },
  },
  list_workspace_scripts: {
    label: "List scripts",
    completedLabel: "Listed scripts",
    detail: { inputOrder: ["workspaceId"] },
  },
  start_workspace_script: {
    label: "Start script",
    completedLabel: "Started script",
    context: field("scriptName"),
    detail: { inputOrder: ["workspaceId", "scriptName"] },
  },
  stop_workspace_script: {
    label: "Stop script",
    completedLabel: "Stopped script",
    context: field("scriptName"),
    detail: { inputOrder: ["workspaceId", "scriptName"] },
  },

  // Terminals
  create_terminal: {
    label: "Create terminal",
    completedLabel: "Created terminal",
    context: field("name", "command"),
    detail: { inputOrder: ["cwd", "workspaceId", "name", "command"] },
  },
  list_terminals: {
    label: "List terminals",
    completedLabel: "Listed terminals",
    detail: { inputOrder: ["cwd", "all"] },
  },
  capture_terminal: {
    label: "Read terminal",
    completedLabel: "Read terminal",
    context: field("terminalId"),
    detail: { inputOrder: ["terminalId", "lines"] },
  },
  send_terminal_keys: {
    label: "Send keys",
    completedLabel: "Sent keys",
    context: field("keys"),
    detail: { inputOrder: ["terminalId", "keys", "literal"] },
  },
  kill_terminal: {
    label: "Kill terminal",
    completedLabel: "Killed terminal",
    context: field("terminalId"),
    detail: { inputOrder: ["terminalId"] },
  },

  // Schedules and heartbeats
  create_schedule: {
    label: "Create schedule",
    completedLabel: "Created schedule",
    context: field("name", "cron"),
    detail: {
      promptField: "prompt",
      inputOrder: AUTOMATION_FIELDS,
      outputFields: AUTOMATION_OUTPUT,
    },
  },
  create_heartbeat: {
    label: "Create heartbeat",
    completedLabel: "Created heartbeat",
    context: field("name", "cron"),
    detail: {
      promptField: "prompt",
      inputOrder: AUTOMATION_FIELDS,
      outputFields: AUTOMATION_OUTPUT,
    },
  },
  update_schedule: {
    label: "Update schedule",
    completedLabel: "Updated schedule",
    context: field("name", "id"),
    detail: { promptField: "prompt", inputOrder: AUTOMATION_FIELDS },
  },
  list_schedules: { label: "List schedules", completedLabel: "Listed schedules" },
  inspect_schedule: {
    label: "Inspect schedule",
    completedLabel: "Inspected schedule",
    context: field("id"),
    detail: { inputOrder: ["id"] },
  },
  schedule_logs: {
    label: "Read schedule logs",
    completedLabel: "Read schedule logs",
    context: field("id"),
    detail: { inputOrder: ["id"] },
  },
  run_schedule_once: {
    label: "Run schedule",
    completedLabel: "Ran schedule",
    context: field("id"),
    detail: { inputOrder: ["id"] },
  },
  pause_schedule: {
    label: "Pause schedule",
    completedLabel: "Paused schedule",
    context: field("id"),
    detail: { inputOrder: ["id"] },
  },
  resume_schedule: {
    label: "Resume schedule",
    completedLabel: "Resumed schedule",
    context: field("id"),
    detail: { inputOrder: ["id"] },
  },
  delete_schedule: {
    label: "Delete schedule",
    completedLabel: "Deleted schedule",
    context: field("id"),
    detail: { inputOrder: ["id"] },
  },
  delete_heartbeat: {
    label: "Delete heartbeat",
    completedLabel: "Deleted heartbeat",
    context: field("id"),
    detail: { inputOrder: ["id"] },
  },

  // Providers
  list_providers: { label: "List providers", completedLabel: "Listed providers" },
  list_models: {
    label: "List models",
    completedLabel: "Listed models",
    context: field("provider"),
    detail: { inputOrder: ["provider"] },
  },
  list_profiles: { label: "List profiles", completedLabel: "Listed profiles" },
  inspect_provider: {
    label: "Inspect provider",
    completedLabel: "Inspected provider",
    context: field("provider"),
    detail: { inputOrder: ["provider", "cwd", "settings"] },
  },

  // Browser
  browser_list_tabs: browser("List browser tabs", "Listed browser tabs"),
  browser_new_tab: browser("Open browser tab", "Opened browser tab", field("url")),
  browser_close_tab: browser("Close browser tab", "Closed browser tab", field("browserId")),
  browser_navigate: browser("Navigate", "Navigated", field("url")),
  browser_back: browser("Go back", "Went back"),
  browser_forward: browser("Go forward", "Went forward"),
  browser_reload: browser("Reload page", "Reloaded page"),
  browser_snapshot: browser("Snapshot page", "Snapshotted page"),
  browser_screenshot: browser("Take screenshot", "Took screenshot"),
  browser_click: browser("Click element", "Clicked element", field("ref")),
  browser_hover: browser("Hover element", "Hovered element", field("ref")),
  browser_drag: browser("Drag element", "Dragged element", field("sourceRef")),
  browser_fill: browser("Fill field", "Filled field", field("ref")),
  browser_select: browser("Select option", "Selected option", field("value", "ref")),
  browser_type: browser("Type text", "Typed text", field("text")),
  browser_keypress: browser("Press key", "Pressed key", field("key")),
  browser_upload: browser("Upload files", "Uploaded files", field("filePaths")),
  browser_wait: browser("Wait for page", "Waited for page", field("text", "url")),
  browser_scroll: browser("Scroll page", "Scrolled page"),
  browser_resize: browser("Resize browser", "Resized browser", viewportContext()),
  browser_logs: browser("Read browser logs", "Read browser logs"),
  browser_evaluate: browser("Run JavaScript", "Ran JavaScript", field("function")),
} satisfies Record<string, PaseoToolEntry>;

export type PaseoToolName = keyof typeof PASEO_TOOL_CATALOG;

export function getPaseoToolEntry(leafName: string): PaseoToolEntry | undefined {
  return Object.prototype.hasOwnProperty.call(PASEO_TOOL_CATALOG, leafName)
    ? PASEO_TOOL_CATALOG[leafName as PaseoToolName]
    : undefined;
}
