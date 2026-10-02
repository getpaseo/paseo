import { useCallback, useMemo } from "react";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useAppSettings } from "@/hooks/use-settings";
import type { AppSettings } from "@/hooks/use-settings/storage";
import { useInstalledPlugins } from "@/plugins/registry";
import { groupPluginSidebarItems } from "@/plugins/sidebar-groups";
import {
  moveSidebarNavItem,
  resolveSidebarNavItems,
  setSidebarNavItemVisible,
  type SidebarNavItem,
  type SidebarSection,
} from "./model";

const PREFERENCE_FIELDS = {
  header: "sidebarNavItems",
  footer: "sidebarFooterItems",
} as const satisfies Record<SidebarSection, keyof AppSettings>;

export interface UseSidebarNavItemsReturn<Section extends SidebarSection> {
  /** Every item in the section in display order, hidden ones included. */
  items: SidebarNavItem<Section>[];
  setVisible: (key: string, visible: boolean) => void;
  move: (key: string, direction: "up" | "down") => void;
}

export function useSidebarNavItems<Section extends SidebarSection>(
  section: Section,
): UseSidebarNavItemsReturn<Section> {
  const plugins = useInstalledPlugins();
  const compact = useIsCompactFormFactor();
  const { settings, updateSettings } = useAppSettings();
  const field = PREFERENCE_FIELDS[section];
  const preferences = settings[field];
  const pluginGroups = useMemo(() => groupPluginSidebarItems(plugins, section), [plugins, section]);

  const items = useMemo(
    () => resolveSidebarNavItems({ section, compact, pluginGroups, preferences }),
    [compact, pluginGroups, preferences, section],
  );

  const setVisible = useCallback(
    (key: string, visible: boolean) => {
      void updateSettings((current) => {
        const previous = current[field];
        const currentItems = resolveSidebarNavItems({
          section,
          compact,
          pluginGroups,
          preferences: previous,
        });
        return {
          [field]: setSidebarNavItemVisible({ items: currentItems, key, visible, previous }),
        };
      });
    },
    [compact, field, pluginGroups, section, updateSettings],
  );

  const move = useCallback(
    (key: string, direction: "up" | "down") => {
      void updateSettings((current) => {
        const previous = current[field];
        const currentItems = resolveSidebarNavItems({
          section,
          compact,
          pluginGroups,
          preferences: previous,
        });
        return {
          [field]: moveSidebarNavItem({ items: currentItems, key, direction, previous }),
        };
      });
    },
    [compact, field, pluginGroups, section, updateSettings],
  );

  return { items, setVisible, move };
}
