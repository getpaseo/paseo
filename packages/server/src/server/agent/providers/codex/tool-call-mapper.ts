import { z } from "zod";

import type { ToolCallDetail, ToolCallTimelineItem } from "../../agent-sdk-types.js";
import {
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
  input: unknown | null;
  output: unknown | null;
  status: ToolCallTimelineItem["status"];
  error: unknown | null;
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
    metadata: z.record(z.unknown()).optional(),
    cwd: z.string().nullable().optional(),
  })
  .passthrough();

const CODEX_SPEAK_TOOL_NAME = "paseo.speak";
const CODEX_SHELL_TOOL_NAMES = ["Bash", "shell", "bash", "exec", "exec_command", "command"] as const;
const CODEX_READ_TOOL_NAMES = ["read", "read_file"] as const;
const CODEX_WRITE_TOOL_NAMES = ["write", "write_file", "create_file"] as const;
const CODEX_EDIT_TOOL_NAMES = ["edit", "apply_patch", "apply_diff"] as const;
const CODEX_SEARCH_TOOL_NAMES = ["search", "web_search"] as const;

type CodexToolKind = "shell" | "read" | "write" | "edit" | "search" | "speak" | "unknown";

const CodexToolKindByName: Record<string, Exclude<CodexToolKind, "unknown">> = {
  Bash: "shell",
  shell: "shell",
  bash: "shell",
  exec: "shell",
  exec_command: "shell",
  command: "shell",
  read: "read",
  read_file: "read",
  write: "write",
  write_file: "write",
  create_file: "write",
  edit: "edit",
  apply_patch: "edit",
  apply_diff: "edit",
  search: "search",
  web_search: "search",
  [CODEX_SPEAK_TOOL_NAME]: "speak",
};

const CodexToolKindSchema = z.enum(["shell", "read", "write", "edit", "search", "speak", "unknown"]);

function resolveCodexToolKind(name: string): CodexToolKind {
  return CodexToolKindByName[name] ?? "unknown";
}

const CodexToolCallPass2BaseSchema = CodexNormalizedToolCallPass1Schema.extend({
  toolKind: CodexToolKindSchema,
});

const CodexToolCallPass2InputSchema = CodexNormalizedToolCallPass1Schema.transform((envelope) => {
  const name = envelope.name.trim();
  return {
    ...envelope,
    name,
    toolKind: resolveCodexToolKind(name),
  };
});

const CodexNormalizedToolCallPass2Schema = z.discriminatedUnion("toolKind", [
  CodexToolCallPass2BaseSchema.extend({
    toolKind: z.literal("shell"),
    name: z.enum(CODEX_SHELL_TOOL_NAMES),
  }).transform((envelope) => {
    const detail = deriveCodexToolDetail({
      name: envelope.name,
      input: envelope.input,
      output: envelope.output,
      cwd: envelope.cwd ?? null,
    });

    return buildToolCall({
      callId: envelope.callId,
      name: envelope.name,
      status: envelope.status,
      error: envelope.error,
      detail,
      ...(envelope.metadata ? { metadata: envelope.metadata } : {}),
    });
  }),
  CodexToolCallPass2BaseSchema.extend({
    toolKind: z.literal("read"),
    name: z.enum(CODEX_READ_TOOL_NAMES),
  }).transform((envelope) => {
    const detail = deriveCodexToolDetail({
      name: envelope.name,
      input: envelope.input,
      output: envelope.output,
      cwd: envelope.cwd ?? null,
    });

    return buildToolCall({
      callId: envelope.callId,
      name: envelope.name,
      status: envelope.status,
      error: envelope.error,
      detail,
      ...(envelope.metadata ? { metadata: envelope.metadata } : {}),
    });
  }),
  CodexToolCallPass2BaseSchema.extend({
    toolKind: z.literal("write"),
    name: z.enum(CODEX_WRITE_TOOL_NAMES),
  }).transform((envelope) => {
    const detail = deriveCodexToolDetail({
      name: envelope.name,
      input: envelope.input,
      output: envelope.output,
      cwd: envelope.cwd ?? null,
    });

    return buildToolCall({
      callId: envelope.callId,
      name: envelope.name,
      status: envelope.status,
      error: envelope.error,
      detail,
      ...(envelope.metadata ? { metadata: envelope.metadata } : {}),
    });
  }),
  CodexToolCallPass2BaseSchema.extend({
    toolKind: z.literal("edit"),
    name: z.enum(CODEX_EDIT_TOOL_NAMES),
  }).transform((envelope) => {
    const input = normalizeApplyPatchInput(envelope.input);
    let detail = deriveCodexToolDetail({
      name: envelope.name,
      input,
      output: envelope.output,
      cwd: envelope.cwd ?? null,
    });

    if (detail.type === "unknown") {
      const fallbackDetail = deriveApplyPatchDetailFromInput(input, envelope.cwd ?? null);
      if (fallbackDetail) {
        detail = fallbackDetail;
      }
    }

    if (
      detail.type === "edit" &&
      !hasRenderableEditContent(detail) &&
      envelope.output !== null
    ) {
      detail = {
        type: "unknown",
        input,
        output: envelope.output,
      };
    }

    return buildToolCall({
      callId: envelope.callId,
      name: envelope.name,
      status: envelope.status,
      error: envelope.error,
      detail,
      ...(envelope.metadata ? { metadata: envelope.metadata } : {}),
    });
  }),
  CodexToolCallPass2BaseSchema.extend({
    toolKind: z.literal("search"),
    name: z.enum(CODEX_SEARCH_TOOL_NAMES),
  }).transform((envelope) => {
    const detail = deriveCodexToolDetail({
      name: envelope.name,
      input: envelope.input,
      output: envelope.output,
      cwd: envelope.cwd ?? null,
    });

    return buildToolCall({
      callId: envelope.callId,
      name: envelope.name,
      status: envelope.status,
      error: envelope.error,
      detail,
      ...(envelope.metadata ? { metadata: envelope.metadata } : {}),
    });
  }),
  CodexToolCallPass2BaseSchema.extend({
    toolKind: z.literal("speak"),
    name: z.literal(CODEX_SPEAK_TOOL_NAME),
  }).transform((envelope) => {
    const canonicalName = "speak";
    const detail = deriveCodexToolDetail({
      name: canonicalName,
      input: envelope.input,
      output: envelope.output,
      cwd: envelope.cwd ?? null,
    });

    return buildToolCall({
      callId: envelope.callId,
      name: canonicalName,
      status: envelope.status,
      error: envelope.error,
      detail,
      ...(envelope.metadata ? { metadata: envelope.metadata } : {}),
    });
  }),
  CodexToolCallPass2BaseSchema.extend({
    toolKind: z.literal("unknown"),
  }).transform((envelope) => {
    const detail = deriveCodexToolDetail({
      name: envelope.name,
      input: envelope.input,
      output: envelope.output,
      cwd: envelope.cwd ?? null,
    });

    return buildToolCall({
      callId: envelope.callId,
      name: envelope.name,
      status: envelope.status,
      error: envelope.error,
      detail,
      ...(envelope.metadata ? { metadata: envelope.metadata } : {}),
    });
  }),
]);

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
    changes: z
      .array(
        z
          .object({
            path: z.string().optional(),
            kind: z.string().optional(),
            diff: z.string().optional(),
            patch: z.string().optional(),
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

function hasRenderableEditContent(detail: ToolCallDetail): boolean {
  if (detail.type !== "edit") {
    return false;
  }
  return (
    (typeof detail.unifiedDiff === "string" && detail.unifiedDiff.length > 0) ||
    (typeof detail.newString === "string" && detail.newString.length > 0) ||
    (typeof detail.oldString === "string" && detail.oldString.length > 0)
  );
}

function pickFirstPatchLikeString(values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function removePatchLikeFields(input: Record<string, unknown>): Record<string, unknown> {
  const { patch: _patch, diff: _diff, ...rest } = input;
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
    (typeof input.file_path === "string" && input.file_path.trim().length > 0 && input.file_path.trim());
  const patchText =
    (typeof input.patch === "string" && input.patch) ||
    (typeof input.diff === "string" && input.diff) ||
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
    "";
  if (!pathValue) {
    return null;
  }

  const normalizedPath = normalizeCodexFilePath(pathValue, cwd) ?? pathValue;
  const diffText =
    (typeof input.patch === "string" && input.patch) ||
    (typeof input.diff === "string" && input.diff) ||
    (typeof input.content === "string" && input.content) ||
    undefined;

  const textFields = asEditTextFields(diffText);
  return {
    type: "edit",
    filePath: normalizedPath,
    ...textFields,
  };
}

function toToolCallFromNormalizedEnvelope(
  envelope: CodexNormalizedToolCallEnvelope
): ToolCallTimelineItem | null {
  const pass2Input = CodexToolCallPass2InputSchema.safeParse(envelope);
  if (!pass2Input.success) {
    return null;
  }
  const parsed = CodexNormalizedToolCallPass2Schema.safeParse(pass2Input.data);
  if (!parsed.success) {
    return null;
  }
  return parsed.data;
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

function mapFileChangeItem(
  item: z.infer<typeof CodexFileChangeItemSchema>,
  options?: CodexMapperOptions
): CodexNormalizedToolCallEnvelope {
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
        diff: pickFirstPatchLikeString([
          change.diff,
          change.patch,
          change.content,
        ]),
      };
    })
    .filter((change) => change.path !== undefined);

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

  const callId = parsed.data.callId?.trim();
  if (!callId) {
    return null;
  }

  const mapped = toToolCallFromNormalizedEnvelope({
    callId,
    name: parsed.data.name,
    input: parsed.data.input ?? null,
    output: parsed.data.output ?? null,
    error: parsed.data.error ?? null,
    status: resolveStatus("completed", parsed.data.error ?? null, parsed.data.output ?? null),
    cwd: params.cwd ?? null,
  });
  if (!mapped) {
    return null;
  }

  return mapped;
}
