import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { findPaneById } from "@/stores/workspace-layout-actions";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

/**
 * The tab id currently being viewed in this workspace, or null.
 *
 * Scoped to the active workspace on purpose. The sidebar highlights exactly one
 * workspace row — the one you are looking at — and this mirrors that: exactly
 * one agent or terminal row is highlighted, inside that workspace. Highlighting
 * each expanded workspace's last-focused tab would read as several active
 * things at once.
 */
export function useActiveTreeTabId(input: {
  serverId: string;
  workspaceId: string;
}): string | null {
  const activeSelection = useActiveWorkspaceSelection();
  const isActiveWorkspace =
    activeSelection?.serverId === input.serverId &&
    activeSelection?.workspaceId === input.workspaceId;
  const layoutKey = isActiveWorkspace ? buildWorkspaceTabPersistenceKey(input) : null;

  return useWorkspaceLayoutStore((state) => {
    if (!layoutKey) {
      return null;
    }
    const layout = state.layoutByWorkspace[layoutKey];
    if (!layout) {
      return null;
    }
    return findPaneById(layout.root, layout.focusedPaneId)?.focusedTabId ?? null;
  });
}
