import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { usePanelStore } from "@/stores/panel-store";
import {
  clearWorkspaceTabAutoFocusSuppression,
  suppressWorkspaceTabAutoFocus,
} from "./tab-navigation-focus";

function revealWorkspaceTabInternal(options: {
  workspaceKey: string;
  tabId: string | null;
  preserveBrowsingFocus: boolean;
}): string | null {
  const { workspaceKey, tabId, preserveBrowsingFocus } = options;
  if (!tabId) return null;
  const store = useWorkspaceLayoutStore.getState();
  const destination = store.getTabDestination(workspaceKey, tabId);
  // Opening a sheet already reveals it, preserving the surface underneath.
  if (!destination) return null;
  if (destination.kind === "sheet") return tabId;
  if (preserveBrowsingFocus) {
    suppressWorkspaceTabAutoFocus(workspaceKey, tabId);
  } else {
    clearWorkspaceTabAutoFocusSuppression(workspaceKey);
  }
  store.focusTab(workspaceKey, tabId);
  const panels = usePanelStore.getState();
  if (store.layoutMode === "compact" && destination.host === "explorer") {
    panels.showMobileFileExplorer();
  } else {
    panels.showMobileAgent();
  }
  return tabId;
}

/** Reveals the actual destination after placement and deduplication, including existing tabs. */
export function revealWorkspaceTab(workspaceKey: string, tabId: string | null): string | null {
  return revealWorkspaceTabInternal({ workspaceKey, tabId, preserveBrowsingFocus: false });
}

/** Reveals `tabId` during relative tab cycling without auto-focusing its composer or terminal. */
export function revealWorkspaceTabPreservingBrowsingFocus(options: {
  workspaceKey: string;
  tabId: string | null;
}): string | null {
  return revealWorkspaceTabInternal({
    workspaceKey: options.workspaceKey,
    tabId: options.tabId,
    preserveBrowsingFocus: true,
  });
}
