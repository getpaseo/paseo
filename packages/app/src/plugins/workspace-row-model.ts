import type { EvaluatedWorkspaceRowAccessory, InstalledPlugin } from "./types";

export interface WorkspaceRowAccessoryTarget {
  plugin: InstalledPlugin;
  accessory: EvaluatedWorkspaceRowAccessory;
}

/** A row has one leading slot: the most recently registered accessory of its host wins. */
export function selectWorkspaceRowAccessory(
  plugins: readonly InstalledPlugin[],
  serverId: string,
): WorkspaceRowAccessoryTarget | null {
  let target: WorkspaceRowAccessoryTarget | null = null;
  for (const plugin of plugins.filter((candidate) => candidate.serverId === serverId)) {
    for (const accessory of plugin.workspaceRowAccessories) {
      if (!target || accessory.sequence > target.accessory.sequence) target = { plugin, accessory };
    }
  }
  return target;
}

function largeAccessoryHosts(plugins: readonly InstalledPlugin[]): string[] {
  const hosts = plugins
    .filter((plugin) => plugin.workspaceRowAccessories.some((entry) => entry.size === "large"))
    .map((plugin) => plugin.serverId);
  return [...new Set(hosts)].sort();
}

/**
 * Titles keep one rail across hosts: one large accessory anywhere widens every row's slot. Rows
 * render before their host's plugins evaluate, so a host remembered from the last launch holds
 * the rail until its catalog is evaluated, instead of the titles jumping when it is.
 */
export function hasLargeWorkspaceRowAccessory(
  plugins: readonly InstalledPlugin[],
  rememberedHosts: readonly string[],
  hasCatalog: (serverId: string) => boolean,
): boolean {
  return (
    largeAccessoryHosts(plugins).length > 0 ||
    rememberedHosts.some((serverId) => !hasCatalog(serverId))
  );
}

// A remembered host holds the rail only while its catalog may still arrive: at most this long
// in a row (at launch or after a disconnect), so an offline or removed host cannot keep every
// row wide.
export const LARGE_RAIL_MEMORY_GRACE_MS = 30_000;

/** Hosts to remember: those with a large accessory now, plus remembered ones still loading. */
export function nextLargeRailMemory(
  remembered: readonly string[],
  plugins: readonly InstalledPlugin[],
  hasCatalog: (serverId: string) => boolean,
  pendingFor: (serverId: string) => number,
): string[] {
  const pending = remembered.filter(
    (serverId) => !hasCatalog(serverId) && pendingFor(serverId) < LARGE_RAIL_MEMORY_GRACE_MS,
  );
  return [...new Set([...largeAccessoryHosts(plugins), ...pending])].sort();
}
