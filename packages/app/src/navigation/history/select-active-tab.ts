import type { WorkspaceLayout } from "@/stores/workspace-layout-actions";
import { findPaneById, resolveExplorerSidebarPaneId } from "@/stores/workspace-layout-store";

export interface ActiveTabLayoutState {
  layoutByWorkspace: Record<string, WorkspaceLayout>;
  focusRestorationByWorkspace: Record<string, { restorePaneId: string | null }>;
  explorerSidebarPaneIdByWorkspace: Record<string, string | null>;
}

/**
 * The tab the user is looking at in a workspace: the focused pane's focused tab. Falls back to
 * the pane focus will return to, because `unfocusPane` nulls `focusedPaneId` while focus sits in
 * the composer or sidebar and that must not read as "no tab". The Explorer sidebar pane never
 * counts; selecting a view there is not a place to navigate back to.
 */
export function selectActiveWorkspaceTabId(
  state: ActiveTabLayoutState,
  workspaceKey: string,
): string | null {
  const layout = state.layoutByWorkspace[workspaceKey];
  if (!layout) {
    return null;
  }
  const paneId =
    layout.focusedPaneId ?? state.focusRestorationByWorkspace[workspaceKey]?.restorePaneId ?? null;
  if (!paneId) {
    return null;
  }
  const explorerPaneId = resolveExplorerSidebarPaneId(
    layout,
    state.explorerSidebarPaneIdByWorkspace[workspaceKey],
  );
  if (paneId === explorerPaneId) {
    return null;
  }
  return findPaneById(layout.root, paneId)?.focusedTabId ?? null;
}
