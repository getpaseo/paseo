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
  const pluginGroups = useMemo(() => groupPluginSidebarContributions(plugins), [plugins]);

  const items = useMemo(
    () =>
      resolveSidebarNavItems({
        pluginGroups,
        preferences,
      }),
    [pluginGroups, preferences],
  );

  const setVisible = useCallback(
    (key: string, visible: boolean) => {
      void updateSettings((current) => {
        const previous = current.sidebarNavItems;
        const currentItems = resolveSidebarNavItems({ pluginGroups, preferences: previous });
        return {
          sidebarNavItems: setSidebarNavItemVisible({
            items: currentItems,
            key,
            visible,
            previous,
          }),
        };
      });
    },
    [pluginGroups, updateSettings],
  );

  const move = useCallback(
    (key: string, direction: "up" | "down") => {
      void updateSettings((current) => {
        const previous = current.sidebarNavItems;
        const currentItems = resolveSidebarNavItems({ pluginGroups, preferences: previous });
        return {
          sidebarNavItems: moveSidebarNavItem({
            items: currentItems,
            key,
            direction,
            previous,
          }),
        };
      });
    },
    [pluginGroups, updateSettings],
  );

  return { items, setVisible, move };
}
