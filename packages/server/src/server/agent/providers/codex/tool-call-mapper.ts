import { z } from "zod";

import type { ToolCallDetail, ToolCallTimelineItem } from "../../agent-sdk-types.js";
import { CommandValueSchema } from "../tool-call-detail-primitives.js";
import {
  coerceToolCallId,
  extractCodexShellOutput,
  truncateDiffText,
} from "../tool-call-mapper-utils.js";
import {
  CODEX_BUILTIN_TOOL_NAMES,
  deriveCodexToolDetail,
  normalizeCodexFilePath,
} from "./tool-call-detail-parser.js";

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

// ---------------------------------------------------------------------------
// Thread-item parsing
// ---------------------------------------------------------------------------

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
            content: z.string().optional(),
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

function coerceCallId(raw: string | null | undefined, name: string, input: unknown): string {
  return coerceToolCallId({
    providerPrefix: "codex",
    rawCallId: raw,
    toolName: name,
    input,
  });
}

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

function asPatchOrContentFields(text: string | undefined): { patch?: string; content?: string } {
  if (typeof text !== "string" || text.length === 0) {
    return {};
  }
  const classified = classifyDiffLikeText(text);
  if (classified.isDiff) {
    return { patch: truncateDiffText(classified.text) };
  }
  return { content: text };
}

function removePatchLikeFields(input: Record<string, unknown>): Record<string, unknown> {
  const {
    patch: _patch,
    diff: _diff,
    unified_diff: _unifiedDiffSnake,
    unifiedDiff: _unifiedDiffCamel,
    ...rest
  } = input;
  return rest;
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

function buildToolCall(params: {
  callId: string;
  name: string;
  status: ToolCallTimelineItem["status"];
  error: unknown | null;
  detail: ToolCallDetail;
  metadata?: Record<string, unknown>;
}): ToolCallTimelineItem {
  if (params.status === "failed") {
    return {
      type: "tool_call",
      callId: params.callId,
      name: params.name,
      status: "failed",
      error: params.error ?? { message: "Tool call failed" },
      detail: params.detail,
      ...(params.metadata ? { metadata: params.metadata } : {}),
    };
  }

  return {
    type: "tool_call",
    callId: params.callId,
    name: params.name,
    status: params.status,
    error: null,
    detail: params.detail,
    ...(params.metadata ? { metadata: params.metadata } : {}),
  };
}

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

function extractPatchPrimaryFilePath(patch: string): string | undefined {
  for (const line of patch.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("*** Add File:")) {
      return trimmed.replace("*** Add File:", "").trim();
    }
    if (trimmed.startsWith("*** Update File:")) {
      return trimmed.replace("*** Update File:", "").trim();
    }
    if (trimmed.startsWith("*** Delete File:")) {
      return trimmed.replace("*** Delete File:", "").trim();
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeApplyPatchInput(input: unknown): unknown {
  if (typeof input === "string") {
    const filePath = extractPatchPrimaryFilePath(input);
    const textFields = asPatchOrContentFields(input);
    return filePath ? { path: filePath, ...textFields } : textFields;
  }

  if (!isRecord(input)) {
    return input;
  }

  const existingPath =
    (typeof input.path === "string" && input.path.trim().length > 0 && input.path.trim()) ||
    (typeof input.file_path === "string" &&
      input.file_path.trim().length > 0 &&
      input.file_path.trim()) ||
    (typeof input.filePath === "string" &&
      input.filePath.trim().length > 0 &&
      input.filePath.trim());
  const patchText =
    (typeof input.patch === "string" && input.patch) ||
    (typeof input.diff === "string" && input.diff) ||
    (typeof input.unified_diff === "string" && input.unified_diff) ||
    (typeof input.unifiedDiff === "string" && input.unifiedDiff) ||
    undefined;
  const contentText = typeof input.content === "string" ? input.content : undefined;
  const inferredPatchFromContent = !patchText && typeof contentText === "string" ? contentText : undefined;
  const patchOrContentText = patchText ?? inferredPatchFromContent;

  if (existingPath && !patchOrContentText) {
    return input;
  }

  if (!patchOrContentText) {
    return input;
  }

  const base = removePatchLikeFields(input);
  if (inferredPatchFromContent) {
    delete (base as { content?: unknown }).content;
  }
  const filePath = existingPath || extractPatchPrimaryFilePath(patchOrContentText);
  const textFields = asPatchOrContentFields(patchOrContentText);
  return filePath ? { ...base, path: filePath, ...textFields } : { ...base, ...textFields };
}

function deriveApplyPatchDetailFromInput(
  input: unknown,
  cwd: string | null | undefined
): ToolCallDetail | null {
  if (!isRecord(input)) {
    return null;
  }

  const pathValue =
    (typeof input.path === "string" && input.path.trim()) ||
    (typeof input.file_path === "string" && input.file_path.trim()) ||
    (typeof input.filePath === "string" && input.filePath.trim()) ||
    "";
  if (!pathValue) {
    return null;
  }

  const normalizedPath = normalizeCodexFilePath(pathValue, cwd) ?? pathValue;
  const diffText =
    (typeof input.patch === "string" && input.patch) ||
    (typeof input.diff === "string" && input.diff) ||
    (typeof input.unified_diff === "string" && input.unified_diff) ||
    (typeof input.unifiedDiff === "string" && input.unifiedDiff) ||
    (typeof input.content === "string" && input.content) ||
    undefined;

  const textFields = asEditTextFields(diffText);
  return {
    type: "edit",
    filePath: normalizedPath,
    ...textFields,
  };
}

function mapCommandExecutionItem(
  item: z.infer<typeof CodexCommandExecutionItemSchema>
): ToolCallTimelineItem {
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

  const detail = command
    ? {
        type: "shell" as const,
        command,
        ...(item.cwd ? { cwd: item.cwd } : {}),
        ...(parsedOutput ? { output: parsedOutput } : {}),
        ...(item.exitCode !== undefined ? { exitCode: item.exitCode } : {}),
      }
    : {
        type: "unknown" as const,
        input,
        output,
      };

  const name = "shell";
  const callId = coerceCallId(item.id, name, input);
  const error = item.error ?? null;
  const status = resolveStatus(item.status, error, output);

  return buildToolCall({
    callId,
    name,
    status,
    error,
    detail,
  });
}

function mapFileChangeItem(
  item: z.infer<typeof CodexFileChangeItemSchema>,
  options?: CodexMapperOptions
): ToolCallTimelineItem {
  const changes = item.changes ?? [];

  const files = changes
    .map((change) => {
      const pathValue =
        typeof change.path === "string"
          ? normalizeCodexFilePath(change.path.trim(), options?.cwd)
          : undefined;

      return {
        path: pathValue,
        kind: change.kind,
        diff: change.diff ?? change.content,
      };
    })
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
            ...asEditFileOutputFields(file.diff),
          })),
        }
      : {}),
  });

  const firstFile = files[0];
  const firstTextFields = asEditTextFields(firstFile?.diff);
  const detail = firstFile?.path
    ? {
        type: "edit" as const,
        filePath: firstFile.path,
        ...firstTextFields,
      }
    : {
        type: "unknown" as const,
        input,
        output,
      };

  const name = "apply_patch";
  const callId = coerceCallId(item.id, name, input);
  const error = item.error ?? null;
  const status = resolveStatus(item.status, error, output);

  return buildToolCall({
    callId,
    name,
    status,
    error,
    detail,
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
  const detail = deriveCodexToolDetail({
    name: tool,
    input,
    output,
    cwd: options?.cwd ?? null,
  });

  return buildToolCall({
    callId,
    name,
    status,
    error,
    detail,
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
    : {
        type: "unknown" as const,
        input,
        output,
      };

  return buildToolCall({
    callId,
    name,
    status,
    error,
    detail,
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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
  cwd?: string | null;
}): ToolCallTimelineItem {
  const parsed = CodexRolloutToolCallParamsSchema.parse(params);
  const rawInput = parsed.input ?? null;
  const normalizedName = parsed.name.trim().toLowerCase();
  const input =
    normalizedName === "apply_patch" || normalizedName === "apply_diff"
      ? normalizeApplyPatchInput(rawInput)
      : rawInput;
  const output = parsed.output ?? null;
  const error = parsed.error ?? null;
  const status = resolveStatus("completed", error, output);
  const callId = coerceCallId(parsed.callId, parsed.name, input);
  let detail = deriveCodexToolDetail({
    name: parsed.name,
    input,
    output,
    cwd: params.cwd ?? null,
  });
  if (detail.type === "unknown" && (normalizedName === "apply_patch" || normalizedName === "apply_diff")) {
    const fallbackDetail = deriveApplyPatchDetailFromInput(input, params.cwd ?? null);
    if (fallbackDetail) {
      detail = fallbackDetail;
    }
  }

  return buildToolCall({
    callId,
    name: parsed.name,
    status,
    error,
    detail,
  });
}
