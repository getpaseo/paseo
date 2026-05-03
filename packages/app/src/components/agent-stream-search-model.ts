import type { StreamItem } from "@/types/stream";
import {
  findMountedWindowStart,
  getWebMountedRecentStreamItems,
  getWebPartialVirtualizationThreshold,
} from "./agent-stream-web-virtualization";

type AgentStreamSearchSource = "historyVirtualized" | "historyMounted" | "liveHead";

interface AgentStreamSearchTextSegment {
  key: string;
  text: string;
  startOffset: number;
}

interface AgentStreamSearchEntry {
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

interface AgentStreamSearchModel {
  entries: AgentStreamSearchEntry[];
  segments: {
    historyVirtualized: AgentStreamSearchEntry[];
    historyMounted: AgentStreamSearchEntry[];
    liveHead: AgentStreamSearchEntry[];
  };
}

interface BuildAgentStreamSearchModelInput {
  platform: "web" | "native";
  isMobileBreakpoint: boolean;
  streamItems: StreamItem[];
  streamHead: StreamItem[];
  optimisticItems?: StreamItem[];
  cwd?: string;
}

interface FindAgentStreamSearchMatchesInput {
  model: AgentStreamSearchModel;
  query: string;
}

function getFenceDelimiter(line: string): string | null {
  const match = /^( {0,3})(`{3,}|~{3,})/.exec(line);
  return match?.[2] ?? null;
}

function getMessageSearchableSegments(text: string): AgentStreamSearchTextSegment[] {
  const segments: AgentStreamSearchTextSegment[] = [];
  let activeFenceCharacter: "`" | "~" | null = null;
  let activeFenceLength = 0;
  let currentText = "";
  let currentStartOffset = 0;
  let offset = 0;

  const flush = () => {
    if (currentText.length > 0) {
      segments.push({ key: "text", text: currentText, startOffset: currentStartOffset });
      currentText = "";
    }
  };

  for (const line of text.split("\n")) {
    const lineWithBreak = offset + line.length < text.length ? `${line}\n` : line;
    const fenceDelimiter = getFenceDelimiter(line);
    const isClosingFence =
      activeFenceCharacter &&
      fenceDelimiter?.[0] === activeFenceCharacter &&
      fenceDelimiter.length >= activeFenceLength;
    const isOpeningFence = !activeFenceCharacter && fenceDelimiter;
    const isIndentedCode = !activeFenceCharacter && (/^( {4,}|\t)/.test(line) || line === "    ");

    if (isOpeningFence || activeFenceCharacter || isIndentedCode) {
      flush();
    } else {
      if (currentText.length === 0) {
        currentStartOffset = offset;
      }
      currentText += lineWithBreak;
    }

    if (isOpeningFence) {
      activeFenceCharacter = fenceDelimiter[0] as "`" | "~";
      activeFenceLength = fenceDelimiter.length;
    } else if (isClosingFence) {
      activeFenceCharacter = null;
      activeFenceLength = 0;
    }

    offset += lineWithBreak.length;
  }

  flush();
  return segments;
}

function getAgentStreamItemSearchableSegments(item: StreamItem): AgentStreamSearchTextSegment[] {
  switch (item.kind) {
    case "user_message":
    case "assistant_message":
      return item.text ? getMessageSearchableSegments(item.text) : [];
    case "thought":
    case "activity_log":
    case "todo_list":
    case "tool_call":
    case "compaction":
      return [];
  }
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
    const segments = getAgentStreamItemSearchableSegments(item);
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
        const absoluteStart = segment.startOffset + start;
        const absoluteEnd = segment.startOffset + end;
        matches.push({
          id: `${entry.item.id}:${segment.key}:${occurrenceIndex}:${absoluteStart}:${absoluteEnd}`,
          entry,
          segmentKey: segment.key,
          occurrenceIndex,
          start: absoluteStart,
          end: absoluteEnd,
        });
        occurrenceIndex += 1;
        fromIndex = end;
      }
    }
  }
  return matches;
}
