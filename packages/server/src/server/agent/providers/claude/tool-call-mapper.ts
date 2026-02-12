import { z } from "zod";

import type { ToolCallTimelineItem } from "../../agent-sdk-types.js";
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
    metadata: z.record(z.unknown()).optional(),
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

const ClaudeToolCallPass2BaseSchema = z.object({
  callId: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown().nullable(),
  output: z.unknown().nullable(),
  metadata: z.record(z.unknown()).optional(),
  error: z.unknown().nullable(),
  status: ClaudeToolCallStatusSchema,
  toolKind: z.enum(["speak", "other"]),
});

const ClaudeToolCallPass2InputSchema = ClaudeToolCallPass2BaseSchema.omit({
  toolKind: true,
}).transform((normalized) => ({
  ...normalized,
  name: normalized.name.trim(),
  toolKind: normalized.name.trim() === "mcp__paseo__speak" ? ("speak" as const) : ("other" as const),
}));

const ClaudeToolCallPass2Schema = z.discriminatedUnion("toolKind", [
  ClaudeToolCallPass2BaseSchema.extend({
    toolKind: z.literal("speak"),
    name: z.literal("mcp__paseo__speak"),
  }).transform((normalized): ToolCallTimelineItem => {
    const name = "speak" as const;
    const detail = deriveClaudeToolDetail(name, normalized.input, normalized.output);
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
  }),
  ClaudeToolCallPass2BaseSchema.extend({
    toolKind: z.literal("other"),
  }).transform((normalized): ToolCallTimelineItem => {
    const detail = deriveClaudeToolDetail(normalized.name, normalized.input, normalized.output);
    if (normalized.status === "failed") {
      return {
        type: "tool_call",
        callId: normalized.callId,
        name: normalized.name,
        detail,
        status: "failed",
        error: normalized.error ?? { message: "Tool call failed" },
        ...(normalized.metadata ? { metadata: normalized.metadata } : {}),
      };
    }
    return {
      type: "tool_call",
      callId: normalized.callId,
      name: normalized.name,
      detail,
      status: normalized.status,
      error: null,
      ...(normalized.metadata ? { metadata: normalized.metadata } : {}),
    };
  }),
]);

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

  const pass2Input = ClaudeToolCallPass2InputSchema.safeParse(pass1.data);
  if (!pass2Input.success) {
    return null;
  }

  const pass2 = ClaudeToolCallPass2Schema.safeParse(pass2Input.data);
  if (!pass2.success) {
    return null;
  }

  return pass2.data;
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
