import { callPluginRpc } from "@getpaseo/plugin/client/host";
import type {
  PluginAgentCommandContext,
  PluginCommandCapabilities,
  PluginPanelLocation,
  PluginScreenParams,
  PluginWorkspaceCommandContext,
} from "@getpaseo/plugin/client";
import type { PluginClientStateSource } from "@getpaseo/plugin/client/host";
import { resolvePluginPanelOpenLocation } from "./workspace-panels/locations";
import { parsePluginOpenScreenInput } from "./surface-contribution";
import type { InstalledPlugin } from "./types";

export interface PluginNavigation {
  openSettings(pluginId: string, screenId: string): void;
  openSurface(pluginId: string, surfaceId: string, params?: PluginScreenParams): void;
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
  navigation: PluginNavigation,
): PluginCommandCapabilities {
  function openScreen(input: unknown) {
    const { screenId, params } = parsePluginOpenScreenInput(plugin, input);
    navigation.openSurface(plugin.id, screenId, params);
  }
  return {
    paseo: plugin.paseo,
    rpc: (contract, input) => callPluginRpc(contract, plugin.invoke, input),
    openSettings(screenId) {
      if (!plugin.settingsScreens.some((screen) => screen.id === screenId))
        throw new Error(`Plugin settings screen is unavailable: ${screenId}`);
      navigation.openSettings(plugin.id, screenId);
    },
    openScreen,
    // COMPAT(pluginSidebarAliases): added in v0.11.0, remove after 2027-03-29
    openSurface: (screenId) => openScreen({ screenId }),
  };
}

export function createPluginAgentActionContext(input: {
  plugin: InstalledPlugin;
  navigation: PluginNavigation;
  state: PluginClientStateSource;
  workspaceId: string;
  agentId: string;
}): PluginAgentCommandContext | null {
  const { plugin, navigation, state, workspaceId, agentId } = input;
  const workspace = state.getWorkspace(workspaceId);
  const agent = state.getAgent(agentId);
  if (!workspace || !agent || agent.workspaceId !== workspace.id) return null;
  return {
    context: "agent",
    ...createPluginCapabilities(plugin, navigation),
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
  navigation: PluginNavigation;
  state: PluginClientStateSource;
  workspaceId: string;
}): PluginWorkspaceCommandContext | null {
  const { plugin, navigation, state, workspaceId } = input;
  const workspace = state.getWorkspace(workspaceId);
  if (!workspace) return null;
  return {
    context: "workspace",
    ...createPluginCapabilities(plugin, navigation),
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
