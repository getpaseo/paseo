import type { WorkspaceTab, WorkspaceTabTarget } from "@/workspace-tabs/model";
import {
  deriveWorkspacePaneState,
  type WorkspaceDerivedTab,
} from "@/screens/workspace/workspace-pane-state";

export interface WorkspaceTabModel {
  tabs: WorkspaceDerivedTab[];
  activeTabId: string | null;
  activeTab: WorkspaceDerivedTab | null;
}

export function deriveWorkspaceTabModel(input: {
  tabs: WorkspaceTab[];
  focusedTabId?: string | null;
  preferredTarget?: WorkspaceTabTarget | null;
}): WorkspaceTabModel {
  const paneState = deriveWorkspacePaneState({
    tabs: input.tabs,
    focusedTabId: input.focusedTabId,
    preferredTarget: input.preferredTarget,
  });
  return {
    tabs: paneState.tabs,
    activeTabId: paneState.activeTabId,
    activeTab: paneState.activeTab,
  };
}
