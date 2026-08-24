import {
  collectAllTabs,
  findPaneById,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-store";

export function getFocusedAgentId(layout: WorkspaceLayout | null): string | null {
  if (!layout) return null;
  const pane = findPaneById(layout.root, layout.focusedPaneId);
  if (!pane?.focusedTabId) return null;
  const tab = collectAllTabs(layout.root).find(
    (candidate) => candidate.tabId === pane.focusedTabId,
  );
  if (tab?.target.kind === "agent") return tab.target.agentId;
  return tab?.target.kind === "plugin" && tab.target.context === "agent"
    ? tab.target.agentId
    : null;
}
