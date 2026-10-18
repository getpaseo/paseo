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

function browser(label: string, context?: PaseoToolContext): PaseoToolEntry {
  return { label, ...(context ? { context } : {}), detail: { inputOrder: BROWSER_FIELDS } };
}

export const PASEO_TOOL_CATALOG = {
  // Agents
  create_agent: {
    label: "Create agent",
    context: field("title", "initialPrompt"),
    detail: {
      promptField: "initialPrompt",
      inputOrder: AGENT_FIELDS,
      outputFields: ["agentId", "status", "currentModeId", "cwd"],
    },
  },
  send_agent_prompt: {
    label: "Send message",
    context: field("prompt"),
    detail: {
      promptField: "prompt",
      inputOrder: AGENT_FIELDS,
      outputFields: ["status", "lastMessage", "permission"],
    },
  },
  get_agent_status: {
    label: "Check agent",
    context: targetAgent(),
    detail: { inputOrder: ["agentId"] },
  },
  get_agent_activity: {
    label: "Read agent activity",
    context: targetAgent(),
    detail: { inputOrder: ["agentId", "limit"] },
  },
  list_agents: {
    label: "List agents",
    detail: { inputOrder: ["cwd", "statuses", "sinceHours", "limit", "includeArchived"] },
  },
  update_agent: {
    label: "Update agent",
    context: fieldOrTargetAgent("name"),
    detail: { inputOrder: AGENT_FIELDS },
  },
  set_agent_mode: {
    label: "Set agent mode",
    context: field("modeId"),
    detail: { inputOrder: ["agentId", "modeId"] },
  },
  cancel_agent: {
    label: "Cancel agent",
    context: targetAgent(),
    detail: { inputOrder: ["agentId"] },
  },
  archive_agent: {
    label: "Archive agent",
    context: targetAgent(),
    detail: { inputOrder: ["agentId"] },
  },
  kill_agent: { label: "Kill agent", context: targetAgent(), detail: { inputOrder: ["agentId"] } },
  list_pending_permissions: { label: "List permissions" },
  respond_to_permission: {
    label: "Respond to permission",
    context: targetAgent(),
    detail: { inputOrder: ["agentId", "requestId", "response"] },
  },

  // Workspaces and scripts
  create_workspace: {
    label: "Create workspace",
    context: workspaceContext(),
    detail: { inputOrder: WORKSPACE_FIELDS, outputFields: ["workspaceId", "projectId"] },
  },
  list_workspaces: { label: "List workspaces" },
  rename_workspace: {
    label: "Rename workspace",
    context: field("title"),
    detail: { inputOrder: ["title", "workspaceId"] },
  },
  archive_workspace: {
    label: "Archive workspace",
    context: field("workspaceId"),
    detail: {
      inputOrder: ["workspaceId"],
      outputFields: ["workspaceId", "archivedAgentIds", "removedDirectory"],
    },
  },
  list_workspace_scripts: { label: "List scripts", detail: { inputOrder: ["workspaceId"] } },
  start_workspace_script: {
    label: "Start script",
    context: field("scriptName"),
    detail: { inputOrder: ["workspaceId", "scriptName"] },
  },
  stop_workspace_script: {
    label: "Stop script",
    context: field("scriptName"),
    detail: { inputOrder: ["workspaceId", "scriptName"] },
  },

  // Terminals
  create_terminal: {
    label: "Create terminal",
    context: field("name", "command"),
    detail: { inputOrder: ["cwd", "workspaceId", "name", "command"] },
  },
  list_terminals: { label: "List terminals", detail: { inputOrder: ["cwd", "all"] } },
  capture_terminal: {
    label: "Read terminal",
    context: field("terminalId"),
    detail: { inputOrder: ["terminalId", "lines"] },
  },
  send_terminal_keys: {
    label: "Send keys",
    context: field("keys"),
    detail: { inputOrder: ["terminalId", "keys", "literal"] },
  },
  kill_terminal: {
    label: "Kill terminal",
    context: field("terminalId"),
    detail: { inputOrder: ["terminalId"] },
  },

  // Schedules and heartbeats
  create_schedule: {
    label: "Create schedule",
    context: field("name", "cron"),
    detail: {
      promptField: "prompt",
      inputOrder: AUTOMATION_FIELDS,
      outputFields: AUTOMATION_OUTPUT,
    },
  },
  create_heartbeat: {
    label: "Create heartbeat",
    context: field("name", "cron"),
    detail: {
      promptField: "prompt",
      inputOrder: AUTOMATION_FIELDS,
      outputFields: AUTOMATION_OUTPUT,
    },
  },
  update_schedule: {
    label: "Update schedule",
    context: field("name", "id"),
    detail: { promptField: "prompt", inputOrder: AUTOMATION_FIELDS },
  },
  list_schedules: { label: "List schedules" },
  inspect_schedule: {
    label: "Inspect schedule",
    context: field("id"),
    detail: { inputOrder: ["id"] },
  },
  schedule_logs: {
    label: "Read schedule logs",
    context: field("id"),
    detail: { inputOrder: ["id"] },
  },
  run_schedule_once: {
    label: "Run schedule",
    context: field("id"),
    detail: { inputOrder: ["id"] },
  },
  pause_schedule: { label: "Pause schedule", context: field("id"), detail: { inputOrder: ["id"] } },
  resume_schedule: {
    label: "Resume schedule",
    context: field("id"),
    detail: { inputOrder: ["id"] },
  },
  delete_schedule: {
    label: "Delete schedule",
    context: field("id"),
    detail: { inputOrder: ["id"] },
  },
  delete_heartbeat: {
    label: "Delete heartbeat",
    context: field("id"),
    detail: { inputOrder: ["id"] },
  },

  // Providers
  list_providers: { label: "List providers" },
  list_models: {
    label: "List models",
    context: field("provider"),
    detail: { inputOrder: ["provider"] },
  },
  list_profiles: { label: "List profiles" },
  inspect_provider: {
    label: "Inspect provider",
    context: field("provider"),
    detail: { inputOrder: ["provider", "cwd", "settings"] },
  },

  // Browser
  browser_list_tabs: browser("List browser tabs"),
  browser_new_tab: browser("Open browser tab", field("url")),
  browser_close_tab: browser("Close browser tab", field("browserId")),
  browser_navigate: browser("Navigate", field("url")),
  browser_back: browser("Go back"),
  browser_forward: browser("Go forward"),
  browser_reload: browser("Reload page"),
  browser_snapshot: browser("Snapshot page"),
  browser_screenshot: browser("Take screenshot"),
  browser_click: browser("Click element", field("ref")),
  browser_hover: browser("Hover element", field("ref")),
  browser_drag: browser("Drag element", field("sourceRef")),
  browser_fill: browser("Fill field", field("ref")),
  browser_select: browser("Select option", field("value", "ref")),
  browser_type: browser("Type text", field("text")),
  browser_keypress: browser("Press key", field("key")),
  browser_upload: browser("Upload files", field("filePaths")),
  browser_wait: browser("Wait for page", field("text", "url")),
  browser_scroll: browser("Scroll page"),
  browser_resize: browser("Resize browser", viewportContext()),
  browser_logs: browser("Read browser logs"),
  browser_evaluate: browser("Run JavaScript", field("function")),
} satisfies Record<string, PaseoToolEntry>;

export type PaseoToolName = keyof typeof PASEO_TOOL_CATALOG;

export function getPaseoToolEntry(leafName: string): PaseoToolEntry | undefined {
  return Object.prototype.hasOwnProperty.call(PASEO_TOOL_CATALOG, leafName)
    ? PASEO_TOOL_CATALOG[leafName as PaseoToolName]
    : undefined;
}
