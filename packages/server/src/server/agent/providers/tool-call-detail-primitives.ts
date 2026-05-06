import { z } from "zod";

import type { ToolCallDetail } from "../agent-sdk-types.js";
import {
  extractCodexShellOutput,
  flattenReadContent as flattenToolReadContent,
  nonEmptyString,
  truncateDiffText,
} from "./tool-call-mapper-utils.js";

export const CommandValueSchema = z.union([z.string(), z.array(z.string())]);

export const ToolShellInputSchema = z
  .union([
    z
      .object({
        command: CommandValueSchema,
        cwd: z.string().optional(),
        directory: z.string().optional(),
      })
      .passthrough(),
    z
      .object({
        cmd: CommandValueSchema,
        cwd: z.string().optional(),
        directory: z.string().optional(),
      })
      .passthrough(),
  ])
  .transform((value) => {
    const parsedCommand = CommandValueSchema.safeParse(
      "command" in value ? value.command : value.cmd,
    );
    let command: string | undefined;
    if (parsedCommand.success) {
      if (typeof parsedCommand.data === "string") {
        command = nonEmptyString(parsedCommand.data);
      } else {
        command =
          parsedCommand.data
            .map((token) => token.trim())
            .filter((token) => token.length > 0)
            .join(" ") || undefined;
      }
    }
    return {
      command,
      cwd: nonEmptyString(value.cwd) ?? nonEmptyString(value.directory),
    };
  });

const ToolShellOutputObjectSchema = z
  .object({
    command: z.string().optional(),
    output: z.string().optional(),
    text: z.string().optional(),
    content: z.string().optional(),
    aggregated_output: z.string().optional(),
    aggregatedOutput: z.string().optional(),
    exitCode: z.number().finite().nullable().optional(),
    exit_code: z.number().finite().nullable().optional(),
    metadata: z
      .object({
        exitCode: z.number().finite().nullable().optional(),
        exit_code: z.number().finite().nullable().optional(),
      })
      .passthrough()
      .optional(),
    structuredContent: z
      .object({
        output: z.string().optional(),
        text: z.string().optional(),
        content: z.string().optional(),
      })
      .passthrough()
      .optional(),
    structured_content: z
      .object({
        output: z.string().optional(),
        text: z.string().optional(),
        content: z.string().optional(),
      })
      .passthrough()
      .optional(),
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

function firstNonEmptyString(values: Array<unknown>): string | undefined {
  for (const value of values) {
    const resolved = nonEmptyString(value);
    if (resolved) {
      return resolved;
    }
  }
  return undefined;
}

function resolveShellOutputRawText(
  value: z.infer<typeof ToolShellOutputObjectSchema>,
): string | undefined {
  return firstNonEmptyString([
    value.output,
    value.text,
    value.content,
    value.aggregated_output,
    value.aggregatedOutput,
    value.structuredContent?.output,
    value.structuredContent?.text,
    value.structuredContent?.content,
    value.structured_content?.output,
    value.structured_content?.text,
    value.structured_content?.content,
    value.result?.output,
    value.result?.text,
    value.result?.content,
  ]);
}

function resolveShellOutputExitCode(
  value: z.infer<typeof ToolShellOutputObjectSchema>,
): number | null | undefined {
  return (
    value.exitCode ??
    value.exit_code ??
    value.metadata?.exitCode ??
    value.metadata?.exit_code ??
    undefined
  );
}

function transformShellOutputObject(value: z.infer<typeof ToolShellOutputObjectSchema>) {
  return {
    command: nonEmptyString(value.command) ?? nonEmptyString(value.result?.command),
    output: extractCodexShellOutput(resolveShellOutputRawText(value)),
    exitCode: resolveShellOutputExitCode(value),
  };
}

export const ToolShellOutputSchema = z.union([
  z.string().transform((value) => ({
    command: undefined,
    output: extractCodexShellOutput(value),
    exitCode: undefined,
  })),
  ToolShellOutputObjectSchema.transform((value) => transformShellOutputObject(value)),
]);

export const ToolPathInputSchema = z.union([
  z
    .object({ path: z.string() })
    .passthrough()
    .transform((value) => ({ filePath: value.path })),
  z
    .object({ file_path: z.string() })
    .passthrough()
    .transform((value) => ({ filePath: value.file_path })),
  z
    .object({ filePath: z.string() })
    .passthrough()
    .transform((value) => ({ filePath: value.filePath })),
]);

export const ToolReadInputSchema = z.union([
  z
    .object({
      path: z.string(),
      offset: z.number().finite().optional(),
      limit: z.number().finite().optional(),
    })
    .passthrough()
    .transform((value) => ({ filePath: value.path, offset: value.offset, limit: value.limit })),
  z
    .object({
      file_path: z.string(),
      offset: z.number().finite().optional(),
      limit: z.number().finite().optional(),
    })
    .passthrough()
    .transform((value) => ({
      filePath: value.file_path,
      offset: value.offset,
      limit: value.limit,
    })),
  z
    .object({
      filePath: z.string(),
      offset: z.number().finite().optional(),
      limit: z.number().finite().optional(),
    })
    .passthrough()
    .transform((value) => ({ filePath: value.filePath, offset: value.offset, limit: value.limit })),
]);

const ToolReadChunkSchema = z.union([
  z
    .object({
      text: z.string(),
      content: z.string().optional(),
      output: z.string().optional(),
    })
    .passthrough(),
  z
    .object({
      text: z.string().optional(),
      content: z.string(),
      output: z.string().optional(),
    })
    .passthrough(),
  z
    .object({
      text: z.string().optional(),
      content: z.string().optional(),
      output: z.string(),
    })
    .passthrough(),
]);

const ToolReadContentSchema = z.union([
  z.string(),
  ToolReadChunkSchema,
  z.array(ToolReadChunkSchema),
]);

const ToolReadPayloadSchema = z.union([
  z
    .object({
      content: ToolReadContentSchema,
      text: ToolReadContentSchema.optional(),
      output: ToolReadContentSchema.optional(),
    })
    .passthrough(),
  z
    .object({
      content: ToolReadContentSchema.optional(),
      text: ToolReadContentSchema,
      output: ToolReadContentSchema.optional(),
    })
    .passthrough(),
  z
    .object({
      content: ToolReadContentSchema.optional(),
      text: ToolReadContentSchema.optional(),
      output: ToolReadContentSchema,
    })
    .passthrough(),
]);

function flattenReadContent(
  value: z.infer<typeof ToolReadContentSchema> | undefined,
): string | undefined {
  return flattenToolReadContent(value);
}

const ToolReadOutputContentSchema = z.union([
  z.string().transform((value) => ({ filePath: undefined, content: nonEmptyString(value) })),
  ToolReadChunkSchema.transform((value) => ({
    filePath: undefined,
    content: flattenReadContent(value),
  })),
  z.array(ToolReadChunkSchema).transform((value) => ({
    filePath: undefined,
    content: flattenReadContent(value),
  })),
  ToolReadPayloadSchema.transform((value) => ({
    filePath: undefined,
    content:
      flattenReadContent(value.content) ??
      flattenReadContent(value.text) ??
      flattenReadContent(value.output),
  })),
  z
    .object({ data: ToolReadPayloadSchema })
    .passthrough()
    .transform((value) => ({
      filePath: undefined,
      content:
        flattenReadContent(value.data.content) ??
        flattenReadContent(value.data.text) ??
        flattenReadContent(value.data.output),
    })),
  z
    .object({ structuredContent: ToolReadPayloadSchema })
    .passthrough()
    .transform((value) => ({
      filePath: undefined,
      content:
        flattenReadContent(value.structuredContent.content) ??
        flattenReadContent(value.structuredContent.text) ??
        flattenReadContent(value.structuredContent.output),
    })),
  z
    .object({ structured_content: ToolReadPayloadSchema })
    .passthrough()
    .transform((value) => ({
      filePath: undefined,
      content:
        flattenReadContent(value.structured_content.content) ??
        flattenReadContent(value.structured_content.text) ??
        flattenReadContent(value.structured_content.output),
    })),
]);

const ToolReadOutputPathSchema = z.union([
  z
    .object({
      path: z.string(),
      content: ToolReadContentSchema.optional(),
      text: ToolReadContentSchema.optional(),
      output: ToolReadContentSchema.optional(),
    })
    .passthrough()
    .transform((value) => ({
      filePath: value.path,
      content:
        flattenReadContent(value.content) ??
        flattenReadContent(value.text) ??
        flattenReadContent(value.output),
    })),
  z
    .object({
      file_path: z.string(),
      content: ToolReadContentSchema.optional(),
      text: ToolReadContentSchema.optional(),
      output: ToolReadContentSchema.optional(),
    })
    .passthrough()
    .transform((value) => ({
      filePath: value.file_path,
      content:
        flattenReadContent(value.content) ??
        flattenReadContent(value.text) ??
        flattenReadContent(value.output),
    })),
  z
    .object({
      filePath: z.string(),
      content: ToolReadContentSchema.optional(),
      text: ToolReadContentSchema.optional(),
      output: ToolReadContentSchema.optional(),
    })
    .passthrough()
    .transform((value) => ({
      filePath: value.filePath,
      content:
        flattenReadContent(value.content) ??
        flattenReadContent(value.text) ??
        flattenReadContent(value.output),
    })),
]);

interface ToolReadOutputValue {
  filePath?: string;
  content?: string;
}

export const ToolReadOutputSchema: z.ZodType<ToolReadOutputValue, z.ZodTypeDef, unknown> =
  ToolReadOutputContentSchema;

export const ToolReadOutputWithPathSchema: z.ZodType<ToolReadOutputValue, z.ZodTypeDef, unknown> =
  z.union([ToolReadOutputContentSchema, ToolReadOutputPathSchema]);

export const ToolWriteContentSchema = z
  .object({
    content: z.string().optional(),
    new_content: z.string().optional(),
    newContent: z.string().optional(),
  })
  .passthrough();

export const ToolWriteInputSchema = z
  .intersection(ToolPathInputSchema, ToolWriteContentSchema)
  .transform((value) => ({
    filePath: value.filePath,
    content:
      nonEmptyString(value.content) ??
      nonEmptyString(value.new_content) ??
      nonEmptyString(value.newContent),
  }));

export const ToolWriteOutputSchema = z.union([
  z.intersection(ToolPathInputSchema, ToolWriteContentSchema).transform((value) => ({
    filePath: value.filePath,
    content:
      nonEmptyString(value.content) ??
      nonEmptyString(value.new_content) ??
      nonEmptyString(value.newContent),
  })),
  ToolWriteContentSchema.transform((value) => ({
    filePath: undefined,
    content:
      nonEmptyString(value.content) ??
      nonEmptyString(value.new_content) ??
      nonEmptyString(value.newContent),
  })),
]);

export const ToolEditTextSchema = z
  .object({
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
  })
  .passthrough();

export const ToolEditInputSchema = z
  .intersection(ToolPathInputSchema, ToolEditTextSchema)
  .transform((value) => ({
    filePath: value.filePath,
    oldString:
      nonEmptyString(value.old_string) ??
      nonEmptyString(value.old_str) ??
      nonEmptyString(value.oldContent) ??
      nonEmptyString(value.old_content),
    newString:
      nonEmptyString(value.new_string) ??
      nonEmptyString(value.new_str) ??
      nonEmptyString(value.newContent) ??
      nonEmptyString(value.new_content) ??
      nonEmptyString(value.content),
    unifiedDiff: truncateDiffText(
      nonEmptyString(value.patch) ??
        nonEmptyString(value.diff) ??
        nonEmptyString(value.unified_diff) ??
        nonEmptyString(value.unifiedDiff),
    ),
  }));

const ToolEditOutputFileSchema = z.union([
  z
    .object({
      path: z.string(),
      patch: z.string().optional(),
      diff: z.string().optional(),
      unified_diff: z.string().optional(),
      unifiedDiff: z.string().optional(),
    })
    .passthrough()
    .transform((value) => ({
      filePath: value.path,
      unifiedDiff: truncateDiffText(
        nonEmptyString(value.patch) ??
          nonEmptyString(value.diff) ??
          nonEmptyString(value.unified_diff) ??
          nonEmptyString(value.unifiedDiff),
      ),
    })),
  z
    .object({
      file_path: z.string(),
      patch: z.string().optional(),
      diff: z.string().optional(),
      unified_diff: z.string().optional(),
      unifiedDiff: z.string().optional(),
    })
    .passthrough()
    .transform((value) => ({
      filePath: value.file_path,
      unifiedDiff: truncateDiffText(
        nonEmptyString(value.patch) ??
          nonEmptyString(value.diff) ??
          nonEmptyString(value.unified_diff) ??
          nonEmptyString(value.unifiedDiff),
      ),
    })),
  z
    .object({
      filePath: z.string(),
      patch: z.string().optional(),
      diff: z.string().optional(),
      unified_diff: z.string().optional(),
      unifiedDiff: z.string().optional(),
    })
    .passthrough()
    .transform((value) => ({
      filePath: value.filePath,
      unifiedDiff: truncateDiffText(
        nonEmptyString(value.patch) ??
          nonEmptyString(value.diff) ??
          nonEmptyString(value.unified_diff) ??
          nonEmptyString(value.unifiedDiff),
      ),
    })),
]);

export const ToolEditOutputSchema = z.union([
  z.intersection(ToolPathInputSchema, ToolEditTextSchema).transform((value) => ({
    filePath: value.filePath,
    newString:
      nonEmptyString(value.newContent) ??
      nonEmptyString(value.new_content) ??
      nonEmptyString(value.content),
    unifiedDiff: truncateDiffText(
      nonEmptyString(value.patch) ??
        nonEmptyString(value.diff) ??
        nonEmptyString(value.unified_diff) ??
        nonEmptyString(value.unifiedDiff),
    ),
  })),
  z
    .object({ files: z.array(ToolEditOutputFileSchema).min(1) })
    .passthrough()
    .transform((value) => ({
      filePath: value.files[0]?.filePath,
      unifiedDiff: value.files[0]?.unifiedDiff,
      newString: undefined,
    })),
  ToolEditTextSchema.transform((value) => ({
    filePath: undefined,
    newString:
      nonEmptyString(value.newContent) ??
      nonEmptyString(value.new_content) ??
      nonEmptyString(value.content),
    unifiedDiff: truncateDiffText(
      nonEmptyString(value.patch) ??
        nonEmptyString(value.diff) ??
        nonEmptyString(value.unified_diff) ??
        nonEmptyString(value.unifiedDiff),
    ),
  })),
]);

export const ToolSearchInputSchema = z.union([
  z
    .object({ query: z.string() })
    .passthrough()
    .transform((value) => ({ query: value.query })),
  z
    .object({ q: z.string() })
    .passthrough()
    .transform((value) => ({ query: value.q })),
  z
    .object({ pattern: z.string() })
    .passthrough()
    .transform((value) => ({ query: value.pattern })),
]);

export const ToolGlobOutputSchema = z
  .object({
    durationMs: z.number().finite(),
    numFiles: z.number().int().nonnegative(),
    filenames: z.array(z.string()),
    truncated: z.boolean(),
  })
  .passthrough();

export const ToolGrepOutputSchema = z
  .object({
    mode: z.enum(["content", "files_with_matches", "count"]).optional(),
    numFiles: z.number().int().nonnegative(),
    filenames: z.array(z.string()),
    content: z.string().optional(),
    numLines: z.number().int().nonnegative().optional(),
    numMatches: z.number().int().nonnegative().optional(),
    appliedLimit: z.number().int().nonnegative().optional(),
    appliedOffset: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export const ToolWebFetchInputSchema = z
  .object({
    url: z.string(),
    prompt: z.string(),
  })
  .passthrough();

export const ToolWebFetchOutputSchema = z
  .object({
    bytes: z.number().int().nonnegative(),
    code: z.number().int(),
    codeText: z.string(),
    result: z.string(),
    durationMs: z.number().finite(),
    url: z.string(),
  })
  .passthrough();

const ToolWebSearchResultHitSchema = z
  .object({
    title: z.string(),
    url: z.string(),
  })
  .passthrough();

const ToolWebSearchResultEntrySchema = z.union([
  z
    .object({
      tool_use_id: z.string(),
      content: z.array(ToolWebSearchResultHitSchema),
    })
    .passthrough(),
  z.string(),
]);

export const ToolWebSearchOutputSchema = z
  .object({
    query: z.string(),
    results: z.array(ToolWebSearchResultEntrySchema),
    durationSeconds: z.number().finite(),
  })
  .passthrough();

export type ParsedToolShellInput = z.infer<typeof ToolShellInputSchema>;
export type ParsedToolShellOutput = z.infer<typeof ToolShellOutputSchema>;
export type ParsedToolReadInput = z.infer<typeof ToolReadInputSchema>;
export type ParsedToolReadOutput = ToolReadOutputValue;
export type ParsedToolReadOutputWithPath = ToolReadOutputValue;
export type ParsedToolWriteInput = z.infer<typeof ToolWriteInputSchema>;
export type ParsedToolWriteOutput = z.infer<typeof ToolWriteOutputSchema>;
export type ParsedToolEditInput = z.infer<typeof ToolEditInputSchema>;
export type ParsedToolEditOutput = z.infer<typeof ToolEditOutputSchema>;
export type ParsedToolSearchInput = z.infer<typeof ToolSearchInputSchema>;
export type ParsedToolGlobOutput = z.infer<typeof ToolGlobOutputSchema>;
export type ParsedToolGrepOutput = z.infer<typeof ToolGrepOutputSchema>;
export type ParsedToolWebFetchInput = z.infer<typeof ToolWebFetchInputSchema>;
export type ParsedToolWebFetchOutput = z.infer<typeof ToolWebFetchOutputSchema>;
export type ParsedToolWebSearchOutput = z.infer<typeof ToolWebSearchOutputSchema>;

type NormalizePathFn = (filePath: string) => string | undefined;

function normalizeDetailPath(
  filePath: string | undefined,
  normalizePath?: NormalizePathFn,
): string | undefined {
  if (typeof filePath !== "string") {
    return undefined;
  }
  const trimmed = filePath.trim();
  if (!trimmed) {
    return undefined;
  }
  return normalizePath ? normalizePath(trimmed) : trimmed;
}

function isParsedToolGlobOutput(
  output:
    | ParsedToolGrepOutput
    | ParsedToolGlobOutput
    | ParsedToolWebSearchOutput
    | null
    | undefined,
): output is ParsedToolGlobOutput {
  return Boolean(output && "truncated" in output);
}

function isParsedToolGrepOutput(
  output:
    | ParsedToolGrepOutput
    | ParsedToolGlobOutput
    | ParsedToolWebSearchOutput
    | null
    | undefined,
): output is ParsedToolGrepOutput {
  return Boolean(output && "filenames" in output && !("truncated" in output));
}

function isParsedToolWebSearchOutput(
  output:
    | ParsedToolGrepOutput
    | ParsedToolGlobOutput
    | ParsedToolWebSearchOutput
    | null
    | undefined,
): output is ParsedToolWebSearchOutput {
  return Boolean(output && "results" in output);
}

export function toShellToolDetail(
  input: ParsedToolShellInput | null,
  output: ParsedToolShellOutput | null,
): ToolCallDetail | undefined {
  const command = input?.command ?? output?.command;
  if (!command) {
    return undefined;
  }

  return {
    type: "shell",
    command,
    ...(input?.cwd ? { cwd: input.cwd } : {}),
    ...(output?.output ? { output: output.output } : {}),
    ...(output?.exitCode !== undefined ? { exitCode: output.exitCode } : {}),
  };
}

export function toReadToolDetail(
  input: ParsedToolReadInput | null,
  output: ParsedToolReadOutput | null,
  options?: { normalizePath?: NormalizePathFn },
): ToolCallDetail | undefined {
  const filePath = normalizeDetailPath(input?.filePath ?? output?.filePath, options?.normalizePath);
  if (!filePath) {
    return undefined;
  }

  return {
    type: "read",
    filePath,
    ...(output?.content ? { content: output.content } : {}),
    ...(input?.offset !== undefined ? { offset: input.offset } : {}),
    ...(input?.limit !== undefined ? { limit: input.limit } : {}),
  };
}

export function toWriteToolDetail(
  input: ParsedToolWriteInput | null,
  output: ParsedToolWriteOutput | null,
  options?: { normalizePath?: NormalizePathFn },
): ToolCallDetail | undefined {
  const filePath = normalizeDetailPath(input?.filePath ?? output?.filePath, options?.normalizePath);
  if (!filePath) {
    return undefined;
  }

  const content = input?.content ?? output?.content;
  return {
    type: "write",
    filePath,
    ...(content ? { content } : {}),
  };
}

export function toEditToolDetail(
  input: ParsedToolEditInput | null,
  output: ParsedToolEditOutput | null,
  options?: { normalizePath?: NormalizePathFn },
): ToolCallDetail | undefined {
  const filePath = normalizeDetailPath(input?.filePath ?? output?.filePath, options?.normalizePath);
  if (!filePath) {
    return undefined;
  }

  const newString = input?.newString ?? output?.newString;
  const unifiedDiff = input?.unifiedDiff ?? output?.unifiedDiff;
  return {
    type: "edit",
    filePath,
    ...(input?.oldString ? { oldString: input.oldString } : {}),
    ...(newString ? { newString } : {}),
    ...(unifiedDiff ? { unifiedDiff } : {}),
  };
}

function buildWebSearchExtraFields(output: ParsedToolWebSearchOutput): Record<string, unknown> {
  const webResults = output.results.flatMap((entry) =>
    typeof entry === "string" ? [] : entry.content,
  );
  const annotations = output.results.filter((entry): entry is string => typeof entry === "string");
  return {
    ...(webResults.length > 0 ? { webResults } : {}),
    ...(annotations.length > 0 ? { annotations } : {}),
    durationSeconds: output.durationSeconds,
  };
}

function buildGrepExtraFields(output: ParsedToolGrepOutput): Record<string, unknown> {
  const filePaths = output.filenames.length > 0 ? output.filenames : undefined;
  return {
    ...(output.content ? { content: output.content } : {}),
    ...(filePaths ? { filePaths } : {}),
    numFiles: output.numFiles,
    ...(output.numMatches !== undefined ? { numMatches: output.numMatches } : {}),
    ...(output.mode ? { mode: output.mode } : {}),
  };
}

function buildGlobExtraFields(output: ParsedToolGlobOutput): Record<string, unknown> {
  const filePaths = output.filenames.length > 0 ? output.filenames : undefined;
  return {
    ...(filePaths ? { filePaths } : {}),
    numFiles: output.numFiles,
    durationMs: output.durationMs,
    truncated: output.truncated,
  };
}

function buildSearchToolDetailOutputFields(
  output?: ParsedToolGrepOutput | ParsedToolGlobOutput | ParsedToolWebSearchOutput | null,
): Record<string, unknown> {
  if (isParsedToolGrepOutput(output)) {
    return buildGrepExtraFields(output);
  }
  if (isParsedToolGlobOutput(output)) {
    return buildGlobExtraFields(output);
  }
  if (isParsedToolWebSearchOutput(output)) {
    return buildWebSearchExtraFields(output);
  }
  return {};
}

export function toSearchToolDetail(params: {
  input: ParsedToolSearchInput | null;
  output?: ParsedToolGrepOutput | ParsedToolGlobOutput | ParsedToolWebSearchOutput | null;
  toolName?: "search" | "grep" | "glob" | "web_search";
}): ToolCallDetail | undefined {
  const { input, output, toolName } = params;
  if (!input?.query) {
    return undefined;
  }

  return {
    type: "search",
    query: input.query,
    ...(toolName ? { toolName } : {}),
    ...buildSearchToolDetailOutputFields(output),
  };
}

export function toFetchToolDetail(
  input: ParsedToolWebFetchInput | null,
  output: ParsedToolWebFetchOutput | null,
): ToolCallDetail | undefined {
  const url = input?.url ?? output?.url;
  if (!url) {
    return undefined;
  }

  return {
    type: "fetch",
    url,
    ...(input?.prompt ? { prompt: input.prompt } : {}),
    ...(output?.result ? { result: output.result } : {}),
    ...(output?.code !== undefined ? { code: output.code } : {}),
    ...(output?.codeText ? { codeText: output.codeText } : {}),
    ...(output?.bytes !== undefined ? { bytes: output.bytes } : {}),
    ...(output?.durationMs !== undefined ? { durationMs: output.durationMs } : {}),
  };
}

export function toolDetailBranchByName<
  Name extends string,
  InputSchema extends z.ZodTypeAny,
  OutputSchema extends z.ZodTypeAny,
>(
  name: Name,
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  mapper: (
    input: z.infer<InputSchema> | null,
    output: z.infer<OutputSchema> | null,
  ) => ToolCallDetail | undefined,
) {
  const schema = z.object({
    name: z.literal(name),
    input: inputSchema.nullable(),
    output: outputSchema.nullable(),
  });
  return schema.transform((value: z.infer<typeof schema>) => {
    return mapper(value.input, value.output);
  });
}

export function toolDetailBranchByToolName<
  Name extends string,
  InputSchema extends z.ZodTypeAny,
  OutputSchema extends z.ZodTypeAny,
>(
  toolName: Name,
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  mapper: (
    input: z.infer<InputSchema> | null,
    output: z.infer<OutputSchema> | null,
  ) => ToolCallDetail | undefined,
) {
  const schema = z.object({
    toolName: z.literal(toolName),
    input: inputSchema.nullable(),
    output: outputSchema.nullable(),
  });
  return schema.transform((value: z.infer<typeof schema>) => {
    return mapper(value.input, value.output);
  });
}

export function toolDetailBranchByNameWithCwd<
  Name extends string,
  InputSchema extends z.ZodTypeAny,
  OutputSchema extends z.ZodTypeAny,
>(
  name: Name,
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  mapper: (
    input: z.infer<InputSchema> | null,
    output: z.infer<OutputSchema> | null,
    cwd: string | null,
  ) => ToolCallDetail | undefined,
) {
  const schema = z.object({
    name: z.literal(name),
    input: inputSchema.nullable(),
    output: outputSchema.nullable(),
    cwd: z.string().optional().nullable(),
  });
  return schema.transform((value: z.infer<typeof schema>) => {
    return mapper(value.input, value.output, value.cwd ?? null);
  });
}
