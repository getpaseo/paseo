import { z } from "zod";

import type { ToolCallTimelineItem } from "../../agent-sdk-types.js";
import { isSpeakToolName } from "../../tool-name-normalization.js";
import { deriveClaudeToolDetail } from "./tool-call-detail-parser.js";

type MapperParams = {
  callId?: string | null;
  name: string;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
};

const ClaudeToolCallStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "canceled",
]);

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

const ClaudeToolCallPass1Schema = ClaudeRawToolCallSchema.transform((raw) => ({
  callId:
    typeof raw.callId === "string" && raw.callId.trim().length > 0
      ? raw.callId
      : null,
  name: raw.name.trim(),
  input: raw.input ?? null,
  output: raw.output ?? null,
  metadata: raw.metadata,
  error: raw.error ?? null,
  status: raw.status,
}));

const ClaudeShellToolNameSchema = z.union([
  z.literal("Bash"),
  z.literal("bash"),
  z.literal("shell"),
  z.literal("exec_command"),
]);
const ClaudeReadToolNameSchema = z.union([
  z.literal("Read"),
  z.literal("read"),
  z.literal("read_file"),
  z.literal("view_file"),
]);
const ClaudeWriteToolNameSchema = z.union([
  z.literal("Write"),
  z.literal("write"),
  z.literal("write_file"),
  z.literal("create_file"),
]);
const ClaudeEditToolNameSchema = z.union([
  z.literal("Edit"),
  z.literal("MultiEdit"),
  z.literal("multi_edit"),
  z.literal("edit"),
  z.literal("apply_patch"),
  z.literal("apply_diff"),
  z.literal("str_replace_editor"),
]);
const ClaudeSearchToolNameSchema = z.union([
  z.literal("WebSearch"),
  z.literal("web_search"),
  z.literal("search"),
]);
const ClaudeSpeakToolNameSchema = z
  .string()
  .min(1)
  .refine((name) => isSpeakToolName(name.trim()));

const ClaudeToolKindSchema = z.enum([
  "shell",
  "read",
  "write",
  "edit",
  "search",
  "speak",
  "unknown",
]);

const ClaudeToolCallPass2BaseSchema = z.object({
  callId: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown().nullable(),
  output: z.unknown().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  error: z.unknown().nullable(),
  status: ClaudeToolCallStatusSchema,
  toolKind: ClaudeToolKindSchema,
});

const ClaudeToolCallPass2InputSchema = ClaudeToolCallPass2BaseSchema.omit({
  toolKind: true,
});

const ClaudeToolCallPass2EnvelopeSchema = z.union([
  ClaudeToolCallPass2InputSchema.extend({
    name: ClaudeShellToolNameSchema,
  }).transform((normalized) => ({
    ...normalized,
    name: normalized.name.trim(),
    toolKind: "shell" as const,
  })),
  ClaudeToolCallPass2InputSchema.extend({
    name: ClaudeReadToolNameSchema,
  }).transform((normalized) => ({
    ...normalized,
    name: normalized.name.trim(),
    toolKind: "read" as const,
  })),
  ClaudeToolCallPass2InputSchema.extend({
    name: ClaudeWriteToolNameSchema,
  }).transform((normalized) => ({
    ...normalized,
    name: normalized.name.trim(),
    toolKind: "write" as const,
  })),
  ClaudeToolCallPass2InputSchema.extend({
    name: ClaudeEditToolNameSchema,
  }).transform((normalized) => ({
    ...normalized,
    name: normalized.name.trim(),
    toolKind: "edit" as const,
  })),
  ClaudeToolCallPass2InputSchema.extend({
    name: ClaudeSearchToolNameSchema,
  }).transform((normalized) => ({
    ...normalized,
    name: normalized.name.trim(),
    toolKind: "search" as const,
  })),
  ClaudeToolCallPass2InputSchema.extend({
    name: ClaudeSpeakToolNameSchema,
  }).transform((normalized) => ({
    ...normalized,
    name: "speak" as const,
    toolKind: "speak" as const,
  })),
  ClaudeToolCallPass2InputSchema.transform((normalized) => ({
    ...normalized,
    name: normalized.name.trim(),
    toolKind: "unknown" as const,
  })),
]);

const ClaudeToolCallPass2Schema = z.discriminatedUnion("toolKind", [
  ClaudeToolCallPass2BaseSchema.extend({
    toolKind: z.literal("shell"),
    name: ClaudeShellToolNameSchema,
  }),
  ClaudeToolCallPass2BaseSchema.extend({
    toolKind: z.literal("read"),
    name: ClaudeReadToolNameSchema,
  }),
  ClaudeToolCallPass2BaseSchema.extend({
    toolKind: z.literal("write"),
    name: ClaudeWriteToolNameSchema,
  }),
  ClaudeToolCallPass2BaseSchema.extend({
    toolKind: z.literal("edit"),
    name: ClaudeEditToolNameSchema,
  }),
  ClaudeToolCallPass2BaseSchema.extend({
    toolKind: z.literal("search"),
    name: ClaudeSearchToolNameSchema,
  }),
  ClaudeToolCallPass2BaseSchema.extend({
    toolKind: z.literal("speak"),
    name: z.literal("speak"),
  }),
  ClaudeToolCallPass2BaseSchema.extend({
    toolKind: z.literal("unknown"),
  }),
]);

type ClaudeToolCallPass2 = z.infer<typeof ClaudeToolCallPass2Schema>;

function toToolCallTimelineItem(normalized: ClaudeToolCallPass2): ToolCallTimelineItem {
  const name = normalized.toolKind === "speak" ? ("speak" as const) : normalized.name;
  const detailName =
    normalized.toolKind === "shell"
      ? "shell"
      : normalized.toolKind === "read"
        ? "read_file"
        : normalized.toolKind === "write"
          ? "write_file"
          : normalized.toolKind === "edit"
            ? "apply_patch"
            : normalized.toolKind === "search"
              ? "search"
              : normalized.toolKind === "speak"
                ? "speak"
                : normalized.name;
  const detail = deriveClaudeToolDetail(detailName, normalized.input, normalized.output);
  if (normalized.status === "failed") {
    return {
      type: "tool_call",
      callId: normalized.callId,
      name,
      detail,
      status: "failed",
      error: normalized.error ?? { message: "Tool call failed" },
      ...(normalized.metadata ? { metadata: normalized.metadata } : {}),
    };
  }
  return {
    type: "tool_call",
    callId: normalized.callId,
    name,
    detail,
    status: normalized.status,
    error: null,
    ...(normalized.metadata ? { metadata: normalized.metadata } : {}),
  };
}

function mapClaudeToolCall(
  params: MapperParams,
  status: z.infer<typeof ClaudeToolCallStatusSchema>,
  error: unknown | null
): ToolCallTimelineItem | null {
  const pass1 = ClaudeToolCallPass1Schema.safeParse({
    ...params,
    status,
    error,
  });
  if (!pass1.success) {
    return null;
  }

  const pass2Envelope = ClaudeToolCallPass2EnvelopeSchema.safeParse(pass1.data);
  if (!pass2Envelope.success) {
    return null;
  }

  const pass2 = ClaudeToolCallPass2Schema.safeParse(pass2Envelope.data);
  if (!pass2.success) {
    return null;
  }

  return toToolCallTimelineItem(pass2.data);
}

export function mapClaudeRunningToolCall(
  params: MapperParams
): ToolCallTimelineItem | null {
  return mapClaudeToolCall(params, "running", null);
}

export function mapClaudeCompletedToolCall(
  params: MapperParams
): ToolCallTimelineItem | null {
  return mapClaudeToolCall(params, "completed", null);
}

export function mapClaudeFailedToolCall(
  params: MapperParams & { error: unknown }
): ToolCallTimelineItem | null {
  return mapClaudeToolCall(params, "failed", params.error);
}

export function mapClaudeCanceledToolCall(
  params: MapperParams
): ToolCallTimelineItem | null {
  return mapClaudeToolCall(params, "canceled", null);
}
