import path from "node:path";
import { stat } from "node:fs/promises";
import type pino from "pino";
import {
  PluginIdSchema,
  type PluginLogEntry,
  type PluginListItem,
  type PluginSource,
  type PluginSourceStatusItem,
  type PluginSourceUpdateItem,
} from "@getpaseo/protocol/messages";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import { type ManagedPluginCandidate, ManagedPluginSources } from "./managed-source.js";
import { readPluginManifest } from "./manifest.js";
import { PluginRuntime } from "./runtime.js";

interface PluginRuntimePort {
  catalog(): Array<{ id: string; clientBundle: string }>;
  invoke(pluginId: string, method: string, input: unknown): Promise<unknown>;
  getLogs(pluginId: string): PluginLogEntry[];
  clearLogs(pluginId: string): void;
  validatePlugin?(path: string): Promise<void>;
  startPlugin(pluginId: string, path: string, canPublish: () => boolean): Promise<void>;
  stopPluginById(pluginId: string): Promise<boolean>;
  stopAll(): Promise<void>;
  subscribe(listener: (pluginId: string, error?: string) => void): () => void;
  bindPaseoSessionHost(sessionHost: Parameters<PluginRuntime["bindPaseoSessionHost"]>[0]): void;
}

interface PluginServiceDependencies {
  runtime?: PluginRuntimePort;
  managedSources?: ManagedPluginSources;
}

function resolvePluginStatus(input: {
  enabled: boolean;
  globallyEnabled: boolean;
  running: boolean;
}): PluginListItem["status"] {
  if (!input.enabled || !input.globallyEnabled) return "disabled";
  return input.running ? "running" : "failed";
}

export class PluginService {
  private readonly runtime: PluginRuntimePort;
  private readonly managedSources: ManagedPluginSources | null;
  private readonly logger: pino.Logger;
  private readonly errors = new Map<string, string>();
  private readonly listeners = new Set<(pluginId: string) => void>();
  private lifecycle = Promise.resolve();
  private globalStartsBlocked = true;
  private started = false;

  constructor(
    logger: pino.Logger,
    private readonly configStore: DaemonConfigStore,
    daemonVersion: string,
    dependencies: PluginServiceDependencies = {},
  ) {
    this.logger = logger.child({ module: "plugin-service" });
    this.runtime = dependencies.runtime ?? new PluginRuntime(logger, daemonVersion);
    this.managedSources = dependencies.managedSources ?? null;
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
        const item: PluginListItem = {
          id,
          path: source.path,
          enabled,
          status: resolvePluginStatus({
            enabled,
            globallyEnabled: config.pluginsEnabled === true,
            running: running.has(id),
          }),
        };
        const managed = this.managedSources?.get(id);
        if (managed) {
          item.source = "git";
          const remote = this.managedSources?.displayRemote(id);
          if (remote) item.remote = remote;
          item.ref = managed.requestedRef ?? managed.trackingBranch ?? managed.commit;
          item.commit = managed.commit;
        }
        const error = this.errors.get(id);
        if (error && item.status === "failed") item.error = error;
        return item;
      })
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  getLogs(pluginId: string): PluginLogEntry[] {
    this.requireSource(pluginId);
    return this.runtime.getLogs(pluginId);
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

  async installSource(input: {
    source: string;
    id?: string;
    ref?: string;
    pluginPath?: string;
  }): Promise<PluginListItem> {
    const directory = path.resolve(input.source);
    const info = await stat(directory).catch(() => null);
    if (info?.isDirectory()) {
      if (input.ref) throw new Error("Plugin --ref is only valid for Git sources");
      const pluginDirectory = resolveLocalPluginPath(directory, input.pluginPath);
      return this.installDirectory({ path: pluginDirectory, id: input.id });
    }
    const managedSources = this.requireManagedSources();
    return this.enqueue(async () => {
      let candidate = await managedSources.prepareInstall(input);
      const pluginId = PluginIdSchema.parse(input.id ?? candidate.defaultId);
      if (this.configStore.get().plugins?.[pluginId]) {
        await managedSources.discard(candidate);
        throw new Error(
          `Plugin ID "${pluginId}" is already configured; choose another ID with --id`,
        );
      }
      candidate = await managedSources.place(pluginId, candidate);
      try {
        await this.validateCandidate(candidate);
      } catch (error) {
        await managedSources.discard(candidate);
        throw error;
      }
      const sources = {
        ...this.configStore.get().plugins,
        [pluginId]: { source: "directory" as const, path: candidate.directory, enabled: true },
      };
      managedSources.commit(pluginId, candidate.record);
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

  async statusSources(pluginId?: string): Promise<PluginSourceStatusItem[]> {
    return this.enqueue(async () => {
      const sources = this.configStore.get().plugins ?? {};
      const selected = pluginId
        ? [[pluginId, this.requireSource(pluginId)] as const]
        : Object.entries(sources);
      const managedSources = this.requireManagedSources();
      const statuses: PluginSourceStatusItem[] = [];
      for (const [id, source] of selected) {
        statuses.push(await managedSources.status(id, source.path));
      }
      return statuses.sort((left, right) => left.id.localeCompare(right.id));
    });
  }

  async updateSources(pluginId?: string): Promise<PluginSourceUpdateItem[]> {
    return this.enqueue(async () => {
      const sources = this.configStore.get().plugins ?? {};
      const ids = pluginId
        ? [pluginId]
        : Object.keys(sources).filter((id) => this.managedSources?.get(id));
      const updates: PluginSourceUpdateItem[] = [];
      for (const id of ids.sort()) updates.push(await this.updateSource(id));
      return updates;
    });
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
      this.runtime.clearLogs(pluginId);
      this.errors.delete(pluginId);
      this.notify(pluginId);
      await this.managedSources?.remove(pluginId);
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

  private async updateSource(pluginId: string): Promise<PluginSourceUpdateItem> {
    const managedSources = this.requireManagedSources();
    const source = this.requireSource(pluginId);
    const previous = managedSources.get(pluginId);
    if (!previous) throw new Error(`Plugin is not managed by Git: ${pluginId}`);
    const prepared = await managedSources.prepareUpdate(pluginId, source.path);
    if (!prepared.candidate) {
      return {
        id: pluginId,
        previousCommit: previous.commit,
        currentCommit: previous.commit,
        commits: 0,
        updated: false,
      };
    }
    const candidate = await managedSources.place(pluginId, prepared.candidate);
    try {
      await this.validateCandidate(candidate);
    } catch (error) {
      await managedSources.discard(candidate);
      throw error;
    }

    const current = this.configStore.get().plugins?.[pluginId];
    if (!current) {
      await managedSources.discard(candidate);
      throw new Error(`Plugin is no longer configured: ${pluginId}`);
    }
    const isRunning = this.runtime.catalog().some((plugin) => plugin.id === pluginId);
    const isEnabled = current.enabled !== false;
    const isGloballyEnabled = this.configStore.get().pluginsEnabled === true;
    const shouldActivate = isEnabled && isGloballyEnabled;
    if (shouldActivate) {
      if (isRunning) await this.runtime.stopPluginById(pluginId);
      try {
        await this.startExplicit(pluginId, candidate.directory);
      } catch (error) {
        this.errors.delete(pluginId);
        const latest = this.configStore.get().plugins?.[pluginId];
        const isStillConfigured = latest !== undefined;
        const isStillEnabled = isStillConfigured && latest.enabled !== false;
        const isStillGloballyEnabled = this.configStore.get().pluginsEnabled === true;
        const canRestore = isRunning && isStillEnabled && isStillGloballyEnabled;
        if (canRestore) await this.startExplicit(pluginId, source.path);
        await managedSources.discard(candidate);
        this.notify(pluginId);
        throw error;
      }
    }

    const activatedSource = this.configStore.get().plugins?.[pluginId];
    if (!activatedSource) {
      await this.runtime.stopPluginById(pluginId);
      await managedSources.discard(candidate);
      throw new Error(`Plugin is no longer configured: ${pluginId}`);
    }
    this.patchSource(pluginId, { ...activatedSource, path: candidate.directory });
    managedSources.commit(pluginId, candidate.record);
    await managedSources.removeVersion(previous);
    this.errors.delete(pluginId);
    this.notify(pluginId);
    return {
      id: pluginId,
      previousCommit: previous.commit,
      currentCommit: candidate.record.commit,
      commits: prepared.commits,
      updated: true,
    };
  }

  private validateCandidate(candidate: ManagedPluginCandidate): Promise<void> {
    if (!this.runtime.validatePlugin) {
      throw new Error("Plugin runtime cannot validate managed Git sources");
    }
    return this.runtime.validatePlugin(candidate.directory);
  }

  private requireManagedSources(): ManagedPluginSources {
    if (!this.managedSources) throw new Error("Git plugin management is unavailable");
    return this.managedSources;
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

function resolveLocalPluginPath(directory: string, pluginPath: string | undefined): string {
  if (!pluginPath) return directory;
  if (path.isAbsolute(pluginPath)) throw new Error("Plugin --path must be relative to the source");
  const pluginDirectory = path.resolve(directory, pluginPath);
  const relative = path.relative(directory, pluginDirectory);
  const escapesSource =
    relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  if (escapesSource) throw new Error("Plugin --path must stay inside the source directory");
  return pluginDirectory;
}
