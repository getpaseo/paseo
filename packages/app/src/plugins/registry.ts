import { useMemo, useSyncExternalStore } from "react";
import { QueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { assertPluginCompatibility } from "@getpaseo/protocol/plugin-requirements";
import MarkdownIt from "markdown-it";
import { resolveAppVersion } from "@/utils/app-version";
import { setMarkdownBlockDelimiters } from "@/utils/split-markdown-blocks";
import { createPluginClientRuntime } from "./client-runtime";
import { runPluginClientBundle, type PluginClientRuntime } from "./evaluate";
import {
  applyMarkdownExtensionParsers,
  collectMarkdownBlockDelimiters,
  collectMarkdownExtensions,
} from "./markdown-extensions";
import type { InstalledPlugin } from "./types";

type CatalogPlugin = Awaited<ReturnType<DaemonClient["getPluginCatalog"]>>[number];

export class PluginRegistry {
  private readonly byHost = new Map<string, InstalledPlugin[]>();
  private readonly listeners = new Set<() => void>();
  private snapshot: InstalledPlugin[] = [];
  private readonly disposed = new WeakSet<InstalledPlugin>();
  private readonly evaluationErrors = new Map<string, string>();

  constructor(
    private readonly dependencies: {
      version: string | null;
      createRuntime: typeof createPluginClientRuntime;
    },
  ) {}

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
    options: {
      replacePluginId?: string;
      client: DaemonClient;
    },
  ): boolean {
    const previous = this.byHost.get(serverId) ?? [];
    const previousTimelineBundles = previous
      .filter((plugin) => plugin.timelineTransformers.length > 0)
      .map((plugin) => `${plugin.id}\0${plugin.clientBundle}`);
    const preserved = catalog.flatMap((entry) => {
      const existing = previous.find(
        (plugin) =>
          plugin.id !== options.replacePluginId &&
          plugin.id === entry.id &&
          plugin.clientBundle === entry.clientBundle &&
          plugin.requirements?.paseo === entry.requirements?.paseo,
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
      let runtime: PluginClientRuntime | undefined;
      let lifetime: AbortController | undefined;
      try {
        if (!entry.clientBundle) return [];
        assertPluginCompatibility({ ...entry, version: this.dependencies.version, runtime: "app" });
        const existing = preserved.find(
          (plugin) => plugin.id === entry.id && plugin.clientBundle === entry.clientBundle,
        );
        if (existing) {
          this.evaluationErrors.delete(key);
          return [existing];
        }
        lifetime = new AbortController();
        const installation: InstalledPlugin = {
          lifetime,
          id: entry.id,
          serverId,
          clientBundle: entry.clientBundle,
          requirements: entry.requirements,
          queryClient: new QueryClient(),
          cleanup: () => undefined,
          surfaces: [],
          settingsScreens: [],
          sidebarItems: [],
          workspacePanels: [],
          commandCenterItems: [],
          clientSlashCommands: [],
          attachmentSources: [],
          themes: [],
          timelineTransformers: [],
          timelineRenderers: [],
          markdownExtensions: [],
        };
        runtime = this.dependencies.createRuntime(installation, options.client);
        const evaluated = runPluginClientBundle(entry.id, entry.clientBundle, runtime, () =>
          this.publish(),
        );
        Object.assign(installation, evaluated);
        const paseo = runtime.paseo;
        installation.cleanup = async () => {
          const results = await Promise.allSettled([paseo.dispose(), evaluated.cleanup()]);
          const failures = results.filter((result) => result.status === "rejected");
          if (failures.length)
            throw new AggregateError(
              failures.map((result) => result.reason),
              "Plugin cleanup failed",
            );
        };
        this.evaluationErrors.delete(key);
        return [installation];
      } catch (error) {
        lifetime?.abort();
        void runtime?.paseo
          .dispose()
          .catch((failure) => console.warn(`[Plugins] API cleanup failed for ${key}`, failure));
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
    const installedTimelineBundles = installed
      .filter((plugin) => plugin.timelineTransformers.length > 0)
      .map((plugin) => `${plugin.id}\0${plugin.clientBundle}`);
    return (
      previousTimelineBundles.length !== installedTimelineBundles.length ||
      previousTimelineBundles.some((bundle, index) => bundle !== installedTimelineBundles[index])
    );
  }

  removeHost(serverId: string): void {
    const installed = this.byHost.get(serverId);
    if (installed) {
      for (const plugin of installed) this.dispose(plugin);
      for (const key of this.evaluationErrors.keys()) {
        if (key.startsWith(`${serverId}/`)) this.evaluationErrors.delete(key);
      }
      this.byHost.delete(serverId);
      this.publish();
    }
    // Unsupported, disconnected, and torn-down hosts have no catalog to wait for.
    // Publish empty delimiters so completed-block promotion keeps running.
    this.acknowledgeEmptyHost(serverId);
  }

  /** Pending is only while a catalog load is in flight. */
  acknowledgeEmptyHost(serverId: string): void {
    if (this.byHost.has(serverId)) return;
    setMarkdownBlockDelimiters(serverId, []);
  }

  private dispose(plugin: InstalledPlugin): void {
    if (this.disposed.has(plugin)) return;
    this.disposed.add(plugin);
    plugin.lifetime.abort();
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
    // The block splitter runs in the stream reducer and the height estimator, which cannot
    // subscribe to this registry, so push per-host delimiters instead of having them pull.
    for (const serverId of this.byHost.keys()) {
      const extensions = collectMarkdownExtensions(selectHostPlugins(this.snapshot, serverId));
      const { extensions: installed } = applyMarkdownExtensionParsers(
        () => new MarkdownIt(),
        extensions,
      );
      setMarkdownBlockDelimiters(
        serverId,
        collectMarkdownBlockDelimiters(
          installed.map((extension) => ({ markdownExtensions: [extension] })),
        ),
      );
    }
    for (const listener of this.listeners) listener();
  }
}

export const pluginRegistry = new PluginRegistry({
  version: resolveAppVersion(),
  createRuntime: createPluginClientRuntime,
});

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

/** No host means no plugins, not every host's. */
export function selectHostPlugins(
  installed: readonly InstalledPlugin[],
  serverId: string | undefined,
): InstalledPlugin[] {
  if (!serverId) return [];
  return installed.filter((plugin) => plugin.serverId === serverId);
}

/** Plugins installed on one host. */
export function useHostPlugins(serverId: string | undefined): InstalledPlugin[] {
  const installed = useInstalledPlugins();
  return useMemo(() => selectHostPlugins(installed, serverId), [installed, serverId]);
}

export function usePluginInstallations(pluginId: string): InstalledPlugin[] {
  const installed = useInstalledPlugins();
  return useMemo(() => installed.filter((plugin) => plugin.id === pluginId), [installed, pluginId]);
}
