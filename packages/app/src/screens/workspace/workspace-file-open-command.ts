import {
  createWorkspaceFileTabTarget,
  normalizeWorkspaceFileLocation,
} from "@/workspace/file-open";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

interface OpenWorkspaceFileFromExplorerInput {
  location: { path: string; lineStart?: number };
  persistenceKey: string | null;
  showMobileAgent: () => void;
  openWorkspaceTabFocused: (workspaceKey: string, target: WorkspaceTabTarget) => string | null;
  focusWorkspaceTab: (workspaceKey: string, tabId: string) => void;
}

export function openWorkspaceFileFromExplorer(input: OpenWorkspaceFileFromExplorerInput): void {
  input.showMobileAgent();
  if (!input.persistenceKey) {
    return;
  }
  const location = normalizeWorkspaceFileLocation(input.location);
  if (!location) {
    return;
  }
  const tabId = input.openWorkspaceTabFocused(
    input.persistenceKey,
    createWorkspaceFileTabTarget(location),
  );
  if (tabId) {
    input.focusWorkspaceTab(input.persistenceKey, tabId);
  }
}
