import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { resolve } from "node:path";

import type { Logger } from "pino";

import { withTimeout } from "../../utils/promise-timeout.js";
import type { AgentProvider, ProviderSnapshotEntry } from "./agent-sdk-types.js";
import type { ProviderDefinition } from "./provider-registry.js";

const DEFAULT_SNAPSHOT_TTL_MS = 300_000;
const DEFAULT_REFRESH_TIMEOUT_MS = 30_000;

type ProviderSnapshotChangeListener = (entries: ProviderSnapshotEntry[], cwd: string) => void;
interface ProviderSnapshotManagerOptions {
  ttlMs?: number;
  refreshTimeoutMs?: number;
  now?: () => number;
}
interface ProviderSnapshotRefreshOptions {
  cwd: string;
  providers?: AgentProvider[];
}
interface ProviderLoadOptions {
  cwd: string;
  providers: AgentProvider[];
  force: boolean;
}
interface ProviderLoad {
  promise: Promise<void>;
}

export class ProviderSnapshotManager {
  private readonly snapshots = new Map<string, Map<AgentProvider, ProviderSnapshotEntry>>();
  private readonly lastCheckedAts = new Map<string, number>();
  private readonly providerLoads = new Map<string, Map<AgentProvider, ProviderLoad>>();
  private readonly events = new EventEmitter();
  private destroyed = false;
  private readonly ttlMs: number;
  private readonly refreshTimeoutMs: number;
  private readonly now: () => number;
  private providerRegistry: Record<AgentProvider, ProviderDefinition>;

  constructor(
    providerRegistry: Record<AgentProvider, ProviderDefinition>,
    private readonly logger: Logger,
    options: ProviderSnapshotManagerOptions = {},
  ) {
    this.providerRegistry = providerRegistry;
    this.ttlMs = options.ttlMs ?? DEFAULT_SNAPSHOT_TTL_MS;
    this.refreshTimeoutMs = options.refreshTimeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  getSnapshot(_cwd?: string): ProviderSnapshotEntry[] {
    const resolvedCwd = resolveGlobalSnapshotCwd();
    const entries = this.snapshots.get(resolvedCwd);
    if (!entries) {
      const loadingEntries = this.resetSnapshotToLoading(resolvedCwd);
      void this.warmUp(resolvedCwd);
      return entriesToArray(loadingEntries);
    }
    const missingProviders = this.getProviderIds().filter((provider) => !entries.has(provider));
    if (missingProviders.length > 0) {
      this.resetSnapshotToLoading(resolvedCwd, missingProviders);
      void this.warmUp(resolvedCwd, missingProviders);
    }
    const providerLoads = this.providerLoads.get(resolvedCwd);
    const loadingProviders = Array.from(entries.values())
      .filter((entry) => entry.status === "loading" && !providerLoads?.has(entry.provider))
      .map((entry) => entry.provider);
    if (loadingProviders.length > 0) {
      void this.warmUp(resolvedCwd, loadingProviders);
    }
    if (this.shouldRevalidate(resolvedCwd)) {
      void this.warmUp(resolvedCwd);
    }
    return entriesToArray(entries);
  }

  async refreshSnapshotForCwd(options: ProviderSnapshotRefreshOptions): Promise<void> {
    const snapshotCwd = resolveGlobalSnapshotCwd();
    const providers = this.resolveRefreshProviders(options.providers);
    this.resetSnapshotToLoading(snapshotCwd, providers);
    this.emitChange(snapshotCwd);
    await this.refreshProviders(snapshotCwd, providers ?? this.getProviderIds());
    if (!providers) {
      this.lastCheckedAts.set(snapshotCwd, this.now());
    }
  }

  async refreshSettingsSnapshot(
    options: Omit<ProviderSnapshotRefreshOptions, "cwd"> = {},
  ): Promise<void> {
    const homeCwd = resolveGlobalSnapshotCwd();
    const providers = this.resolveRefreshProviders(options.providers);
    const providersToRefresh = providers ?? this.getProviderIds();

    this.resetSnapshotToLoading(homeCwd, providers);
    this.emitChange(homeCwd);
    await this.refreshProviders(homeCwd, providersToRefresh);
    if (!providers) {
      this.lastCheckedAts.set(homeCwd, this.now());
    }
  }

  async warmUpSnapshotForCwd(options: ProviderSnapshotRefreshOptions): Promise<void> {
    const snapshotCwd = resolveGlobalSnapshotCwd();
    const providers = this.resolveRefreshProviders(options.providers);
    if (options.providers && providers?.length === 0) {
      return;
    }

    const snapshot = this.snapshots.get(snapshotCwd);
    if (!snapshot) {
      this.resetSnapshotToLoading(snapshotCwd, providers);
    } else if (providers) {
      const missingProviders = providers.filter((provider) => !snapshot.has(provider));
      if (missingProviders.length > 0) {
        this.resetSnapshotToLoading(snapshotCwd, missingProviders);
      }
    }

    await this.warmUp(snapshotCwd, providers);
  }

  async refresh(options: ProviderSnapshotRefreshOptions): Promise<void> {
    await this.refreshSnapshotForCwd(options);
  }

  on(event: "change", listener: ProviderSnapshotChangeListener): this {
    this.events.on(event, listener);
    return this;
  }

  off(event: "change", listener: ProviderSnapshotChangeListener): this {
    this.events.off(event, listener);
    return this;
  }

  destroy(): void {
    this.destroyed = true;
    this.events.removeAllListeners();
    this.snapshots.clear();
    this.lastCheckedAts.clear();
    this.providerLoads.clear();
  }

  replaceRegistry(providerRegistry: Record<AgentProvider, ProviderDefinition>): void {
    this.providerRegistry = providerRegistry;

    for (const cwd of this.snapshots.keys()) {
      this.providerLoads.delete(cwd);
      this.lastCheckedAts.delete(cwd);
      this.snapshots.set(cwd, this.createLoadingEntries());
      this.emitChange(cwd);
      void this.warmUp(cwd);
    }
  }

  private createLoadingEntries(): Map<AgentProvider, ProviderSnapshotEntry> {
    const entries = new Map<AgentProvider, ProviderSnapshotEntry>();
    for (const provider of this.getProviderIds()) {
      const definition = this.providerRegistry[provider];
      entries.set(provider, {
        provider,
        status: "loading",
        enabled: definition?.enabled ?? true,
        label: definition?.label,
        description: definition?.description,
        defaultModeId: definition?.defaultModeId ?? null,
      });
    }
    return entries;
  }

  private async warmUp(cwd: string, providers?: AgentProvider[]): Promise<void> {
    const providersToRefresh = providers ?? this.getProviderIds();

    await this.loadProviders({
      cwd,
      providers: providersToRefresh,
      force: false,
    });
    if (!providers) {
      this.lastCheckedAts.set(cwd, this.now());
    }
  }

  private async refreshProviders(cwd: string, providers: AgentProvider[]): Promise<void> {
    await this.loadProviders({ cwd, providers, force: true });
  }

  private async loadProviders(options: ProviderLoadOptions): Promise<void> {
    await Promise.allSettled(
      options.providers.map((provider) => this.loadProvider({ ...options, provider })),
    );
  }

  private loadProvider(options: ProviderLoadOptions & { provider: AgentProvider }): Promise<void> {
    const definition = this.providerRegistry[options.provider];
    if (!definition) {
      return Promise.resolve();
    }

    const existingLoad = this.getProviderLoad(options.cwd, options.provider);
    if (existingLoad && !options.force) {
      return existingLoad.promise;
    }

    const load: ProviderLoad = {
      promise: Promise.resolve(),
    };
    this.setProviderLoad(options.cwd, options.provider, load);
    load.promise = Promise.resolve()
      .then(() =>
        this.refreshProvider({
          cwd: options.cwd,
          provider: options.provider,
          definition,
          load,
          force: options.force,
        }),
      )
      .finally(() => {
        const providerLoads = this.providerLoads.get(options.cwd);
        if (providerLoads?.get(options.provider) === load) {
          providerLoads.delete(options.provider);
        }
        if (providerLoads?.size === 0) {
          this.providerLoads.delete(options.cwd);
        }
      });
    return load.promise;
  }

  private async refreshProvider(options: {
    cwd: string;
    provider: AgentProvider;
    definition: ProviderDefinition;
    load: ProviderLoad;
    force: boolean;
  }): Promise<void> {
    const { cwd, provider, definition, load, force } = options;
    const snapshot = this.getOrCreateSnapshot(options.cwd);
    const base = {
      provider,
      label: definition.label,
      description: definition.description,
      defaultModeId: definition.defaultModeId,
    };
    const setEntry = (entry: ProviderSnapshotEntry) => {
      if (!this.isCurrentProviderLoad(cwd, provider, load)) {
        return false;
      }
      snapshot.set(provider, entry);
      this.emitChange(cwd);
      return true;
    };

    try {
      if (!definition.enabled) {
        setEntry({ ...base, status: "unavailable", enabled: false });
        return;
      }

      const client = definition.createClient(this.logger);
      const available = await withTimeout(
        client.isAvailable(),
        this.refreshTimeoutMs,
        `Timed out checking ${definition.label} availability after ${this.refreshTimeoutMs}ms`,
      );
      if (!available) {
        setEntry({ ...base, status: "unavailable", enabled: true });
        return;
      }

      const [models, modes] = await withTimeout(
        Promise.all([
          definition.fetchModels({ cwd, force }),
          definition.fetchModes({ cwd, force }),
        ]),
        this.refreshTimeoutMs,
        `Timed out refreshing ${definition.label} after ${this.refreshTimeoutMs}ms`,
      );

      setEntry({
        ...base,
        status: "ready",
        enabled: true,
        models,
        modes,
        fetchedAt: new Date().toISOString(),
      });
    } catch (error) {
      const emitted = setEntry({
        ...base,
        status: "error",
        enabled: true,
        error: toErrorMessage(error),
      });
      if (emitted) {
        this.logger.warn({ err: error, provider, cwd }, "Failed to refresh provider snapshot");
      }
    }
  }

  private getProviderLoad(cwdKey: string, provider: AgentProvider): ProviderLoad | undefined {
    return this.providerLoads.get(cwdKey)?.get(provider);
  }

  private setProviderLoad(cwdKey: string, provider: AgentProvider, load: ProviderLoad): void {
    let providerLoads = this.providerLoads.get(cwdKey);
    if (!providerLoads) {
      providerLoads = new Map<AgentProvider, ProviderLoad>();
      this.providerLoads.set(cwdKey, providerLoads);
    }
    providerLoads.set(provider, load);
  }

  private isCurrentProviderLoad(
    cwdKey: string,
    provider: AgentProvider,
    load: ProviderLoad,
  ): boolean {
    return this.providerLoads.get(cwdKey)?.get(provider) === load;
  }

  private emitChange(cwdKey: string): void {
    if (this.destroyed) {
      return;
    }
    const snapshot = this.snapshots.get(cwdKey);
    if (!snapshot) {
      return;
    }
    this.events.emit("change", entriesToArray(snapshot), cwdKey);
  }

  private shouldRevalidate(cwdKey: string): boolean {
    if (this.providerLoads.has(cwdKey)) {
      return false;
    }
    const lastCheckedAt = this.lastCheckedAts.get(cwdKey);
    if (lastCheckedAt === undefined) {
      return false;
    }
    return this.now() - lastCheckedAt > this.ttlMs;
  }

  private getOrCreateSnapshot(cwdKey: string): Map<AgentProvider, ProviderSnapshotEntry> {
    const existing = this.snapshots.get(cwdKey);
    if (existing) {
      return existing;
    }

    const created = this.createLoadingEntries();
    this.snapshots.set(cwdKey, created);
    return created;
  }

  private resetSnapshotToLoading(
    cwdKey: string,
    providers?: AgentProvider[],
  ): Map<AgentProvider, ProviderSnapshotEntry> {
    const snapshot = this.getOrCreateSnapshot(cwdKey);
    const loadingEntries = this.createLoadingEntries();

    if (!providers) {
      snapshot.clear();
      for (const [provider, entry] of loadingEntries) {
        snapshot.set(provider, entry);
      }
      return snapshot;
    }

    for (const provider of providers) {
      const loadingEntry = loadingEntries.get(provider);
      if (!loadingEntry) continue;
      const existing = snapshot.get(provider);
      snapshot.set(provider, {
        ...loadingEntry,
        models: existing?.models,
        modes: existing?.modes,
        fetchedAt: existing?.fetchedAt,
      });
    }
    return snapshot;
  }

  private getProviderIds(): AgentProvider[] {
    return Object.keys(this.providerRegistry);
  }

  private resolveRefreshProviders(providers?: AgentProvider[]): AgentProvider[] | undefined {
    if (!providers || providers.length === 0) {
      return undefined;
    }

    const providerIds = new Set(this.getProviderIds());
    return Array.from(new Set(providers)).filter((provider) => providerIds.has(provider));
  }
}

export function resolveSnapshotCwd(cwd?: string | null): string {
  const trimmed = cwd?.trim();
  if (!trimmed) {
    return homedir();
  }
  const expanded =
    trimmed === "~" || trimmed.startsWith("~/") ? `${homedir()}${trimmed.slice(1)}` : trimmed;
  return resolve(expanded);
}

function resolveGlobalSnapshotCwd(): string {
  return resolveSnapshotCwd();
}

function entriesToArray(
  entries: Map<AgentProvider, ProviderSnapshotEntry>,
): ProviderSnapshotEntry[] {
  return Array.from(entries.values(), cloneEntry);
}

function cloneEntry(entry: ProviderSnapshotEntry): ProviderSnapshotEntry {
  return {
    ...entry,
    models: entry.models?.map((model) => ({ ...model })),
    modes: entry.modes?.map((mode) => ({ ...mode })),
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string" && error) {
    return error;
  }
  return "Unknown error";
}
