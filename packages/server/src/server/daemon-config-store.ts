import {
  loadPersistedConfig,
  savePersistedConfig,
  type PersistedConfig,
} from "./persisted-config.js";
import { ProviderOverrideSchema } from "./agent/provider-launch-config.js";
import { MutableDaemonConfigSchema, MutableDaemonConfigPatchSchema } from "../shared/messages.js";

export type { MutableDaemonConfig, MutableDaemonConfigPatch } from "../shared/messages.js";

type MutableDaemonConfig = import("../shared/messages.js").MutableDaemonConfig;
type MutableDaemonConfigPatch = import("../shared/messages.js").MutableDaemonConfigPatch;
type ProviderOverride = import("./agent/provider-launch-config.js").ProviderOverride;

interface LoggerLike {
  child(bindings: Record<string, unknown>): LoggerLike;
  info(...args: unknown[]): void;
}

type ConfigListener = (config: MutableDaemonConfig) => void;
type FieldChangeHandler = (value: unknown) => void;

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

function getValueAtPath(config: MutableDaemonConfig, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((value, segment) => (isRecord(value) ? value[segment] : undefined), config);
}

function isEqualValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
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
    nextOverrides[providerId] = {
      ...nextOverrides[providerId],
      ...ProviderOverrideSchema.strip().parse(providerConfig),
    };
  }

  return nextOverrides;
}

export class DaemonConfigStore {
  private current: MutableDaemonConfig;
  private readonly paseoHome: string;
  private readonly logger: LoggerLike | undefined;
  private readonly changeListeners = new Set<ConfigListener>();
  private readonly fieldChangeHandlers = new Map<string, Set<FieldChangeHandler>>();

  constructor(paseoHome: string, initial: MutableDaemonConfig, logger?: LoggerLike) {
    this.paseoHome = paseoHome;
    this.logger = getLogger(logger);
    this.current = MutableDaemonConfigSchema.parse(initial);
  }

  public get(): MutableDaemonConfig {
    return this.current;
  }

  public patch(partial: MutableDaemonConfigPatch): MutableDaemonConfig {
    const parsedPatch = MutableDaemonConfigPatchSchema.parse(partial);
    const next = MutableDaemonConfigSchema.parse(deepMerge(this.current, parsedPatch));

    const changedFieldPaths = Array.from(this.fieldChangeHandlers.keys()).filter((path) => {
      return !isEqualValue(getValueAtPath(this.current, path), getValueAtPath(next, path));
    });

    if (changedFieldPaths.length === 0 && isEqualValue(this.current, next)) {
      return this.current;
    }

    // Persist before updating in-memory state so that if persistence fails,
    // runtime and disk stay consistent.
    this.persistConfig(next);
    this.current = next;

    for (const path of changedFieldPaths) {
      const handlers = this.fieldChangeHandlers.get(path);
      if (!handlers) {
        continue;
      }
      const value = getValueAtPath(next, path);
      for (const handler of handlers) {
        handler(value);
      }
    }

    for (const listener of this.changeListeners) {
      listener(next);
    }

    return next;
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

  private persistConfig(config: MutableDaemonConfig): void {
    const persisted = loadPersistedConfig(this.paseoHome, this.logger);
    const nextPersisted = mergeMutableConfigIntoPersistedConfig({
      persisted,
      mutable: config,
    });
    savePersistedConfig(this.paseoHome, nextPersisted, this.logger);
  }
}

function mergeMutableConfigIntoPersistedConfig(params: {
  persisted: PersistedConfig;
  mutable: MutableDaemonConfig;
}): PersistedConfig {
  const { persisted, mutable } = params;
  const providerOverrides = applyMutableProviderConfigToOverrides(
    persisted.agents?.providers as Record<string, ProviderOverride> | undefined,
    mutable.providers,
  );
  const persistedAgents = persisted.agents as
    | ({ providers?: Record<string, ProviderOverride> } & Record<string, unknown>)
    | undefined;

  return {
    ...persisted,
    daemon: {
      ...persisted.daemon,
      mcp: {
        ...persisted.daemon?.mcp,
        injectIntoAgents: mutable.mcp.injectIntoAgents,
      },
    },
    agents:
      providerOverrides && Object.keys(providerOverrides).length > 0
        ? {
            ...persistedAgents,
            providers: providerOverrides,
          }
        : persisted.agents,
  } as PersistedConfig;
}
