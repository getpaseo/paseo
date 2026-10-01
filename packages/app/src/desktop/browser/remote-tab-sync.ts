import { getIsElectron } from "@/constants/platform";
import type { BrowserMirrorEvent } from "@getpaseo/protocol/browser-activity/rpc-schemas";
import { publishBrowserMirror } from "@/desktop/browser/mirror";
import { isRemoteBrowserClosed, useBrowserStore } from "@/desktop/browser/store";
import { duplicateRemoteBrowserRecordIds } from "@/desktop/browser/remote-tab-records";
import { collectAllTabs, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";

// The daemon lists a new tab before it answers new_tab (it waits for the page to
// load), so a listing during that window would adopt our own tab a second time.
let remoteNewTabsInFlight = 0;

export async function whileCreatingRemoteTab<T>(create: () => Promise<T>): Promise<T> {
  remoteNewTabsInFlight += 1;
  try {
    return await create();
  } finally {
    remoteNewTabsInFlight -= 1;
  }
}

export interface ListedRemoteTab {
  browserId: string;
  workspaceId?: string | null;
  url: string;
  title: string;
}

function openBrowserIds(workspaceKey: string): Set<string> {
  const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
  const ids = new Set<string>();
  for (const tab of layout ? collectAllTabs(layout.root) : []) {
    if (tab.target.kind === "browser") ids.add(tab.target.browserId);
  }
  return ids;
}

export function closeLocalBrowserTab(workspaceKey: string, browserId: string): void {
  const layoutStore = useWorkspaceLayoutStore.getState();
  const layout = layoutStore.layoutByWorkspace[workspaceKey];
  for (const tab of layout ? collectAllTabs(layout.root) : []) {
    if (tab.target.kind === "browser" && tab.target.browserId === browserId) {
      layoutStore.closeTab(workspaceKey, tab.tabId);
    }
  }
  useBrowserStore.getState().removeBrowser(browserId);
}

/**
 * The one place a daemon tab listing becomes workspace tabs. A daemon tab that a
 * record already shows opens as that record, never under its daemon id as well;
 * a second owner opened a second tab that the next cleanup closed again.
 */
export function syncRemoteBrowserTabs(input: {
  tabs: readonly ListedRemoteTab[];
  workspaceId: string;
  workspaceKey: string;
  serverId?: string;
  mirrorEvents?: readonly BrowserMirrorEvent[];
}): void {
  const { workspaceId, workspaceKey } = input;
  if (input.serverId) {
    for (const event of input.mirrorEvents ?? []) {
      if (event.workspaceId === workspaceId) publishBrowserMirror(input.serverId, event);
    }
  }
  for (const duplicate of duplicateRemoteBrowserRecordIds(
    Object.values(useBrowserStore.getState().browsersById),
  )) {
    closeLocalBrowserTab(workspaceKey, duplicate);
  }
  for (const tab of input.tabs) {
    if (tab.workspaceId && tab.workspaceId !== workspaceId) continue;
    if (isRemoteBrowserClosed(tab.browserId)) continue;
    const browserStore = useBrowserStore.getState();
    const record = Object.values(browserStore.browsersById).find(
      (candidate) => candidate.remoteBrowserId === tab.browserId,
    );
    if (!record) {
      if (remoteNewTabsInFlight > 0) continue;
      browserStore.upsertRemoteBrowser({
        browserId: tab.browserId,
        url: tab.url,
        title: tab.title,
      });
    } else if (
      (!getIsElectron() || record.url === "about:blank" || !record.url) &&
      (record.url !== tab.url || record.title !== tab.title)
    ) {
      // In the desktop app the local tab owns its address; it follows the daemon through
      // mirror navigations, and a page the user moved on to stays where it is.
      browserStore.updateBrowser(record.browserId, { url: tab.url, title: tab.title });
    }
    const localBrowserId = record?.browserId ?? tab.browserId;
    if (!openBrowserIds(workspaceKey).has(localBrowserId)) {
      useWorkspaceLayoutStore.getState().openTab({
        workspaceKey,
        target: { kind: "browser", browserId: localBrowserId },
        intent: "background",
      });
    }
  }
}
