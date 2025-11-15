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

type ActivityLogType = "system" | "info" | "success" | "error";

export interface ActivityLogItem {
  kind: "activity_log";
  id: string;
  timestamp: Date;
  activityType: ActivityLogType;
  message: string;
  metadata?: Record<string, unknown>;
}

type FileChangeEntry = { path: string; kind: string };
type TodoEntry = { text: string; completed: boolean };

function appendAssistantMessage(state: StreamItem[], text: string, timestamp: Date): StreamItem[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return state;
  }

  const last = state[state.length - 1];
  if (last && last.kind === "assistant_message") {
    const updated: AssistantMessageItem = {
      ...last,
      text: `${last.text}${trimmed}`,
      timestamp,
    };
    return [...state.slice(0, -1), updated];
  }

  const item: AssistantMessageItem = {
    kind: "assistant_message",
    id: createTimelineId("assistant", trimmed, timestamp),
    text: trimmed,
    timestamp,
  };
  return [...state, item];
}

function appendThought(state: StreamItem[], text: string, timestamp: Date): StreamItem[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return state;
  }

  const last = state[state.length - 1];
  if (last && last.kind === "thought") {
    const updated: ThoughtItem = {
      ...last,
      text: `${last.text}${trimmed}`,
      timestamp,
    };
    return [...state.slice(0, -1), updated];
  }

  const item: ThoughtItem = {
    kind: "thought",
    id: createTimelineId("thought", trimmed, timestamp),
    text: trimmed,
    timestamp,
  };
  return [...state, item];
}

function appendAgentToolCall(
  state: StreamItem[],
  data: AgentToolCallData,
  timestamp: Date
): StreamItem[] {
  const status = data.status;
  const id = createTimelineId(
    "tool",
    `${data.provider}:${data.server}:${data.tool}:${status}`,
    timestamp
  );

  const normalizedStatus: "executing" | "completed" | "failed" =
    status === "completed"
      ? "completed"
      : status === "failed"
      ? "failed"
      : "executing";

  const item: ToolCallItem = {
    kind: "tool_call",
    id,
    timestamp,
    payload: {
      source: "agent",
      data: { ...data, status: normalizedStatus },
    },
  };

  // Replace existing entry with same ID if present
  const index = state.findIndex((entry) => entry.id === id);
  if (index >= 0) {
    const next = [...state];
    next[index] = item;
    return next;
  }

  return [...state, item];
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

function toHumanLabel(value?: string): string {
  if (!value) {
    return "";
  }
  return value
    .replace(/[_-]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function describeCommandStatus(status?: string): ActivityLogType {
  if (!status) {
    return "info";
  }
  const normalized = status.toLowerCase();
  if (
    normalized.includes("fail") ||
    normalized.includes("error") ||
    normalized.includes("deny") ||
    normalized.includes("reject")
  ) {
    return "error";
  }
  if (
    normalized.includes("success") ||
    normalized.includes("complete") ||
    normalized.includes("granted") ||
    normalized.includes("applied")
  ) {
    return "success";
  }
  return "info";
}

function formatCommandMessage(command: string, status?: string): string {
  const label = status ? toHumanLabel(status) : null;
  const header = label ? `Command (${label})` : "Command";
  return `${header}\n${command}`;
}

function formatFileChangeMessage(files: FileChangeEntry[]): string {
  if (!files.length) {
    return "File changes";
  }
  const header = files.length === 1 ? "File change" : `${files.length} file changes`;
  const entries = files.map((file) => {
    const kindLabel = file.kind ? toHumanLabel(file.kind) : "";
    return `• ${kindLabel ? `[${kindLabel}] ` : ""}${file.path}`;
  });
  return [header, ...entries].join("\n");
}

function formatWebSearchMessage(query: string): string {
  return `Web search\n"${query.trim()}"`;
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
        case "assistant_message":
          return appendAssistantMessage(state, item.text, timestamp);
        case "reasoning":
          return appendThought(state, item.text, timestamp);
        case "mcp_tool":
          return appendAgentToolCall(
            state,
            {
              provider: event.provider,
              server: item.server,
              tool: item.tool,
              status: item.status,
              raw: item.raw,
            },
            timestamp
          );
        case "command": {
          const activity: ActivityLogItem = {
            kind: "activity_log",
            id: createTimelineId("command", `${item.command}:${item.status ?? ""}`, timestamp),
            timestamp,
            activityType: describeCommandStatus(item.status),
            message: formatCommandMessage(item.command, item.status),
            metadata: item.raw ? { raw: item.raw } : undefined,
          };
          return appendActivityLog(state, activity);
        }
        case "file_change": {
          const files = (item.files ?? []) as FileChangeEntry[];
          const activity: ActivityLogItem = {
            kind: "activity_log",
            id: createTimelineId("file_change", JSON.stringify(files), timestamp),
            timestamp,
            activityType: "info",
            message: formatFileChangeMessage(files),
            metadata: files.length ? { files } : undefined,
          };
          return appendActivityLog(state, activity);
        }
        case "web_search": {
          const activity: ActivityLogItem = {
            kind: "activity_log",
            id: createTimelineId("web_search", item.query ?? "", timestamp),
            timestamp,
            activityType: "info",
            message: formatWebSearchMessage(item.query ?? ""),
            metadata: item.raw ? { raw: item.raw } : { query: item.query },
          };
          return appendActivityLog(state, activity);
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
