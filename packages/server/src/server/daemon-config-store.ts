import {
  loadPersistedConfig,
  savePersistedConfig,
  type PersistedConfig,
} from "./persisted-config.js";
import { ProviderOverrideSchema } from "./agent/provider-launch-config.js";
import {
  MutableDaemonConfigSchema,
  MutableDaemonConfigPatchSchema,
} from "@getpaseo/protocol/messages";
import type { AgentSkillSelection } from "@getpaseo/protocol/messages";
import { normalizeRelayEndpoint } from "@getpaseo/protocol/daemon-endpoints";
import {
  RELAY_CONFIG_FIELDS,
  RELAY_CONFIG_FIELD_KEYS,
  type RelayConfigField,
} from "@getpaseo/protocol/relay-config";

export type { MutableDaemonConfig, MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";

type MutableDaemonConfig = import("@getpaseo/protocol/messages").MutableDaemonConfig;
type MutableDaemonConfigPatch = import("@getpaseo/protocol/messages").MutableDaemonConfigPatch;
type ProviderOverride = import("./agent/provider-launch-config.js").ProviderOverride;

interface SupportedMutableConfigPatch {
  relay?: {
    enabled?: boolean;
    endpoint?: string;
    publicEndpoint?: string;
    useTls?: boolean;
    publicUseTls?: boolean;
  };
  mcp?: { injectIntoAgents?: boolean };
  browserTools?: { enabled?: boolean };
  providers?: MutableDaemonConfig["providers"];
  removeProviders?: string[];
  metadataGeneration?: MutableDaemonConfig["metadataGeneration"];
  autoArchiveAfterMerge?: boolean;
  enableTerminalAgentHooks?: boolean;
  appendSystemPrompt?: string;
  terminalProfiles?: MutableDaemonConfig["terminalProfiles"];
  agentProfiles?: MutableDaemonConfig["agentProfiles"];
  skills?: MutableDaemonConfig["skills"];
  pluginsEnabled?: boolean;
  plugins?: MutableDaemonConfig["plugins"];
}

interface LoggerLike {
  child(bindings: Record<string, unknown>): LoggerLike;
  info(...args: unknown[]): void;
}

export interface DaemonConfigChangeDetails {
  removedProviders: readonly string[];
}

export interface DaemonConfigReloadResult {
  appliedPaths: string[];
  restartRequiredPaths: string[];
  overrideControlledPaths: string[];
}

export interface DaemonConfigPatchResult {
  config: MutableDaemonConfig;
  restartRequiredPaths: string[];
  overrideControlledPaths: string[];
}

export interface DaemonConfigReloadSource {
  resolve(persisted: PersistedConfig): {
    mutable: MutableDaemonConfig;
    overrideControlledPaths: readonly string[];
  };
}

type ConfigListener = (config: MutableDaemonConfig, details: DaemonConfigChangeDetails) => void;
type ConfigApplyRollback = () => void;
type ConfigApplyListener = (
  config: MutableDaemonConfig,
  previous: MutableDaemonConfig,
  details: DaemonConfigChangeDetails,
) => ConfigApplyRollback;
type FieldChangeHandler = (value: unknown) => void;

interface AppliedFieldChange {
  handler: FieldChangeHandler;
  previousValue: unknown;
}

function getLogger(logger: LoggerLike | undefined): LoggerLike | undefined {
  return logger?.child({ module: "daemon-config-store" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge<T extends Record<string, unknown>>(
  current: T,
  patch: Record<string, unknown>,
): T {
  const next: Record<string, unknown> = { ...current };

  for (const [key, patchValue] of Object.entries(patch)) {
    if (patchValue === undefined) {
      continue;
    }
    const currentValue = next[key];
    if (isRecord(currentValue) && isRecord(patchValue)) {
      next[key] = deepMerge(currentValue, patchValue);
      continue;
    }
    next[key] = patchValue;
  }

  return next as T;
}

function omitProvidersFromConfig<T extends { providers?: Record<string, unknown> }>(
  config: T,
  providers: readonly string[],
): T {
  if (providers.length === 0 || !config.providers) {
    return config;
  }

  let changed = false;
  const nextProviders = { ...config.providers };
  for (const provider of providers) {
    if (provider in nextProviders) {
      delete nextProviders[provider];
      changed = true;
    }
  }

  return changed ? ({ ...config, providers: nextProviders } as T) : config;
}

function omitMetadataGenerationProvidersFromConfig<
  T extends { metadataGeneration?: { providers?: Array<{ provider?: unknown }> } },
>(config: T, providers: readonly string[]): T {
  if (providers.length === 0 || !config.metadataGeneration?.providers) {
    return config;
  }

  const removedProviderIds = new Set(providers);
  const nextProviders = config.metadataGeneration.providers.filter((entry) => {
    return typeof entry.provider !== "string" || !removedProviderIds.has(entry.provider);
  });
  if (nextProviders.length === config.metadataGeneration.providers.length) {
    return config;
  }

  return {
    ...config,
    metadataGeneration: {
      ...config.metadataGeneration,
      providers: nextProviders,
    },
  } as T;
}

function omitProvidersFromOverrides(
  overrides: Record<string, ProviderOverride> | undefined,
  providers: readonly string[],
): Record<string, ProviderOverride> | undefined {
  if (!overrides) {
    return undefined;
  }

  const nextOverrides = { ...overrides };
  for (const provider of providers) {
    delete nextOverrides[provider];
  }

  return Object.keys(nextOverrides).length > 0 ? nextOverrides : undefined;
}

function getValueAtPath(config: MutableDaemonConfig, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((value, segment) => (isRecord(value) ? value[segment] : undefined), config);
}

function isEqualValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const RELOADABLE_PATHS = [
  "daemon.relay.enabled",
  "daemon.mcp.enabled",
  "daemon.mcp.injectIntoAgents",
  "daemon.browserTools.enabled",
  "daemon.hostnames",
  "daemon.cors.allowedOrigins",
  "daemon.trustedProxies",
  "daemon.git.maxProcessesPerSecond",
  "daemon.git.maxProcessConcurrency",
  "daemon.autoArchiveAfterMerge",
  "daemon.enableTerminalAgentHooks",
  "daemon.appendSystemPrompt",
  "daemon.terminalProfiles",
  "daemon.agentProfiles",
  "app.baseUrl",
  "agents.providers",
  "agents.catalogRefreshTimeoutMs",
  "agents.metadataGeneration",
  "agents.skills.selection",
  "pluginsEnabled",
] as const;

const PERSISTED_TO_MUTABLE_PATH = new Map<string, string>([
  [RELAY_CONFIG_FIELDS.enabled.persistedPath, RELAY_CONFIG_FIELDS.enabled.mutablePath],
  ["daemon.mcp.enabled", "mcp.enabled"],
  ["daemon.mcp.injectIntoAgents", "mcp.injectIntoAgents"],
  ["daemon.browserTools.enabled", "browserTools.enabled"],
  ["daemon.hostnames", "hostnames"],
  ["daemon.cors.allowedOrigins", "cors.allowedOrigins"],
  ["daemon.trustedProxies", "trustedProxies"],
  ["daemon.git.maxProcessesPerSecond", "git.maxProcessesPerSecond"],
  ["daemon.git.maxProcessConcurrency", "git.maxProcessConcurrency"],
  ["daemon.autoArchiveAfterMerge", "autoArchiveAfterMerge"],
  ["daemon.enableTerminalAgentHooks", "enableTerminalAgentHooks"],
  ["daemon.appendSystemPrompt", "appendSystemPrompt"],
  ["daemon.terminalProfiles", "terminalProfiles"],
  ["daemon.agentProfiles", "agentProfiles"],
  ["app.baseUrl", "app.baseUrl"],
  ["agents.providers", "providers"],
  ["agents.catalogRefreshTimeoutMs", "catalogRefreshTimeoutMs"],
  ["agents.metadataGeneration", "metadataGeneration"],
  ["agents.skills.selection", "skills.selection"],
  ["pluginsEnabled", "pluginsEnabled"],
]);

const RESTART_REQUIRED_MUTABLE_PATHS = new Map<string, string>(
  RELAY_CONFIG_FIELD_KEYS.filter((field) => RELAY_CONFIG_FIELDS[field].restartRequired).map(
    (field) => [RELAY_CONFIG_FIELDS[field].persistedPath, RELAY_CONFIG_FIELDS[field].mutablePath],
  ),
);

const RELAY_OVERRIDE_ENV_BY_PATH = new Map<string, string>(
  RELAY_CONFIG_FIELD_KEYS.map((field) => [
    RELAY_CONFIG_FIELDS[field].persistedPath,
    RELAY_CONFIG_FIELDS[field].env,
  ]),
);

function pathBelongsTo(path: string, owner: string): boolean {
  return path === owner || path.startsWith(`${owner}.`);
}

function diffPaths(previous: unknown, next: unknown, prefix = ""): string[] {
  if (isEqualValue(previous, next)) return [];
  if (!isRecord(previous) || !isRecord(next)) {
    if (isRecord(previous)) return leafPaths(previous, prefix);
    if (isRecord(next)) return leafPaths(next, prefix);
    return prefix ? [prefix] : [];
  }

  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  return Array.from(keys).flatMap((key) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return diffPaths(previous[key], next[key], path);
  });
}

function leafPaths(record: Record<string, unknown>, prefix: string): string[] {
  return Object.entries(record).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return isRecord(value) ? leafPaths(value, path) : [path];
  });
}

function compactOwnedPaths(paths: readonly string[], owners: readonly string[]): string[] {
  const compacted = new Set<string>();
  for (const path of paths) {
    const owner = owners.find((candidate) => pathBelongsTo(path, candidate));
    compacted.add(owner ?? path);
  }
  return Array.from(compacted).sort();
}

function pickSupportedRelayPatch(
  relay: MutableDaemonConfigPatch["relay"],
): SupportedMutableConfigPatch["relay"] {
  if (!relay) return undefined;
  const supported: NonNullable<SupportedMutableConfigPatch["relay"]> = {};
  if (relay.enabled !== undefined) supported.enabled = relay.enabled;
  if (relay.endpoint !== undefined) supported.endpoint = relay.endpoint;
  if (relay.publicEndpoint !== undefined) supported.publicEndpoint = relay.publicEndpoint;
  if (relay.useTls !== undefined) supported.useTls = relay.useTls;
  if (relay.publicUseTls !== undefined) supported.publicUseTls = relay.publicUseTls;
  return Object.keys(supported).length > 0 ? supported : undefined;
}

function pickSupportedPatchFields(patch: MutableDaemonConfigPatch): SupportedMutableConfigPatch {
  const relay = pickSupportedRelayPatch(patch.relay);
  return {
    ...(relay && Object.keys(relay).length > 0 ? { relay } : {}),
    ...(patch.mcp?.injectIntoAgents !== undefined
      ? { mcp: { injectIntoAgents: patch.mcp.injectIntoAgents } }
      : {}),
    ...(patch.browserTools?.enabled !== undefined
      ? { browserTools: { enabled: patch.browserTools.enabled } }
      : {}),
    ...(patch.providers !== undefined ? { providers: patch.providers } : {}),
    ...(patch.removeProviders !== undefined ? { removeProviders: patch.removeProviders } : {}),
    ...(patch.metadataGeneration?.providers !== undefined
      ? { metadataGeneration: { providers: patch.metadataGeneration.providers } }
      : {}),
    ...(patch.autoArchiveAfterMerge !== undefined
      ? { autoArchiveAfterMerge: patch.autoArchiveAfterMerge }
      : {}),
    ...(patch.enableTerminalAgentHooks !== undefined
      ? { enableTerminalAgentHooks: patch.enableTerminalAgentHooks }
      : {}),
    ...(patch.appendSystemPrompt !== undefined
      ? { appendSystemPrompt: patch.appendSystemPrompt }
      : {}),
    ...(patch.terminalProfiles !== undefined ? { terminalProfiles: patch.terminalProfiles } : {}),
    ...(patch.agentProfiles !== undefined ? { agentProfiles: patch.agentProfiles } : {}),
    ...(patch.pluginsEnabled !== undefined ? { pluginsEnabled: patch.pluginsEnabled } : {}),
    ...(patch.plugins !== undefined ? { plugins: patch.plugins } : {}),
  };
}

export function applyMutableProviderConfigToOverrides(
  baseOverrides: Record<string, ProviderOverride> | undefined,
  mutableProviders: MutableDaemonConfig["providers"] | undefined,
): Record<string, ProviderOverride> | undefined {
  if (!baseOverrides && (!mutableProviders || Object.keys(mutableProviders).length === 0)) {
    return undefined;
  }

  const nextOverrides: Record<string, ProviderOverride> = { ...baseOverrides };
  for (const [providerId, providerConfig] of Object.entries(mutableProviders ?? {})) {
    const previousOverride = nextOverrides[providerId];
    const parsedOverride = ProviderOverrideSchema.strip().parse(providerConfig);
    nextOverrides[providerId] = {
      ...previousOverride,
      ...parsedOverride,
      ...(parsedOverride.paseoTools
        ? {
            paseoTools: {
              ...previousOverride?.paseoTools,
              ...parsedOverride.paseoTools,
            },
          }
        : {}),
    };
  }

  return nextOverrides;
}

export class DaemonConfigStore {
  private current: MutableDaemonConfig;
  private readonly paseoHome: string;
  private readonly logger: LoggerLike | undefined;
  private readonly changeListeners = new Set<ConfigListener>();
  private readonly applyListeners = new Set<ConfigApplyListener>();
  private readonly fieldChangeHandlers = new Map<string, Set<FieldChangeHandler>>();
  private readonly relayEnabledMutable: boolean;
  private readonly overrideControlledPaths: string[];
  private readonly reloadSource: DaemonConfigReloadSource | undefined;
  private readonly startupPersisted: PersistedConfig;
  private lastKnownPersisted: PersistedConfig;

  constructor(
    paseoHome: string,
    initial: MutableDaemonConfig,
    logger?: LoggerLike,
    options: {
      relayEnabledMutable?: boolean;
      overrideControlledPaths?: readonly string[];
      reloadSource?: DaemonConfigReloadSource;
      startupPersisted?: PersistedConfig;
    } = {},
  ) {
    this.paseoHome = paseoHome;
    this.logger = getLogger(logger);
    this.current = MutableDaemonConfigSchema.parse({
      ...initial,
      relay: initial.relay ?? { enabled: true },
    });
    this.relayEnabledMutable = options.relayEnabledMutable ?? true;
    this.overrideControlledPaths = Array.from(
      new Set([
        ...(options.overrideControlledPaths ?? []),
        ...(!this.relayEnabledMutable ? ["daemon.relay.enabled"] : []),
      ]),
    ).sort();
    this.reloadSource = options.reloadSource;
    this.startupPersisted = options.startupPersisted ?? loadPersistedConfig(paseoHome, this.logger);
    this.lastKnownPersisted = this.startupPersisted;
  }

  public get(): MutableDaemonConfig {
    return this.current;
  }

  public patch(partial: MutableDaemonConfigPatch): MutableDaemonConfig {
    return this.patchWithResult(partial).config;
  }

  public patchWithResult(partial: MutableDaemonConfigPatch): DaemonConfigPatchResult {
    const parsedPatch = pickSupportedPatchFields(MutableDaemonConfigPatchSchema.parse(partial));
    this.assertPatchIsMutable(parsedPatch);
    const previous = this.current;
    const config = this.applySupportedPatch(parsedPatch);
    const restartRequiredPaths = Array.from(RESTART_REQUIRED_MUTABLE_PATHS.entries())
      .filter(([persistedPath, mutablePath]) => {
        const patchPath = mutablePath.replace("relay.", "");
        return (
          parsedPatch.relay?.[
            patchPath as keyof NonNullable<SupportedMutableConfigPatch["relay"]>
          ] !== undefined &&
          !isEqualValue(
            getValueAtPath(previous, mutablePath),
            getValueAtPath(config, mutablePath),
          ) &&
          !this.overrideControlledPaths.includes(persistedPath)
        );
      })
      .map(([persistedPath]) => persistedPath)
      .sort();
    return {
      config,
      restartRequiredPaths,
      overrideControlledPaths: this.getOverrideControlledPaths(),
    };
  }

  public getOverrideControlledPaths(): string[] {
    return [...this.overrideControlledPaths];
  }

  private assertPatchIsMutable(parsedPatch: SupportedMutableConfigPatch): void {
    for (const [field, value] of Object.entries(parsedPatch.relay ?? {})) {
      if (value === undefined) continue;
      const path = RELAY_CONFIG_FIELDS[field as RelayConfigField].persistedPath;
      if (!this.overrideControlledPaths.includes(path)) continue;
      const env = RELAY_OVERRIDE_ENV_BY_PATH.get(path);
      throw new Error(
        `Relay is controlled by a daemon launch override. Remove ${env ?? path} or the corresponding CLI option before changing it here.`,
      );
    }
    if (parsedPatch.relay?.endpoint !== undefined) {
      normalizeRelayEndpoint(parsedPatch.relay.endpoint);
    }
    if (parsedPatch.relay?.publicEndpoint !== undefined) {
      normalizeRelayEndpoint(parsedPatch.relay.publicEndpoint);
    }
  }

  public setAgentSkillSelection(selection: AgentSkillSelection): MutableDaemonConfig {
    return this.applySupportedPatch({ skills: { selection } });
  }

  private applySupportedPatch(parsedPatch: SupportedMutableConfigPatch): MutableDaemonConfig {
    const { removeProviders = [], ...configPatch } = parsedPatch;
    const removedProviders = Array.from(new Set(removeProviders));
    const merged = deepMerge(this.current, configPatch);
    if (parsedPatch.skills?.selection !== undefined) {
      merged.skills = { selection: parsedPatch.skills.selection };
    }
    if (parsedPatch.plugins !== undefined) merged.plugins = parsedPatch.plugins;
    const next = MutableDaemonConfigSchema.parse(
      omitMetadataGenerationProvidersFromConfig(
        omitProvidersFromConfig(merged, removedProviders),
        removedProviders,
      ),
    );

    const configChanged = !isEqualValue(this.current, next);

    if (!configChanged && removedProviders.length === 0) {
      return this.current;
    }

    const { previous: persistedBeforePatch, knownNext } = this.persistConfig(
      configPatch,
      removedProviders,
    );
    if (!configChanged) {
      this.lastKnownPersisted = knownNext;
      return this.current;
    }

    try {
      this.applyReplacement(next, { removedProviders });
      this.lastKnownPersisted = knownNext;
    } catch (error) {
      savePersistedConfig(this.paseoHome, persistedBeforePatch, this.logger);
      throw error;
    }

    return this.current;
  }

  public reload(): DaemonConfigReloadResult {
    if (!this.reloadSource) {
      throw new Error("Daemon config reload is unavailable for this daemon instance");
    }

    const persisted = loadPersistedConfig(this.paseoHome, this.logger);
    const resolved = this.reloadSource.resolve(persisted);
    // Plugin source changes require the plugin lifecycle operation or a daemon
    // restart. The global switch is independently reloadable.
    const desired = MutableDaemonConfigSchema.parse({
      ...resolved.mutable,
      plugins: this.current.plugins,
    });
    const changedSinceLastApply = diffPaths(this.lastKnownPersisted, persisted);
    const overrideControlledPaths = compactOwnedPaths(
      changedSinceLastApply.filter((path) =>
        resolved.overrideControlledPaths.some((owner) => pathBelongsTo(path, owner)),
      ),
      resolved.overrideControlledPaths,
    );
    const appliedPaths = RELOADABLE_PATHS.filter((persistedPath) => {
      if (resolved.overrideControlledPaths.some((owner) => pathBelongsTo(persistedPath, owner))) {
        return false;
      }
      const mutablePath = PERSISTED_TO_MUTABLE_PATH.get(persistedPath);
      return (
        mutablePath !== undefined &&
        !isEqualValue(
          getValueAtPath(this.current, mutablePath),
          getValueAtPath(desired, mutablePath),
        )
      );
    });
    const restartRequiredPaths = compactOwnedPaths(
      diffPaths(this.startupPersisted, persisted).filter((path) => {
        if (path === "$schema" || path === "version") return false;
        if (RELOADABLE_PATHS.some((owner) => pathBelongsTo(path, owner))) return false;
        return !resolved.overrideControlledPaths.some((owner) => pathBelongsTo(path, owner));
      }),
      [],
    );

    const removedProviders = Object.keys(this.current.providers).filter(
      (provider) => !(provider in desired.providers),
    );
    this.applyReplacement(desired, { removedProviders });
    this.lastKnownPersisted = persisted;

    return {
      appliedPaths: [...appliedPaths].sort(),
      restartRequiredPaths,
      overrideControlledPaths,
    };
  }

  private applyReplacement(
    next: MutableDaemonConfig,
    changeDetails: DaemonConfigChangeDetails,
  ): void {
    const changedFieldPaths = Array.from(this.fieldChangeHandlers.keys()).filter((path) => {
      return !isEqualValue(getValueAtPath(this.current, path), getValueAtPath(next, path));
    });
    if (isEqualValue(this.current, next) && changeDetails.removedProviders.length === 0) return;

    const previous = this.current;
    const appliedFieldChanges: AppliedFieldChange[] = [];
    const applyRollbacks: ConfigApplyRollback[] = [];
    this.current = next;
    try {
      for (const path of changedFieldPaths) {
        const handlers = this.fieldChangeHandlers.get(path);
        if (!handlers) {
          continue;
        }
        const value = getValueAtPath(next, path);
        const previousValue = getValueAtPath(previous, path);
        for (const handler of handlers) {
          appliedFieldChanges.push({ handler, previousValue });
          handler(value);
        }
      }
      for (const listener of this.applyListeners) {
        applyRollbacks.push(listener(next, previous, changeDetails));
      }
    } catch (error) {
      this.current = previous;
      const rollbackErrors: unknown[] = [];
      for (const rollback of applyRollbacks.toReversed()) {
        try {
          rollback();
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      for (const change of appliedFieldChanges.toReversed()) {
        try {
          change.handler(change.previousValue);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        const rollbackFailure = new Error(
          "Daemon config apply failed and one or more live owners could not roll back",
          { cause: error },
        );
        Object.assign(rollbackFailure, { rollbackErrors });
        throw rollbackFailure;
      }
      throw error;
    }

    for (const listener of this.changeListeners) {
      try {
        listener(next, changeDetails);
      } catch (error) {
        this.logger?.info({ error }, "Daemon config change notification failed");
      }
    }
  }

  public onFieldChange(path: string, handler: FieldChangeHandler): () => void {
    const handlers = this.fieldChangeHandlers.get(path) ?? new Set<FieldChangeHandler>();
    handlers.add(handler);
    this.fieldChangeHandlers.set(path, handlers);

    return () => {
      const currentHandlers = this.fieldChangeHandlers.get(path);
      if (!currentHandlers) {
        return;
      }
      currentHandlers.delete(handler);
      if (currentHandlers.size === 0) {
        this.fieldChangeHandlers.delete(path);
      }
    };
  }

  public onChange(listener: ConfigListener): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  public onApply(listener: ConfigApplyListener): () => void {
    // A live owner must either throw before changing its state or return a
    // rollback that restores the previous config. Notifications belong in
    // onChange so they run only after every live owner commits.
    this.applyListeners.add(listener);
    return () => {
      this.applyListeners.delete(listener);
    };
  }

  private persistConfig(
    patch: Omit<SupportedMutableConfigPatch, "removeProviders">,
    removeProviders: readonly string[],
  ): { previous: PersistedConfig; knownNext: PersistedConfig } {
    const persisted = loadPersistedConfig(this.paseoHome, this.logger);
    const merge = (source: PersistedConfig) =>
      mergeMutablePatchIntoPersistedConfig({
        persisted: source,
        patch,
        removeProviders,
        persistRelayEnabled: this.relayEnabledMutable,
      });
    const nextPersisted = merge(persisted);
    const knownNext = merge(this.lastKnownPersisted);
    savePersistedConfig(this.paseoHome, nextPersisted, this.logger);
    return { previous: persisted, knownNext };
  }
}

function mergeMutablePatchIntoPersistedConfig(params: {
  persisted: PersistedConfig;
  patch: Omit<SupportedMutableConfigPatch, "removeProviders">;
  removeProviders: readonly string[];
  persistRelayEnabled: boolean;
}): PersistedConfig {
  const { persisted, patch, removeProviders, persistRelayEnabled } = params;
  const daemon = mergeMutableDaemonPatch(persisted.daemon, patch, persistRelayEnabled);
  const agents = mergeMutableAgentPatch(persisted.agents, patch, removeProviders);
  return {
    ...persisted,
    ...(patch.pluginsEnabled !== undefined ? { pluginsEnabled: patch.pluginsEnabled } : {}),
    ...(patch.plugins !== undefined ? { plugins: patch.plugins } : {}),
    ...(daemon ? { daemon } : { daemon: undefined }),
    ...(agents ? { agents } : { agents: undefined }),
  } as PersistedConfig;
}

function mergeMutableAgentPatch(
  persistedAgents: PersistedConfig["agents"],
  patch: Omit<SupportedMutableConfigPatch, "removeProviders">,
  removeProviders: readonly string[],
): PersistedConfig["agents"] {
  if (
    patch.providers === undefined &&
    patch.metadataGeneration === undefined &&
    patch.skills === undefined &&
    removeProviders.length === 0
  ) {
    return persistedAgents;
  }

  const next = { ...persistedAgents } as Record<string, unknown>;
  const persistedProviderOverrides = omitProvidersFromOverrides(
    persistedAgents?.providers as Record<string, ProviderOverride> | undefined,
    removeProviders,
  );
  const providerOverrides = applyMutableProviderConfigToOverrides(
    persistedProviderOverrides,
    patch.providers,
  );
  if (providerOverrides) next["providers"] = providerOverrides;
  else delete next["providers"];

  if (patch.metadataGeneration?.providers !== undefined) {
    next["metadataGeneration"] = { providers: patch.metadataGeneration.providers };
  } else if (removeProviders.length > 0 && persistedAgents?.metadataGeneration?.providers) {
    const removed = new Set(removeProviders);
    next["metadataGeneration"] = {
      providers: persistedAgents.metadataGeneration.providers.filter(
        (entry) => !removed.has(entry.provider),
      ),
    };
  }

  if (patch.skills?.selection !== undefined) {
    next["skills"] = { selection: patch.skills.selection };
  }

  return Object.keys(next).length > 0 ? (next as PersistedConfig["agents"]) : undefined;
}

function mergeMutableDaemonPatch(
  persistedDaemon: PersistedConfig["daemon"],
  patch: Omit<SupportedMutableConfigPatch, "removeProviders">,
  persistRelayEnabled: boolean,
): PersistedConfig["daemon"] {
  const next = { ...persistedDaemon } as NonNullable<PersistedConfig["daemon"]>;
  next.relay = mergeMutableRelayPatch(next.relay, patch.relay, persistRelayEnabled);
  if (patch.mcp?.injectIntoAgents !== undefined) {
    next.mcp = { ...next.mcp, injectIntoAgents: patch.mcp.injectIntoAgents };
  }
  if (patch.browserTools?.enabled !== undefined) {
    next.browserTools = { ...next.browserTools, enabled: patch.browserTools.enabled };
  }
  if (patch.autoArchiveAfterMerge !== undefined) {
    next.autoArchiveAfterMerge = patch.autoArchiveAfterMerge;
  }
  if (patch.enableTerminalAgentHooks !== undefined) {
    next.enableTerminalAgentHooks = patch.enableTerminalAgentHooks;
  }
  if (patch.appendSystemPrompt !== undefined) next.appendSystemPrompt = patch.appendSystemPrompt;
  if (patch.terminalProfiles !== undefined) next.terminalProfiles = patch.terminalProfiles;
  if (patch.agentProfiles !== undefined) next.agentProfiles = patch.agentProfiles;
  return Object.keys(next).length > 0 ? next : undefined;
}

function mergeMutableRelayPatch(
  persistedRelay: NonNullable<PersistedConfig["daemon"]>["relay"],
  relayPatch: SupportedMutableConfigPatch["relay"],
  persistEnabled: boolean,
): NonNullable<PersistedConfig["daemon"]>["relay"] {
  if (!relayPatch) return persistedRelay;
  const next = { ...persistedRelay };
  if (persistEnabled && relayPatch.enabled !== undefined) next.enabled = relayPatch.enabled;
  if (relayPatch.endpoint !== undefined) next.endpoint = relayPatch.endpoint;
  if (relayPatch.publicEndpoint !== undefined) next.publicEndpoint = relayPatch.publicEndpoint;
  if (relayPatch.useTls !== undefined) next.useTls = relayPatch.useTls;
  if (relayPatch.publicUseTls !== undefined) next.publicUseTls = relayPatch.publicUseTls;
  return next;
}
