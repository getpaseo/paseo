import { z } from "zod";

import type { ToolCallTimelineItem } from "../../agent-sdk-types.js";
import {
  extractCodexShellOutput,
  truncateDiffText,
} from "../tool-call-mapper-utils.js";
import {
  deriveCodexToolDetail,
  normalizeCodexFilePath,
} from "./tool-call-detail-parser.js";

type CodexMapperOptions = { cwd?: string | null };

const FAILED_STATUSES = new Set(["failed", "error", "errored", "rejected", "denied"]);
const CANCELED_STATUSES = new Set(["canceled", "cancelled", "interrupted", "aborted"]);
const COMPLETED_STATUSES = new Set(["completed", "complete", "done", "success", "succeeded"]);
const CodexCommandValueSchema = z.union([z.string(), z.array(z.string())]);

const CodexToolCallStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "canceled",
]);

const CodexRolloutToolCallParamsSchema = z
  .object({
    callId: z.string().optional().nullable(),
    name: z.string().min(1),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .passthrough();

type CodexNormalizedToolCallEnvelope = {
  callId: string;
  name: string;
  input?: unknown | null;
  output?: unknown | null;
  status?: ToolCallTimelineItem["status"];
  error?: unknown | null;
  metadata?: Record<string, unknown>;
  cwd?: string | null;
};

const CodexNormalizedToolCallPass1Schema = z
  .object({
    callId: z.string().min(1),
    name: z.string().min(1),
    input: z.unknown().nullable(),
    output: z.unknown().nullable(),
    status: CodexToolCallStatusSchema,
    error: z.unknown().nullable(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    cwd: z.string().nullable().optional(),
  })
  .passthrough();

const CodexShellToolNameSchema = z.union([
  z.literal("Bash"),
  z.literal("shell"),
  z.literal("bash"),
  z.literal("exec"),
  z.literal("exec_command"),
  z.literal("command"),
]);
const CodexReadToolNameSchema = z.union([z.literal("read"), z.literal("read_file")]);
const CodexWriteToolNameSchema = z.union([
  z.literal("write"),
  z.literal("write_file"),
  z.literal("create_file"),
]);
const CodexEditToolNameSchema = z.union([
  z.literal("edit"),
  z.literal("apply_patch"),
  z.literal("apply_diff"),
]);
const CodexSearchToolNameSchema = z.union([z.literal("search"), z.literal("web_search")]);
const CodexSpeakToolNameSchema = z.literal("paseo.speak");

const CodexToolKindSchema = z.enum(["shell", "read", "write", "edit", "search", "speak", "unknown"]);

const CodexToolCallPass2BaseSchema = CodexNormalizedToolCallPass1Schema.extend({
  toolKind: CodexToolKindSchema,
});

const CodexToolCallPass2EnvelopeSchema = z.union([
  CodexNormalizedToolCallPass1Schema.extend({
    name: CodexShellToolNameSchema,
  }).transform((envelope) => ({ ...envelope, toolKind: "shell" as const })),
  CodexNormalizedToolCallPass1Schema.extend({
    name: CodexReadToolNameSchema,
  }).transform((envelope) => ({ ...envelope, toolKind: "read" as const })),
  CodexNormalizedToolCallPass1Schema.extend({
    name: CodexWriteToolNameSchema,
  }).transform((envelope) => ({ ...envelope, toolKind: "write" as const })),
  CodexNormalizedToolCallPass1Schema.extend({
    name: CodexEditToolNameSchema,
  }).transform((envelope) => ({ ...envelope, toolKind: "edit" as const })),
  CodexNormalizedToolCallPass1Schema.extend({
    name: CodexSearchToolNameSchema,
  }).transform((envelope) => ({ ...envelope, toolKind: "search" as const })),
  CodexNormalizedToolCallPass1Schema.extend({
    name: CodexSpeakToolNameSchema,
  }).transform((envelope) => ({ ...envelope, toolKind: "speak" as const })),
  CodexNormalizedToolCallPass1Schema.transform((envelope) => ({
    ...envelope,
    name: envelope.name.trim(),
    toolKind: "unknown" as const,
  })),
]);

const CodexNormalizedToolCallPass2Schema = z.discriminatedUnion("toolKind", [
  CodexToolCallPass2BaseSchema.extend({
    toolKind: z.literal("shell"),
    name: CodexShellToolNameSchema,
  }),
  CodexToolCallPass2BaseSchema.extend({
    toolKind: z.literal("read"),
    name: CodexReadToolNameSchema,
  }),
  CodexToolCallPass2BaseSchema.extend({
    toolKind: z.literal("write"),
    name: CodexWriteToolNameSchema,
  }),
  CodexToolCallPass2BaseSchema.extend({
    toolKind: z.literal("edit"),
    name: CodexEditToolNameSchema,
  }),
  CodexToolCallPass2BaseSchema.extend({
    toolKind: z.literal("search"),
    name: CodexSearchToolNameSchema,
  }),
  CodexToolCallPass2BaseSchema.extend({
    toolKind: z.literal("speak"),
    name: CodexSpeakToolNameSchema,
  }),
  CodexToolCallPass2BaseSchema.extend({
    toolKind: z.literal("unknown"),
  }),
]);

type CodexNormalizedToolCallPass2 = z.infer<typeof CodexNormalizedToolCallPass2Schema>;

function toToolCallTimelineItem(envelope: CodexNormalizedToolCallPass2): ToolCallTimelineItem {
  const name = envelope.toolKind === "speak" ? ("speak" as const) : envelope.name;
  const parsedDetail = deriveCodexToolDetail({
    name,
    input: envelope.input,
    output: envelope.output,
    cwd: envelope.cwd ?? null,
  });

  const detail: ToolCallTimelineItem["detail"] =
    envelope.toolKind === "edit" &&
    envelope.status !== "running" &&
    !hasRenderableEditDetail(parsedDetail)
      ? {
          type: "unknown",
          input: envelope.input,
          output: envelope.output,
        }
      : parsedDetail;

  if (envelope.status === "failed") {
    return {
      type: "tool_call",
      callId: envelope.callId,
      name,
      status: "failed",
      error: envelope.error ?? { message: "Tool call failed" },
      detail,
      ...(envelope.metadata ? { metadata: envelope.metadata } : {}),
    };
  }

  return {
    type: "tool_call",
    callId: envelope.callId,
    name,
    status: envelope.status,
    error: null,
    detail,
    ...(envelope.metadata ? { metadata: envelope.metadata } : {}),
  };
}

// ---------------------------------------------------------------------------
// Thread-item parsing
// ---------------------------------------------------------------------------

const CodexCommandExecutionItemSchema = z
  .object({
    type: z.literal("commandExecution"),
    id: z.string().min(1),
    status: z.string().optional(),
    error: z.unknown().optional(),
    command: CodexCommandValueSchema.optional(),
    cwd: z.string().optional(),
    aggregatedOutput: z.string().optional(),
    exitCode: z.number().nullable().optional(),
  })
  .passthrough();

const CodexFileChangeItemSchema = z
  .object({
    type: z.literal("fileChange"),
    id: z.string().min(1),
    status: z.string().optional(),
    error: z.unknown().optional(),
    changes: z.unknown().optional(),
  })
  .passthrough();

const CodexMcpToolCallItemSchema = z
  .object({
    type: z.literal("mcpToolCall"),
    id: z.string().min(1),
    status: z.string().optional(),
    error: z.unknown().optional(),
    tool: z.string().min(1),
    server: z.string().optional(),
    arguments: z.unknown().optional(),
    result: z.unknown().optional(),
  })
  .passthrough();

const CodexWebSearchItemSchema = z
  .object({
    type: z.literal("webSearch"),
    id: z.string().min(1),
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

function maybeUnwrapShellWrapperCommand(command: string): string {
  const trimmed = command.trim();
  const wrapperMatch = trimmed.match(
    /^(?:\/bin\/)?(?:zsh|bash|sh)\s+-(?:lc|c)\s+([\s\S]+)$/
  );
  if (!wrapperMatch) {
    return trimmed;
  }
  const candidate = wrapperMatch[1]?.trim() ?? "";
  if (!candidate) {
    return trimmed;
  }
  if (
    (candidate.startsWith('"') && candidate.endsWith('"')) ||
    (candidate.startsWith("'") && candidate.endsWith("'"))
  ) {
    return candidate.slice(1, -1);
  }
  return candidate;
}

function normalizeCommandExecutionCommand(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = maybeUnwrapShellWrapperCommand(value);
    return normalized.length > 0 ? normalized : undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (parts.length === 0) {
    return undefined;
  }
  if (parts.length >= 3 && (parts[1] === "-lc" || parts[1] === "-c")) {
    const unwrapped = parts[2]?.trim();
    return unwrapped && unwrapped.length > 0 ? unwrapped : undefined;
  }
  return parts.join(" ");
}

function looksLikeUnifiedDiff(text: string): boolean {
  const normalized = text.trimStart();
  if (!normalized) {
    return false;
  }
  return (
    normalized.startsWith("diff --git") ||
    normalized.startsWith("@@") ||
    normalized.startsWith("--- ") ||
    normalized.startsWith("+++ ")
  );
}

type CodexApplyPatchDirective = {
  kind: "add" | "update" | "delete";
  path: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCodexApplyPatchDirective(line: string): CodexApplyPatchDirective | null {
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

function extractPatchPrimaryFilePath(patch: string): string | undefined {
  for (const line of patch.split(/\r?\n/)) {
    const directive = parseCodexApplyPatchDirective(line);
    if (directive && directive.path.length > 0) {
      return directive.path;
    }
  }
  return undefined;
}

function looksLikeCodexApplyPatch(text: string): boolean {
  const normalized = text.trimStart();
  if (!normalized) {
    return false;
  }
  if (normalized.startsWith("*** Begin Patch")) {
    return true;
  }
  return text.split(/\r?\n/).some((line) => parseCodexApplyPatchDirective(line) !== null);
}

function normalizeDiffHeaderPath(rawPath: string): string {
  return rawPath.trim().replace(/^["']+|["']+$/g, "");
}

function codexApplyPatchToUnifiedDiff(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const output: string[] = [];
  let sawDiffBody = false;

  for (const line of lines) {
    const directive = parseCodexApplyPatchDirective(line);
    if (directive) {
      const path = normalizeDiffHeaderPath(directive.path);
      if (path.length > 0) {
        if (output.length > 0 && output[output.length - 1] !== "") {
          output.push("");
        }
        const left = directive.kind === "add" ? "/dev/null" : `a/${path}`;
        const right = directive.kind === "delete" ? "/dev/null" : `b/${path}`;
        output.push(`diff --git a/${path} b/${path}`);
        output.push(`--- ${left}`);
        output.push(`+++ ${right}`);
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

    if (line.startsWith("@@")) {
      output.push(line);
      sawDiffBody = true;
      continue;
    }
    if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) {
      output.push(line);
      sawDiffBody = true;
      continue;
    }
    if (line.startsWith("\\ No newline at end of file")) {
      output.push(line);
      sawDiffBody = true;
      continue;
    }
  }

  if (!sawDiffBody) {
    return text;
  }

  const normalized = output.join("\n").trim();
  return normalized.length > 0 ? normalized : text;
}

function classifyDiffLikeText(
  text: string
): { isDiff: true; text: string } | { isDiff: false; text: string } {
  if (looksLikeUnifiedDiff(text)) {
    return { isDiff: true, text };
  }
  if (looksLikeCodexApplyPatch(text)) {
    return { isDiff: true, text: codexApplyPatchToUnifiedDiff(text) };
  }
  return { isDiff: false, text };
}

function asEditTextFields(
  text: string | undefined
): { unifiedDiff?: string; newString?: string } {
  if (typeof text !== "string" || text.length === 0) {
    return {};
  }
  const classified = classifyDiffLikeText(text);
  if (classified.isDiff) {
    return { unifiedDiff: truncateDiffText(classified.text) };
  }
  return { newString: text };
}

function normalizeRolloutEditInput(input: unknown): unknown {
  if (typeof input === "string") {
    const textFields = asEditTextFields(input);
    const path = extractPatchPrimaryFilePath(input);
    return {
      ...(path ? { path } : {}),
      ...(textFields.unifiedDiff ? { patch: textFields.unifiedDiff } : {}),
      ...(textFields.newString ? { content: textFields.newString } : {}),
    };
  }
  if (!isRecord(input)) {
    return input;
  }

  const candidatePatchText =
    (typeof input.patch === "string" && input.patch) ||
    (typeof input.diff === "string" && input.diff) ||
    (typeof input.unified_diff === "string" && input.unified_diff) ||
    (typeof input.unifiedDiff === "string" && input.unifiedDiff) ||
    (typeof input.content === "string" && input.content) ||
    undefined;
  if (!candidatePatchText) {
    return input;
  }

  const textFields = asEditTextFields(candidatePatchText);
  const rawPath =
    (typeof input.path === "string" && input.path.trim().length > 0 ? input.path : undefined) ||
    (typeof input.file_path === "string" && input.file_path.trim().length > 0
      ? input.file_path
      : undefined) ||
    (typeof input.filePath === "string" && input.filePath.trim().length > 0
      ? input.filePath
      : undefined) ||
    extractPatchPrimaryFilePath(candidatePatchText);

  const {
    patch: _patch,
    diff: _diff,
    unified_diff: _unifiedDiffSnake,
    unifiedDiff: _unifiedDiffCamel,
    ...rest
  } = input;

  const normalized: Record<string, unknown> = {
    ...rest,
    ...(rawPath ? { path: rawPath } : {}),
    ...(textFields.unifiedDiff ? { patch: textFields.unifiedDiff } : {}),
    ...(textFields.newString ? { content: textFields.newString } : {}),
  };

  if (textFields.unifiedDiff && "content" in normalized) {
    delete normalized.content;
  }

  return normalized;
}

function asEditFileOutputFields(
  text: string | undefined
): { patch?: string; content?: string } {
  if (typeof text !== "string" || text.length === 0) {
    return {};
  }
  const classified = classifyDiffLikeText(text);
  if (classified.isDiff) {
    return { patch: truncateDiffText(classified.text) };
  }
  return { content: text };
}

function pickFirstPatchLikeString(values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function hasRenderableEditDetail(detail: ToolCallTimelineItem["detail"]): boolean {
  if (detail.type !== "edit") {
    return true;
  }
  return (
    (typeof detail.unifiedDiff === "string" && detail.unifiedDiff.trim().length > 0) ||
    (typeof detail.newString === "string" && detail.newString.trim().length > 0) ||
    (typeof detail.oldString === "string" && detail.oldString.trim().length > 0)
  );
}

function resolveStatus(
  rawStatus: string | undefined,
  error: unknown,
  output: unknown
): ToolCallTimelineItem["status"] {
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

function buildMcpToolName(server: string | undefined, tool: string): string {
  const trimmedTool = tool.trim();
  if (!trimmedTool) {
    return "tool";
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

function toToolCallFromNormalizedEnvelope(
  envelope: CodexNormalizedToolCallEnvelope
): ToolCallTimelineItem | null {
  const pass2Envelope = CodexToolCallPass2EnvelopeSchema.safeParse(envelope);
  if (!pass2Envelope.success) {
    return null;
  }
  const parsed = CodexNormalizedToolCallPass2Schema.safeParse(pass2Envelope.data);
  if (!parsed.success) {
    return null;
  }
  return toToolCallTimelineItem(parsed.data);
}

function mapCommandExecutionItem(
  item: z.infer<typeof CodexCommandExecutionItemSchema>
): CodexNormalizedToolCallEnvelope {
  const command = normalizeCommandExecutionCommand(item.command);
  const parsedOutput = extractCodexShellOutput(item.aggregatedOutput);
  const input = toNullableObject({
    ...(command !== undefined ? { command } : {}),
    ...(item.cwd !== undefined ? { cwd: item.cwd } : {}),
  });

  const output =
    parsedOutput !== undefined || item.exitCode !== undefined
      ? {
          ...(command !== undefined ? { command } : {}),
          ...(parsedOutput !== undefined ? { output: parsedOutput } : {}),
          ...(item.exitCode !== undefined ? { exitCode: item.exitCode } : {}),
        }
      : null;

  const name = "shell";
  const error = item.error ?? null;
  const status = resolveStatus(item.status, error, output);

  return {
    callId: item.id,
    name,
    input,
    output,
    status,
    error,
    cwd: item.cwd ?? null,
  };
}

type CodexFileChangeEntry = {
  path: string;
  kind?: string;
  diff?: string;
};

function parseFileChangePath(
  entry: Record<string, unknown>,
  options?: CodexMapperOptions,
  fallbackPath?: string
): string | undefined {
  const rawPath =
    (typeof entry.path === "string" && entry.path.trim().length > 0
      ? entry.path.trim()
      : undefined) ??
    (typeof entry.file_path === "string" && entry.file_path.trim().length > 0
      ? entry.file_path.trim()
      : undefined) ??
    (typeof entry.filePath === "string" && entry.filePath.trim().length > 0
      ? entry.filePath.trim()
      : undefined) ??
    (typeof fallbackPath === "string" && fallbackPath.trim().length > 0
      ? fallbackPath.trim()
      : undefined);
  if (!rawPath) {
    return undefined;
  }
  return normalizeCodexFilePath(rawPath, options?.cwd);
}

function parseFileChangeKind(entry: Record<string, unknown>): string | undefined {
  return (
    (typeof entry.kind === "string" && entry.kind) ||
    (typeof entry.type === "string" && entry.type) ||
    undefined
  );
}

function parseFileChangeDiff(entry: Record<string, unknown>): string | undefined {
  return pickFirstPatchLikeString([
    entry.diff,
    entry.patch,
    entry.unified_diff,
    entry.unifiedDiff,
    entry.content,
    entry.newString,
  ]);
}

function toFileChangeEntry(
  entry: Record<string, unknown>,
  options?: CodexMapperOptions,
  fallbackPath?: string
): CodexFileChangeEntry | null {
  const path = parseFileChangePath(entry, options, fallbackPath);
  if (!path) {
    return null;
  }
  return {
    path,
    kind: parseFileChangeKind(entry),
    diff: parseFileChangeDiff(entry),
  };
}

function parseFileChangeEntries(
  changes: unknown,
  options?: CodexMapperOptions
): CodexFileChangeEntry[] {
  if (!changes) {
    return [];
  }

  if (Array.isArray(changes)) {
    return changes
      .map((entry) =>
        isRecord(entry) ? toFileChangeEntry(entry, options) : null
      )
      .filter((entry): entry is CodexFileChangeEntry => entry !== null);
  }

  if (!isRecord(changes)) {
    return [];
  }

  if (Array.isArray(changes.files)) {
    return parseFileChangeEntries(changes.files, options);
  }

  const singleEntry = toFileChangeEntry(changes, options);
  if (singleEntry) {
    return [singleEntry];
  }

  return Object.entries(changes)
    .map(([path, value]) => {
      if (isRecord(value)) {
        return toFileChangeEntry(value, options, path);
      }
      if (typeof value === "string") {
        const normalizedPath = normalizeCodexFilePath(path.trim(), options?.cwd);
        if (!normalizedPath) {
          return null;
        }
        return { path: normalizedPath, diff: value };
      }
      return null;
    })
    .filter((entry): entry is CodexFileChangeEntry => entry !== null);
}

function mapFileChangeItem(
  item: z.infer<typeof CodexFileChangeItemSchema>,
  options?: CodexMapperOptions
): CodexNormalizedToolCallEnvelope {
  const files = parseFileChangeEntries(item.changes, options);

  const inputBase = {
    ...(files.length > 0
      ? {
          files: files.map((file) => ({
            path: file.path,
            ...(file.kind !== undefined ? { kind: file.kind } : {}),
          })),
        }
      : {}),
  };

  const output = toNullableObject({
    ...(files.length > 0
      ? {
          files: files.map((file) => ({
            path: file.path,
            ...(file.kind !== undefined ? { kind: file.kind } : {}),
            ...asEditFileOutputFields(file.diff),
          })),
        }
      : {}),
  });

  const name = "apply_patch";
  const error = item.error ?? null;
  const status = resolveStatus(item.status, error, output);
  const firstFile = files[0];
  const firstTextFields = asEditTextFields(firstFile?.diff);
  const hasFirstTextFields = Object.keys(firstTextFields).length > 0;
  const input = toNullableObject({
    ...inputBase,
    ...(firstFile?.path && hasFirstTextFields ? { path: firstFile.path } : {}),
    ...(hasFirstTextFields && firstTextFields.unifiedDiff
      ? { patch: firstTextFields.unifiedDiff }
      : {}),
    ...(hasFirstTextFields && firstTextFields.newString
      ? { content: firstTextFields.newString }
      : {}),
  });

  return {
    callId: item.id,
    name,
    input,
    output,
    status,
    error,
    cwd: options?.cwd ?? null,
  };
}

function mapMcpToolCallItem(
  item: z.infer<typeof CodexMcpToolCallItemSchema>,
  options?: CodexMapperOptions
): CodexNormalizedToolCallEnvelope | null {
  const tool = item.tool.trim();
  if (!tool) {
    return null;
  }
  const name = buildMcpToolName(item.server, tool);
  const input = item.arguments ?? null;
  const output = item.result ?? null;
  const error = item.error ?? null;
  const status = resolveStatus(item.status, error, output);

  return {
    callId: item.id,
    name,
    input,
    output,
    status,
    error,
    cwd: options?.cwd ?? null,
  };
}

function mapWebSearchItem(
  item: z.infer<typeof CodexWebSearchItemSchema>
): CodexNormalizedToolCallEnvelope {
  const input = item.query !== undefined ? { query: item.query } : null;
  const output = item.action ?? null;
  const name = "web_search";
  const error = item.error ?? null;
  const status = resolveStatus(item.status ?? "completed", error, output);

  return {
    callId: item.id,
    name,
    input,
    output,
    status,
    error,
    cwd: null,
  };
}

function mapThreadItemToNormalizedEnvelope(
  item: z.infer<typeof CodexThreadItemSchema>,
  options?: CodexMapperOptions
): CodexNormalizedToolCallEnvelope | null {
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
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function mapCodexToolCallFromThreadItem(
  item: unknown,
  options?: CodexMapperOptions
): ToolCallTimelineItem | null {
  const parsed = CodexThreadItemSchema.safeParse(item);
  if (!parsed.success) {
    return null;
  }
  const envelope = mapThreadItemToNormalizedEnvelope(parsed.data, options);
  if (!envelope) {
    return null;
  }
  return toToolCallFromNormalizedEnvelope(envelope);
}

export function mapCodexRolloutToolCall(params: {
  callId?: string | null;
  name: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  cwd?: string | null;
}): ToolCallTimelineItem | null {
  const parsed = CodexRolloutToolCallParamsSchema.safeParse(params);
  if (!parsed.success) {
    return null;
  }

  const normalizedName = parsed.data.name.trim();
  const normalizedInput =
    normalizedName === "apply_patch" || normalizedName === "apply_diff"
      ? normalizeRolloutEditInput(parsed.data.input ?? null)
      : parsed.data.input ?? null;

  const pass1 = CodexNormalizedToolCallPass1Schema.safeParse({
    callId:
      typeof parsed.data.callId === "string" ? parsed.data.callId.trim() : "",
    name: normalizedName,
    input: normalizedInput,
    output: parsed.data.output ?? null,
    error: parsed.data.error ?? null,
    status: resolveStatus("completed", parsed.data.error ?? null, parsed.data.output ?? null),
    cwd: params.cwd ?? null,
  });
  if (!pass1.success) {
    return null;
  }

  const mapped = toToolCallFromNormalizedEnvelope(pass1.data);
  if (!mapped) {
    return null;
  }

  return mapped;
}
