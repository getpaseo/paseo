import type { EvaluatedPluginWorkspacePanelContribution } from "../types";
import type { InstalledPlugin } from "../types";
import type { PluginWorkspaceTabTarget } from "@/workspace-tabs/model";

export function resolvePluginWorkspacePanel(
  plugin: InstalledPlugin | null,
  target: PluginWorkspaceTabTarget,
): EvaluatedPluginWorkspacePanelContribution | null {
  return (
    plugin?.workspacePanels.find(
      (panel) => panel.id === target.panelId && panel.context === target.context,
    ) ?? null
  );
}
