import { promises as fs, type Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";

import { z } from "zod";
import type { Logger } from "pino";

import type { AgentTimelineItem } from "../agent-sdk-types.js";
import { mapCodexRolloutToolCall } from "./codex/tool-call-mapper.js";

const MAX_ROLLOUT_SEARCH_DEPTH = 4;

function resolveCodexSessionRoot(): string | null {
  if (process.env.CODEX_SESSION_DIR) {
    return process.env.CODEX_SESSION_DIR;
  }
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  return path.join(codexHome, "sessions");
}

async function findRolloutFile(
  threadId: string,
  root: string
): Promise<string | null> {
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isFile()) {
        const matchesThread = entry.name.includes(threadId);
        const matchesPrefix = entry.name.startsWith("rollout-");
        const matchesExtension =
          entry.name.endsWith(".json") || entry.name.endsWith(".jsonl");
        if (matchesThread && matchesPrefix && matchesExtension) {
          return entryPath;
        }
      } else if (entry.isDirectory() && depth < MAX_ROLLOUT_SEARCH_DEPTH) {
        stack.push({ dir: entryPath, depth: depth + 1 });
      }
    }
  }
  return null;
}

const RolloutContentItemSchema = z
  .union([
    z.object({ type: z.literal("input_text"), text: z.string() }),
    z.object({ type: z.literal("output_text"), text: z.string() }),
    z.object({ type: z.literal("reasoning_text"), text: z.string() }),
    z.object({ type: z.literal("text"), text: z.string() }),
    z
      .object({
        type: z.string(),
        text: z.string().optional(),
        message: z.string().optional(),
      })
      .passthrough(),
  ]);

const RolloutContentArraySchema = z.array(RolloutContentItemSchema);

function extractContentTextByType(content: unknown, itemType: string): string {
  const parsed = RolloutContentArraySchema.safeParse(content);
  if (!parsed.success) {
    return "";
  }
  return parsed.data
    .filter((item) => item.type === itemType)
    .map((item) => item.text)
    .join("\n")
    .trim();
}

const RolloutResponseMessagePayloadSchema = z.object({
  type: z.literal("message"),
  role: z.enum(["user", "assistant"]).optional(),
  content: z.unknown().optional(),
});

const RolloutResponseReasoningPayloadSchema = z.object({
  type: z.literal("reasoning"),
  content: z.unknown().optional(),
  summary: z.array(z.object({ text: z.string().optional() })).optional(),
  text: z.string().optional(),
});

const RolloutResponseFunctionCallPayloadSchema = z.object({
  type: z.literal("function_call"),
  name: z.string().optional(),
  call_id: z.string().optional(),
  arguments: z.string().optional(),
});

const RolloutResponseCustomToolCallPayloadSchema = z.object({
  type: z.literal("custom_tool_call"),
  name: z.string().optional(),
  call_id: z.string().optional(),
  arguments: z.string().optional(),
});

const RolloutResponseFunctionCallOutputPayloadSchema = z.object({
  type: z.literal("function_call_output"),
  call_id: z.string().optional(),
  output: z.string().optional(),
});

const RolloutEventAgentReasoningPayloadSchema = z.object({
  type: z.literal("agent_reasoning"),
  text: z.string().optional(),
});

const RolloutEventAgentMessagePayloadSchema = z.object({
  type: z.literal("agent_message"),
  message: z
    .union([
      z.string(),
      z
        .object({
          role: z.string().optional(),
          message: z.string().optional(),
          text: z.string().optional(),
        })
        .passthrough(),
    ])
    .optional(),
});

const RolloutEventUserMessagePayloadSchema = z.object({
  type: z.literal("user_message"),
  message: z
    .union([
      z.string(),
      z
        .object({
          role: z.string().optional(),
          message: z.string().optional(),
          text: z.string().optional(),
        })
        .passthrough(),
    ])
    .optional(),
});

type RolloutResponseReasoningPayload = z.infer<
  typeof RolloutResponseReasoningPayloadSchema
>;
type ParsedRolloutRecord =
  | { kind: "timeline"; item: AgentTimelineItem }
  | { kind: "call"; name: string; callId?: string; input?: unknown }
  | { kind: "output"; callId: string; output: string }
  | { kind: "ignore" };

const RolloutMessageContentSchema = z
  .union([
    z.string().transform((content) => content.trim()),
    z.array(
      z
        .object({
          text: z.string().optional(),
          message: z.string().optional(),
        })
        .passthrough()
    ).transform((content) =>
      content
        .map((block) => block.text ?? block.message ?? "")
        .map((text) => text.trim())
        .filter(Boolean)
        .join("\n")
        .trim()
    ),
  ]);

function extractMessageText(content: unknown): string {
  const parsed = RolloutMessageContentSchema.safeParse(content);
  if (!parsed.success) {
    return "";
  }
  return parsed.data;
}

const RolloutEventMessageTextSchema = z
  .union([
    z.string(),
    z
      .object({
        message: z.string().optional(),
        text: z.string().optional(),
      })
      .passthrough()
      .transform((message) => message.message ?? message.text ?? ""),
  ]);

function extractEventMessageText(message: unknown): string {
  const parsed = RolloutEventMessageTextSchema.safeParse(message);
  if (!parsed.success) {
    return "";
  }
  return parsed.data;
}

function isSyntheticRolloutUserMessage(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return false;
  }
  const lower = normalized.toLowerCase();
  if (
    lower.startsWith("# agents.md instructions for") &&
    lower.includes("<instructions>")
  ) {
    return true;
  }
  if (lower.startsWith("<environment_context>")) {
    return true;
  }
  return false;
}

function extractReasoningText(payload: RolloutResponseReasoningPayload): string {
  if (Array.isArray(payload.summary)) {
    const text = payload.summary
      .map((item) => item.text ?? "")
      .filter(Boolean)
      .join("\n")
      .trim();
    if (text) {
      return text;
    }
  }
  const contentText = extractContentTextByType(payload.content, "reasoning_text");
  if (contentText) {
    return contentText;
  }
  if (typeof payload.text === "string") {
    return payload.text;
  }
  return "";
}

function parseJsonLikeString(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

const FunctionCallInputNormalizationSchema = z
  .union([
    z.object({ cmd: z.string() }).transform((input) => ({ name: "Bash", input: { command: input.cmd } })),
    z
      .object({ command: z.array(z.string()) })
      .transform((input) => ({ name: "Bash", input: { command: input.command[2] ?? "" } })),
    z.unknown().transform((input) => ({ name: "unknown", input })),
  ]);

const RolloutResponseRecordSchema = z
  .union([
    RolloutResponseMessagePayloadSchema.transform((payload): ParsedRolloutRecord => {
      const text = extractMessageText(payload.content);
      const itemType = payload.role === "assistant" ? "assistant_message" : "user_message";
      const shouldEmit = text.length > 0 && (itemType !== "user_message" || !isSyntheticRolloutUserMessage(text));
      return shouldEmit
        ? { kind: "timeline", item: { type: itemType, text } }
        : { kind: "ignore" };
    }),
    RolloutResponseReasoningPayloadSchema.transform((payload): ParsedRolloutRecord => {
      const text = extractReasoningText(payload);
      return text.length > 0
        ? { kind: "timeline", item: { type: "reasoning", text } }
        : { kind: "ignore" };
    }),
    z
      .union([
        RolloutResponseFunctionCallPayloadSchema,
        RolloutResponseCustomToolCallPayloadSchema,
      ])
      .transform((payload): ParsedRolloutRecord => {
        const rawName = payload.name ?? "unknown";
        const parsedArguments = payload.arguments ? parseJsonLikeString(payload.arguments) : undefined;
        const normalized =
          rawName === "exec_command" || rawName === "shell"
            ? FunctionCallInputNormalizationSchema.parse(parsedArguments)
            : { name: rawName, input: parsedArguments };
        const skip = rawName === "write_stdin";
        return skip
          ? { kind: "ignore" }
          : {
              kind: "call",
              name: normalized.name,
              callId: payload.call_id,
              input: normalized.input,
            };
      }),
    RolloutResponseFunctionCallOutputPayloadSchema.transform(
      (payload): ParsedRolloutRecord =>
        payload.call_id && payload.output
          ? { kind: "output", callId: payload.call_id, output: payload.output }
          : { kind: "ignore" }
    ),
    z.unknown().transform((): ParsedRolloutRecord => ({ kind: "ignore" })),
  ]);

const RolloutEventRecordSchema = z
  .union([
    RolloutEventAgentReasoningPayloadSchema.transform(
      (payload): ParsedRolloutRecord =>
        payload.text
          ? { kind: "timeline", item: { type: "reasoning", text: payload.text } }
          : { kind: "ignore" }
    ),
    RolloutEventAgentMessagePayloadSchema.transform((payload): ParsedRolloutRecord => {
      const text = extractEventMessageText(payload.message);
      return text.length > 0
        ? { kind: "timeline", item: { type: "assistant_message", text } }
        : { kind: "ignore" };
    }),
    RolloutEventUserMessagePayloadSchema.transform((payload): ParsedRolloutRecord => {
      const text = extractEventMessageText(payload.message);
      const shouldEmit = text.length > 0 && !isSyntheticRolloutUserMessage(text);
      return shouldEmit
        ? { kind: "timeline", item: { type: "user_message", text } }
        : { kind: "ignore" };
    }),
    z.unknown().transform((): ParsedRolloutRecord => ({ kind: "ignore" })),
  ]);

const RolloutRecordSchema = z
  .object({
    type: z.enum(["response_item", "event_msg"]),
    payload: z.unknown().optional(),
    item: z.unknown().optional(),
    msg: z.unknown().optional(),
  })
  .transform((entry) =>
    entry.type === "response_item"
      ? RolloutResponseRecordSchema.parse(entry.payload ?? entry.item)
      : RolloutEventRecordSchema.parse(entry.payload ?? entry.msg)
  );

function parseJsonRolloutTimeline(
  parsed: unknown
): AgentTimelineItem[] | null {
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const items = (parsed as { items?: unknown }).items;
  if (!Array.isArray(items)) {
    return null;
  }
  const timeline: AgentTimelineItem[] = [];
  for (const entry of items) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const messagePayloadResult =
      RolloutResponseMessagePayloadSchema.safeParse(entry);
    if (messagePayloadResult.success) {
      const payload = messagePayloadResult.data;
      const text = extractMessageText(payload.content);
      if (!text) {
        continue;
      }
      if (payload.role === "assistant") {
        timeline.push({ type: "assistant_message", text });
      } else if (payload.role === "user") {
        if (!isSyntheticRolloutUserMessage(text)) {
          timeline.push({ type: "user_message", text });
        }
      }
      continue;
    }

    const reasoningPayloadResult =
      RolloutResponseReasoningPayloadSchema.safeParse(entry);
    if (reasoningPayloadResult.success) {
      const text = extractReasoningText(reasoningPayloadResult.data);
      if (text) {
        timeline.push({ type: "reasoning", text });
      }
      continue;
    }
  }
  return timeline;
}

export async function parseRolloutFile(
  filePath: string
): Promise<AgentTimelineItem[]> {
  const content = await fs.readFile(filePath, "utf8");
  const trimmed = content.trim();
  if (!trimmed) {
    return [];
  }
  try {
    const parsed = JSON.parse(trimmed);
    const jsonTimeline = parseJsonRolloutTimeline(parsed);
    if (jsonTimeline) {
      return jsonTimeline;
    }
  } catch {
    // Fall back to JSONL parsing.
  }
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const parsedRecords = lines
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((record): record is unknown => record !== null)
    .map((record) => RolloutRecordSchema.safeParse(record))
    .filter((result): result is { success: true; data: ParsedRolloutRecord } => result.success)
    .map((result) => result.data);

  const outputsByCallId = parsedRecords
    .filter((record): record is Extract<ParsedRolloutRecord, { kind: "output" }> => record.kind === "output")
    .reduce((map, record) => map.set(record.callId, record.output), new Map<string, string>());

  return parsedRecords.flatMap((record): AgentTimelineItem[] =>
    record.kind === "timeline"
      ? [record.item]
      : record.kind === "call"
        ? [
            mapCodexRolloutToolCall({
              callId: record.callId ?? null,
              name: record.name,
              input: record.input ?? null,
              output: record.callId ? outputsByCallId.get(record.callId) ?? null : null,
            }),
          ]
        : []
  );
}

export type CodexPersistedTimelineOptions = {
  sessionRoot?: string | null;
  rolloutPath?: string | null;
};

export async function loadCodexPersistedTimeline(
  sessionId: string,
  options?: CodexPersistedTimelineOptions,
  logger?: Logger
): Promise<AgentTimelineItem[]> {
  const rolloutPath = options?.rolloutPath ?? null;
  if (rolloutPath) {
    try {
      const stat = await fs.stat(rolloutPath);
      if (stat.isFile()) {
        const timeline = await parseRolloutFile(rolloutPath);
        if (timeline.length > 0) {
          return timeline;
        }
      }
    } catch {
      // Fall back to session root scan.
    }
  }

  try {
    const preferredRoot = options?.sessionRoot ?? resolveCodexSessionRoot();
    const fallbackRoot = resolveCodexSessionRoot();
    let rolloutFile: string | null = null;

    if (preferredRoot) {
      rolloutFile = await findRolloutFile(sessionId, preferredRoot);
    }
    if (
      !rolloutFile &&
      fallbackRoot &&
      fallbackRoot !== preferredRoot
    ) {
      rolloutFile = await findRolloutFile(sessionId, fallbackRoot);
    }
    if (!rolloutFile) {
      return [];
    }

    return await parseRolloutFile(rolloutFile);
  } catch (error) {
    logger?.warn(
      { err: error, sessionId },
      "Failed to load persisted timeline"
    );
    return [];
  }
}
