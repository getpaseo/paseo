import { z } from "zod";

import type { ToolCallDetail } from "../../agent-sdk-types.js";
import {
  extractCodexShellOutput,
  flattenReadContent,
  nonEmptyString,
  truncateDiffText,
} from "../tool-call-mapper-utils.js";

const StringOrStringArraySchema = z.union([z.string(), z.array(z.string())]);

const ClaudeToolEnvelopeSchema = z
  .object({
    name: z.string().min(1),
    input: z.unknown().nullable(),
    output: z.unknown().nullable(),
  })
  .passthrough();

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

function parseShellDetail(input: unknown, output: unknown): ToolCallDetail | undefined {
  const parsedInput = z
    .object({
      command: StringOrStringArraySchema.optional(),
      cmd: StringOrStringArraySchema.optional(),
      cwd: z.string().optional(),
      directory: z.string().optional(),
    })
    .passthrough()
    .safeParse(input ?? {});

  const command = commandFromValue(
    parsedInput.success ? (parsedInput.data.command ?? parsedInput.data.cmd) : undefined
  );
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
          aggregatedOutput: z.string().optional(),
          aggregated_output: z.string().optional(),
          exitCode: z.number().nullable().optional(),
          exit_code: z.number().nullable().optional(),
        })
        .passthrough()
        .transform((value) => ({
          output:
            nonEmptyString(value.output) ??
            nonEmptyString(value.text) ??
            nonEmptyString(value.content) ??
            nonEmptyString(value.aggregatedOutput) ??
            nonEmptyString(value.aggregated_output),
          exitCode: value.exitCode ?? value.exit_code,
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
          ...(nonEmptyString(parsedInput.data.directory) && !nonEmptyString(parsedInput.data.cwd)
            ? { cwd: parsedInput.data.directory }
            : {}),
        }
      : {}),
    ...(shellOutput ? { output: shellOutput } : {}),
    ...(parsedOutput.success && parsedOutput.data.exitCode !== undefined
      ? { exitCode: parsedOutput.data.exitCode }
      : {}),
  };
}

function parseReadDetail(input: unknown, output: unknown): ToolCallDetail | undefined {
  const parsedInput = z
    .object({
      file_path: z.string(),
      offset: z.number().finite().optional(),
      limit: z.number().finite().optional(),
    })
    .passthrough()
    .safeParse(input ?? {});
  if (!parsedInput.success) {
    return undefined;
  }

  const content = extractReadOutputContent(output);
  return {
    type: "read",
    filePath: parsedInput.data.file_path,
    ...(content ? { content } : {}),
    ...(parsedInput.data.offset !== undefined ? { offset: parsedInput.data.offset } : {}),
    ...(parsedInput.data.limit !== undefined ? { limit: parsedInput.data.limit } : {}),
  };
}

function parseWriteDetail(input: unknown, output: unknown): ToolCallDetail | undefined {
  const parsedInput = z
    .object({
      file_path: z.string(),
      content: z.string().optional(),
      new_content: z.string().optional(),
      newContent: z.string().optional(),
    })
    .passthrough()
    .safeParse(input ?? {});
  if (!parsedInput.success) {
    return undefined;
  }

  const outputContent = z
    .object({
      content: z.string().optional(),
      new_content: z.string().optional(),
      newContent: z.string().optional(),
    })
    .passthrough()
    .safeParse(output ?? {});

  const content =
    nonEmptyString(parsedInput.data.content) ??
    nonEmptyString(parsedInput.data.new_content) ??
    nonEmptyString(parsedInput.data.newContent) ??
    (outputContent.success
      ? nonEmptyString(outputContent.data.content) ??
        nonEmptyString(outputContent.data.new_content) ??
        nonEmptyString(outputContent.data.newContent)
      : undefined);

  return {
    type: "write",
    filePath: parsedInput.data.file_path,
    ...(content ? { content } : {}),
  };
}

function parseEditDetail(input: unknown, output: unknown): ToolCallDetail | undefined {
  const parsedInput = z
    .object({
      file_path: z.string(),
      old_string: z.string().optional(),
      old_str: z.string().optional(),
      old_content: z.string().optional(),
      oldContent: z.string().optional(),
      new_string: z.string().optional(),
      new_str: z.string().optional(),
      new_content: z.string().optional(),
      newContent: z.string().optional(),
      content: z.string().optional(),
      patch: z.string().optional(),
      diff: z.string().optional(),
      unified_diff: z.string().optional(),
      unifiedDiff: z.string().optional(),
    })
    .passthrough()
    .safeParse(input ?? {});

  if (!parsedInput.success) {
    return undefined;
  }

  const parsedOutput = z
    .object({
      patch: z.string().optional(),
      diff: z.string().optional(),
      unified_diff: z.string().optional(),
      unifiedDiff: z.string().optional(),
      content: z.string().optional(),
      new_content: z.string().optional(),
      newContent: z.string().optional(),
    })
    .passthrough()
    .safeParse(output ?? {});

  const oldString =
    nonEmptyString(parsedInput.data.old_string) ??
    nonEmptyString(parsedInput.data.old_str) ??
    nonEmptyString(parsedInput.data.old_content) ??
    nonEmptyString(parsedInput.data.oldContent);
  const newString =
    nonEmptyString(parsedInput.data.new_string) ??
    nonEmptyString(parsedInput.data.new_str) ??
    nonEmptyString(parsedInput.data.new_content) ??
    nonEmptyString(parsedInput.data.newContent) ??
    nonEmptyString(parsedInput.data.content) ??
    (parsedOutput.success
      ? nonEmptyString(parsedOutput.data.new_content) ??
        nonEmptyString(parsedOutput.data.newContent) ??
        nonEmptyString(parsedOutput.data.content)
      : undefined);
  const unifiedDiff = truncateDiffText(
    nonEmptyString(parsedInput.data.patch) ??
      nonEmptyString(parsedInput.data.diff) ??
      nonEmptyString(parsedInput.data.unified_diff) ??
      nonEmptyString(parsedInput.data.unifiedDiff) ??
      (parsedOutput.success
        ? nonEmptyString(parsedOutput.data.patch) ??
          nonEmptyString(parsedOutput.data.diff) ??
          nonEmptyString(parsedOutput.data.unified_diff) ??
          nonEmptyString(parsedOutput.data.unifiedDiff)
        : undefined)
  );

  return {
    type: "edit",
    filePath: parsedInput.data.file_path,
    ...(oldString ? { oldString } : {}),
    ...(newString ? { newString } : {}),
    ...(unifiedDiff ? { unifiedDiff } : {}),
  };
}

function parseSearchDetail(input: unknown): ToolCallDetail | undefined {
  const parsed = z
    .union([
      z.object({ query: z.string() }).passthrough(),
      z.object({ q: z.string() }).passthrough(),
    ])
    .safeParse(input ?? {});
  if (!parsed.success) {
    return undefined;
  }

  const query =
    nonEmptyString((parsed.data as { query?: unknown }).query) ??
    nonEmptyString((parsed.data as { q?: unknown }).q);
  return query ? { type: "search", query } : undefined;
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

const ClaudeToolDetailPass2Schema = z.union([
  z
    .object({
      name: z.enum(["Bash", "bash", "shell", "exec_command"]),
      input: z.unknown().nullable(),
      output: z.unknown().nullable(),
    })
    .transform((value) => parseShellDetail(value.input, value.output)),
  z
    .object({
      name: z.enum(["Read", "read", "read_file", "view_file"]),
      input: z.unknown().nullable(),
      output: z.unknown().nullable(),
    })
    .transform((value) => parseReadDetail(value.input, value.output)),
  z
    .object({
      name: z.enum(["Write", "write", "write_file", "create_file"]),
      input: z.unknown().nullable(),
      output: z.unknown().nullable(),
    })
    .transform((value) => parseWriteDetail(value.input, value.output)),
  z
    .object({
      name: z.enum([
        "Edit",
        "MultiEdit",
        "multi_edit",
        "edit",
        "apply_patch",
        "apply_diff",
        "str_replace_editor",
      ]),
      input: z.unknown().nullable(),
      output: z.unknown().nullable(),
    })
    .transform((value) => parseEditDetail(value.input, value.output)),
  z
    .object({
      name: z.enum(["WebSearch", "web_search", "search"]),
      input: z.unknown().nullable(),
      output: z.unknown().nullable(),
    })
    .transform((value) => parseSearchDetail(value.input)),
  z
    .object({
      name: z.literal("speak"),
      input: z.unknown().nullable(),
      output: z.unknown().nullable(),
    })
    .transform((value) => parseSpeakDetail(value.input)),
]);

export function deriveClaudeToolDetail(
  name: string,
  input: unknown,
  output: unknown
): ToolCallDetail {
  const pass1 = ClaudeToolEnvelopeSchema.safeParse({
    name,
    input: input ?? null,
    output: output ?? null,
  });
  if (!pass1.success) {
    return {
      type: "unknown",
      input: input ?? null,
      output: output ?? null,
    };
  }

  const pass2 = ClaudeToolDetailPass2Schema.safeParse(pass1.data);
  if (pass2.success && pass2.data) {
    return pass2.data;
  }

  return {
    type: "unknown",
    input: pass1.data.input,
    output: pass1.data.output,
  };
}
