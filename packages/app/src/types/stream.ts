import type { AgentProvider } from "@server/server/agent/agent-sdk-types";
import type { AgentStreamEventPayload } from "@server/server/messages";
import {
  extractCommandDetails,
  extractEditEntries,
  extractReadEntries,
  type CommandDetails,
  type EditEntry,
  type ReadEntry,
} from "../utils/tool-call-parsers";

/**
 * Simple hash function for deterministic ID generation
 */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36);
}

/**
 * Generate a simple unique ID (timestamp + random)
 */
export function generateMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

function createTimelineId(prefix: string, text: string, timestamp: Date): string {
  return `${prefix}_${timestamp.getTime()}_${simpleHash(text)}`;
}

function createUniqueTimelineId(
  state: StreamItem[],
  prefix: "assistant" | "thought" | "user",
  text: string,
  timestamp: Date
): string {
  const base = createTimelineId(prefix, text, timestamp);
  let suffixSeed = state.length;
  let candidate = `${base}_${suffixSeed.toString(36)}`;

  // Fast path when the generated id hasn't been used yet
  const hasCollision = state.some((entry) => entry.id === candidate);
  if (!hasCollision) {
    return candidate;
  }

  // If the id already exists (e.g. prior items were pruned/replaced),
  // spin until we find an unused suffix. Building the lookup Set lazily keeps
  // the common case cheap while still guaranteeing uniqueness.
  const usedIds = new Set(state.map((entry) => entry.id));
  while (usedIds.has(candidate)) {
    suffixSeed += 1;
    candidate = `${base}_${suffixSeed.toString(36)}`;
  }

  return candidate;
}

export type StreamItem =
  | UserMessageItem
  | AssistantMessageItem
  | ThoughtItem
  | ToolCallItem
  | TodoListItem
  | ActivityLogItem;

export interface UserMessageItem {
  kind: "user_message";
  id: string;
  text: string;
  timestamp: Date;
}

export interface AssistantMessageItem {
  kind: "assistant_message";
  id: string;
  text: string;
  timestamp: Date;
}

export interface ThoughtItem {
  kind: "thought";
  id: string;
  text: string;
  timestamp: Date;
}

interface OrchestratorToolCallData {
  toolCallId: string;
  toolName: string;
  arguments: unknown;
  result?: unknown;
  error?: unknown;
  status: "executing" | "completed" | "failed";
}

export interface AgentToolCallData {
  provider: AgentProvider;
  server: string;
  tool: string;
  status: string;
  raw?: unknown;
  callId?: string;
  displayName?: string;
  kind?: string;
  result?: unknown;
  error?: unknown;
  parsedEdits?: EditEntry[];
  parsedReads?: ReadEntry[];
  parsedCommand?: CommandDetails | null;
}

export type ToolCallPayload =
  | { source: "agent"; data: AgentToolCallData }
  | { source: "orchestrator"; data: OrchestratorToolCallData };

export interface ToolCallItem {
  kind: "tool_call";
  id: string;
  timestamp: Date;
  payload: ToolCallPayload;
}

type AgentToolCallItem = ToolCallItem & {
  payload: { source: "agent"; data: AgentToolCallData };
};

type ActivityLogType = "system" | "info" | "success" | "error";

export interface ActivityLogItem {
  kind: "activity_log";
  id: string;
  timestamp: Date;
  activityType: ActivityLogType;
  message: string;
  metadata?: Record<string, unknown>;
}

export type TodoEntry = { text: string; completed: boolean };

export interface TodoListItem {
  kind: "todo_list";
  id: string;
  timestamp: Date;
  provider: AgentProvider;
  items: TodoEntry[];
  raw?: unknown;
}

function normalizeChunk(text: string): { chunk: string; hasContent: boolean } {
  if (!text) {
    return { chunk: "", hasContent: false };
  }
  const chunk = text.replace(/\r/g, "");
  if (!chunk) {
    return { chunk: "", hasContent: false };
  }
  return { chunk, hasContent: /\S/.test(chunk) };
}

function appendUserMessage(
  state: StreamItem[],
  text: string,
  timestamp: Date,
  messageId?: string
): StreamItem[] {
  const { chunk, hasContent } = normalizeChunk(text);
  if (!hasContent) {
    return state;
  }

  const chunkSeed = chunk.trim() || chunk;
  const entryId =
    messageId ?? createUniqueTimelineId(state, "user", chunkSeed, timestamp);
  const existingIndex = state.findIndex(
    (entry) => entry.kind === "user_message" && entry.id === entryId
  );

  const nextItem: UserMessageItem = {
    kind: "user_message",
    id: entryId,
    text: chunk,
    timestamp,
  };

  if (existingIndex >= 0) {
    const next = [...state];
    next[existingIndex] = nextItem;
    return next;
  }

  return [...state, nextItem];
}

function appendAssistantMessage(state: StreamItem[], text: string, timestamp: Date): StreamItem[] {
  const { chunk, hasContent } = normalizeChunk(text);
  if (!chunk) {
    return state;
  }

  const last = state[state.length - 1];
  if (last && last.kind === "assistant_message") {
    const updated: AssistantMessageItem = {
      ...last,
      text: `${last.text}${chunk}`,
      timestamp,
    };
    return [...state.slice(0, -1), updated];
  }

  if (!hasContent) {
    return state;
  }

  const idSeed = chunk.trim() || chunk;
  const item: AssistantMessageItem = {
    kind: "assistant_message",
    id: createUniqueTimelineId(state, "assistant", idSeed, timestamp),
    text: chunk,
    timestamp,
  };
  return [...state, item];
}

function appendThought(state: StreamItem[], text: string, timestamp: Date): StreamItem[] {
  const { chunk, hasContent } = normalizeChunk(text);
  if (!chunk) {
    return state;
  }

  const last = state[state.length - 1];
  if (last && last.kind === "thought") {
    const updated: ThoughtItem = {
      ...last,
      text: `${last.text}${chunk}`,
      timestamp,
    };
    return [...state.slice(0, -1), updated];
  }

  if (!hasContent) {
    return state;
  }

  const idSeed = chunk.trim() || chunk;
  const item: ThoughtItem = {
    kind: "thought",
    id: createUniqueTimelineId(state, "thought", idSeed, timestamp),
    text: chunk,
    timestamp,
  };
  return [...state, item];
}

function mergeToolCallRaw(existingRaw: unknown, nextRaw: unknown): unknown {
  if (existingRaw === undefined || existingRaw === null) {
    return nextRaw;
  }
  if (nextRaw === undefined || nextRaw === null) {
    return existingRaw;
  }
  if (Array.isArray(existingRaw)) {
    return [...existingRaw, nextRaw];
  }
  return [existingRaw, nextRaw];
}

function computeParsedToolPayload(
  raw: unknown,
  result: unknown
): {
  parsedEdits?: EditEntry[];
  parsedReads?: ReadEntry[];
  parsedCommand?: CommandDetails | null;
} {
  const edits = extractEditEntries(raw, result);
  const reads = extractReadEntries(result, raw);
  const command = extractCommandDetails(raw, result);

  return {
    parsedEdits: edits.length > 0 ? edits : undefined,
    parsedReads: reads.length > 0 ? reads : undefined,
    parsedCommand: command ?? undefined,
  };
}

function normalizeComparableString(value?: string | null): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed.length ? trimmed : null;
}

function findExistingAgentToolCallIndex(
  state: StreamItem[],
  callId: string | null,
  data: AgentToolCallData
): number {
  const normalizedCallId = normalizeComparableString(callId);
  if (normalizedCallId) {
    const existingIndex = state.findIndex(
      (entry) =>
        entry.kind === "tool_call" &&
        entry.payload.source === "agent" &&
        normalizeComparableString(entry.payload.data.callId) === normalizedCallId
    );
    if (existingIndex >= 0) {
      return existingIndex;
    }
  }

  const fallbackCandidates: Array<{ index: number; item: AgentToolCallItem }> = [];
  const metadataMatches: Array<{ index: number; item: AgentToolCallItem }> = [];
  for (let i = 0; i < state.length; i += 1) {
    const entry = state[i];
    if (entry.kind !== "tool_call" || entry.payload.source !== "agent") {
      continue;
    }
    const payload = entry.payload.data;
    const providerMatches =
      payload.provider === data.provider &&
      payload.server === data.server &&
      payload.tool === data.tool;
    if (providerMatches) {
      metadataMatches.push({ index: i, item: entry as AgentToolCallItem });
    }
    if (payload.callId) {
      continue;
    }
    if (payload.status !== "executing") {
      continue;
    }
    if (providerMatches) {
      fallbackCandidates.push({ index: i, item: entry as AgentToolCallItem });
    }
  }

  const normalizedDisplayName = normalizeComparableString(data.displayName);
  const normalizedKind = normalizeComparableString(data.kind);

  const filterByComparableField = (
    candidates: Array<{ index: number; item: AgentToolCallItem }>,
    selector: (entry: AgentToolCallItem) => string | null,
    value: string | null
  ): Array<{ index: number; item: AgentToolCallItem }> => {
    if (!value) {
      return candidates;
    }
    const matches = candidates.filter((candidate) => selector(candidate.item) === value);
    if (matches.length === 1) {
      return matches;
    }
    return matches.length > 0 ? matches : candidates;
  };

  const byDisplayName = filterByComparableField(
    fallbackCandidates,
    (entry) => normalizeComparableString(entry.payload.data.displayName),
    normalizedDisplayName
  );

  const selectCandidate = (
    candidates: Array<{ index: number; item: AgentToolCallItem }>
  ): number => {
    const byDisplayName = filterByComparableField(
      candidates,
      (entry) => normalizeComparableString(entry.payload.data.displayName),
      normalizedDisplayName
    );

    const byKind = filterByComparableField(
      byDisplayName,
      (entry) => normalizeComparableString(entry.payload.data.kind),
      normalizedKind
    );

    return byKind[0]?.index ?? -1;
  };

  if (fallbackCandidates.length) {
    return selectCandidate(fallbackCandidates);
  }

  // If this update still lacks a call id, fall back to metadata matches (e.g. replayed hydration events)
  if (!normalizedCallId && metadataMatches.length) {
    return selectCandidate(metadataMatches);
  }

  return -1;
}

function appendAgentToolCall(
  state: StreamItem[],
  data: AgentToolCallData,
  timestamp: Date
): StreamItem[] {
  const normalizedStatus = normalizeToolCallStatus(
    data.status,
    data.result,
    data.error,
    data.raw
  );
  const callId = data.callId ?? extractToolCallId(data.raw);

  const payloadData: AgentToolCallData = {
    ...data,
    status: normalizedStatus,
    callId: callId ?? data.callId,
  };

  const existingIndex = findExistingAgentToolCallIndex(state, callId, payloadData);

  if (existingIndex >= 0) {
    const next = [...state];
    const existing = next[existingIndex] as AgentToolCallItem;
    const mergedRaw = mergeToolCallRaw(existing.payload.data.raw, payloadData.raw);
    const mergedResult =
      payloadData.result !== undefined
        ? payloadData.result
        : existing.payload.data.result;
    const mergedError =
      payloadData.error !== undefined
        ? payloadData.error
        : existing.payload.data.error;
    const mergedStatus = mergeToolCallStatus(
      existing.payload.data.status,
      payloadData.status ?? existing.payload.data.status ?? "executing"
    );
    const parsed = computeParsedToolPayload(mergedRaw, mergedResult);
    next[existingIndex] = {
      ...existing,
      timestamp,
      payload: {
        source: "agent",
        data: {
          ...existing.payload.data,
          ...payloadData,
          status: mergedStatus,
          raw: mergedRaw,
          result: mergedResult,
          error: mergedError,
          displayName: payloadData.displayName ?? existing.payload.data.displayName,
          kind: payloadData.kind ?? existing.payload.data.kind,
          callId: payloadData.callId ?? existing.payload.data.callId,
          parsedEdits: parsed.parsedEdits ?? existing.payload.data.parsedEdits,
          parsedReads: parsed.parsedReads ?? existing.payload.data.parsedReads,
          parsedCommand: parsed.parsedCommand ?? existing.payload.data.parsedCommand,
        },
      },
    };
    return next;
  }

  const id = callId
    ? `agent_tool_${callId}`
    : createTimelineId(
        "tool",
        `${data.provider}:${data.server}:${data.tool}`,
        timestamp
      );

  const item: ToolCallItem = {
    kind: "tool_call",
    id,
    timestamp,
    payload: {
      source: "agent",
      data: {
        ...payloadData,
        ...computeParsedToolPayload(payloadData.raw, payloadData.result),
      },
    },
  };

  return [...state, item];
}

function isPermissionToolCall(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") {
    return false;
  }
  const candidate = raw as { server?: string; kind?: string };
  return candidate.server === "permission" || candidate.kind === "permission";
}

const FAILED_STATUS_PATTERN = /fail|error|deny|reject|cancel|abort|exception|refus/;
const COMPLETED_STATUS_PATTERN =
  /complete|success|granted|applied|done|resolved|finish|succeed|ok/;

function normalizeStatusString(
  status?: string | null
): "executing" | "completed" | "failed" | null {
  if (!status) {
    return null;
  }
  const normalized = status.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (FAILED_STATUS_PATTERN.test(normalized)) {
    return "failed";
  }
  if (COMPLETED_STATUS_PATTERN.test(normalized)) {
    return "completed";
  }
  return "executing";
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function inferStatusFromRaw(raw: unknown): "completed" | "failed" | null {
  if (!hasValue(raw)) {
    return null;
  }

  const queue: unknown[] = Array.isArray(raw) ? [...raw] : [raw];
  const visited = new Set<object>();

  while (queue.length > 0) {
    const candidate = queue.shift();
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    if (visited.has(candidate as object)) {
      continue;
    }
    visited.add(candidate as object);
    const record = candidate as Record<string, unknown>;

    if (record.is_error === true) {
      return "failed";
    }

    const statusValue = normalizeStatusString(
      typeof record.status === "string" ? record.status : undefined
    );
    if (statusValue === "failed") {
      return "failed";
    }
    if (statusValue === "completed") {
      return "completed";
    }

    if ("error" in record && hasValue(record.error)) {
      return "failed";
    }

    if (typeof record.stderr === "string" && record.stderr.length > 0) {
      return "failed";
    }

    const typeValue =
      typeof record.type === "string" ? record.type.toLowerCase() : "";
    if (typeValue) {
      if (FAILED_STATUS_PATTERN.test(typeValue)) {
        return "failed";
      }
      if (/result|response|output|success/.test(typeValue)) {
        return "completed";
      }
    }

    const exitCode =
      typeof record.exitCode === "number"
        ? record.exitCode
        : typeof record.exit_code === "number"
          ? record.exit_code
          : null;
    if (exitCode !== null) {
      return exitCode === 0 ? "completed" : "failed";
    }

    const successValue =
      typeof record.success === "boolean" ? record.success : null;
    if (successValue !== null) {
      return successValue ? "completed" : "failed";
    }

    for (const value of Object.values(record)) {
      if (typeof value === "object" && value !== null) {
        queue.push(value);
      }
    }
  }

  return null;
}

function normalizeToolCallStatus(
  status?: string,
  result?: unknown,
  error?: unknown,
  raw?: unknown
): "executing" | "completed" | "failed" {
  const normalizedFromStatus = normalizeStatusString(status);
  if (normalizedFromStatus === "failed") {
    return "failed";
  }
  if (normalizedFromStatus === "completed") {
    return "completed";
  }

  if (hasValue(error)) {
    return "failed";
  }
  if (hasValue(result)) {
    return "completed";
  }

  const inferredFromRaw = inferStatusFromRaw(raw);
  if (inferredFromRaw) {
    return inferredFromRaw;
  }

  return normalizedFromStatus ?? "executing";
}

function mergeToolCallStatus(
  existing: "executing" | "completed" | "failed" | undefined,
  incoming: "executing" | "completed" | "failed"
): "executing" | "completed" | "failed" {
  if (existing === "failed" || incoming === "failed") {
    return "failed";
  }
  if (existing === "completed" || incoming === "completed") {
    return "completed";
  }
  return incoming ?? existing ?? "executing";
}

const TOOL_CALL_ID_KEYS = [
  "toolCallId",
  "tool_call_id",
  "callId",
  "call_id",
  "tool_use_id",
  "toolUseId",
];

function extractToolCallId(raw: unknown, depth = 0): string | null {
  if (!raw || depth > 4) {
    return null;
  }
  if (typeof raw === "string" || typeof raw === "number") {
    return null;
  }
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const nested = extractToolCallId(entry, depth + 1);
      if (nested) {
        return nested;
      }
    }
    return null;
  }
  if (typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    for (const key of TOOL_CALL_ID_KEYS) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }
    const idValue = record.id;
    if (typeof idValue === "string" && /tool|call/i.test(idValue)) {
      return idValue;
    }
    for (const value of Object.values(record)) {
      const nested = extractToolCallId(value, depth + 1);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}

function appendActivityLog(state: StreamItem[], entry: ActivityLogItem): StreamItem[] {
  const index = state.findIndex((existing) => existing.id === entry.id);
  if (index >= 0) {
    const next = [...state];
    next[index] = entry;
    return next;
  }
  return [...state, entry];
}

function appendTodoList(
  state: StreamItem[],
  provider: AgentProvider,
  items: TodoEntry[],
  timestamp: Date,
  raw?: unknown
): StreamItem[] {
  const normalizedItems = items.map((item) => ({
    text: item.text,
    completed: Boolean(item.completed),
  }));

  const lastItem = state[state.length - 1];
  if (lastItem && lastItem.kind === "todo_list" && lastItem.provider === provider) {
    const next = [...state];
    const updated: TodoListItem = {
      ...lastItem,
      items: normalizedItems,
      timestamp,
      raw: raw ?? lastItem.raw,
    };
    next[next.length - 1] = updated;
    return next;
  }

  const entry: TodoListItem = {
    kind: "todo_list",
    id: createTimelineId("todo", `${provider}:${JSON.stringify(normalizedItems)}`, timestamp),
    timestamp,
    provider,
    items: normalizedItems,
    raw,
  };

  return [...state, entry];
}

function formatErrorMessage(message: string): string {
  return `Agent error\n${message}`;
}

/**
 * Reduce a single AgentManager stream event into the UI timeline
 */
export function reduceStreamUpdate(
  state: StreamItem[],
  event: AgentStreamEventPayload,
  timestamp: Date
): StreamItem[] {
  switch (event.type) {
    case "timeline": {
      const item = event.item;
      switch (item.type) {
        case "user_message":
          return appendUserMessage(state, item.text, timestamp, item.messageId);
        case "assistant_message":
          return appendAssistantMessage(state, item.text, timestamp);
        case "reasoning":
          return appendThought(state, item.text, timestamp);
        case "tool_call": {
          if (isPermissionToolCall(item)) {
            return state;
          }
          const rawPayload =
            item.raw ?? { input: item.input, output: item.output, error: item.error };
          return appendAgentToolCall(
            state,
            {
              provider: event.provider,
              server: item.server,
              tool: item.tool,
              status: item.status ?? "executing",
              raw: rawPayload,
              callId: item.callId,
              displayName: item.displayName,
              kind: item.kind,
              result: item.output,
              error: item.error,
            },
            timestamp
          );
        }
        case "todo": {
          const items = (item.items ?? []) as TodoEntry[];
          return appendTodoList(state, event.provider, items, timestamp, item.raw);
        }
        case "error": {
          const activity: ActivityLogItem = {
            kind: "activity_log",
            id: createTimelineId("error", item.message ?? "", timestamp),
            timestamp,
            activityType: "error",
            message: formatErrorMessage(item.message ?? "Unknown error"),
            metadata: item.raw ? { raw: item.raw } : undefined,
          };
          return appendActivityLog(state, activity);
        }
        default:
          return state;
      }
    }
    default:
      return state;
  }
}

/**
 * Hydrate stream state from a batch of AgentManager stream events
 */
export function hydrateStreamState(
  events: Array<{ event: AgentStreamEventPayload; timestamp: Date }>
): StreamItem[] {
  return events.reduce<StreamItem[]>((state, { event, timestamp }) => {
    return reduceStreamUpdate(state, event, timestamp);
  }, []);
}
