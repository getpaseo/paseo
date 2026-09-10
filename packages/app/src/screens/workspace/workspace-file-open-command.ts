import {
  createWorkspaceFileTabTarget,
  normalizeWorkspaceFileLocation,
  type WorkspaceFileLocation,
} from "@/workspace/file-open";
import {
  FOCUSED_PANE_PLACEMENT,
  type WorkspaceTabPlacement,
} from "@/stores/workspace-layout-store";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

interface OpenWorkspaceFileInput {
  location: WorkspaceFileLocation;
  persistenceKey: string | null;
  closeExplorerAfterOpen: boolean;
  showMobileAgent: () => void;
  openWorkspaceTabInFocusedPane: (
    workspaceKey: string,
    target: WorkspaceTabTarget,
    placement?: WorkspaceTabPlacement,
  ) => string | null;
  focusWorkspaceTab: (workspaceKey: string, tabId: string) => void;
  requestFileNavigation: (tabId: string) => void;
}

/**
 * Opens a workspace file in the focused pane and navigates to it.
 *
 * The navigation request is the part callers keep forgetting: a file target is identity-stable, so
 * reopening the same path — or the same occurrence — reuses its tab and would otherwise leave the
 * pane wherever the reader had scrolled it. Every explicit activation asks for a reveal.
 */
export function openWorkspaceFileInFocusedPane(input: OpenWorkspaceFileInput): void {
  if (input.closeExplorerAfterOpen) {
    input.showMobileAgent();
  }
  if (!input.persistenceKey) {
    return;
  }
  const location = normalizeWorkspaceFileLocation(input.location);
  if (!location) {
    return;
  }
  const tabId = input.openWorkspaceTabInFocusedPane(
    input.persistenceKey,
    createWorkspaceFileTabTarget(location),
    FOCUSED_PANE_PLACEMENT,
  );
  if (!tabId) {
    return;
  }
  input.focusWorkspaceTab(input.persistenceKey, tabId);
  input.requestFileNavigation(tabId);
}
