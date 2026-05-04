import { z } from "zod";

import type { ToolCallTimelineItem } from "../../agent-sdk-types.js";
import { isSpeakToolName } from "../../tool-name-normalization.js";
import { deriveClaudeToolDetail } from "./tool-call-detail-parser.js";

interface MapperParams {
  callId?: string | null;
  name: string;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
}

const ClaudeToolCallStatusSchema = z.enum(["running", "completed", "failed", "canceled"]);
type ClaudeToolCallStatus = z.infer<typeof ClaudeToolCallStatusSchema>;

const ClaudeRawToolCallSchema = z
  .object({
    callId: z.string().optional().nullable(),
    name: z.string().min(1),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    error: z.unknown().nullable().optional(),
    status: ClaudeToolCallStatusSchema,
  })
  .passthrough();

type ClaudeToolKind =
  | "shell"
  | "read"
  | "write"
  | "edit"
  | "search"
  | "fetch"
  | "speak"
  | "unknown";

const SHELL_NAMES: ReadonlySet<string> = new Set(["Bash", "bash", "shell", "exec_command"]);
const READ_NAMES: ReadonlySet<string> = new Set(["Read", "read", "read_file", "view_file"]);
const WRITE_NAMES: ReadonlySet<string> = new Set(["Write", "write", "write_file", "create_file"]);
const EDIT_NAMES: ReadonlySet<string> = new Set([
  "Edit",
  "MultiEdit",
  "multi_edit",
  "edit",
  "apply_patch",
  "apply_diff",
  "str_replace_editor",
]);
const SEARCH_NAMES: ReadonlySet<string> = new Set([
  "WebSearch",
  "web_search",
  "search",
  "Grep",
  "grep",
  "Glob",
  "glob",
]);
const FETCH_NAMES: ReadonlySet<string> = new Set([
  "WebFetch",
  "web_fetch",
  "WebFetchTool",
  "web_fetch_tool",
  "webfetch",
]);

function resolveClaudeToolKind(name: string): ClaudeToolKind {
  if (SHELL_NAMES.has(name)) return "shell";
  if (READ_NAMES.has(name)) return "read";
  if (WRITE_NAMES.has(name)) return "write";
  if (EDIT_NAMES.has(name)) return "edit";
  if (SEARCH_NAMES.has(name)) return "search";
  if (FETCH_NAMES.has(name)) return "fetch";
  if (isSpeakToolName(name)) return "speak";
  return "unknown";
}

function resolveDetailName(toolKind: ClaudeToolKind, name: string): string {
  switch (toolKind) {
    case "shell":
      return "shell";
    case "read":
      return "read_file";
    case "write":
      return "write_file";
    case "edit":
      return "apply_patch";
    case "search":
    case "fetch":
      return name;
    case "speak":
      return "speak";
    default:
      return name;
  }
}

function mapClaudeToolCall(
  params: MapperParams,
  status: ClaudeToolCallStatus,
  error: unknown,
): ToolCallTimelineItem | null {
  const parsed = ClaudeRawToolCallSchema.safeParse({ ...params, status, error });
  if (!parsed.success) {
    return null;
  }
  const raw = parsed.data;
  const callId = typeof raw.callId === "string" && raw.callId.trim().length > 0 ? raw.callId : null;
  if (callId === null) {
    return null;
  }

  const trimmedName = raw.name.trim();
  const toolKind = resolveClaudeToolKind(trimmedName);
  const name = toolKind === "speak" ? "speak" : trimmedName;
  const input = raw.input ?? null;
  const output = raw.output ?? null;
  const detail = deriveClaudeToolDetail(resolveDetailName(toolKind, name), input, output);

  if (raw.status === "failed") {
    return {
      type: "tool_call",
      callId,
      name,
      detail,
      status: "failed",
      error: raw.error ?? { message: "Tool call failed" },
      ...(raw.metadata ? { metadata: raw.metadata } : {}),
    };
  }
  return {
    type: "tool_call",
    callId,
    name,
    detail,
    status: raw.status,
    error: null,
    ...(raw.metadata ? { metadata: raw.metadata } : {}),
  };
}

export function mapClaudeRunningToolCall(params: MapperParams): ToolCallTimelineItem | null {
  return mapClaudeToolCall(params, "running", null);
}

export function mapClaudeCompletedToolCall(params: MapperParams): ToolCallTimelineItem | null {
  return mapClaudeToolCall(params, "completed", null);
}

export function mapClaudeFailedToolCall(
  params: MapperParams & { error: unknown },
): ToolCallTimelineItem | null {
  return mapClaudeToolCall(params, "failed", params.error);
}

export function mapClaudeCanceledToolCall(params: MapperParams): ToolCallTimelineItem | null {
  return mapClaudeToolCall(params, "canceled", null);
}
