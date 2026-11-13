import type { PluginIcon } from "@getpaseo/plugin/client";
import type { InstalledPlugin } from "../types";

/** One workspace row badge item, coalesced across every host that contributes it. */
export interface PluginWorkspaceRowBadgeItemGroup {
  /** `<pluginId>/<itemId>`: the key its Show toggle is stored under. */
  key: string;
  pluginId: string;
  itemId: string;
  title: string;
  icon: PluginIcon;
}

export function workspaceRowBadgeItemKey(pluginId: string, itemId: string): string {
  return `${pluginId}/${itemId}`;
}

/** An item missing from the stored record has never been toggled, so it shows. */
export function isWorkspaceRowBadgeItemVisible(
  visibility: Readonly<Record<string, boolean>>,
  key: string,
): boolean {
  return visibility[key] !== false;
}

/** Distinct items in install order, for the Show menu. Each host's copy draws on its own rows. */
export function groupPluginWorkspaceRowBadgeItems(
  plugins: readonly InstalledPlugin[],
): PluginWorkspaceRowBadgeItemGroup[] {
  const groups = new Map<string, PluginWorkspaceRowBadgeItemGroup>();
  for (const plugin of plugins) {
    for (const item of plugin.workspaceRowBadgeItems) {
      const key = workspaceRowBadgeItemKey(plugin.id, item.id);
      if (groups.has(key)) continue;
      groups.set(key, {
        key,
        pluginId: plugin.id,
        itemId: item.id,
        title: plugin.i18n.resolve(item.title, plugin.locale),
        icon: item.icon,
      });
    }
  }
  return [...groups.values()];
}
