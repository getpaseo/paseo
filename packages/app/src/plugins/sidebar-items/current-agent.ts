import {
  collectAllTabs,
  findPaneById,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-store";
import {
  parseHostAgentRouteFromPathname,
  parseHostWorkspaceRouteFromPathname,
} from "@/utils/host-routes";

/** A sidebar item follows the visible host and focused native conversation. */
export function getPluginSidebarCurrentAgentId(
  serverId: string,
  pathname: string,
  layouts: Readonly<Record<string, WorkspaceLayout>>,
): string | null {
  const direct = parseHostAgentRouteFromPathname(pathname);
  if (direct) return direct.serverId === serverId ? direct.agentId : null;
  const route = parseHostWorkspaceRouteFromPathname(pathname);
  if (!route || route.serverId !== serverId) return null;
  const layout = layouts[`${serverId}:${route.workspaceId}`];
  if (!layout) return null;
  const pane = findPaneById(layout.root, layout.focusedPaneId);
  const tab = collectAllTabs(layout.root).find(
    (candidate) => candidate.tabId === pane?.focusedTabId,
  );
  return tab?.target.kind === "agent" ? tab.target.agentId : null;
}
