import { getPaseoToolLeafName } from "./tool-name-normalization.js";

export interface PaseoToolDetailField {
  label: string;
  value: string;
}

export type PaseoToolDetailSection =
  | {
      kind: "prose";
      title: string;
      text: string;
    }
  | {
      kind: "fields";
      title: string;
      fields: PaseoToolDetailField[];
    };

interface ToolDetailSpec {
  promptField?: string;
  inputOrder?: readonly string[];
  outputFields?: readonly string[];
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

const TOOL_SPECS: Readonly<Record<string, ToolDetailSpec>> = {
  create_workspace: {
    inputOrder: WORKSPACE_FIELDS,
    outputFields: ["workspaceId", "projectId"],
  },
  list_workspaces: {},
  archive_workspace: {
    inputOrder: ["workspaceId"],
    outputFields: ["workspaceId", "archivedAgentIds", "removedDirectory"],
  },
  rename_workspace: { inputOrder: ["title", "workspaceId"] },
  create_agent: {
    promptField: "initialPrompt",
    inputOrder: AGENT_FIELDS,
    outputFields: ["agentId", "status", "currentModeId", "cwd"],
  },
  send_agent_prompt: {
    promptField: "prompt",
    inputOrder: AGENT_FIELDS,
    outputFields: ["status", "lastMessage", "permission"],
  },
  get_agent_status: { inputOrder: ["agentId"] },
  list_agents: { inputOrder: ["cwd", "statuses", "sinceHours", "limit", "includeArchived"] },
  cancel_agent: { inputOrder: ["agentId"] },
  archive_agent: { inputOrder: ["agentId"] },
  kill_agent: { inputOrder: ["agentId"] },
  update_agent: { inputOrder: AGENT_FIELDS },
  get_agent_activity: { inputOrder: ["agentId", "limit"] },
  set_agent_mode: { inputOrder: ["agentId", "modeId"] },
  list_workspace_scripts: { inputOrder: ["workspaceId"] },
  start_workspace_script: { inputOrder: ["workspaceId", "scriptName"] },
  stop_workspace_script: { inputOrder: ["workspaceId", "scriptName"] },
  list_terminals: { inputOrder: ["cwd", "all"] },
  create_terminal: { inputOrder: ["cwd", "workspaceId", "name", "command"] },
  kill_terminal: { inputOrder: ["terminalId"] },
  capture_terminal: { inputOrder: ["terminalId", "lines"] },
  send_terminal_keys: { inputOrder: ["terminalId", "keys", "literal"] },
  create_schedule: {
    promptField: "prompt",
    inputOrder: AUTOMATION_FIELDS,
    outputFields: ["id", "status", "nextRunAt", "expiresAt"],
  },
  create_heartbeat: {
    promptField: "prompt",
    inputOrder: AUTOMATION_FIELDS,
    outputFields: ["id", "status", "nextRunAt", "expiresAt"],
  },
  delete_heartbeat: { inputOrder: ["id"] },
  list_schedules: {},
  inspect_schedule: { inputOrder: ["id"] },
  pause_schedule: { inputOrder: ["id"] },
  resume_schedule: { inputOrder: ["id"] },
  delete_schedule: { inputOrder: ["id"] },
  update_schedule: { promptField: "prompt", inputOrder: AUTOMATION_FIELDS },
  schedule_logs: { inputOrder: ["id"] },
  run_schedule_once: { inputOrder: ["id"] },
  list_providers: {},
  list_models: { inputOrder: ["provider"] },
  list_profiles: {},
  inspect_provider: { inputOrder: ["provider", "cwd", "settings"] },
  list_pending_permissions: {},
  respond_to_permission: { inputOrder: ["agentId", "requestId", "response"] },
  browser_list_tabs: {},
  browser_new_tab: { inputOrder: BROWSER_FIELDS },
  browser_snapshot: { inputOrder: BROWSER_FIELDS },
  browser_click: { inputOrder: BROWSER_FIELDS },
  browser_fill: { inputOrder: BROWSER_FIELDS },
  browser_wait: { inputOrder: BROWSER_FIELDS },
  browser_type: { inputOrder: BROWSER_FIELDS },
  browser_keypress: { inputOrder: BROWSER_FIELDS },
  browser_navigate: { inputOrder: BROWSER_FIELDS },
  browser_back: { inputOrder: BROWSER_FIELDS },
  browser_forward: { inputOrder: BROWSER_FIELDS },
  browser_reload: { inputOrder: BROWSER_FIELDS },
  browser_screenshot: { inputOrder: BROWSER_FIELDS },
  browser_upload: { inputOrder: BROWSER_FIELDS },
  browser_hover: { inputOrder: BROWSER_FIELDS },
  browser_select: { inputOrder: BROWSER_FIELDS },
  browser_drag: { inputOrder: BROWSER_FIELDS },
  browser_logs: { inputOrder: BROWSER_FIELDS },
  browser_evaluate: { inputOrder: BROWSER_FIELDS },
  browser_scroll: { inputOrder: BROWSER_FIELDS },
  browser_resize: { inputOrder: BROWSER_FIELDS },
  browser_close_tab: { inputOrder: BROWSER_FIELDS },
};

const FIELD_LABELS: Readonly<Record<string, string>> = {
  agentId: "Agent",
  archivedAgentIds: "Archived agents",
  baseBranch: "Base branch",
  branchName: "New branch",
  browserId: "Browser tab",
  clearExpires: "Clear expiry",
  currentModeId: "Current mode",
  cwd: "Working directory",
  deltaX: "Horizontal delta",
  deltaY: "Vertical delta",
  doubleClick: "Double click",
  expiresIn: "Expires in",
  expiresAt: "Expires",
  filePaths: "Files",
  fullPage: "Full page",
  initialPrompt: "Prompt",
  id: "ID",
  lastMessage: "Last message",
  maxEntries: "Maximum entries",
  maxRuns: "Maximum runs",
  modeId: "Mode",
  newMode: "New mode",
  nextRunAt: "Next run",
  notifyOnFinish: "Notify on finish",
  prNumber: "Change request",
  projectId: "Project",
  removedDirectory: "Removed directory",
  requestId: "Request",
  scriptName: "Script",
  sessionMode: "Session mode",
  sinceHours: "Since (hours)",
  sourceRef: "Source",
  targetRef: "Target",
  terminalId: "Terminal",
  thinkingOptionId: "Thinking",
  timeoutMs: "Timeout (ms)",
  updateCount: "Updates",
  workspaceId: "Workspace",
  worktreeSlug: "Worktree",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function humanizeKey(key: string): string {
  const known = FIELD_LABELS[key];
  if (known) return known;
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .split(" ")
    .filter(Boolean);
  const sentence = words.join(" ").toLowerCase();
  return `${sentence[0]?.toUpperCase() ?? ""}${sentence.slice(1)}`;
}

function formatValue(value: unknown, depth = 0): string {
  if (value === null) return "None";
  if (value === undefined) return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "None";
    return value.map((item) => `• ${indentMultiline(formatValue(item, depth + 1), 2)}`).join("\n");
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).filter(([, child]) => child !== undefined);
    if (entries.length === 0) return "None";
    return entries
      .map(([key, child]) => {
        const formatted = formatValue(child, depth + 1);
        return `${humanizeKey(key)}: ${indentMultiline(formatted, 2)}`;
      })
      .join("\n");
  }
  return String(value);
}

function indentMultiline(value: string, spaces: number): string {
  const indentation = " ".repeat(spaces);
  return value.replace(/\n/g, `\n${indentation}`);
}

function orderedEntries(
  value: Record<string, unknown>,
  order: readonly string[] = [],
  omittedKey?: string,
  includedKeys?: readonly string[],
): Array<[string, unknown]> {
  const included = includedKeys ? new Set(includedKeys) : null;
  const keys = Object.keys(value).filter(
    (key) => key !== omittedKey && value[key] !== undefined && (!included || included.has(key)),
  );
  const rank = new Map(order.map((key, index) => [key, index]));
  keys.sort((left, right) => {
    const leftRank = rank.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rank.get(right) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || left.localeCompare(right);
  });
  return keys.map((key) => [key, value[key]]);
}

function fieldsFromValue(
  value: unknown,
  order?: readonly string[],
  omittedKey?: string,
  includedKeys?: readonly string[],
): PaseoToolDetailField[] {
  if (value === null || value === undefined) return [];
  if (!isRecord(value)) {
    const formatted = formatValue(value);
    return formatted ? [{ label: "Value", value: formatted }] : [];
  }
  return orderedEntries(value, order, omittedKey, includedKeys).map(([key, child]) => ({
    label: humanizeKey(key),
    value: formatValue(child),
  }));
}

function parseJsonText(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function unwrapMcpResult(output: unknown): unknown {
  if (!isRecord(output)) return output;

  if (output.structuredContent !== undefined) {
    return output.structuredContent;
  }

  if (Array.isArray(output.content) && output.content.length === 1) {
    const item = output.content[0];
    if (isRecord(item) && item.type === "text") {
      return parseJsonText(item.text) ?? item.text;
    }
  }

  return output;
}

export function buildPaseoToolDetailSections(
  toolName: string,
  input: unknown,
  output: unknown,
): PaseoToolDetailSection[] | null {
  const leafName = getPaseoToolLeafName(toolName);
  if (!leafName) return null;

  const spec = TOOL_SPECS[leafName] ?? {};
  const sections: PaseoToolDetailSection[] = [];
  if (spec.promptField && isRecord(input)) {
    const prompt = input[spec.promptField];
    if (typeof prompt === "string" && prompt.length > 0) {
      sections.push({ kind: "prose", title: "Prompt", text: prompt });
    }
  }

  const inputFields = fieldsFromValue(input, spec.inputOrder, spec.promptField);
  if (inputFields.length > 0) {
    sections.push({ kind: "fields", title: "Details", fields: inputFields });
  }

  const outputFields = fieldsFromValue(
    unwrapMcpResult(output),
    spec.outputFields,
    undefined,
    spec.outputFields,
  );
  if (outputFields.length > 0) {
    sections.push({ kind: "fields", title: "Result", fields: outputFields });
  }
  return sections;
}
