import { useEffect } from "react";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { findPaneContainingTab, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import type { WorkspaceTabTarget } from "@/stores/workspace-tabs-store";

/**
 * Listens for `browser_launched` push messages from the daemon and places
 * the browser tab in the UI.
 *
 * Single-visible-browser invariant: the agent has one browser tab at a
 * time, always rendered alongside the chat. The three cases:
 *
 *   1. A tab already exists with the SAME `browserId` → focus it.
 *   2. A tab exists for a DIFFERENT browserId (stale after a daemon
 *      restart or a `browser_close` + `browser_launch` cycle) → open the
 *      new tab IN THE SAME PANE as the stale one, then close the stale.
 *      This preserves the user's split layout — if they put the browser
 *      in a specific pane, new launches keep showing up there.
 *   3. No browser tab exists → split the focused pane to the right and
 *      open the new tab in the split. Keeps the chat visible next to the
 *      browser on first launch.
 */
export function useBrowserLaunchListener(
  serverId: string | null,
  workspaceKey: string | null,
): void {
  const client = useHostRuntimeClient(serverId ?? "");

  useEffect(() => {
    if (!client || !workspaceKey) return;

    // Daemon sends this right after a session connects, so a client that
    // held onto browser tabs across a daemon restart can drop the ones
    // the daemon no longer tracks. Without this, stale tabs silently
    // time out on every agent interaction until the user closes them.
    console.log("[BrowserLaunchListener] mounted, registering listeners for", workspaceKey);
    const unsubscribeActive = client.on("browser_active_list" as any, (msg: any) => {
      const activeIds = new Set<string>(
        Array.isArray(msg?.payload?.browserIds) ? msg.payload.browserIds : [],
      );
      const state = useWorkspaceLayoutStore.getState();
      const tabs = state.getWorkspaceTabs(workspaceKey);
      const browserTabs = tabs.filter((t) => t.target.kind === "browser");
      console.log(
        "[BrowserLaunchListener] received browser_active_list — server active:",
        Array.from(activeIds),
        "client browser tabs:",
        browserTabs.map((t) => (t.target.kind === "browser" ? t.target.browserId : "?")),
      );
      const stale = browserTabs.filter(
        (tab) => tab.target.kind === "browser" && !activeIds.has(tab.target.browserId),
      );
      if (stale.length === 0) return;
      console.log(
        "[BrowserLaunchListener] dropping stale tabs:",
        stale.map((t) => (t.target.kind === "browser" ? t.target.browserId : "?")),
      );
      for (const tab of stale) {
        state.closeTab(workspaceKey, tab.tabId);
      }
    });

    // Defined first because the WS callback below schedules it via
    // queueMicrotask — moving this above the `client.on` call avoids
    // any temporal-dead-zone confusion.
    const applyLaunch = (browserId: string, url: string | undefined) => {
      const state = useWorkspaceLayoutStore.getState();
      const target: WorkspaceTabTarget = { kind: "browser", browserId, url };

      // Case 1: matching tab → focus.
      const existingTabs = state.getWorkspaceTabs(workspaceKey);
      const matching = existingTabs.find(
        (tab) => tab.target.kind === "browser" && tab.target.browserId === browserId,
      );
      if (matching) {
        state.focusTab(workspaceKey, matching.tabId);
        return;
      }

      // Case 2: stale browser tab → open new in its pane, then drop the old.
      const stale = existingTabs.filter((tab) => tab.target.kind === "browser");
      if (stale.length > 0) {
        const layout = state.layoutByWorkspace[workspaceKey];
        const stalePane = layout ? findPaneContainingTab(layout.root, stale[0]!.tabId) : null;
        if (stalePane) {
          // Focus the pane that held the stale browser BEFORE opening, so
          // openTab lands there (the store's openTab targets the focused
          // pane). Then close the stale tabs — the pane stays alive
          // because the freshly-opened tab keeps it populated.
          state.focusPane(workspaceKey, stalePane.id);
          const tabId = state.openTab(workspaceKey, target);
          if (tabId) state.focusTab(workspaceKey, tabId);
          for (const tab of stale) {
            state.closeTab(workspaceKey, tab.tabId);
          }
          return;
        }
        // Pane vanished (layout got restructured) — fall through to the
        // fresh-launch path after cleaning up stale tab records.
        for (const tab of stale) {
          state.closeTab(workspaceKey, tab.tabId);
        }
      }

      // Case 3: fresh launch with no prior browser tab anywhere → split.
      const layout = state.layoutByWorkspace[workspaceKey];
      const focusedPaneId = layout?.focusedPaneId ?? null;
      if (focusedPaneId) {
        const newPaneId = state.splitPaneEmpty(workspaceKey, {
          targetPaneId: focusedPaneId,
          position: "right",
        });
        if (newPaneId) {
          const tabId = state.openTab(workspaceKey, target);
          if (tabId) state.focusTab(workspaceKey, tabId);
          return;
        }
      }
      const tabId = state.openTab(workspaceKey, target);
      if (tabId) state.focusTab(workspaceKey, tabId);
    };

    // Close the tab when the server confirms a `browser_close` — without
    // this, the MCP tool `browser_close` succeeds server-side but the
    // UI pane stays open because the client has no way to know.
    const unsubscribeClosed = client.on("browser_closed" as any, (msg: any) => {
      const closedId = String(msg?.payload?.browserId ?? "");
      if (!closedId) return;
      console.log("[BrowserLaunchListener] received browser_closed", closedId);
      const state = useWorkspaceLayoutStore.getState();
      const tabs = state.getWorkspaceTabs(workspaceKey);
      const tab = tabs.find((t) => t.target.kind === "browser" && t.target.browserId === closedId);
      if (tab) state.closeTab(workspaceKey, tab.tabId);
    });

    const unsubscribe = client.on("browser_launched", (msg: any) => {
      const browserId: string | undefined = msg?.payload?.browserId;
      const url: string | undefined = msg?.payload?.url;
      console.log("[BrowserLaunchListener] received browser_launched", { browserId, url });
      if (!browserId) return;

      // Defer the cascade of layout mutations (splitPane + openTab +
      // focusTab + closeTab…) to the next microtask so we don't fire
      // them inside the WS message callback. Running them synchronously
      // triggers "Internal React error: Expected static flag was
      // missing" — React's reconciler gets confused when a layout tree
      // is rebuilt mid-commit. The microtask defer makes the mutations
      // run as a plain event, after the current render pass has
      // finished, and React batches them cleanly.
      queueMicrotask(() => applyLaunch(browserId, url));
    });

    return () => {
      try {
        unsubscribe();
      } catch {}
      try {
        unsubscribeActive();
      } catch {}
      try {
        unsubscribeClosed();
      } catch {}
    };
  }, [client, workspaceKey]);
}
