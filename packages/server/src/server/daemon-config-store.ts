import {
  loadPersistedConfig,
  savePersistedConfig,
  type PersistedConfig,
} from "./persisted-config.js";
import { MutableDaemonConfigSchema, MutableDaemonConfigPatchSchema } from "../shared/messages.js";

export type { MutableDaemonConfig, MutableDaemonConfigPatch } from "../shared/messages.js";

type MutableDaemonConfig = import("../shared/messages.js").MutableDaemonConfig;
type MutableDaemonConfigPatch = import("../shared/messages.js").MutableDaemonConfigPatch;

type LoggerLike = {
  child(bindings: Record<string, unknown>): LoggerLike;
  info(...args: any[]): void;
};

type ConfigListener = (config: MutableDaemonConfig) => void;
type FieldChangeHandler = (value: unknown) => void;

function getLogger(logger: LoggerLike | undefined): LoggerLike | undefined {
  return logger?.child({ module: "daemon-config-store" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const REPLACE_PATHS = new Set(["agents.cliProviders"]);

function deepMerge<T extends Record<string, unknown>>(
  current: T,
  patch: Record<string, unknown>,
  path: string[] = [],
): T {
  const next: Record<string, unknown> = { ...current };

  for (const [key, patchValue] of Object.entries(patch)) {
    if (patchValue === undefined) {
      continue;
    }
    const nextPath = [...path, key];
    const nextPathKey = nextPath.join(".");
    const currentValue = next[key];
    if (REPLACE_PATHS.has(nextPathKey) && isRecord(patchValue)) {
      next[key] = { ...patchValue };
      continue;
    }
    if (isRecord(currentValue) && isRecord(patchValue)) {
      next[key] = deepMerge(currentValue, patchValue, nextPath);
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

export class DaemonConfigStore {
  private current: MutableDaemonConfig;
  private readonly hubcodeHome: string;
  private readonly logger: LoggerLike | undefined;
  private readonly changeListeners = new Set<ConfigListener>();
  private readonly fieldChangeHandlers = new Map<string, Set<FieldChangeHandler>>();

  constructor(hubcodeHome: string, initial: MutableDaemonConfig, logger?: LoggerLike) {
    this.hubcodeHome = hubcodeHome;
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
    const persisted = loadPersistedConfig(this.hubcodeHome, this.logger);
    const nextPersisted = mergeMutableConfigIntoPersistedConfig({
      persisted,
      mutable: config,
    });
    savePersistedConfig(this.hubcodeHome, nextPersisted, this.logger);
  }
}

function mergeMutableConfigIntoPersistedConfig(params: {
  persisted: PersistedConfig;
  mutable: MutableDaemonConfig;
}): PersistedConfig {
  const { persisted, mutable } = params;

  // Top-level `providers` patches (passthrough on MutableDaemonConfigSchema)
  // funnel into `agents.providers` overrides on disk. Each provider's override
  // is fully replaced when the patch supplies it — that's how we get
  // delete-by-omission semantics for fields like additionalModels.
  const providerOverridesPatch = isRecord((mutable as Record<string, unknown>).providers)
    ? ((mutable as Record<string, unknown>).providers as Record<string, unknown>)
    : undefined;

  const nextAgents = applyProviderOverridesPatch({
    agents: persisted.agents,
    providerOverridesPatch,
    cliProvidersPatch: mutable.agents?.cliProviders,
  });

  return {
    ...persisted,
    daemon: {
      ...persisted.daemon,
      mcp: {
        ...persisted.daemon?.mcp,
        injectIntoAgents: mutable.mcp.injectIntoAgents,
      },
    },
    agents: nextAgents,
  };
}

function applyProviderOverridesPatch(params: {
  agents: PersistedConfig["agents"];
  providerOverridesPatch: Record<string, unknown> | undefined;
  cliProvidersPatch: NonNullable<MutableDaemonConfig["agents"]>["cliProviders"];
}): PersistedConfig["agents"] {
  const { agents, providerOverridesPatch, cliProvidersPatch } = params;

  const hasProviderOverridesPatch = providerOverridesPatch !== undefined;
  const hasCliProvidersPatch = cliProvidersPatch !== undefined;
  if (!hasProviderOverridesPatch && !hasCliProvidersPatch) {
    return agents;
  }

  // Merge provider override patches one provider at a time. Within a single
  // provider entry the patch wins field-by-field — passing a fresh
  // additionalModels array fully replaces the stored array (no element-level
  // merge), matching the user-intent of "this is my new list".
  const nextProviders: Record<string, Record<string, unknown>> | undefined =
    hasProviderOverridesPatch
      ? mergeProviderOverrides(
          (agents as { providers?: Record<string, Record<string, unknown>> } | undefined)
            ?.providers,
          providerOverridesPatch,
        )
      : (agents as { providers?: Record<string, Record<string, unknown>> } | undefined)?.providers;

  const nextCliProviders = hasCliProvidersPatch
    ? Object.keys(cliProvidersPatch ?? {}).length > 0
      ? cliProvidersPatch
      : undefined
    : agents?.cliProviders;

  // Casting back to PersistedConfig["agents"] — the runtime shape is broader
  // than the static type because the persisted schema accepts ProviderOverride
  // entries directly. Schema validation on the next save catches anything off.
  return {
    ...(agents ?? {}),
    ...(nextProviders !== undefined ? { providers: nextProviders } : {}),
    ...(nextCliProviders !== undefined ? { cliProviders: nextCliProviders } : {}),
  } as PersistedConfig["agents"];
}

export function mergeProviderOverrides(
  current: Record<string, Record<string, unknown>> | undefined,
  patch: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const next: Record<string, Record<string, unknown>> = { ...(current ?? {}) };
  for (const [providerId, providerPatch] of Object.entries(patch)) {
    if (!isRecord(providerPatch)) {
      continue;
    }
    const existing = next[providerId];
    next[providerId] = isRecord(existing)
      ? { ...existing, ...providerPatch }
      : { ...providerPatch };
  }
  return next;
}
