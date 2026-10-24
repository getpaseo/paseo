import { buildPluginSettingsRoute } from "./settings/routes";
import { router } from "expo-router";
import type { PluginPanelLocation } from "@getpaseo/plugin/client";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import {
  collectAllTabs,
  createWorkspaceLayoutWithExplorerSidebar,
  findPaneById,
  resolveExplorerSidebarPaneId,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { workspaceTabTargetsEqual } from "@/workspace-tabs/identity";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
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
  /** Adds the panel without navigating, showing Explorer, or changing a visible tab. */
  function openInBackground(target: WorkspaceTabTarget, location: PluginPanelLocation) {
    if (!workspaceId) throw new Error("No active workspace");
    const workspaceKey = `${serverId}:${workspaceId}`;
    const store = useWorkspaceLayoutStore.getState();
    if (location !== "explorer") {
      store.openTab({ workspaceKey, target, intent: "background" });
      return;
    }
    const layout =
      store.layoutByWorkspace[workspaceKey] ?? createWorkspaceLayoutWithExplorerSidebar();
    const paneId = resolveExplorerSidebarPaneId(
      layout,
      store.explorerSidebarPaneIdByWorkspace[workspaceKey],
    );
    if (!paneId) throw new Error("Explorer is unavailable");
    // A new tab can be selected inside a hidden Explorer because nothing on screen changes.
    const selectable =
      findPaneById(layout.root, paneId)?.hidden === true &&
      !collectAllTabs(layout.root).some((tab) => workspaceTabTargetsEqual(tab.target, target));
    store.openTab({
      workspaceKey,
      target,
      intent: selectable ? "reveal" : "background",
      placement: { mode: "prefer", paneId },
    });
  }
  return {
    openSettings(pluginId, screenId) {
      router.push(buildPluginSettingsRoute(serverId, pluginId, screenId));
    },
    openSurface(pluginId, surfaceId, params) {
      router.push(
        buildPluginSurfaceRoute(serverId, pluginId, { kind: "surface", id: surfaceId }, params),
      );
    },
    openWorkspacePanel(pluginId, panelId, location, background) {
      if (!workspaceId) throw new Error("No active workspace");
      const target = { kind: "plugin", pluginId, panelId, context: "workspace" } as const;
      if (background) {
        openInBackground(target, location);
        return;
      }
      navigateToWorkspace({ serverId, workspaceId, target, placement: placement(location) });
    },
    openAgentPanel(pluginId, panelId, agentId, location, background) {
      if (!workspaceId) throw new Error("No active workspace");
      const target = { kind: "plugin", pluginId, panelId, context: "agent", agentId } as const;
      if (background) {
        openInBackground(target, location);
        return;
      }
      navigateToWorkspace({ serverId, workspaceId, target, placement: placement(location) });
    },
  };
}
