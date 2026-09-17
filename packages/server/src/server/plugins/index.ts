import type { PluginLifecycle } from "./lifecycle/index.js";
import path from "node:path";
import { stat, rm } from "node:fs/promises";
import type pino from "pino";
import type { ProviderRegistration } from "@getpaseo/plugin/server/provider";
import {
  PluginIdSchema,
  type PluginLogEntry,
  type PluginListItem,
  type PluginSource,
  type PluginSourceStatusItem,
  type PluginSourceUpdateItem,
  type PluginUpdateSelection,
  type PluginUpdateProposal,
  type PluginUpdatePreview,
  type PluginUpdateResult,
} from "@getpaseo/protocol/messages";
import { parsePluginSourceReference } from "@getpaseo/protocol/plugin-source-reference";
import { assertPluginCompatibility } from "@getpaseo/protocol/plugin-requirements";
import { BUILTIN_PROVIDER_IDS } from "@getpaseo/protocol/provider-manifest";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import { type ManagedPluginCandidate, ManagedPluginSources } from "./managed-source.js";
import { readPluginManifest } from "./manifest.js";
import { runPluginBuild } from "./preparation.js";
import { PluginRuntime } from "./runtime.js";
import type { PluginProviderMetadata } from "./plugin-process-protocol.js";
import { readPluginProviderIcon } from "./provider-icon.js";

const BUILTIN_PROVIDER_ID_SET: ReadonlySet<string> = new Set(BUILTIN_PROVIDER_IDS);

interface PluginRuntimePort {
  emit?: PluginLifecycle["emit"];
  before?: PluginLifecycle["before"];
  catalog: PluginRuntime["catalog"];
  invoke(pluginId: string, method: string, input: unknown): Promise<unknown>;
  getLogs(pluginId: string): PluginLogEntry[];
  clearLogs(pluginId: string): void;
  getProviderRegistrations?(pluginId: string): readonly PluginProviderMetadata[];
  connectProvider: PluginRuntime["connectProvider"];
  getProviderCatalogCacheKey?: PluginRuntime["getProviderCatalogCacheKey"];
  validatePlugin?(path: string): Promise<void>;
  startPlugin(pluginId: string, path: string, canPublish: () => boolean): Promise<void>;
  stopPluginById(pluginId: string): Promise<boolean>;
  stopAll(): Promise<void>;
  subscribe(listener: (pluginId: string, error?: string) => void): () => void;
  bindPaseoSessionHost(sessionHost: Parameters<PluginRuntime["bindPaseoSessionHost"]>[0]): void;
}

interface PluginServiceDependencies {
  settingsDirectory?: string;
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
  private readonly providers = new Map<string, ProviderRegistration>();
  private readonly providerIdsByPlugin = new Map<string, readonly string[]>();
  private readonly providerListeners = new Set<() => void>();
  private lifecycle = Promise.resolve();
  private globalStartsBlocked = true;
  private started = false;
  private readonly settingsListeners = new Set<(pluginId: string, settingsId: string) => void>();

  constructor(
    logger: pino.Logger,
    private readonly configStore: DaemonConfigStore,
    private readonly daemonVersion: string,
    private readonly dependencies: PluginServiceDependencies = {},
  ) {
    this.logger = logger.child({ module: "plugin-service" });
    this.runtime =
      dependencies.runtime ??
      new PluginRuntime(logger, daemonVersion, {
        settingsDirectory: dependencies.settingsDirectory,
        onSettingsChanged: (pluginId, settingsId) => {
          for (const listener of this.settingsListeners) listener(pluginId, settingsId);
        },
      });
    this.managedSources = dependencies.managedSources ?? null;
    this.runtime.subscribe((pluginId, error) => {
      this.removeProviderRegistrations(pluginId);
      if (error) this.errors.set(pluginId, error);
      this.notify(pluginId);
    });
  }

  readonly emit: PluginLifecycle["emit"] = (name, event) => {
    this.runtime.emit?.(name, event);
  };

  readonly before: PluginLifecycle["before"] = async (name, request) => {
    if (this.runtime.before) {
      return this.runtime.before(name, request);
    }
    return request;
  };

  subscribeSettings(listener: (pluginId: string, settingsId: string) => void): () => void {
    this.settingsListeners.add(listener);
    return () => this.settingsListeners.delete(listener);
  }

  subscribe(listener: (pluginId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  bindPaseoSessionHost(sessionHost: Parameters<PluginRuntime["bindPaseoSessionHost"]>[0]): void {
    this.runtime.bindPaseoSessionHost(sessionHost);
  }

  getProviderRegistrations(): readonly ProviderRegistration[] {
    return [...this.providers.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  subscribeProviderRegistrations(listener: () => void): () => void {
    this.providerListeners.add(listener);
    return () => this.providerListeners.delete(listener);
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

  async listPlugins(): Promise<PluginListItem[]> {
    const config = this.configStore.get();
    const running = new Set(this.runtime.catalog().map((plugin) => plugin.id));
    const plugins = await Promise.all(
      Object.entries(config.plugins ?? {}).map(async ([id, source]) => {
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
        const manifest = await readPluginManifest(path.resolve(source.path)).catch(() => null);
        if (manifest?.description) item.description = manifest.description;
        item.installation = await this.managedSources
          ?.describe(id, source.path)
          .catch(() => undefined);
        if (!this.managedSources)
          item.installation = { identity: { kind: "directory", path: path.resolve(source.path) } };
        if (item.installation?.identity.kind === "git") {
          item.source = "git";
          item.remote = item.installation.identity.remote;
          item.commit = item.installation.currentRevision;
        }
        const error = this.errors.get(id);
        if (error && item.status === "failed") item.error = error;
        return item;
      }),
    );
    return plugins.sort((left, right) => left.id.localeCompare(right.id));
  }

  getLogs(pluginId: string): PluginLogEntry[] {
    this.requireSource(pluginId);
    return this.runtime.getLogs(pluginId);
  }

  catalog(): ReturnType<PluginRuntime["catalog"]> {
    return this.runtime.catalog();
  }

  async installDirectory(input: { path: string; id?: string }): Promise<PluginListItem> {
    return this.enqueue(async () => {
      const directory = path.resolve(input.path);
      const manifest = await readPluginManifest(directory);
      assertPluginCompatibility({ ...manifest, version: this.daemonVersion, runtime: "daemon" });
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
      const installed = await this.requireItem(pluginId);
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
  }): Promise<PluginListItem> {
    const directDirectory = path.resolve(input.source);
    const explicit = /^(npm:|github:|git:(?!\/\/))/.test(input.source);
    const directInfo = await stat(directDirectory).catch(() => null);
    const reference = directInfo?.isDirectory()
      ? { source: input.source, pluginPath: undefined }
      : parsePluginSourceReference(input.source);
    const directory = path.resolve(reference.source);
    let info = directInfo;
    if (!info?.isDirectory() && !explicit) info = await stat(directory).catch(() => null);
    if (info?.isDirectory()) {
      if (input.ref) throw new Error("Plugin --ref is only valid for Git sources");
      const pluginDirectory = resolveLocalPluginPath(directory, reference.pluginPath);
      return this.installDirectory({ path: pluginDirectory, id: input.id });
    }
    const managedSources = this.requireManagedSources();
    return this.enqueue(async () => {
      let candidate = await managedSources.prepareInstall({
        ...input,
        source: reference.source,
        pluginPath: reference.pluginPath,
      });
      let pluginId: string;
      try {
        await this.checkRequirements(candidate.directory);
        pluginId = PluginIdSchema.parse(input.id ?? candidate.defaultId);
        if (this.configStore.get().plugins?.[pluginId]) {
          throw new Error(
            `Plugin ID "${pluginId}" is already configured; choose another ID with --id`,
          );
        }
        await runPluginBuild(candidate.directory, candidate.build, this.logger);
        candidate = await managedSources.place(pluginId, candidate);
        await this.validateCandidate(candidate);
        await managedSources.verifyCandidate(pluginId, candidate);
      } catch (error) {
        await managedSources.discard(candidate);
        throw error;
      }
      this.patchSource(pluginId, { source: "directory", path: candidate.directory, enabled: true });
      try {
        if (this.canPublish(pluginId)) await this.startExplicit(pluginId, candidate.directory);
        managedSources.commit(pluginId, candidate.record);
      } catch (error) {
        await this.stopPlugin(pluginId);
        const sources = { ...this.configStore.get().plugins };
        delete sources[pluginId];
        this.configStore.patch({ plugins: sources });
        await managedSources.discard(candidate);
        this.errors.delete(pluginId);
        this.notify(pluginId);
        throw error;
      }
      this.notify(pluginId);
      return this.requireItem(pluginId);
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

  // COMPAT(plugin-immediate-update): added in v0.8.0; remove after 2027-03-16 when clients use reviewed targets.
  async updateSources(_pluginId?: string): Promise<PluginSourceUpdateItem[]> {
    throw new Error("Update the client to review plugin updates before applying them.");
  }

  async previewUpdates(input: {
    pluginId?: string;
    target?: PluginUpdateSelection;
  }): Promise<PluginUpdatePreview[]> {
    if (input.target && !input.pluginId)
      throw new Error("An explicit update target requires one plugin ID");
    const sources = this.configStore.get().plugins ?? {};
    const ids = input.pluginId ? [input.pluginId] : Object.keys(sources).sort();
    return Promise.all(
      ids.map(async (id) => {
        try {
          return await this.requireManagedSources().preview(
            id,
            this.requireSource(id).path,
            input.target,
          );
        } catch (error) {
          return {
            id,
            outcome: "error" as const,
            links: [],
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
  }

  async applyUpdates(proposals: PluginUpdateProposal[]): Promise<PluginUpdateResult[]> {
    return this.enqueue(async () => {
      const results: PluginUpdateResult[] = [];
      for (const proposal of proposals) {
        try {
          results.push(await this.updateSource(proposal));
        } catch (error) {
          results.push({
            id: proposal.id,
            outcome: "error",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return results;
    });
  }

  async reloadPlugin(pluginId: string): Promise<PluginListItem> {
    return this.enqueue(async () => {
      const source = this.requireEnabledSource(pluginId);
      if (this.configStore.get().pluginsEnabled !== true) {
        throw new Error("Plugins are globally disabled");
      }
      this.errors.delete(pluginId);
      await this.stopPlugin(pluginId);
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
    const stopping = this.stopPlugin(pluginId);
    return this.enqueue(async () => {
      await stopping;
      this.errors.delete(pluginId);
      this.notify(pluginId);
      return this.requireItem(pluginId);
    });
  }

  async removePlugin(pluginId: string): Promise<void> {
    this.requireSource(pluginId);
    const stopping = this.stopPlugin(pluginId);
    const sources = { ...this.configStore.get().plugins };
    delete sources[pluginId];
    this.configStore.patch({ plugins: sources });
    await this.enqueue(async () => {
      await stopping;
      this.runtime.clearLogs(pluginId);
      this.errors.delete(pluginId);
      this.notify(pluginId);
      await this.managedSources?.remove(pluginId);
      if (this.dependencies.settingsDirectory)
        await rm(path.join(this.dependencies.settingsDirectory, pluginId), {
          recursive: true,
          force: true,
        });
    });
  }

  invokePluginRpc(pluginId: string, method: string, input: unknown): Promise<unknown> {
    return this.runtime.invoke(pluginId, method, input);
  }

  async stopAllPlugins(): Promise<void> {
    this.globalStartsBlocked = true;
    const stopping = this.stopAll();
    await this.enqueue(async () => {
      await stopping;
      await this.stopAll();
    });
  }

  private handleGlobalSwitch(enabled: boolean): void {
    if (!enabled) {
      this.globalStartsBlocked = true;
      const stopping = this.stopAll();
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
      await this.startPlugin(pluginId, source.path);
    } catch (error) {
      if (this.canPublish(pluginId)) this.recordFailure(pluginId, error);
    }
  }

  private async startExplicit(pluginId: string, sourcePath: string): Promise<void> {
    try {
      await this.startPlugin(pluginId, sourcePath);
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

  private async startPlugin(pluginId: string, sourcePath: string): Promise<void> {
    await this.runtime.startPlugin(pluginId, sourcePath, () => this.canPublish(pluginId));
    try {
      await this.publishProviderRegistrations(pluginId, sourcePath);
    } catch (error) {
      try {
        this.removeProviderRegistrations(pluginId);
      } finally {
        await this.runtime.stopPluginById(pluginId);
      }
      throw error;
    }
  }

  private stopPlugin(pluginId: string): Promise<boolean> {
    this.removeProviderRegistrations(pluginId);
    return this.runtime.stopPluginById(pluginId);
  }

  private async stopAll(): Promise<void> {
    for (const pluginId of this.providerIdsByPlugin.keys()) {
      this.removeProviderRegistrations(pluginId);
    }
    await this.runtime.stopAll();
  }

  private async publishProviderRegistrations(
    pluginId: string,
    pluginDirectory: string,
  ): Promise<void> {
    const metadata = this.runtime.getProviderRegistrations?.(pluginId) ?? [];
    const configuredIds = new Set(Object.keys(this.configStore.get().providers));
    for (const provider of metadata) {
      if (BUILTIN_PROVIDER_ID_SET.has(provider.id)) {
        throw new Error(`Plugin ${pluginId} cannot register builtin provider ID "${provider.id}"`);
      }
      if (configuredIds.has(provider.id)) {
        throw new Error(
          `Plugin ${pluginId} cannot register configured provider ID "${provider.id}"`,
        );
      }
      if (this.providers.has(provider.id)) {
        throw new Error(`Plugin ${pluginId} cannot register provider ID "${provider.id}" twice`);
      }
    }
    const registrations = await Promise.all(
      metadata.map(
        async (provider): Promise<ProviderRegistration> => ({
          id: provider.id,
          label: provider.label,
          description: provider.description,
          getCatalogCacheKey: provider.hasCatalogCacheKey
            ? (options) => {
                if (!this.runtime.getProviderCatalogCacheKey)
                  throw new Error("Plugin runtime cannot resolve catalogue keys");
                return this.runtime.getProviderCatalogCacheKey(pluginId, provider.id, options);
              }
            : undefined,
          icon: provider.iconPath
            ? await readPluginProviderIcon(pluginDirectory, provider.iconPath)
            : undefined,
          connect: (request) => this.runtime.connectProvider(pluginId, provider.id, request),
        }),
      ),
    );
    const ids = registrations.map((provider) => provider.id);
    for (const provider of registrations) {
      this.providers.set(provider.id, {
        ...provider,
      });
    }
    if (ids.length > 0) {
      this.providerIdsByPlugin.set(pluginId, ids);
      this.notifyProviderRegistrations();
    }
  }

  private removeProviderRegistrations(pluginId: string): void {
    const ids = this.providerIdsByPlugin.get(pluginId);
    if (!ids) return;
    this.providerIdsByPlugin.delete(pluginId);
    for (const id of ids) this.providers.delete(id);
    this.notifyProviderRegistrations();
  }

  private notifyProviderRegistrations(): void {
    for (const listener of this.providerListeners) listener();
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

  private async checkRequirements(directory: string): Promise<void> {
    const manifest = await readPluginManifest(directory);
    assertPluginCompatibility({ ...manifest, version: this.daemonVersion, runtime: "daemon" });
  }

  private async updateSource(proposal: PluginUpdateProposal): Promise<PluginUpdateResult> {
    const pluginId = proposal.id;
    const managedSources = this.requireManagedSources();
    const source = this.requireSource(pluginId);
    let candidate = await managedSources.prepareUpdate(proposal, source.path);
    try {
      await this.checkRequirements(candidate.directory);
      await runPluginBuild(candidate.directory, candidate.build, this.logger);
      candidate = await managedSources.place(pluginId, candidate);
      await this.validateCandidate(candidate);
      await managedSources.verifyCandidate(pluginId, candidate, proposal.target);
      await managedSources.assertCurrent(proposal, this.requireSource(pluginId).path);
    } catch (error) {
      await managedSources.discard(candidate);
      throw error;
    }

    const current = this.requireSource(pluginId);
    const isRunning = this.runtime.catalog().some((plugin) => plugin.id === pluginId);
    const shouldActivate =
      current.enabled !== false && this.configStore.get().pluginsEnabled === true;
    if (shouldActivate) {
      if (isRunning) await this.stopPlugin(pluginId);
      try {
        await this.startExplicit(pluginId, candidate.directory);
      } catch (error) {
        let recoveryError: unknown;
        try {
          this.errors.delete(pluginId);
          if (isRunning && this.canPublish(pluginId))
            await this.startExplicit(pluginId, source.path);
        } catch (restoreError) {
          recoveryError = restoreError;
        } finally {
          await managedSources.discard(candidate);
          this.notify(pluginId);
        }
        if (recoveryError)
          throw new Error(
            `Update failed: ${error instanceof Error ? error.message : String(error)}; restoring previous plugin also failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
            { cause: error },
          );
        throw error;
      }
    }
    const activatedSource = this.configStore.get().plugins?.[pluginId];
    if (!activatedSource) {
      await this.stopPlugin(pluginId);
      await managedSources.discard(candidate);
      throw new Error(`Plugin is no longer configured: ${pluginId}`);
    }
    this.patchSource(pluginId, { ...activatedSource, path: candidate.directory });
    this.errors.delete(pluginId);
    this.notify(pluginId);
    let warning: string | undefined;
    try {
      await managedSources.removeVersion(pluginId, source.path);
    } catch (error) {
      warning = `Plugin updated, but previous installation cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    return {
      id: pluginId,
      outcome: "updated",
      plugin: await this.requireItem(pluginId),
      ...(warning ? { warning } : {}),
    };
  }

  private validateCandidate(candidate: ManagedPluginCandidate): Promise<void> {
    if (!this.runtime.validatePlugin) {
      throw new Error("Plugin runtime cannot validate managed sources");
    }
    return this.runtime.validatePlugin(candidate.directory);
  }

  private requireManagedSources(): ManagedPluginSources {
    if (!this.managedSources) throw new Error("Plugin source management is unavailable");
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

  private async requireItem(pluginId: string): Promise<PluginListItem> {
    const item = (await this.listPlugins()).find((plugin) => plugin.id === pluginId);
    if (!item) throw new Error(`Plugin is not configured: ${pluginId}`);
    return item;
  }

  private notify(pluginId: string): void {
    for (const listener of this.listeners) listener(pluginId);
  }
}

function resolveLocalPluginPath(directory: string, pluginPath: string | undefined): string {
  if (!pluginPath) return directory;
  if (path.isAbsolute(pluginPath)) throw new Error("Plugin path must be relative to the source");
  const pluginDirectory = path.resolve(directory, pluginPath);
  const relative = path.relative(directory, pluginDirectory);
  const escapesSource =
    relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  if (escapesSource) throw new Error("Plugin path must stay inside the source directory");
  return pluginDirectory;
}
