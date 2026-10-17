import { buildPluginSettingsRoute } from "./settings/routes";
import { router } from "expo-router";
import type { PluginPanelLocation } from "@getpaseo/plugin/client";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import {
  collectAllTabs,
  findPaneById,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { buildPluginSurfaceRoute } from "./routes";
import type { PluginNavigation } from "./actions";

// Internal tab operations shared by foreground navigation and external plan actions.
export function createBackgroundAgentNavigation(input: {
  serverId: string;
  workspaceId: string;
}): Required<Pick<PluginNavigation, "openAgent" | "replaceAgent">> {
  const workspaceKey = `${input.serverId}:${input.workspaceId}`;
  function openAgent(agentId: string) {
    useWorkspaceLayoutStore.getState().openTab({
      workspaceKey,
      target: { kind: "agent", agentId },
      intent: "background",
    });
  }
  return {
    openAgent,
    replaceAgent(sourceAgentId, targetAgentId) {
      if (sourceAgentId === targetAgentId) {
        openAgent(targetAgentId);
        return;
      }
      const store = useWorkspaceLayoutStore.getState();
      const layout = store.layoutByWorkspace[workspaceKey];
      const tabs = layout ? collectAllTabs(layout.root) : [];
      const sources = tabs.filter(
        (tab) => tab.target.kind === "agent" && tab.target.agentId === sourceAgentId,
      );
      const focusedTabId = layout
        ? findPaneById(layout.root, layout.focusedPaneId)?.focusedTabId
        : undefined;
      const focusedSource = sources.find((tab) => tab.tabId === focusedTabId);
      let targetTabId = tabs.find(
        (tab) => tab.target.kind === "agent" && tab.target.agentId === targetAgentId,
      )?.tabId;
      store.unpinAgent(workspaceKey, sourceAgentId);
      store.hideAgent(workspaceKey, sourceAgentId);
      const replacement = focusedSource ?? sources[0];
      if (!targetTabId && replacement) {
        targetTabId =
          store.replaceTab(workspaceKey, replacement.tabId, {
            kind: "agent",
            agentId: targetAgentId,
          }) ?? undefined;
      }
      for (const source of sources) {
        if (source.tabId !== targetTabId) store.closeTab(workspaceKey, source.tabId);
      }
      if (!targetTabId) openAgent(targetAgentId);
      if (focusedSource && targetTabId) store.focusTab(workspaceKey, targetTabId);
      else if (focusedTabId) store.focusTab(workspaceKey, focusedTabId);
    },
  };
}

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
      createBackgroundAgentNavigation({ serverId, workspaceId }).replaceAgent(
        sourceAgentId,
        targetAgentId,
      );
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
