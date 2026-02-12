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
      "command" in value ? value.command : value.cmd
    );
    const command = parsedCommand.success
      ? typeof parsedCommand.data === "string"
        ? nonEmptyString(parsedCommand.data)
        : parsedCommand.data
            .map((token) => token.trim())
            .filter((token) => token.length > 0)
            .join(" ") || undefined
      : undefined;
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

export const ToolShellOutputSchema = z.union([
  z.string().transform((value) => ({
    command: undefined,
    output: extractCodexShellOutput(value),
    exitCode: undefined,
  })),
  ToolShellOutputObjectSchema.transform((value) => {
    const rawOutput =
      nonEmptyString(value.output) ??
      nonEmptyString(value.text) ??
      nonEmptyString(value.content) ??
      nonEmptyString(value.aggregated_output) ??
      nonEmptyString(value.aggregatedOutput) ??
      nonEmptyString(value.structuredContent?.output) ??
      nonEmptyString(value.structuredContent?.text) ??
      nonEmptyString(value.structuredContent?.content) ??
      nonEmptyString(value.structured_content?.output) ??
      nonEmptyString(value.structured_content?.text) ??
      nonEmptyString(value.structured_content?.content) ??
      nonEmptyString(value.result?.output) ??
      nonEmptyString(value.result?.text) ??
      nonEmptyString(value.result?.content);

    return {
      command: nonEmptyString(value.command) ?? nonEmptyString(value.result?.command),
      output: extractCodexShellOutput(rawOutput),
      exitCode:
        value.exitCode ??
        value.exit_code ??
        value.metadata?.exitCode ??
        value.metadata?.exit_code ??
        undefined,
    };
  }),
]);

export const ToolPathInputSchema = z.union([
  z.object({ path: z.string() }).passthrough().transform((value) => ({ filePath: value.path })),
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
    .transform((value) => ({ filePath: value.file_path, offset: value.offset, limit: value.limit })),
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

const ToolReadContentSchema = z.union([z.string(), ToolReadChunkSchema, z.array(ToolReadChunkSchema)]);

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
  value: z.infer<typeof ToolReadContentSchema> | undefined
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

type ToolReadOutputValue = {
  filePath?: string;
  content?: string;
};

export const ToolReadOutputSchema = ToolReadOutputContentSchema;

export const ToolReadOutputWithPathSchema = z.union([
  ToolReadOutputContentSchema,
  ToolReadOutputPathSchema,
]);

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
  z
    .intersection(ToolPathInputSchema, ToolWriteContentSchema)
    .transform((value) => ({
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
        nonEmptyString(value.unifiedDiff)
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
          nonEmptyString(value.unifiedDiff)
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
          nonEmptyString(value.unifiedDiff)
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
          nonEmptyString(value.unifiedDiff)
      ),
    })),
]);

export const ToolEditOutputSchema = z.union([
  z
    .intersection(ToolPathInputSchema, ToolEditTextSchema)
    .transform((value) => ({
      filePath: value.filePath,
      newString:
        nonEmptyString(value.newContent) ??
        nonEmptyString(value.new_content) ??
        nonEmptyString(value.content),
      unifiedDiff: truncateDiffText(
        nonEmptyString(value.patch) ??
          nonEmptyString(value.diff) ??
          nonEmptyString(value.unified_diff) ??
          nonEmptyString(value.unifiedDiff)
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
        nonEmptyString(value.unifiedDiff)
    ),
  })),
]);

export const ToolSearchInputSchema = z.union([
  z.object({ query: z.string() }).passthrough().transform((value) => ({ query: value.query })),
  z.object({ q: z.string() }).passthrough().transform((value) => ({ query: value.q })),
]);

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

type NormalizePathFn = (filePath: string) => string | undefined;

function normalizeDetailPath(
  filePath: string | undefined,
  normalizePath?: NormalizePathFn
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

export function toShellToolDetail(
  input: ParsedToolShellInput | null,
  output: ParsedToolShellOutput | null
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
  output: ParsedToolReadOutput | ParsedToolReadOutputWithPath | null,
  options?: { normalizePath?: NormalizePathFn }
): ToolCallDetail | undefined {
  const filePath = normalizeDetailPath(
    input?.filePath ?? output?.filePath,
    options?.normalizePath
  );
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
  options?: { normalizePath?: NormalizePathFn }
): ToolCallDetail | undefined {
  const filePath = normalizeDetailPath(
    input?.filePath ?? output?.filePath,
    options?.normalizePath
  );
  if (!filePath) {
    return undefined;
  }

  return {
    type: "write",
    filePath,
    ...(input?.content ? { content: input.content } : output?.content ? { content: output.content } : {}),
  };
}

export function toEditToolDetail(
  input: ParsedToolEditInput | null,
  output: ParsedToolEditOutput | null,
  options?: { normalizePath?: NormalizePathFn }
): ToolCallDetail | undefined {
  const filePath = normalizeDetailPath(
    input?.filePath ?? output?.filePath,
    options?.normalizePath
  );
  if (!filePath) {
    return undefined;
  }

  return {
    type: "edit",
    filePath,
    ...(input?.oldString ? { oldString: input.oldString } : {}),
    ...(input?.newString ? { newString: input.newString } : output?.newString ? { newString: output.newString } : {}),
    ...(input?.unifiedDiff
      ? { unifiedDiff: input.unifiedDiff }
      : output?.unifiedDiff
        ? { unifiedDiff: output.unifiedDiff }
        : {}),
  };
}

export function toSearchToolDetail(
  input: ParsedToolSearchInput | null
): ToolCallDetail | undefined {
  if (!input?.query) {
    return undefined;
  }
  return {
    type: "search",
    query: input.query,
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
    output: z.infer<OutputSchema> | null
  ) => ToolCallDetail | undefined
) {
  return z
    .object({
      name: z.literal(name),
      input: inputSchema.nullable(),
      output: outputSchema.nullable(),
    })
    .transform((value) => {
      const parsed = value as unknown as {
        input: z.infer<InputSchema> | null;
        output: z.infer<OutputSchema> | null;
      };
      return mapper(parsed.input, parsed.output);
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
    output: z.infer<OutputSchema> | null
  ) => ToolCallDetail | undefined
) {
  return z
    .object({
      toolName: z.literal(toolName),
      input: inputSchema.nullable(),
      output: outputSchema.nullable(),
    })
    .transform((value) => {
      const parsed = value as unknown as {
        input: z.infer<InputSchema> | null;
        output: z.infer<OutputSchema> | null;
      };
      return mapper(parsed.input, parsed.output);
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
    cwd: string | null
  ) => ToolCallDetail | undefined
) {
  return z
    .object({
      name: z.literal(name),
      input: inputSchema.nullable(),
      output: outputSchema.nullable(),
      cwd: z.string().optional().nullable(),
    })
    .transform((value) => {
      const parsed = value as unknown as {
        input: z.infer<InputSchema> | null;
        output: z.infer<OutputSchema> | null;
        cwd?: string | null;
      };
      return mapper(parsed.input, parsed.output, parsed.cwd ?? null);
    });
}
