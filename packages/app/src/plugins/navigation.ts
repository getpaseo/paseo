import { buildPluginSettingsRoute } from "./settings/routes";
import { router } from "expo-router";
import type { PluginPanelLocation } from "@getpaseo/plugin/client";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { collectAllTabs, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
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
    openAgent(agentId) {
      navigateToAgent({ serverId, agentId });
    },
    replaceAgent(sourceAgentId, targetAgentId) {
      if (!workspaceId) throw new Error("No active workspace");
      const workspaceKey = `${serverId}:${workspaceId}`;
      const store = useWorkspaceLayoutStore.getState();
      const layout = store.layoutByWorkspace[workspaceKey];
      const tabs = layout ? collectAllTabs(layout.root) : [];
      const sourceTab = tabs.find(
        (tab) => tab.target.kind === "agent" && tab.target.agentId === sourceAgentId,
      );
      const targetTab = tabs.find(
        (tab) => tab.target.kind === "agent" && tab.target.agentId === targetAgentId,
      );
      if (sourceTab) {
        store.unpinAgent(workspaceKey, sourceAgentId);
        store.hideAgent(workspaceKey, sourceAgentId);
      }
      if (sourceTab && targetTab) {
        store.closeTab(workspaceKey, sourceTab.tabId);
        store.focusTab(workspaceKey, targetTab.tabId);
      } else if (sourceTab) {
        store.replaceTab(workspaceKey, sourceTab.tabId, {
          kind: "agent",
          agentId: targetAgentId,
        });
      }
      // Widget actions can originate from a workspace that is not on screen.
      navigateToAgent({ serverId, workspaceId, agentId: targetAgentId });
    },
    openSettings(pluginId, screenId) {
      router.push(buildPluginSettingsRoute(serverId, pluginId, screenId));
    },
    openSurface(pluginId, surfaceId, params) {
      router.push(
        buildPluginSurfaceRoute(serverId, pluginId, { kind: "surface", id: surfaceId }, params),
      );
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
