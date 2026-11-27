import type { PluginIcon, WorkspaceRowBadgeItem } from "@getpaseo/plugin/client";
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

/** The entries a sidebar view asked for, in its order; all of them when it named none. Unknown keys are skipped. */
export function pickWorkspaceRowBadgeItems<Entry>(
  entries: readonly Entry[],
  keyOf: (entry: Entry) => string,
  keys: readonly string[] | undefined,
): readonly Entry[] {
  if (!keys) return entries;
  return keys.flatMap((key) => entries.filter((entry) => keyOf(entry) === key));
}

/** Items a sidebar view may draw: the visible ones, each with the hosts that contribute it. */
export function listWorkspaceRowBadgeItems(
  plugins: readonly InstalledPlugin[],
  visibility: Readonly<Record<string, boolean>>,
): WorkspaceRowBadgeItem[] {
  const items = new Map<string, { item: WorkspaceRowBadgeItem; hostIds: string[] }>();
  for (const plugin of plugins) {
    for (const contribution of plugin.workspaceRowBadgeItems) {
      const key = workspaceRowBadgeItemKey(plugin.id, contribution.id);
      if (!isWorkspaceRowBadgeItemVisible(visibility, key)) continue;
      const listed = items.get(key);
      if (listed) {
        listed.hostIds.push(plugin.serverId);
        continue;
      }
      const hostIds = [plugin.serverId];
      items.set(key, {
        hostIds,
        item: {
          key,
          pluginId: plugin.id,
          itemId: contribution.id,
          title: plugin.i18n.resolve(contribution.title, plugin.locale),
          icon: contribution.icon,
          hostIds,
        },
      });
    }
  }
  return [...items.values()].map((entry) => entry.item);
}
