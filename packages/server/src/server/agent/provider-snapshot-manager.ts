import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { resolve } from "node:path";

import type { Logger } from "pino";

import { expandTilde } from "../../utils/path.js";
import { withTimeout } from "../../utils/promise-timeout.js";
import {
  capShutdownDeadline,
  createShutdownDeadline,
  DAEMON_GRACEFUL_SHUTDOWN_BUDGET_MS,
  remainingShutdownTimeMs,
  settleBeforeShutdownDeadline,
  type ShutdownDeadline,
} from "../../utils/shutdown-deadline.js";
import type {
  AgentClient,
  AgentCreateConfigParent,
  AgentMode,
  AgentModelDefinition,
  AgentProvider,
  FetchCatalogOptions,
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
import { BUILTIN_PROVIDER_IDS } from "@getpaseo/protocol/provider-manifest";
import { applyMutableProviderConfigToOverrides } from "../daemon-config-store.js";
import {
  formatProviderDiagnostic,
  formatProviderDiagnosticError,
} from "./providers/diagnostic-utils.js";
import type { MutableDaemonConfig } from "../daemon-config-store.js";

const DEFAULT_REFRESH_TIMEOUT_MS = 60_000;
const DEFAULT_DIAGNOSTIC_TIMEOUT_MS = 120_000;
// Codex owns a five-second startup drain. Keep an additional half-second so
// that provider-local cleanup can publish its bounded receipt before the
// shared daemon deadline expires.
const PROVIDER_CLIENT_SHUTDOWN_RESERVE_MS = 5_500;
const REFRESH_TIMEOUT_ENV_VAR = "PASEO_PROVIDER_REFRESH_TIMEOUT_MS";
export const GLOBAL_PROVIDER_SNAPSHOT_KEY = "paseo:global";

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

function resolveDiagnosticTimeoutMs(option: number | undefined, refreshTimeoutMs: number): number {
  if (typeof option === "number" && Number.isFinite(option) && option > 0) {
    return option;
  }
  return Math.max(refreshTimeoutMs, DEFAULT_DIAGNOSTIC_TIMEOUT_MS);
}

function omitProviderOverrides(
  overrides: Record<string, ProviderOverride> | undefined,
  providers: readonly string[],
): Record<string, ProviderOverride> | undefined {
  if (!overrides || providers.length === 0) {
    return overrides;
  }

  const nextOverrides = { ...overrides };
  for (const provider of providers) {
    delete nextOverrides[provider];
  }

  return Object.keys(nextOverrides).length > 0 ? nextOverrides : undefined;
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
  diagnosticTimeoutMs?: number;
}

interface ProviderSnapshotRefreshOptions {
  cwd: string;
  providers?: AgentProvider[];
}

interface ProviderSnapshotWarmUpOptions {
  cwd?: string | null;
  providers?: AgentProvider[];
}

interface ProviderSnapshotReadOptions {
  cwd?: string | null;
  providers?: AgentProvider[];
  wait?: boolean;
}

interface ApplyMutableProviderConfigOptions {
  removeProviders?: readonly string[];
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
  snapshotCwd: string;
  providers: AgentProvider[];
  catalogScope: ProviderCatalogScope;
  force: boolean;
}
interface ProviderLoad {
  promise: Promise<void>;
  drained: Promise<void>;
  controller: AbortController;
  providerOperations: Promise<unknown>[];
  client?: AgentClient;
  runtimeEpoch: number;
  snapshotCwd: string;
  provider: AgentProvider;
}

type ProviderCatalogScope = { scope: "global" } | { scope: "workspace"; cwd: string };

interface ProviderSnapshotTarget {
  snapshotCwd: string;
  catalogScope: ProviderCatalogScope;
}

type ProviderRuntimeLifecycle = "active" | "shutting_down" | "shut_down";

export class ProviderSnapshotManager {
  private readonly snapshots = new Map<string, Map<AgentProvider, ProviderSnapshotEntry>>();
  private readonly providerLoads = new Map<string, Map<AgentProvider, ProviderLoad>>();
  private readonly activeProviderLoads = new Set<ProviderLoad>();
  private readonly events = new EventEmitter();
  private destroyed = false;
  private lifecycle: ProviderRuntimeLifecycle = "active";
  private runtimeEpoch = 0;
  private shutdownPromise: Promise<void> | null = null;
  private readonly pendingClientShutdowns = new Set<Promise<void>>();
  private readonly refreshTimeoutMs: number;
  private readonly diagnosticTimeoutMs: number;
  private readonly logger: Logger;
  private readonly workspaceGitService?: Pick<WorkspaceGitService, "resolveRepoRoot">;
  private readonly managedProcesses?: ManagedProcessRegistry;
  private readonly isDev: boolean;
  private readonly extraClients: Partial<Record<AgentProvider, AgentClient>>;
  private runtimeSettings: AgentProviderRuntimeSettingsMap | undefined;
  private providerOverrides: Record<string, ProviderOverride> | undefined;
  private baseProviderOverrides: Record<string, ProviderOverride> | undefined;
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
    this.diagnosticTimeoutMs = resolveDiagnosticTimeoutMs(
      options.diagnosticTimeoutMs,
      this.refreshTimeoutMs,
    );
    this.providerRegistry = this.buildRegistry();
    this.providerClients = { ...this.extraClients } as Record<AgentProvider, AgentClient>;
  }

  getSnapshot(cwd?: string): ProviderSnapshotEntry[] {
    const target = resolveProviderSnapshotTarget(cwd);
    return this.getSnapshotForTarget(target);
  }

  async refreshSnapshotForCwd(options: ProviderSnapshotRefreshOptions): Promise<void> {
    this.assertRuntimeActive();
    const snapshotCwd = resolveSnapshotCwd(options.cwd);
    const target = createWorkspaceSnapshotTarget(snapshotCwd);
    const providers = this.resolveRefreshProviders(options.providers);
    this.resetSnapshotToLoading(snapshotCwd, providers, { preserveExisting: false });
    this.emitChange(snapshotCwd);
    await this.refreshProviders(target, providers ?? this.getProviderIds());
  }

  async refreshSettingsSnapshot(
    options: Omit<ProviderSnapshotRefreshOptions, "cwd"> = {},
  ): Promise<void> {
    this.assertRuntimeActive();
    const target = createGlobalSnapshotTarget();
    const homeCwd = target.snapshotCwd;
    const providers = this.resolveRefreshProviders(options.providers);
    const providersToRefresh = providers ?? this.getProviderIds();

    this.clearCachedProviders(providers);
    this.resetSnapshotToLoading(homeCwd, providers, { preserveExisting: false });
    this.emitChange(homeCwd);
    await this.refreshProviders(target, providersToRefresh);
  }

  async warmUpSnapshotForCwd(options: ProviderSnapshotWarmUpOptions): Promise<void> {
    this.assertRuntimeActive();
    const target = resolveProviderSnapshotTarget(options.cwd);
    const snapshotCwd = target.snapshotCwd;
    const providers = this.resolveRefreshProviders(options.providers);
    if (options.providers && providers?.length === 0) {
      return;
    }

    const providersToWarm = this.resolveProvidersToWarm(snapshotCwd, providers);
    if (providersToWarm.length === 0) {
      return;
    }
    await this.warmUp(target, providersToWarm);
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
    this.assertRuntimeActive();
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
    this.assertRuntimeActive();
    const existing = this.providerClients[provider];
    if (existing) {
      return existing;
    }
    const client = definition.createClient(this.logger);
    this.providerClients[provider] = client;
    return client;
  }

  async listProviders(input: ProviderSnapshotReadOptions = {}): Promise<ProviderSnapshotEntry[]> {
    const target = resolveProviderSnapshotTarget(input.cwd);
    if (input.wait && this.lifecycle === "active") {
      await this.warmUpSnapshotForCwd({ cwd: input.cwd, providers: input.providers });
    }
    const providerFilter = input.providers ? new Set(input.providers) : null;
    const entries = this.getSnapshotForTarget(target);
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
    const definition = this.providerRegistry[provider];
    if (!definition) {
      return {
        provider,
        diagnostic: formatProviderDiagnostic(provider, [
          { label: "Error", value: `Provider ${provider} is not configured` },
        ]),
      };
    }

    if (this.lifecycle !== "active") {
      const entry = await this.getProvider({ provider, wait: false });
      const modelCount = entry.status === "ready" ? String(entry.models?.length ?? 0) : "—";
      const status = formatProviderStatus(entry);
      const diagnostic = `${formatProviderDiagnostic(definition.label ?? provider, [
        { label: "Runtime", value: this.getRuntimeUnavailableReason() },
      ])}\n  Models: ${modelCount}\n  Status: ${status}`;
      return { provider, diagnostic };
    }

    const baseDiagnosticPromise = this.getBaseProviderDiagnostic(provider, definition);
    const snapshotEntryPromise = this.refreshDiagnosticSnapshotEntry(provider, definition);
    const [baseDiagnostic, entry] = await Promise.all([
      baseDiagnosticPromise,
      snapshotEntryPromise,
    ]);

    const modelCount = entry.status === "ready" ? String(entry.models?.length ?? 0) : "—";
    const status = formatProviderStatus(entry);
    const diagnostic = `${baseDiagnostic}\n  Models: ${modelCount}\n  Status: ${status}`;
    return { provider, diagnostic };
  }

  applyMutableProviderConfig(
    mutableProviders: MutableDaemonConfig["providers"] | undefined,
    options: ApplyMutableProviderConfigOptions = {},
  ): AgentManagerProviderState {
    this.assertRuntimeActive();
    const previousClients = Object.values(this.providerClients);
    this.abortProviderLoads(
      () => true,
      new Error("Provider catalog load canceled because provider configuration changed"),
    );
    this.providerLoads.clear();
    this.baseProviderOverrides = omitProviderOverrides(
      this.baseProviderOverrides,
      options.removeProviders ?? [],
    );
    this.providerOverrides = applyMutableProviderConfigToOverrides(
      this.baseProviderOverrides,
      mutableProviders,
    );
    this.providerRegistry = this.buildRegistry();
    this.providerClients = { ...this.extraClients } as Record<AgentProvider, AgentClient>;
    const retainedClients = new Set(Object.values(this.providerClients));
    const retiredClients = previousClients.filter((client) => !retainedClients.has(client));
    const retiredClientSet = new Set(retiredClients);
    const retiredLoads = Array.from(this.activeProviderLoads).filter(
      (load) => load.client && retiredClientSet.has(load.client),
    );
    this.queueClientShutdown(retiredClients, retiredLoads);

    for (const cwd of this.snapshots.keys()) {
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

  async shutdown(
    deadline: ShutdownDeadline = createShutdownDeadline(DAEMON_GRACEFUL_SHUTDOWN_BUDGET_MS),
  ): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }
    if (this.lifecycle === "shut_down") {
      return;
    }

    // Materialize a client per enabled provider so provider-owned resources
    // (background processes, sockets, etc.) get a chance to release even when
    // a given provider hasn't been touched yet during this daemon's lifetime.
    const state = this.getAgentManagerProviderState();
    const clients = Object.values(state.clients).filter(
      (client): client is AgentClient => client !== undefined,
    );
    this.lifecycle = "shutting_down";
    this.runtimeEpoch += 1;
    const activeLoads = Array.from(this.activeProviderLoads);
    const pendingClientShutdowns = Array.from(this.pendingClientShutdowns);
    this.invalidateProviderLoads();
    const shutdownPromise = Promise.all([
      this.shutdownClientsAfterProviderLoads(
        clients,
        activeLoads,
        "provider runtime shutdown",
        deadline,
      ),
      this.drainPendingClientShutdowns(pendingClientShutdowns, deadline),
    ])
      .then(() => undefined)
      .finally(() => {
        this.lifecycle = "shut_down";
        this.invalidateProviderLoads();
        this.demoteSnapshotsForUnavailableRuntime();
      });
    // Publish the shared operation before any synchronous observer notification
    // can re-enter shutdown or throw.
    this.shutdownPromise = shutdownPromise;
    this.demoteSnapshotsForUnavailableRuntime();
    return shutdownPromise;
  }

  destroy(): void {
    this.destroyed = true;
    this.abortProviderLoads(() => true, new Error("Provider snapshot manager was destroyed"));
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

  private getSnapshotForTarget(target: ProviderSnapshotTarget): ProviderSnapshotEntry[] {
    if (this.lifecycle !== "active") {
      return entriesToArray(this.getOrCreateSnapshot(target.snapshotCwd));
    }
    const providersToWarm = this.resolveProvidersToWarm(target.snapshotCwd);
    if (providersToWarm.length > 0) {
      void this.warmUp(target, providersToWarm);
    }
    return entriesToArray(this.getOrCreateSnapshot(target.snapshotCwd));
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
    if (entry.error) {
      throw new Error(entry.error);
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

  private async refreshDiagnosticSnapshotEntry(
    provider: AgentProvider,
    definition: ProviderDefinition,
  ): Promise<ProviderSnapshotEntry> {
    try {
      const target = createGlobalSnapshotTarget();
      this.resetSnapshotToLoading(target.snapshotCwd, [provider], { preserveExisting: false });
      this.emitChange(target.snapshotCwd);
      await this.refreshProviders(target, [provider]);
      return await this.getProvider({ provider, wait: false });
    } catch (error) {
      return {
        provider,
        status: "error",
        enabled: definition.enabled,
        source: this.getProviderSource(provider),
        label: definition.label,
        description: definition.description,
        defaultModeId: definition.defaultModeId,
        error: toErrorMessage(error),
      };
    }
  }

  private async getBaseProviderDiagnostic(
    provider: AgentProvider,
    definition: ProviderDefinition,
  ): Promise<string> {
    try {
      const client = this.ensureClient(provider, definition);
      if (client.getDiagnostic) {
        return (
          await withTimeout(
            client.getDiagnostic(),
            this.diagnosticTimeoutMs,
            `Timed out collecting ${definition.label ?? provider} diagnostic after ${
              this.diagnosticTimeoutMs
            }ms`,
          )
        ).diagnostic;
      }
      return formatProviderDiagnostic(definition.label ?? provider, [
        { label: "Diagnostic", value: "No diagnostic available" },
      ]);
    } catch (error) {
      return formatProviderDiagnosticError(definition.label ?? provider, error);
    }
  }

  private getProviderSource(provider: AgentProvider): ProviderSnapshotEntry["source"] {
    const isBuiltin = BUILTIN_PROVIDER_IDS.includes(provider);
    return !isBuiltin && this.providerOverrides?.[provider]?.extends ? "custom" : "builtin";
  }

  private createLoadingEntries(): Map<AgentProvider, ProviderSnapshotEntry> {
    const entries = new Map<AgentProvider, ProviderSnapshotEntry>();
    for (const provider of this.getProviderIds()) {
      const definition = this.providerRegistry[provider];
      entries.set(provider, {
        provider,
        status: "loading",
        enabled: definition?.enabled ?? true,
        source: this.getProviderSource(provider),
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
        source: this.getProviderSource(provider),
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

  private async warmUp(target: ProviderSnapshotTarget, providers?: AgentProvider[]): Promise<void> {
    const providersToRefresh = providers ?? this.getProviderIds();

    await this.loadProviders({
      snapshotCwd: target.snapshotCwd,
      catalogScope: target.catalogScope,
      providers: providersToRefresh,
      force: false,
    });
  }

  private async refreshProviders(
    target: ProviderSnapshotTarget,
    providers: AgentProvider[],
  ): Promise<void> {
    await this.loadProviders({
      snapshotCwd: target.snapshotCwd,
      catalogScope: target.catalogScope,
      providers,
      force: true,
    });
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

    this.abortProviderLoads(
      (load) => !providerSet || providerSet.has(load.provider),
      new Error("Provider catalog load was superseded by a forced refresh"),
    );

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
    this.assertRuntimeActive();
    await Promise.allSettled(
      options.providers.map((provider) => this.loadProvider({ ...options, provider })),
    );
  }

  private loadProvider(options: ProviderLoadOptions & { provider: AgentProvider }): Promise<void> {
    if (this.lifecycle !== "active") {
      return Promise.reject(new Error(this.getRuntimeUnavailableReason()));
    }
    const definition = this.providerRegistry[options.provider];
    if (!definition) {
      return Promise.resolve();
    }

    const existingLoad = this.getProviderLoad(options.snapshotCwd, options.provider);
    if (existingLoad && !options.force) {
      return existingLoad.promise;
    }
    if (existingLoad) {
      existingLoad.controller.abort(
        new Error("Provider catalog load was superseded by a forced refresh"),
      );
    }
    const existingEntry = this.snapshots.get(options.snapshotCwd)?.get(options.provider);
    if (existingEntry && existingEntry.status !== "loading" && !options.force) {
      return Promise.resolve();
    }

    const load: ProviderLoad = {
      promise: Promise.resolve(),
      drained: Promise.resolve(),
      controller: new AbortController(),
      providerOperations: [],
      runtimeEpoch: this.runtimeEpoch,
      snapshotCwd: options.snapshotCwd,
      provider: options.provider,
    };
    this.activeProviderLoads.add(load);
    this.setProviderLoad(options.snapshotCwd, options.provider, load);
    load.promise = Promise.resolve().then(() =>
      this.refreshProvider({
        snapshotCwd: options.snapshotCwd,
        catalogScope: options.catalogScope,
        provider: options.provider,
        definition,
        load,
        force: options.force,
      }),
    );
    load.drained = load.promise
      .then(
        () => Promise.allSettled(load.providerOperations),
        () => Promise.allSettled(load.providerOperations),
      )
      .then(() => undefined);
    void load.drained.then(() => {
      this.activeProviderLoads.delete(load);
      const providerLoads = this.providerLoads.get(options.snapshotCwd);
      if (providerLoads?.get(options.provider) === load) {
        providerLoads.delete(options.provider);
      }
      if (providerLoads?.size === 0) {
        this.providerLoads.delete(options.snapshotCwd);
      }
      return undefined;
    });
    return load.promise;
  }

  private async refreshProvider(options: {
    snapshotCwd: string;
    catalogScope: ProviderCatalogScope;
    provider: AgentProvider;
    definition: ProviderDefinition;
    load: ProviderLoad;
    force: boolean;
  }): Promise<void> {
    const { snapshotCwd, catalogScope, provider, definition, load, force } = options;
    const snapshot = this.getOrCreateSnapshot(snapshotCwd);
    const base = {
      provider,
      source: this.getProviderSource(provider),
      label: definition.label,
      description: definition.description,
      defaultModeId: definition.defaultModeId,
    };
    const setEntry = (entry: ProviderSnapshotEntry) => {
      if (!this.isCurrentProviderLoad(snapshotCwd, provider, load)) {
        return false;
      }
      snapshot.set(provider, entry);
      this.emitChange(snapshotCwd);
      return true;
    };

    try {
      if (!this.isProviderLoadRuntimeActive(load)) {
        return;
      }
      if (!definition.enabled) {
        setEntry({ ...base, status: "unavailable", enabled: false });
        return;
      }

      const client = this.ensureClient(provider, definition);
      load.client = client;
      const availabilityOperation = client.isAvailable({ signal: load.controller.signal });
      load.providerOperations.push(availabilityOperation);
      const available = await withAbortTimeout(
        availabilityOperation,
        load.controller,
        this.refreshTimeoutMs,
        `Timed out checking ${definition.label} availability after ${this.refreshTimeoutMs}ms`,
      );
      if (!this.isProviderLoadRuntimeActive(load)) {
        return;
      }
      if (!available) {
        setEntry({ ...base, status: "unavailable", enabled: true });
        return;
      }

      const catalogOptions = createFetchCatalogOptions(catalogScope, force);
      const catalogOperation = definition.fetchCatalog(
        {
          ...catalogOptions,
          timeoutMs: this.refreshTimeoutMs,
          signal: load.controller.signal,
        },
        client,
      );
      load.providerOperations.push(catalogOperation);
      const catalog = await withAbortTimeout(
        catalogOperation,
        load.controller,
        this.refreshTimeoutMs,
        `Timed out refreshing ${definition.label} after ${this.refreshTimeoutMs}ms`,
      );
      if (!this.isProviderLoadRuntimeActive(load)) {
        return;
      }

      setEntry({
        ...base,
        defaultModeId:
          catalog.defaultModeId === undefined ? definition.defaultModeId : catalog.defaultModeId,
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
        this.logger.warn(
          { err: error, provider, cwd: snapshotCwd },
          "Failed to refresh provider snapshot",
        );
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

    const created =
      this.lifecycle === "active"
        ? this.createLoadingEntries()
        : this.createUnavailableRuntimeEntries();
    this.snapshots.set(cwdKey, created);
    return created;
  }

  private assertRuntimeActive(): void {
    if (this.lifecycle !== "active") {
      throw new Error(this.getRuntimeUnavailableReason());
    }
  }

  private getRuntimeUnavailableReason(): string {
    return this.lifecycle === "shutting_down"
      ? "Provider runtime is shutting down"
      : "Provider runtime has shut down";
  }

  private invalidateProviderLoads(): void {
    this.abortProviderLoads(() => true, new Error(this.getRuntimeUnavailableReason()));
    this.providerLoads.clear();
  }

  private abortProviderLoads(predicate: (load: ProviderLoad) => boolean, reason: Error): void {
    for (const load of this.activeProviderLoads) {
      if (predicate(load)) {
        load.controller.abort(reason);
      }
    }
  }

  private queueClientShutdown(clients: AgentClient[], loads: ProviderLoad[]): void {
    if (clients.length === 0) {
      return;
    }
    const shutdown = this.shutdownClientsAfterProviderLoads(
      clients,
      loads,
      "retired provider client cleanup",
      createShutdownDeadline(DAEMON_GRACEFUL_SHUTDOWN_BUDGET_MS),
    );
    this.pendingClientShutdowns.add(shutdown);
    void shutdown.then(
      () => this.pendingClientShutdowns.delete(shutdown),
      (error) => {
        this.pendingClientShutdowns.delete(shutdown);
        this.logger.warn({ err: error }, "Retired provider client cleanup failed");
      },
    );
  }

  private async drainProviderLoadsBeforeClientShutdown(
    loads: ProviderLoad[],
    context: string,
    deadline: ShutdownDeadline,
  ): Promise<void> {
    if (loads.length === 0) {
      return;
    }
    const drainBudgetMs = Math.max(
      0,
      remainingShutdownTimeMs(deadline) - PROVIDER_CLIENT_SHUTDOWN_RESERVE_MS,
    );
    const drainDeadline = capShutdownDeadline(deadline, drainBudgetMs);
    const result = await settleBeforeShutdownDeadline(
      Promise.all(loads.map((load) => load.drained)).then(() => undefined),
      drainDeadline,
    );
    if (result.status !== "completed") {
      // Keep unresolved loads owned by activeProviderLoads until their real operations settle.
      // Client shutdown is the bounded terminal boundary for provider-owned resources.
      this.logger.warn(
        {
          ...(result.status === "failed" ? { err: result.error } : {}),
          context,
          drainBudgetMs,
          loads: loads.map((load) => ({ provider: load.provider, cwd: load.snapshotCwd })),
        },
        "Provider load drain did not complete; proceeding with client shutdown",
      );
    }
  }

  private async shutdownClientsAfterProviderLoads(
    clients: AgentClient[],
    loads: ProviderLoad[],
    context: string,
    deadline: ShutdownDeadline,
  ): Promise<void> {
    await this.drainProviderLoadsBeforeClientShutdown(loads, context, deadline);
    await shutdownAgentClients(clients, this.logger, {
      timeoutMs: Math.max(0, remainingShutdownTimeMs(deadline)),
    });
  }

  private async drainPendingClientShutdowns(
    pendingClientShutdowns: Promise<void>[],
    deadline: ShutdownDeadline,
  ): Promise<void> {
    if (pendingClientShutdowns.length === 0) {
      return;
    }
    const result = await settleBeforeShutdownDeadline(
      Promise.allSettled(pendingClientShutdowns),
      deadline,
    );
    if (result.status === "timed_out") {
      this.logger.warn(
        { pendingClientShutdownCount: pendingClientShutdowns.length },
        "Retired provider client cleanup exceeded the provider shutdown deadline",
      );
    } else if (result.status === "failed") {
      this.logger.warn(
        { err: result.error, pendingClientShutdownCount: pendingClientShutdowns.length },
        "Retired provider client cleanup failed during provider shutdown",
      );
    }
  }

  private isProviderLoadRuntimeActive(load: ProviderLoad): boolean {
    return (
      this.lifecycle === "active" &&
      load.runtimeEpoch === this.runtimeEpoch &&
      !load.controller.signal.aborted
    );
  }

  private demoteSnapshotsForUnavailableRuntime(): void {
    for (const cwd of this.snapshots.keys()) {
      this.snapshots.set(cwd, this.createUnavailableRuntimeEntries());
      try {
        this.emitChange(cwd);
      } catch (error) {
        this.logger.warn({ err: error, cwd }, "Provider snapshot shutdown notification failed");
      }
    }
  }

  private createUnavailableRuntimeEntries(): Map<AgentProvider, ProviderSnapshotEntry> {
    const entries = new Map<AgentProvider, ProviderSnapshotEntry>();
    const error = this.getRuntimeUnavailableReason();
    for (const provider of this.getProviderIds()) {
      const definition = this.providerRegistry[provider];
      const enabled = definition?.enabled ?? true;
      entries.set(provider, {
        provider,
        status: "unavailable",
        enabled,
        source: this.getProviderSource(provider),
        label: definition?.label,
        description: definition?.description,
        defaultModeId: definition?.defaultModeId ?? null,
        ...(enabled ? { error } : {}),
      });
    }
    return entries;
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

function resolveProviderSnapshotTarget(cwd?: string | null): ProviderSnapshotTarget {
  const trimmed = cwd?.trim();
  if (!trimmed) {
    return createGlobalSnapshotTarget();
  }
  return createWorkspaceSnapshotTarget(resolveSnapshotCwd(trimmed));
}

function createGlobalSnapshotTarget(): ProviderSnapshotTarget {
  return {
    snapshotCwd: GLOBAL_PROVIDER_SNAPSHOT_KEY,
    catalogScope: { scope: "global" },
  };
}

function createWorkspaceSnapshotTarget(cwd: string): ProviderSnapshotTarget {
  const snapshotCwd = resolveSnapshotCwd(cwd);
  return {
    snapshotCwd,
    catalogScope: { scope: "workspace", cwd: snapshotCwd },
  };
}

function createFetchCatalogOptions(
  scope: ProviderCatalogScope,
  force: boolean,
): FetchCatalogOptions {
  return scope.scope === "global"
    ? { scope: "global", force }
    : { scope: "workspace", cwd: scope.cwd, force };
}

export function isGlobalProviderSnapshotKey(cwd: string): boolean {
  return cwd === GLOBAL_PROVIDER_SNAPSHOT_KEY;
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

async function withAbortTimeout<T>(
  operation: Promise<T>,
  controller: AbortController,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function formatProviderStatus(entry: ProviderSnapshotEntry): string {
  if (entry.status === "ready") return "Ready";
  if (entry.status === "error") return `Error: ${entry.error ?? "Unknown error"}`;
  if (entry.status === "unavailable") return "Unavailable";
  return "Loading";
}
