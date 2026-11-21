import { router } from "expo-router";
import { pluginRegistry } from "@/plugins/registry";
import { parsePluginSurfaceRoute } from "@/plugins/routes";
import { resolvePluginSurfaceContribution } from "@/plugins/surface-contribution";
import {
  navigateToWorkspace,
  type ActiveWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { revealWorkspaceTab } from "@/workspace-tabs/navigation";
import { appVisitHistory, type AppVisitDirection } from "./app-visit-history";

export function navigateAppVisitHistory(
  direction: AppVisitDirection,
  pathname: string,
  activeWorkspace: ActiveWorkspaceSelection | null,
): void {
  const sessions = useSessionStore.getState().sessions;
  const layout = useWorkspaceLayoutStore.getState();
  const activeRoute = activeWorkspace ?? parsePluginSurfaceRoute(pathname);
  const replay = appVisitHistory.move(direction, activeRoute, (candidate) => {
    if (candidate.kind === "plugin") {
      const plugin = pluginRegistry
        .getSnapshot()
        .find(({ serverId, id }) => serverId === candidate.serverId && id === candidate.pluginId);
      return Boolean(resolvePluginSurfaceContribution(plugin ?? null, candidate.identity).surface);
    }

    const workspace = resolveWorkspaceMapKeyByIdentity({
      workspaces: sessions[candidate.serverId]?.workspaces,
      workspaceId: candidate.workspaceId,
    });
    const key = buildWorkspaceTabPersistenceKey(candidate);
    if (!workspace || !key) return false;
    return candidate.tabId
      ? layout.getTabDestination(key, candidate.tabId)?.kind === "pane"
      : layout.getWorkspaceTabs(key).length === 0;
  });
  if (!replay) return;

  const { visit, navigateRoute } = replay;
  if (visit.kind === "plugin") {
    router.dismissTo(visit.href);
    return;
  }
  if (navigateRoute) {
    navigateToWorkspace({ serverId: visit.serverId, workspaceId: visit.workspaceId });
  }
  const key = buildWorkspaceTabPersistenceKey(visit);
  if (key) revealWorkspaceTab(key, visit.tabId);
}
