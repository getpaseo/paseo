import type { StreamItem, ToolCallItem } from "@/types/stream";
import { buildToolCallDisplayModel } from "@/utils/tool-call-display";
import {
  findMountedWindowStart,
  getWebMountedRecentStreamItems,
  getWebPartialVirtualizationThreshold,
} from "./agent-stream-web-virtualization";

export type AgentStreamSearchSource = "historyVirtualized" | "historyMounted" | "liveHead";

export interface AgentStreamSearchTextSegment {
  key: string;
  text: string;
}

export interface AgentStreamSearchEntry {
  item: StreamItem;
  source: AgentStreamSearchSource;
  index: number;
  text: string;
  segments: AgentStreamSearchTextSegment[];
}

export interface AgentStreamSearchMatch {
  id: string;
  entry: AgentStreamSearchEntry;
  segmentKey: string;
  occurrenceIndex: number;
  start: number;
  end: number;
}

export interface AgentStreamSearchModel {
  entries: AgentStreamSearchEntry[];
  segments: {
    historyVirtualized: AgentStreamSearchEntry[];
    historyMounted: AgentStreamSearchEntry[];
    liveHead: AgentStreamSearchEntry[];
  };
}

export interface BuildAgentStreamSearchModelInput {
  platform: "web" | "native";
  isMobileBreakpoint: boolean;
  streamItems: StreamItem[];
  streamHead: StreamItem[];
  optimisticItems?: StreamItem[];
  cwd?: string;
}

export interface FindAgentStreamSearchMatchesInput {
  model: AgentStreamSearchModel;
  query: string;
}

function compactText(parts: Array<string | undefined>): string {
  return parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join("\n");
}

function getToolCallSearchableSegments(
  item: ToolCallItem,
  cwd: string | undefined,
): AgentStreamSearchTextSegment[] {
  if (item.payload.source === "agent") {
    const { data } = item.payload;
    if (
      data.name === "speak" &&
      data.detail.type === "unknown" &&
      typeof data.detail.input === "string" &&
      data.detail.input.trim()
    ) {
      return [{ key: "text", text: data.detail.input }];
    }

    const display = buildToolCallDisplayModel({
      name: data.name,
      status: data.status,
      error: data.error,
      detail: data.detail,
      metadata: data.metadata,
      cwd,
    });
    const visibleText = compactText([
      display.displayName,
      display.summary,
      data.detail.type === "plan" ? data.detail.text : undefined,
      display.errorText,
    ]);
    return visibleText ? [{ key: "tool", text: visibleText }] : [];
  }

  const { data } = item.payload;
  const display = buildToolCallDisplayModel({
    name: data.toolName,
    status: data.status === "executing" ? "running" : data.status,
    error: data.error,
    detail: {
      type: "unknown",
      input: data.arguments,
      output: data.result ?? null,
    },
    cwd,
  });
  const visibleText = compactText([display.displayName, display.summary, display.errorText]);
  return visibleText ? [{ key: "tool", text: visibleText }] : [];
}

export function getAgentStreamItemSearchableSegments(
  item: StreamItem,
  options: { cwd?: string } = {},
): AgentStreamSearchTextSegment[] {
  switch (item.kind) {
    case "user_message":
    case "assistant_message":
    case "thought":
      return item.text ? [{ key: "text", text: item.text }] : [];
    case "activity_log":
      return item.message ? [{ key: "text", text: item.message }] : [];
    case "todo_list":
      return item.items.map((todo, index) => ({
        key: `todo:${index}`,
        text: todo.text,
      }));
    case "tool_call":
      return getToolCallSearchableSegments(item, options.cwd);
    case "compaction":
      return [];
  }
}

export function getAgentStreamItemSearchableText(
  item: StreamItem,
  options: { cwd?: string } = {},
): string {
  return getAgentStreamItemSearchableSegments(item, options)
    .map((segment) => segment.text)
    .filter((text) => text.length > 0)
    .join("\n");
}

function mergeOptimisticItems(input: {
  streamItems: StreamItem[];
  optimisticItems: StreamItem[] | undefined;
}): StreamItem[] {
  if (!input.optimisticItems || input.optimisticItems.length === 0) {
    return input.streamItems;
  }
  const committedIds = new Set(input.streamItems.map((item) => item.id));
  const pendingOptimisticItems = input.optimisticItems.filter((item) => !committedIds.has(item.id));
  if (pendingOptimisticItems.length === 0) {
    return input.streamItems;
  }
  return [...pendingOptimisticItems, ...input.streamItems];
}

function buildEntries(input: {
  items: StreamItem[];
  source: AgentStreamSearchSource;
  startIndex: number;
  cwd: string | undefined;
}): AgentStreamSearchEntry[] {
  return input.items.map((item, offset) => {
    const segments = getAgentStreamItemSearchableSegments(item, { cwd: input.cwd });
    return {
      item,
      source: input.source,
      index: input.startIndex + offset,
      text: segments.map((segment) => segment.text).join("\n"),
      segments,
    };
  });
}

function orderStreamItems(input: {
  items: StreamItem[];
  platform: "web" | "native";
}): StreamItem[] {
  return input.platform === "native" ? [...input.items].toReversed() : input.items;
}

function splitOrderedHistory(input: {
  orderedTail: StreamItem[];
  platform: "web" | "native";
  isMobileBreakpoint: boolean;
}): {
  historyVirtualizedItems: StreamItem[];
  historyMountedItems: StreamItem[];
} {
  const shouldSplitHistory =
    input.platform === "web" &&
    !input.isMobileBreakpoint &&
    input.orderedTail.length > getWebPartialVirtualizationThreshold();
  if (!shouldSplitHistory) {
    return {
      historyVirtualizedItems: [],
      historyMountedItems: input.orderedTail,
    };
  }
  const mountedWindowStart = findMountedWindowStart({
    items: input.orderedTail,
    minMountedCount: getWebMountedRecentStreamItems(),
  });
  return {
    historyVirtualizedItems: input.orderedTail.slice(0, mountedWindowStart),
    historyMountedItems: input.orderedTail.slice(mountedWindowStart),
  };
}

export function buildAgentStreamSearchModel(
  input: BuildAgentStreamSearchModelInput,
): AgentStreamSearchModel {
  const tail = mergeOptimisticItems({
    streamItems: input.streamItems,
    optimisticItems: input.optimisticItems,
  });
  const orderedTail = orderStreamItems({
    items: tail,
    platform: input.platform,
  });
  const orderedHead = orderStreamItems({
    items: input.streamHead,
    platform: input.platform,
  });
  const splitHistory = splitOrderedHistory({
    orderedTail,
    platform: input.platform,
    isMobileBreakpoint: input.isMobileBreakpoint,
  });
  const historyVirtualized = buildEntries({
    items: splitHistory.historyVirtualizedItems,
    source: "historyVirtualized",
    startIndex: 0,
    cwd: input.cwd,
  });
  const historyMounted = buildEntries({
    items: splitHistory.historyMountedItems,
    source: "historyMounted",
    startIndex: historyVirtualized.length,
    cwd: input.cwd,
  });
  const liveHead = buildEntries({
    items: orderedHead,
    source: "liveHead",
    startIndex: historyVirtualized.length + historyMounted.length,
    cwd: input.cwd,
  });
  return {
    entries: [...historyVirtualized, ...historyMounted, ...liveHead],
    segments: {
      historyVirtualized,
      historyMounted,
      liveHead,
    },
  };
}

export function findAgentStreamSearchMatches(
  input: FindAgentStreamSearchMatchesInput,
): AgentStreamSearchMatch[] {
  const normalizedQuery = input.query.toLocaleLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  const matches: AgentStreamSearchMatch[] = [];
  for (const entry of input.model.entries) {
    for (const segment of entry.segments) {
      const normalizedText = segment.text.toLocaleLowerCase();
      let occurrenceIndex = 0;
      let fromIndex = 0;
      while (fromIndex <= normalizedText.length) {
        const start = normalizedText.indexOf(normalizedQuery, fromIndex);
        if (start < 0) {
          break;
        }
        const end = start + input.query.length;
        matches.push({
          id: `${entry.item.id}:${segment.key}:${occurrenceIndex}:${start}:${end}`,
          entry,
          segmentKey: segment.key,
          occurrenceIndex,
          start,
          end,
        });
        occurrenceIndex += 1;
        fromIndex = end;
      }
    }
  }
  return matches;
}
