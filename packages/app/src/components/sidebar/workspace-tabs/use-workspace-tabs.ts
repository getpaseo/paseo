import { useMemo } from "react";
import {
  selectExplorerSidebarPaneId,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { selectSidebarWorkspaceTabs, type SidebarWorkspaceTabs } from "./model";

/**
 * A workspace's open tabs for its sidebar row. Every row calls this for its count, so both
 * selectors return references the store already holds: they only re-render a row when that
 * workspace's own layout changes, and the derivation runs once per change in `useMemo`.
 */
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
