import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { resolve } from "node:path";

import type { Logger } from "pino";

import { expandTilde } from "../../utils/path.js";
import { withTimeout } from "../../utils/promise-timeout.js";
import type {
  AgentClient,
  AgentCreateConfigParent,
  AgentMode,
  AgentModelDefinition,
  AgentProvider,
  ProviderSnapshotEntry,
} from "./agent-sdk-types.js";
import type { ManagedAgent } from "./agent-manager.js";
import type { WorkspaceGitService } from "../workspace-git-service.js";
import type { ManagedProcessRegistry } from "../managed-processes/managed-processes.js";
import type {
  AgentProviderRuntimeSettingsMap,
  ProviderOverride,
} from "./provider-launch-config.js";
import {
  buildProviderRegistry,
  shutdownAgentClients,
  type ProviderDefinition,
} from "./provider-registry.js";
import { applyMutableProviderConfigToOverrides } from "../daemon-config-store.js";
import { formatProviderDiagnostic } from "./providers/diagnostic-utils.js";
import type { MutableDaemonConfig } from "../daemon-config-store.js";

const DEFAULT_REFRESH_TIMEOUT_MS = 30_000;
const REFRESH_TIMEOUT_ENV_VAR = "PASEO_PROVIDER_REFRESH_TIMEOUT_MS";

// Provider refresh probes can be slow on cold starts (e.g. Copilot's first
// `copilot --acp` invocation, OpenCode workspace probes with many MCP servers).
// Allow operators to bump the ceiling via env var without rebuilding.
function resolveRefreshTimeoutMs(option: number | undefined): number {
  if (typeof option === "number" && Number.isFinite(option) && option > 0) {
    return option;
  }
  const fromEnv = process.env[REFRESH_TIMEOUT_ENV_VAR];
  if (fromEnv) {
    // Number() handles scientific notation (e.g. "6e4") which parseInt would silently truncate.
    const parsed = Number(fromEnv);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_REFRESH_TIMEOUT_MS;
}

type ProviderSnapshotChangeListener = (entries: ProviderSnapshotEntry[], cwd: string) => void;

export interface ProviderSnapshotManagerOptions {
  logger: Logger;
  runtimeSettings?: AgentProviderRuntimeSettingsMap;
  providerOverrides?: Record<string, ProviderOverride>;
  workspaceGitService?: Pick<WorkspaceGitService, "resolveRepoRoot">;
  managedProcesses?: ManagedProcessRegistry;
  isDev?: boolean;
  extraClients?: Partial<Record<AgentProvider, AgentClient>>;
  refreshTimeoutMs?: number;
}

interface ProviderSnapshotRefreshOptions {
  cwd: string;
  providers?: AgentProvider[];
}

interface ProviderSnapshotReadOptions {
  cwd?: string | null;
  providers?: AgentProvider[];
  wait?: boolean;
}

interface ProviderSnapshotProviderOptions {
  cwd?: string | null;
  provider: AgentProvider;
  wait?: boolean;
}

export interface ResolveProviderCreateConfigOptions {
  cwd?: string | null;
  provider: AgentProvider;
  requestedMode: string | undefined;
  featureValues: Record<string, unknown> | undefined;
  parent: ManagedAgent | null;
  unattended: boolean;
}

export interface ResolvedProviderCreateConfig {
  modeId: string | undefined;
  featureValues: Record<string, unknown> | undefined;
}

interface ResolveDefaultModelOptions {
  provider: AgentProvider;
  requestedModel?: string | null;
  cwd?: string;
}

export interface ProviderDiagnosticResult {
  provider: AgentProvider;
  diagnostic: string;
}

export interface AgentManagerProviderState {
  providerDefinitions: Partial<
    Record<AgentProvider, { enabled: boolean; derivedFromProviderId: string | null }>
  >;
  clients: Partial<Record<AgentProvider, AgentClient>>;
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
  private readonly providerLoads = new Map<string, Map<AgentProvider, ProviderLoad>>();
  private readonly events = new EventEmitter();
  private destroyed = false;
  private readonly refreshTimeoutMs: number;
  private readonly logger: Logger;
  private readonly workspaceGitService?: Pick<WorkspaceGitService, "resolveRepoRoot">;
  private readonly managedProcesses?: ManagedProcessRegistry;
  private readonly isDev: boolean;
  private readonly extraClients: Partial<Record<AgentProvider, AgentClient>>;
  private runtimeSettings: AgentProviderRuntimeSettingsMap | undefined;
  private providerOverrides: Record<string, ProviderOverride> | undefined;
  private readonly baseProviderOverrides: Record<string, ProviderOverride> | undefined;
  private providerRegistry: Record<AgentProvider, ProviderDefinition>;
  private providerClients: Record<AgentProvider, AgentClient>;

  constructor(options: ProviderSnapshotManagerOptions) {
    this.logger = options.logger;
    this.workspaceGitService = options.workspaceGitService;
    this.managedProcesses = options.managedProcesses;
    this.isDev = options.isDev === true;
    this.extraClients = options.extraClients ?? {};
    this.runtimeSettings = options.runtimeSettings;
    this.providerOverrides = options.providerOverrides;
    this.baseProviderOverrides = options.providerOverrides;
    this.refreshTimeoutMs = resolveRefreshTimeoutMs(options.refreshTimeoutMs);
    this.providerRegistry = this.buildRegistry();
    this.providerClients = { ...this.extraClients } as Record<AgentProvider, AgentClient>;
  }

  getSnapshot(cwd?: string): ProviderSnapshotEntry[] {
    const resolvedCwd = resolveSnapshotCwd(cwd);
    const providersToWarm = this.resolveProvidersToWarm(resolvedCwd);
    if (providersToWarm.length > 0) {
      void this.warmUp(resolvedCwd, providersToWarm);
    }
    return entriesToArray(this.getOrCreateSnapshot(resolvedCwd));
  }

  async refreshSnapshotForCwd(options: ProviderSnapshotRefreshOptions): Promise<void> {
    const snapshotCwd = resolveSnapshotCwd(options.cwd);
    const providers = this.resolveRefreshProviders(options.providers);
    this.resetSnapshotToLoading(snapshotCwd, providers, { preserveExisting: false });
    this.emitChange(snapshotCwd);
    await this.refreshProviders(snapshotCwd, providers ?? this.getProviderIds());
  }

  async refreshSettingsSnapshot(
    options: Omit<ProviderSnapshotRefreshOptions, "cwd"> = {},
  ): Promise<void> {
    const homeCwd = resolveSnapshotCwd();
    const providers = this.resolveRefreshProviders(options.providers);
    const providersToRefresh = providers ?? this.getProviderIds();

    this.clearCachedProviders(providers);
    this.resetSnapshotToLoading(homeCwd, providers, { preserveExisting: false });
    this.emitChange(homeCwd);
    await this.refreshProviders(homeCwd, providersToRefresh);
  }

  async warmUpSnapshotForCwd(options: ProviderSnapshotRefreshOptions): Promise<void> {
    const snapshotCwd = resolveSnapshotCwd(options.cwd);
    const providers = this.resolveRefreshProviders(options.providers);
    if (options.providers && providers?.length === 0) {
      return;
    }

    const providersToWarm = this.resolveProvidersToWarm(snapshotCwd, providers);
    if (providersToWarm.length === 0) {
      return;
    }
    await this.warmUp(snapshotCwd, providersToWarm);
  }

  async refresh(options: ProviderSnapshotRefreshOptions): Promise<void> {
    await this.refreshSnapshotForCwd(options);
  }

  listRegisteredProviderIds(): AgentProvider[] {
    return this.getProviderIds();
  }

  hasProvider(provider: AgentProvider): boolean {
    return Object.prototype.hasOwnProperty.call(this.providerRegistry, provider);
  }

  getProviderLabel(provider: AgentProvider): string {
    return this.providerRegistry[provider]?.label ?? provider;
  }

  getAgentManagerProviderState(): AgentManagerProviderState {
    const providerDefinitions: AgentManagerProviderState["providerDefinitions"] = {};
    const clients: AgentManagerProviderState["clients"] = {};
    for (const [provider, definition] of Object.entries(this.providerRegistry)) {
      providerDefinitions[provider] = {
        enabled: definition.enabled,
        derivedFromProviderId: definition.derivedFromProviderId,
      };
      if (definition.enabled) {
        clients[provider] = this.ensureClient(provider, definition);
      }
    }
    for (const [provider, client] of Object.entries(this.extraClients)) {
      if (client) {
        clients[provider] = client;
      }
    }
    return { providerDefinitions, clients };
  }

  private ensureClient(provider: AgentProvider, definition: ProviderDefinition): AgentClient {
    const existing = this.providerClients[provider];
    if (existing) {
      return existing;
    }
    const client = definition.createClient(this.logger);
    this.providerClients[provider] = client;
    return client;
  }

  async listProviders(input: ProviderSnapshotReadOptions = {}): Promise<ProviderSnapshotEntry[]> {
    const cwd = resolveSnapshotCwd(input.cwd);
    if (input.wait) {
      await this.warmUpSnapshotForCwd({ cwd, providers: input.providers });
    }
    const providerFilter = input.providers ? new Set(input.providers) : null;
    const entries = this.getSnapshot(cwd);
    return providerFilter ? entries.filter((entry) => providerFilter.has(entry.provider)) : entries;
  }

  async getProvider(input: ProviderSnapshotProviderOptions): Promise<ProviderSnapshotEntry> {
    const entry = (await this.listProviders({ ...input, providers: [input.provider] })).find(
      (candidate) => candidate.provider === input.provider,
    );
    if (!entry) {
      throw new Error(`Provider ${input.provider} is not configured`);
    }
    return entry;
  }

  async listModels(input: ProviderSnapshotProviderOptions): Promise<AgentModelDefinition[]> {
    const entry = await this.getReadyProvider(input);
    return entry.models ?? [];
  }

  async listModes(input: ProviderSnapshotProviderOptions): Promise<AgentMode[]> {
    const entry = await this.getReadyProvider(input);
    return entry.modes ?? [];
  }

  async resolveDefaultModel(input: ResolveDefaultModelOptions): Promise<string | undefined> {
    try {
      const trimmed = input.requestedModel?.trim();
      if (trimmed) {
        return trimmed;
      }
      const models = await this.listModels({
        provider: input.provider,
        cwd: input.cwd ? expandTilde(input.cwd) : undefined,
        wait: true,
      });
      const preferred = models.find((model) => model.isDefault) ?? models[0];
      return preferred?.id;
    } catch (error) {
      this.logger.warn({ err: error, provider: input.provider }, "Failed to resolve default model");
      return undefined;
    }
  }

  async resolveCreateConfig(
    input: ResolveProviderCreateConfigOptions,
  ): Promise<ResolvedProviderCreateConfig> {
    const entry = await this.getReadyProvider({
      cwd: input.cwd,
      provider: input.provider,
      wait: true,
    });
    const definition = this.requireProvider(input.provider);
    const parent = input.parent ? this.resolveParent(input.parent) : null;
    return definition.resolveCreateConfig({
      provider: input.provider,
      requestedMode: input.requestedMode,
      featureValues: input.featureValues,
      parent,
      unattended: input.unattended || parent?.isUnattended === true,
      availableModes: entry.modes ?? [],
    });
  }

  async getProviderDiagnostic(provider: AgentProvider): Promise<ProviderDiagnosticResult> {
    const definition = this.requireProvider(provider);
    const client = this.ensureClient(provider, definition);

    // Force-refresh the snapshot so Models/Status come from the single catalog authority.
    await this.refreshSnapshotForCwd({ cwd: homedir(), providers: [provider] });
    const entry = await this.getProvider({ cwd: homedir(), provider, wait: true });

    const modelCount = entry.status === "ready" ? String(entry.models?.length ?? 0) : "—";
    const status = formatProviderStatus(entry);

    const baseDiagnostic = client.getDiagnostic
      ? (await client.getDiagnostic()).diagnostic
      : formatProviderDiagnostic(definition.label ?? provider, [
          { label: "Diagnostic", value: "No diagnostic available" },
        ]);

    const diagnostic = `${baseDiagnostic}\n  Models: ${modelCount}\n  Status: ${status}`;
    return { provider, diagnostic };
  }

  applyMutableProviderConfig(
    mutableProviders: MutableDaemonConfig["providers"] | undefined,
  ): AgentManagerProviderState {
    this.providerOverrides = applyMutableProviderConfigToOverrides(
      this.baseProviderOverrides,
      mutableProviders,
    );
    this.providerRegistry = this.buildRegistry();
    this.providerClients = { ...this.extraClients } as Record<AgentProvider, AgentClient>;

    for (const cwd of this.snapshots.keys()) {
      this.providerLoads.delete(cwd);
      this.snapshots.set(cwd, this.reconcileSnapshotForRegistry(cwd));
      this.emitChange(cwd);
    }

    return this.getAgentManagerProviderState();
  }

  on(event: "change", listener: ProviderSnapshotChangeListener): this {
    this.events.on(event, listener);
    return this;
  }

  off(event: "change", listener: ProviderSnapshotChangeListener): this {
    this.events.off(event, listener);
    return this;
  }

  async shutdown(): Promise<void> {
    // Materialize a client per enabled provider so provider-owned resources
    // (background processes, sockets, etc.) get a chance to release even when
    // a given provider hasn't been touched yet during this daemon's lifetime.
    const state = this.getAgentManagerProviderState();
    const clients = Object.values(state.clients).filter(
      (client): client is AgentClient => client !== undefined,
    );
    await shutdownAgentClients(clients, this.logger);
  }

  destroy(): void {
    this.destroyed = true;
    this.events.removeAllListeners();
    this.snapshots.clear();
    this.providerLoads.clear();
  }

  private buildRegistry(): Record<AgentProvider, ProviderDefinition> {
    const registry = buildProviderRegistry(this.logger, {
      runtimeSettings: this.runtimeSettings,
      providerOverrides: this.providerOverrides,
      workspaceGitService: this.workspaceGitService,
      managedProcesses: this.managedProcesses,
      isDev: this.isDev,
    });

    for (const [provider, client] of Object.entries(this.extraClients) as Array<
      [AgentProvider, AgentClient]
    >) {
      const definition = registry[provider];
      if (!definition) continue;
      registry[provider] = {
        ...definition,
        createClient: () => client,
        resolveCreateConfig:
          client.resolveCreateConfig?.bind(client) ?? definition.resolveCreateConfig,
        isCreateConfigUnattended:
          client.isCreateConfigUnattended?.bind(client) ?? definition.isCreateConfigUnattended,
        fetchCatalog: client.fetchCatalog.bind(client),
      };
    }

    return registry;
  }

  private resolveParent(parent: ManagedAgent): AgentCreateConfigParent {
    const definition = this.requireProvider(parent.provider);
    return {
      provider: parent.provider,
      modeId: parent.currentModeId,
      isUnattended: definition.isCreateConfigUnattended({
        modeId: parent.currentModeId,
        config: parent.config,
        features: parent.features,
        availableModes: parent.availableModes ?? definition.modes ?? [],
      }),
    };
  }

  private async getReadyProvider(
    input: ProviderSnapshotProviderOptions,
  ): Promise<ProviderSnapshotEntry> {
    const entry = await this.getProvider(input);
    if (!entry.enabled) {
      throw new Error(`Provider '${entry.provider}' is disabled`);
    }
    if (entry.status === "ready") {
      return entry;
    }
    if (entry.status === "error") {
      throw new Error(entry.error ?? `Failed to load provider '${entry.provider}'`);
    }
    throw new Error(`Provider '${entry.provider}' is not available`);
  }

  private requireProvider(provider: AgentProvider): ProviderDefinition {
    const definition = this.providerRegistry[provider];
    if (!definition) {
      throw new Error(`Provider ${provider} is not configured`);
    }
    return definition;
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

  private reconcileSnapshotForRegistry(cwd: string): Map<AgentProvider, ProviderSnapshotEntry> {
    const existing = this.snapshots.get(cwd);
    const entries = new Map<AgentProvider, ProviderSnapshotEntry>();

    for (const provider of this.getProviderIds()) {
      const definition = this.providerRegistry[provider];
      const current = existing?.get(provider);
      const metadata = {
        provider,
        enabled: definition?.enabled ?? true,
        label: definition?.label,
        description: definition?.description,
        defaultModeId: definition?.defaultModeId ?? null,
      };

      if (!definition?.enabled || !current || current.status === "loading") {
        entries.set(provider, {
          ...metadata,
          status: "unavailable",
          enabled: definition?.enabled ?? true,
        });
        continue;
      }

      entries.set(provider, {
        ...current,
        ...metadata,
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
  }

  private async refreshProviders(cwd: string, providers: AgentProvider[]): Promise<void> {
    await this.loadProviders({ cwd, providers, force: true });
  }

  private resolveProvidersToWarm(cwd: string, providers?: AgentProvider[]): AgentProvider[] {
    const providersToInspect = providers ?? this.getProviderIds();
    const snapshot = this.snapshots.get(cwd);
    if (!snapshot) {
      this.resetSnapshotToLoading(cwd, providers);
      return providersToInspect;
    }

    const missingProviders = providersToInspect.filter((provider) => !snapshot.has(provider));
    if (missingProviders.length > 0) {
      this.resetSnapshotToLoading(cwd, missingProviders);
    }

    return providersToInspect.filter((provider) => snapshot.get(provider)?.status === "loading");
  }

  private clearCachedProviders(providers?: AgentProvider[]): void {
    const providerSet = providers ? new Set(providers) : null;
    const loadingEntries = this.createLoadingEntries();

    for (const [cwd, providerLoads] of Array.from(this.providerLoads.entries())) {
      if (!providerSet) {
        this.providerLoads.delete(cwd);
        continue;
      }

      for (const provider of providerSet) {
        providerLoads.delete(provider);
      }
      if (providerLoads.size === 0) {
        this.providerLoads.delete(cwd);
      }
    }

    for (const [cwd, snapshot] of this.snapshots.entries()) {
      if (!providerSet) {
        snapshot.clear();
        for (const [provider, entry] of loadingEntries) {
          snapshot.set(provider, entry);
        }
        this.emitChange(cwd);
        continue;
      }

      let changed = false;
      for (const provider of providerSet) {
        const loadingEntry = loadingEntries.get(provider);
        if (!loadingEntry) continue;
        snapshot.set(provider, loadingEntry);
        changed = true;
      }
      if (changed) {
        this.emitChange(cwd);
      }
    }
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
    const existingEntry = this.snapshots.get(options.cwd)?.get(options.provider);
    if (existingEntry && existingEntry.status !== "loading" && !options.force) {
      return Promise.resolve();
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

      const client = this.ensureClient(provider, definition);
      const available = await withTimeout(
        client.isAvailable(),
        this.refreshTimeoutMs,
        `Timed out checking ${definition.label} availability after ${this.refreshTimeoutMs}ms`,
      );
      if (!available) {
        setEntry({ ...base, status: "unavailable", enabled: true });
        return;
      }

      const catalog = await withTimeout(
        definition.fetchCatalog({ cwd, force }, client),
        this.refreshTimeoutMs,
        `Timed out refreshing ${definition.label} after ${this.refreshTimeoutMs}ms`,
      );

      setEntry({
        ...base,
        status: "ready",
        enabled: true,
        models: catalog.models,
        modes: catalog.modes,
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
    options: { preserveExisting?: boolean } = {},
  ): Map<AgentProvider, ProviderSnapshotEntry> {
    const snapshot = this.getOrCreateSnapshot(cwdKey);
    const loadingEntries = this.createLoadingEntries();
    const preserveExisting = options.preserveExisting ?? true;

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
        ...(preserveExisting
          ? {
              models: existing?.models,
              modes: existing?.modes,
              fetchedAt: existing?.fetchedAt,
            }
          : {}),
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
  let expanded =
    trimmed === "~" || trimmed.startsWith("~/") ? `${homedir()}${trimmed.slice(1)}` : trimmed;
  if (process.platform === "win32" && /^[A-Za-z]:$/.test(expanded)) {
    expanded = `${expanded}\\`;
  }
  let resolved = resolve(expanded);
  if (process.platform === "win32" && /^[A-Za-z]:$/.test(resolved)) {
    resolved = `${resolved}\\`;
  }
  return resolved;
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

function formatProviderStatus(entry: ProviderSnapshotEntry): string {
  if (entry.status === "ready") return "Ready";
  if (entry.status === "error") return `Error: ${entry.error ?? "Unknown error"}`;
  if (entry.status === "unavailable") return "Unavailable";
  return "Loading";
}
