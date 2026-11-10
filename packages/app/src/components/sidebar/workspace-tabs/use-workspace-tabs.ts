import equal from "fast-deep-equal";
import { useMemo } from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { usePendingArchiveAgentKeys } from "@/hooks/use-archive-agent";
import { useSessionStore } from "@/stores/session-store";
import { useProviderSubagentStore } from "@/subagents/provider-store";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import {
  selectExplorerSidebarPaneId,
  useWorkspaceLayoutStore,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import {
  selectProviderSubagentsForParent,
  selectSubagentsForParent,
  useHasSubagents,
} from "@/subagents/select";
import {
  EMPTY_SIDEBAR_WORKSPACE_TABS_SUMMARY,
  hasSidebarWorkspaceTabsDisclosure,
  selectNestedSubagentTabIds,
  selectSidebarWorkspaceTabs,
  sidebarWorkspaceTabsSummariesEqual,
  summarizeSidebarWorkspaceTabs,
  type SidebarWorkspaceTabs,
  type SidebarWorkspaceTabsSummary,
} from "./model";

type WorkspaceLayoutState = Parameters<Parameters<typeof useWorkspaceLayoutStore>[0]>[0];

/** A workspace's open tabs for its expanded sidebar row. */
export function useSidebarWorkspaceTabs(
  serverId: string,
  workspaceId: string,
): SidebarWorkspaceTabs {
  const layoutKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  const layout = useWorkspaceLayoutStore((state) =>
    layoutKey ? (state.layoutByWorkspace[layoutKey] ?? null) : null,
  );
  const explorerPaneId = useWorkspaceLayoutStore((state) =>
    layoutKey ? selectExplorerSidebarPaneId(state, layoutKey) : null,
  );
  return useMemo(
    () => selectSidebarWorkspaceTabs({ layout, explorerPaneId }),
    [layout, explorerPaneId],
  );
}

/**
 * How many tabs a workspace has open, and the agent of its only tab, for every sidebar row's
 * disclosure. The row subscribes to a reference-stable summary, so focus moves and tab-state
 * writes that leave it alone do not re-render it, and the selector stays O(1) until this
 * workspace's own layout reference changes.
 */
function useSidebarWorkspaceTabsSummary(
  serverId: string,
  workspaceId: string,
): SidebarWorkspaceTabsSummary {
  const layoutKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  const selectSummary = useMemo(() => {
    let lastLayout: WorkspaceLayout | null | undefined;
    let lastExplorerPaneIdSource: string | null | undefined;
    let lastSummary = EMPTY_SIDEBAR_WORKSPACE_TABS_SUMMARY;
    return (state: WorkspaceLayoutState): SidebarWorkspaceTabsSummary => {
      if (!layoutKey) return EMPTY_SIDEBAR_WORKSPACE_TABS_SUMMARY;
      const layout = state.layoutByWorkspace[layoutKey] ?? null;
      const explorerPaneIdSource = state.explorerSidebarPaneIdByWorkspace[layoutKey];
      if (layout === lastLayout && explorerPaneIdSource === lastExplorerPaneIdSource) {
        return lastSummary;
      }
      lastLayout = layout;
      lastExplorerPaneIdSource = explorerPaneIdSource;
      const next = summarizeSidebarWorkspaceTabs(
        selectSidebarWorkspaceTabs({
          layout,
          explorerPaneId: selectExplorerSidebarPaneId(state, layoutKey),
        }),
      );
      if (!sidebarWorkspaceTabsSummariesEqual(next, lastSummary)) lastSummary = next;
      return lastSummary;
    };
  }, [layoutKey]);
  return useWorkspaceLayoutStore(selectSummary);
}

/**
 * The count a workspace row's disclosure shows, or null when the row has no disclosure. A lone
 * agent tab with subagents keeps it, so its subagents stay reachable from the sidebar.
 */
export function useSidebarWorkspaceTabsDisclosureCount(
  serverId: string,
  workspaceId: string,
): number | null {
  const { tabCount, soleAgentId } = useSidebarWorkspaceTabsSummary(serverId, workspaceId);
  const soleTabHasSubagents = useHasSubagents(serverId, soleAgentId);
  return hasSidebarWorkspaceTabsDisclosure(tabCount, soleTabHasSubagents) ? tabCount : null;
}

const NO_TAB_IDS: ReadonlySet<string> = new Set();

/**
 * The expanded list's tabs that belong under another agent tab's subagents, matched against the
 * same rows that list shows. The Paseo half recomputes only when an agent map changes, so stream
 * ticks that leave the maps alone cost a reference check.
 */
export function useNestedSubagentTabIds(
  serverId: string,
  tabs: readonly WorkspaceTabDescriptor[],
): ReadonlySet<string> {
  const pendingArchiveIds = usePendingArchiveAgentKeys();
  const selectPaseoNested = useMemo(() => {
    let lastMaps: unknown[] = [];
    let lastResult: string[] = [];
    return (state: ReturnType<typeof useSessionStore.getState>): string[] => {
      const maps = Object.values(state.sessions).map((session) => session.agents);
      if (maps.length === lastMaps.length && maps.every((map, index) => map === lastMaps[index])) {
        return lastResult;
      }
      lastMaps = maps;
      lastResult = selectNestedSubagentTabIds(tabs, (parentAgentId) =>
        selectSubagentsForParent(state, { serverId, parentAgentId }, pendingArchiveIds),
      );
      return lastResult;
    };
  }, [serverId, tabs, pendingArchiveIds]);
  const paseoNested = useStoreWithEqualityFn(useSessionStore, selectPaseoNested, equal);
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.providerSubagents === true,
  );
  const nestingSupported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.providerSubagentNesting === true,
  );
  const providerNested = useStoreWithEqualityFn(
    useProviderSubagentStore,
    (state) =>
      selectNestedSubagentTabIds(tabs, (parentAgentId) =>
        selectProviderSubagentsForParent(
          state,
          { serverId, parentAgentId },
          supported,
          nestingSupported,
        ),
      ),
    equal,
  );
  return useMemo(() => {
    if (paseoNested.length === 0 && providerNested.length === 0) return NO_TAB_IDS;
    return new Set([...paseoNested, ...providerNested]);
  }, [paseoNested, providerNested]);
}
