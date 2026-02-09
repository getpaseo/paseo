import { z } from "zod";

import type { ToolCallDetail } from "../../agent-sdk-types.js";
import { stripCwdPrefix } from "../../../../shared/path-utils.js";
import {
  ToolEditInputSchema,
  ToolEditOutputSchema,
  ToolReadInputSchema,
  ToolReadOutputWithPathSchema,
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
  toolDetailBranchByNameWithCwd,
} from "../tool-call-detail-primitives.js";

export type CodexToolDetailContext = {
  cwd?: string | null;
};

export const CODEX_BUILTIN_TOOL_NAMES = new Set([
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

export function normalizeCodexFilePath(
  filePath: string,
  cwd: string | null | undefined
): string | undefined {
  if (!filePath) {
    return undefined;
  }

  if (typeof cwd === "string" && cwd.length > 0) {
    return stripCwdPrefix(filePath, cwd);
  }
  return filePath;
}

function normalizePathForCwd(cwd: string | null): (filePath: string) => string | undefined {
  return (filePath) => normalizeCodexFilePath(filePath, cwd);
}

const CodexKnownToolDetailSchema = z.union([
  toolDetailBranchByNameWithCwd("Bash", ToolShellInputSchema, ToolShellOutputSchema, (input, output) =>
    toShellToolDetail(input, output)
  ),
  toolDetailBranchByNameWithCwd("shell", ToolShellInputSchema, ToolShellOutputSchema, (input, output) =>
    toShellToolDetail(input, output)
  ),
  toolDetailBranchByNameWithCwd("bash", ToolShellInputSchema, ToolShellOutputSchema, (input, output) =>
    toShellToolDetail(input, output)
  ),
  toolDetailBranchByNameWithCwd("exec", ToolShellInputSchema, ToolShellOutputSchema, (input, output) =>
    toShellToolDetail(input, output)
  ),
  toolDetailBranchByNameWithCwd(
    "exec_command",
    ToolShellInputSchema,
    ToolShellOutputSchema,
    (input, output) => toShellToolDetail(input, output)
  ),
  toolDetailBranchByNameWithCwd("command", ToolShellInputSchema, ToolShellOutputSchema, (input, output) =>
    toShellToolDetail(input, output)
  ),
  toolDetailBranchByNameWithCwd("read", ToolReadInputSchema, ToolReadOutputWithPathSchema, (input, output, cwd) =>
    toReadToolDetail(input, output, { normalizePath: normalizePathForCwd(cwd) })
  ),
  toolDetailBranchByNameWithCwd(
    "read_file",
    ToolReadInputSchema,
    ToolReadOutputWithPathSchema,
    (input, output, cwd) => toReadToolDetail(input, output, { normalizePath: normalizePathForCwd(cwd) })
  ),
  toolDetailBranchByNameWithCwd("write", ToolWriteInputSchema, ToolWriteOutputSchema, (input, output, cwd) =>
    toWriteToolDetail(input, output, { normalizePath: normalizePathForCwd(cwd) })
  ),
  toolDetailBranchByNameWithCwd(
    "write_file",
    ToolWriteInputSchema,
    ToolWriteOutputSchema,
    (input, output, cwd) => toWriteToolDetail(input, output, { normalizePath: normalizePathForCwd(cwd) })
  ),
  toolDetailBranchByNameWithCwd(
    "create_file",
    ToolWriteInputSchema,
    ToolWriteOutputSchema,
    (input, output, cwd) => toWriteToolDetail(input, output, { normalizePath: normalizePathForCwd(cwd) })
  ),
  toolDetailBranchByNameWithCwd("edit", ToolEditInputSchema, ToolEditOutputSchema, (input, output, cwd) =>
    toEditToolDetail(input, output, { normalizePath: normalizePathForCwd(cwd) })
  ),
  toolDetailBranchByNameWithCwd(
    "apply_patch",
    ToolEditInputSchema,
    ToolEditOutputSchema,
    (input, output, cwd) => toEditToolDetail(input, output, { normalizePath: normalizePathForCwd(cwd) })
  ),
  toolDetailBranchByNameWithCwd(
    "apply_diff",
    ToolEditInputSchema,
    ToolEditOutputSchema,
    (input, output, cwd) => toEditToolDetail(input, output, { normalizePath: normalizePathForCwd(cwd) })
  ),
  toolDetailBranchByNameWithCwd("search", ToolSearchInputSchema, z.unknown(), (input) =>
    toSearchToolDetail(input)
  ),
  toolDetailBranchByNameWithCwd("web_search", ToolSearchInputSchema, z.unknown(), (input) =>
    toSearchToolDetail(input)
  ),
]);

export function deriveCodexToolDetail(params: {
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
