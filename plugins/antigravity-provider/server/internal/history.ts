import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { mapToolDetail, type ToolJsonValue } from "./timeline.js";

export interface HistoryReplayEntry {
  item: ProviderTimelineItem;
  timestamp?: string;
}

export interface LoadTranscriptHistoryOptions {
  conversationId: string;
  appDataDir: string;
  systemPrompt?: string;
}

interface TranscriptToolCall {
  name: string;
  args: Record<string, ToolJsonValue>;
}

interface TranscriptEntry {
  stepIndex: number;
  type: string;
  status?: string;
  createdAt?: string;
  content?: string;
  thinking?: string;
  error?: string;
  toolCalls: TranscriptToolCall[];
}

interface PendingToolCall {
  id: string;
  name: string;
  args: Record<string, ToolJsonValue>;
  timestamp?: string;
}

type ToolCallItem = Extract<ProviderTimelineItem, { type: "tool_call" }>;

interface RunningToolRef {
  entry: HistoryReplayEntry;
  item: ToolCallItem;
}

interface ReplayAccumulator {
  entries: HistoryReplayEntry[];
  pendingTools: PendingToolCall[];
  runningTools: RunningToolRef[];
  seenUserTurn: boolean;
  systemPrompt?: string;
}

interface TranscriptReadResult {
  entries: HistoryReplayEntry[];
  complete: boolean;
}

const TRANSCRIPT_FILENAMES = ["transcript_full.jsonl", "transcript.jsonl"] as const;
const CANCELED_STATUSES = new Set(["CANCELED", "INTERRUPTED", "HALTED"]);
const USER_REQUEST_PREFIX = "<USER_REQUEST>";
const USER_REQUEST_CLOSE = "</USER_REQUEST>";
const TRAILING_WRAPPER_CLOSE =
  /\r?\n<\/USER_REQUEST>(?=\r?\n<(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>|\s*$)/g;

function lookupEnvValue(
  env: Readonly<Record<string, string | undefined>> | undefined,
  key: string,
): string | undefined {
  if (!env) return undefined;
  if (env[key] !== undefined) return env[key];
  if (process.platform !== "win32") return undefined;
  const lower = key.toLowerCase();
  for (const [entryKey, value] of Object.entries(env)) {
    if (entryKey.toLowerCase() === lower) return value;
  }
  return undefined;
}

function trimmedEnvValue(
  env: Readonly<Record<string, string | undefined>> | undefined,
  key: string,
): string | undefined {
  const raw = lookupEnvValue(env, key);
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function firstEnvValue(
  envs: ReadonlyArray<Readonly<Record<string, string | undefined>> | undefined>,
  key: string,
): string | undefined {
  for (const env of envs) {
    const value = trimmedEnvValue(env, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Resolves Antigravity CLI's app data directory matching `agy` env precedence. */
export function resolveAntigravityAppDataDir(
  launchEnv?: Readonly<Record<string, string | undefined>>,
  sessionEnv?: Readonly<Record<string, string | undefined>>,
): string {
  const configured = firstEnvValue([sessionEnv, launchEnv], "ANTIGRAVITY_APP_DATA_DIR");
  if (configured) return configured;
  const home =
    firstEnvValue([sessionEnv, launchEnv], "HOME") ??
    (process.platform === "win32"
      ? firstEnvValue([sessionEnv, launchEnv], "USERPROFILE")
      : undefined) ??
    os.homedir();
  return path.join(home, ".gemini", "antigravity-cli");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sanitizeJsonValue(value: unknown): ToolJsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    const items: ToolJsonValue[] = [];
    for (const element of value) {
      const normalized = sanitizeJsonValue(element);
      if (normalized !== undefined) {
        items.push(normalized);
      }
    }
    return items;
  }
  if (!isRecord(value)) return undefined;
  return sanitizeJsonRecord(value);
}

function sanitizeJsonRecord(value: unknown): Record<string, ToolJsonValue> {
  if (!isRecord(value)) return {};
  const entries: Array<[string, ToolJsonValue]> = [];
  for (const [key, entry] of Object.entries(value)) {
    const normalized = sanitizeJsonValue(entry);
    if (normalized !== undefined) {
      entries.push([key, normalized]);
    }
  }
  return Object.fromEntries(entries);
}

function parseToolCalls(rawCalls: unknown): TranscriptToolCall[] {
  if (!Array.isArray(rawCalls)) return [];
  const toolCalls: TranscriptToolCall[] = [];
  for (const rawCall of rawCalls) {
    if (!isRecord(rawCall) || typeof rawCall.name !== "string" || rawCall.name.length === 0) {
      continue;
    }
    toolCalls.push({ name: rawCall.name, args: sanitizeJsonRecord(rawCall.args) });
  }
  return toolCalls;
}

function parseEntry(line: string, fallbackIndex: number): TranscriptEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") return null;
  const stepIndex =
    typeof parsed.step_index === "number" && Number.isInteger(parsed.step_index)
      ? parsed.step_index
      : fallbackIndex;
  return {
    stepIndex,
    type: parsed.type,
    status: typeof parsed.status === "string" ? parsed.status : undefined,
    createdAt: asNonEmptyString(parsed.created_at),
    content: typeof parsed.content === "string" ? parsed.content : undefined,
    thinking: typeof parsed.thinking === "string" ? parsed.thinking : undefined,
    error: asNonEmptyString(parsed.error),
    toolCalls: parseToolCalls(parsed.tool_calls),
  };
}

function unwrapUserRequest(rawContent: string): string {
  if (!rawContent.startsWith(USER_REQUEST_PREFIX)) {
    return rawContent;
  }
  const afterPrefix = rawContent.slice(USER_REQUEST_PREFIX.length).replace(/^\r?\n/, "");
  let lastCloseIndex: number | undefined;
  for (const match of afterPrefix.matchAll(TRAILING_WRAPPER_CLOSE)) {
    lastCloseIndex = match.index;
  }
  if (lastCloseIndex !== undefined) {
    return afterPrefix.slice(0, lastCloseIndex);
  }
  const inlineClose = afterPrefix.lastIndexOf(USER_REQUEST_CLOSE);
  if (
    inlineClose !== -1 &&
    afterPrefix.slice(inlineClose + USER_REQUEST_CLOSE.length).trim() === ""
  ) {
    return afterPrefix.slice(0, inlineClose).replace(/\r?\n$/, "");
  }
  return rawContent;
}

function extractUserMessageText(
  rawContent: string,
  isFirstUserTurn: boolean,
  systemPrompt?: string,
): string {
  let text = unwrapUserRequest(rawContent);
  if (isFirstUserTurn && systemPrompt) {
    const prefix = `${systemPrompt}\n\n`;
    if (text.startsWith(prefix)) {
      text = text.slice(prefix.length);
    }
  }
  return text;
}

function buildToolItem(pending: PendingToolCall, result?: TranscriptEntry): HistoryReplayEntry {
  const timestamp = result?.createdAt ?? pending.timestamp;
  const base = {
    type: "tool_call" as const,
    id: pending.id,
    callId: pending.id,
    name: pending.name,
  };
  if (!result || (result.status !== undefined && CANCELED_STATUSES.has(result.status))) {
    const detail = mapToolDetail(pending.name, pending.args, result?.content);
    return { item: { ...base, detail, status: "canceled", error: null }, timestamp };
  }
  if (result.status === "ERROR" || result.error !== undefined) {
    const error = result.error ?? "Antigravity tool failed";
    const detail = mapToolDetail(pending.name, pending.args, result.content, error);
    return { item: { ...base, detail, status: "failed", error }, timestamp };
  }
  const detail = mapToolDetail(pending.name, pending.args, result.content);
  const status = result.status === "RUNNING" ? "running" : "completed";
  return { item: { ...base, detail, status, error: null }, timestamp };
}

function flushPendingTools(state: ReplayAccumulator): void {
  for (const pending of state.pendingTools) {
    state.entries.push(buildToolItem(pending));
  }
  state.pendingTools.length = 0;
}

function settleRunningTools(state: ReplayAccumulator, status: "completed" | "canceled"): void {
  for (const ref of state.runningTools) {
    ref.entry.item = { ...ref.item, status, error: null };
  }
  state.runningTools.length = 0;
}

function recordToolResult(
  state: ReplayAccumulator,
  pending: PendingToolCall,
  entry: TranscriptEntry,
): void {
  const replayEntry = buildToolItem(pending, entry);
  state.entries.push(replayEntry);
  if (entry.status === "RUNNING" && replayEntry.item.type === "tool_call") {
    state.runningTools.push({ entry: replayEntry, item: replayEntry.item });
  }
}

function appendPlannerResponse(state: ReplayAccumulator, entry: TranscriptEntry): void {
  if (entry.thinking && entry.thinking.trim().length > 0) {
    state.entries.push({
      item: {
        type: "reasoning",
        id: `history:${entry.stepIndex}:reasoning`,
        text: entry.thinking,
      },
      timestamp: entry.createdAt,
    });
  }
  if (entry.content && entry.content.trim().length > 0) {
    state.entries.push({
      item: {
        type: "assistant_message",
        id: `history:${entry.stepIndex}:assistant`,
        text: entry.content,
      },
      timestamp: entry.createdAt,
    });
  }
  for (const [toolIndex, toolCall] of entry.toolCalls.entries()) {
    state.pendingTools.push({
      id: `history:${entry.stepIndex}:tool:${toolIndex}`,
      name: toolCall.name,
      args: toolCall.args,
      timestamp: entry.createdAt,
    });
  }
}

function applyTranscriptEntry(state: ReplayAccumulator, entry: TranscriptEntry): void {
  if (entry.type === "GENERIC") {
    const pending = state.pendingTools.shift();
    if (pending) recordToolResult(state, pending, entry);
    return;
  }
  if (entry.type === "SYSTEM_MESSAGE" || entry.type === "CHECKPOINT") {
    return;
  }
  flushPendingTools(state);
  settleRunningTools(state, entry.type === "PLANNER_RESPONSE" ? "completed" : "canceled");

  if (entry.type === "USER_INPUT" && entry.content !== undefined) {
    const text = extractUserMessageText(entry.content, !state.seenUserTurn, state.systemPrompt);
    state.seenUserTurn = true;
    state.entries.push({
      item: { type: "user_message", id: `history:${entry.stepIndex}:user`, text },
      timestamp: entry.createdAt,
    });
    return;
  }
  if (entry.type === "ERROR_MESSAGE") {
    const message = entry.error ?? asNonEmptyString(entry.content) ?? "Antigravity error";
    state.entries.push({
      item: { type: "error", id: `history:${entry.stepIndex}:error`, message },
      timestamp: entry.createdAt,
    });
    return;
  }
  if (entry.type === "PLANNER_RESPONSE") {
    appendPlannerResponse(state, entry);
  }
}

function isSafeConversationId(conversationId: string): boolean {
  return (
    Boolean(conversationId) &&
    !conversationId.includes("\0") &&
    !/[\\/:]/.test(conversationId) &&
    conversationId !== "." &&
    conversationId !== ".."
  );
}

async function readTranscriptFile(
  transcriptPath: string,
  systemPrompt?: string,
): Promise<TranscriptReadResult> {
  const state: ReplayAccumulator = {
    entries: [],
    pendingTools: [],
    runningTools: [],
    seenUserTurn: false,
    systemPrompt,
  };
  let lineNumber = 0;
  let readAnyLine = false;
  const stream = createReadStream(transcriptPath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      readAnyLine = true;
      const trimmed = line.trim();
      if (!trimmed) continue;
      const entry = parseEntry(trimmed, lineNumber++);
      if (entry) applyTranscriptEntry(state, entry);
    }
  } catch (error) {
    flushPendingTools(state);
    settleRunningTools(state, "canceled");
    if (error instanceof Error) {
      return { entries: state.entries, complete: false };
    }
    throw error;
  } finally {
    lines.close();
    stream.destroy();
  }
  if (!readAnyLine) return { entries: [], complete: false };
  flushPendingTools(state);
  settleRunningTools(state, "canceled");
  return { entries: state.entries, complete: true };
}

/**
 * Reconstructs Paseo timeline items from Antigravity's persisted JSONL transcript.
 * Empty, missing, or mid-stream failed files fall back to the next candidate variant.
 */
export async function loadTranscriptHistory(
  options: LoadTranscriptHistoryOptions,
): Promise<HistoryReplayEntry[]> {
  if (!isSafeConversationId(options.conversationId)) return [];
  const logsDir = path.join(
    options.appDataDir,
    "brain",
    options.conversationId,
    ".system_generated",
    "logs",
  );
  let partialFallback: HistoryReplayEntry[] = [];
  for (const filename of TRANSCRIPT_FILENAMES) {
    const result = await readTranscriptFile(path.join(logsDir, filename), options.systemPrompt);
    if (result.complete) return result.entries;
    if (partialFallback.length === 0 && result.entries.length > 0) {
      partialFallback = result.entries;
    }
  }
  return partialFallback;
}
