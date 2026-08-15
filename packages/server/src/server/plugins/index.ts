import path from "node:path";
import type pino from "pino";
import {
  PluginIdSchema,
  type PluginListItem,
  type PluginSource,
} from "@getpaseo/protocol/messages";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import { readPluginManifest } from "./manifest.js";
import { PluginRuntime } from "./runtime.js";

interface PluginRuntimePort {
  catalog(): Array<{ id: string; clientBundle: string }>;
  invoke(pluginId: string, method: string, input: unknown): Promise<unknown>;
  startPlugin(pluginId: string, path: string, canPublish: () => boolean): Promise<void>;
  stopPluginById(pluginId: string): Promise<boolean>;
  stopAll(): Promise<void>;
  subscribe(listener: (pluginId: string, error?: string) => void): () => void;
  bindPaseoSessionHost(sessionHost: Parameters<PluginRuntime["bindPaseoSessionHost"]>[0]): void;
}

export class PluginService {
  private readonly runtime: PluginRuntimePort;
  private readonly logger: pino.Logger;
  private readonly errors = new Map<string, string>();
  private readonly listeners = new Set<(pluginId: string) => void>();
  private lifecycle = Promise.resolve();
  private globalStartsBlocked = true;
  private started = false;

  constructor(
    logger: pino.Logger,
    private readonly configStore: DaemonConfigStore,
    runtime: PluginRuntimePort = new PluginRuntime(logger),
  ) {
    this.logger = logger.child({ module: "plugin-service" });
    this.runtime = runtime;
    this.runtime.subscribe((pluginId, error) => {
      if (error) this.errors.set(pluginId, error);
      this.notify(pluginId);
    });
  }

  subscribe(listener: (pluginId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  bindPaseoSessionHost(sessionHost: Parameters<PluginRuntime["bindPaseoSessionHost"]>[0]): void {
    this.runtime.bindPaseoSessionHost(sessionHost);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const config = this.configStore.get();
    this.globalStartsBlocked = config.pluginsEnabled !== true;
    if (config.pluginsEnabled === true) {
      for (const [pluginId, source] of Object.entries(config.plugins ?? {})) {
        if (source.enabled === false) continue;
        await this.startConfigured(pluginId);
        this.notify(pluginId);
      }
    }
    this.configStore.onFieldChange("pluginsEnabled", (value) => {
      this.handleGlobalSwitch(value === true);
    });
  }

  listPlugins(): PluginListItem[] {
    const config = this.configStore.get();
    const running = new Set(this.runtime.catalog().map((plugin) => plugin.id));
    return Object.entries(config.plugins ?? {})
      .map(([id, source]) => {
        const enabled = source.enabled !== false;
        if (!enabled || config.pluginsEnabled !== true) {
          return { id, path: source.path, enabled, status: "disabled" as const };
        }
        const error = this.errors.get(id);
        const item: PluginListItem = {
          id,
          path: source.path,
          enabled,
          status: running.has(id) ? ("running" as const) : ("failed" as const),
        };
        if (error) item.error = error;
        return item;
      })
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  catalog(): Array<{ id: string; clientBundle: string }> {
    return this.runtime.catalog();
  }

  async installDirectory(input: { path: string; id?: string }): Promise<PluginListItem> {
    return this.enqueue(async () => {
      const directory = path.resolve(input.path);
      const manifest = await readPluginManifest(directory);
      const pluginId = PluginIdSchema.parse(input.id ?? manifest.id);
      if (this.configStore.get().plugins?.[pluginId]) {
        throw new Error(
          `Plugin ID "${pluginId}" is already configured; choose another ID with --id`,
        );
      }
      const sources = {
        ...this.configStore.get().plugins,
        [pluginId]: { source: "directory" as const, path: directory, enabled: true },
      };
      this.configStore.patch({ plugins: sources });
      if (this.canPublish(pluginId)) await this.startConfigured(pluginId);
      this.notify(pluginId);
      const installed = this.requireItem(pluginId);
      if (installed.status === "failed") {
        throw new Error(installed.error ?? `Plugin failed to start: ${pluginId}`);
      }
      return installed;
    });
  }

  async inspectDirectory(configuredPath: string): Promise<{ id: string }> {
    return readPluginManifest(path.resolve(configuredPath));
  }

  async reloadPlugin(pluginId: string): Promise<PluginListItem> {
    return this.enqueue(async () => {
      const source = this.requireEnabledSource(pluginId);
      if (this.configStore.get().pluginsEnabled !== true) {
        throw new Error("Plugins are globally disabled");
      }
      this.errors.delete(pluginId);
      await this.runtime.stopPluginById(pluginId);
      await this.startExplicit(pluginId, source.path);
      this.notify(pluginId);
      return this.requireItem(pluginId);
    });
  }

  async enablePlugin(pluginId: string): Promise<PluginListItem> {
    const source = this.requireSource(pluginId);
    this.patchSource(pluginId, { ...source, enabled: true });
    this.errors.delete(pluginId);
    return this.enqueue(async () => {
      const current = this.requireSource(pluginId);
      if (current.enabled !== false && this.configStore.get().pluginsEnabled === true) {
        await this.startExplicit(pluginId, current.path);
      }
      this.notify(pluginId);
      return this.requireItem(pluginId);
    });
  }

  async disablePlugin(pluginId: string): Promise<PluginListItem> {
    const source = this.requireSource(pluginId);
    this.patchSource(pluginId, { ...source, enabled: false });
    const stopping = this.runtime.stopPluginById(pluginId);
    return this.enqueue(async () => {
      await stopping;
      this.errors.delete(pluginId);
      this.notify(pluginId);
      return this.requireItem(pluginId);
    });
  }

  async removePlugin(pluginId: string): Promise<void> {
    this.requireSource(pluginId);
    const stopping = this.runtime.stopPluginById(pluginId);
    const sources = { ...this.configStore.get().plugins };
    delete sources[pluginId];
    this.configStore.patch({ plugins: sources });
    await this.enqueue(async () => {
      await stopping;
      this.errors.delete(pluginId);
      this.notify(pluginId);
    });
  }

  invokePluginRpc(pluginId: string, method: string, input: unknown): Promise<unknown> {
    return this.runtime.invoke(pluginId, method, input);
  }

  async stopAllPlugins(): Promise<void> {
    this.globalStartsBlocked = true;
    const stopping = this.runtime.stopAll();
    await this.enqueue(async () => {
      await stopping;
      await this.runtime.stopAll();
    });
  }

  private handleGlobalSwitch(enabled: boolean): void {
    if (!enabled) {
      this.globalStartsBlocked = true;
      const stopping = this.runtime.stopAll();
      for (const id of Object.keys(this.configStore.get().plugins ?? {})) this.notify(id);
      void this.enqueue(async () => {
        await stopping;
      }).catch((error) => this.logger.error({ err: error }, "Failed to disable plugins"));
      return;
    }
    void this.enqueue(async () => {
      this.globalStartsBlocked = false;
      for (const [pluginId, source] of Object.entries(this.configStore.get().plugins ?? {})) {
        if (source.enabled !== false) await this.startConfigured(pluginId);
        this.notify(pluginId);
      }
    }).catch((error) => this.logger.error({ err: error }, "Failed to enable plugins"));
  }

  private async startConfigured(pluginId: string): Promise<void> {
    const source = this.configStore.get().plugins?.[pluginId];
    if (!source || source.enabled === false || !this.canPublish(pluginId)) return;
    this.errors.delete(pluginId);
    try {
      await this.runtime.startPlugin(pluginId, source.path, () => this.canPublish(pluginId));
    } catch (error) {
      if (this.canPublish(pluginId)) this.recordFailure(pluginId, error);
    }
  }

  private async startExplicit(pluginId: string, sourcePath: string): Promise<void> {
    try {
      await this.runtime.startPlugin(pluginId, sourcePath, () => this.canPublish(pluginId));
    } catch (error) {
      if (this.canPublish(pluginId)) {
        this.recordFailure(pluginId, error);
        this.notify(pluginId);
      }
      throw error;
    }
  }

  private canPublish(pluginId: string): boolean {
    const config = this.configStore.get();
    return (
      !this.globalStartsBlocked &&
      config.pluginsEnabled === true &&
      config.plugins?.[pluginId]?.enabled !== false &&
      config.plugins?.[pluginId] !== undefined
    );
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycle.then(operation, operation);
    this.lifecycle = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private recordFailure(pluginId: string, error: unknown): void {
    this.errors.set(pluginId, error instanceof Error ? error.message : String(error));
  }

  private requireSource(pluginId: string): PluginSource {
    PluginIdSchema.parse(pluginId);
    const source = this.configStore.get().plugins?.[pluginId];
    if (!source) throw new Error(`Plugin is not configured: ${pluginId}`);
    return source;
  }

  private requireEnabledSource(pluginId: string): PluginSource {
    const source = this.requireSource(pluginId);
    if (source.enabled === false) throw new Error(`Plugin is disabled: ${pluginId}`);
    return source;
  }

  private patchSource(pluginId: string, source: PluginSource): void {
    this.configStore.patch({
      plugins: { ...this.configStore.get().plugins, [pluginId]: source },
    });
  }

  private requireItem(pluginId: string): PluginListItem {
    const item = this.listPlugins().find((plugin) => plugin.id === pluginId);
    if (!item) throw new Error(`Plugin is not configured: ${pluginId}`);
    return item;
  }

  private notify(pluginId: string): void {
    for (const listener of this.listeners) listener(pluginId);
  }
}
