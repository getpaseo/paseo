import type { StreamItem } from "@/types/stream";
import { estimateAssistantMessageHeightFromCache } from "@/utils/assistant-message-height-estimate";

export const DEFAULT_WEB_PARTIAL_VIRTUALIZATION_THRESHOLD = 100;
export const DEFAULT_WEB_MOUNTED_RECENT_STREAM_ITEMS = 50;
// Tool calls and thoughts collapse to a single-line summary row by default.
// A single tight estimate for both prevents virtualization from over-reserving
// space for rows that are actually tiny — which is what makes the timeline
// visibly "jump" as real heights arrive. (Paseo commit 0c3d15f.)
const COLLAPSED_TOOL_SEQUENCE_ROW_HEIGHT_ESTIMATE = 40;

type BottomAnchorE2ETestGlobals = typeof globalThis & {
  __HUBCODE_E2E_WEB_PARTIAL_VIRTUALIZATION_THRESHOLD?: unknown;
  __HUBCODE_E2E_WEB_MOUNTED_RECENT_STREAM_ITEMS?: unknown;
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
    (globalThis as BottomAnchorE2ETestGlobals).__HUBCODE_E2E_WEB_PARTIAL_VIRTUALIZATION_THRESHOLD,
  );
  return override ?? DEFAULT_WEB_PARTIAL_VIRTUALIZATION_THRESHOLD;
}

export function getWebMountedRecentStreamItems(): number {
  const override = readPositiveIntegerOverride(
    (globalThis as BottomAnchorE2ETestGlobals).__HUBCODE_E2E_WEB_MOUNTED_RECENT_STREAM_ITEMS,
  );
  return override ?? DEFAULT_WEB_MOUNTED_RECENT_STREAM_ITEMS;
}

export type IndexedStreamItem = {
  item: StreamItem;
  index: number;
};

export type WebVirtualizedHistoryWindow = {
  virtualizedEntries: IndexedStreamItem[];
  mountedEntries: IndexedStreamItem[];
};

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

export function findMountedWindowStart(input: {
  items: StreamItem[];
  minMountedCount: number;
}): number {
  const { items, minMountedCount } = input;
  if (items.length <= minMountedCount) {
    return 0;
  }

  let startIndex = Math.max(items.length - minMountedCount, 0);
  while (startIndex > 0 && items[startIndex]?.kind !== "user_message") {
    startIndex -= 1;
  }
  return startIndex;
}

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
