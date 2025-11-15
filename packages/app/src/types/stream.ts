import type { AgentProvider } from "@server/server/agent/agent-sdk-types";
import type { AgentStreamEventPayload } from "@server/server/messages";

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

export type StreamItem =
  | UserMessageItem
  | AssistantMessageItem
  | ThoughtItem
  | ToolCallItem
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

type TodoEntry = { text: string; completed: boolean };

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

  const entryId = messageId ?? createTimelineId("user", chunk.trim() || chunk, timestamp);
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
    id: createTimelineId("assistant", idSeed, timestamp),
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
    id: createTimelineId("thought", idSeed, timestamp),
    text: chunk,
    timestamp,
  };
  return [...state, item];
}

function appendAgentToolCall(
  state: StreamItem[],
  data: AgentToolCallData,
  timestamp: Date
): StreamItem[] {
  const normalizedStatus = normalizeToolCallStatus(data.status);
  const callId = data.callId ?? extractToolCallId(data.raw);

  const payloadData: AgentToolCallData = {
    ...data,
    status: normalizedStatus,
    callId: callId ?? data.callId,
  };

  if (callId) {
    const existingIndex = state.findIndex(
      (entry) =>
        entry.kind === "tool_call" &&
        entry.payload.source === "agent" &&
        entry.payload.data.callId === callId
    );

    if (existingIndex >= 0) {
      const next = [...state];
      const existing = next[existingIndex] as AgentToolCallItem;
      const mergedRaw =
        existing.payload.data.raw !== undefined && existing.payload.data.raw !== null
          ? existing.payload.data.raw
          : payloadData.raw;
      next[existingIndex] = {
        ...existing,
        timestamp,
        payload: {
          source: "agent",
          data: {
            ...existing.payload.data,
            ...payloadData,
            raw: mergedRaw,
            displayName: payloadData.displayName ?? existing.payload.data.displayName,
            kind: payloadData.kind ?? existing.payload.data.kind,
            callId,
          },
        },
      };
      return next;
    }
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
      data: payloadData,
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

function normalizeToolCallStatus(status?: string): "executing" | "completed" | "failed" {
  if (!status) {
    return "executing";
  }
  const normalized = status.toLowerCase();
  if (/fail|error|deny|reject|cancel/.test(normalized)) {
    return "failed";
  }
  if (/complete|success|granted|applied|done|resolved/.test(normalized)) {
    return "completed";
  }
  return "executing";
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

function formatTodoMessage(items: TodoEntry[]): string {
  if (!items.length) {
    return "Todo list";
  }
  const header = "Todo list";
  const entries = items.map((item) => `• [${item.completed ? "x" : " "}] ${item.text}`);
  return [header, ...entries].join("\n");
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
          const activity: ActivityLogItem = {
            kind: "activity_log",
            id: createTimelineId("todo", JSON.stringify(items), timestamp),
            timestamp,
            activityType: "system",
            message: formatTodoMessage(items),
            metadata: items.length ? { items } : undefined,
          };
          return appendActivityLog(state, activity);
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
