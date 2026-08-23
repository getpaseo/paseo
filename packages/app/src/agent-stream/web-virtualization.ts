import type { StreamItem } from "@/types/stream";
import { estimateAssistantMessageHeightFromCache } from "@/utils/assistant-message-height-estimate";
import {
  DEFAULT_MOUNTED_RECENT_STREAM_ITEMS,
  findMountedWindowStart,
  getMountedRecentStreamItems,
} from "./history-window";

export const DEFAULT_WEB_PARTIAL_VIRTUALIZATION_THRESHOLD = 100;
export const DEFAULT_WEB_MOUNTED_RECENT_STREAM_ITEMS = DEFAULT_MOUNTED_RECENT_STREAM_ITEMS;
const COLLAPSED_TOOL_SEQUENCE_ROW_HEIGHT_ESTIMATE = 40;

export function shouldAdjustScrollForVirtualRowResize(input: {
  isHistoryStartPrependActive: boolean;
  rowStart: number;
  scrollOffset: number;
  remainingDistanceFromBottom: number;
  bottomThreshold: number;
}): boolean {
  if (input.isHistoryStartPrependActive) {
    return false;
  }
  return (
    input.remainingDistanceFromBottom > input.bottomThreshold && input.rowStart < input.scrollOffset
  );
}

type BottomAnchorE2ETestGlobals = typeof globalThis & {
  __PASEO_E2E_WEB_PARTIAL_VIRTUALIZATION_THRESHOLD?: unknown;
};

function readPositiveIntegerOverride(value: unknown): number | null {
  if (!Number.isFinite(value)) {
    return null;
  }
  const normalized = Math.trunc(value as number);
  return normalized > 0 ? normalized : null;
}

export function getWebPartialVirtualizationThreshold(): number {
  const override = readPositiveIntegerOverride(
    (globalThis as BottomAnchorE2ETestGlobals).__PASEO_E2E_WEB_PARTIAL_VIRTUALIZATION_THRESHOLD,
  );
  return override ?? DEFAULT_WEB_PARTIAL_VIRTUALIZATION_THRESHOLD;
}

export function getWebMountedRecentStreamItems(): number {
  return getMountedRecentStreamItems();
}

export interface IndexedStreamItem {
  item: StreamItem;
  index: number;
}

export interface WebVirtualizedHistoryWindow {
  virtualizedEntries: IndexedStreamItem[];
  mountedEntries: IndexedStreamItem[];
}

export function estimateStreamItemHeight(item: StreamItem): number {
  switch (item.kind) {
    case "user_message":
      return item.images && item.images.length > 0 ? 220 : 96;
    case "assistant_message":
      return estimateAssistantMessageHeightFromCache(item.text) ?? 220;
    case "tool_call":
      return COLLAPSED_TOOL_SEQUENCE_ROW_HEIGHT_ESTIMATE;
    case "thought":
      return COLLAPSED_TOOL_SEQUENCE_ROW_HEIGHT_ESTIMATE;
    case "todo_list":
      return 144;
    case "activity_log":
      return 88;
    case "compaction":
      return 72;
    default:
      return 120;
  }
}

export { findMountedWindowStart };

export function splitWebVirtualizedHistory(input: {
  entries: IndexedStreamItem[];
  minMountedCount: number;
}): WebVirtualizedHistoryWindow {
  const startIndex = findMountedWindowStart({
    items: input.entries.map((entry) => entry.item),
    minMountedCount: input.minMountedCount,
  });
  return {
    virtualizedEntries: input.entries.slice(0, startIndex),
    mountedEntries: input.entries.slice(startIndex),
  };
}
