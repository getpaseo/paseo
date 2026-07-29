import { useMemo } from "react";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { findPaneById } from "@/stores/workspace-layout-actions";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

export interface ActiveTreeTab {
  /** The workspace being viewed. */
  workspaceId: string;
  /** The tab focused inside it. */
  tabId: string;
}

/**
 * The tab currently being viewed on this server, with the workspace it lives in.
 *
 * Rows compare against both halves, because a row's workspace is not always the
 * one it is displayed under: a cross-workspace subagent renders beneath its
 * parent but opens in its own workspace. Returning the workspace alongside the
 * tab id lets such a row highlight when it is active, and keeps rows in other
 * workspaces from matching a tab id that happens to collide.
 *
 * Only the active workspace is considered, so exactly one row is highlighted
 * overall — mirroring how exactly one workspace row is.
 */
export function useActiveTreeTab(serverId: string): ActiveTreeTab | null {
  const activeSelection = useActiveWorkspaceSelection();
  const activeWorkspaceId =
    activeSelection?.serverId === serverId ? activeSelection.workspaceId : null;
  const layoutKey = activeWorkspaceId
    ? buildWorkspaceTabPersistenceKey({ serverId, workspaceId: activeWorkspaceId })
    : null;

  const focusedTabId = useWorkspaceLayoutStore((state) => {
    if (!layoutKey) {
      return null;
    }
    const layout = state.layoutByWorkspace[layoutKey];
    if (!layout) {
      return null;
    }
    return findPaneById(layout.root, layout.focusedPaneId)?.focusedTabId ?? null;
  });

  return useMemo(
    () =>
      activeWorkspaceId && focusedTabId
        ? { workspaceId: activeWorkspaceId, tabId: focusedTabId }
        : null,
    [activeWorkspaceId, focusedTabId],
  );
}
