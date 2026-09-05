import { useLayoutEffect, useMemo, useRef } from "react";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";

interface UseMountedTabSetInput {
  activeTabId: string | null;
  allTabIds: string[];
  cap: number;
  retainedTabIds?: Set<string>;
}

interface UseMountedTabSetResult {
  mountedTabIds: Set<string>;
}

interface DeriveMountedTabLruInput {
  activeTabId: string | null;
  availableTabIds: Set<string>;
  cap: number;
  previousLru: string[];
  retainedTabIds: Set<string>;
}

interface DeriveMountableWorkspaceTabIdsInput {
  activeTabId: string | null;
  isWorkspaceFocused: boolean;
  retainInactiveTimelineTabs: boolean;
  tabs: WorkspaceTabDescriptor[];
}

type DesktopTabLifecycleE2ETestGlobals = typeof globalThis & {
  __PASEO_E2E_RETAIN_INACTIVE_AGENT_TIMELINES?: unknown;
};

export function shouldRetainInactiveAgentTimelines(): boolean {
  const override = (globalThis as DesktopTabLifecycleE2ETestGlobals)
    .__PASEO_E2E_RETAIN_INACTIVE_AGENT_TIMELINES;
  return typeof override === "boolean" ? override : true;
}

export function deriveMountableWorkspaceTabIds(
  input: DeriveMountableWorkspaceTabIdsInput,
): string[] {
  return input.tabs
    .filter((tab) => {
      const isTimeline = tab.kind === "agent" || tab.kind === "provider_subagent";
      if (!isTimeline || input.retainInactiveTimelineTabs) {
        return true;
      }
      return input.isWorkspaceFocused && tab.tabId === input.activeTabId;
    })
    .map((tab) => tab.tabId);
}

function createInitialMountedTabLru(input: UseMountedTabSetInput): string[] {
  if (!input.activeTabId || !input.allTabIds.includes(input.activeTabId)) {
    return [];
  }
  return [input.activeTabId];
}

function deriveMountedTabLru(input: DeriveMountedTabLruInput): string[] {
  const { activeTabId, availableTabIds, cap, previousLru, retainedTabIds } = input;
  const maxSize = Math.max(1, cap);

  const next: string[] = [];
  if (activeTabId && availableTabIds.has(activeTabId)) {
    next.push(activeTabId);
  }

  for (const tabId of retainedTabIds) {
    if (tabId !== activeTabId && availableTabIds.has(tabId)) next.push(tabId);
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
        retainedTabIds: input.retainedTabIds ?? new Set(),
      }),
    [activeTabId, availableTabIds, cap, input.retainedTabIds],
  );
  const mountedTabIds = useMemo(() => new Set<string>(mountedTabLru), [mountedTabLru]);

  useLayoutEffect(() => {
    committedLruRef.current = mountedTabLru;
  }, [mountedTabLru]);

  return { mountedTabIds };
}
