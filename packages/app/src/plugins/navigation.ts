import { router } from "expo-router";
import type { PluginPanelLocation } from "@getpaseo/plugin";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildPluginSurfaceRoute } from "./routes";
import type { PluginNavigation } from "./actions";

export function createPluginNavigation(input: {
  serverId: string;
  workspaceId: string | null;
}): PluginNavigation {
  const { serverId, workspaceId } = input;
  function placement(location: PluginPanelLocation) {
    if (location !== "explorer") return undefined;
    if (!workspaceId) throw new Error("No active workspace");
    const workspaceKey = `${serverId}:${workspaceId}`;
    const paneId = useWorkspaceLayoutStore.getState().showExplorerSidebar(workspaceKey);
    if (!paneId) throw new Error("Explorer is unavailable");
    return { mode: "pane" as const, paneId };
  }
  return {
    openSurface(pluginId, surfaceId) {
      router.push(buildPluginSurfaceRoute(serverId, pluginId, { kind: "surface", id: surfaceId }));
    },
    openWorkspacePanel(pluginId, panelId, location) {
      if (!workspaceId) throw new Error("No active workspace");
      navigateToWorkspace({
        serverId,
        workspaceId,
        target: { kind: "plugin", pluginId, panelId, context: "workspace" },
        placement: placement(location),
      });
    },
    openAgentPanel(pluginId, panelId, agentId, location) {
      if (!workspaceId) throw new Error("No active workspace");
      navigateToWorkspace({
        serverId,
        workspaceId,
        target: { kind: "plugin", pluginId, panelId, context: "agent", agentId },
        placement: placement(location),
      });
    },
  };
}
