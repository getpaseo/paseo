import type { AgentTimelineItem, ToolCallTimelineItem } from "@getpaseo/protocol/agent-types";
import type { AgentToolCallData, PluginTimelineStreamItem, StreamItem } from "@/types/stream";
import type { TimelineItemTransform } from "./model";

const projectionCache = new WeakMap<TimelineItemTransform, WeakMap<StreamItem, StreamItem[]>>();

function cloneAndFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => cloneAndFreeze(entry))) as T;
  }
  if (value !== null && typeof value === "object") {
    return Object.freeze(
      Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneAndFreeze(entry)])),
    ) as T;
  }
  return value;
}

function sourceToolCallTimelineItem(data: AgentToolCallData): ToolCallTimelineItem {
  const { callId, name, status, error, detail, metadata } = data;
  const base = {
    type: "tool_call" as const,
    callId,
    name,
    detail,
    ...(metadata ? { metadata } : {}),
  };
  switch (status) {
    case "running":
    case "completed":
    case "canceled":
      return { ...base, status, error: null };
    case "failed":
      return { ...base, status, error };
  }
}

function sourceTimelineItem(item: StreamItem): AgentTimelineItem | null {
  switch (item.kind) {
    case "user_message":
      return {
        type: "user_message",
        text: item.text,
        ...(item.messageId ? { messageId: item.messageId } : {}),
        ...(item.clientMessageId ? { clientMessageId: item.clientMessageId } : {}),
      };
    case "assistant_message":
      return {
        type: "assistant_message",
        text: item.text,
        ...(item.messageId ? { messageId: item.messageId } : {}),
      };
    case "thought":
      return { type: "reasoning", text: item.text };
    case "tool_call": {
      if (item.payload.source !== "agent") return null;
      return sourceToolCallTimelineItem(item.payload.data);
    }
    case "todo_list":
      return { type: "todo", items: item.items };
    case "activity_log":
      return item.activityType === "error" ? { type: "error", message: item.message } : null;
    case "compaction":
      return {
        type: "compaction",
        status: item.status,
        ...(item.trigger ? { trigger: item.trigger } : {}),
        ...(item.preTokens !== undefined ? { preTokens: item.preTokens } : {}),
      };
    case "plugin":
      return null;
  }
}

function transformSourceItem(
  item: StreamItem,
  transformTimelineItem: TimelineItemTransform,
): StreamItem[] {
  const source = sourceTimelineItem(item);
  if (!source) return [item];
  const isStreamingThought = item.kind === "thought" && item.status === "loading";
  const isStreamingToolCall =
    item.kind === "tool_call" &&
    item.payload.source === "agent" &&
    item.payload.data.status === "running";
  const phase = isStreamingThought || isStreamingToolCall ? "streaming" : "complete";
  const transformed = transformTimelineItem({
    item: cloneAndFreeze(source),
    phase,
    sourceId: item.id,
  });
  if (transformed === undefined) return [item];
  return transformed.map((pluginItem) => {
    const projected: PluginTimelineStreamItem = {
      kind: "plugin",
      id: `${pluginItem.pluginId}/${pluginItem.id}`,
      timestamp: item.timestamp,
      pluginId: pluginItem.pluginId,
      pluginItemId: pluginItem.id,
      itemKind: pluginItem.kind,
      version: pluginItem.version,
      data: pluginItem.data,
    };
    if (item.timelineCursor) projected.timelineCursor = item.timelineCursor;
    if (item.turnId) projected.turnId = item.turnId;
    return projected;
  });
}

export function projectPluginTimelineItems(
  items: StreamItem[],
  transformTimelineItem: TimelineItemTransform | undefined,
): StreamItem[] {
  if (!transformTimelineItem) return items;
  let bySource = projectionCache.get(transformTimelineItem);
  if (!bySource) {
    bySource = new WeakMap();
    projectionCache.set(transformTimelineItem, bySource);
  }
  let changed = false;
  const projected = items.flatMap((item) => {
    const cached = bySource.get(item);
    if (cached) {
      changed = changed || cached.length !== 1 || cached[0] !== item;
      return cached;
    }
    const output = transformSourceItem(item, transformTimelineItem);
    bySource.set(item, output);
    changed = changed || output.length !== 1 || output[0] !== item;
    return output;
  });
  return changed ? projected : items;
}
