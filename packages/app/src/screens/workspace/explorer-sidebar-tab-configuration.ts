import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import { workspaceTabTargetsEqual } from "@/workspace-tabs/identity";
import type { WorkspaceTabLaunchItem } from "@/workspace-tabs/launcher";

export const EXPLORER_SIDEBAR_CONFIGURATION_TRIGGER = {
  kind: "menu",
  labelKey: "workspace.git.actions.moreActions",
  testID: "explorer-sidebar-configuration-menu-trigger",
  titlebarStyle: {
    WebkitAppRegion: "no-drag",
  },
} as const;

export interface ExplorerSidebarConfigurationEntry {
  item: WorkspaceTabLaunchItem;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}

export function buildExplorerSidebarConfigurationEntries({
  items,
  tabs,
  paneId,
  onCloseTab,
}: {
  items: readonly WorkspaceTabLaunchItem[];
  tabs: readonly WorkspaceTabDescriptor[];
  paneId: string;
  onCloseTab: (tabId: string) => Promise<void> | void;
}): ExplorerSidebarConfigurationEntry[] {
  return items.map((item) => {
    const target = item.toggleTarget;
    const tab =
      target === null
        ? null
        : (tabs.find((candidate) => workspaceTabTargetsEqual(target, candidate.target)) ?? null);
    return {
      item,
      selected: Boolean(tab),
      disabled: !tab && item.disabled,
      onSelect: () => {
        if (tab) {
          void onCloseTab(tab.tabId);
          return;
        }
        item.launch({ kind: "open", paneId });
      },
    };
  });
}
