import { callPluginRpc } from "@getpaseo/plugin/host";
import type { PluginCommandCapabilities } from "@getpaseo/plugin";
import type { PluginClientStateSource } from "@getpaseo/plugin/host";
import type { CommandCenterContribution } from "@/command-center/contributions";
import { getCommandCenterIcon } from "@/command-center/icon";
import { resolvePluginIcon } from "../icons";
import type { PluginSurfaceRuntime } from "../surface-runtime";
import type { InstalledPlugin } from "../types";

export interface PluginCommandCenterNavigation {
  openSurface(pluginId: string, surfaceId: string): void;
  openWorkspacePanel(pluginId: string, panelId: string): void;
  openAgentPanel(pluginId: string, panelId: string, agentId: string): void;
}

export interface PluginCommandCenterSource {
  plugins: readonly InstalledPlugin[];
  runtime(pluginId: string): PluginSurfaceRuntime;
  state: PluginClientStateSource;
  workspaceId: string | null;
  agentId: string | null;
  navigation: PluginCommandCenterNavigation;
  reportError(error: unknown): void;
}

function capabilities(
  plugin: InstalledPlugin,
  runtime: PluginSurfaceRuntime,
  navigation: PluginCommandCenterNavigation,
): PluginCommandCapabilities {
  return {
    paseo: runtime.paseo,
    rpc: (contract, input) => callPluginRpc(contract, runtime.invoke, input),
    openSurface(surfaceId) {
      if (!plugin.surfaces.some((surface) => surface.id === surfaceId)) {
        throw new Error(`Plugin surface is unavailable: ${surfaceId}`);
      }
      navigation.openSurface(plugin.id, surfaceId);
    },
  };
}

export function buildPluginCommandCenterContributions(
  source: PluginCommandCenterSource,
): CommandCenterContribution[] {
  const contributions: CommandCenterContribution[] = [];
  for (const plugin of source.plugins) {
    const runtime = source.runtime(plugin.id);
    const common = capabilities(plugin, runtime, source.navigation);
    for (const [rank, item] of plugin.commandCenterItems.entries()) {
      if (item.context === "workspace" && !source.workspaceId) continue;
      if (item.context === "agent" && (!source.workspaceId || !source.agentId)) continue;
      const run = async () => {
        try {
          if (item.context === "global") {
            await item.onSelect({ context: "global", ...common });
            return;
          }
          const workspace = source.workspaceId
            ? source.state.getWorkspace(source.workspaceId)
            : null;
          if (!workspace) return;
          if (item.context === "workspace") {
            await item.onSelect({
              context: "workspace",
              ...common,
              workspace,
              openPanel(panelId) {
                const panel = plugin.workspacePanels.find(
                  (candidate) => candidate.id === panelId && candidate.context === "workspace",
                );
                if (!panel) throw new Error(`Workspace panel is unavailable: ${panelId}`);
                source.navigation.openWorkspacePanel(plugin.id, panelId);
              },
            });
            return;
          }
          const agent = source.agentId ? source.state.getAgent(source.agentId) : null;
          if (!agent) return;
          await item.onSelect({
            context: "agent",
            ...common,
            workspace,
            agent,
            openPanel(panelId) {
              const panel = plugin.workspacePanels.find((candidate) => candidate.id === panelId);
              if (!panel) throw new Error(`Workspace panel is unavailable: ${panelId}`);
              if (panel.context === "workspace") {
                source.navigation.openWorkspacePanel(plugin.id, panelId);
                return;
              }
              source.navigation.openAgentPanel(plugin.id, panelId, agent.id);
            },
          });
        } catch (error) {
          source.reportError(error);
        }
      };
      contributions.push({
        id: `${plugin.id}:${item.id}`,
        group: `plugin:${plugin.id}`,
        groupRank: 5,
        rank,
        keywords: item.keywords ?? [],
        visibility: "always",
        presentation: {
          kind: "action",
          title: item.title,
          sectionTitle: plugin.id,
          icon: getCommandCenterIcon(resolvePluginIcon(item.icon)),
        },
        run,
      });
    }
  }
  return contributions;
}
