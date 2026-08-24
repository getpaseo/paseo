import { z } from "zod";

import type { ToolCallDetail } from "../../agent-sdk-types.js";

interface BashToolInput {
  command: string;
  timeout?: number;
}

interface ReadToolInput {
  path: string;
  offset?: number;
  limit?: number;
}

interface EditToolInput {
  path: string;
  edits: Array<{
    oldText: string;
    newText: string;
  }>;
}

interface WriteToolInput {
  path: string;
  content: string;
}

interface FindToolInput {
  pattern: string;
  path?: string;
  limit?: number;
}

interface GrepToolInput {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
}

interface LsToolInput {
  path?: string;
  limit?: number;
}

interface OmpToolResultObject {
  output?: string;
  stdout?: string;
  text?: string;
  content?: OmpToolResultContent[];
  exitCode?: number;
  code?: number;
  details?: OmpToolResultDetails;
}

interface OmpToolResultDetails {
  diff?: string;
  mode?: string;
  xdev?: unknown;
}

interface OmpToolResultTextContent {
  type: "text";
  text: string;
}

interface OmpToolResultUnknownContent {
  type: string;
}

type OmpToolResultContent = OmpToolResultTextContent | OmpToolResultUnknownContent;
export type OmpToolResult = string | OmpToolResultObject | null;

interface OmpBashToolCall {
  kind: "bash";
  toolName: "bash";
  args: BashToolInput;
}

interface OmpReadToolCall {
  kind: "read";
  toolName: "read";
  args: ReadToolInput;
}

interface OmpEditToolCall {
  kind: "edit";
  toolName: "edit";
  args: EditToolInput;
}

interface OmpWriteToolCall {
  kind: "write";
  toolName: "write";
  args: WriteToolInput;
}

interface OmpFindToolCall {
  kind: "find";
  toolName: "find";
  args: FindToolInput;
}

interface OmpGrepToolCall {
  kind: "grep";
  toolName: "grep";
  args: GrepToolInput;
}

interface OmpLsToolCall {
  kind: "ls";
  toolName: "ls";
  args: LsToolInput;
}

interface OmpUnknownToolCall {
  kind: "unknown";
  toolName: string;
  args: unknown;
}

export type OmpTrackedToolCall =
  | OmpBashToolCall
  | OmpReadToolCall
  | OmpEditToolCall
  | OmpWriteToolCall
  | OmpFindToolCall
  | OmpGrepToolCall
  | OmpLsToolCall
  | OmpUnknownToolCall;

interface ToolCallOutputSummary {
  output?: string;
  exitCode?: number | null;
}

const OmpToolResultTextContentSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

const OmpToolResultUnknownContentSchema = z
  .object({
    type: z.string(),
  })
  .passthrough();

const OmpToolResultContentSchema = z.union([
  OmpToolResultTextContentSchema,
  OmpToolResultUnknownContentSchema,
]);

const OmpToolResultDetailsSchema = z
  .object({
    diff: z.string().optional(),
  })
  .passthrough();

const XdevExecuteDetailsSchema = z.object({
  tool: z.string().trim().min(1),
  mode: z.literal("execute"),
  args: z.unknown().optional(),
  inner: z.unknown().optional(),
});

const OmpToolResultObjectSchema = z
  .object({
    output: z.string().optional(),
    stdout: z.string().optional(),
    text: z.string().optional(),
    content: z.array(OmpToolResultContentSchema).optional(),
    exitCode: z.number().optional(),
    code: z.number().optional(),
    details: OmpToolResultDetailsSchema.optional(),
  })
  .passthrough();

const OmpToolResultSchema = z.union([z.string(), OmpToolResultObjectSchema, z.null()]);

const BashToolInputSchema: z.ZodType<BashToolInput> = z.object({
  command: z.string(),
  timeout: z.number().optional(),
});

const ReadToolInputSchema: z.ZodType<ReadToolInput> = z.object({
  path: z.string(),
  offset: z.number().optional(),
  limit: z.number().optional(),
});

const EditToolInputSchema: z.ZodType<EditToolInput> = z.object({
  path: z.string(),
  edits: z.array(
    z.object({
      oldText: z.string(),
      newText: z.string(),
    }),
  ),
});

const LegacyEditToolInputSchema = z.object({
  path: z.string(),
  old_string: z.string().optional(),
  oldString: z.string().optional(),
  new_string: z.string().optional(),
  newString: z.string().optional(),
});

const WriteToolInputSchema: z.ZodType<WriteToolInput> = z.object({
  path: z.string(),
  content: z.string(),
});

const FindToolInputSchema: z.ZodType<FindToolInput> = z.object({
  pattern: z.string(),
  path: z.string().optional(),
  limit: z.number().optional(),
});

const GrepToolInputSchema: z.ZodType<GrepToolInput> = z.object({
  pattern: z.string(),
  path: z.string().optional(),
  glob: z.string().optional(),
  ignoreCase: z.boolean().optional(),
  literal: z.boolean().optional(),
  context: z.number().optional(),
  limit: z.number().optional(),
});

const LsToolInputSchema: z.ZodType<LsToolInput> = z.object({
  path: z.string().optional(),
  limit: z.number().optional(),
});

export function parseToolResult(rawResult: unknown): OmpToolResult {
  const parsed = OmpToolResultSchema.safeParse(rawResult);
  if (parsed.success) {
    return parsed.data;
  }
  return null;
}

export function extractTextFromToolResult(result: OmpToolResult): string | undefined {
  if (typeof result === "string") {
    return result;
  }
  if (!result) {
    return undefined;
  }

  const directText = result.output ?? result.stdout ?? result.text;
  if (directText) {
    return directText;
  }
  if (!result.content) {
    return undefined;
  }

  const textParts: string[] = [];
  for (const block of result.content) {
    if (block.type === "text" && "text" in block) {
      textParts.push(block.text);
    }
  }

  return textParts.length > 0 ? textParts.join("\n") : undefined;
}

export function parseToolArgs(toolName: string, rawArgs: unknown): OmpTrackedToolCall {
  if (toolName === "edit") {
    return parseEditToolArgs(rawArgs);
  }
  const schema = SIMPLE_TOOL_SCHEMAS[toolName as SimpleToolKind];
  if (schema) {
    const parsed = schema.safeParse(rawArgs);
    if (parsed.success) {
      return {
        kind: toolName as SimpleToolKind,
        toolName,
        args: parsed.data,
      } as OmpTrackedToolCall;
    }
  }
  return { kind: "unknown", toolName, args: rawArgs ?? null };
}

export function resolveToolCallName(toolCall: OmpTrackedToolCall, result?: OmpToolResult): string {
  if (toolCall.kind === "write" && result && typeof result !== "string") {
    const xdev = XdevExecuteDetailsSchema.safeParse(result.details?.xdev);
    if (xdev.success) {
      return xdev.data.tool;
    }
  }

  return toolCall.toolName;
}

export function mapToolDetail(
  toolCall: OmpTrackedToolCall,
  result?: OmpToolResult,
): ToolCallDetail {
  const parsedResult = result ?? null;

  switch (toolCall.kind) {
    case "bash": {
      const summary = resolveToolCallOutput(parsedResult);
      return {
        type: "shell",
        command: toolCall.args.command,
        output: summary.output,
        exitCode: summary.exitCode,
      };
    }
    case "read":
      return {
        type: "read",
        filePath: toolCall.args.path,
        content: extractTextFromToolResult(parsedResult),
        offset: toolCall.args.offset,
        limit: toolCall.args.limit,
      };
    case "edit": {
      const firstEdit = toolCall.args.edits[0];
      const unifiedDiff =
        parsedResult && typeof parsedResult !== "string" ? parsedResult.details?.diff : undefined;

      return {
        type: "edit",
        filePath: toolCall.args.path,
        oldString: firstEdit?.oldText,
        newString: firstEdit?.newText,
        unifiedDiff,
      };
    }
    case "write":
      return mapWriteToolDetail(toolCall.args, parsedResult);
    case "find":
      return mapFindToolDetail(toolCall.args, parsedResult);
    case "grep":
      return mapGrepToolDetail(toolCall.args, parsedResult);
    case "ls":
      return mapLsToolDetail(toolCall.args, parsedResult);
    default:
      return {
        type: "unknown",
        input: toolCall.args,
        output: parsedResult,
      };
  }
}

function mapWriteToolDetail(args: WriteToolInput, result: OmpToolResult): ToolCallDetail {
  if (result && typeof result !== "string" && result.details && "xdev" in result.details) {
    const xdev = XdevExecuteDetailsSchema.safeParse(result.details.xdev);
    if (xdev.success) {
      return {
        type: "unknown",
        input: xdev.data.args ?? null,
        output: {
          ...result,
          details: xdev.data.inner ?? null,
        },
      };
    }

    return {
      type: "unknown",
      input: args,
      output: result,
    };
  }

  return {
    type: "write",
    filePath: args.path,
    content: args.content,
  };
}

function resolveToolCallOutput(result: OmpToolResult): ToolCallOutputSummary {
  if (typeof result === "string") {
    return { output: result };
  }
  if (!result) {
    return {};
  }

  const summary: ToolCallOutputSummary = {
    output: extractTextFromToolResult(result),
  };
  if (typeof result.exitCode === "number") {
    summary.exitCode = result.exitCode;
    return summary;
  }
  if (typeof result.code === "number") {
    summary.exitCode = result.code;
    return summary;
  }
  summary.exitCode = null;
  return summary;
}

function normalizeLegacyEditArgs(rawArgs: unknown): EditToolInput | null {
  const parsed = LegacyEditToolInputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return null;
  }

  const oldText = parsed.data.old_string ?? parsed.data.oldString;
  const newText = parsed.data.new_string ?? parsed.data.newString;
  if (!oldText || newText === undefined) {
    return null;
  }

  return {
    path: parsed.data.path,
    edits: [{ oldText, newText }],
  };
}

function parseEditToolArgs(rawArgs: unknown): OmpTrackedToolCall {
  const parsed = EditToolInputSchema.safeParse(rawArgs);
  if (parsed.success) {
    return { kind: "edit", toolName: "edit", args: parsed.data };
  }
  const legacyArgs = normalizeLegacyEditArgs(rawArgs);
  if (legacyArgs) {
    return { kind: "edit", toolName: "edit", args: legacyArgs };
  }
  return { kind: "unknown", toolName: "edit", args: rawArgs ?? null };
}

type SimpleToolKind = "bash" | "read" | "write" | "find" | "grep" | "ls";
const SIMPLE_TOOL_SCHEMAS: {
  [K in SimpleToolKind]: { safeParse: (data: unknown) => { success: boolean; data?: unknown } };
} = {
  bash: BashToolInputSchema,
  read: ReadToolInputSchema,
  write: WriteToolInputSchema,
  find: FindToolInputSchema,
  grep: GrepToolInputSchema,
  ls: LsToolInputSchema,
};

function mapFindToolDetail(args: FindToolInput, result: OmpToolResult): ToolCallDetail {
  return {
    type: "search",
    query: args.pattern,
    toolName: "search",
    content: typeof result === "string" ? result : undefined,
  };
}

function mapGrepToolDetail(args: GrepToolInput, result: OmpToolResult): ToolCallDetail {
  return {
    type: "search",
    query: args.pattern,
    toolName: "grep",
    content: typeof result === "string" ? result : undefined,
  };
}

function mapLsToolDetail(args: LsToolInput, result: OmpToolResult): ToolCallDetail {
  return {
    type: "search",
    query: args.path ?? "ls",
    content: typeof result === "string" ? result : undefined,
  };
}
