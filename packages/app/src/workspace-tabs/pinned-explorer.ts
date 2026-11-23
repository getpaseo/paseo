import { useWorkspaceLayoutStore, type PinnedExplorer } from "@/stores/workspace-layout-store";
import {
  closeTabInLayout,
  collectAllTabs,
  createTabInLayout,
  findPaneById,
  findPaneContainingTab,
  moveTabToPaneInLayout,
  selectTabInPaneInLayout,
  setPaneHiddenInLayout,
  setTabStateInLayout,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-actions";

interface ObservePinnedExplorerInput {
  serverId: string;
  workspaceKey: string;
  store?: typeof useWorkspaceLayoutStore;
}

/** Only the active workspace owns the shared intent; retained workspaces never write it. */
export function observePinnedExplorer({
  serverId,
  workspaceKey,
  store = useWorkspaceLayoutStore,
}: ObservePinnedExplorerInput): () => void {
  restorePinnedExplorer({ serverId, workspaceKey, store });
  return store.subscribe((state, before) => {
    if (
      state.layoutByWorkspace[workspaceKey] === before.layoutByWorkspace[workspaceKey] &&
      state.explorerSidebarWidthByWorkspace[workspaceKey] ===
        before.explorerSidebarWidthByWorkspace[workspaceKey]
    )
      return;
    const shared = state.pinnedExplorerByHost[serverId];
    const layout = state.layoutByWorkspace[workspaceKey];
    if (!shared?.tabs.length || !layout) return;
    const pane = findPaneById(layout.root, state.explorerSidebarPaneIdByWorkspace[workspaceKey]);
    if (!pane) return;
    const tabs = shared.tabs.map((pin) => {
      const tab = collectAllTabs(layout.root).find(
        (candidate) => candidate.tabId === pin.tab.tabId && pane.tabIds.includes(candidate.tabId),
      );
      if (!tab || tab.target.kind !== "plugin" || tab.target.context !== "workspace") {
        return { tab: pin.tab, open: false };
      }
      return { tab: { ...tab, target: tab.target }, open: true };
    });
    const selectedTabId = tabs.some((pin) => pin.open && pin.tab.tabId === pane.focusedTabId)
      ? pane.focusedTabId
      : null;
    const next: PinnedExplorer = {
      tabs,
      selectedTabId,
      visible: !pane.hidden,
      width: state.explorerSidebarWidthByWorkspace[workspaceKey] ?? null,
    };
    if (JSON.stringify(next) === JSON.stringify(shared)) return;
    store.setState({ pinnedExplorerByHost: { ...state.pinnedExplorerByHost, [serverId]: next } });
  });
}

function restorePinnedExplorer({
  serverId,
  workspaceKey,
  store = useWorkspaceLayoutStore,
}: ObservePinnedExplorerInput): void {
  const pinned = store.getState().pinnedExplorerByHost[serverId];
  if (pinned?.tabs.length) {
    const paneId = store.getState().ensureExplorerSidebar(workspaceKey);
    const state = store.getState();
    const original = state.layoutByWorkspace[workspaceKey];
    if (paneId && original) {
      let layout = original;
      const originalSelection = findPaneById(layout.root, paneId)?.focusedTabId ?? null;
      for (const pin of pinned.tabs) {
        layout = restorePin({ layout, paneId, pin });
      }
      const selection = pinned.selectedTabId ?? originalSelection;
      if (selection) {
        layout = selectTabInPaneInLayout({ layout, paneId, tabId: selection }) ?? layout;
      }
      layout = setPaneHiddenInLayout({ layout, paneId, hidden: !pinned.visible }) ?? layout;
      store.setState({
        layoutByWorkspace: {
          ...state.layoutByWorkspace,
          [workspaceKey]: { ...layout, focusedPaneId: original.focusedPaneId },
        },
        ...(pinned.width === null
          ? {}
          : {
              explorerSidebarWidthByWorkspace: {
                ...state.explorerSidebarWidthByWorkspace,
                [workspaceKey]: pinned.width,
              },
            }),
      });
    }
  }
}

function restorePin({
  layout,
  paneId,
  pin,
}: {
  layout: WorkspaceLayout;
  paneId: string;
  pin: PinnedExplorer["tabs"][number];
}): WorkspaceLayout {
  const { tab } = pin;
  const owner = findPaneContainingTab(layout.root, tab.tabId);
  if (!pin.open) {
    if (owner?.id === paneId) {
      layout =
        closeTabInLayout({ layout, tabId: tab.tabId, explorerSidebarPaneId: paneId }) ?? layout;
    }
    return layout;
  }
  if (owner) {
    layout =
      moveTabToPaneInLayout({
        layout,
        tabId: tab.tabId,
        toPaneId: paneId,
        explorerSidebarPaneId: paneId,
      }) ?? layout;
    layout = setTabStateInLayout({ layout, tabId: tab.tabId, state: tab.state }) ?? layout;
  } else {
    layout =
      createTabInLayout({
        layout,
        target: tab.target,
        now: tab.createdAt,
        state: tab.state,
        createTabId: () => tab.tabId,
        placement: { mode: "pane", paneId },
        explorerSidebarPaneId: paneId,
      })?.layout ?? layout;
  }

  return layout;
}
