import type { PluginClientStateSource } from "@getpaseo/plugin/host";
import type { CommandCenterContribution } from "@/command-center/contributions";
import { getCommandCenterIcon } from "@/command-center/icon";
import { resolvePluginIcon } from "../icons";
import { resolvePluginPanelOpenLocation } from "../workspace-panels/locations";
import type { PluginSurfaceRuntime } from "../surface-runtime";
import type { InstalledPlugin } from "../types";
import { createPluginCapabilities, type PluginNavigation } from "../actions";

export interface PluginCommandCenterSource {
  plugins: readonly InstalledPlugin[];
  runtime(pluginId: string): PluginSurfaceRuntime;
  state: PluginClientStateSource;
  workspaceId: string | null;
  agentId: string | null;
  navigation: PluginNavigation;
  reportError(error: unknown): void;
}

export function buildPluginCommandCenterContributions(
  source: PluginCommandCenterSource,
): CommandCenterContribution[] {
  const contributions: CommandCenterContribution[] = [];
  for (const plugin of source.plugins) {
    const runtime = source.runtime(plugin.id);
    const common = createPluginCapabilities(plugin, runtime, source.navigation);
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
              openPanel(panelId, options) {
                const panel = plugin.workspacePanels.find(
                  (candidate) => candidate.id === panelId && candidate.context === "workspace",
                );
                if (!panel) throw new Error(`Workspace panel is unavailable: ${panelId}`);
                const location = resolvePluginPanelOpenLocation(panel, options?.location);
                source.navigation.openWorkspacePanel(plugin.id, panelId, location);
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
            openPanel(panelId, options) {
              const panel = plugin.workspacePanels.find((candidate) => candidate.id === panelId);
              if (!panel) throw new Error(`Workspace panel is unavailable: ${panelId}`);
              const location = resolvePluginPanelOpenLocation(panel, options?.location);
              if (panel.context === "workspace") {
                source.navigation.openWorkspacePanel(plugin.id, panelId, location);
                return;
              }
              source.navigation.openAgentPanel(plugin.id, panelId, agent.id, location);
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
