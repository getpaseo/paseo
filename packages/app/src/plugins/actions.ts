import { callPluginRpc } from "@getpaseo/plugin/client/host";
import type {
  PluginAgentCommandContext,
  PluginCommandCapabilities,
  PluginPanelLocation,
  PluginWorkspaceCommandContext,
} from "@getpaseo/plugin/client";
import type { PluginClientStateSource } from "@getpaseo/plugin/client/host";
import { resolvePluginPanelOpenLocation } from "./workspace-panels/locations";
import type { PluginSurfaceRuntime } from "./surface-runtime";
import type { InstalledPlugin } from "./types";

export interface PluginNavigation {
  openSettings(pluginId: string, screenId: string): void;
  openSurface(pluginId: string, surfaceId: string): void;
  openWorkspacePanel(pluginId: string, panelId: string, location: PluginPanelLocation): void;
  openAgentPanel(
    pluginId: string,
    panelId: string,
    agentId: string,
    location: PluginPanelLocation,
  ): void;
}

export function createPluginCapabilities(
  plugin: InstalledPlugin,
  runtime: PluginSurfaceRuntime,
  navigation: PluginNavigation,
): PluginCommandCapabilities {
  return {
    paseo: runtime.paseo,
    rpc: (contract, input) => callPluginRpc(contract, runtime.invoke, input),
    openSettings(screenId) {
      if (!plugin.settingsScreens.some((screen) => screen.id === screenId))
        throw new Error(`Plugin settings screen is unavailable: ${screenId}`);
      navigation.openSettings(plugin.id, screenId);
    },
    openSurface(surfaceId) {
      if (!plugin.surfaces.some((surface) => surface.id === surfaceId)) {
        throw new Error(`Plugin surface is unavailable: ${surfaceId}`);
      }
      navigation.openSurface(plugin.id, surfaceId);
    },
  };
}

export function createPluginAgentActionContext(input: {
  plugin: InstalledPlugin;
  runtime: PluginSurfaceRuntime;
  navigation: PluginNavigation;
  state: PluginClientStateSource;
  workspaceId: string;
  agentId: string;
}): PluginAgentCommandContext | null {
  const { plugin, runtime, navigation, state, workspaceId, agentId } = input;
  const workspace = state.getWorkspace(workspaceId);
  const agent = state.getAgent(agentId);
  if (!workspace || !agent || agent.workspaceId !== workspace.id) return null;
  return {
    context: "agent",
    ...createPluginCapabilities(plugin, runtime, navigation),
    workspace,
    agent,
    openPanel(panelId, options) {
      const panel = plugin.workspacePanels.find((candidate) => candidate.id === panelId);
      if (!panel) throw new Error(`Workspace panel is unavailable: ${panelId}`);
      const location = resolvePluginPanelOpenLocation(panel, options?.location);
      if (panel.context === "workspace") {
        navigation.openWorkspacePanel(plugin.id, panelId, location);
        return;
      }
      navigation.openAgentPanel(plugin.id, panelId, agent.id, location);
    },
  };
}

export function createPluginWorkspaceActionContext(input: {
  plugin: InstalledPlugin;
  runtime: PluginSurfaceRuntime;
  navigation: PluginNavigation;
  state: PluginClientStateSource;
  workspaceId: string;
}): PluginWorkspaceCommandContext | null {
  const { plugin, runtime, navigation, state, workspaceId } = input;
  const workspace = state.getWorkspace(workspaceId);
  if (!workspace) return null;
  return {
    context: "workspace",
    ...createPluginCapabilities(plugin, runtime, navigation),
    workspace,
    openPanel(panelId, options) {
      const panel = plugin.workspacePanels.find(
        (candidate) => candidate.id === panelId && candidate.context === "workspace",
      );
      if (!panel) throw new Error(`Workspace panel is unavailable: ${panelId}`);
      const location = resolvePluginPanelOpenLocation(panel, options?.location);
      navigation.openWorkspacePanel(plugin.id, panelId, location);
    },
  };
}
