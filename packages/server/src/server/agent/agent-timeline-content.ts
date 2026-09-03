import type { AgentTaskItem, AgentTimelineItem, ToolCallTimelineItem } from "./agent-sdk-types.js";
import type { JsonValue } from "@getpaseo/protocol/agent-types";

const TOOL_CALL_CONTENT_MAX_LENGTH = 64 * 1024;
const TIMELINE_TEXT_MAX_BYTES = 64 * 1024;
const TIMELINE_IDENTIFIER_MAX_BYTES = 4 * 1024;
const TIMELINE_TASK_TEXT_MAX_BYTES = 512;
const TIMELINE_TASK_IDENTIFIER_MAX_BYTES = 256;
const TIMELINE_TASK_LIMIT = 8;
const TIMELINE_TRUNCATION_NOTICE = "\n\n[truncated to fit timeline storage]";
export const AGENT_TIMELINE_ITEM_MAX_BYTES = 128 * 1024;
export const PLUGIN_TIMELINE_DATA_MAX_BYTES = 64 * 1024;

export function assertPluginTimelineDataSize(data: JsonValue): void {
  const dataBytes = Buffer.byteLength(JSON.stringify(data), "utf8");
  if (dataBytes > PLUGIN_TIMELINE_DATA_MAX_BYTES) {
    throw new Error(`Plugin timeline item data exceeds ${PLUGIN_TIMELINE_DATA_MAX_BYTES} bytes`);
  }
}

function limitFailedShellError(item: AgentTimelineItem): AgentTimelineItem {
  if (
    item.type !== "tool_call" ||
    item.detail.type !== "shell" ||
    item.status !== "failed" ||
    typeof item.error !== "object" ||
    item.error === null ||
    !("content" in item.error) ||
    typeof item.error.content !== "string" ||
    item.error.content.length <= TOOL_CALL_CONTENT_MAX_LENGTH
  ) {
    return item;
  }
  return {
    ...item,
    error: {
      ...item.error,
      content: item.error.content.slice(0, TOOL_CALL_CONTENT_MAX_LENGTH),
    },
  };
}

function limitPlainText(item: AgentTimelineItem): AgentTimelineItem {
  if (
    item.type !== "tool_call" ||
    item.detail.type !== "plain_text" ||
    typeof item.detail.text !== "string" ||
    item.detail.text.length <= TOOL_CALL_CONTENT_MAX_LENGTH
  ) {
    return item;
  }
  return {
    ...item,
    detail: {
      ...item.detail,
      text: item.detail.text.slice(0, TOOL_CALL_CONTENT_MAX_LENGTH),
    },
  };
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function truncateUtf8(text: string, maxBytes: number, suffix = TIMELINE_TRUNCATION_NOTICE): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const contentBudget = Math.max(0, maxBytes - suffixBytes);
  let low = 0;
  let high = text.length;
  while (low < high) {
    const candidate = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, candidate), "utf8") <= contentBudget) {
      low = candidate;
    } else {
      high = candidate - 1;
    }
  }
  if (
    low > 0 &&
    low < text.length &&
    /[\uD800-\uDBFF]/.test(text[low - 1] ?? "") &&
    /[\uDC00-\uDFFF]/.test(text[low] ?? "")
  ) {
    low -= 1;
  }
  return `${text.slice(0, low)}${suffix}`;
}

function truncateIdentifier(value: string): string {
  return truncateUtf8(value, TIMELINE_IDENTIFIER_MAX_BYTES, "");
}

function rebuildOversizedToolCall(
  item: ToolCallTimelineItem,
  options: { callId: string; name: string; label?: string },
): ToolCallTimelineItem {
  const base = {
    type: "tool_call" as const,
    callId: options.callId,
    name: options.name,
    detail: {
      type: "plain_text" as const,
      ...(options.label ? { label: options.label } : {}),
      text: TIMELINE_TRUNCATION_NOTICE.trim(),
    },
  };
  switch (item.status) {
    case "running":
      return { ...base, status: item.status, error: null };
    case "completed":
      return { ...base, status: item.status, error: null };
    case "failed":
      return {
        ...base,
        status: item.status,
        error: { message: TIMELINE_TRUNCATION_NOTICE.trim() },
      };
    case "canceled":
      return { ...base, status: item.status, error: null };
  }
}

function summarizeOversizedToolCall(item: ToolCallTimelineItem): ToolCallTimelineItem {
  return rebuildOversizedToolCall(item, {
    callId: truncateIdentifier(item.callId),
    name: truncateIdentifier(item.name),
    label: truncateIdentifier(item.name),
  });
}

function summarizeTimelineTask(task: AgentTaskItem): AgentTaskItem {
  const summarized: AgentTaskItem = {
    text: truncateUtf8(task.text, TIMELINE_TASK_TEXT_MAX_BYTES),
    completed: task.completed,
  };
  if (task.id) {
    summarized.id = truncateUtf8(task.id, TIMELINE_TASK_IDENTIFIER_MAX_BYTES, "");
  }
  if (task.status) {
    summarized.status = task.status;
  }
  if (task.activeForm) {
    summarized.activeForm = truncateUtf8(task.activeForm, TIMELINE_TASK_IDENTIFIER_MAX_BYTES, "");
  }
  return summarized;
}

function summarizeOversizedTimelineItem(item: AgentTimelineItem): AgentTimelineItem {
  switch (item.type) {
    case "user_message":
      return {
        type: item.type,
        text: truncateUtf8(item.text, TIMELINE_TEXT_MAX_BYTES),
        ...(item.messageId ? { messageId: truncateIdentifier(item.messageId) } : {}),
        ...(item.clientMessageId
          ? { clientMessageId: truncateIdentifier(item.clientMessageId) }
          : {}),
      };
    case "assistant_message":
      return {
        type: item.type,
        text: truncateUtf8(item.text, TIMELINE_TEXT_MAX_BYTES),
        ...(item.messageId ? { messageId: truncateIdentifier(item.messageId) } : {}),
      };
    case "reasoning":
      return { type: item.type, text: truncateUtf8(item.text, TIMELINE_TEXT_MAX_BYTES) };
    case "error":
      return { type: item.type, message: truncateUtf8(item.message, TIMELINE_TEXT_MAX_BYTES) };
    case "todo":
      return {
        type: item.type,
        items: item.items.slice(0, TIMELINE_TASK_LIMIT).map(summarizeTimelineTask),
      };
    case "tool_call":
      return summarizeOversizedToolCall(item);
    case "compaction":
      return {
        type: item.type,
        status: item.status,
        ...(item.trigger ? { trigger: item.trigger } : {}),
        ...(item.preTokens === undefined ? {} : { preTokens: item.preTokens }),
      };
    case "plugin":
      return {
        type: item.type,
        id: truncateIdentifier(item.id),
        pluginId: truncateIdentifier(item.pluginId),
        kind: truncateIdentifier(item.kind),
        version: item.version,
        data: { truncated: true },
      };
  }
}

function minimalTimelineItem(item: AgentTimelineItem): AgentTimelineItem {
  const notice = TIMELINE_TRUNCATION_NOTICE.trim();
  switch (item.type) {
    case "user_message":
      return { type: item.type, text: notice };
    case "assistant_message":
      return { type: item.type, text: notice };
    case "reasoning":
      return { type: item.type, text: notice };
    case "error":
      return { type: item.type, message: notice };
    case "todo":
      return { type: item.type, items: [] };
    case "tool_call":
      return rebuildOversizedToolCall(item, {
        callId: "oversized-tool-call",
        name: "tool",
      });
    case "compaction":
      return { type: item.type, status: item.status };
    case "plugin":
      return {
        type: item.type,
        id: "oversized-plugin-item",
        pluginId: "unknown",
        kind: "truncated",
        version: item.version,
        data: { truncated: true },
      };
  }
}

function limitAgentTimelineItemSize(item: AgentTimelineItem): AgentTimelineItem {
  if (serializedBytes(item) <= AGENT_TIMELINE_ITEM_MAX_BYTES) {
    return item;
  }
  const summarized = summarizeOversizedTimelineItem(item);
  return serializedBytes(summarized) <= AGENT_TIMELINE_ITEM_MAX_BYTES
    ? summarized
    : minimalTimelineItem(item);
}

export function limitAgentTimelineItemContent(item: AgentTimelineItem): AgentTimelineItem {
  item = limitFailedShellError(item);
  item = limitPlainText(item);
  if (
    item.type === "tool_call" &&
    item.detail.type === "shell" &&
    typeof item.detail.output === "string" &&
    item.detail.output.length > TOOL_CALL_CONTENT_MAX_LENGTH
  ) {
    item = {
      ...item,
      detail: {
        ...item.detail,
        output: item.detail.output.slice(0, TOOL_CALL_CONTENT_MAX_LENGTH),
      },
    };
  }
  return limitAgentTimelineItemSize(item);
}
