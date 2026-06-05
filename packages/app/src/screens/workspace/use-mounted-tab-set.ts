import { useLayoutEffect, useMemo, useRef } from "react";

interface UseMountedTabSetInput {
  activeTabId: string | null;
  allTabIds: string[];
  cap: number;
}

interface UseMountedTabSetResult {
  mountedTabIds: Set<string>;
}

interface DeriveMountedTabLruInput {
  activeTabId: string | null;
  availableTabIds: Set<string>;
  cap: number;
  previousLru: string[];
}

function createInitialMountedTabLru(input: UseMountedTabSetInput): string[] {
  if (!input.activeTabId || !input.allTabIds.includes(input.activeTabId)) {
    return [];
  }
  return [input.activeTabId];
}

function deriveMountedTabLru(input: DeriveMountedTabLruInput): string[] {
  const { activeTabId, availableTabIds, cap, previousLru } = input;
  const maxSize = Math.max(1, cap);

  const next: string[] = [];
  if (activeTabId && availableTabIds.has(activeTabId)) {
    next.push(activeTabId);
  }

  for (const tabId of previousLru) {
    if (next.length >= maxSize) break;
    if (tabId !== activeTabId && availableTabIds.has(tabId)) {
      next.push(tabId);
    }
  }
  return next;
}

export function useMountedTabSet(input: UseMountedTabSetInput): UseMountedTabSetResult {
  const { activeTabId, allTabIds, cap } = input;
  const allTabIdsKey = allTabIds.join("\u0000");
  const availableTabIds = useMemo(() => {
    void allTabIdsKey;
    return new Set(allTabIds);
  }, [allTabIds, allTabIdsKey]);
  const committedLruRef = useRef(createInitialMountedTabLru(input));
  const mountedTabLru = useMemo(
    () =>
      deriveMountedTabLru({
        activeTabId,
        availableTabIds,
        cap,
        previousLru: committedLruRef.current,
      }),
    [activeTabId, availableTabIds, cap],
  );
  const mountedTabIds = useMemo(() => new Set<string>(mountedTabLru), [mountedTabLru]);

  useLayoutEffect(() => {
    committedLruRef.current = mountedTabLru;
  }, [mountedTabLru]);

  return { mountedTabIds };
}
