import { z } from "zod";

import type { ToolCallDetail, ToolCallTimelineItem } from "../../agent-sdk-types.js";
import {
  coerceToolCallId,
  commandFromValue,
  flattenReadContent as flattenToolReadContent,
  nonEmptyString,
  truncateDiffText,
} from "../tool-call-mapper-utils.js";

type MapperParams = {
  callId?: string | null;
  name: string;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
};

const MAX_DIFF_TEXT_CHARS = 12_000;

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

const CommandValueSchema = z.union([z.string(), z.array(z.string())]);

const ClaudeShellInputSchema = z
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

const ClaudeShellOutputObjectSchema = z
  .object({
    command: z.string().optional(),
    output: z.string().optional(),
    text: z.string().optional(),
    content: z.string().optional(),
    aggregated_output: z.string().optional(),
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

const ClaudeShellOutputSchema = z.union([
  z.string().transform((value) => ({
    command: undefined,
    output: nonEmptyString(value),
    exitCode: undefined,
  })),
  ClaudeShellOutputObjectSchema.transform((value) => ({
    command: nonEmptyString(value.command) ?? nonEmptyString(value.result?.command),
    output:
      nonEmptyString(value.output) ??
      nonEmptyString(value.text) ??
      nonEmptyString(value.content) ??
      nonEmptyString(value.aggregated_output) ??
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

const ClaudeReadPathInputSchema = z.union([
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

const ClaudeReadChunkSchema = z.union([
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

const ClaudeReadContentSchema = z.union([
  z.string(),
  ClaudeReadChunkSchema,
  z.array(ClaudeReadChunkSchema),
]);

const ClaudeReadPayloadSchema = z.union([
  z
    .object({
      content: ClaudeReadContentSchema,
      text: ClaudeReadContentSchema.optional(),
      output: ClaudeReadContentSchema.optional(),
    })
    .passthrough(),
  z
    .object({
      content: ClaudeReadContentSchema.optional(),
      text: ClaudeReadContentSchema,
      output: ClaudeReadContentSchema.optional(),
    })
    .passthrough(),
  z
    .object({
      content: ClaudeReadContentSchema.optional(),
      text: ClaudeReadContentSchema.optional(),
      output: ClaudeReadContentSchema,
    })
    .passthrough(),
]);

const ClaudeReadOutputSchema = z.union([
  z.string().transform((value) => ({ content: nonEmptyString(value) })),
  ClaudeReadChunkSchema.transform((value) => ({ content: flattenReadContent(value) })),
  z.array(ClaudeReadChunkSchema).transform((value) => ({ content: flattenReadContent(value) })),
  ClaudeReadPayloadSchema.transform((value) => ({
    content:
      flattenReadContent(value.content) ??
      flattenReadContent(value.text) ??
      flattenReadContent(value.output),
  })),
  z
    .object({ data: ClaudeReadPayloadSchema })
    .passthrough()
    .transform((value) => ({
      content:
        flattenReadContent(value.data.content) ??
        flattenReadContent(value.data.text) ??
        flattenReadContent(value.data.output),
    })),
  z
    .object({ structuredContent: ClaudeReadPayloadSchema })
    .passthrough()
    .transform((value) => ({
      content:
        flattenReadContent(value.structuredContent.content) ??
        flattenReadContent(value.structuredContent.text) ??
        flattenReadContent(value.structuredContent.output),
    })),
  z
    .object({ structured_content: ClaudeReadPayloadSchema })
    .passthrough()
    .transform((value) => ({
      content:
        flattenReadContent(value.structured_content.content) ??
        flattenReadContent(value.structured_content.text) ??
        flattenReadContent(value.structured_content.output),
    })),
]);

const ClaudeWritePathInputSchema = z.union([
  z.object({ file_path: z.string() }).passthrough().transform((value) => ({ filePath: value.file_path })),
  z.object({ path: z.string() }).passthrough().transform((value) => ({ filePath: value.path })),
  z.object({ filePath: z.string() }).passthrough().transform((value) => ({ filePath: value.filePath })),
]);

const ClaudeWriteContentSchema = z
  .object({
    content: z.string().optional(),
    new_content: z.string().optional(),
    newContent: z.string().optional(),
  })
  .passthrough();

const ClaudeWriteInputSchema = z
  .intersection(ClaudeWritePathInputSchema, ClaudeWriteContentSchema)
  .transform((value) => ({
    filePath: value.filePath,
    content:
      nonEmptyString(value.content) ??
      nonEmptyString(value.new_content) ??
      nonEmptyString(value.newContent),
  }));

const ClaudeWriteOutputSchema = z.union([
  z
    .intersection(ClaudeWritePathInputSchema, ClaudeWriteContentSchema)
    .transform((value) => ({
      filePath: value.filePath,
      content:
        nonEmptyString(value.content) ??
        nonEmptyString(value.new_content) ??
        nonEmptyString(value.newContent),
    })),
  ClaudeWriteContentSchema.transform((value) => ({
    filePath: undefined,
    content:
      nonEmptyString(value.content) ??
      nonEmptyString(value.new_content) ??
      nonEmptyString(value.newContent),
  })),
]);

const ClaudeEditTextSchema = z
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

const ClaudeEditInputSchema = z
  .intersection(ClaudeWritePathInputSchema, ClaudeEditTextSchema)
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

const ClaudeEditOutputFileSchema = z.union([
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

const ClaudeEditOutputSchema = z.union([
  z
    .intersection(ClaudeWritePathInputSchema, ClaudeEditTextSchema)
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
    .object({ files: z.array(ClaudeEditOutputFileSchema).min(1) })
    .passthrough()
    .transform((value) => ({
      filePath: value.files[0]?.filePath,
      unifiedDiff: value.files[0]?.unifiedDiff,
      newString: undefined,
    })),
  ClaudeEditTextSchema.transform((value) => ({
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

const ClaudeSearchInputSchema = z.union([
  z.object({ query: z.string() }).passthrough().transform((value) => ({ query: value.query })),
  z.object({ q: z.string() }).passthrough().transform((value) => ({ query: value.q })),
]);

function flattenReadContent(
  value: z.infer<typeof ClaudeReadContentSchema> | undefined
): string | undefined {
  return flattenToolReadContent(value);
}

function coerceCallId(callId: string | null | undefined, name: string, input: unknown): string {
  return coerceToolCallId({
    providerPrefix: "claude",
    rawCallId: callId,
    toolName: name,
    input,
  });
}

function toShellDetail(
  input: z.infer<typeof ClaudeShellInputSchema> | null,
  output: z.infer<typeof ClaudeShellOutputSchema> | null
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
  input: z.infer<typeof ClaudeReadPathInputSchema> | null,
  output: z.infer<typeof ClaudeReadOutputSchema> | null
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
  input: z.infer<typeof ClaudeWriteInputSchema> | null,
  output: z.infer<typeof ClaudeWriteOutputSchema> | null
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
  input: z.infer<typeof ClaudeEditInputSchema> | null,
  output: z.infer<typeof ClaudeEditOutputSchema> | null
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

function toSearchDetail(input: z.infer<typeof ClaudeSearchInputSchema> | null): ToolCallDetail | undefined {
  if (!input?.query) {
    return undefined;
  }
  return {
    type: "search",
    query: input.query,
  };
}

function claudeToolBranch<Name extends string, InputSchema extends z.ZodTypeAny, OutputSchema extends z.ZodTypeAny>(
  name: Name,
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  mapper: (
    input: z.infer<InputSchema> | null,
    output: z.infer<OutputSchema> | null
  ) => ToolCallDetail | undefined
) {
  return z
    .object({
      name: z.literal(name),
      input: inputSchema.nullable(),
      output: outputSchema.nullable(),
    })
    .transform(({ input, output }) => mapper(input, output));
}

const ClaudeKnownToolDetailSchema = z.union([
  claudeToolBranch("Bash", ClaudeShellInputSchema, ClaudeShellOutputSchema, toShellDetail),
  claudeToolBranch("bash", ClaudeShellInputSchema, ClaudeShellOutputSchema, toShellDetail),
  claudeToolBranch("shell", ClaudeShellInputSchema, ClaudeShellOutputSchema, toShellDetail),
  claudeToolBranch("exec_command", ClaudeShellInputSchema, ClaudeShellOutputSchema, toShellDetail),
  claudeToolBranch("Read", ClaudeReadPathInputSchema, ClaudeReadOutputSchema, toReadDetail),
  claudeToolBranch("read", ClaudeReadPathInputSchema, ClaudeReadOutputSchema, toReadDetail),
  claudeToolBranch("read_file", ClaudeReadPathInputSchema, ClaudeReadOutputSchema, toReadDetail),
  claudeToolBranch("view_file", ClaudeReadPathInputSchema, ClaudeReadOutputSchema, toReadDetail),
  claudeToolBranch("Write", ClaudeWriteInputSchema, ClaudeWriteOutputSchema, toWriteDetail),
  claudeToolBranch("write", ClaudeWriteInputSchema, ClaudeWriteOutputSchema, toWriteDetail),
  claudeToolBranch("write_file", ClaudeWriteInputSchema, ClaudeWriteOutputSchema, toWriteDetail),
  claudeToolBranch("create_file", ClaudeWriteInputSchema, ClaudeWriteOutputSchema, toWriteDetail),
  claudeToolBranch("Edit", ClaudeEditInputSchema, ClaudeEditOutputSchema, toEditDetail),
  claudeToolBranch("MultiEdit", ClaudeEditInputSchema, ClaudeEditOutputSchema, toEditDetail),
  claudeToolBranch("multi_edit", ClaudeEditInputSchema, ClaudeEditOutputSchema, toEditDetail),
  claudeToolBranch("edit", ClaudeEditInputSchema, ClaudeEditOutputSchema, toEditDetail),
  claudeToolBranch("apply_patch", ClaudeEditInputSchema, ClaudeEditOutputSchema, toEditDetail),
  claudeToolBranch("apply_diff", ClaudeEditInputSchema, ClaudeEditOutputSchema, toEditDetail),
  claudeToolBranch("str_replace_editor", ClaudeEditInputSchema, ClaudeEditOutputSchema, toEditDetail),
  claudeToolBranch("WebSearch", ClaudeSearchInputSchema, z.unknown(), (input) => toSearchDetail(input)),
  claudeToolBranch("web_search", ClaudeSearchInputSchema, z.unknown(), (input) => toSearchDetail(input)),
  claudeToolBranch("search", ClaudeSearchInputSchema, z.unknown(), (input) => toSearchDetail(input)),
]);

function deriveDetail(name: string, input: unknown, output: unknown): ToolCallDetail | undefined {
  const parsed = ClaudeKnownToolDetailSchema.safeParse({
    name,
    input,
    output,
  });
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data;
}

function buildBase(params: MapperParams): {
  callId: string;
  name: string;
  detail: ToolCallDetail;
  metadata?: Record<string, unknown>;
} {
  const parsedParams = ClaudeMapperParamsSchema.parse(params);
  const input = parsedParams.input ?? null;
  const output = parsedParams.output ?? null;
  const detail =
    deriveDetail(parsedParams.name, input, output) ?? {
      type: "unknown",
      rawInput: input,
      rawOutput: output,
    };

  return {
    callId: coerceCallId(parsedParams.callId, parsedParams.name, input),
    name: parsedParams.name,
    detail,
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
