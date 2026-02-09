import { z } from "zod";

import type { ToolCallDetail, ToolCallTimelineItem } from "../../agent-sdk-types.js";
import {
  coerceToolCallId,
  commandFromValue,
  flattenReadContent as flattenToolReadContent,
  nonEmptyString,
  truncateDiffText,
} from "../tool-call-mapper-utils.js";

type OpencodeToolCallParams = {
  toolName: string;
  callId?: string | null;
  status?: unknown;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  metadata?: Record<string, unknown>;
};

const MAX_DIFF_TEXT_CHARS = 12_000;

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

const CommandValueSchema = z.union([z.string(), z.array(z.string())]);

const OpencodeShellInputSchema = z
  .union([
    z
      .object({
        command: CommandValueSchema,
        cwd: z.string().optional(),
        directory: z.string().optional(),
      })
      .passthrough(),
    z
      .object({
        cmd: CommandValueSchema,
        cwd: z.string().optional(),
        directory: z.string().optional(),
      })
      .passthrough(),
  ])
  .transform((value) => {
    const commandValue = "command" in value ? value.command : value.cmd;
    return {
      command: commandFromValue(commandValue),
      cwd: nonEmptyString(value.cwd) ?? nonEmptyString(value.directory),
    };
  });

const OpencodeShellOutputObjectSchema = z
  .object({
    command: z.string().optional(),
    output: z.string().optional(),
    text: z.string().optional(),
    content: z.string().optional(),
    exitCode: z.number().finite().nullable().optional(),
    exit_code: z.number().finite().nullable().optional(),
    metadata: z
      .object({
        exitCode: z.number().finite().nullable().optional(),
        exit_code: z.number().finite().nullable().optional(),
      })
      .passthrough()
      .optional(),
    structuredContent: z
      .object({
        output: z.string().optional(),
        text: z.string().optional(),
        content: z.string().optional(),
      })
      .passthrough()
      .optional(),
    structured_content: z
      .object({
        output: z.string().optional(),
        text: z.string().optional(),
        content: z.string().optional(),
      })
      .passthrough()
      .optional(),
    result: z
      .object({
        command: z.string().optional(),
        output: z.string().optional(),
        text: z.string().optional(),
        content: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const OpencodeShellOutputSchema = z.union([
  z.string().transform((value) => ({
    command: undefined,
    output: nonEmptyString(value),
    exitCode: undefined,
  })),
  OpencodeShellOutputObjectSchema.transform((value) => ({
    command: nonEmptyString(value.command) ?? nonEmptyString(value.result?.command),
    output:
      nonEmptyString(value.output) ??
      nonEmptyString(value.text) ??
      nonEmptyString(value.content) ??
      nonEmptyString(value.structuredContent?.output) ??
      nonEmptyString(value.structuredContent?.text) ??
      nonEmptyString(value.structuredContent?.content) ??
      nonEmptyString(value.structured_content?.output) ??
      nonEmptyString(value.structured_content?.text) ??
      nonEmptyString(value.structured_content?.content) ??
      nonEmptyString(value.result?.output) ??
      nonEmptyString(value.result?.text) ??
      nonEmptyString(value.result?.content),
    exitCode:
      value.exitCode ??
      value.exit_code ??
      value.metadata?.exitCode ??
      value.metadata?.exit_code ??
      undefined,
  })),
]);

const OpencodeReadPathInputSchema = z.union([
  z
    .object({
      file_path: z.string(),
      offset: z.number().finite().optional(),
      limit: z.number().finite().optional(),
    })
    .passthrough()
    .transform((value) => ({
      filePath: value.file_path,
      offset: value.offset,
      limit: value.limit,
    })),
  z
    .object({
      path: z.string(),
      offset: z.number().finite().optional(),
      limit: z.number().finite().optional(),
    })
    .passthrough()
    .transform((value) => ({
      filePath: value.path,
      offset: value.offset,
      limit: value.limit,
    })),
  z
    .object({
      filePath: z.string(),
      offset: z.number().finite().optional(),
      limit: z.number().finite().optional(),
    })
    .passthrough()
    .transform((value) => ({
      filePath: value.filePath,
      offset: value.offset,
      limit: value.limit,
    })),
]);

const OpencodeReadChunkSchema = z.union([
  z
    .object({
      text: z.string(),
      content: z.string().optional(),
      output: z.string().optional(),
    })
    .passthrough(),
  z
    .object({
      text: z.string().optional(),
      content: z.string(),
      output: z.string().optional(),
    })
    .passthrough(),
  z
    .object({
      text: z.string().optional(),
      content: z.string().optional(),
      output: z.string(),
    })
    .passthrough(),
]);

const OpencodeReadContentSchema = z.union([
  z.string(),
  OpencodeReadChunkSchema,
  z.array(OpencodeReadChunkSchema),
]);

const OpencodeReadPayloadSchema = z.union([
  z
    .object({
      content: OpencodeReadContentSchema,
      text: OpencodeReadContentSchema.optional(),
      output: OpencodeReadContentSchema.optional(),
    })
    .passthrough(),
  z
    .object({
      content: OpencodeReadContentSchema.optional(),
      text: OpencodeReadContentSchema,
      output: OpencodeReadContentSchema.optional(),
    })
    .passthrough(),
  z
    .object({
      content: OpencodeReadContentSchema.optional(),
      text: OpencodeReadContentSchema.optional(),
      output: OpencodeReadContentSchema,
    })
    .passthrough(),
]);

const OpencodeReadOutputSchema = z.union([
  z.string().transform((value) => ({ content: nonEmptyString(value) })),
  OpencodeReadChunkSchema.transform((value) => ({ content: flattenReadContent(value) })),
  z.array(OpencodeReadChunkSchema).transform((value) => ({ content: flattenReadContent(value) })),
  OpencodeReadPayloadSchema.transform((value) => ({
    content:
      flattenReadContent(value.content) ??
      flattenReadContent(value.text) ??
      flattenReadContent(value.output),
  })),
  z
    .object({ data: OpencodeReadPayloadSchema })
    .passthrough()
    .transform((value) => ({
      content:
        flattenReadContent(value.data.content) ??
        flattenReadContent(value.data.text) ??
        flattenReadContent(value.data.output),
    })),
  z
    .object({ structuredContent: OpencodeReadPayloadSchema })
    .passthrough()
    .transform((value) => ({
      content:
        flattenReadContent(value.structuredContent.content) ??
        flattenReadContent(value.structuredContent.text) ??
        flattenReadContent(value.structuredContent.output),
    })),
  z
    .object({ structured_content: OpencodeReadPayloadSchema })
    .passthrough()
    .transform((value) => ({
      content:
        flattenReadContent(value.structured_content.content) ??
        flattenReadContent(value.structured_content.text) ??
        flattenReadContent(value.structured_content.output),
    })),
]);

const OpencodeWritePathInputSchema = z.union([
  z.object({ file_path: z.string() }).passthrough().transform((value) => ({ filePath: value.file_path })),
  z.object({ path: z.string() }).passthrough().transform((value) => ({ filePath: value.path })),
  z.object({ filePath: z.string() }).passthrough().transform((value) => ({ filePath: value.filePath })),
]);

const OpencodeWriteContentSchema = z
  .object({
    content: z.string().optional(),
    new_content: z.string().optional(),
    newContent: z.string().optional(),
  })
  .passthrough();

const OpencodeWriteInputSchema = z
  .intersection(OpencodeWritePathInputSchema, OpencodeWriteContentSchema)
  .transform((value) => ({
    filePath: value.filePath,
    content:
      nonEmptyString(value.content) ??
      nonEmptyString(value.new_content) ??
      nonEmptyString(value.newContent),
  }));

const OpencodeWriteOutputSchema = z.union([
  z
    .intersection(OpencodeWritePathInputSchema, OpencodeWriteContentSchema)
    .transform((value) => ({
      filePath: value.filePath,
      content:
        nonEmptyString(value.content) ??
        nonEmptyString(value.new_content) ??
        nonEmptyString(value.newContent),
    })),
  OpencodeWriteContentSchema.transform((value) => ({
    filePath: undefined,
    content:
      nonEmptyString(value.content) ??
      nonEmptyString(value.new_content) ??
      nonEmptyString(value.newContent),
  })),
]);

const OpencodeEditTextSchema = z
  .object({
    old_string: z.string().optional(),
    old_str: z.string().optional(),
    oldContent: z.string().optional(),
    old_content: z.string().optional(),
    new_string: z.string().optional(),
    new_str: z.string().optional(),
    newContent: z.string().optional(),
    new_content: z.string().optional(),
    content: z.string().optional(),
    patch: z.string().optional(),
    diff: z.string().optional(),
    unified_diff: z.string().optional(),
    unifiedDiff: z.string().optional(),
  })
  .passthrough();

const OpencodeEditInputSchema = z
  .intersection(OpencodeWritePathInputSchema, OpencodeEditTextSchema)
  .transform((value) => ({
    filePath: value.filePath,
    oldString:
      nonEmptyString(value.old_string) ??
      nonEmptyString(value.old_str) ??
      nonEmptyString(value.oldContent) ??
      nonEmptyString(value.old_content),
    newString:
      nonEmptyString(value.new_string) ??
      nonEmptyString(value.new_str) ??
      nonEmptyString(value.newContent) ??
      nonEmptyString(value.new_content) ??
      nonEmptyString(value.content),
    unifiedDiff: truncateDiffText(
      nonEmptyString(value.patch) ??
        nonEmptyString(value.diff) ??
        nonEmptyString(value.unified_diff) ??
        nonEmptyString(value.unifiedDiff),
      MAX_DIFF_TEXT_CHARS
    ),
  }));

const OpencodeEditOutputFileSchema = z.union([
  z
    .object({
      path: z.string(),
      patch: z.string().optional(),
      diff: z.string().optional(),
      unified_diff: z.string().optional(),
      unifiedDiff: z.string().optional(),
    })
    .passthrough()
    .transform((value) => ({
      filePath: value.path,
      unifiedDiff: truncateDiffText(
        nonEmptyString(value.patch) ??
          nonEmptyString(value.diff) ??
          nonEmptyString(value.unified_diff) ??
          nonEmptyString(value.unifiedDiff),
        MAX_DIFF_TEXT_CHARS
      ),
    })),
  z
    .object({
      file_path: z.string(),
      patch: z.string().optional(),
      diff: z.string().optional(),
      unified_diff: z.string().optional(),
      unifiedDiff: z.string().optional(),
    })
    .passthrough()
    .transform((value) => ({
      filePath: value.file_path,
      unifiedDiff: truncateDiffText(
        nonEmptyString(value.patch) ??
          nonEmptyString(value.diff) ??
          nonEmptyString(value.unified_diff) ??
          nonEmptyString(value.unifiedDiff),
        MAX_DIFF_TEXT_CHARS
      ),
    })),
  z
    .object({
      filePath: z.string(),
      patch: z.string().optional(),
      diff: z.string().optional(),
      unified_diff: z.string().optional(),
      unifiedDiff: z.string().optional(),
    })
    .passthrough()
    .transform((value) => ({
      filePath: value.filePath,
      unifiedDiff: truncateDiffText(
        nonEmptyString(value.patch) ??
          nonEmptyString(value.diff) ??
          nonEmptyString(value.unified_diff) ??
          nonEmptyString(value.unifiedDiff),
        MAX_DIFF_TEXT_CHARS
      ),
    })),
]);

const OpencodeEditOutputSchema = z.union([
  z
    .intersection(OpencodeWritePathInputSchema, OpencodeEditTextSchema)
    .transform((value) => ({
      filePath: value.filePath,
      newString:
        nonEmptyString(value.newContent) ??
        nonEmptyString(value.new_content) ??
        nonEmptyString(value.content),
      unifiedDiff: truncateDiffText(
        nonEmptyString(value.patch) ??
          nonEmptyString(value.diff) ??
          nonEmptyString(value.unified_diff) ??
          nonEmptyString(value.unifiedDiff),
        MAX_DIFF_TEXT_CHARS
      ),
    })),
  z
    .object({ files: z.array(OpencodeEditOutputFileSchema).min(1) })
    .passthrough()
    .transform((value) => ({
      filePath: value.files[0]?.filePath,
      unifiedDiff: value.files[0]?.unifiedDiff,
      newString: undefined,
    })),
  OpencodeEditTextSchema.transform((value) => ({
    filePath: undefined,
    newString:
      nonEmptyString(value.newContent) ??
      nonEmptyString(value.new_content) ??
      nonEmptyString(value.content),
    unifiedDiff: truncateDiffText(
      nonEmptyString(value.patch) ??
        nonEmptyString(value.diff) ??
        nonEmptyString(value.unified_diff) ??
        nonEmptyString(value.unifiedDiff),
      MAX_DIFF_TEXT_CHARS
    ),
  })),
]);

const OpencodeSearchInputSchema = z.union([
  z.object({ query: z.string() }).passthrough().transform((value) => ({ query: value.query })),
  z.object({ q: z.string() }).passthrough().transform((value) => ({ query: value.q })),
]);

function flattenReadContent(
  value: z.infer<typeof OpencodeReadContentSchema> | undefined
): string | undefined {
  return flattenToolReadContent(value);
}

function coerceCallId(callId: string | null | undefined, toolName: string, input: unknown): string {
  return coerceToolCallId({
    providerPrefix: "opencode",
    rawCallId: callId,
    toolName,
    input,
  });
}

function resolveStatus(rawStatus: unknown, error: unknown, output: unknown): ToolCallTimelineItem["status"] {
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

function toShellDetail(
  input: z.infer<typeof OpencodeShellInputSchema> | null,
  output: z.infer<typeof OpencodeShellOutputSchema> | null
): ToolCallDetail | undefined {
  const command = input?.command ?? output?.command;
  if (!command) {
    return undefined;
  }

  return {
    type: "shell",
    command,
    ...(input?.cwd ? { cwd: input.cwd } : {}),
    ...(output?.output ? { output: output.output } : {}),
    ...(output?.exitCode !== undefined ? { exitCode: output.exitCode } : {}),
  };
}

function toReadDetail(
  input: z.infer<typeof OpencodeReadPathInputSchema> | null,
  output: z.infer<typeof OpencodeReadOutputSchema> | null
): ToolCallDetail | undefined {
  if (!input?.filePath) {
    return undefined;
  }

  return {
    type: "read",
    filePath: input.filePath,
    ...(output?.content ? { content: output.content } : {}),
    ...(input.offset !== undefined ? { offset: input.offset } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  };
}

function toWriteDetail(
  input: z.infer<typeof OpencodeWriteInputSchema> | null,
  output: z.infer<typeof OpencodeWriteOutputSchema> | null
): ToolCallDetail | undefined {
  const filePath = input?.filePath ?? output?.filePath;
  if (!filePath) {
    return undefined;
  }

  return {
    type: "write",
    filePath,
    ...(input?.content ? { content: input.content } : output?.content ? { content: output.content } : {}),
  };
}

function toEditDetail(
  input: z.infer<typeof OpencodeEditInputSchema> | null,
  output: z.infer<typeof OpencodeEditOutputSchema> | null
): ToolCallDetail | undefined {
  const filePath = input?.filePath ?? output?.filePath;
  if (!filePath) {
    return undefined;
  }

  return {
    type: "edit",
    filePath,
    ...(input?.oldString ? { oldString: input.oldString } : {}),
    ...(input?.newString ? { newString: input.newString } : output?.newString ? { newString: output.newString } : {}),
    ...(input?.unifiedDiff
      ? { unifiedDiff: input.unifiedDiff }
      : output?.unifiedDiff
        ? { unifiedDiff: output.unifiedDiff }
        : {}),
  };
}

function toSearchDetail(input: z.infer<typeof OpencodeSearchInputSchema> | null): ToolCallDetail | undefined {
  if (!input?.query) {
    return undefined;
  }
  return {
    type: "search",
    query: input.query,
  };
}

function opencodeToolBranch<
  ToolName extends string,
  InputSchema extends z.ZodTypeAny,
  OutputSchema extends z.ZodTypeAny,
>(
  toolName: ToolName,
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  mapper: (
    input: z.infer<InputSchema> | null,
    output: z.infer<OutputSchema> | null
  ) => ToolCallDetail | undefined
) {
  return z
    .object({
      toolName: z.literal(toolName),
      input: inputSchema.nullable(),
      output: outputSchema.nullable(),
    })
    .transform(({ input, output }) => mapper(input, output));
}

const OpencodeKnownToolDetailSchema = z.union([
  opencodeToolBranch("shell", OpencodeShellInputSchema, OpencodeShellOutputSchema, toShellDetail),
  opencodeToolBranch("bash", OpencodeShellInputSchema, OpencodeShellOutputSchema, toShellDetail),
  opencodeToolBranch("exec_command", OpencodeShellInputSchema, OpencodeShellOutputSchema, toShellDetail),
  opencodeToolBranch("read", OpencodeReadPathInputSchema, OpencodeReadOutputSchema, toReadDetail),
  opencodeToolBranch("read_file", OpencodeReadPathInputSchema, OpencodeReadOutputSchema, toReadDetail),
  opencodeToolBranch("write", OpencodeWriteInputSchema, OpencodeWriteOutputSchema, toWriteDetail),
  opencodeToolBranch("write_file", OpencodeWriteInputSchema, OpencodeWriteOutputSchema, toWriteDetail),
  opencodeToolBranch("create_file", OpencodeWriteInputSchema, OpencodeWriteOutputSchema, toWriteDetail),
  opencodeToolBranch("edit", OpencodeEditInputSchema, OpencodeEditOutputSchema, toEditDetail),
  opencodeToolBranch("apply_patch", OpencodeEditInputSchema, OpencodeEditOutputSchema, toEditDetail),
  opencodeToolBranch("apply_diff", OpencodeEditInputSchema, OpencodeEditOutputSchema, toEditDetail),
  opencodeToolBranch("search", OpencodeSearchInputSchema, z.unknown(), (input) => toSearchDetail(input)),
  opencodeToolBranch("web_search", OpencodeSearchInputSchema, z.unknown(), (input) => toSearchDetail(input)),
]);

function deriveDetail(toolName: string, input: unknown, output: unknown): ToolCallDetail | undefined {
  const parsed = OpencodeKnownToolDetailSchema.safeParse({
    toolName,
    input,
    output,
  });
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data;
}

function toCanonicalDetail(
  knownDetail: ToolCallDetail | undefined,
  rawInput: unknown | null,
  rawOutput: unknown | null
): ToolCallDetail {
  if (knownDetail) {
    return knownDetail;
  }

  return {
    type: "unknown",
    rawInput,
    rawOutput,
  };
}

export function mapOpencodeToolCall(params: OpencodeToolCallParams): ToolCallTimelineItem {
  const parsedParams = OpencodeToolCallParamsSchema.parse(params);
  const input = parsedParams.input ?? null;
  const output = parsedParams.output ?? null;
  const status = resolveStatus(parsedParams.status, parsedParams.error, output);
  const callId = coerceCallId(parsedParams.callId, parsedParams.toolName, input);
  const detail = toCanonicalDetail(deriveDetail(parsedParams.toolName, input, output), input, output);

  if (status === "failed") {
    return {
      type: "tool_call",
      callId,
      name: parsedParams.toolName,
      status: "failed",
      error: parsedParams.error ?? { message: "Tool call failed" },
      detail,
      ...(parsedParams.metadata ? { metadata: parsedParams.metadata } : {}),
    };
  }

  return {
    type: "tool_call",
    callId,
    name: parsedParams.toolName,
    status,
    error: null,
    detail,
    ...(parsedParams.metadata ? { metadata: parsedParams.metadata } : {}),
  };
}
