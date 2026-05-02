import { z } from "zod";

import type { ToolCallDetail } from "../../agent-sdk-types.js";
import { nonEmptyString } from "../tool-call-mapper-utils.js";
import {
  ToolEditInputSchema,
  ToolEditOutputSchema,
  ToolGlobOutputSchema,
  ToolReadInputSchema,
  ToolReadOutputSchema,
  ToolSearchInputSchema,
  ToolShellInputSchema,
  ToolShellOutputSchema,
  ToolWriteInputSchema,
  ToolWriteOutputSchema,
  toEditToolDetail,
  toReadToolDetail,
  toSearchToolDetail,
  toShellToolDetail,
  toWriteToolDetail,
  toolDetailBranchByToolName,
} from "../tool-call-detail-primitives.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSubAgentText(value: unknown): string | undefined {
  return nonEmptyString(value)?.trim().replace(/\s+/g, " ");
}

function readOutputText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return nonEmptyString(value.trim());
  }
  if (!isRecord(value)) {
    return undefined;
  }

  const directText =
    readOutputText(value.output) ??
    readOutputText(value.text) ??
    readOutputText(value.content) ??
    readOutputText(value.result);
  if (directText) {
    return directText;
  }

  return undefined;
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

function extractOpenCodeTaskSessionId(value: unknown): string | undefined {
  const text = readOutputText(value);
  if (text) {
    const match = text.match(/\btask_id:\s*(ses_[A-Za-z0-9]+)/i);
    if (match?.[1]) {
      return match[1];
    }
  }
  if (!isRecord(value)) {
    return undefined;
  }

  return (
    normalizeSubAgentText(value.task_id) ??
    normalizeSubAgentText(value.taskId) ??
    normalizeSubAgentText(value.sessionID) ??
    normalizeSubAgentText(value.sessionId) ??
    extractOpenCodeTaskSessionId(value.output) ??
    extractOpenCodeTaskSessionId(value.text) ??
    extractOpenCodeTaskSessionId(value.content) ??
    extractOpenCodeTaskSessionId(value.result)
  );
}

function deriveOpencodeTaskDetail(
  input: unknown,
  output: unknown,
  error: unknown,
): ToolCallDetail | null {
  if (!isRecord(input)) {
    return null;
  }

  const subAgentType = normalizeSubAgentText(input.subagent_type ?? input.subAgentType);
  const description = normalizeSubAgentText(input.description);
  if (!subAgentType && !description) {
    return null;
  }

  const log = [formatLogEntry(output), formatLogEntry(error)].filter((entry) => entry).join("\n");
  const childSessionId = extractOpenCodeTaskSessionId(output);
  return {
    type: "sub_agent",
    ...(subAgentType ? { subAgentType } : {}),
    ...(description ? { description } : {}),
    ...(childSessionId ? { childSessionId } : {}),
    log,
    actions: [],
  };
}

const OpencodeKnownToolDetailSchema = z.union([
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
  toolDetailBranchByToolName(
    "exec_command",
    ToolShellInputSchema,
    ToolShellOutputSchema,
    toShellToolDetail,
  ),
  toolDetailBranchByToolName("read", ToolReadInputSchema, z.unknown(), (input, output) => {
    const parsedOutput = ToolReadOutputSchema.safeParse(output);
    return toReadToolDetail(input, parsedOutput.success ? parsedOutput.data : null);
  }),
  toolDetailBranchByToolName("read_file", ToolReadInputSchema, z.unknown(), (input, output) => {
    const parsedOutput = ToolReadOutputSchema.safeParse(output);
    return toReadToolDetail(input, parsedOutput.success ? parsedOutput.data : null);
  }),
  toolDetailBranchByToolName(
    "write",
    ToolWriteInputSchema,
    ToolWriteOutputSchema,
    toWriteToolDetail,
  ),
  toolDetailBranchByToolName(
    "write_file",
    ToolWriteInputSchema,
    ToolWriteOutputSchema,
    toWriteToolDetail,
  ),
  toolDetailBranchByToolName(
    "create_file",
    ToolWriteInputSchema,
    ToolWriteOutputSchema,
    toWriteToolDetail,
  ),
  toolDetailBranchByToolName("edit", ToolEditInputSchema, ToolEditOutputSchema, toEditToolDetail),
  toolDetailBranchByToolName(
    "apply_patch",
    ToolEditInputSchema,
    ToolEditOutputSchema,
    toEditToolDetail,
  ),
  toolDetailBranchByToolName(
    "apply_diff",
    ToolEditInputSchema,
    ToolEditOutputSchema,
    toEditToolDetail,
  ),
  toolDetailBranchByToolName("search", ToolSearchInputSchema, z.unknown(), (input) =>
    toSearchToolDetail({ input, toolName: "search" }),
  ),
  toolDetailBranchByToolName("glob", ToolSearchInputSchema, z.unknown(), (input, output) => {
    const parsedOutput = ToolGlobOutputSchema.safeParse(output);
    return toSearchToolDetail({
      input,
      output: parsedOutput.success ? parsedOutput.data : null,
      toolName: "glob",
    });
  }),
  toolDetailBranchByToolName("web_search", ToolSearchInputSchema, z.unknown(), (input) =>
    toSearchToolDetail({ input, toolName: "web_search" }),
  ),
]);

export function deriveOpencodeToolDetail(
  toolName: string,
  input: unknown,
  output: unknown,
  error: unknown = null,
): ToolCallDetail {
  if (toolName.trim().toLowerCase() === "task") {
    const taskDetail = deriveOpencodeTaskDetail(input, output, error);
    if (taskDetail) {
      return taskDetail;
    }
  }

  const parsed = OpencodeKnownToolDetailSchema.safeParse({
    toolName,
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
