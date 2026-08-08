import type { InstalledPlugin, PluginSidebarContribution } from "./types";

const preferredHosts = new Map<string, string>();

export interface PluginSidebarTarget {
  plugin: InstalledPlugin;
  item: PluginSidebarContribution;
}

export interface PluginSidebarGroup {
  key: string;
  pluginId: string;
  contributionId: string;
  title: string;
  icon: string;
  targets: PluginSidebarTarget[];
}

export function groupPluginSidebarContributions(plugins: InstalledPlugin[]): PluginSidebarGroup[] {
  const groups = new Map<string, PluginSidebarGroup>();
  for (const plugin of plugins) {
    for (const item of plugin.sidebarItems) {
      const key = `${plugin.id}/${item.id}`;
      const existing = groups.get(key);
      if (existing) {
        existing.targets.push({ plugin, item });
      } else {
        groups.set(key, {
          key,
          pluginId: plugin.id,
          contributionId: item.id,
          title: item.title,
          icon: item.icon,
          targets: [{ plugin, item }],
        });
      }
    }
  }
  return [...groups.values()];
}

export function getPreferredPluginContributionHost(groupKey: string): string | null {
  return preferredHosts.get(groupKey) ?? null;
}

export function rememberPluginContributionHost(groupKey: string, serverId: string): void {
  preferredHosts.set(groupKey, serverId);
}
