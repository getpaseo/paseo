import { isWeb } from "@/constants/platform";
import { getBrowserRecord, useBrowserStore } from "@/desktop/browser/store";
import { getResidentBrowserWebview } from "@/desktop/browser/resident-webviews";
import type { WorkspaceTab } from "@/workspace-tabs/model";
import { openWorkspaceBrowser } from "@/workspace-tabs/browser";
import {
  collectAllTabs,
  findPaneById,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";

export function isAgentBrowserTab(tab: WorkspaceTab): boolean {
  return (
    tab.target.kind === "browser" &&
    tab.state != null &&
    typeof tab.state === "object" &&
    !Array.isArray(tab.state) &&
    tab.state.agentBrowser === true
  );
}

export function selectClassicBrowser(
  tabs: WorkspaceTab[],
  focusedTabId?: string | null,
): WorkspaceTab | undefined {
  const classic = tabs.filter((tab) => tab.target.kind === "browser" && !isAgentBrowserTab(tab));
  const dashboard = tabs.find(isAgentBrowserTab);
  const previous =
    dashboard?.state && typeof dashboard.state === "object" && !Array.isArray(dashboard.state)
      ? dashboard.state.classicBrowserId
      : null;
  return (
    classic.find((tab) => tab.tabId === focusedTabId) ??
    classic.find((tab) => tab.target.kind === "browser" && tab.target.browserId === previous) ??
    classic.at(-1)
  );
}

export function rememberWorkspaceClassicBrowser(workspaceKey: string) {
  const store = useWorkspaceLayoutStore.getState();
  const layout = store.layoutByWorkspace[workspaceKey];
  if (!layout) return;
  const pane = findPaneById(layout.root, layout.focusedPaneId);
  const tabs = collectAllTabs(layout.root);
  const classic = tabs.find((tab) => tab.tabId === pane?.focusedTabId);
  if (classic?.target.kind !== "browser" || isAgentBrowserTab(classic)) return;
  const dashboard = tabs.find(isAgentBrowserTab);
  const closed = useBrowserStore.getState().lastClosedByWorkspace[workspaceKey];
  const state = dashboard ? dashboard.state : closed?.state;
  if (!state || typeof state !== "object" || Array.isArray(state) || state.agentBrowser !== true)
    return;
  if (state.classicBrowserId === classic.target.browserId) return;
  const nextState = { ...state, classicBrowserId: classic.target.browserId };
  if (dashboard) store.setTabState(workspaceKey, dashboard.tabId, nextState);
  else if (closed)
    useBrowserStore.setState((current) => ({
      lastClosedByWorkspace: {
        ...current.lastClosedByWorkspace,
        [workspaceKey]: { ...closed, state: nextState },
      },
    }));
}

export function openWorkspaceAgentBrowser(workspaceKey: string, url: string) {
  const store = useWorkspaceLayoutStore.getState();
  const layout = store.layoutByWorkspace[workspaceKey];
  const tabs = layout ? collectAllTabs(layout.root) : [];
  const existing = tabs.find(isAgentBrowserTab);
  const pane = layout
    ? findPaneById(layout.root, store.browserPaneIdByWorkspace[workspaceKey])
    : null;
  const classic = selectClassicBrowser(tabs, pane?.focusedTabId);
  const state = {
    agentBrowser: true,
    classicBrowserId: classic?.target.kind === "browser" ? classic.target.browserId : null,
  };
  if (existing?.target.kind === "browser") {
    const browserId = existing.target.browserId;
    const record = getBrowserRecord(browserId);
    if (record && new URL(record.url).origin !== new URL(url).origin) {
      useBrowserStore.getState().updateBrowser(browserId, { url, lastError: null });
      if (isWeb) getResidentBrowserWebview(browserId)?.setAttribute("src", url);
    }
  }
  const result = openWorkspaceBrowser({
    workspaceKey,
    url,
    intent: "reveal",
    ...(existing?.target.kind === "browser" ? { browserId: existing.target.browserId } : {}),
    state,
  });
  if (result.ok) store.setTabState(workspaceKey, result.tabId, state);
  return result;
}
