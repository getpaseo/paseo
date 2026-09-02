import type { PaneHost } from "@/panels/panel-manifest";
import type { EvaluatedPluginWorkspacePanelContribution } from "@/plugins/types";
import type { PluginWorkspaceTabTarget } from "@/workspace-tabs/model";

interface PluginLaunchCatalogSource {
  readonly id: string;
  readonly serverId: string;
  readonly workspacePanels: readonly EvaluatedPluginWorkspacePanelContribution[];
}

export interface PluginPanelLaunchEntry {
  pluginId: string;
  panel: EvaluatedPluginWorkspacePanelContribution;
  target: PluginWorkspaceTabTarget;
}

export const PRIMARY_LAUNCH_ORDER = [
  "agent",
  "terminal",
  "changes",
  "diff",
  "files",
  "browser",
  "pullRequest",
] as const;

export const SUPPORTING_LAUNCH_ORDER = [
  "changes",
  "diff",
  "files",
  "terminal",
  "agent",
  "browser",
  "pullRequest",
] as const;

export type BuiltInLaunchItemId = (typeof PRIMARY_LAUNCH_ORDER)[number];

export function getBuiltInLaunchOrder(purpose: "primary" | "supporting") {
  return purpose === "supporting" ? SUPPORTING_LAUNCH_ORDER : PRIMARY_LAUNCH_ORDER;
}

export function getPluginPanelLaunchEntries(input: {
  plugins: readonly PluginLaunchCatalogSource[];
  serverId: string;
  host: PaneHost;
  agentId: string | null;
}): PluginPanelLaunchEntry[] {
  const location = input.host === "explorer" ? "explorer" : "workspace";
  const agentId = input.agentId;
  const entries: PluginPanelLaunchEntry[] = [];
  for (const plugin of input.plugins) {
    if (plugin.serverId !== input.serverId) continue;
    for (const panel of plugin.workspacePanels) {
      if (!panel.locations.includes(location)) continue;
      let target: PluginWorkspaceTabTarget;
      if (panel.context === "agent") {
        if (!agentId) continue;
        target = {
          kind: "plugin",
          pluginId: plugin.id,
          panelId: panel.id,
          context: "agent",
          agentId,
        };
      } else {
        target = {
          kind: "plugin",
          pluginId: plugin.id,
          panelId: panel.id,
          context: "workspace",
        };
      }
      entries.push({ pluginId: plugin.id, panel, target });
    }
  }
  return entries;
}
