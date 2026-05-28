import { z } from "zod";

import type { ToolCallDetail } from "../../agent-sdk-types.js";
import { nonEmptyString, truncateDiffText } from "../tool-call-mapper-utils.js";
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

function parseApplyPatchDirective(
  line: string,
): { kind: "add" | "update" | "delete"; path: string } | null {
  const trimmed = line.trim();
  if (trimmed.startsWith("*** Add File:")) {
    return { kind: "add", path: trimmed.replace("*** Add File:", "").trim() };
  }
  if (trimmed.startsWith("*** Update File:")) {
    return { kind: "update", path: trimmed.replace("*** Update File:", "").trim() };
  }
  if (trimmed.startsWith("*** Delete File:")) {
    return { kind: "delete", path: trimmed.replace("*** Delete File:", "").trim() };
  }
  return null;
}

function extractApplyPatchPrimaryFilePath(patchText: string): string | undefined {
  for (const line of patchText.split(/\r?\n/)) {
    const directive = parseApplyPatchDirective(line);
    if (directive?.path) {
      return directive.path;
    }
  }
  return undefined;
}

function normalizeDiffHeaderPath(rawPath: string): string {
  return rawPath.trim().replace(/^["']+|["']+$/g, "");
}

function applyPatchToUnifiedDiff(patchText: string): string {
  const lines = patchText.replace(/\r\n/g, "\n").split("\n");
  const output: string[] = [];
  let sawDiffContent = false;

  for (const line of lines) {
    const directive = parseApplyPatchDirective(line);
    if (directive) {
      const filePath = normalizeDiffHeaderPath(directive.path);
      if (filePath.length > 0) {
        if (output.length > 0 && output[output.length - 1] !== "") {
          output.push("");
        }
        const left = directive.kind === "add" ? "/dev/null" : `a/${filePath}`;
        const right = directive.kind === "delete" ? "/dev/null" : `b/${filePath}`;
        output.push(`diff --git a/${filePath} b/${filePath}`);
        output.push(`--- ${left}`);
        output.push(`+++ ${right}`);
        sawDiffContent = true;
      }
      continue;
    }

    const trimmed = line.trim();
    if (
      trimmed === "*** Begin Patch" ||
      trimmed === "*** End Patch" ||
      trimmed === "*** End of File" ||
      trimmed.startsWith("*** Move to:")
    ) {
      continue;
    }

    if (
      line.startsWith("@@") ||
      line.startsWith("+") ||
      line.startsWith("-") ||
      line.startsWith(" ") ||
      line.startsWith("\\ No newline at end of file")
    ) {
      output.push(line);
      sawDiffContent = true;
    }
  }

  if (!sawDiffContent) {
    return patchText;
  }

  const normalized = output.join("\n").trim();
  return normalized.length > 0 ? normalized : patchText;
}

const OpencodeApplyPatchTextInputSchema = z
  .object({ patchText: z.string() })
  .passthrough()
  .transform((value) => {
    const filePath = extractApplyPatchPrimaryFilePath(value.patchText);
    return {
      filePath: filePath ?? "",
      oldString: undefined,
      newString: undefined,
      unifiedDiff: truncateDiffText(applyPatchToUnifiedDiff(value.patchText)),
    };
  });

const OpencodeGrepOutputSchema = z
  .union([
    ToolGrepOutputSchema,
    z.string().transform((output) => ({ numFiles: 0, filenames: [], content: output })),
  ])
  .nullable();

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

const OpencodeEditInputSchema = z.union([
  z
    .object({
      filePath: z.string(),
      oldString: z.string().optional(),
      newString: z.string().optional(),
    })
    .passthrough()
    .transform((value) => ({
      filePath: value.filePath,
      oldString: nonEmptyString(value.oldString),
      newString: nonEmptyString(value.newString),
      unifiedDiff: undefined,
    })),
  ToolEditInputSchema,
]);

const OpencodeEditOutputSchema = z.union([z.string().transform(() => null), ToolEditOutputSchema]);

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
  toolDetailBranchByToolName(
    "edit",
    OpencodeEditInputSchema,
    OpencodeEditOutputSchema,
    toEditToolDetail,
  ),
  toolDetailBranchByToolName(
    "apply_patch",
    OpencodeEditInputSchema,
    OpencodeEditOutputSchema,
    toEditToolDetail,
  ),
  toolDetailBranchByToolName(
    "apply_patch",
    OpencodeApplyPatchTextInputSchema,
    z.unknown(),
    (input) => toEditToolDetail(input, null),
  ),
  toolDetailBranchByToolName(
    "apply_diff",
    OpencodeEditInputSchema,
    OpencodeEditOutputSchema,
    toEditToolDetail,
  ),
  toolDetailBranchByToolName("search", ToolSearchInputSchema, z.unknown(), (input) =>
    toSearchToolDetail({ input, toolName: "search" }),
  ),
  toolDetailBranchByToolName(
    "grep",
    ToolSearchInputSchema,
    OpencodeGrepOutputSchema,
    (input, output) => toSearchToolDetail({ input, output, toolName: "grep" }),
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
  toolDetailBranchByToolName(
    "skill",
    z.object({ name: z.string() }).passthrough(),
    z
      .union([
        z
          .object({ output: z.string() })
          .passthrough()
          .transform((value) => value.output),
        z.string(),
      ])
      .nullable(),
    (input, output) => {
      const skillName = input?.name.trim();
      if (!skillName) {
        return undefined;
      }
      return {
        type: "plain_text" as const,
        label: skillName,
        icon: "sparkles" as const,
        ...(output ? { text: output } : {}),
      } satisfies ToolCallDetail;
    },
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
