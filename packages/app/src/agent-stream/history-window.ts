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

  const mountedLimit =
    input.maxMountedCount === undefined
      ? items.length
      : Math.max(minMountedCount, input.maxMountedCount);
  const earliestStart = Math.max(0, items.length - mountedLimit);
  let startIndex = Math.max(items.length - minMountedCount, 0);
  while (startIndex > earliestStart && continuesTurn(items[startIndex - 1], items[startIndex])) {
    startIndex -= 1;
  }
  return startIndex;
}
