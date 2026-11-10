import { useMemo } from "react";
import {
  selectExplorerSidebarPaneId,
  useWorkspaceLayoutStore,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { selectSidebarWorkspaceTabs, type SidebarWorkspaceTabs } from "./model";

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
 * How many tabs a workspace has open, for every sidebar row's disclosure. The row subscribes to a
 * number, so focus moves and tab-state writes that leave the count alone do not re-render it, and
 * the selector stays O(1) until this workspace's own layout reference changes.
 */
export function useSidebarWorkspaceTabCount(serverId: string, workspaceId: string): number {
  const layoutKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  const selectCount = useMemo(() => {
    let lastLayout: WorkspaceLayout | null | undefined;
    let lastExplorerPaneIdSource: string | null | undefined;
    let lastCount = 0;
    return (state: WorkspaceLayoutState): number => {
      if (!layoutKey) return 0;
      const layout = state.layoutByWorkspace[layoutKey] ?? null;
      const explorerPaneIdSource = state.explorerSidebarPaneIdByWorkspace[layoutKey];
      if (layout === lastLayout && explorerPaneIdSource === lastExplorerPaneIdSource) {
        return lastCount;
      }
      lastLayout = layout;
      lastExplorerPaneIdSource = explorerPaneIdSource;
      lastCount = selectSidebarWorkspaceTabs({
        layout,
        explorerPaneId: selectExplorerSidebarPaneId(state, layoutKey),
      }).tabs.length;
      return lastCount;
    };
  }, [layoutKey]);
  return useWorkspaceLayoutStore(selectCount);
}
