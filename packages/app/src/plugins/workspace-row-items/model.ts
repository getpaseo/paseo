import type { PluginIcon } from "@getpaseo/plugin/client";
import type { InstalledPlugin } from "../types";

/** One workspace row item, coalesced across every host that contributes it. */
export interface PluginWorkspaceRowItemGroup {
  /** `<pluginId>/<itemId>`: the key its Show toggle is stored under. */
  key: string;
  pluginId: string;
  itemId: string;
  title: string;
  icon: PluginIcon;
}

export function workspaceRowItemKey(pluginId: string, itemId: string): string {
  return `${pluginId}/${itemId}`;
}

/** An item missing from the stored record has never been toggled, so it shows. */
export function isWorkspaceRowItemVisible(
  visibility: Readonly<Record<string, boolean>>,
  key: string,
): boolean {
  return visibility[key] !== false;
}

/** Distinct items in install order, for the Show menu. Each host's copy draws on its own rows. */
export function groupPluginWorkspaceRowItems(
  plugins: readonly InstalledPlugin[],
): PluginWorkspaceRowItemGroup[] {
  const groups = new Map<string, PluginWorkspaceRowItemGroup>();
  for (const plugin of plugins) {
    for (const item of plugin.workspaceRowItems) {
      const key = workspaceRowItemKey(plugin.id, item.id);
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
