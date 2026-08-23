import {
  collectAllPanes,
  collectAllTabs,
  findPaneById,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-store";
import { getWorkspaceTabAgentId, type WorkspaceTab } from "@/workspace-tabs/model";

/**
 * The agent a launched tab should attach to.
 *
 * The Command Center can ask for the focused tab and stop there, because the
 * user is looking at that tab when they open it. A launcher cannot: the pane it
 * launches from often holds the New tab itself, so the focused tab resolves to
 * nothing exactly when an answer is needed. Hence the fallbacks — a visible
 * agent in another pane, then any open agent, newest first.
 *
 * Newest-first is a tiebreak, not a claim about recency of use. Tabs carry no
 * last-focused timestamp, so a workspace with several background agents gets
 * the most recently opened one.
 */
export function resolveLauncherAgentId(layout: WorkspaceLayout | null): string | null {
  if (!layout) return null;
  const tabsById = new Map(collectAllTabs(layout.root).map((tab) => [tab.tabId, tab]));
  const panes = collectAllPanes(layout.root);

  const focusedPane = findPaneById(layout.root, layout.focusedPaneId);
  const focused = focusedPane?.focusedTabId ? tabsById.get(focusedPane.focusedTabId) : undefined;
  const focusedAgentId = focused ? getWorkspaceTabAgentId(focused.target) : null;
  if (focusedAgentId) return focusedAgentId;

  const visible = panes.flatMap((pane) => {
    const tab = pane.focusedTabId ? tabsById.get(pane.focusedTabId) : undefined;
    return tab ? [tab] : [];
  });
  return newestAgentId(visible) ?? newestAgentId([...tabsById.values()]);
}

function newestAgentId(tabs: readonly WorkspaceTab[]): string | null {
  let newest: WorkspaceTab | null = null;
  for (const tab of tabs) {
    if (!getWorkspaceTabAgentId(tab.target)) continue;
    if (!newest || tab.createdAt > newest.createdAt) newest = tab;
  }
  return newest ? getWorkspaceTabAgentId(newest.target) : null;
}
