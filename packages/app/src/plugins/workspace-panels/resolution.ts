import type { PluginWorkspacePanelContribution } from "@paseo/plugin";
import type { InstalledPlugin } from "../types";
import type { PluginWorkspaceTabTarget } from "@/workspace-tabs/model";

export function resolvePluginWorkspacePanel(
  plugin: InstalledPlugin | null,
  target: PluginWorkspaceTabTarget,
): PluginWorkspacePanelContribution | null {
  return (
    plugin?.workspacePanels.find(
      (panel) => panel.id === target.panelId && panel.context === target.context,
    ) ?? null
  );
}
