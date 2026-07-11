import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";

export const TOOL_CALL_DISPLAY_NAME_KEYS = [
  "toolCallDetails.names.shell",
  "toolCallDetails.names.read",
  "toolCallDetails.names.edit",
  "toolCallDetails.names.write",
  "toolCallDetails.names.search",
  "toolCallDetails.names.fetch",
  "toolCallDetails.names.webSearch",
  "toolCallDetails.names.worktreeSetup",
  "toolCallDetails.names.task",
  "toolCallDetails.names.plan",
  "toolCallDetails.names.thinking",
  "toolCallDetails.names.terminal",
  "toolCallDetails.names.createAgent",
  "toolCallDetails.names.listAgents",
  "toolCallDetails.names.getAgentStatus",
  "toolCallDetails.names.updateAgent",
] as const;

export type ToolCallDisplayNameKey = (typeof TOOL_CALL_DISPLAY_NAME_KEYS)[number];

interface ToolCallDisplayNameInput {
  toolName: string;
  detail: ToolCallDetail;
  displayName: string;
  summary?: string;
}

const DETAIL_KEYS: Partial<Record<ToolCallDetail["type"], ToolCallDisplayNameKey>> = {
  shell: "toolCallDetails.names.shell",
  read: "toolCallDetails.names.read",
  edit: "toolCallDetails.names.edit",
  write: "toolCallDetails.names.write",
  search: "toolCallDetails.names.search",
  fetch: "toolCallDetails.names.fetch",
  worktree_setup: "toolCallDetails.names.worktreeSetup",
  plan: "toolCallDetails.names.plan",
};

const KNOWN_NAME_KEYS: Record<string, ToolCallDisplayNameKey> = {
  shell: "toolCallDetails.names.shell",
  "exec command": "toolCallDetails.names.shell",
  exec_command: "toolCallDetails.names.shell",
  read: "toolCallDetails.names.read",
  "read file": "toolCallDetails.names.read",
  read_file: "toolCallDetails.names.read",
  edit: "toolCallDetails.names.edit",
  "edit file": "toolCallDetails.names.edit",
  edit_file: "toolCallDetails.names.edit",
  apply_patch: "toolCallDetails.names.edit",
  write: "toolCallDetails.names.write",
  "write file": "toolCallDetails.names.write",
  write_file: "toolCallDetails.names.write",
  search: "toolCallDetails.names.search",
  grep: "toolCallDetails.names.search",
  glob: "toolCallDetails.names.search",
  fetch: "toolCallDetails.names.fetch",
  "web fetch": "toolCallDetails.names.fetch",
  web_fetch: "toolCallDetails.names.fetch",
  "web search": "toolCallDetails.names.webSearch",
  web_search: "toolCallDetails.names.webSearch",
  "search query": "toolCallDetails.names.webSearch",
  search_query: "toolCallDetails.names.webSearch",
  task: "toolCallDetails.names.task",
  plan: "toolCallDetails.names.plan",
  thinking: "toolCallDetails.names.thinking",
  terminal: "toolCallDetails.names.terminal",
  "create agent": "toolCallDetails.names.createAgent",
  create_agent: "toolCallDetails.names.createAgent",
  "list agents": "toolCallDetails.names.listAgents",
  list_agents: "toolCallDetails.names.listAgents",
  "get agent status": "toolCallDetails.names.getAgentStatus",
  get_agent_status: "toolCallDetails.names.getAgentStatus",
  "update agent": "toolCallDetails.names.updateAgent",
  update_agent: "toolCallDetails.names.updateAgent",
};

function normalizedToolCandidates(toolName: string): string[] {
  const lowerToolName = toolName.trim().toLowerCase();
  const paseoLeaf = lowerToolName.match(/(?:^|__|\.)paseo(?:__|\.)([a-z0-9_]+)$/)?.[1];
  return [lowerToolName, ...(paseoLeaf ? [paseoLeaf] : [])];
}

export function getToolCallDisplayNameKey(
  input: ToolCallDisplayNameInput,
): ToolCallDisplayNameKey | null {
  if (input.summary?.trim().replace(/:$/, "").toLowerCase() === "web search") {
    return "toolCallDetails.names.webSearch";
  }

  if (input.detail.type === "search" && input.detail.toolName) {
    const nestedSearchKey = KNOWN_NAME_KEYS[input.detail.toolName.trim().toLowerCase()];
    if (nestedSearchKey) return nestedSearchKey;
  }

  for (const candidate of normalizedToolCandidates(input.toolName)) {
    const key = KNOWN_NAME_KEYS[candidate];
    if (key) return key;
  }

  const detailKey = DETAIL_KEYS[input.detail.type];
  if (detailKey) {
    return detailKey;
  }

  if (input.detail.type === "sub_agent" && input.displayName.trim().toLowerCase() === "task") {
    return "toolCallDetails.names.task";
  }

  return KNOWN_NAME_KEYS[input.displayName.trim().toLowerCase()] ?? null;
}

export function getToolCallLocalizedSummary(
  displayNameKey: ToolCallDisplayNameKey | null,
  summary: string | undefined,
): string | undefined {
  if (
    displayNameKey === "toolCallDetails.names.webSearch" &&
    summary?.trim().replace(/:$/, "").toLowerCase() === "web search"
  ) {
    return undefined;
  }
  return summary;
}
