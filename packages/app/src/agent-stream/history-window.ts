import type { StreamItem } from "@/types/stream";

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
