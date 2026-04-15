import { useCallback } from "react";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import type { WorkspaceTabTarget } from "@/stores/workspace-tabs-store";

/**
 * Opens a browser tab in split-screen next to the currently focused pane.
 *
 * Usage:
 * ```ts
 * const openBrowserTab = useOpenBrowserTab();
 * openBrowserTab({ workspaceKey, browserId, focusedPaneId });
 * ```
 */
export function useOpenBrowserTab() {
  const openTab = useWorkspaceLayoutStore((s) => s.openTab);
  const splitPaneEmpty = useWorkspaceLayoutStore((s) => s.splitPaneEmpty);
  const focusTab = useWorkspaceLayoutStore((s) => s.focusTab);

  return useCallback(
    (input: { workspaceKey: string; browserId: string; focusedPaneId: string | null }) => {
      const { workspaceKey, browserId, focusedPaneId } = input;
      const target: WorkspaceTabTarget = { kind: "browser", browserId };

      if (focusedPaneId) {
        // Create a new pane to the right, then open the tab in it
        const newPaneId = splitPaneEmpty(workspaceKey, {
          targetPaneId: focusedPaneId,
          position: "right",
        });
        if (newPaneId) {
          const tabId = openTab(workspaceKey, target);
          if (tabId) {
            focusTab(workspaceKey, tabId);
          }
          return tabId;
        }
      }

      // Fallback: just open the tab (no split)
      const tabId = openTab(workspaceKey, target);
      if (tabId) {
        focusTab(workspaceKey, tabId);
      }
      return tabId;
    },
    [openTab, splitPaneEmpty, focusTab],
  );
}
