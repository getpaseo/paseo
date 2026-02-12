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

const CodexToolEnvelopeSchema = z
  .object({
    name: z.string().min(1),
    input: z.unknown().nullable(),
    output: z.unknown().nullable(),
    cwd: z.string().nullable().optional(),
  })
  .passthrough();

const CodexSpeakToolDetailSchema = z
  .object({
    name: z.literal("speak"),
    input: z
      .union([
        z.string().transform((text) => ({ text })),
        z.object({ text: z.string() }).passthrough(),
      ])
      .nullable(),
    output: z.unknown().nullable(),
    cwd: z.string().nullable().optional(),
  })
  .transform(({ input }) => {
    const text = input?.text?.trim() ?? "";
    if (!text) {
      return undefined;
    }
    return {
      type: "unknown",
      input: text,
      output: null,
    } satisfies ToolCallDetail;
  });

const CodexLooseEditOutputSchema = z.unknown().transform((value) => {
  const parsed = ToolEditOutputSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
});

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

const CodexToolDetailPass2Schema = z.union([
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
  toolDetailBranchByNameWithCwd("read", ToolReadInputSchema, z.unknown(), (input, output, cwd) => {
    const parsedOutput = ToolReadOutputWithPathSchema.safeParse(output);
    return toReadToolDetail(input, parsedOutput.success ? parsedOutput.data : null, {
      normalizePath: normalizePathForCwd(cwd),
    });
  }),
  toolDetailBranchByNameWithCwd(
    "read_file",
    ToolReadInputSchema,
    z.unknown(),
    (input, output, cwd) => {
      const parsedOutput = ToolReadOutputWithPathSchema.safeParse(output);
      return toReadToolDetail(input, parsedOutput.success ? parsedOutput.data : null, {
        normalizePath: normalizePathForCwd(cwd),
      });
    }
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
  toolDetailBranchByNameWithCwd("edit", ToolEditInputSchema, CodexLooseEditOutputSchema, (input, output, cwd) =>
    toEditToolDetail(input, output, { normalizePath: normalizePathForCwd(cwd) })
  ),
  toolDetailBranchByNameWithCwd(
    "apply_patch",
    ToolEditInputSchema,
    CodexLooseEditOutputSchema,
    (input, output, cwd) => toEditToolDetail(input, output, { normalizePath: normalizePathForCwd(cwd) })
  ),
  toolDetailBranchByNameWithCwd(
    "apply_diff",
    ToolEditInputSchema,
    CodexLooseEditOutputSchema,
    (input, output, cwd) => toEditToolDetail(input, output, { normalizePath: normalizePathForCwd(cwd) })
  ),
  toolDetailBranchByNameWithCwd("search", ToolSearchInputSchema, z.unknown(), (input) =>
    toSearchToolDetail(input)
  ),
  toolDetailBranchByNameWithCwd("web_search", ToolSearchInputSchema, z.unknown(), (input) =>
    toSearchToolDetail(input)
  ),
  CodexSpeakToolDetailSchema,
]);

export function deriveCodexToolDetail(params: {
  name: string;
  input: unknown;
  output: unknown;
  cwd?: string | null;
}): ToolCallDetail {
  const pass1 = CodexToolEnvelopeSchema.safeParse({
    name: params.name,
    input: params.input ?? null,
    output: params.output ?? null,
    cwd: params.cwd ?? null,
  });
  if (!pass1.success) {
    return {
      type: "unknown",
      input: params.input ?? null,
      output: params.output ?? null,
    };
  }

  const pass2 = CodexToolDetailPass2Schema.safeParse(pass1.data);
  if (pass2.success && pass2.data) {
    return pass2.data;
  }

  return {
    type: "unknown",
    input: pass1.data.input,
    output: pass1.data.output,
  };
}
