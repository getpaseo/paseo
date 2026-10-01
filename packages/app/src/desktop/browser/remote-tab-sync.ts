import { getIsElectron } from "@/constants/platform";
import type { BrowserMirrorEvent } from "@getpaseo/protocol/browser-activity/rpc-schemas";
import { publishBrowserMirror } from "@/desktop/browser/mirror";
import { isRemoteBrowserClosed, useBrowserStore } from "@/desktop/browser/store";
import { duplicateRemoteBrowserRecordIds } from "@/desktop/browser/remote-tab-records";
import { collectAllTabs, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";

let remoteNewTabsInFlight = 0;
let nextSyncSequence = 0;
const appliedSyncSequences = new Map<string, number>();

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

export function beginRemoteBrowserTabSync(workspaceKey: string) {
  return { sequence: ++nextSyncSequence, browserIds: openBrowserIds(workspaceKey) };
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

function removeClosedRemoteBrowserTabs(
  workspaceKey: string,
  candidates: ReadonlySet<string>,
  listedIds: ReadonlySet<string>,
): void {
  if (remoteNewTabsInFlight > 0) return;
  for (const browserId of openBrowserIds(workspaceKey)) {
    const record = useBrowserStore.getState().browsersById[browserId];
    if (
      candidates.has(browserId) &&
      record?.remoteBrowserId === browserId &&
      !listedIds.has(browserId)
    ) {
      closeLocalBrowserTab(workspaceKey, browserId);
    }
  }
}

export function syncRemoteBrowserTabs(input: {
  tabs: readonly ListedRemoteTab[];
  workspaceId: string;
  workspaceKey: string;
  request: ReturnType<typeof beginRemoteBrowserTabSync>;
  serverId?: string;
  mirrorEvents?: readonly BrowserMirrorEvent[];
}): void {
  const { workspaceId, workspaceKey } = input;
  if (input.request.sequence <= (appliedSyncSequences.get(workspaceKey) ?? 0)) return;
  appliedSyncSequences.set(workspaceKey, input.request.sequence);
  const tabs = input.tabs.filter((tab) => !tab.workspaceId || tab.workspaceId === workspaceId);
  removeClosedRemoteBrowserTabs(
    workspaceKey,
    input.request.browserIds,
    new Set(tabs.map((tab) => tab.browserId)),
  );
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
  for (const tab of tabs) {
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
