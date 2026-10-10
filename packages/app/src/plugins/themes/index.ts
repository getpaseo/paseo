import { useMemo } from "react";
import type { PluginThemeContribution } from "@getpaseo/plugin";
import { useHostFeatureMap } from "@/runtime/host-features";
import type { Theme } from "@/styles/theme";
import {
  getPreferredPluginContributionHost,
  rememberPluginContributionHost,
} from "../contribution-host";
import { useInstalledPlugins } from "../registry";
import type { InstalledPlugin } from "../types";
import { buildPluginTheme, type PluginThemeSnapshot } from "./palette";

export interface PluginThemeOption {
  id: string;
  serverId: string;
  name: string;
  swatch: string;
  contribution: PluginThemeContribution;
  theme: Theme;
}

interface PluginThemeTarget {
  serverId: string;
  contribution: PluginThemeContribution;
}

function selectTarget(id: string, targets: PluginThemeTarget[]): PluginThemeTarget {
  const preferredHost = getPreferredPluginContributionHost(id);
  return targets.find((target) => target.serverId === preferredHost) ?? targets[0];
}

export function collectPluginThemes(
  plugins: InstalledPlugin[],
  supportedHosts: ReadonlySet<string>,
): PluginThemeOption[] {
  const targetsById = new Map<string, PluginThemeTarget[]>();
  for (const plugin of plugins) {
    if (!supportedHosts.has(plugin.serverId)) continue;
    for (const contribution of plugin.themes) {
      const id = `${plugin.id}/theme/${contribution.id}`;
      const target = { serverId: plugin.serverId, contribution };
      const targets = targetsById.get(id);
      if (targets) targets.push(target);
      else targetsById.set(id, [target]);
    }
  }

  return [...targetsById].map(([id, targets]) => {
    const target = selectTarget(id, targets);
    return pluginThemeOption({ id, serverId: target.serverId, contribution: target.contribution });
  });
}

/** Builds the option a picker lists, from a live contribution or from a stored snapshot. */
export function pluginThemeOption(source: PluginThemeSnapshot): PluginThemeOption {
  const { id, serverId, contribution } = source;
  return {
    id,
    serverId,
    name: contribution.name,
    swatch: contribution.colors.background,
    contribution,
    theme: buildPluginTheme(contribution),
  };
}

interface ContributedThemeSelection {
  /** The catalog option `pluginThemeId` names, once a host has contributed it. */
  selected: PluginThemeOption | null;
  /** The snapshot to keep in app settings; the stored object itself while it still holds. */
  snapshot: PluginThemeSnapshot | null;
}

/**
 * Plugin themes only exist once a host's plugin catalog has loaded, which takes seconds on a slow
 * connection and starts over after every reconnect. Until then the stored snapshot stands in for
 * the selected theme. It is dropped only when the host that contributed it has loaded its catalog
 * without the theme, so an offline or reconnecting host keeps it.
 */
export function resolveContributedTheme(input: {
  pluginThemeId: string | null;
  options: readonly PluginThemeOption[];
  stored: PluginThemeSnapshot | null;
  loadedHosts: ReadonlySet<string>;
}): ContributedThemeSelection {
  const { pluginThemeId, options, stored, loadedHosts } = input;
  const selected = options.find((option) => option.id === pluginThemeId) ?? null;
  if (selected) {
    const current =
      stored?.id === selected.id &&
      stored.serverId === selected.serverId &&
      samePalette(stored.contribution, selected.contribution);
    return { selected, snapshot: current ? stored : snapshotPluginTheme(selected) };
  }
  if (!stored || stored.id !== pluginThemeId || loadedHosts.has(stored.serverId)) {
    return { selected: null, snapshot: null };
  }
  return { selected: null, snapshot: stored };
}

export function snapshotPluginTheme(option: PluginThemeOption): PluginThemeSnapshot {
  return { id: option.id, serverId: option.serverId, contribution: option.contribution };
}

function samePalette(left: PluginThemeContribution, right: PluginThemeContribution): boolean {
  if (left.id !== right.id || left.name !== right.name || left.appearance !== right.appearance) {
    return false;
  }
  const keys = new Set([...Object.keys(left.colors), ...Object.keys(right.colors)]);
  return [...keys].every(
    (key) =>
      left.colors[key as keyof typeof left.colors] ===
      right.colors[key as keyof typeof right.colors],
  );
}

export function rememberPluginThemeHost(option: PluginThemeOption): void {
  rememberPluginContributionHost(option.id, option.serverId);
}

function supportedThemeHosts(support: ReadonlyMap<string, boolean>): Set<string> {
  const serverIds = new Set<string>();
  for (const [serverId, supported] of support) {
    if (supported) serverIds.add(serverId);
  }
  return serverIds;
}

export function usePluginThemeCatalog(): PluginThemeOption[] {
  const plugins = useInstalledPlugins();
  const serverIds = useMemo(
    () => [...new Set(plugins.map((plugin) => plugin.serverId))],
    [plugins],
  );
  // COMPAT(pluginThemes): added in v0.5.0, remove gate after 2027-08-20.
  const support = useHostFeatureMap(serverIds, "pluginThemes");
  return useMemo(
    () => collectPluginThemes(plugins, supportedThemeHosts(support)),
    [plugins, support],
  );
}
