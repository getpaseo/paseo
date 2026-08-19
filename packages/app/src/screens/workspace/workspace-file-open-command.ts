import {
  createWorkspaceFileTabTarget,
  normalizeWorkspaceFileLocation,
} from "@/workspace/file-open";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

interface OpenWorkspaceFileFromExplorerInput {
  filePath: string;
  persistenceKey: string | null;
  showMobileAgent: () => void;
  openWorkspaceTabInFocusedPane: (
    workspaceKey: string,
    target: WorkspaceTabTarget,
  ) => string | null;
  focusWorkspaceTab: (workspaceKey: string, tabId: string) => void;
}

export function openWorkspaceFileFromExplorer(input: OpenWorkspaceFileFromExplorerInput): void {
  input.showMobileAgent();
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
  );
  if (tabId) {
    input.focusWorkspaceTab(input.persistenceKey, tabId);
  }
}
