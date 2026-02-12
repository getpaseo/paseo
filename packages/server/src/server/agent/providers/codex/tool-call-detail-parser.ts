import { z } from "zod";

import type { ToolCallDetail } from "../../agent-sdk-types.js";
import { stripCwdPrefix } from "../../../../shared/path-utils.js";
import {
  extractCodexShellOutput,
  flattenReadContent,
  nonEmptyString,
  truncateDiffText,
} from "../tool-call-mapper-utils.js";

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

const StringOrStringArraySchema = z.union([z.string(), z.array(z.string())]);

const CodexToolEnvelopeSchema = z
  .object({
    name: z.string().min(1),
    input: z.unknown().nullable(),
    output: z.unknown().nullable(),
    cwd: z.string().nullable().optional(),
  })
  .passthrough();

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

function normalizeDetailPath(
  filePath: string | undefined,
  cwd: string | null | undefined
): string | undefined {
  if (typeof filePath !== "string") {
    return undefined;
  }
  const trimmed = filePath.trim();
  if (!trimmed) {
    return undefined;
  }
  return normalizeCodexFilePath(trimmed, cwd);
}

function commandFromValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return nonEmptyString(value);
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const tokens = value
    .filter((token): token is string => typeof token === "string" && token.trim().length > 0)
    .map((token) => token.trim());
  return tokens.length > 0 ? tokens.join(" ") : undefined;
}

function parsePathFromInput(input: Record<string, unknown>): string | undefined {
  return nonEmptyString(input.path) ?? nonEmptyString(input.file_path);
}

function parsePathFromOutput(output: Record<string, unknown>): string | undefined {
  return nonEmptyString(output.path) ?? nonEmptyString(output.file_path);
}

function extractReadOutputContent(value: unknown): string | undefined {
  if (typeof value === "string") {
    return nonEmptyString(value);
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const output = value as Record<string, unknown>;
  const direct =
    flattenReadContent(output.content as any) ??
    flattenReadContent(output.text as any) ??
    flattenReadContent(output.output as any);
  if (direct) {
    return direct;
  }

  const structured = output.structured_content;
  if (structured && typeof structured === "object") {
    const structuredObj = structured as Record<string, unknown>;
    return (
      flattenReadContent(structuredObj.content as any) ??
      flattenReadContent(structuredObj.text as any) ??
      flattenReadContent(structuredObj.output as any)
    );
  }

  return undefined;
}

function parseShellDetail(
  input: unknown,
  output: unknown
): ToolCallDetail | undefined {
  const parsedInput = z
    .object({
      command: StringOrStringArraySchema.optional(),
      cwd: z.string().optional(),
    })
    .passthrough()
    .safeParse(input ?? {});

  const command = commandFromValue(parsedInput.success ? parsedInput.data.command : undefined);
  if (!command) {
    return undefined;
  }

  const parsedOutput = z
    .union([
      z.string().transform((text) => ({ output: text, exitCode: undefined as number | null | undefined })),
      z
        .object({
          output: z.string().optional(),
          text: z.string().optional(),
          content: z.string().optional(),
          exitCode: z.number().nullable().optional(),
        })
        .passthrough()
        .transform((value) => ({
          output:
            nonEmptyString(value.output) ??
            nonEmptyString(value.text) ??
            nonEmptyString(value.content),
          exitCode: value.exitCode,
        })),
    ])
    .safeParse(output ?? null);

  const shellOutput =
    parsedOutput.success && parsedOutput.data.output
      ? extractCodexShellOutput(parsedOutput.data.output)
      : undefined;

  return {
    type: "shell",
    command,
    ...(parsedInput.success
      ? {
          ...(nonEmptyString(parsedInput.data.cwd) ? { cwd: parsedInput.data.cwd } : {}),
        }
      : {}),
    ...(shellOutput ? { output: shellOutput } : {}),
    ...(parsedOutput.success && parsedOutput.data.exitCode !== undefined
      ? { exitCode: parsedOutput.data.exitCode }
      : {}),
  };
}

function parseReadDetail(
  input: unknown,
  output: unknown,
  cwd: string | null | undefined
): ToolCallDetail | undefined {
  const parsedInput = z
    .object({
      path: z.string().optional(),
      file_path: z.string().optional(),
      offset: z.number().finite().optional(),
      limit: z.number().finite().optional(),
    })
    .passthrough()
    .safeParse(input ?? {});
  const parsedOutput = z
    .object({
      path: z.string().optional(),
      file_path: z.string().optional(),
    })
    .passthrough()
    .safeParse(output ?? {});

  const filePath = normalizeDetailPath(
    parsedInput.success ? parsePathFromInput(parsedInput.data) : undefined,
    cwd
  ) ??
    normalizeDetailPath(
      parsedOutput.success ? parsePathFromOutput(parsedOutput.data) : undefined,
      cwd
    );

  if (!filePath) {
    return undefined;
  }

  const offset =
    parsedInput.success && typeof parsedInput.data.offset === "number"
      ? parsedInput.data.offset
      : undefined;
  const limit =
    parsedInput.success && typeof parsedInput.data.limit === "number"
      ? parsedInput.data.limit
      : undefined;

  const content = extractReadOutputContent(output);
  return {
    type: "read",
    filePath,
    ...(content ? { content } : {}),
    ...(offset !== undefined ? { offset } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

function parseWriteDetail(
  input: unknown,
  output: unknown,
  cwd: string | null | undefined
): ToolCallDetail | undefined {
  const parsedInput = z
    .object({
      path: z.string().optional(),
      file_path: z.string().optional(),
      content: z.string().optional(),
    })
    .passthrough()
    .safeParse(input ?? {});
  if (!parsedInput.success) {
    return undefined;
  }

  const filePath = normalizeDetailPath(parsePathFromInput(parsedInput.data), cwd);
  if (!filePath) {
    return undefined;
  }

  const parsedOutput = z
    .object({
      content: z.string().optional(),
    })
    .passthrough()
    .safeParse(output ?? {});
  const content =
    nonEmptyString(parsedInput.data.content) ??
    (parsedOutput.success ? nonEmptyString(parsedOutput.data.content) : undefined);

  return {
    type: "write",
    filePath,
    ...(content ? { content } : {}),
  };
}

function parseEditDetail(
  input: unknown,
  output: unknown,
  cwd: string | null | undefined
): ToolCallDetail | undefined {
  const parsedInput = z
    .object({
      path: z.string().optional(),
      file_path: z.string().optional(),
      old_string: z.string().optional(),
      new_string: z.string().optional(),
      content: z.string().optional(),
      patch: z.string().optional(),
      diff: z.string().optional(),
    })
    .passthrough()
    .safeParse(input ?? {});
  if (!parsedInput.success) {
    return undefined;
  }

  const filePath = normalizeDetailPath(parsePathFromInput(parsedInput.data), cwd);
  if (!filePath) {
    return undefined;
  }

  const parsedOutput = z
    .object({
      patch: z.string().optional(),
      diff: z.string().optional(),
      content: z.string().optional(),
      new_string: z.string().optional(),
    })
    .passthrough()
    .safeParse(output ?? {});

  const oldString = nonEmptyString(parsedInput.data.old_string);
  const newString =
    nonEmptyString(parsedInput.data.new_string) ??
    nonEmptyString(parsedInput.data.content) ??
    (parsedOutput.success
      ? nonEmptyString(parsedOutput.data.new_string) ??
        nonEmptyString(parsedOutput.data.content)
      : undefined);
  const unifiedDiff = truncateDiffText(
    nonEmptyString(parsedInput.data.patch) ??
      nonEmptyString(parsedInput.data.diff) ??
      (parsedOutput.success
        ? nonEmptyString(parsedOutput.data.patch) ??
          nonEmptyString(parsedOutput.data.diff)
        : undefined)
  );

  return {
    type: "edit",
    filePath,
    ...(oldString ? { oldString } : {}),
    ...(newString ? { newString } : {}),
    ...(unifiedDiff ? { unifiedDiff } : {}),
  };
}

function parseSearchDetail(input: unknown): ToolCallDetail | undefined {
  const parsed = z.object({ query: z.string() }).passthrough().safeParse(input ?? {});
  if (!parsed.success || !parsed.data.query) {
    return undefined;
  }
  return {
    type: "search",
    query: parsed.data.query,
  };
}

function parseSpeakDetail(input: unknown): ToolCallDetail | undefined {
  const parsed = z
    .union([
      z.string().transform((text) => ({ text })),
      z.object({ text: z.string() }).passthrough(),
    ])
    .safeParse(input ?? null);
  if (!parsed.success) {
    return undefined;
  }

  const text = nonEmptyString(parsed.data.text);
  if (!text) {
    return undefined;
  }

  return {
    type: "unknown",
    input: text,
    output: null,
  };
}

const CodexToolDetailPass2Schema = z.union([
  z
    .object({
      name: z.enum(["Bash", "shell", "bash", "exec", "exec_command", "command"]),
      input: z.unknown().nullable(),
      output: z.unknown().nullable(),
      cwd: z.string().nullable().optional(),
    })
    .transform((value) => parseShellDetail(value.input, value.output)),
  z
    .object({
      name: z.enum(["read", "read_file"]),
      input: z.unknown().nullable(),
      output: z.unknown().nullable(),
      cwd: z.string().nullable().optional(),
    })
    .transform((value) => parseReadDetail(value.input, value.output, value.cwd ?? null)),
  z
    .object({
      name: z.enum(["write", "write_file", "create_file"]),
      input: z.unknown().nullable(),
      output: z.unknown().nullable(),
      cwd: z.string().nullable().optional(),
    })
    .transform((value) => parseWriteDetail(value.input, value.output, value.cwd ?? null)),
  z
    .object({
      name: z.enum(["edit", "apply_patch", "apply_diff"]),
      input: z.unknown().nullable(),
      output: z.unknown().nullable(),
      cwd: z.string().nullable().optional(),
    })
    .transform((value) => parseEditDetail(value.input, value.output, value.cwd ?? null)),
  z
    .object({
      name: z.enum(["search", "web_search"]),
      input: z.unknown().nullable(),
      output: z.unknown().nullable(),
      cwd: z.string().nullable().optional(),
    })
    .transform((value) => parseSearchDetail(value.input)),
  z
    .object({
      name: z.literal("speak"),
      input: z.unknown().nullable(),
      output: z.unknown().nullable(),
      cwd: z.string().nullable().optional(),
    })
    .transform((value) => parseSpeakDetail(value.input)),
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
