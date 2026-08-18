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
  private readonly disposed = new WeakSet<InstalledPlugin>();
  private readonly evaluationErrors = new Map<string, string>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): InstalledPlugin[] => this.snapshot;

  getEvaluationError(serverId: string, pluginId: string): string | undefined {
    return this.evaluationErrors.get(`${serverId}/${pluginId}`);
  }

  installCatalog(
    serverId: string,
    catalog: CatalogPlugin[],
    options: { replacePluginId?: string } = {},
  ): void {
    const previous = this.byHost.get(serverId) ?? [];
    const preserved = catalog.flatMap((entry) => {
      const existing = previous.find(
        (plugin) =>
          plugin.id !== options.replacePluginId &&
          plugin.id === entry.id &&
          plugin.clientBundle === entry.clientBundle,
      );
      return existing ? [existing] : [];
    });
    const removed = previous.filter((plugin) => !preserved.includes(plugin));
    if (removed.length > 0) {
      this.byHost.set(serverId, preserved);
      this.publish();
      for (const plugin of removed) this.dispose(plugin);
    }
    const installed = catalog.flatMap((entry) => {
      const key = `${serverId}/${entry.id}`;
      try {
        const existing = preserved.find(
          (plugin) => plugin.id === entry.id && plugin.clientBundle === entry.clientBundle,
        );
        if (existing) {
          this.evaluationErrors.delete(key);
          return [existing];
        }
        const queryClient = new QueryClient();
        const evaluated = [
          {
            ...evaluatePluginClientBundle(entry.id, entry.clientBundle),
            serverId,
            clientBundle: entry.clientBundle,
            queryClient,
          },
        ];
        this.evaluationErrors.delete(key);
        return evaluated;
      } catch (error) {
        this.evaluationErrors.set(key, error instanceof Error ? error.message : String(error));
        console.warn(`[Plugins] Failed to evaluate ${serverId}/${entry.id}`, error);
        return [];
      }
    });
    const configuredIds = new Set(catalog.map((entry) => entry.id));
    for (const key of this.evaluationErrors.keys()) {
      if (key.startsWith(`${serverId}/`) && !configuredIds.has(key.slice(serverId.length + 1))) {
        this.evaluationErrors.delete(key);
      }
    }
    this.byHost.set(serverId, installed);
    this.publish();
  }

  removeHost(serverId: string): void {
    const installed = this.byHost.get(serverId);
    if (!installed) return;
    for (const plugin of installed) this.dispose(plugin);
    for (const key of this.evaluationErrors.keys()) {
      if (key.startsWith(`${serverId}/`)) this.evaluationErrors.delete(key);
    }
    this.byHost.delete(serverId);
    this.publish();
  }

  private dispose(plugin: InstalledPlugin): void {
    if (this.disposed.has(plugin)) return;
    this.disposed.add(plugin);
    plugin.queryClient.clear();
    try {
      void Promise.resolve(plugin.cleanup()).catch((error) => {
        console.warn(`[Plugins] Cleanup failed for ${plugin.serverId}/${plugin.id}`, error);
      });
    } catch (error) {
      console.warn(`[Plugins] Cleanup failed for ${plugin.serverId}/${plugin.id}`, error);
    }
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
