import type { Logger } from "pino";
import type {
  InstalledPlugin,
  PluginRegistryEntry,
  PluginSource,
} from "@getpaseo/protocol/plugin/types";
import {
  createFetchPluginRegistryHttp,
  PluginRegistryClient,
  type PluginRegistryHttp,
} from "./registry-client.js";
import { PluginNotInstalledError, PluginStore } from "./store.js";

export const DEFAULT_PLUGIN_REGISTRY_URL = "https://plugins.paseo.sh/index.json";

export type PluginsChangedListener = (plugins: InstalledPlugin[]) => void;

export interface PluginServiceOptions {
  /** `$PASEO_HOME/plugins`. */
  dir: string;
  daemonVersion: string;
  registryUrl?: string;
  logger: Logger;
  /** Injected in tests; production uses `fetch` plus `file://` reads. */
  http?: PluginRegistryHttp;
  now?: () => Date;
}

/**
 * Coordinates the on-disk plugin directory and the marketplace registry, and
 * notifies listeners whenever the installed set changes so every connected
 * session can be pushed a fresh list.
 */
export class PluginService {
  private readonly store: PluginStore;
  private readonly registry: PluginRegistryClient;
  private readonly logger: Logger;
  private readonly listeners = new Set<PluginsChangedListener>();

  constructor(options: PluginServiceOptions) {
    this.logger = options.logger.child({ module: "plugins" });
    this.store = new PluginStore({
      dir: options.dir,
      daemonVersion: options.daemonVersion,
      ...(options.now ? { now: options.now } : {}),
    });
    this.registry = new PluginRegistryClient({
      registryUrl: options.registryUrl ?? DEFAULT_PLUGIN_REGISTRY_URL,
      http: options.http ?? createFetchPluginRegistryHttp(),
    });
  }

  get registryUrl(): string {
    return this.registry.registryUrl;
  }

  async list(): Promise<InstalledPlugin[]> {
    return this.store.list();
  }

  async getEntry(pluginId: string, entry: string): Promise<string> {
    return this.store.readEntry(pluginId, entry);
  }

  async browse(options?: { refresh?: boolean }): Promise<PluginRegistryEntry[]> {
    const index = await this.registry.browse(options ?? {});
    return index.plugins;
  }

  async install(pluginId: string): Promise<InstalledPlugin> {
    const download = await this.registry.download(pluginId);
    const source: PluginSource = { kind: "registry", registryUrl: this.registry.registryUrl };
    await this.store.install({
      pluginId,
      files: download.files,
      manifest: download.entry.manifest,
      source,
    });
    this.logger.info({ pluginId, files: download.files.length }, "Installed plugin");
    return this.emitChanged(pluginId);
  }

  async uninstall(pluginId: string): Promise<void> {
    await this.store.uninstall(pluginId);
    this.logger.info({ pluginId }, "Uninstalled plugin");
    await this.notify();
  }

  async setEnabled(pluginId: string, enabled: boolean): Promise<InstalledPlugin> {
    await this.store.setEnabled(pluginId, enabled);
    return this.emitChanged(pluginId);
  }

  onChanged(listener: PluginsChangedListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  stop(): void {
    this.listeners.clear();
    this.registry.clearCache();
  }

  private async emitChanged(pluginId: string): Promise<InstalledPlugin> {
    const plugins = await this.notify();
    const plugin = plugins.find((candidate) => candidate.manifest.id === pluginId);
    if (!plugin) {
      throw new PluginNotInstalledError(pluginId);
    }
    return plugin;
  }

  private async notify(): Promise<InstalledPlugin[]> {
    const plugins = await this.store.list();
    for (const listener of this.listeners) {
      try {
        listener(plugins);
      } catch (error) {
        this.logger.warn({ err: error }, "Plugin change listener threw");
      }
    }
    return plugins;
  }
}
