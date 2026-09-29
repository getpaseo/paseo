import { getDesktopHost } from "@/desktop/host";
import { removeResidentBrowserWebview } from "@/desktop/browser/resident-webviews";
import { useBrowserStore } from "@/desktop/browser/store";
import type { BrowserRecord } from "@/desktop/browser/store/state";
import { useSessionStore } from "@/stores/session-store";
import { collectAllTabs, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";

// Archive is the only unambiguous "done": idle and "finished" fire on every turn end and would
// close a preview the Dev agent still uses.
export function browsersOfArchivedAgents(
  browsersById: Record<string, BrowserRecord>,
  agents: ReadonlyMap<string, { archivedAt?: Date | null }>,
): string[] {
  return Object.values(browsersById)
    .filter((browser) => browser.ownerAgentId && agents.get(browser.ownerAgentId)?.archivedAt)
    .map((browser) => browser.browserId);
}

function closeBrowser(browserId: string): void {
  const layouts = useWorkspaceLayoutStore.getState().layoutByWorkspace;
  for (const [workspaceKey, layout] of Object.entries(layouts)) {
    for (const tab of collectAllTabs(layout.root)) {
      if (tab.target.kind === "browser" && tab.target.browserId === browserId) {
        useWorkspaceLayoutStore.getState().closeTab(workspaceKey, tab.tabId);
      }
    }
  }
  useBrowserStore.getState().removeBrowser(browserId);
  removeResidentBrowserWebview(browserId);
  void getDesktopHost()?.browser?.unregisterWorkspaceBrowser?.(browserId);
}

export function mountBrowserOwnerCleanup(serverId: string): () => void {
  const sweep = () => {
    const agents = useSessionStore.getState().sessions[serverId]?.agents;
    if (!agents) return;
    for (const browserId of browsersOfArchivedAgents(
      useBrowserStore.getState().browsersById,
      agents,
    )) {
      closeBrowser(browserId);
    }
  };
  sweep();
  return useSessionStore.subscribe(sweep);
}
