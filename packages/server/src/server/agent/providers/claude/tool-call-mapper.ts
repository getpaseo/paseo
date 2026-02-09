import { z } from "zod";

import type { ToolCallDetail, ToolCallTimelineItem } from "../../agent-sdk-types.js";
import { coerceToolCallId } from "../tool-call-mapper-utils.js";
import { deriveClaudeToolDetail } from "./tool-call-detail-parser.js";

type MapperParams = {
  callId?: string | null;
  name: string;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
};

const ClaudeMapperParamsSchema = z
  .object({
    callId: z.string().optional().nullable(),
    name: z.string().min(1),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .passthrough();

const ClaudeFailedMapperParamsSchema = ClaudeMapperParamsSchema.extend({
  error: z.unknown(),
});

function coerceCallId(callId: string | null | undefined, name: string, input: unknown): string {
  return coerceToolCallId({
    providerPrefix: "claude",
    rawCallId: callId,
    toolName: name,
    input,
  });
}

function buildBase(params: MapperParams): {
  callId: string;
  name: string;
  input: unknown | null;
  output: unknown | null;
  detail?: ToolCallDetail;
  metadata?: Record<string, unknown>;
} {
  const parsedParams = ClaudeMapperParamsSchema.parse(params);
  const input = parsedParams.input ?? null;
  const output = parsedParams.output ?? null;
  const detail = deriveClaudeToolDetail(parsedParams.name, input, output);

  return {
    callId: coerceCallId(parsedParams.callId, parsedParams.name, input),
    name: parsedParams.name,
    input,
    output,
    ...(detail ? { detail } : {}),
    ...(parsedParams.metadata ? { metadata: parsedParams.metadata } : {}),
  };
}

export function mapClaudeRunningToolCall(params: MapperParams): ToolCallTimelineItem {
  const base = buildBase(params);
  return {
    type: "tool_call",
    ...base,
    status: "running",
    error: null,
  };
}

export function mapClaudeCompletedToolCall(params: MapperParams): ToolCallTimelineItem {
  const base = buildBase(params);
  return {
    type: "tool_call",
    ...base,
    status: "completed",
    error: null,
  };
}

export function mapClaudeFailedToolCall(
  params: MapperParams & { error: unknown }
): ToolCallTimelineItem {
  const parsedParams = ClaudeFailedMapperParamsSchema.parse(params);
  const base = buildBase(parsedParams);
  return {
    type: "tool_call",
    ...base,
    status: "failed",
    error: parsedParams.error,
  };
}

export function mapClaudeCanceledToolCall(params: MapperParams): ToolCallTimelineItem {
  const base = buildBase(params);
  return {
    type: "tool_call",
    ...base,
    status: "canceled",
    error: null,
  };
}
