import { useCallback, useMemo } from "react";
import { useAppSettings } from "@/hooks/use-settings";
import { useInstalledPlugins } from "@/plugins/registry";
import { groupPluginSidebarContributions } from "@/plugins/sidebar-groups";
import {
  moveSidebarNavItem,
  resolveSidebarNavItems,
  setSidebarNavItemVisible,
  type SidebarNavItem,
} from "./model";

export interface UseSidebarNavItemsReturn {
  /** Every top-level item in display order, hidden ones included. */
  items: SidebarNavItem[];
  setVisible: (key: string, visible: boolean) => void;
  move: (key: string, direction: "up" | "down") => void;
}

export function useSidebarNavItems(): UseSidebarNavItemsReturn {
  const plugins = useInstalledPlugins();
  const { settings, updateSettings } = useAppSettings();
  const preferences = settings.sidebarNavItems;

  const items = useMemo(
    () =>
      resolveSidebarNavItems({
        pluginGroups: groupPluginSidebarContributions(plugins),
        preferences,
      }),
    [plugins, preferences],
  );

  const setVisible = useCallback(
    (key: string, visible: boolean) => {
      void updateSettings({
        sidebarNavItems: setSidebarNavItemVisible({ items, key, visible, previous: preferences }),
      });
    },
    [items, preferences, updateSettings],
  );

  const move = useCallback(
    (key: string, direction: "up" | "down") => {
      void updateSettings({
        sidebarNavItems: moveSidebarNavItem({ items, key, direction, previous: preferences }),
      });
    },
    [items, preferences, updateSettings],
  );

  return { items, setVisible, move };
}
