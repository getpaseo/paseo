import { z } from "zod";

import type { ToolCallDetail, ToolCallTimelineItem } from "../../agent-sdk-types.js";
import { normalizeToolCallStatus } from "../tool-call-mapper-utils.js";
import {
  ToolEditInputSchema,
  ToolEditOutputSchema,
  ToolGrepOutputSchema,
  ToolGlobOutputSchema,
  ToolReadInputSchema,
  ToolReadOutputSchema,
  ToolSearchInputSchema,
  ToolShellInputSchema,
  ToolShellOutputSchema,
  ToolWebFetchInputSchema,
  ToolWebFetchOutputSchema,
  ToolWebSearchOutputSchema,
  ToolWriteInputSchema,
  ToolWriteOutputSchema,
  toEditToolDetail,
  toFetchToolDetail,
  toReadToolDetail,
  toSearchToolDetail,
  toShellToolDetail,
  toWriteToolDetail,
  toolDetailBranchByToolName,
} from "../tool-call-detail-primitives.js";

interface OpenCodeV2ToolCallParams {
  toolName: string;
  callId?: string | null;
  status?: unknown;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  metadata?: Record<string, unknown>;
}

const OpenCodeV2RawToolCallSchema = z
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSubAgentText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length > 0 ? trimmed : undefined;
}

function readOutputText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return normalizeSubAgentText(value);
  }
  if (!isRecord(value)) {
    return undefined;
  }
  return (
    readOutputText(value.output) ??
    readOutputText(value.text) ??
    readOutputText(value.content) ??
    readOutputText(value.result)
  );
}

function formatLogEntry(value: unknown): string | undefined {
  const outputText = readOutputText(value);
  if (outputText) {
    return outputText;
  }
  if (value === null || value === undefined) {
    return undefined;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function deriveOpenCodeV2SubAgentDetail(
  input: unknown,
  output: unknown,
  error: unknown,
  metadata: Record<string, unknown> | undefined,
): ToolCallDetail | null {
  if (!isRecord(input)) {
    return null;
  }

  const subAgentType = normalizeSubAgentText(input.agent ?? input.subagent ?? input.subAgentType);
  const description = normalizeSubAgentText(input.description);
  if (!subAgentType && !description) {
    return null;
  }

  const log = [formatLogEntry(output), formatLogEntry(error)].filter((entry) => entry).join("\n");
  const childSessionId = normalizeSubAgentText(metadata?.sessionID ?? metadata?.sessionId);
  return {
    type: "sub_agent",
    ...(subAgentType ? { subAgentType } : {}),
    ...(description ? { description } : {}),
    ...(childSessionId ? { childSessionId } : {}),
    log,
    actions: [],
  };
}

const OpenCodeV2KnownToolDetailSchema = z.union([
  toolDetailBranchByToolName(
    "shell",
    ToolShellInputSchema,
    ToolShellOutputSchema,
    toShellToolDetail,
  ),
  toolDetailBranchByToolName(
    "bash",
    ToolShellInputSchema,
    ToolShellOutputSchema,
    toShellToolDetail,
  ),
  toolDetailBranchByToolName("read", ToolReadInputSchema, z.unknown(), (input, output) => {
    const parsedOutput = ToolReadOutputSchema.safeParse(output);
    return toReadToolDetail(input, parsedOutput.success ? parsedOutput.data : null);
  }),
  toolDetailBranchByToolName(
    "write",
    ToolWriteInputSchema,
    ToolWriteOutputSchema,
    (input, output) => toWriteToolDetail(input, output as never),
  ),
  toolDetailBranchByToolName("edit", ToolEditInputSchema, ToolEditOutputSchema, (input, output) =>
    toEditToolDetail(input, output as never),
  ),
  toolDetailBranchByToolName(
    "apply_patch",
    ToolEditInputSchema,
    ToolEditOutputSchema,
    (input, output) => toEditToolDetail(input, output as never),
  ),
  toolDetailBranchByToolName("grep", ToolSearchInputSchema, ToolGrepOutputSchema, (input, output) =>
    toSearchToolDetail({ input, output, toolName: "grep" }),
  ),
  toolDetailBranchByToolName("glob", ToolSearchInputSchema, z.unknown(), (input, output) => {
    const parsedOutput = ToolGlobOutputSchema.safeParse(output);
    return toSearchToolDetail({
      input,
      output: parsedOutput.success ? parsedOutput.data : null,
      toolName: "glob",
    });
  }),
  toolDetailBranchByToolName(
    "websearch",
    ToolSearchInputSchema,
    ToolWebSearchOutputSchema,
    (input, output) => toSearchToolDetail({ input, output, toolName: "web_search" }),
  ),
  toolDetailBranchByToolName(
    "webfetch",
    ToolWebFetchInputSchema,
    ToolWebFetchOutputSchema,
    (input, output) => toFetchToolDetail(input, output as never),
  ),
]);

/**
 * Map an opencode-v2 tool call to a paseo `ToolCallTimelineItem`. The v2 tool
 * names (`shell`, `edit`, `read`, `write`, `grep`, `glob`, `webfetch`,
 * `websearch`, `subagent`, `task`, ...) map onto the shared paseo tool detail
 * shapes. Unknown tools fall back to an `unknown` detail so nothing is dropped.
 */
export function mapOpenCodeV2ToolCall(
  params: OpenCodeV2ToolCallParams,
): ToolCallTimelineItem | null {
  const parsed = OpenCodeV2RawToolCallSchema.safeParse(params);
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
  const detail = deriveOpenCodeV2ToolDetail(name, input, output, error, raw.metadata);

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

export function deriveOpenCodeV2ToolDetail(
  toolName: string,
  input: unknown,
  output: unknown,
  error: unknown = null,
  metadata?: Record<string, unknown>,
): ToolCallDetail {
  const normalizedName = toolName.trim().toLowerCase();
  if (normalizedName === "task" || normalizedName === "subagent") {
    const subAgentDetail = deriveOpenCodeV2SubAgentDetail(input, output, error, metadata);
    if (subAgentDetail) {
      return subAgentDetail;
    }
  }

  const parsed = OpenCodeV2KnownToolDetailSchema.safeParse({
    toolName: normalizedName,
    input,
    output,
  });
  if (parsed.success && parsed.data) {
    return parsed.data;
  }
  return {
    type: "unknown",
    input: input ?? null,
    output: output ?? null,
  };
}
