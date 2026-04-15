import { useEffect } from "react";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import type { WorkspaceTabTarget } from "@/stores/workspace-tabs-store";

/**
 * Listens for `browser_launched` push messages from the daemon and
 * automatically opens the browser tab in a split pane to the right
 * of the currently focused pane.
 */
export function useBrowserLaunchListener(
  serverId: string | null,
  workspaceKey: string | null,
): void {
  const client = useHostRuntimeClient(serverId ?? "");

  useEffect(() => {
    if (!client || !workspaceKey) return;

    const unsubscribe = client.on("browser_launched", (msg: any) => {
      const browserId: string | undefined = msg?.payload?.browserId;
      const url: string | undefined = msg?.payload?.url;
      console.log("[BrowserLaunchListener] received browser_launched", { browserId, url });
      if (!browserId) return;

      const state = useWorkspaceLayoutStore.getState();
      const target: WorkspaceTabTarget = { kind: "browser", browserId, url };

      // Check if a tab for this browser already exists
      const existingTabs = state.getWorkspaceTabs(workspaceKey);
      const alreadyOpen = existingTabs.some(
        (tab) => tab.target.kind === "browser" && tab.target.browserId === browserId,
      );
      if (alreadyOpen) return;

      // Open the browser as a new tab in the current pane (no split)
      const tabId = state.openTab(workspaceKey, target);
      if (tabId) {
        state.focusTab(workspaceKey, tabId);
      }
    });

    return unsubscribe;
  }, [client, workspaceKey]);
}
