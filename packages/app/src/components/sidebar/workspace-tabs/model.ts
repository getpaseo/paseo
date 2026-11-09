import { collectAllPanes, collectAllTabs } from "@/stores/workspace-layout-actions";
import type { WorkspaceLayout } from "@/stores/workspace-layout-store";
import { getWorkspacePaneDescriptors } from "@/screens/workspace/workspace-pane-state";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";

export interface SidebarWorkspaceTabs {
  tabs: WorkspaceTabDescriptor[];
  /** The tab the workspace shows when it is opened: the focused pane's focused tab. */
  activeTabId: string | null;
}

export interface SelectSidebarWorkspaceTabsInput {
  layout: WorkspaceLayout | null;
  /**
   * The explorer is chrome beside the tab strip, not part of it, and on desktop it always holds
   * Files and Changes, so listing it would put the same two rows under every workspace.
   */
  explorerPaneId: string | null;
}

const NO_TABS: SidebarWorkspaceTabs = { tabs: [], activeTabId: null };

/** A workspace's open tabs, pane by pane in strip order, for the sidebar's tab list. */
export function selectSidebarWorkspaceTabs({
  layout,
  explorerPaneId,
}: SelectSidebarWorkspaceTabsInput): SidebarWorkspaceTabs {
  if (!layout) return NO_TABS;
  const allTabs = collectAllTabs(layout.root);
  const panes = collectAllPanes(layout.root).filter((pane) => pane.id !== explorerPaneId);
  const seenTabIds = new Set<string>();
  const tabs: WorkspaceTabDescriptor[] = [];
  for (const pane of panes) {
    for (const tab of getWorkspacePaneDescriptors({ pane, tabs: allTabs })) {
      if (seenTabIds.has(tab.tabId)) continue;
      seenTabIds.add(tab.tabId);
      tabs.push(tab);
    }
  }
  if (tabs.length === 0) return NO_TABS;
  const focusedPane = panes.find((pane) => pane.id === layout.focusedPaneId);
  const focusedTabId = focusedPane?.focusedTabId ?? null;
  const activeTabId = focusedTabId && seenTabIds.has(focusedTabId) ? focusedTabId : null;
  return { tabs, activeTabId };
}

/**
 * A row only offers its tabs when there is a choice to make: with one tab, opening the
 * workspace already lands on it.
 */
export function hasSidebarWorkspaceTabsDisclosure(tabCount: number): boolean {
  return tabCount > 1;
}

/** Adds the key if absent and removes it if present, returning a new set. */
export function toggleExpandedWorkspaceKey(
  expanded: ReadonlySet<string>,
  workspaceKey: string,
): ReadonlySet<string> {
  const next = new Set(expanded);
  if (next.has(workspaceKey)) next.delete(workspaceKey);
  else next.add(workspaceKey);
  return next;
}
