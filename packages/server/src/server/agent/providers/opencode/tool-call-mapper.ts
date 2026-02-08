import { z } from "zod";

import type { ToolCallDetail, ToolCallTimelineItem } from "../../agent-sdk-types.js";

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

const OpencodeShellToolNameSchema = z.union([
  z.literal("shell"),
  z.literal("bash"),
  z.literal("exec_command"),
]);

const OpencodeReadToolNameSchema = z.union([
  z.literal("read"),
  z.literal("read_file"),
]);

const OpencodeWriteToolNameSchema = z.union([
  z.literal("write"),
  z.literal("write_file"),
  z.literal("create_file"),
]);

const OpencodeEditToolNameSchema = z.union([
  z.literal("edit"),
  z.literal("apply_patch"),
  z.literal("apply_diff"),
]);

const OpencodeSearchToolNameSchema = z.union([
  z.literal("search"),
  z.literal("web_search"),
]);

const OpencodeFileReferenceSchema = z
  .object({
    file_path: z.string().optional(),
    filePath: z.string().optional(),
    path: z.string().optional(),
    target_path: z.string().optional(),
    targetPath: z.string().optional(),
  })
  .passthrough();

const OpencodeFileReferenceCollectionSchema = OpencodeFileReferenceSchema.extend({
  files: z.array(OpencodeFileReferenceSchema).optional(),
}).passthrough();

const OpencodeTextLikeSchema = z
  .object({
    output: z.string().optional(),
    text: z.string().optional(),
    content: z.string().optional(),
  })
  .passthrough();

const OpencodeShellInputSchema = z
  .object({
    command: z.union([z.string(), z.array(z.string())]).optional(),
    cmd: z.union([z.string(), z.array(z.string())]).optional(),
    cwd: z.string().optional(),
    directory: z.string().optional(),
  })
  .passthrough();

const OpencodeShellOutputObjectSchema = z
  .object({
    command: z.string().optional(),
    output: z.string().optional(),
    text: z.string().optional(),
    content: z.string().optional(),
    exitCode: z.number().nullable().optional(),
    exit_code: z.number().nullable().optional(),
    metadata: z
      .object({
        exitCode: z.number().nullable().optional(),
        exit_code: z.number().nullable().optional(),
      })
      .passthrough()
      .optional(),
    structuredContent: OpencodeTextLikeSchema.optional(),
    structured_content: OpencodeTextLikeSchema.optional(),
    result: OpencodeTextLikeSchema.optional(),
  })
  .passthrough();

const OpencodeShellOutputSchema = z.union([z.string(), OpencodeShellOutputObjectSchema]);

const OpencodeReadInputSchema = OpencodeFileReferenceCollectionSchema.extend({
  offset: z.number().finite().optional(),
  limit: z.number().finite().optional(),
}).passthrough();

const OpencodeReadOutputSchema = z.union([
  z.string(),
  OpencodeFileReferenceCollectionSchema.extend({
    content: z.string().optional(),
    text: z.string().optional(),
    output: z.string().optional(),
    structuredContent: OpencodeTextLikeSchema.optional(),
    structured_content: OpencodeTextLikeSchema.optional(),
    data: OpencodeTextLikeSchema.optional(),
  }).passthrough(),
]);

const OpencodeWriteInputSchema = OpencodeFileReferenceCollectionSchema.extend({
  content: z.string().optional(),
  newContent: z.string().optional(),
  new_content: z.string().optional(),
}).passthrough();

const OpencodeWriteOutputSchema = OpencodeFileReferenceCollectionSchema.extend({
  content: z.string().optional(),
  newContent: z.string().optional(),
  new_content: z.string().optional(),
}).passthrough();

const OpencodeEditInputSchema = OpencodeFileReferenceCollectionSchema.extend({
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

const OpencodeEditOutputSchema = OpencodeFileReferenceCollectionSchema.extend({
  patch: z.string().optional(),
  diff: z.string().optional(),
  unified_diff: z.string().optional(),
  unifiedDiff: z.string().optional(),
  files: z
    .array(
      OpencodeFileReferenceSchema.extend({
        patch: z.string().optional(),
        diff: z.string().optional(),
        unified_diff: z.string().optional(),
        unifiedDiff: z.string().optional(),
      }).passthrough()
    )
    .optional(),
}).passthrough();

const OpencodeSearchInputSchema = z
  .object({
    query: z.string().optional(),
    q: z.string().optional(),
  })
  .passthrough();

const OpencodeShellDetailCandidateSchema = z
  .object({
    toolName: OpencodeShellToolNameSchema,
    input: z.unknown().nullable(),
    output: z.unknown().nullable(),
  })
  .transform(({ input, output }) => resolveShellDetail(input, output));

const OpencodeReadDetailCandidateSchema = z
  .object({
    toolName: OpencodeReadToolNameSchema,
    input: z.unknown().nullable(),
    output: z.unknown().nullable(),
  })
  .transform(({ input, output }) => resolveReadDetail(input, output));

const OpencodeWriteDetailCandidateSchema = z
  .object({
    toolName: OpencodeWriteToolNameSchema,
    input: z.unknown().nullable(),
    output: z.unknown().nullable(),
  })
  .transform(({ input, output }) => resolveWriteDetail(input, output));

const OpencodeEditDetailCandidateSchema = z
  .object({
    toolName: OpencodeEditToolNameSchema,
    input: z.unknown().nullable(),
    output: z.unknown().nullable(),
  })
  .transform(({ input, output }) => resolveEditDetail(input, output));

const OpencodeSearchDetailCandidateSchema = z
  .object({
    toolName: OpencodeSearchToolNameSchema,
    input: z.unknown().nullable(),
    output: z.unknown().nullable(),
  })
  .transform(({ input }) => resolveSearchDetail(input));

const OpencodeKnownToolDetailSchema = z.union([
  OpencodeShellDetailCandidateSchema,
  OpencodeReadDetailCandidateSchema,
  OpencodeWriteDetailCandidateSchema,
  OpencodeEditDetailCandidateSchema,
  OpencodeSearchDetailCandidateSchema,
]);

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

function resolveFilePath(value: z.infer<typeof OpencodeFileReferenceCollectionSchema>): string | undefined {
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

function hashText(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function coerceCallId(callId: string | null | undefined, toolName: string, input: unknown): string {
  if (typeof callId === "string" && callId.trim().length > 0) {
    return callId;
  }

  let serialized = "";
  try {
    serialized = JSON.stringify(input) ?? "";
  } catch {
    serialized = String(input);
  }

  return `opencode-${hashText(`${toolName}:${serialized}`)}`;
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

function resolveShellDetail(input: unknown, output: unknown): ToolCallDetail | undefined {
  const parsedInput = OpencodeShellInputSchema.safeParse(input);
  const parsedOutput = OpencodeShellOutputSchema.safeParse(output);

  const command =
    (parsedInput.success
      ? commandFromValue(parsedInput.data.command) ?? commandFromValue(parsedInput.data.cmd)
      : undefined) ??
    (parsedOutput.success && typeof parsedOutput.data !== "string"
      ? parsedOutput.data.command
      : undefined);

  if (!command) {
    return undefined;
  }

  const cwd = parsedInput.success
    ? firstNonEmpty(parsedInput.data.cwd, parsedInput.data.directory)
    : undefined;

  const outputText =
    parsedOutput.success
      ? typeof parsedOutput.data === "string"
        ? parsedOutput.data
        : firstNonEmpty(
            parsedOutput.data.output,
            parsedOutput.data.text,
            parsedOutput.data.content,
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
      ? parsedOutput.data.exitCode ?? parsedOutput.data.exit_code ?? parsedOutput.data.metadata?.exitCode ?? parsedOutput.data.metadata?.exit_code ?? null
      : null;

  return {
    type: "shell",
    command,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(outputText !== undefined ? { output: outputText } : {}),
    ...(exitCode !== null ? { exitCode } : { exitCode: null }),
  };
}

function resolveReadDetail(input: unknown, output: unknown): ToolCallDetail | undefined {
  const parsedInput = OpencodeReadInputSchema.safeParse(input);
  const parsedOutput = OpencodeReadOutputSchema.safeParse(output);

  const filePath = firstNonEmpty(
    parsedInput.success ? resolveFilePath(parsedInput.data) : undefined,
    parsedOutput.success && typeof parsedOutput.data !== "string"
      ? resolveFilePath(parsedOutput.data)
      : undefined
  );

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
            parsedOutput.data.structuredContent?.content,
            parsedOutput.data.structuredContent?.text,
            parsedOutput.data.structuredContent?.output,
            parsedOutput.data.structured_content?.content,
            parsedOutput.data.structured_content?.text,
            parsedOutput.data.structured_content?.output,
            parsedOutput.data.data?.content,
            parsedOutput.data.data?.text,
            parsedOutput.data.data?.output
          )
      : undefined;

  return {
    type: "read",
    filePath,
    ...(content !== undefined ? { content } : {}),
    ...(parsedInput.success && parsedInput.data.offset !== undefined ? { offset: parsedInput.data.offset } : {}),
    ...(parsedInput.success && parsedInput.data.limit !== undefined ? { limit: parsedInput.data.limit } : {}),
  };
}

function resolveWriteDetail(input: unknown, output: unknown): ToolCallDetail | undefined {
  const parsedInput = OpencodeWriteInputSchema.safeParse(input);
  const parsedOutput = OpencodeWriteOutputSchema.safeParse(output);

  const filePath = firstNonEmpty(
    parsedInput.success ? resolveFilePath(parsedInput.data) : undefined,
    parsedOutput.success ? resolveFilePath(parsedOutput.data) : undefined
  );

  if (!filePath) {
    return undefined;
  }

  const content = firstNonEmpty(
    parsedInput.success
      ? firstNonEmpty(parsedInput.data.content, parsedInput.data.newContent, parsedInput.data.new_content)
      : undefined,
    parsedOutput.success
      ? firstNonEmpty(parsedOutput.data.content, parsedOutput.data.newContent, parsedOutput.data.new_content)
      : undefined
  );

  return {
    type: "write",
    filePath,
    ...(content !== undefined ? { content } : {}),
  };
}

function resolveEditDetail(input: unknown, output: unknown): ToolCallDetail | undefined {
  const parsedInput = OpencodeEditInputSchema.safeParse(input);
  const parsedOutput = OpencodeEditOutputSchema.safeParse(output);

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

  const newString = parsedInput.success
    ? firstNonEmpty(
        parsedInput.data.new_string,
        parsedInput.data.new_str,
        parsedInput.data.newContent,
        parsedInput.data.new_content,
        parsedInput.data.content
      )
    : undefined;

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
  const parsedInput = OpencodeSearchInputSchema.safeParse(input);
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

export function mapOpencodeToolCall(params: OpencodeToolCallParams): ToolCallTimelineItem {
  const parsedParams = OpencodeToolCallParamsSchema.parse(params);
  const input = parsedParams.input ?? null;
  const output = parsedParams.output ?? null;
  const status = resolveStatus(parsedParams.status, parsedParams.error, output);
  const callId = coerceCallId(parsedParams.callId, parsedParams.toolName, input);
  const detail = deriveDetail(parsedParams.toolName, input, output);

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
