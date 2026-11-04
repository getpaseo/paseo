import type {
  ProviderTimelineItem,
  ProviderToolCallDetail,
  ProviderToolPolicy,
} from "@getpaseo/plugin/server/provider";
import type { AcpToolCallPayload, JsonValue } from "./wire.js";

const NATIVE_ACCEPT_EDITS_TOOLS = new Set([
  "view_file",
  "read_file",
  "view_file_outline",
  "view_code_item",
  "list_dir",
  "find_by_name",
  "grep_search",
  "replace_file_content",
  "multi_replace_file_content",
  "edit_file",
  "write_to_file",
  "write_file",
]);

const NATIVE_READ_TOOLS = new Set([
  "view_file",
  "read_file",
  "view_file_outline",
  "view_code_item",
  "list_dir",
  "find_by_name",
  "grep_search",
]);

const INPUT_FIELD_TOOL_NAMES: ReadonlyArray<[string, string]> = [
  ["CommandLine", "run_command"],
  ["CommandId", "send_command_input"],
  ["Terminate", "send_command_input"],
  ["TypeName", "invoke_subagent"],
  ["ConversationIds", "manage_subagents"],
  ["ReplacementChunks", "multi_replace_file_content"],
  ["TargetContent", "replace_file_content"],
  ["ReplacementContent", "replace_file_content"],
  ["CodeContent", "write_to_file"],
  ["AbsolutePath", "view_file"],
  ["Query", "grep_search"],
  ["Pattern", "find_by_name"],
  ["DirectoryPath", "list_dir"],
];

export function mergeAcpToolCall(
  previous: AcpToolCallPayload | undefined,
  incoming: AcpToolCallPayload,
): AcpToolCallPayload {
  if (!previous) return incoming;
  return {
    toolCallId: incoming.toolCallId,
    name: incoming.name ?? previous.name,
    title: incoming.title ?? previous.title,
    kind: incoming.kind ?? previous.kind,
    status: incoming.status ?? previous.status,
    rawInput: incoming.rawInput !== undefined ? incoming.rawInput : previous.rawInput,
    rawOutput: incoming.rawOutput !== undefined ? incoming.rawOutput : previous.rawOutput,
    locations: incoming.locations ?? previous.locations,
    content: incoming.content ?? previous.content,
  };
}

export function inferToolName(tool: AcpToolCallPayload): string {
  const explicitName = tool.name?.trim();
  if (explicitName) return explicitName;
  const title = tool.title?.trim();
  if (title && looksLikeMcpIdentifier(title)) return title;
  const input = asRecord(tool.rawInput);
  if (input) {
    const inferred = inferToolNameFromInput(input);
    if (inferred) return inferred;
  }
  return title || tool.kind?.trim() || "tool";
}

function inferToolNameFromInput(input: Record<string, unknown>): string | undefined {
  const explicit = stringField(input, "toolName") ?? stringField(input, "_toolName");
  if (explicit) return explicit;
  if ("ServerName" in input && "ToolName" in input) return "call_mcp_tool";
  for (const [field, toolName] of INPUT_FIELD_TOOL_NAMES) {
    if (field in input) return toolName;
  }
  if ("Replacement" in input && "Target" in input) return "edit_file";
  if ("Content" in input && ("TargetFile" in input || "Path" in input)) return "write_to_file";
  return "Path" in input && !("Content" in input) ? "view_file" : undefined;
}

export function mapAcpToolCall(
  tool: AcpToolCallPayload,
): Extract<ProviderTimelineItem, { type: "tool_call" }> {
  const name = inferToolName(tool);
  const input = jsonRecord(tool.rawInput);
  const output = extractToolOutputText(tool);
  const detail = mapAcpToolDetail(tool, name, input, output);
  if (tool.status === "failed") {
    return {
      type: "tool_call",
      id: tool.toolCallId,
      callId: tool.toolCallId,
      name,
      status: "failed",
      error: output ?? "Tool call failed",
      detail,
    };
  }
  return {
    type: "tool_call",
    id: tool.toolCallId,
    callId: tool.toolCallId,
    name,
    status: tool.status === "completed" ? "completed" : "running",
    error: null,
    detail,
  };
}

export function mapAcpToolDetail(
  tool: AcpToolCallPayload,
  name = inferToolName(tool),
  input = jsonRecord(tool.rawInput),
  output = extractToolOutputText(tool),
): ProviderToolCallDetail {
  const rawInput = input ?? {};
  const rawOutput = asRecord(tool.rawOutput);
  return (
    trySubAgentDetail(name, rawInput, rawOutput, output) ??
    tryShellDetail(tool, name, rawInput, rawOutput, output) ??
    tryFileDetail(tool, name, rawInput, output) ??
    tryFetchDetail(tool, name, rawInput, output) ??
    trySearchDetail(tool, name, rawInput, output) ?? {
      type: "unknown",
      input: (tool.rawInput as JsonValue | undefined) ?? null,
      output: (tool.rawOutput as JsonValue | undefined) ?? output ?? null,
    }
  );
}

/**
 * Security check for `accept-edits` mode: decoupled from `mapAcpToolDetail` so external MCP tools
 * with `query` arguments are never auto-approved unless explicitly preapproved in `toolPolicy`.
 */
export function isSafeAcceptEditsTool(
  tool: AcpToolCallPayload,
  name = inferToolName(tool),
): boolean {
  if (isExternalOrMcpTool(tool, name)) return false;
  if (tool.kind === "execute" || name === "run_command" || name === "send_command_input") {
    return false;
  }
  if (NATIVE_ACCEPT_EDITS_TOOLS.has(name)) return true;
  if (tool.kind === "read" || tool.kind === "edit" || tool.kind === "write") {
    return hasNativeFileEvidence(tool);
  }
  return false;
}

export function isNativeReadTool(tool: AcpToolCallPayload, name = inferToolName(tool)): boolean {
  if (isExternalOrMcpTool(tool, name)) return false;
  if (NATIVE_READ_TOOLS.has(name)) return true;
  return tool.kind === "read" && hasNativeFileEvidence(tool);
}

export function matchesPreapprovedMcpTool(
  tool: AcpToolCallPayload,
  name: string,
  policy: ProviderToolPolicy | undefined,
): boolean {
  if (!policy || policy.preapproved.length === 0) return false;
  const parsed = extractMcpIdentity(tool, name);
  if (!parsed) return false;
  return policy.preapproved.some(
    (entry) => entry.kind === "mcp" && entry.server === parsed.server && entry.tool === parsed.tool,
  );
}

function extractMcpIdentity(
  tool: AcpToolCallPayload,
  name: string,
): { server: string; tool: string } | null {
  for (const candidate of [tool.name, name, tool.title]) {
    const trimmed = candidate?.trim();
    if (!trimmed) continue;
    const dunder = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(trimmed);
    if (dunder) return { server: dunder[1]!, tool: dunder[2]! };
    const slash = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(trimmed);
    if (slash) return { server: slash[1]!, tool: slash[2]! };
    const colon = /^mcp:([A-Za-z0-9._-]+):([A-Za-z0-9._-]+)$/.exec(trimmed);
    if (colon) return { server: colon[1]!, tool: colon[2]! };
  }

  const isWrapper =
    name === "call_mcp_tool" ||
    tool.name === "call_mcp_tool" ||
    name === "call_mcp" ||
    tool.name === "call_mcp";
  if (isWrapper) {
    const rawInput = asRecord(tool.rawInput);
    const wrapperServer =
      stringField(rawInput, "ServerName") ?? stringField(rawInput, "serverName");
    const wrapperTool = stringField(rawInput, "ToolName") ?? stringField(rawInput, "toolName");
    if (wrapperServer && wrapperTool) return { server: wrapperServer, tool: wrapperTool };
  }

  return null;
}

function looksLikeMcpIdentifier(value: string): boolean {
  return (
    value.startsWith("mcp__") ||
    value.startsWith("mcp:") ||
    /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value)
  );
}

function isExternalOrMcpTool(tool: AcpToolCallPayload, name: string): boolean {
  if (name === "call_mcp_tool" || extractMcpIdentity(tool, name) !== null) return true;
  const rawInput = asRecord(tool.rawInput);
  if (rawInput && ("ServerName" in rawInput || "serverName" in rawInput)) return true;
  return looksLikeMcpIdentifier(name) || Boolean(tool.title && looksLikeMcpIdentifier(tool.title));
}

function hasNativeFileEvidence(tool: AcpToolCallPayload): boolean {
  if (tool.content?.some((item) => item.type === "diff")) return true;
  if (tool.locations?.some((loc) => Boolean(loc.path))) return true;
  const rawInput = asRecord(tool.rawInput);
  return Boolean(
    rawInput &&
    (typeof rawInput.AbsolutePath === "string" ||
      typeof rawInput.TargetFile === "string" ||
      typeof rawInput.Path === "string"),
  );
}

function trySubAgentDetail(
  name: string,
  rawInput: Record<string, unknown>,
  rawOutput: Record<string, unknown> | undefined,
  output: string | undefined,
): ProviderToolCallDetail | undefined {
  if (
    name !== "invoke_subagent" &&
    name !== "manage_subagents" &&
    !("TypeName" in rawInput) &&
    !("ConversationIds" in rawInput)
  ) {
    return undefined;
  }
  const childSessionId =
    firstString(rawOutput?.conversationIds) ??
    stringField(rawOutput, "conversationId") ??
    firstString(rawInput.ConversationIds) ??
    extractSubagentId(output);
  const agentType = stringField(rawInput, "TypeName");
  const description = stringField(rawInput, "Role");
  return {
    type: "sub_agent",
    ...(childSessionId ? { childSessionId } : {}),
    ...(agentType ? { subAgentType: agentType } : {}),
    ...(description ? { description } : {}),
    log: output ?? stringField(rawInput, "Prompt") ?? "",
  };
}

function tryShellDetail(
  tool: AcpToolCallPayload,
  name: string,
  rawInput: Record<string, unknown>,
  rawOutput: Record<string, unknown> | undefined,
  output: string | undefined,
): ProviderToolCallDetail | undefined {
  const command =
    stringField(rawInput, "CommandLine") ??
    stringField(rawInput, "command") ??
    (tool.kind === "execute" ? tool.title?.trim() : undefined);
  if (!command && name !== "run_command" && tool.kind !== "execute") return undefined;
  const cwd = stringField(rawInput, "Cwd") ?? stringField(rawInput, "cwd");
  const exitCode = typeof rawOutput?.exitCode === "number" ? rawOutput.exitCode : undefined;
  return {
    type: "shell",
    command: command || name,
    ...(cwd ? { cwd } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
  };
}

function tryFileDetail(
  tool: AcpToolCallPayload,
  name: string,
  rawInput: Record<string, unknown>,
  output: string | undefined,
): ProviderToolCallDetail | undefined {
  const diffItem = tool.content?.find((item) => item.type === "diff");
  if (diffItem) {
    return {
      type: "edit",
      filePath: diffItem.path,
      ...(diffItem.oldText ? { oldString: diffItem.oldText } : {}),
      newString: diffItem.newText,
    };
  }
  const filePath = resolveToolFilePath(tool, rawInput);
  if (!filePath) return undefined;

  if (isEditToolName(tool.kind, name)) {
    const oldString =
      stringField(rawInput, "TargetContent") ??
      stringField(rawInput, "Target") ??
      joinChunkField(rawInput.ReplacementChunks, "TargetContent");
    const newString =
      stringField(rawInput, "ReplacementContent") ??
      stringField(rawInput, "Replacement") ??
      joinChunkField(rawInput.ReplacementChunks, "ReplacementContent");
    return {
      type: "edit",
      filePath,
      ...(oldString !== undefined ? { oldString } : {}),
      ...(newString !== undefined ? { newString } : {}),
    };
  }

  const writeContent = stringField(rawInput, "CodeContent") ?? stringField(rawInput, "Content");
  if (writeContent !== undefined || isWriteToolName(tool.kind, name)) {
    return {
      type: "write",
      filePath,
      ...(writeContent !== undefined ? { content: writeContent } : {}),
    };
  }

  if (isReadToolName(tool.kind, name) || "AbsolutePath" in rawInput) {
    return buildReadDetail(tool, rawInput, filePath, output);
  }
  return undefined;
}

function tryFetchDetail(
  tool: AcpToolCallPayload,
  name: string,
  rawInput: Record<string, unknown>,
  output: string | undefined,
): ProviderToolCallDetail | undefined {
  const url = stringField(rawInput, "Url") ?? stringField(rawInput, "url");
  if (!url || (tool.kind !== "fetch" && name !== "read_url_content")) return undefined;
  return { type: "fetch", url, ...(output !== undefined ? { result: output } : {}) };
}

function resolveToolFilePath(
  tool: AcpToolCallPayload,
  rawInput: Record<string, unknown>,
): string | undefined {
  return (
    stringField(rawInput, "TargetFile") ??
    stringField(rawInput, "AbsolutePath") ??
    stringField(rawInput, "Path") ??
    stringField(rawInput, "filePath") ??
    tool.locations?.[0]?.path
  );
}

function isEditToolName(kind: string | null | undefined, name: string): boolean {
  return (
    kind === "edit" ||
    name === "replace_file_content" ||
    name === "multi_replace_file_content" ||
    name === "edit_file"
  );
}

function isWriteToolName(kind: string | null | undefined, name: string): boolean {
  return kind === "write" || name === "write_to_file" || name === "write_file";
}

function isReadToolName(kind: string | null | undefined, name: string): boolean {
  return kind === "read" || name === "view_file" || name === "read_file";
}

function buildReadDetail(
  tool: AcpToolCallPayload,
  rawInput: Record<string, unknown>,
  filePath: string,
  output: string | undefined,
): ProviderToolCallDetail {
  const startLine = numberField(rawInput, "StartLine") ?? tool.locations?.[0]?.line ?? undefined;
  const endLine = numberField(rawInput, "EndLine");
  const limit =
    startLine !== undefined && endLine !== undefined && endLine >= startLine
      ? endLine - startLine + 1
      : undefined;
  return {
    type: "read",
    filePath,
    ...(output !== undefined ? { content: output } : {}),
    ...(startLine !== undefined ? { offset: startLine } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

function mapSearchToolName(name: string): "grep" | "glob" | "web_search" | undefined {
  if (name === "grep_search") return "grep";
  if (name === "find_by_name") return "glob";
  return name === "search_web" ? "web_search" : undefined;
}

function trySearchDetail(
  tool: AcpToolCallPayload,
  name: string,
  rawInput: Record<string, unknown>,
  output: string | undefined,
): ProviderToolCallDetail | undefined {
  const query =
    stringField(rawInput, "Query") ??
    stringField(rawInput, "Pattern") ??
    stringField(rawInput, "SearchPath") ??
    stringField(rawInput, "DirectoryPath") ??
    stringField(rawInput, "query");
  if (!query && tool.kind !== "search") return undefined;
  const toolName = mapSearchToolName(name);
  return {
    type: "search",
    query: query || tool.title?.trim() || name,
    ...(toolName ? { toolName } : {}),
    ...(output !== undefined ? { content: output } : {}),
  };
}

export function extractTargetPaths(
  tool: AcpToolCallPayload,
  detail: ProviderToolCallDetail,
): string[] {
  const paths = new Set<string>();
  if (detail.type === "read" || detail.type === "write" || detail.type === "edit") {
    paths.add(detail.filePath);
  }
  for (const loc of tool.locations ?? []) {
    if (loc.path) paths.add(loc.path);
  }
  const input = asRecord(tool.rawInput);
  if (input) {
    for (const key of ["AbsolutePath", "Path", "TargetFile", "SearchPath", "DirectoryPath"]) {
      const value = stringField(input, key);
      if (value) paths.add(value);
    }
  }
  return [...paths];
}

function extractToolOutputText(tool: AcpToolCallPayload): string | undefined {
  const parts: string[] = [];
  for (const item of tool.content ?? []) {
    if (item.type === "content" && item.content.type === "text" && item.content.text) {
      parts.push(item.content.text);
    }
  }
  if (parts.length > 0) return parts.join("\n");
  if (typeof tool.rawOutput === "string") return tool.rawOutput;
  const record = asRecord(tool.rawOutput);
  if (!record) return undefined;
  return (
    stringField(record, "output") ??
    stringField(record, "content") ??
    stringField(record, "result") ??
    stringField(record, "error")
  );
}

function extractSubagentId(output: string | undefined): string | undefined {
  if (!output) return undefined;
  return (
    /conversation:\/\/([0-9a-f-]{36})/i.exec(output)?.[1] ??
    /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i.exec(output)?.[1]
  );
}

function joinChunkField(chunks: unknown, key: string): string | undefined {
  if (!Array.isArray(chunks)) return undefined;
  const parts = chunks
    .map((chunk) => stringField(asRecord(chunk), key))
    .filter((value): value is string => value !== undefined);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function jsonRecord(value: unknown): Record<string, JsonValue> | undefined {
  return asRecord(value) as Record<string, JsonValue> | undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstString(value: unknown): string | undefined {
  const first = Array.isArray(value) ? value[0] : undefined;
  return typeof first === "string" && first.length > 0 ? first : undefined;
}
