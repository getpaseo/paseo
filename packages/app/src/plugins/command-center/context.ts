import {
  collectAllTabs,
  findPaneById,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-store";
import { getWorkspaceTabAgentId } from "@/workspace-tabs/model";

export function getFocusedAgentId(layout: WorkspaceLayout | null): string | null {
  if (!layout) return null;
  const pane = findPaneById(layout.root, layout.focusedPaneId);
  if (!pane?.focusedTabId) return null;
  const tab = collectAllTabs(layout.root).find(
    (candidate) => candidate.tabId === pane.focusedTabId,
  );
  return tab ? getWorkspaceTabAgentId(tab.target) : null;
}
