import { z } from "zod";

import type { ToolCallDetail, ToolCallTimelineItem } from "../../agent-sdk-types.js";

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

const ClaudeShellToolNameSchema = z.union([
  z.literal("Bash"),
  z.literal("bash"),
  z.literal("shell"),
  z.literal("exec_command"),
]);

const ClaudeReadToolNameSchema = z.union([
  z.literal("Read"),
  z.literal("read"),
  z.literal("read_file"),
  z.literal("view_file"),
]);

const ClaudeWriteToolNameSchema = z.union([
  z.literal("Write"),
  z.literal("write"),
  z.literal("write_file"),
  z.literal("create_file"),
]);

const ClaudeEditToolNameSchema = z.union([
  z.literal("Edit"),
  z.literal("edit"),
  z.literal("multi_edit"),
  z.literal("multiedit"),
  z.literal("apply_patch"),
  z.literal("apply_diff"),
  z.literal("str_replace_editor"),
]);

const ClaudeSearchToolNameSchema = z.union([
  z.literal("WebSearch"),
  z.literal("web_search"),
  z.literal("websearch"),
  z.literal("search"),
]);

const ClaudeFileReferenceSchema = z
  .object({
    file_path: z.string().optional(),
    filePath: z.string().optional(),
    path: z.string().optional(),
    target_path: z.string().optional(),
    targetPath: z.string().optional(),
  })
  .passthrough();

const ClaudeFileReferenceCollectionSchema = ClaudeFileReferenceSchema.extend({
  files: z.array(ClaudeFileReferenceSchema).optional(),
}).passthrough();

const ClaudeTextLikeSchema = z
  .object({
    output: z.string().optional(),
    text: z.string().optional(),
    content: z.string().optional(),
  })
  .passthrough();

const ClaudeShellInputSchema = z
  .object({
    command: z.union([z.string(), z.array(z.string())]).optional(),
    cmd: z.union([z.string(), z.array(z.string())]).optional(),
    cwd: z.string().optional(),
    directory: z.string().optional(),
  })
  .passthrough();

const ClaudeShellOutputObjectSchema = z
  .object({
    command: z.string().optional(),
    output: z.string().optional(),
    text: z.string().optional(),
    content: z.string().optional(),
    aggregated_output: z.string().optional(),
    exitCode: z.number().finite().optional(),
    exit_code: z.number().finite().optional(),
    metadata: z
      .object({
        exitCode: z.number().finite().optional(),
        exit_code: z.number().finite().optional(),
      })
      .passthrough()
      .optional(),
    structuredContent: ClaudeTextLikeSchema.optional(),
    structured_content: ClaudeTextLikeSchema.optional(),
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

const ClaudeShellOutputSchema = z.union([z.string(), ClaudeShellOutputObjectSchema]);

const ClaudeReadInputSchema = ClaudeFileReferenceCollectionSchema.extend({
  offset: z.number().finite().optional(),
  limit: z.number().finite().optional(),
}).passthrough();

const ClaudeReadOutputSchema = z.union([
  z.string(),
  ClaudeFileReferenceCollectionSchema.extend({
    content: z.string().optional(),
    text: z.string().optional(),
    output: z.string().optional(),
    data: ClaudeTextLikeSchema.optional(),
    structuredContent: ClaudeTextLikeSchema.optional(),
    structured_content: ClaudeTextLikeSchema.optional(),
  }).passthrough(),
]);

const ClaudeWriteInputSchema = ClaudeFileReferenceCollectionSchema.extend({
  content: z.string().optional(),
  new_content: z.string().optional(),
  newContent: z.string().optional(),
}).passthrough();

const ClaudeWriteOutputSchema = ClaudeFileReferenceCollectionSchema.extend({
  content: z.string().optional(),
  new_content: z.string().optional(),
  newContent: z.string().optional(),
}).passthrough();

const ClaudeEditInputSchema = ClaudeFileReferenceCollectionSchema.extend({
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
}).passthrough();

const ClaudeEditOutputSchema = ClaudeFileReferenceCollectionSchema.extend({
  content: z.string().optional(),
  new_content: z.string().optional(),
  newContent: z.string().optional(),
  patch: z.string().optional(),
  diff: z.string().optional(),
  unified_diff: z.string().optional(),
  unifiedDiff: z.string().optional(),
  files: z
    .array(
      ClaudeFileReferenceSchema.extend({
        patch: z.string().optional(),
        diff: z.string().optional(),
        unified_diff: z.string().optional(),
        unifiedDiff: z.string().optional(),
      }).passthrough()
    )
    .optional(),
}).passthrough();

const ClaudeSearchInputSchema = z
  .object({
    query: z.string().optional(),
    q: z.string().optional(),
  })
  .passthrough();

const ClaudeShellDetailCandidateSchema = z
  .object({
    name: ClaudeShellToolNameSchema,
    input: z.unknown().nullable(),
    output: z.unknown().nullable(),
  })
  .transform(({ input, output }) => resolveShellDetail(input, output));

const ClaudeReadDetailCandidateSchema = z
  .object({
    name: ClaudeReadToolNameSchema,
    input: z.unknown().nullable(),
    output: z.unknown().nullable(),
  })
  .transform(({ input, output }) => resolveReadDetail(input, output));

const ClaudeWriteDetailCandidateSchema = z
  .object({
    name: ClaudeWriteToolNameSchema,
    input: z.unknown().nullable(),
    output: z.unknown().nullable(),
  })
  .transform(({ input, output }) => resolveWriteDetail(input, output));

const ClaudeEditDetailCandidateSchema = z
  .object({
    name: ClaudeEditToolNameSchema,
    input: z.unknown().nullable(),
    output: z.unknown().nullable(),
  })
  .transform(({ input, output }) => resolveEditDetail(input, output));

const ClaudeSearchDetailCandidateSchema = z
  .object({
    name: ClaudeSearchToolNameSchema,
    input: z.unknown().nullable(),
    output: z.unknown().nullable(),
  })
  .transform(({ input }) => resolveSearchDetail(input));

const ClaudeKnownToolDetailSchema = z.union([
  ClaudeShellDetailCandidateSchema,
  ClaudeReadDetailCandidateSchema,
  ClaudeWriteDetailCandidateSchema,
  ClaudeEditDetailCandidateSchema,
  ClaudeSearchDetailCandidateSchema,
]);

function hashText(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function coerceCallId(callId: string | null | undefined, name: string, input: unknown): string {
  if (typeof callId === "string" && callId.trim().length > 0) {
    return callId;
  }
  let serialized = "";
  try {
    serialized = JSON.stringify(input) ?? "";
  } catch {
    serialized = String(input);
  }
  return `claude-${hashText(`${name}:${serialized}`)}`;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === "string" && value.length > 0);
}

function commandFromValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (Array.isArray(value)) {
    const tokens = value.filter((token): token is string => typeof token === "string" && token.length > 0);
    if (tokens.length > 0) {
      return tokens.join(" ");
    }
  }
  return undefined;
}

function resolveFilePath(value: z.infer<typeof ClaudeFileReferenceCollectionSchema>): string | undefined {
  return firstNonEmpty(
    value.file_path,
    value.filePath,
    value.path,
    value.target_path,
    value.targetPath,
    value.files?.[0]?.path,
    value.files?.[0]?.filePath,
    value.files?.[0]?.file_path
  );
}

function resolveShellDetail(input: unknown, output: unknown): ToolCallDetail | undefined {
  const parsedInput = ClaudeShellInputSchema.safeParse(input);
  const parsedOutput = ClaudeShellOutputSchema.safeParse(output);

  const command =
    (parsedInput.success
      ? commandFromValue(parsedInput.data.command) ?? commandFromValue(parsedInput.data.cmd)
      : undefined) ??
    (parsedOutput.success && typeof parsedOutput.data !== "string"
      ? firstNonEmpty(parsedOutput.data.command, parsedOutput.data.result?.command)
      : undefined);

  if (!command) {
    return undefined;
  }

  const outputText =
    parsedOutput.success
      ? typeof parsedOutput.data === "string"
        ? parsedOutput.data
        : firstNonEmpty(
            parsedOutput.data.output,
            parsedOutput.data.text,
            parsedOutput.data.content,
            parsedOutput.data.aggregated_output,
            parsedOutput.data.structuredContent?.output,
            parsedOutput.data.structuredContent?.text,
            parsedOutput.data.structuredContent?.content,
            parsedOutput.data.structured_content?.output,
            parsedOutput.data.structured_content?.text,
            parsedOutput.data.structured_content?.content,
            parsedOutput.data.result?.output,
            parsedOutput.data.result?.text,
            parsedOutput.data.result?.content
          )
      : undefined;

  const exitCode =
    parsedOutput.success && typeof parsedOutput.data !== "string"
      ? parsedOutput.data.exitCode ??
        parsedOutput.data.exit_code ??
        parsedOutput.data.metadata?.exitCode ??
        parsedOutput.data.metadata?.exit_code ??
        null
      : null;

  const cwd =
    parsedInput.success
      ? firstNonEmpty(parsedInput.data.cwd, parsedInput.data.directory)
      : undefined;

  return {
    type: "shell",
    command,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(outputText !== undefined ? { output: outputText } : {}),
    ...(exitCode !== null ? { exitCode } : { exitCode: null }),
  };
}

function resolveReadDetail(input: unknown, output: unknown): ToolCallDetail | undefined {
  const parsedInput = ClaudeReadInputSchema.safeParse(input);
  const parsedOutput = ClaudeReadOutputSchema.safeParse(output);

  const inputPath = parsedInput.success ? resolveFilePath(parsedInput.data) : undefined;
  const outputPath =
    parsedOutput.success && typeof parsedOutput.data !== "string"
      ? resolveFilePath(parsedOutput.data)
      : undefined;
  const filePath = firstNonEmpty(inputPath, outputPath);

  if (!filePath) {
    return undefined;
  }

  const content =
    parsedOutput.success
      ? typeof parsedOutput.data === "string"
        ? parsedOutput.data
        : firstNonEmpty(
            parsedOutput.data.content,
            parsedOutput.data.text,
            parsedOutput.data.output,
            parsedOutput.data.data?.content,
            parsedOutput.data.data?.text,
            parsedOutput.data.data?.output,
            parsedOutput.data.structuredContent?.content,
            parsedOutput.data.structuredContent?.text,
            parsedOutput.data.structuredContent?.output,
            parsedOutput.data.structured_content?.content,
            parsedOutput.data.structured_content?.text,
            parsedOutput.data.structured_content?.output
          )
      : undefined;

  const offset = parsedInput.success ? parsedInput.data.offset : undefined;
  const limit = parsedInput.success ? parsedInput.data.limit : undefined;

  return {
    type: "read",
    filePath,
    ...(content !== undefined ? { content } : {}),
    ...(offset !== undefined ? { offset } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

function resolveWriteDetail(input: unknown, output: unknown): ToolCallDetail | undefined {
  const parsedInput = ClaudeWriteInputSchema.safeParse(input);
  const parsedOutput = ClaudeWriteOutputSchema.safeParse(output);

  const filePath = firstNonEmpty(
    parsedInput.success ? resolveFilePath(parsedInput.data) : undefined,
    parsedOutput.success ? resolveFilePath(parsedOutput.data) : undefined
  );

  if (!filePath) {
    return undefined;
  }

  const content = firstNonEmpty(
    parsedInput.success
      ? firstNonEmpty(parsedInput.data.content, parsedInput.data.new_content, parsedInput.data.newContent)
      : undefined,
    parsedOutput.success
      ? firstNonEmpty(parsedOutput.data.content, parsedOutput.data.new_content, parsedOutput.data.newContent)
      : undefined
  );

  return {
    type: "write",
    filePath,
    ...(content !== undefined ? { content } : {}),
  };
}

function resolveEditDetail(input: unknown, output: unknown): ToolCallDetail | undefined {
  const parsedInput = ClaudeEditInputSchema.safeParse(input);
  const parsedOutput = ClaudeEditOutputSchema.safeParse(output);

  const filePath = firstNonEmpty(
    parsedInput.success ? resolveFilePath(parsedInput.data) : undefined,
    parsedOutput.success ? resolveFilePath(parsedOutput.data) : undefined
  );

  if (!filePath) {
    return undefined;
  }

  const oldString = parsedInput.success
    ? firstNonEmpty(
        parsedInput.data.old_string,
        parsedInput.data.old_str,
        parsedInput.data.oldContent,
        parsedInput.data.old_content
      )
    : undefined;

  const newString = firstNonEmpty(
    parsedInput.success
      ? firstNonEmpty(
          parsedInput.data.new_string,
          parsedInput.data.new_str,
          parsedInput.data.newContent,
          parsedInput.data.new_content,
          parsedInput.data.content
        )
      : undefined,
    parsedOutput.success
      ? firstNonEmpty(parsedOutput.data.newContent, parsedOutput.data.new_content, parsedOutput.data.content)
      : undefined
  );

  const unifiedDiff = firstNonEmpty(
    parsedInput.success
      ? firstNonEmpty(
          parsedInput.data.patch,
          parsedInput.data.diff,
          parsedInput.data.unified_diff,
          parsedInput.data.unifiedDiff
        )
      : undefined,
    parsedOutput.success
      ? firstNonEmpty(
          parsedOutput.data.patch,
          parsedOutput.data.diff,
          parsedOutput.data.unified_diff,
          parsedOutput.data.unifiedDiff,
          parsedOutput.data.files?.[0]?.patch,
          parsedOutput.data.files?.[0]?.diff,
          parsedOutput.data.files?.[0]?.unified_diff,
          parsedOutput.data.files?.[0]?.unifiedDiff
        )
      : undefined
  );

  return {
    type: "edit",
    filePath,
    ...(oldString !== undefined ? { oldString } : {}),
    ...(newString !== undefined ? { newString } : {}),
    ...(unifiedDiff !== undefined ? { unifiedDiff } : {}),
  };
}

function resolveSearchDetail(input: unknown): ToolCallDetail | undefined {
  const parsedInput = ClaudeSearchInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return undefined;
  }

  const query = firstNonEmpty(parsedInput.data.query, parsedInput.data.q);
  if (!query) {
    return undefined;
  }

  return {
    type: "search",
    query,
  };
}

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
  input: unknown | null;
  output: unknown | null;
  detail?: ToolCallDetail;
  metadata?: Record<string, unknown>;
} {
  const parsedParams = ClaudeMapperParamsSchema.parse(params);
  const callId = coerceCallId(parsedParams.callId, parsedParams.name, parsedParams.input);
  const input = parsedParams.input ?? null;
  const output = parsedParams.output ?? null;
  const detail = deriveDetail(parsedParams.name, input, output);

  return {
    callId,
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
