import { open, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import type {
  ProviderTimelineItem,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";
import type { Step } from "./wire.js";

const MAX_REPLAY_TOOL_OUTPUT_CHARS = 64 * 1024;
const RELEVANT_STEP_TYPES = new Set(["USER_INPUT", "PLANNER_RESPONSE", "GENERIC"]);

const transcriptToolCallSchema = z.object({
  name: z.string(),
  args: z.record(z.string(), z.json()).default({}),
});

const transcriptStepSchema = z.object({
  step_index: z.number().int().nonnegative(),
  type: z.string(),
  status: z.string().default("DONE"),
  created_at: z.string().optional(),
  content: z.string().optional(),
  thinking: z.string().optional(),
  tool_calls: z.array(transcriptToolCallSchema).optional(),
  error: z.string().optional(),
});

type TranscriptStep = z.infer<typeof transcriptStepSchema>;
type TranscriptToolCall = z.infer<typeof transcriptToolCallSchema>;

export interface ReplayedTimelineEntry {
  item: ProviderTimelineItem;
  timestamp?: string;
}

const READ_TOOLS = new Set(["view_file", "read_file"]);
const WRITE_TOOLS = new Set(["write_to_file", "write_file"]);
const EDIT_TOOLS = new Set(["replace_file_content", "multi_replace_file_content", "edit_file"]);

export function toolItem(
  step: Step,
  id: string,
): Extract<ProviderTimelineItem, { type: "tool_call" }> {
  const detail = toolDetail(step);
  const name = step.tool_name || "Antigravity tool";
  const metadata = step.subagent_info ? { subagents: step.subagent_info.subagents } : undefined;
  const base = { type: "tool_call" as const, id, callId: id, name, detail, metadata };
  if (step.state === "ERROR") {
    const error =
      step.tool_info && step.tool_info.error
        ? step.tool_info.error.message
        : "Antigravity tool failed";
    return { ...base, status: "failed", error };
  }
  const status = step.state === "ACTIVE" ? "running" : "completed";
  return { ...base, status, error: null };
}

function toolDetail(step: Step): ProviderToolCallDetail {
  const child = step.subagent_info?.subagents[0];
  if (child) {
    return {
      type: "sub_agent",
      subAgentType: child.type_name,
      description: child.initial_prompt,
      childSessionId: child.conversation_id === null ? undefined : child.conversation_id,
      log: child.log_uri,
    };
  }
  const info = step.tool_info;
  if (!info) return { type: "plain_text", label: step.tool_name, text: "" };
  if (info.name === "run_command" && typeof info.parameters.CommandLine === "string") {
    return { type: "shell", command: info.parameters.CommandLine, output: info.output };
  }
  const fileDetail = fileToolDetail(info);
  if (fileDetail) return fileDetail;
  // Native frames summarize writes; they do not carry the file contents or diff.
  return { type: "unknown", input: info.parameters, output: info.error || info.output };
}

function fileToolDetail(info: NonNullable<Step["tool_info"]>): ProviderToolCallDetail | null {
  const filePath = stringField(info.parameters, "AbsolutePath", "TargetFile", "Path");
  if (!filePath) return null;
  if (READ_TOOLS.has(info.name)) return { type: "read", filePath, content: info.output };
  if (WRITE_TOOLS.has(info.name)) {
    const content = stringField(info.parameters, "Content");
    return { type: "write", filePath, ...(content !== undefined ? { content } : {}) };
  }
  if (EDIT_TOOLS.has(info.name)) {
    const oldString = stringField(info.parameters, "Target");
    const newString = stringField(info.parameters, "Replacement");
    return {
      type: "edit",
      filePath,
      ...(oldString !== undefined ? { oldString } : {}),
      ...(newString !== undefined ? { newString } : {}),
    };
  }
  return null;
}

export async function readTranscriptHistory(options: {
  conversationId: string;
  env: Readonly<Record<string, string>>;
  systemPrompt?: string;
}): Promise<ReplayedTimelineEntry[]> {
  const { conversationId, env, systemPrompt } = options;
  if (!isSafeConversationId(conversationId)) return [];
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const logsDir = path.join(
    home,
    ".gemini",
    "antigravity-cli",
    "brain",
    conversationId,
    ".system_generated",
    "logs",
  );
  const handle = await openTranscriptFile(logsDir);
  if (handle === null) return [];

  const stepsByIndex = await streamTranscriptSteps(handle);
  const orderedIndices = [...stepsByIndex.keys()].sort((left, right) => left - right);
  const entries: ReplayedTimelineEntry[] = [];
  let firstUserMessage = true;

  for (const stepIndex of orderedIndices) {
    const step = stepsByIndex.get(stepIndex);
    if (!step) continue;
    stepsByIndex.delete(stepIndex);
    if (step.type === "USER_INPUT" && typeof step.content === "string") {
      entries.push(toUserEntry(step, step.content, firstUserMessage ? systemPrompt : undefined));
      firstUserMessage = false;
      continue;
    }
    if (step.type === "PLANNER_RESPONSE") {
      appendPlannerEntries(entries, conversationId, step, stepsByIndex);
    }
  }

  return entries;
}

function isSafeConversationId(conversationId: string): boolean {
  return (
    Boolean(conversationId) &&
    path.basename(conversationId) === conversationId &&
    conversationId !== "." &&
    conversationId !== ".."
  );
}

async function openTranscriptFile(logsDir: string): Promise<FileHandle | null> {
  for (const name of ["transcript_full.jsonl", "transcript.jsonl"]) {
    try {
      return await open(path.join(logsDir, name), "r");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
  }
  return null;
}

async function streamTranscriptSteps(handle: FileHandle): Promise<Map<number, TranscriptStep>> {
  const stepsByIndex = new Map<number, TranscriptStep>();
  const stream = handle.createReadStream({ encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let pendingInvalidJson: unknown = null;

  try {
    for await (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      if (pendingInvalidJson !== null) throw pendingInvalidJson;
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(line);
      } catch (error) {
        pendingInvalidJson = error;
        continue;
      }
      const step = compactTranscriptStep(transcriptStepSchema.parse(parsedJson));
      recordTranscriptStep(stepsByIndex, step);
    }
  } finally {
    lines.close();
    await handle.close().catch(() => undefined);
  }

  return stepsByIndex;
}

function recordTranscriptStep(
  stepsByIndex: Map<number, TranscriptStep>,
  step: TranscriptStep,
): void {
  if (!RELEVANT_STEP_TYPES.has(step.type)) return;
  if (stepsByIndex.has(step.step_index) && step.type === "USER_INPUT") {
    for (const existingIndex of stepsByIndex.keys()) {
      if (existingIndex > step.step_index) stepsByIndex.delete(existingIndex);
    }
  }
  stepsByIndex.set(step.step_index, step);
}

function compactTranscriptStep(step: TranscriptStep): TranscriptStep {
  if (step.type === "GENERIC") {
    return {
      step_index: step.step_index,
      type: step.type,
      status: step.status,
      created_at: step.created_at,
      content: step.content
        ? boundText(stripGenericHeader(step.content), MAX_REPLAY_TOOL_OUTPUT_CHARS)
        : undefined,
      error: step.error ? boundText(step.error, MAX_REPLAY_TOOL_OUTPUT_CHARS) : undefined,
    };
  }
  if (step.type === "PLANNER_RESPONSE" && step.tool_calls) {
    return {
      ...step,
      tool_calls: step.tool_calls.map((call) => ({
        name: call.name,
        args: boundToolArgs(call.args),
      })),
    };
  }
  return step;
}

type JsonValue = TranscriptToolCall["args"][string];

function boundToolArgs(args: Record<string, JsonValue>): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => [key, boundJsonValue(value)]),
  );
}

function boundJsonValue(value: JsonValue): JsonValue {
  if (typeof value === "string") return boundText(value, MAX_REPLAY_TOOL_OUTPUT_CHARS);
  if (Array.isArray(value)) return value.map(boundJsonValue);
  if (typeof value === "object" && value !== null) {
    return boundToolArgs(value as Record<string, JsonValue>);
  }
  return value;
}

function boundText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return Buffer.from(text.slice(0, maxChars), "utf16le").toString("utf16le");
}

function toUserEntry(
  step: TranscriptStep,
  rawContent: string,
  systemPrompt: string | undefined,
): ReplayedTimelineEntry {
  let text = unwrapUserRequest(rawContent);
  if (systemPrompt && text.startsWith(`${systemPrompt}\n\n`)) {
    text = text.slice(systemPrompt.length + 2);
  } else if (systemPrompt && text === systemPrompt) {
    text = "";
  }
  text = stripPromptImageLines(text);
  const id = `history:${step.step_index}`;
  return {
    item: { type: "user_message", id, messageId: id, text },
    timestamp: step.created_at,
  };
}

function appendPlannerEntries(
  entries: ReplayedTimelineEntry[],
  conversationId: string,
  step: TranscriptStep,
  stepsByIndex: Map<number, TranscriptStep>,
): void {
  const thinking = step.thinking?.trim();
  if (thinking) {
    entries.push({
      item: {
        type: "reasoning",
        id: `history:${step.step_index}:reasoning`,
        text: thinking,
      },
      timestamp: step.created_at,
    });
  }

  if (step.content) {
    const id = `history:${step.step_index}`;
    entries.push({
      item: { type: "assistant_message", id, messageId: id, text: step.content },
      timestamp: step.created_at,
    });
  }

  for (const [offset, call] of (step.tool_calls ?? []).entries()) {
    const toolStepIndex = step.step_index + 1 + offset;
    const candidate = stepsByIndex.get(toolStepIndex);
    const generic = candidate?.type === "GENERIC" ? candidate : undefined;
    if (generic) stepsByIndex.delete(toolStepIndex);
    const id = `history:${toolStepIndex}`;
    entries.push({
      item: replayedToolItem(conversationId, toolStepIndex, call, generic, id),
      timestamp: generic?.created_at ?? step.created_at,
    });
  }
}

function unwrapUserRequest(content: string): string {
  if (!content.startsWith("<USER_REQUEST>")) return content;
  const body = content.slice("<USER_REQUEST>".length).replace(/^\r?\n/, "");
  return body.replace(
    /\r?\n?<\/USER_REQUEST>(?:\r?\n<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>\s*|\s*)$/,
    "",
  );
}

function stripPromptImageLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^Attached image: .*[\\/]paseo-antigravity-images-/.test(line))
    .join("\n");
}

function stripGenericHeader(content: string): string {
  return content.replace(/^Created At: [^\n]*\n(?:Completed At: [^\n]*\n)?/, "");
}

function replayedToolItem(
  conversationId: string,
  stepIndex: number,
  call: TranscriptToolCall,
  generic: TranscriptStep | undefined,
  id: string,
): Extract<ProviderTimelineItem, { type: "tool_call" }> {
  const item = toolItem(toToolStep(conversationId, stepIndex, call, generic), id);
  if (!generic) return { ...item, status: "canceled", error: null };
  if (generic.status !== "DONE" && generic.status !== "ERROR" && generic.status !== "INVALID") {
    return { ...item, status: "canceled", error: null };
  }
  return item;
}

function toToolStep(
  conversationId: string,
  stepIndex: number,
  call: TranscriptToolCall,
  generic: TranscriptStep | undefined,
): Step {
  const name = call.name.trim();
  const output = generic?.content ?? "";
  const failed = generic?.status === "ERROR" || generic?.status === "INVALID";
  const state: Step["state"] = failed ? "ERROR" : "DONE";

  if (name === "invoke_subagent" && !failed) {
    const subagents = parseSubagents(call.args, output);
    if (subagents.length > 0) {
      return {
        conversation_id: conversationId,
        step_index: stepIndex,
        state,
        step_type: "subagent",
        text_delta: "",
        tool_name: name,
        tool_info: null,
        subagent_info: { subagents },
        usage: null,
      };
    }
  }

  return {
    conversation_id: conversationId,
    step_index: stepIndex,
    state,
    step_type: "tool",
    text_delta: "",
    tool_name: name,
    tool_info: {
      name,
      parameters: call.args,
      output: failed ? "" : output,
      error: failed
        ? {
            type: "TOOL_ERROR",
            message:
              generic?.error ||
              output.replace(/^Encountered error in step execution:\s*/, "") ||
              "Antigravity tool failed",
          }
        : null,
    },
    subagent_info: null,
    usage: null,
  };
}

function parseSubagents(
  args: Record<string, unknown>,
  output: string,
): NonNullable<Step["subagent_info"]>["subagents"] {
  const specs =
    Array.isArray(args.Subagents) && args.Subagents.length > 0
      ? args.Subagents.filter(
          (entry): entry is Record<string, unknown> =>
            typeof entry === "object" && entry !== null && !Array.isArray(entry),
        )
      : [args];
  const created = parseCreatedSubagents(output);
  return specs
    .map((spec, index) => toSubagentEntry(spec, created[index]))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
}

function parseCreatedSubagents(output: string): Array<Record<string, unknown>> {
  const created: Array<Record<string, unknown>> = [];
  for (const match of output.matchAll(/\{\s*"conversationId"[\s\S]*?\}/g)) {
    try {
      const parsed = JSON.parse(match[0]);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        created.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Ignore malformed JSON blocks in tool output.
    }
  }
  return created;
}

function toSubagentEntry(
  spec: Record<string, unknown>,
  info: Record<string, unknown> | undefined,
): NonNullable<Step["subagent_info"]>["subagents"][number] | null {
  const typeName = stringField(spec, "TypeName", "type_name") ?? "";
  const role = stringField(spec, "Role", "role") ?? "";
  const initialPrompt = stringField(spec, "Prompt", "initial_prompt") ?? "";
  const conversationId =
    stringField(info, "conversationId") ?? stringField(spec, "conversation_id") ?? null;
  const logUri = stringField(info, "logAbsoluteUri") ?? stringField(spec, "log_uri") ?? "";
  const workspaceUris = Array.isArray(info?.workspaceUris)
    ? info.workspaceUris.filter((uri): uri is string => typeof uri === "string")
    : [];
  if (!typeName && !initialPrompt && !conversationId) return null;
  return {
    type_name: typeName,
    role,
    initial_prompt: initialPrompt,
    conversation_id: conversationId,
    log_uri: logUri,
    workspace_uris: workspaceUris,
  };
}

function stringField(
  record: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}
