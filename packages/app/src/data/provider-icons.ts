import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { PluginSerializableIcon } from "@getpaseo/plugin";
import type { InstalledPlugin } from "@/plugins/types";
import { createStore } from "zustand/vanilla";

export const providerSnapshotIcons = createStore<ReadonlyMap<string, ReadonlyMap<string, string>>>(
  () => new Map(),
);

export const providerIconOverrides = createStore<
  ReadonlyMap<string, ReadonlyMap<string, PluginSerializableIcon>>
>(() => new Map());

type IconInstallation = Pick<InstalledPlugin, "id" | "serverId" | "providerIconOverrides">;

function sameIcon(left: PluginSerializableIcon, right: PluginSerializableIcon): boolean {
  return typeof left === "string" || typeof right === "string"
    ? left === right
    : left.svg === right.svg;
}

/** Rebuild from live installations so removal and reload restore the original provider icon. */
export function replaceProviderIconOverrides(plugins: readonly IconInstallation[]): void {
  const candidates = plugins.flatMap((plugin) =>
    plugin.providerIconOverrides.map((entry) => ({
      serverId: plugin.serverId,
      pluginId: plugin.id,
      ...entry,
    })),
  );
  candidates.sort((left, right) => {
    if (left.pluginId !== right.pluginId) return left.pluginId < right.pluginId ? -1 : 1;
    if (left.id === right.id) return 0;
    return left.id < right.id ? -1 : 1;
  });
  const next = new Map<string, Map<string, PluginSerializableIcon>>();
  for (const entry of candidates) {
    let host = next.get(entry.serverId);
    if (!host) {
      host = new Map();
      next.set(entry.serverId, host);
    }
    if (!host.has(entry.provider)) host.set(entry.provider, entry.icon);
  }
  providerIconOverrides.setState((previous) => {
    const stable = new Map<string, ReadonlyMap<string, PluginSerializableIcon>>(next);
    for (const [serverId, icons] of next) {
      const prior = previous.get(serverId);
      if (
        prior?.size === icons.size &&
        [...icons].every(([provider, icon]) => {
          const previousIcon = prior.get(provider);
          return previousIcon !== undefined && sameIcon(icon, previousIcon);
        })
      ) {
        stable.set(serverId, prior);
      }
    }
    return stable.size === previous.size &&
      [...stable].every(([serverId, icons]) => icons === previous.get(serverId))
      ? previous
      : stable;
  }, true);
}

export function replaceProviderSnapshotIcons(
  serverId: string,
  entries: readonly Pick<ProviderSnapshotEntry, "provider" | "iconSvg">[],
): void {
  const icons = new Map<string, string>();
  for (const entry of entries) {
    if (entry.iconSvg) icons.set(entry.provider, entry.iconSvg);
  }
  providerSnapshotIcons.setState((previous) => new Map(previous).set(serverId, icons), true);
}
