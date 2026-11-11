import type { StreamItem } from "@/types/stream";
import { continuesTurn } from "./turn-membership";

export const DEFAULT_MOUNTED_RECENT_STREAM_ITEMS = 20;

type MountedRecentStreamItemsE2ETestGlobals = typeof globalThis & {
  __PASEO_E2E_WEB_MOUNTED_RECENT_STREAM_ITEMS?: unknown;
};

function readPositiveIntegerOverride(value: unknown): number | null {
  if (!Number.isFinite(value)) {
    return null;
  }
  const normalized = Math.trunc(value as number);
  return normalized > 0 ? normalized : null;
}

export function getMountedRecentStreamItems(): number {
  const override = readPositiveIntegerOverride(
    (globalThis as MountedRecentStreamItemsE2ETestGlobals)
      .__PASEO_E2E_WEB_MOUNTED_RECENT_STREAM_ITEMS,
  );
  return override ?? DEFAULT_MOUNTED_RECENT_STREAM_ITEMS;
}

function isExpandedTurnSummary(item: StreamItem | undefined): boolean {
  return item?.kind === "turn_summary" && item.expanded;
}

export function findMountedWindowStart(input: {
  items: StreamItem[];
  minMountedCount: number;
  // Caps how far turn alignment may rewind. History paging and the replica
  // cache omit it and still keep a whole turn.
  maxMountedCount?: number;
}): number {
  const { items, minMountedCount } = input;
  if (items.length <= minMountedCount) {
    return 0;
  }

  let mountedLimit = items.length;
  if (input.maxMountedCount !== undefined) {
    mountedLimit = Math.max(minMountedCount, input.maxMountedCount);
  }
  const cappedStart = Math.max(0, items.length - mountedLimit);
  let startIndex = Math.max(items.length - minMountedCount, 0);
  while (startIndex > cappedStart && continuesTurn(items[startIndex - 1], items[startIndex])) {
    startIndex -= 1;
  }

  // An expanded turn keeps its own summary row mounted, because that row is the only control
  // that folds the turn again. Only the turn this window is inside qualifies: lifting the cap
  // for an older expanded turn would mount a newer long turn in full.
  if (isExpandedTurnSummary(items[startIndex])) {
    return startIndex;
  }
  let turnStart = startIndex;
  while (turnStart > 0 && continuesTurn(items[turnStart - 1], items[turnStart])) {
    turnStart -= 1;
    const item = items[turnStart];
    if (item?.kind === "turn_summary") {
      // The summary starts this turn. Its expanded variant is the row the reader needs back;
      // any other summary means the window reached an older turn and must keep the cap.
      return item.expanded ? turnStart : startIndex;
    }
  }
  return startIndex;
}
