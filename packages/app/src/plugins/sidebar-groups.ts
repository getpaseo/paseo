import {
  getPreferredPluginContributionHost,
  legacySidebarItemHostKey,
  pluginScreensHostKey,
} from "./contribution-host";
import type {
  InstalledPlugin,
  PluginSidebarContribution,
  PluginSidebarItemContribution,
  PluginSidebarSection,
} from "./types";

export interface PluginSidebarTarget {
  plugin: InstalledPlugin;
  item: PluginSidebarItemContribution;
}

// COMPAT(pluginSidebarAliases): added in v0.11.0, remove after 2027-03-29
export interface PluginLegacySidebarTarget {
  plugin: InstalledPlugin;
  item: PluginSidebarContribution;
}

interface PluginSidebarGroupBase {
  key: string;
  pluginId: string;
  contributionId: string;
  title: string;
}

/**
 * One sidebar item, coalesced across every host that contributes it. A `legacy` group is an
 * `addSidebarItem` row: the app draws it with its registered icon and it opens its sidebar route.
 */
export type PluginSidebarGroup =
  | (PluginSidebarGroupBase & { kind: "item"; targets: PluginSidebarTarget[] })
  | (PluginSidebarGroupBase & {
      kind: "legacy";
      icon: string;
      targets: PluginLegacySidebarTarget[];
    });

function groupKey(pluginId: string, section: PluginSidebarSection, itemId: string) {
  return section === "header"
    ? legacySidebarItemHostKey(pluginId, itemId)
    : `${pluginId}/sidebar-${section}/${itemId}`;
}

export function groupPluginSidebarItems(
  plugins: InstalledPlugin[],
  section: PluginSidebarSection,
): PluginSidebarGroup[] {
  const groups = new Map<string, PluginSidebarGroup>();
  for (const plugin of plugins) {
    const legacyItems = section === "header" ? plugin.legacySidebarItems : [];
    for (const item of legacyItems) {
      const key = groupKey(plugin.id, section, item.id);
      const existing = groups.get(key);
      if (existing?.kind === "legacy") existing.targets.push({ plugin, item });
      else if (!existing) {
        groups.set(key, {
          kind: "legacy",
          key,
          pluginId: plugin.id,
          contributionId: item.id,
          title: item.title,
          icon: item.icon,
          targets: [{ plugin, item }],
        });
      }
    }
    for (const item of plugin.sidebarItems[section]) {
      const key = groupKey(plugin.id, section, item.id);
      const existing = groups.get(key);
      if (existing?.kind === "item") existing.targets.push({ plugin, item });
      else if (!existing) {
        groups.set(key, {
          kind: "item",
          key,
          pluginId: plugin.id,
          contributionId: item.id,
          title: item.title,
          targets: [{ plugin, item }],
        });
      }
    }
  }
  return [...groups.values()];
}

/**
 * The host a group's row uses: the current route's host, else the remembered one, else the first.
 * A legacy row remembers its own host; other items share the host last used with the plugin's
 * screens.
 */
export function selectPluginSidebarTarget<Group extends PluginSidebarGroup>(
  group: Group,
  currentHostId: string | null,
): Group["targets"][number] {
  const rememberedHostId = getPreferredPluginContributionHost(
    group.kind === "legacy" ? group.key : pluginScreensHostKey(group.pluginId),
  );
  const targets: Group["targets"] = group.targets;
  return (
    targets.find((target) => target.plugin.serverId === currentHostId) ??
    targets.find((target) => target.plugin.serverId === rememberedHostId) ??
    targets[0]
  );
}
