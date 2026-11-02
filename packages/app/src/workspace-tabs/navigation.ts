import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { usePanelStore } from "@/stores/panel-store";

/** Reveals the actual destination after placement and deduplication, including existing tabs. */
export function revealWorkspaceTab(workspaceKey: string, tabId: string | null): string | null {
  if (!tabId) return null;
  const store = useWorkspaceLayoutStore.getState();
  const destination = store.getTabDestination(workspaceKey, tabId);
  // Opening a sheet already reveals it, preserving the surface underneath.
  if (!destination) return null;
  if (destination.kind === "sheet") return tabId;
  store.focusTab(workspaceKey, tabId);
  if (store.layoutMode === "compact") {
    const panels = usePanelStore.getState();
    if (destination.host === "explorer") panels.showMobileFileExplorer();
    else panels.showMobileAgent();
  }
  return tabId;
}
