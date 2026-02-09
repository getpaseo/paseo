import { z } from "zod";

import type { ToolCallDetail, ToolCallTimelineItem } from "../../agent-sdk-types.js";
import { stripCwdPrefix } from "../../../../shared/path-utils.js";
import {
  coerceToolCallId,
  commandFromValue,
  flattenReadContent as flattenToolReadContent,
  nonEmptyString,
  truncateDiffText,
} from "../tool-call-mapper-utils.js";

type CodexMapperOptions = { cwd?: string | null };

const FAILED_STATUSES = new Set(["failed", "error", "errored", "rejected", "denied"]);
const CANCELED_STATUSES = new Set(["canceled", "cancelled", "interrupted", "aborted"]);
const COMPLETED_STATUSES = new Set(["completed", "complete", "done", "success", "succeeded"]);

const CodexRolloutToolCallParamsSchema = z
  .object({
    callId: z.string().optional().nullable(),
    name: z.string().min(1),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .passthrough();

const CommandValueSchema = z.union([z.string(), z.array(z.string())]);

const CodexShellInputSchema = z
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

const CodexShellOutputObjectSchema = z
  .object({
    command: z.string().optional(),
    output: z.string().optional(),
    text: z.string().optional(),
    content: z.string().optional(),
    aggregatedOutput: z.string().optional(),
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

const CodexShellOutputSchema = z.union([
  z.string().transform((value) => ({
    command: undefined,
    output: nonEmptyString(value),
    exitCode: undefined,
  })),
  CodexShellOutputObjectSchema.transform((value) => ({
    command: nonEmptyString(value.command) ?? nonEmptyString(value.result?.command),
    output:
      nonEmptyString(value.output) ??
      nonEmptyString(value.text) ??
      nonEmptyString(value.content) ??
      nonEmptyString(value.aggregatedOutput) ??
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

const CodexPathSchema = z.union([
  z.object({ path: z.string() }).passthrough().transform((value) => value.path),
  z.object({ file_path: z.string() }).passthrough().transform((value) => value.file_path),
  z.object({ filePath: z.string() }).passthrough().transform((value) => value.filePath),
]);

const CodexReadArgumentsSchema = z.union([
  z
    .object({
      path: z.string(),
      offset: z.number().finite().optional(),
      limit: z.number().finite().optional(),
    })
    .passthrough()
    .transform((value) => ({ filePath: value.path, offset: value.offset, limit: value.limit })),
  z
    .object({
      file_path: z.string(),
      offset: z.number().finite().optional(),
      limit: z.number().finite().optional(),
    })
    .passthrough()
    .transform((value) => ({ filePath: value.file_path, offset: value.offset, limit: value.limit })),
  z
    .object({
      filePath: z.string(),
      offset: z.number().finite().optional(),
      limit: z.number().finite().optional(),
    })
    .passthrough()
    .transform((value) => ({ filePath: value.filePath, offset: value.offset, limit: value.limit })),
]);

const CodexReadChunkSchema = z.union([
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

const CodexReadContentSchema = z.union([z.string(), CodexReadChunkSchema, z.array(CodexReadChunkSchema)]);

const CodexReadPayloadSchema = z.union([
  z
    .object({
      content: CodexReadContentSchema,
      text: CodexReadContentSchema.optional(),
      output: CodexReadContentSchema.optional(),
    })
    .passthrough(),
  z
    .object({
      content: CodexReadContentSchema.optional(),
      text: CodexReadContentSchema,
      output: CodexReadContentSchema.optional(),
    })
    .passthrough(),
  z
    .object({
      content: CodexReadContentSchema.optional(),
      text: CodexReadContentSchema.optional(),
      output: CodexReadContentSchema,
    })
    .passthrough(),
]);

const CodexReadResultWithPathSchema = z.union([
  z
    .object({
      path: z.string(),
      content: CodexReadContentSchema.optional(),
      text: CodexReadContentSchema.optional(),
      output: CodexReadContentSchema.optional(),
    })
    .passthrough()
    .transform((value) => ({
      filePath: value.path,
      content:
        flattenReadContent(value.content) ??
        flattenReadContent(value.text) ??
        flattenReadContent(value.output),
    })),
  z
    .object({
      file_path: z.string(),
      content: CodexReadContentSchema.optional(),
      text: CodexReadContentSchema.optional(),
      output: CodexReadContentSchema.optional(),
    })
    .passthrough()
    .transform((value) => ({
      filePath: value.file_path,
      content:
        flattenReadContent(value.content) ??
        flattenReadContent(value.text) ??
        flattenReadContent(value.output),
    })),
  z
    .object({
      filePath: z.string(),
      content: CodexReadContentSchema.optional(),
      text: CodexReadContentSchema.optional(),
      output: CodexReadContentSchema.optional(),
    })
    .passthrough()
    .transform((value) => ({
      filePath: value.filePath,
      content:
        flattenReadContent(value.content) ??
        flattenReadContent(value.text) ??
        flattenReadContent(value.output),
    })),
]);

const CodexReadResultSchema = z.union([
  z.string().transform((value) => ({ filePath: undefined, content: nonEmptyString(value) })),
  CodexReadChunkSchema.transform((value) => ({ filePath: undefined, content: flattenReadContent(value) })),
  z.array(CodexReadChunkSchema).transform((value) => ({ filePath: undefined, content: flattenReadContent(value) })),
  CodexReadPayloadSchema.transform((value) => ({
    filePath: undefined,
    content:
      flattenReadContent(value.content) ??
      flattenReadContent(value.text) ??
      flattenReadContent(value.output),
  })),
  z
    .object({ data: CodexReadPayloadSchema })
    .passthrough()
    .transform((value) => ({
      filePath: undefined,
      content:
        flattenReadContent(value.data.content) ??
        flattenReadContent(value.data.text) ??
        flattenReadContent(value.data.output),
    })),
  z
    .object({ structuredContent: CodexReadPayloadSchema })
    .passthrough()
    .transform((value) => ({
      filePath: undefined,
      content:
        flattenReadContent(value.structuredContent.content) ??
        flattenReadContent(value.structuredContent.text) ??
        flattenReadContent(value.structuredContent.output),
    })),
  z
    .object({ structured_content: CodexReadPayloadSchema })
    .passthrough()
    .transform((value) => ({
      filePath: undefined,
      content:
        flattenReadContent(value.structured_content.content) ??
        flattenReadContent(value.structured_content.text) ??
        flattenReadContent(value.structured_content.output),
    })),
  CodexReadResultWithPathSchema,
]);

const CodexWriteContentSchema = z
  .object({
    content: z.string().optional(),
    new_content: z.string().optional(),
    newContent: z.string().optional(),
  })
  .passthrough();

const CodexWriteArgumentsSchema = z
  .intersection(CodexPathSchema.transform((filePath) => ({ filePath })), CodexWriteContentSchema)
  .transform((value) => ({
    filePath: value.filePath,
    content:
      nonEmptyString(value.content) ??
      nonEmptyString(value.new_content) ??
      nonEmptyString(value.newContent),
  }));

const CodexWriteResultSchema = z.union([
  z
    .intersection(CodexPathSchema.transform((filePath) => ({ filePath })), CodexWriteContentSchema)
    .transform((value) => ({
      filePath: value.filePath,
      content:
        nonEmptyString(value.content) ??
        nonEmptyString(value.new_content) ??
        nonEmptyString(value.newContent),
    })),
  CodexWriteContentSchema.transform((value) => ({
    filePath: undefined,
    content:
      nonEmptyString(value.content) ??
      nonEmptyString(value.new_content) ??
      nonEmptyString(value.newContent),
  })),
]);

const CodexEditTextSchema = z
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

const CodexEditArgumentsSchema = z
  .intersection(CodexPathSchema.transform((filePath) => ({ filePath })), CodexEditTextSchema)
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
        nonEmptyString(value.unifiedDiff)
    ),
  }));

const CodexEditResultFileSchema = z.union([
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
          nonEmptyString(value.unifiedDiff)
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
          nonEmptyString(value.unifiedDiff)
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
          nonEmptyString(value.unifiedDiff)
      ),
    })),
]);

const CodexEditResultSchema = z.union([
  z
    .intersection(CodexPathSchema.transform((filePath) => ({ filePath })), CodexEditTextSchema)
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
          nonEmptyString(value.unifiedDiff)
      ),
    })),
  z
    .object({ files: z.array(CodexEditResultFileSchema).min(1) })
    .passthrough()
    .transform((value) => ({
      filePath: value.files[0]?.filePath,
      unifiedDiff: value.files[0]?.unifiedDiff,
      newString: undefined,
    })),
  CodexEditTextSchema.transform((value) => ({
    filePath: undefined,
    newString:
      nonEmptyString(value.newContent) ??
      nonEmptyString(value.new_content) ??
      nonEmptyString(value.content),
    unifiedDiff: truncateDiffText(
      nonEmptyString(value.patch) ??
        nonEmptyString(value.diff) ??
        nonEmptyString(value.unified_diff) ??
        nonEmptyString(value.unifiedDiff)
    ),
  })),
]);

const CodexSearchArgumentsSchema = z.union([
  z.object({ query: z.string() }).passthrough().transform((value) => ({ query: value.query })),
  z.object({ q: z.string() }).passthrough().transform((value) => ({ query: value.q })),
]);

const CodexCommandExecutionItemSchema = z
  .object({
    type: z.literal("commandExecution"),
    id: z.string().optional(),
    status: z.string().optional(),
    error: z.unknown().optional(),
    command: CommandValueSchema.optional(),
    cwd: z.string().optional(),
    aggregatedOutput: z.string().optional(),
    exitCode: z.number().nullable().optional(),
  })
  .passthrough();

const CodexFileChangeItemSchema = z
  .object({
    type: z.literal("fileChange"),
    id: z.string().optional(),
    status: z.string().optional(),
    error: z.unknown().optional(),
    changes: z
      .array(
        z
          .object({
            path: z.string().optional(),
            kind: z.string().optional(),
            diff: z.string().optional(),
          })
          .passthrough()
      )
      .optional(),
  })
  .passthrough();

const CodexMcpToolCallItemSchema = z
  .object({
    type: z.literal("mcpToolCall"),
    id: z.string().optional(),
    callID: z.string().optional(),
    call_id: z.string().optional(),
    status: z.string().optional(),
    error: z.unknown().optional(),
    tool: z.string().optional(),
    server: z.string().optional(),
    arguments: z.unknown().optional(),
    result: z.unknown().optional(),
  })
  .passthrough();

const CodexWebSearchItemSchema = z
  .object({
    type: z.literal("webSearch"),
    id: z.string().optional(),
    status: z.string().optional(),
    error: z.unknown().optional(),
    query: z.string().optional(),
    action: z.unknown().optional(),
  })
  .passthrough();

const CodexThreadItemSchema = z.discriminatedUnion("type", [
  CodexCommandExecutionItemSchema,
  CodexFileChangeItemSchema,
  CodexMcpToolCallItemSchema,
  CodexWebSearchItemSchema,
]);

function flattenReadContent(
  value: z.infer<typeof CodexReadContentSchema> | undefined
): string | undefined {
  return flattenToolReadContent(value);
}

function coerceCallId(raw: string | null | undefined, name: string, input: unknown): string {
  return coerceToolCallId({
    providerPrefix: "codex",
    rawCallId: raw,
    toolName: name,
    input,
  });
}

function normalizeCodexFilePath(filePath: string | undefined, cwd: string | null | undefined): string | undefined {
  if (typeof filePath !== "string") {
    return undefined;
  }
  const trimmed = filePath.trim();
  if (!trimmed) {
    return undefined;
  }
  if (typeof cwd === "string" && cwd.length > 0) {
    return stripCwdPrefix(trimmed, cwd);
  }
  return trimmed;
}

function resolveStatus(rawStatus: string | undefined, error: unknown, output: unknown): ToolCallTimelineItem["status"] {
  if (error !== undefined && error !== null) {
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
  input: z.infer<typeof CodexShellInputSchema> | null,
  output: z.infer<typeof CodexShellOutputSchema> | null
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
  input: z.infer<typeof CodexReadArgumentsSchema> | null,
  output: z.infer<typeof CodexReadResultSchema> | null,
  cwd: string | null | undefined
): ToolCallDetail | undefined {
  const filePath = normalizeCodexFilePath(input?.filePath ?? output?.filePath, cwd);
  if (!filePath) {
    return undefined;
  }

  return {
    type: "read",
    filePath,
    ...(output?.content ? { content: output.content } : {}),
    ...(input?.offset !== undefined ? { offset: input.offset } : {}),
    ...(input?.limit !== undefined ? { limit: input.limit } : {}),
  };
}

function toWriteDetail(
  input: z.infer<typeof CodexWriteArgumentsSchema> | null,
  output: z.infer<typeof CodexWriteResultSchema> | null,
  cwd: string | null | undefined
): ToolCallDetail | undefined {
  const filePath = normalizeCodexFilePath(input?.filePath ?? output?.filePath, cwd);
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
  input: z.infer<typeof CodexEditArgumentsSchema> | null,
  output: z.infer<typeof CodexEditResultSchema> | null,
  cwd: string | null | undefined
): ToolCallDetail | undefined {
  const filePath = normalizeCodexFilePath(input?.filePath ?? output?.filePath, cwd);
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

function toSearchDetail(input: z.infer<typeof CodexSearchArgumentsSchema> | null): ToolCallDetail | undefined {
  if (!input?.query) {
    return undefined;
  }
  return {
    type: "search",
    query: input.query,
  };
}

function codexToolDetailBranch<Name extends string, InputSchema extends z.ZodTypeAny, OutputSchema extends z.ZodTypeAny>(
  name: Name,
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  mapper: (params: {
    input: z.infer<InputSchema> | null;
    output: z.infer<OutputSchema> | null;
    cwd: string | null | undefined;
  }) => ToolCallDetail | undefined
) {
  return z
    .object({
      name: z.literal(name),
      input: inputSchema.nullable(),
      output: outputSchema.nullable(),
      cwd: z.string().optional().nullable(),
    })
    .transform(({ input, output, cwd }) => mapper({ input, output, cwd }));
}

const CodexKnownToolDetailSchema = z.union([
  codexToolDetailBranch("Bash", CodexShellInputSchema, CodexShellOutputSchema, ({ input, output }) =>
    toShellDetail(input, output)
  ),
  codexToolDetailBranch("shell", CodexShellInputSchema, CodexShellOutputSchema, ({ input, output }) =>
    toShellDetail(input, output)
  ),
  codexToolDetailBranch("bash", CodexShellInputSchema, CodexShellOutputSchema, ({ input, output }) =>
    toShellDetail(input, output)
  ),
  codexToolDetailBranch("exec", CodexShellInputSchema, CodexShellOutputSchema, ({ input, output }) =>
    toShellDetail(input, output)
  ),
  codexToolDetailBranch("exec_command", CodexShellInputSchema, CodexShellOutputSchema, ({ input, output }) =>
    toShellDetail(input, output)
  ),
  codexToolDetailBranch("command", CodexShellInputSchema, CodexShellOutputSchema, ({ input, output }) =>
    toShellDetail(input, output)
  ),
  codexToolDetailBranch("read", CodexReadArgumentsSchema, CodexReadResultSchema, ({ input, output, cwd }) =>
    toReadDetail(input, output, cwd)
  ),
  codexToolDetailBranch("read_file", CodexReadArgumentsSchema, CodexReadResultSchema, ({ input, output, cwd }) =>
    toReadDetail(input, output, cwd)
  ),
  codexToolDetailBranch("write", CodexWriteArgumentsSchema, CodexWriteResultSchema, ({ input, output, cwd }) =>
    toWriteDetail(input, output, cwd)
  ),
  codexToolDetailBranch("write_file", CodexWriteArgumentsSchema, CodexWriteResultSchema, ({ input, output, cwd }) =>
    toWriteDetail(input, output, cwd)
  ),
  codexToolDetailBranch("create_file", CodexWriteArgumentsSchema, CodexWriteResultSchema, ({ input, output, cwd }) =>
    toWriteDetail(input, output, cwd)
  ),
  codexToolDetailBranch("edit", CodexEditArgumentsSchema, CodexEditResultSchema, ({ input, output, cwd }) =>
    toEditDetail(input, output, cwd)
  ),
  codexToolDetailBranch("apply_patch", CodexEditArgumentsSchema, CodexEditResultSchema, ({ input, output, cwd }) =>
    toEditDetail(input, output, cwd)
  ),
  codexToolDetailBranch("apply_diff", CodexEditArgumentsSchema, CodexEditResultSchema, ({ input, output, cwd }) =>
    toEditDetail(input, output, cwd)
  ),
  codexToolDetailBranch("search", CodexSearchArgumentsSchema, z.unknown(), ({ input }) => toSearchDetail(input)),
  codexToolDetailBranch("web_search", CodexSearchArgumentsSchema, z.unknown(), ({ input }) =>
    toSearchDetail(input)
  ),
]);

function deriveToolDetail(params: {
  name: string;
  input: unknown;
  output: unknown;
  cwd?: string | null;
}): ToolCallDetail | undefined {
  const parsed = CodexKnownToolDetailSchema.safeParse({
    name: params.name,
    input: params.input,
    output: params.output,
    cwd: params.cwd ?? null,
  });
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data;
}

function buildToolCall(params: {
  callId: string;
  name: string;
  status: ToolCallTimelineItem["status"];
  input: unknown | null;
  output: unknown | null;
  error: unknown | null;
  detail?: ToolCallDetail;
  metadata?: Record<string, unknown>;
}): ToolCallTimelineItem {
  if (params.status === "failed") {
    return {
      type: "tool_call",
      callId: params.callId,
      name: params.name,
      status: "failed",
      input: params.input,
      output: params.output,
      error: params.error ?? { message: "Tool call failed" },
      ...(params.detail ? { detail: params.detail } : {}),
      ...(params.metadata ? { metadata: params.metadata } : {}),
    };
  }

  return {
    type: "tool_call",
    callId: params.callId,
    name: params.name,
    status: params.status,
    input: params.input,
    output: params.output,
    error: null,
    ...(params.detail ? { detail: params.detail } : {}),
    ...(params.metadata ? { metadata: params.metadata } : {}),
  };
}

const CODEX_BUILTIN_TOOL_NAMES = new Set([
  "shell",
  "bash",
  "exec",
  "exec_command",
  "command",
  "read",
  "read_file",
  "write",
  "write_file",
  "create_file",
  "edit",
  "apply_patch",
  "apply_diff",
  "web_search",
  "search",
]);

function buildMcpToolName(server: string | undefined, tool: string): string {
  const trimmedTool = tool.trim();
  if (!trimmedTool) {
    return "tool";
  }

  if (CODEX_BUILTIN_TOOL_NAMES.has(trimmedTool)) {
    return trimmedTool;
  }

  const trimmedServer = typeof server === "string" ? server.trim() : "";
  if (trimmedServer.length > 0) {
    return `${trimmedServer}.${trimmedTool}`;
  }

  return trimmedTool;
}

function toNullableObject(value: Record<string, unknown>): Record<string, unknown> | null {
  return Object.keys(value).length > 0 ? value : null;
}

function mapCommandExecutionItem(
  item: z.infer<typeof CodexCommandExecutionItemSchema>
): ToolCallTimelineItem {
  const command = item.command ? commandFromValue(item.command) : undefined;
  const input = toNullableObject({
    ...(command !== undefined ? { command } : {}),
    ...(item.cwd !== undefined ? { cwd: item.cwd } : {}),
  });

  const output =
    item.aggregatedOutput !== undefined || item.exitCode !== undefined
      ? {
          ...(command !== undefined ? { command } : {}),
          ...(item.aggregatedOutput !== undefined ? { output: item.aggregatedOutput } : {}),
          ...(item.exitCode !== undefined ? { exitCode: item.exitCode } : {}),
        }
      : null;

  const detail = command
    ? {
        type: "shell" as const,
        command,
        ...(item.cwd ? { cwd: item.cwd } : {}),
        ...(item.aggregatedOutput ? { output: item.aggregatedOutput } : {}),
        ...(item.exitCode !== undefined ? { exitCode: item.exitCode } : {}),
      }
    : undefined;

  const name = "shell";
  const callId = coerceCallId(item.id, name, input);
  const error = item.error ?? null;
  const status = resolveStatus(item.status, error, output);

  return buildToolCall({
    callId,
    name,
    status,
    input,
    output,
    error,
    ...(detail ? { detail } : {}),
  });
}

function mapFileChangeItem(
  item: z.infer<typeof CodexFileChangeItemSchema>,
  options?: CodexMapperOptions
): ToolCallTimelineItem {
  const changes = item.changes ?? [];

  const files = changes
    .map((change) => ({
      path: normalizeCodexFilePath(change.path, options?.cwd),
      kind: change.kind,
      diff: change.diff,
    }))
    .filter((change) => change.path !== undefined);

  const input = toNullableObject({
    ...(files.length > 0
      ? {
          files: files.map((file) => ({
            path: file.path,
            ...(file.kind !== undefined ? { kind: file.kind } : {}),
          })),
        }
      : {}),
  });

  const output = toNullableObject({
    ...(files.length > 0
      ? {
          files: files.map((file) => ({
            path: file.path,
            ...(file.kind !== undefined ? { kind: file.kind } : {}),
            ...(file.diff !== undefined ? { patch: truncateDiffText(file.diff) } : {}),
          })),
        }
      : {}),
  });

  const firstFile = files[0];
  const detail = firstFile?.path
    ? {
        type: "edit" as const,
        filePath: firstFile.path,
        ...(firstFile.diff !== undefined ? { unifiedDiff: truncateDiffText(firstFile.diff) } : {}),
      }
    : undefined;

  const name = "apply_patch";
  const callId = coerceCallId(item.id, name, input);
  const error = item.error ?? null;
  const status = resolveStatus(item.status, error, output);

  return buildToolCall({
    callId,
    name,
    status,
    input,
    output,
    error,
    ...(detail ? { detail } : {}),
  });
}

function mapMcpToolCallItem(
  item: z.infer<typeof CodexMcpToolCallItemSchema>,
  options?: CodexMapperOptions
): ToolCallTimelineItem {
  const tool = item.tool?.trim() || "tool";
  const name = buildMcpToolName(item.server, tool);
  const input = item.arguments ?? null;
  const output = item.result ?? null;
  const error = item.error ?? null;
  const callId = coerceCallId(item.id ?? item.callID ?? item.call_id, name, input);
  const status = resolveStatus(item.status, error, output);
  const detail = deriveToolDetail({
    name: tool,
    input,
    output,
    cwd: options?.cwd ?? null,
  });

  return buildToolCall({
    callId,
    name,
    status,
    input,
    output,
    error,
    ...(detail ? { detail } : {}),
  });
}

function mapWebSearchItem(item: z.infer<typeof CodexWebSearchItemSchema>): ToolCallTimelineItem {
  const input = item.query !== undefined ? { query: item.query } : null;
  const output = item.action ?? null;
  const name = "web_search";
  const callId = coerceCallId(item.id, name, input);
  const error = item.error ?? null;
  const status = resolveStatus(item.status ?? "completed", error, output);
  const detail = item.query
    ? {
        type: "search" as const,
        query: item.query,
      }
    : undefined;

  return buildToolCall({
    callId,
    name,
    status,
    input,
    output,
    error,
    ...(detail ? { detail } : {}),
  });
}

function createCodexThreadItemToTimelineSchema(options?: CodexMapperOptions) {
  return CodexThreadItemSchema.transform((item): ToolCallTimelineItem => {
    switch (item.type) {
      case "commandExecution":
        return mapCommandExecutionItem(item);
      case "fileChange":
        return mapFileChangeItem(item, options);
      case "mcpToolCall":
        return mapMcpToolCallItem(item, options);
      case "webSearch":
        return mapWebSearchItem(item);
      default: {
        const exhaustiveCheck: never = item;
        throw new Error(`Unhandled Codex thread item type: ${String(exhaustiveCheck)}`);
      }
    }
  });
}

export function mapCodexToolCallFromThreadItem(
  item: unknown,
  options?: CodexMapperOptions
): ToolCallTimelineItem | null {
  const parsed = createCodexThreadItemToTimelineSchema(options).safeParse(item);
  if (!parsed.success) {
    return null;
  }
  return parsed.data;
}

export function mapCodexRolloutToolCall(params: {
  callId?: string | null;
  name: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
}): ToolCallTimelineItem {
  const parsed = CodexRolloutToolCallParamsSchema.parse(params);
  const input = parsed.input ?? null;
  const output = parsed.output ?? null;
  const error = parsed.error ?? null;
  const status = resolveStatus("completed", error, output);
  const callId = coerceCallId(parsed.callId, parsed.name, input);
  const detail = deriveToolDetail({
    name: parsed.name,
    input,
    output,
    cwd: null,
  });

  return buildToolCall({
    callId,
    name: parsed.name,
    status,
    input,
    output,
    error,
    ...(detail ? { detail } : {}),
  });
}
