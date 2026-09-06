import { panelSupportsHost } from "@/panels/panel-manifest";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import { workspaceTabTargetsEqual } from "@/workspace-tabs/identity";
import type { WorkspaceTabLaunchGroup, WorkspaceTabLaunchItem } from "@/workspace-tabs/launcher";

export function getExplorerSidebarConfigurationItems(
  groups: readonly WorkspaceTabLaunchGroup[],
): readonly WorkspaceTabLaunchItem[] {
  return groups.flatMap((group) => {
    if (group.id === "plugin-panels") {
      return group.items;
    }
    if (group.id === "tabs") {
      return group.items.filter((item) => !panelSupportsHost(item.panelKind, "main"));
    }
    return [];
  });
}

export function catalogItemMatchesTab(
  item: WorkspaceTabLaunchItem,
  tab: WorkspaceTabDescriptor,
): boolean {
  if (item.pluginTarget) {
    return workspaceTabTargetsEqual(item.pluginTarget, tab.target);
  }
  return item.panelKind === tab.target.kind;
}
