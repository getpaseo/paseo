import { z } from "zod";

import type { ToolCallTimelineItem } from "../../agent-sdk-types.js";
import { coerceToolCallId } from "../tool-call-mapper-utils.js";
import { deriveOpencodeToolDetail } from "./tool-call-detail-parser.js";

type OpencodeToolCallParams = {
  toolName: string;
  callId?: string | null;
  status?: unknown;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  metadata?: Record<string, unknown>;
};

const FAILED_STATUSES = new Set(["error", "failed", "failure"]);
const CANCELED_STATUSES = new Set(["canceled", "cancelled", "aborted", "interrupted"]);
const COMPLETED_STATUSES = new Set(["complete", "completed", "success", "succeeded", "done"]);

const OpencodeToolCallParamsSchema = z
  .object({
    toolName: z.string().min(1),
    callId: z.string().optional().nullable(),
    status: z.unknown().optional(),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    error: z.unknown().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .passthrough();

function coerceCallId(callId: string | null | undefined, toolName: string, input: unknown): string {
  return coerceToolCallId({
    providerPrefix: "opencode",
    rawCallId: callId,
    toolName,
    input,
  });
}

function resolveStatus(
  rawStatus: unknown,
  error: unknown,
  output: unknown
): ToolCallTimelineItem["status"] {
  if (error !== null && error !== undefined) {
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

export function mapOpencodeToolCall(params: OpencodeToolCallParams): ToolCallTimelineItem {
  const parsedParams = OpencodeToolCallParamsSchema.parse(params);
  const input = parsedParams.input ?? null;
  const output = parsedParams.output ?? null;
  const status = resolveStatus(parsedParams.status, parsedParams.error, output);
  const callId = coerceCallId(parsedParams.callId, parsedParams.toolName, input);
  const detail = deriveOpencodeToolDetail(parsedParams.toolName, input, output);

  if (status === "failed") {
    return {
      type: "tool_call",
      callId,
      name: parsedParams.toolName,
      status: "failed",
      input,
      output,
      error: parsedParams.error ?? { message: "Tool call failed" },
      ...(detail ? { detail } : {}),
      ...(parsedParams.metadata ? { metadata: parsedParams.metadata } : {}),
    };
  }

  return {
    type: "tool_call",
    callId,
    name: parsedParams.toolName,
    status,
    input,
    output,
    error: null,
    ...(detail ? { detail } : {}),
    ...(parsedParams.metadata ? { metadata: parsedParams.metadata } : {}),
  };
}
