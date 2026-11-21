import { useCallback, useEffect, useMemo, useState } from "react";
import { getStreamItemMessageId, type StreamItem } from "@/types/stream";
import { findMountedWindowStart, getMountedRecentStreamItems } from "./history-window";

// Callers reveal a message, not a row: an assistant message is several block rows and
// the window has to open at the first of them.
function findMessageRowIndex(items: StreamItem[], messageId: string): number {
  return items.findIndex((item) => getStreamItemMessageId(item) === messageId);
}

function findEarlierHistoryWindowStart(input: {
  items: StreamItem[];
  start: number;
  itemId: string | undefined;
}): number {
  const targetIndex = input.itemId ? findMessageRowIndex(input.items, input.itemId) : -1;
  const targetStart = targetIndex >= 0 && targetIndex < input.start ? targetIndex : input.start;
  if (!input.itemId) {
    return findMountedWindowStart({
      items: input.items.slice(0, targetStart),
      minMountedCount: getMountedRecentStreamItems(),
    });
  }
  return findMountedWindowStart({
    items: input.items.slice(0, targetStart + 1),
    minMountedCount: 1,
  });
}

interface HistoryWindowBoundary {
  boundaryItemId: string | null;
  initialized: boolean;
}

function reconcileHistoryWindow(input: {
  current: HistoryWindowBoundary;
  boundaryIndex: number;
  initialBoundaryItemId: string | null;
  hasItems: boolean;
}): HistoryWindowBoundary {
  const { current, boundaryIndex, initialBoundaryItemId, hasItems } = input;
  if (!current.initialized && hasItems) {
    return { ...current, boundaryItemId: initialBoundaryItemId, initialized: true };
  }
  if (current.boundaryItemId !== null && boundaryIndex < 0) {
    return { ...current, boundaryItemId: initialBoundaryItemId };
  }
  return current;
}

export function useStreamHistoryWindow(input: {
  items: StreamItem[];
  loadRemoteOlder: () => boolean | Promise<boolean>;
}) {
  const { items, loadRemoteOlder } = input;
  const initialStart = useMemo(
    () => findMountedWindowStart({ items, minMountedCount: getMountedRecentStreamItems() }),
    [items],
  );
  const initialBoundaryItemId = initialStart === 0 ? null : (items[initialStart]?.id ?? null);
  const [window, setWindow] = useState(() => ({
    boundaryItemId: initialBoundaryItemId,
    initialized: items.length > 0,
  }));
  const boundaryItemId = window.boundaryItemId;
  const boundaryIndex = useMemo(
    () => (boundaryItemId === null ? -1 : items.findIndex((item) => item.id === boundaryItemId)),
    [boundaryItemId, items],
  );
  let start = initialStart;
  if (window.initialized) {
    if (window.boundaryItemId === null) {
      start = 0;
    } else if (boundaryIndex >= 0) {
      start = boundaryIndex;
    }
  }

  useEffect(() => {
    setWindow((current) =>
      reconcileHistoryWindow({
        current,
        boundaryIndex,
        initialBoundaryItemId,
        hasItems: items.length > 0,
      }),
    );
  }, [boundaryIndex, initialBoundaryItemId, items.length]);

  const revealLoadedHistory = useCallback(
    (itemId?: string): boolean => {
      const targetIndex = itemId ? findMessageRowIndex(items, itemId) : -1;
      if (start === 0 || (itemId !== undefined && (targetIndex < 0 || targetIndex >= start))) {
        return false;
      }
      const nextStart = findEarlierHistoryWindowStart({ items, start, itemId });
      if (nextStart === start) {
        return false;
      }
      setWindow({
        boundaryItemId: items[nextStart]?.id ?? null,
        initialized: true,
      });
      return true;
    },
    [items, start],
  );
  const loadOlder = useCallback(async (): Promise<boolean> => {
    return revealLoadedHistory() || (await loadRemoteOlder());
  }, [loadRemoteOlder, revealLoadedHistory]);

  return { start, hasLocalHistory: start > 0, revealLoadedHistory, loadOlder };
}
