import type {
  ProviderTimelineItem,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";
import type { AcpToolCallPayload, JsonValue } from "./wire.js";

export function mergeAcpToolCall(
  previous: AcpToolCallPayload | undefined,
  incoming: AcpToolCallPayload,
): AcpToolCallPayload {
  if (!previous) return incoming;
  return {
    toolCallId: incoming.toolCallId,
    title: incoming.title ?? previous.title,
    kind: incoming.kind ?? previous.kind,
    status: incoming.status ?? previous.status,
    rawInput: incoming.rawInput !== undefined ? incoming.rawInput : previous.rawInput,
    rawOutput: incoming.rawOutput !== undefined ? incoming.rawOutput : previous.rawOutput,
    locations: incoming.locations ?? previous.locations,
    content: incoming.content ?? previous.content,
  };
}

const INPUT_FIELD_TOOL_NAMES: ReadonlyArray<[string, string]> = [
  ["CommandLine", "run_command"],
  ["CommandId", "send_command_input"],
  ["Terminate", "send_command_input"],
  ["TypeName", "invoke_subagent"],
  ["ConversationIds", "invoke_subagent"],
  ["ReplacementChunks", "multi_replace_file_content"],
  ["TargetContent", "replace_file_content"],
  ["ReplacementContent", "replace_file_content"],
  ["CodeContent", "write_to_file"],
  ["AbsolutePath", "view_file"],
  ["Query", "grep_search"],
  ["Pattern", "find_by_name"],
  ["DirectoryPath", "list_dir"],
];

export function inferToolName(tool: AcpToolCallPayload): string {
  const input = asRecord(tool.rawInput);
  if (input) {
    const inferred = inferToolNameFromInput(input);
    if (inferred) return inferred;
  }
  const title = tool.title?.trim();
  if (title) return title;
  return tool.kind?.trim() || "tool";
}

function inferToolNameFromInput(input: Record<string, unknown>): string | undefined {
  const explicit = stringField(input, "toolName") ?? stringField(input, "_toolName");
  if (explicit) return explicit;
  for (const [field, toolName] of INPUT_FIELD_TOOL_NAMES) {
    if (field in input) return toolName;
  }
  if ("Replacement" in input && "Target" in input) return "edit_file";
  if ("Content" in input && ("TargetFile" in input || "Path" in input)) return "write_to_file";
  if ("Path" in input && !("Content" in input)) return "view_file";
  return undefined;
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
  const status = tool.status === "completed" ? "completed" : "running";
  return {
    type: "tool_call",
    id: tool.toolCallId,
    callId: tool.toolCallId,
    name,
    status,
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
    trySearchDetail(tool, name, rawInput) ?? {
      type: "unknown",
      input: (tool.rawInput as JsonValue | undefined) ?? null,
      output: (tool.rawOutput as JsonValue | undefined) ?? output ?? null,
    }
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
  const prompt = stringField(rawInput, "Prompt");
  return {
    type: "sub_agent",
    ...(childSessionId ? { childSessionId } : {}),
    ...(agentType ? { subAgentType: agentType } : {}),
    ...(description ? { description } : {}),
    log: output ?? prompt ?? "",
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
  if (!command && name !== "run_command" && tool.kind !== "execute") {
    return undefined;
  }
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
  const filePath = resolveToolFilePath(tool, rawInput, diffItem?.path);
  if (diffItem) {
    return {
      type: "edit",
      filePath: diffItem.path,
      ...(diffItem.oldText ? { oldString: diffItem.oldText } : {}),
      newString: diffItem.newText,
    };
  }
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

function resolveToolFilePath(
  tool: AcpToolCallPayload,
  rawInput: Record<string, unknown>,
  diffPath: string | undefined,
): string | undefined {
  return (
    diffPath ??
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

const NATIVE_ACCEPT_EDITS_TOOLS = new Set([
  "replace_file_content",
  "multi_replace_file_content",
  "edit_file",
  "write_to_file",
  "write_file",
  "view_file",
  "read_file",
  "grep_search",
  "find_by_name",
  "list_dir",
  "view_file_outline",
  "view_code_item",
]);

const NATIVE_READ_TOOLS = new Set([
  "view_file",
  "read_file",
  "view_file_outline",
  "view_code_item",
]);

const ACCEPT_EDITS_KINDS = new Set(["edit", "write", "delete", "move", "read", "search"]);

function trySearchDetail(
  tool: AcpToolCallPayload,
  name: string,
  rawInput: Record<string, unknown>,
): ProviderToolCallDetail | undefined {
  const isSearchTool = tool.kind === "search" || name === "grep_search" || name === "find_by_name";
  const query =
    stringField(rawInput, "Query") ??
    stringField(rawInput, "Pattern") ??
    stringField(rawInput, "SearchPath") ??
    stringField(rawInput, "DirectoryPath") ??
    (isSearchTool ? stringField(rawInput, "query") : undefined);
  if (!query && !isSearchTool) return undefined;
  return {
    type: "search",
    query: query || tool.title?.trim() || name,
  };
}

function isExternalToolIdentity(
  tool: AcpToolCallPayload,
  rawInput: Record<string, unknown> | undefined,
): boolean {
  const explicit = rawInput
    ? (stringField(rawInput, "toolName") ?? stringField(rawInput, "_toolName"))
    : undefined;
  if (explicit) return !NATIVE_ACCEPT_EDITS_TOOLS.has(explicit);
  const title = tool.title?.trim();
  if (!title) return false;
  return /^mcp__/i.test(title) || /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(title);
}

export function isEditOrReadTool(tool: AcpToolCallPayload): boolean {
  const rawInput = asRecord(tool.rawInput);
  if (isExternalToolIdentity(tool, rawInput)) return false;
  if (tool.kind) return ACCEPT_EDITS_KINDS.has(tool.kind);
  const inferred = rawInput ? inferToolNameFromInput(rawInput) : undefined;
  if (inferred) return NATIVE_ACCEPT_EDITS_TOOLS.has(inferred);
  const title = tool.title?.trim();
  return Boolean(title && NATIVE_ACCEPT_EDITS_TOOLS.has(title));
}

export function isNativeReadTool(tool: AcpToolCallPayload): boolean {
  const rawInput = asRecord(tool.rawInput);
  if (isExternalToolIdentity(tool, rawInput)) return false;
  if (tool.kind) return tool.kind === "read";
  const inferred = rawInput ? inferToolNameFromInput(rawInput) : undefined;
  if (inferred) return NATIVE_READ_TOOLS.has(inferred);
  const title = tool.title?.trim();
  return Boolean(title && NATIVE_READ_TOOLS.has(title));
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
  if (record) {
    if (typeof record.output === "string") return record.output;
    if (typeof record.content === "string") return record.content;
    if (typeof record.result === "string") return record.result;
    if (typeof record.error === "string") return record.error;
  }
  return undefined;
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
    .map((chunk) =>
      typeof chunk === "object" && chunk !== null && !Array.isArray(chunk)
        ? stringField(chunk as Record<string, unknown>, key)
        : undefined,
    )
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
  if (!Array.isArray(value)) return undefined;
  const first = value[0];
  return typeof first === "string" && first.length > 0 ? first : undefined;
}
