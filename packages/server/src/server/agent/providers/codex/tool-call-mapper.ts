import { z } from "zod";

import type { ToolCallDetail, ToolCallTimelineItem } from "../../agent-sdk-types.js";

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

const CodexFileReferenceSchema = z
  .object({
    file_path: z.string().optional(),
    filePath: z.string().optional(),
    path: z.string().optional(),
    target_path: z.string().optional(),
    targetPath: z.string().optional(),
  })
  .passthrough();

const CodexFileReferenceCollectionSchema = CodexFileReferenceSchema.extend({
  files: z.array(CodexFileReferenceSchema).optional(),
}).passthrough();

const CodexTextLikeSchema = z
  .object({
    output: z.string().optional(),
    text: z.string().optional(),
    content: z.string().optional(),
  })
  .passthrough();

const CodexShellInputSchema = z
  .object({
    command: z.union([z.string(), z.array(z.string())]).optional(),
    cmd: z.union([z.string(), z.array(z.string())]).optional(),
    cwd: z.string().optional(),
    directory: z.string().optional(),
  })
  .passthrough();

const CodexShellOutputObjectSchema = z
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
    structuredContent: CodexTextLikeSchema.optional(),
    structured_content: CodexTextLikeSchema.optional(),
    result: CodexTextLikeSchema.optional(),
  })
  .passthrough();

const CodexShellOutputSchema = z.union([z.string(), CodexShellOutputObjectSchema]);

const CodexReadInputSchema = CodexFileReferenceCollectionSchema.extend({
  offset: z.number().finite().optional(),
  limit: z.number().finite().optional(),
}).passthrough();

const CodexReadOutputSchema = z.union([
  z.string(),
  CodexFileReferenceCollectionSchema.extend({
    content: z.string().optional(),
    text: z.string().optional(),
    output: z.string().optional(),
    structuredContent: CodexTextLikeSchema.optional(),
    structured_content: CodexTextLikeSchema.optional(),
    data: CodexTextLikeSchema.optional(),
  }).passthrough(),
]);

const CodexWriteInputSchema = CodexFileReferenceCollectionSchema.extend({
  content: z.string().optional(),
  newContent: z.string().optional(),
  new_content: z.string().optional(),
}).passthrough();

const CodexWriteOutputSchema = CodexFileReferenceCollectionSchema.extend({
  content: z.string().optional(),
  newContent: z.string().optional(),
  new_content: z.string().optional(),
}).passthrough();

const CodexEditInputSchema = CodexFileReferenceCollectionSchema.extend({
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

const CodexEditOutputSchema = CodexFileReferenceCollectionSchema.extend({
  patch: z.string().optional(),
  diff: z.string().optional(),
  unified_diff: z.string().optional(),
  unifiedDiff: z.string().optional(),
  files: z
    .array(
      CodexFileReferenceSchema.extend({
        patch: z.string().optional(),
        diff: z.string().optional(),
        unified_diff: z.string().optional(),
        unifiedDiff: z.string().optional(),
      }).passthrough()
    )
    .optional(),
}).passthrough();

const CodexSearchInputSchema = z
  .object({
    query: z.string().optional(),
    q: z.string().optional(),
  })
  .passthrough();

const CodexShellToolNameSchema = z.union([
  z.literal("shell"),
  z.literal("bash"),
  z.literal("exec"),
  z.literal("exec_command"),
  z.literal("command"),
  z.literal("Bash"),
]);

const CodexReadToolNameSchema = z.union([
  z.literal("read"),
  z.literal("read_file"),
]);

const CodexWriteToolNameSchema = z.union([
  z.literal("write"),
  z.literal("write_file"),
  z.literal("create_file"),
]);

const CodexEditToolNameSchema = z.union([
  z.literal("edit"),
  z.literal("apply_patch"),
]);

const CodexSearchToolNameSchema = z.union([
  z.literal("web_search"),
  z.literal("search"),
]);

const CodexBuiltinToolNameSchema = z.enum([
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
  "web_search",
  "search",
]);

const CodexShellDetailCandidateSchema = z
  .object({
    name: CodexShellToolNameSchema,
    input: z.unknown().nullable(),
    output: z.unknown().nullable(),
    cwd: z.string().optional().nullable(),
  })
  .transform(({ input, output }) => resolveShellDetail(input, output));

const CodexReadDetailCandidateSchema = z
  .object({
    name: CodexReadToolNameSchema,
    input: z.unknown().nullable(),
    output: z.unknown().nullable(),
    cwd: z.string().optional().nullable(),
  })
  .transform(({ input, output, cwd }) => resolveReadDetail(input, output, { cwd }));

const CodexWriteDetailCandidateSchema = z
  .object({
    name: CodexWriteToolNameSchema,
    input: z.unknown().nullable(),
    output: z.unknown().nullable(),
    cwd: z.string().optional().nullable(),
  })
  .transform(({ input, output, cwd }) => resolveWriteDetail(input, output, { cwd }));

const CodexEditDetailCandidateSchema = z
  .object({
    name: CodexEditToolNameSchema,
    input: z.unknown().nullable(),
    output: z.unknown().nullable(),
    cwd: z.string().optional().nullable(),
  })
  .transform(({ input, output, cwd }) => resolveEditDetail(input, output, { cwd }));

const CodexSearchDetailCandidateSchema = z
  .object({
    name: CodexSearchToolNameSchema,
    input: z.unknown().nullable(),
    output: z.unknown().nullable(),
    cwd: z.string().optional().nullable(),
  })
  .transform(({ input }) => resolveSearchDetail(input));

const CodexKnownToolDetailSchema = z.union([
  CodexShellDetailCandidateSchema,
  CodexReadDetailCandidateSchema,
  CodexWriteDetailCandidateSchema,
  CodexEditDetailCandidateSchema,
  CodexSearchDetailCandidateSchema,
]);

const CodexCommandExecutionItemSchema = z
  .object({
    type: z.literal("commandExecution"),
    id: z.string().optional(),
    status: z.string().optional(),
    error: z.unknown().optional(),
    command: z.union([z.string(), z.array(z.string())]).optional(),
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

function hashText(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function coerceCallId(raw: string | null | undefined, name: string, input: unknown): string {
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw;
  }
  let serialized = "";
  try {
    serialized = JSON.stringify(input) ?? "";
  } catch {
    serialized = String(input);
  }
  return `codex-${hashText(`${name}:${serialized}`)}`;
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
    const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length) || ".";
    }
  }
  return trimmed;
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

function resolveFilePath(
  value: z.infer<typeof CodexFileReferenceCollectionSchema>,
  cwd: string | null | undefined
): string | undefined {
  return normalizeCodexFilePath(
    firstNonEmpty(
      value.file_path,
      value.filePath,
      value.path,
      value.target_path,
      value.targetPath,
      value.files?.[0]?.path,
      value.files?.[0]?.filePath,
      value.files?.[0]?.file_path
    ),
    cwd
  );
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

function resolveShellDetail(input: unknown, output: unknown): ToolCallDetail | undefined {
  const parsedInput = CodexShellInputSchema.safeParse(input);
  const parsedOutput = CodexShellOutputSchema.safeParse(output);

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
      ? parsedOutput.data.exitCode ??
        parsedOutput.data.exit_code ??
        parsedOutput.data.metadata?.exitCode ??
        parsedOutput.data.metadata?.exit_code ??
        null
      : null;

  return {
    type: "shell",
    command,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(outputText !== undefined ? { output: outputText } : {}),
    ...(exitCode !== null ? { exitCode } : { exitCode: null }),
  };
}

function resolveReadDetail(input: unknown, output: unknown, options?: CodexMapperOptions): ToolCallDetail | undefined {
  const parsedInput = CodexReadInputSchema.safeParse(input);
  const parsedOutput = CodexReadOutputSchema.safeParse(output);

  const filePath = firstNonEmpty(
    parsedInput.success ? resolveFilePath(parsedInput.data, options?.cwd) : undefined,
    parsedOutput.success && typeof parsedOutput.data !== "string"
      ? resolveFilePath(parsedOutput.data, options?.cwd)
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

function resolveWriteDetail(input: unknown, output: unknown, options?: CodexMapperOptions): ToolCallDetail | undefined {
  const parsedInput = CodexWriteInputSchema.safeParse(input);
  const parsedOutput = CodexWriteOutputSchema.safeParse(output);

  const filePath = firstNonEmpty(
    parsedInput.success ? resolveFilePath(parsedInput.data, options?.cwd) : undefined,
    parsedOutput.success ? resolveFilePath(parsedOutput.data, options?.cwd) : undefined
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

function resolveEditDetail(input: unknown, output: unknown, options?: CodexMapperOptions): ToolCallDetail | undefined {
  const parsedInput = CodexEditInputSchema.safeParse(input);
  const parsedOutput = CodexEditOutputSchema.safeParse(output);

  const filePath = firstNonEmpty(
    parsedInput.success ? resolveFilePath(parsedInput.data, options?.cwd) : undefined,
    parsedOutput.success ? resolveFilePath(parsedOutput.data, options?.cwd) : undefined
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
  const parsedInput = CodexSearchInputSchema.safeParse(input);
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

function deriveDetail(name: string, input: unknown, output: unknown, options?: CodexMapperOptions): ToolCallDetail | undefined {
  const parsed = CodexKnownToolDetailSchema.safeParse({
    name,
    input,
    output,
    cwd: options?.cwd ?? null,
  });
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data;
}

function buildToolCall(
  params: {
    callId: string;
    name: string;
    status: ToolCallTimelineItem["status"];
    input: unknown | null;
    output: unknown | null;
    error: unknown | null;
    metadata?: Record<string, unknown>;
  },
  options?: CodexMapperOptions
): ToolCallTimelineItem {
  const detail = deriveDetail(params.name, params.input, params.output, options);

  if (params.status === "failed") {
    return {
      type: "tool_call",
      callId: params.callId,
      name: params.name,
      status: "failed",
      input: params.input,
      output: params.output,
      error: params.error ?? { message: "Tool call failed" },
      ...(detail ? { detail } : {}),
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
    ...(detail ? { detail } : {}),
    ...(params.metadata ? { metadata: params.metadata } : {}),
  };
}

function buildMcpToolName(server: string | undefined, tool: string): string {
  const trimmedTool = tool.trim();
  if (!trimmedTool) {
    return "tool";
  }

  const builtin = CodexBuiltinToolNameSchema.safeParse(trimmedTool);
  if (builtin.success) {
    return builtin.data;
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
  item: z.infer<typeof CodexCommandExecutionItemSchema>,
  options?: CodexMapperOptions
): ToolCallTimelineItem {
  const command = commandFromValue(item.command);
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

  const name = "shell";
  const callId = coerceCallId(item.id, name, input);
  const error = item.error ?? null;
  const status = resolveStatus(item.status, error, output);

  return buildToolCall(
    {
      callId,
      name,
      status,
      input,
      output,
      error,
    },
    options
  );
}

function mapFileChangeItem(
  item: z.infer<typeof CodexFileChangeItemSchema>,
  options?: CodexMapperOptions
): ToolCallTimelineItem {
  const changes = item.changes ?? [];

  const files = changes.map((change) => ({
    ...(normalizeCodexFilePath(change.path, options?.cwd) !== undefined
      ? { path: normalizeCodexFilePath(change.path, options?.cwd) }
      : {}),
    ...(change.kind !== undefined ? { kind: change.kind } : {}),
  }));

  const outputFiles = changes.map((change) => ({
    ...(normalizeCodexFilePath(change.path, options?.cwd) !== undefined
      ? { path: normalizeCodexFilePath(change.path, options?.cwd) }
      : {}),
    ...(change.diff !== undefined ? { patch: change.diff } : {}),
    ...(change.kind !== undefined ? { kind: change.kind } : {}),
  }));

  const input = toNullableObject({ ...(files.length > 0 ? { files } : {}) });
  const output = toNullableObject({ ...(outputFiles.length > 0 ? { files: outputFiles } : {}) });
  const name = "apply_patch";
  const callId = coerceCallId(item.id, name, input);
  const error = item.error ?? null;
  const status = resolveStatus(item.status, error, output);

  return buildToolCall(
    {
      callId,
      name,
      status,
      input,
      output,
      error,
    },
    options
  );
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

  return buildToolCall(
    {
      callId,
      name,
      status,
      input,
      output,
      error,
    },
    options
  );
}

function mapWebSearchItem(
  item: z.infer<typeof CodexWebSearchItemSchema>,
  options?: CodexMapperOptions
): ToolCallTimelineItem {
  const input = item.query !== undefined ? { query: item.query } : null;
  const output = item.action ?? null;
  const name = "web_search";
  const callId = coerceCallId(item.id, name, input);
  const error = item.error ?? null;
  const status = resolveStatus(item.status ?? "completed", error, output);

  return buildToolCall(
    {
      callId,
      name,
      status,
      input,
      output,
      error,
    },
    options
  );
}

function createCodexThreadItemToTimelineSchema(options?: CodexMapperOptions) {
  return CodexThreadItemSchema.transform((item): ToolCallTimelineItem => {
    switch (item.type) {
      case "commandExecution":
        return mapCommandExecutionItem(item, options);
      case "fileChange":
        return mapFileChangeItem(item, options);
      case "mcpToolCall":
        return mapMcpToolCallItem(item, options);
      case "webSearch":
        return mapWebSearchItem(item, options);
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

  return buildToolCall({
    callId,
    name: parsed.name,
    status,
    input,
    output,
    error,
  });
}
