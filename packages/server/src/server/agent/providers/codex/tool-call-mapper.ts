import { z } from "zod";

import type { ToolCallDetail, ToolCallTimelineItem } from "../../agent-sdk-types.js";
import { CommandValueSchema } from "../tool-call-detail-primitives.js";
import {
  coerceToolCallId,
  commandFromValue,
  truncateDiffText,
} from "../tool-call-mapper-utils.js";
import {
  CODEX_BUILTIN_TOOL_NAMES,
  deriveCodexToolDetail,
  normalizeCodexFilePath,
} from "./tool-call-detail-parser.js";

type CodexMapperOptions = { cwd?: string | null };

const FAILED_STATUSES = new Set(["failed", "error", "errored", "rejected", "denied"]);
const CANCELED_STATUSES = new Set(["canceled", "cancelled", "interrupted", "aborted"]);
const COMPLETED_STATUSES = new Set(["completed", "complete", "done", "success", "succeeded"]);

const CodexRolloutToolCallParamsSchema = z
  .object({
    callId: z.string().optional().nullable(),
    name: z.string().min(1),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Thread-item parsing
// ---------------------------------------------------------------------------

const CodexCommandExecutionItemSchema = z
  .object({
    type: z.literal("commandExecution"),
    id: z.string().optional(),
    status: z.string().optional(),
    error: z.unknown().optional(),
    command: CommandValueSchema.optional(),
    cwd: z.string().optional(),
    aggregatedOutput: z.string().optional(),
    exitCode: z.number().nullable().optional(),
  })
  .passthrough();

const CodexFileChangeItemSchema = z
  .object({
    type: z.literal("fileChange"),
    id: z.string().optional(),
    status: z.string().optional(),
    error: z.unknown().optional(),
    changes: z
      .array(
        z
          .object({
            path: z.string().optional(),
            kind: z.string().optional(),
            diff: z.string().optional(),
          })
          .passthrough()
      )
      .optional(),
  })
  .passthrough();

const CodexMcpToolCallItemSchema = z
  .object({
    type: z.literal("mcpToolCall"),
    id: z.string().optional(),
    callID: z.string().optional(),
    call_id: z.string().optional(),
    status: z.string().optional(),
    error: z.unknown().optional(),
    tool: z.string().optional(),
    server: z.string().optional(),
    arguments: z.unknown().optional(),
    result: z.unknown().optional(),
  })
  .passthrough();

const CodexWebSearchItemSchema = z
  .object({
    type: z.literal("webSearch"),
    id: z.string().optional(),
    status: z.string().optional(),
    error: z.unknown().optional(),
    query: z.string().optional(),
    action: z.unknown().optional(),
  })
  .passthrough();

const CodexThreadItemSchema = z.discriminatedUnion("type", [
  CodexCommandExecutionItemSchema,
  CodexFileChangeItemSchema,
  CodexMcpToolCallItemSchema,
  CodexWebSearchItemSchema,
]);

function coerceCallId(raw: string | null | undefined, name: string, input: unknown): string {
  return coerceToolCallId({
    providerPrefix: "codex",
    rawCallId: raw,
    toolName: name,
    input,
  });
}

function resolveStatus(
  rawStatus: string | undefined,
  error: unknown,
  output: unknown
): ToolCallTimelineItem["status"] {
  if (error !== undefined && error !== null) {
    return "failed";
  }

  if (typeof rawStatus === "string") {
    const normalized = rawStatus.trim().toLowerCase();
    if (normalized.length > 0) {
      if (FAILED_STATUSES.has(normalized)) {
        return "failed";
      }
      if (CANCELED_STATUSES.has(normalized)) {
        return "canceled";
      }
      if (COMPLETED_STATUSES.has(normalized)) {
        return "completed";
      }
      return "running";
    }
  }

  return output !== null && output !== undefined ? "completed" : "running";
}

function buildToolCall(params: {
  callId: string;
  name: string;
  status: ToolCallTimelineItem["status"];
  input: unknown | null;
  output: unknown | null;
  error: unknown | null;
  detail?: ToolCallDetail;
  metadata?: Record<string, unknown>;
}): ToolCallTimelineItem {
  if (params.status === "failed") {
    return {
      type: "tool_call",
      callId: params.callId,
      name: params.name,
      status: "failed",
      input: params.input,
      output: params.output,
      error: params.error ?? { message: "Tool call failed" },
      ...(params.detail ? { detail: params.detail } : {}),
      ...(params.metadata ? { metadata: params.metadata } : {}),
    };
  }

  return {
    type: "tool_call",
    callId: params.callId,
    name: params.name,
    status: params.status,
    input: params.input,
    output: params.output,
    error: null,
    ...(params.detail ? { detail: params.detail } : {}),
    ...(params.metadata ? { metadata: params.metadata } : {}),
  };
}

function buildMcpToolName(server: string | undefined, tool: string): string {
  const trimmedTool = tool.trim();
  if (!trimmedTool) {
    return "tool";
  }

  if (CODEX_BUILTIN_TOOL_NAMES.has(trimmedTool)) {
    return trimmedTool;
  }

  const trimmedServer = typeof server === "string" ? server.trim() : "";
  if (trimmedServer.length > 0) {
    return `${trimmedServer}.${trimmedTool}`;
  }

  return trimmedTool;
}

function toNullableObject(value: Record<string, unknown>): Record<string, unknown> | null {
  return Object.keys(value).length > 0 ? value : null;
}

function mapCommandExecutionItem(
  item: z.infer<typeof CodexCommandExecutionItemSchema>
): ToolCallTimelineItem {
  const command = item.command ? commandFromValue(item.command) : undefined;
  const input = toNullableObject({
    ...(command !== undefined ? { command } : {}),
    ...(item.cwd !== undefined ? { cwd: item.cwd } : {}),
  });

  const output =
    item.aggregatedOutput !== undefined || item.exitCode !== undefined
      ? {
          ...(command !== undefined ? { command } : {}),
          ...(item.aggregatedOutput !== undefined ? { output: item.aggregatedOutput } : {}),
          ...(item.exitCode !== undefined ? { exitCode: item.exitCode } : {}),
        }
      : null;

  const detail = command
    ? {
        type: "shell" as const,
        command,
        ...(item.cwd ? { cwd: item.cwd } : {}),
        ...(item.aggregatedOutput ? { output: item.aggregatedOutput } : {}),
        ...(item.exitCode !== undefined ? { exitCode: item.exitCode } : {}),
      }
    : undefined;

  const name = "shell";
  const callId = coerceCallId(item.id, name, input);
  const error = item.error ?? null;
  const status = resolveStatus(item.status, error, output);

  return buildToolCall({
    callId,
    name,
    status,
    input,
    output,
    error,
    ...(detail ? { detail } : {}),
  });
}

function mapFileChangeItem(
  item: z.infer<typeof CodexFileChangeItemSchema>,
  options?: CodexMapperOptions
): ToolCallTimelineItem {
  const changes = item.changes ?? [];

  const files = changes
    .map((change) => {
      const pathValue =
        typeof change.path === "string"
          ? normalizeCodexFilePath(change.path.trim(), options?.cwd)
          : undefined;

      return {
        path: pathValue,
        kind: change.kind,
        diff: change.diff,
      };
    })
    .filter((change) => change.path !== undefined);

  const input = toNullableObject({
    ...(files.length > 0
      ? {
          files: files.map((file) => ({
            path: file.path,
            ...(file.kind !== undefined ? { kind: file.kind } : {}),
          })),
        }
      : {}),
  });

  const output = toNullableObject({
    ...(files.length > 0
      ? {
          files: files.map((file) => ({
            path: file.path,
            ...(file.kind !== undefined ? { kind: file.kind } : {}),
            ...(file.diff !== undefined ? { patch: truncateDiffText(file.diff) } : {}),
          })),
        }
      : {}),
  });

  const firstFile = files[0];
  const detail = firstFile?.path
    ? {
        type: "edit" as const,
        filePath: firstFile.path,
        ...(firstFile.diff !== undefined ? { unifiedDiff: truncateDiffText(firstFile.diff) } : {}),
      }
    : undefined;

  const name = "apply_patch";
  const callId = coerceCallId(item.id, name, input);
  const error = item.error ?? null;
  const status = resolveStatus(item.status, error, output);

  return buildToolCall({
    callId,
    name,
    status,
    input,
    output,
    error,
    ...(detail ? { detail } : {}),
  });
}

function mapMcpToolCallItem(
  item: z.infer<typeof CodexMcpToolCallItemSchema>,
  options?: CodexMapperOptions
): ToolCallTimelineItem {
  const tool = item.tool?.trim() || "tool";
  const name = buildMcpToolName(item.server, tool);
  const input = item.arguments ?? null;
  const output = item.result ?? null;
  const error = item.error ?? null;
  const callId = coerceCallId(item.id ?? item.callID ?? item.call_id, name, input);
  const status = resolveStatus(item.status, error, output);
  const detail = deriveCodexToolDetail({
    name: tool,
    input,
    output,
    cwd: options?.cwd ?? null,
  });

  return buildToolCall({
    callId,
    name,
    status,
    input,
    output,
    error,
    ...(detail ? { detail } : {}),
  });
}

function mapWebSearchItem(item: z.infer<typeof CodexWebSearchItemSchema>): ToolCallTimelineItem {
  const input = item.query !== undefined ? { query: item.query } : null;
  const output = item.action ?? null;
  const name = "web_search";
  const callId = coerceCallId(item.id, name, input);
  const error = item.error ?? null;
  const status = resolveStatus(item.status ?? "completed", error, output);
  const detail = item.query
    ? {
        type: "search" as const,
        query: item.query,
      }
    : undefined;

  return buildToolCall({
    callId,
    name,
    status,
    input,
    output,
    error,
    ...(detail ? { detail } : {}),
  });
}

function createCodexThreadItemToTimelineSchema(options?: CodexMapperOptions) {
  return CodexThreadItemSchema.transform((item): ToolCallTimelineItem => {
    switch (item.type) {
      case "commandExecution":
        return mapCommandExecutionItem(item);
      case "fileChange":
        return mapFileChangeItem(item, options);
      case "mcpToolCall":
        return mapMcpToolCallItem(item, options);
      case "webSearch":
        return mapWebSearchItem(item);
      default: {
        const exhaustiveCheck: never = item;
        throw new Error(`Unhandled Codex thread item type: ${String(exhaustiveCheck)}`);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function mapCodexToolCallFromThreadItem(
  item: unknown,
  options?: CodexMapperOptions
): ToolCallTimelineItem | null {
  const parsed = createCodexThreadItemToTimelineSchema(options).safeParse(item);
  if (!parsed.success) {
    return null;
  }
  return parsed.data;
}

export function mapCodexRolloutToolCall(params: {
  callId?: string | null;
  name: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
}): ToolCallTimelineItem {
  const parsed = CodexRolloutToolCallParamsSchema.parse(params);
  const input = parsed.input ?? null;
  const output = parsed.output ?? null;
  const error = parsed.error ?? null;
  const status = resolveStatus("completed", error, output);
  const callId = coerceCallId(parsed.callId, parsed.name, input);
  const detail = deriveCodexToolDetail({
    name: parsed.name,
    input,
    output,
    cwd: null,
  });

  return buildToolCall({
    callId,
    name: parsed.name,
    status,
    input,
    output,
    error,
    ...(detail ? { detail } : {}),
  });
}
