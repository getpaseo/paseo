import { useSyncExternalStore } from "react";
import { QueryClient } from "@tanstack/react-query";
import { evaluatePluginClientBundle } from "./evaluate";
import type { InstalledPlugin } from "./types";

interface CatalogPlugin {
  id: string;
  clientBundle: string;
}

class PluginRegistry {
  private readonly byHost = new Map<string, InstalledPlugin[]>();
  private readonly listeners = new Set<() => void>();
  private snapshot: InstalledPlugin[] = [];

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): InstalledPlugin[] => this.snapshot;

  installCatalog(serverId: string, catalog: CatalogPlugin[]): void {
    const previous = this.byHost.get(serverId) ?? [];
    const installed = catalog.flatMap((entry) => {
      try {
        const existing = previous.find(
          (plugin) => plugin.id === entry.id && plugin.clientBundle === entry.clientBundle,
        );
        const queryClient = existing?.queryClient ?? new QueryClient();
        return [
          {
            ...evaluatePluginClientBundle(entry.id, entry.clientBundle),
            serverId,
            clientBundle: entry.clientBundle,
            queryClient,
          },
        ];
      } catch (error) {
        console.warn(`[Plugins] Failed to evaluate ${serverId}/${entry.id}`, error);
        return [];
      }
    });
    for (const plugin of previous) {
      if (!installed.some((candidate) => candidate.queryClient === plugin.queryClient)) {
        plugin.queryClient.clear();
      }
    }
    this.byHost.set(serverId, installed);
    this.publish();
  }

  removeHost(serverId: string): void {
    const installed = this.byHost.get(serverId);
    if (!installed) return;
    for (const plugin of installed) plugin.queryClient.clear();
    this.byHost.delete(serverId);
    this.publish();
  }

  private publish(): void {
    this.snapshot = [...this.byHost.values()]
      .flat()
      .sort((left, right) =>
        `${left.serverId}/${left.id}`.localeCompare(`${right.serverId}/${right.id}`),
      );
    for (const listener of this.listeners) listener();
  }
}

export const pluginRegistry = new PluginRegistry();

export function useInstalledPlugins(): InstalledPlugin[] {
  return useSyncExternalStore(
    pluginRegistry.subscribe,
    pluginRegistry.getSnapshot,
    pluginRegistry.getSnapshot,
  );
}

export function useInstalledPlugin(serverId: string, pluginId: string): InstalledPlugin | null {
  return (
    useInstalledPlugins().find(
      (plugin) => plugin.serverId === serverId && plugin.id === pluginId,
    ) ?? null
  );
}

export function usePluginInstallations(pluginId: string): InstalledPlugin[] {
  return useInstalledPlugins().filter((plugin) => plugin.id === pluginId);
}
