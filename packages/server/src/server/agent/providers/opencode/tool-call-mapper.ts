import { z } from "zod";

import type { ToolCallTimelineItem } from "../../agent-sdk-types.js";
import { normalizeToolCallStatus } from "../tool-call-mapper-utils.js";
import { deriveOpencodeToolDetail } from "./tool-call-detail-parser.js";

interface OpencodeToolCallParams {
  toolName: string;
  callId?: string | null;
  status?: unknown;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  metadata?: Record<string, unknown>;
}

const OpencodeRawToolCallSchema = z
  .object({
    toolName: z.string().min(1),
    callId: z.string().optional().nullable(),
    status: z.unknown().optional(),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    error: z.unknown().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export function mapOpencodeToolCall(params: OpencodeToolCallParams): ToolCallTimelineItem | null {
  const parsed = OpencodeRawToolCallSchema.safeParse(params);
  if (!parsed.success) {
    return null;
  }
  const raw = parsed.data;
  const callId =
    typeof raw.callId === "string" && raw.callId.trim().length > 0 ? raw.callId.trim() : null;
  if (callId === null) {
    return null;
  }
  const name = raw.toolName.trim();
  const input = raw.input ?? null;
  const output = raw.output ?? null;
  const error = raw.error ?? null;
  const rawStatus = typeof raw.status === "string" ? raw.status : undefined;
  const status = normalizeToolCallStatus(rawStatus, error, output);
  const detail = deriveOpencodeToolDetail(name, input, output, error);

  if (status === "failed") {
    return {
      type: "tool_call",
      callId,
      name,
      status: "failed",
      detail,
      error: error ?? { message: "Tool call failed" },
      ...(raw.metadata ? { metadata: raw.metadata } : {}),
    };
  }
  return {
    type: "tool_call",
    callId,
    name,
    status,
    detail,
    error: null,
    ...(raw.metadata ? { metadata: raw.metadata } : {}),
  };
}
