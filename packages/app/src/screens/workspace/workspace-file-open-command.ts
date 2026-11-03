import {
  createWorkspaceFileTabTarget,
  normalizeWorkspaceFileLocation,
} from "@/workspace/file-open";
import {
  FOCUSED_PANE_PLACEMENT,
  type WorkspaceTabPlacement,
} from "@/stores/workspace-layout-store";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

interface OpenWorkspaceFileFromExplorerInput {
  filePath: string;
  persistenceKey: string | null;
  openWorkspaceTabInFocusedPane: (
    workspaceKey: string,
    target: WorkspaceTabTarget,
    placement?: WorkspaceTabPlacement,
  ) => string | null;
  revealWorkspaceTab: (workspaceKey: string, tabId: string) => void;
}

export function openWorkspaceFileFromExplorer(input: OpenWorkspaceFileFromExplorerInput): void {
  if (!input.persistenceKey) {
    return;
  }
  const location = normalizeWorkspaceFileLocation({ path: input.filePath });
  if (!location) {
    return;
  }
  const tabId = input.openWorkspaceTabInFocusedPane(
    input.persistenceKey,
    createWorkspaceFileTabTarget(location),
    FOCUSED_PANE_PLACEMENT,
  );
  if (tabId) {
    input.revealWorkspaceTab(input.persistenceKey, tabId);
  }
}
