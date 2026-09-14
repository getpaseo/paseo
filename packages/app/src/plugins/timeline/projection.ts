import type { AgentTimelineItem, ToolCallTimelineItem } from "@getpaseo/protocol/agent-types";
import type { AgentToolCallData, PluginTimelineStreamItem, StreamItem } from "@/types/stream";
import type { TimelineItemTransform } from "./model";

interface ProjectionEntry {
  members: StreamItem[];
  output: StreamItem[];
}

const projectionCache = new WeakMap<TimelineItemTransform, WeakMap<StreamItem, ProjectionEntry>>();

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
    case "notification":
      return item.sourceType === "error"
        ? { type: "error", message: item.message }
        : { type: "notification", level: item.level, message: item.message };
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

function getAssistantBlockGroupId(item: StreamItem): string | undefined {
  return item.kind === "assistant_message" ? item.blockGroupId : undefined;
}

// promoteCompletedAssistantBlocks splits one streaming assistant row into consecutive
// block items sharing a blockGroupId; a transformer must see that row, not each block.
// head and tail are projected separately, so while the row streams its live block is
// grouped on its own and only joins the completed blocks once the head is flushed.
function collectSourceGroup(items: StreamItem[], start: number, first: StreamItem): StreamItem[] {
  const blockGroupId = getAssistantBlockGroupId(first);
  if (blockGroupId === undefined) return [first];
  let end = start + 1;
  while (end < items.length) {
    const next = items[end];
    if (!next || getAssistantBlockGroupId(next) !== blockGroupId) break;
    end += 1;
  }
  return items.slice(start, end);
}

// splitMarkdownBlocks drops the blank lines between blocks, so the join restores the
// markdown structure but not the exact number of separator lines.
function joinAssistantBlocks(members: StreamItem[]): string {
  const texts: string[] = [];
  for (const member of members) {
    if (member.kind === "assistant_message") texts.push(member.text);
  }
  return texts.join("\n\n");
}

function sameMembers(left: StreamItem[], right: StreamItem[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function transformSourceGroup(
  members: StreamItem[],
  first: StreamItem,
  transformTimelineItem: TimelineItemTransform,
): StreamItem[] {
  const source = sourceTimelineItem(first);
  if (!source) return members;
  const item =
    source.type === "assistant_message" && members.length > 1
      ? { ...source, text: joinAssistantBlocks(members) }
      : source;
  const isStreamingThought = first.kind === "thought" && first.status === "loading";
  const isStreamingToolCall =
    first.kind === "tool_call" &&
    first.payload.source === "agent" &&
    first.payload.data.status === "running";
  const phase = isStreamingThought || isStreamingToolCall ? "streaming" : "complete";
  const transformed = transformTimelineItem({
    item: cloneAndFreeze(item),
    phase,
    sourceId: first.id,
  });
  if (transformed === undefined) return members;
  return transformed.map((pluginItem) => {
    const projected: PluginTimelineStreamItem = {
      kind: "plugin",
      id: `${pluginItem.pluginId}/${pluginItem.id}`,
      timestamp: first.timestamp,
      pluginId: pluginItem.pluginId,
      pluginItemId: pluginItem.id,
      itemKind: pluginItem.kind,
      version: pluginItem.version,
      data: pluginItem.data,
    };
    if (first.timelineCursor) projected.timelineCursor = first.timelineCursor;
    if (first.turnId) projected.turnId = first.turnId;
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
  const projected: StreamItem[] = [];
  for (let index = 0; index < items.length; ) {
    const first = items[index];
    if (!first) break;
    const members = collectSourceGroup(items, index, first);
    index += members.length;
    // a group's cache key is its last block: the blocks before it are immutable once
    // promoted, and a newly promoted block naturally starts a fresh entry
    const last = members[members.length - 1] ?? first;
    let entry = bySource.get(last);
    if (!entry || !sameMembers(entry.members, members)) {
      entry = { members, output: transformSourceGroup(members, first, transformTimelineItem) };
      bySource.set(last, entry);
    }
    changed = changed || entry.output !== entry.members;
    projected.push(...entry.output);
  }
  return changed ? projected : items;
}
