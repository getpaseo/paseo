import type {
  BashToolInput,
  EditToolInput,
  FindToolInput,
  GrepToolInput,
  LsToolInput,
  ReadToolInput,
  SessionStats,
  WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { z } from "zod";

import type { AgentPromptInput, AgentUsage, ToolCallDetail } from "../../agent-sdk-types.js";
import { renderPromptAttachmentAsText } from "../../prompt-attachments.js";

// Pure event/tool/model mapping ported from the old direct Pi provider. These
// translate Pi's harness shapes into Paseo's provider-agnostic timeline types.
// Kept free of any session/runtime state so they can be unit-tested directly.

export interface PiPromptPayload {
  text: string;
  images?: ImageContent[];
}

interface ToolCallOutputSummary {
  output?: string;
  exitCode?: number | null;
}

interface PiBashToolCall {
  kind: "bash";
  toolName: "bash";
  args: BashToolInput;
}
interface PiReadToolCall {
  kind: "read";
  toolName: "read";
  args: ReadToolInput;
}
interface PiEditToolCall {
  kind: "edit";
  toolName: "edit";
  args: EditToolInput;
}
interface PiWriteToolCall {
  kind: "write";
  toolName: "write";
  args: WriteToolInput;
}
interface PiFindToolCall {
  kind: "find";
  toolName: "find";
  args: FindToolInput;
}
interface PiGrepToolCall {
  kind: "grep";
  toolName: "grep";
  args: GrepToolInput;
}
interface PiLsToolCall {
  kind: "ls";
  toolName: "ls";
  args: LsToolInput;
}
interface PiUnknownToolCall {
  kind: "unknown";
  toolName: string;
  args: unknown;
}

export type PiTrackedToolCall =
  | PiBashToolCall
  | PiReadToolCall
  | PiEditToolCall
  | PiWriteToolCall
  | PiFindToolCall
  | PiGrepToolCall
  | PiLsToolCall
  | PiUnknownToolCall;

const PiToolResultTextContentSchema = z.object({ type: z.literal("text"), text: z.string() });
const PiToolResultUnknownContentSchema = z.object({ type: z.string() }).passthrough();
const PiToolResultContentSchema = z.union([
  PiToolResultTextContentSchema,
  PiToolResultUnknownContentSchema,
]);
const PiToolResultObjectSchema = z
  .object({
    output: z.string().optional(),
    stdout: z.string().optional(),
    text: z.string().optional(),
    content: z.array(PiToolResultContentSchema).optional(),
    exitCode: z.number().optional(),
    code: z.number().optional(),
    details: z.object({ diff: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();
const PiToolResultSchema = z.union([z.string(), PiToolResultObjectSchema, z.null()]);

type PiToolResult = z.infer<typeof PiToolResultSchema>;

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
  edits: z.array(z.object({ oldText: z.string(), newText: z.string() })),
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

export function parseToolResult(rawResult: unknown): PiToolResult {
  const parsed = PiToolResultSchema.safeParse(rawResult);
  return parsed.success ? parsed.data : null;
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
  return { path: parsed.data.path, edits: [{ oldText, newText }] };
}

function parseEditToolArgs(rawArgs: unknown): PiTrackedToolCall {
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

export function parseToolArgs(toolName: string, rawArgs: unknown): PiTrackedToolCall {
  if (toolName === "edit") {
    return parseEditToolArgs(rawArgs);
  }
  const schema = SIMPLE_TOOL_SCHEMAS[toolName as SimpleToolKind];
  if (schema) {
    const parsed = schema.safeParse(rawArgs);
    if (parsed.success) {
      return { kind: toolName as SimpleToolKind, toolName, args: parsed.data } as PiTrackedToolCall;
    }
  }
  return { kind: "unknown", toolName, args: rawArgs ?? null };
}

export function extractTextFromToolResult(result: PiToolResult): string | undefined {
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
      textParts.push(block.text as string);
    }
  }
  return textParts.length > 0 ? textParts.join("\n") : undefined;
}

function resolveToolCallOutput(result: PiToolResult): ToolCallOutputSummary {
  if (typeof result === "string") {
    return { output: result };
  }
  if (!result) {
    return {};
  }
  const summary: ToolCallOutputSummary = { output: extractTextFromToolResult(result) };
  if (typeof result.exitCode === "number") {
    return { ...summary, exitCode: result.exitCode };
  }
  if (typeof result.code === "number") {
    return { ...summary, exitCode: result.code };
  }
  return { ...summary, exitCode: null };
}

export function mapToolDetail(toolCall: PiTrackedToolCall, result?: PiToolResult): ToolCallDetail {
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
      return { type: "write", filePath: toolCall.args.path, content: toolCall.args.content };
    case "find":
      return {
        type: "search",
        query: toolCall.args.pattern,
        toolName: "search",
        content: typeof parsedResult === "string" ? parsedResult : undefined,
      };
    case "grep":
      return {
        type: "search",
        query: toolCall.args.pattern,
        toolName: "grep",
        content: typeof parsedResult === "string" ? parsedResult : undefined,
      };
    case "ls":
      return {
        type: "search",
        query: toolCall.args.path ?? "ls",
        content: typeof parsedResult === "string" ? parsedResult : undefined,
      };
    default:
      return { type: "unknown", input: toolCall.args, output: parsedResult };
  }
}

export function convertPromptInput(prompt: AgentPromptInput): PiPromptPayload {
  if (typeof prompt === "string") {
    return { text: prompt };
  }
  const textParts: string[] = [];
  const images: ImageContent[] = [];
  for (const block of prompt) {
    if (block.type === "text") {
      textParts.push(block.text);
      continue;
    }
    if (block.type === "image") {
      images.push({ type: "image", data: block.data, mimeType: block.mimeType });
      continue;
    }
    textParts.push(renderPromptAttachmentAsText(block));
  }
  const payload: PiPromptPayload = { text: textParts.join("\n\n") };
  if (images.length > 0) {
    payload.images = images;
  }
  return payload;
}

export function toAgentUsage(stats: SessionStats): AgentUsage | undefined {
  const inputTokens = stats.tokens.input;
  const cachedInputTokens = stats.tokens.cacheRead;
  const outputTokens = stats.tokens.output;
  const totalCostUsd = stats.cost;
  const contextWindowMaxTokens = stats.contextUsage?.contextWindow ?? undefined;
  const contextWindowUsedTokens = stats.contextUsage?.tokens ?? undefined;
  if (
    inputTokens === 0 &&
    cachedInputTokens === 0 &&
    outputTokens === 0 &&
    totalCostUsd === 0 &&
    contextWindowMaxTokens === undefined &&
    contextWindowUsedTokens === undefined
  ) {
    return undefined;
  }
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalCostUsd,
    ...(typeof contextWindowMaxTokens === "number" ? { contextWindowMaxTokens } : {}),
    ...(typeof contextWindowUsedTokens === "number" ? { contextWindowUsedTokens } : {}),
  };
}

const PiTextContentSchema = z.object({ type: z.literal("text"), text: z.string() });

export function getUserMessageText(content: string | (TextContent | ImageContent)[]): string {
  if (typeof content === "string") {
    return content;
  }
  const textParts: string[] = [];
  for (const block of content) {
    if (PiTextContentSchema.safeParse(block).success) {
      textParts.push((block as TextContent).text);
    }
  }
  return textParts.join("\n\n");
}
