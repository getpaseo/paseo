import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import {
  canDismissPaneInLayout,
  collectAllPanes,
  findPaneById,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-store";

interface CloseTabsRequest {
  tabsToClose: WorkspaceTabDescriptor[];
  title: string;
  logLabel: string;
}

interface ExecuteCloseWorkspacePaneActionInput {
  layout: WorkspaceLayout;
  paneId: string;
  explorerSidebarPaneId?: string | null;
  tabsById: ReadonlyMap<string, WorkspaceTabDescriptor>;
  title: string;
  canMoveTabsToPane: (tabIds: readonly string[], paneId: string) => boolean;
  closeTabs: (input: CloseTabsRequest) => Promise<boolean>;
  moveTabToPane: (tabId: string, paneId: string) => boolean;
  closePane: (paneId: string) => void;
}

export async function executeCloseWorkspacePaneAction(
  input: ExecuteCloseWorkspacePaneActionInput,
): Promise<boolean> {
  const pane = findPaneById(input.layout.root, input.paneId);
  if (!pane || !canDismissPaneInLayout(input.layout, input.paneId, input.explorerSidebarPaneId)) {
    return false;
  }

  const destinationPane = collectAllPanes(input.layout.root).find(
    (candidate) => candidate.id !== input.paneId && candidate.id !== input.explorerSidebarPaneId,
  );
  if (!destinationPane) {
    return false;
  }

  const pinnedTabIds: string[] = [];
  const tabsToClose: WorkspaceTabDescriptor[] = [];
  for (const tabId of pane.tabIds) {
    const descriptor = input.tabsById.get(tabId);
    if (descriptor?.isPinned === true) {
      pinnedTabIds.push(tabId);
    } else if (descriptor) {
      tabsToClose.push(descriptor);
    }
  }

  if (pinnedTabIds.length > 0 && !input.canMoveTabsToPane(pinnedTabIds, destinationPane.id)) {
    return false;
  }

  const closed = await input.closeTabs({
    tabsToClose,
    title: input.title,
    logLabel: "from pane close",
  });
  if (!closed) {
    return false;
  }

  for (const tabId of pinnedTabIds) {
    if (!input.moveTabToPane(tabId, destinationPane.id)) {
      return false;
    }
  }
  input.closePane(input.paneId);
  return true;
}
