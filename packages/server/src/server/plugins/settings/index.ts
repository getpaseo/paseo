import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z, type ZodType } from "zod";
import {
  defineSettings,
  settingsRpc,
  type DeepReadonly,
  type PluginSettingsDecision,
  type PluginSettingsErrorCode,
  type SettingsDefinition,
} from "@getpaseo/plugin";
import type {
  PluginSettings,
  PluginSettingsState,
  PluginSettingsUpdateResult,
} from "@getpaseo/plugin/server";

const envelopeSchema = z.object({ version: z.number().int().positive(), values: z.json() });
const DEFAULT_WATCHDOG_MS = 30_000;
function message(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues.map((issue) => issue.message).join("\n");
  return error instanceof Error ? error.message : String(error);
}
const revisionOf = (raw: string) => createHash("sha256").update(raw).digest("hex");

type SettingsListener<Schema extends ZodType> = (
  state: PluginSettingsState<Schema>,
) => void | Promise<void>;
type SettingsWriteState<Schema extends ZodType> =
  | { status: "saved"; revision: string; values: z.output<Schema> }
  | { status: "conflict"; error: string }
  | { status: "invalid"; error: string };
interface SettingsInvalid {
  status: "invalid";
  revision: string;
  error: string;
  code: PluginSettingsErrorCode;
}

interface StoredSettings {
  raw: string | null;
  revision: string;
}

type LoadedSettings<Schema extends ZodType> =
  | { status: "ready"; stored: StoredSettings; values: z.output<Schema>; migrated: boolean }
  | SettingsInvalid;

interface ActiveMutation {
  reentryDetected: boolean;
}

// Plugin programming errors get fixed messages: a mutator's own error text may carry values the
// plugin never meant to surface.
const FIXED_MESSAGES: Partial<Record<PluginSettingsErrorCode, string>> = {
  mutator_threw: "The settings update failed before any values were saved.",
  thenable_returned: "Settings mutators must return synchronously.",
  reentrant_access: "A settings mutator cannot access the same document recursively.",
  store_poisoned: "Settings access is unavailable until the plugin is reloaded.",
};

function invalid(
  revision: string,
  code: PluginSettingsErrorCode,
  error: string = FIXED_MESSAGES[code] ?? code,
): SettingsInvalid {
  return { status: "invalid", revision, error, code };
}

function reportListenerError(id: string, error: unknown): void {
  console.error(`Plugin settings subscriber failed for ${id}`, error);
}

function copySettingsState<Schema extends ZodType>(
  state: PluginSettingsState<Schema>,
): PluginSettingsState<Schema> {
  if (state.status === "invalid") return { ...state };
  return { ...state, values: structuredClone(state.values) };
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof Reflect.get(value, "then") === "function"
  );
}

function deepFreeze<Value>(value: Value): DeepReadonly<Value> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value as DeepReadonly<Value>;
}

/** One instance per installation. The subprocess lifetime gives writes a single owner. */
export class PluginSettingsStore {
  private readonly definitions = new Map<string, SettingsDefinition>();
  private readonly activeMutations = new Map<string, ActiveMutation>();
  private queue: Promise<unknown> = Promise.resolve();
  private poisoned = false;
  private readonly poisonWaiters = new Set<() => void>();

  private readonly directory: string;
  private readonly changed: (id: string) => void;
  private readonly watchdogMs: number;
  private readonly onPoisoned: (message: string) => void;
  constructor(
    directory: string,
    changed: (id: string) => void,
    watchdogMs = DEFAULT_WATCHDOG_MS,
    onPoisoned: (message: string) => void = () => undefined,
  ) {
    this.directory = directory;
    this.changed = changed;
    this.watchdogMs = watchdogMs;
    this.onPoisoned = onPoisoned;
  }

  register<Schema extends ZodType>(definition: SettingsDefinition<Schema>) {
    defineSettings(definition);
    if (this.definitions.has(definition.id))
      throw new Error(`Duplicate settings: ${definition.id}`);
    this.definitions.set(definition.id, definition);
    const listeners = new Set<SettingsListener<Schema>>();
    const notify = (state: PluginSettingsState<Schema>): void => {
      for (const listener of listeners) {
        try {
          void Promise.resolve(listener(copySettingsState(state))).catch((error) =>
            reportListenerError(definition.id, error),
          );
        } catch (error) {
          reportListenerError(definition.id, error);
        }
      }
    };
    const rpc = settingsRpc(definition.id);
    const read = () => this.serial(() => this.read(definition, notify));
    const write = (input: z.output<typeof rpc.write.input>) =>
      this.serial(() => this.write(definition, input.revision, input.values, "save", notify));
    const reset = (input: z.output<typeof rpc.reset.input>) =>
      this.serial(() => this.write(definition, input.revision, {}, "reset", notify));
    const settings: PluginSettings<Schema> = {
      read: () => {
        if (this.markReentry(definition.id)) {
          return Promise.resolve(invalid("unknown", "reentrant_access"));
        }
        return read().catch((error: unknown) => this.poisonedOr(error));
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      update: <Result>(
        mutate: (
          current: DeepReadonly<z.output<Schema>>,
        ) => PluginSettingsDecision<z.input<Schema>, Result>,
      ): Promise<PluginSettingsUpdateResult<Schema, Result>> => {
        if (this.markReentry(definition.id)) {
          return Promise.resolve(invalid("unknown", "reentrant_access"));
        }
        return this.serial(() => this.update(definition, mutate, notify)).catch((error: unknown) =>
          this.poisonedOr(error),
        );
      },
    };
    return {
      settings,
      read: { contract: rpc.read, handle: read },
      write: { contract: rpc.write, handle: write },
      reset: { contract: rpc.reset, handle: reset },
    };
  }

  private poisonedOr(error: unknown): SettingsInvalid {
    if (this.poisoned) return invalid("unknown", "store_poisoned");
    throw error;
  }

  private markReentry(id: string): boolean {
    const active = this.activeMutations.get(id);
    if (!active) return false;
    active.reentryDetected = true;
    return true;
  }

  /**
   * A storage operation that never settles would block every later caller. The watchdog fails
   * all waiting and future callers instead, without releasing the stuck item to a second writer.
   */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    if (this.poisoned) return Promise.reject(new Error(FIXED_MESSAGES.store_poisoned));
    const guardedWork = async () => {
      if (this.poisoned) throw new Error(FIXED_MESSAGES.store_poisoned);
      const pending = work();
      const watchdog =
        this.watchdogMs > 0 ? setTimeout(() => this.poison(), this.watchdogMs) : undefined;
      try {
        return await pending;
      } finally {
        if (watchdog) clearTimeout(watchdog);
      }
    };
    const pending = this.queue.then(guardedWork);
    this.queue = pending.catch(() => undefined);
    const poison = new Promise<never>((_resolve, reject) => {
      const waiter = () => reject(new Error(FIXED_MESSAGES.store_poisoned));
      this.poisonWaiters.add(waiter);
      void pending.finally(() => this.poisonWaiters.delete(waiter)).catch(() => undefined);
    });
    return Promise.race([pending, poison]);
  }

  private poison(): void {
    if (this.poisoned) return;
    this.poisoned = true;
    this.onPoisoned(FIXED_MESSAGES.store_poisoned ?? "store_poisoned");
    for (const reject of this.poisonWaiters) reject();
    this.poisonWaiters.clear();
  }

  private async stored(id: string): Promise<StoredSettings> {
    try {
      const raw = await readFile(path.join(this.directory, `${id}.json`), "utf8");
      return { raw, revision: revisionOf(raw) };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        return { raw: null, revision: "missing" };
      throw error;
    }
  }

  private async load<Schema extends ZodType>(
    definition: SettingsDefinition<Schema>,
  ): Promise<LoadedSettings<Schema>> {
    const stored = await this.stored(definition.id);
    let code: PluginSettingsErrorCode = "stored_invalid";
    try {
      const envelope = stored.raw === null ? null : envelopeSchema.parse(JSON.parse(stored.raw));
      let values: unknown = envelope?.values ?? {};
      const migrated = envelope !== null && envelope.version !== definition.version;
      if (envelope && migrated) {
        if (envelope.version > definition.version)
          throw new Error("Settings were saved by a newer plugin version");
        if (!definition.migrate)
          throw new Error(`Settings version ${envelope.version} requires a migration`);
        code = "migration_failed";
        values = await definition.migrate(values, envelope.version);
      }
      const parsed = await definition.schema.parseAsync(values);
      z.json().parse(parsed);
      return { status: "ready", stored, values: parsed, migrated };
    } catch (error) {
      return invalid(stored.revision, code, message(error));
    }
  }

  private async read<Schema extends ZodType>(
    definition: SettingsDefinition<Schema>,
    notify: (state: PluginSettingsState<Schema>) => void,
  ): Promise<PluginSettingsState<Schema>> {
    const loaded = await this.load(definition);
    if (loaded.status === "invalid") return loaded;
    if (!loaded.migrated) {
      return { status: "ready", values: loaded.values, revision: loaded.stored.revision };
    }
    return this.commit(definition, loaded.values, notify);
  }

  private async update<Schema extends ZodType, Result>(
    definition: SettingsDefinition<Schema>,
    mutate: (
      current: DeepReadonly<z.output<Schema>>,
    ) => PluginSettingsDecision<z.input<Schema>, Result>,
    notify: (state: PluginSettingsState<Schema>) => void,
  ): Promise<PluginSettingsUpdateResult<Schema, Result>> {
    const loaded = await this.load(definition);
    if (loaded.status === "invalid") return loaded;
    const revision = loaded.stored.revision;
    const active: ActiveMutation = { reentryDetected: false };
    this.activeMutations.set(definition.id, active);
    let decision: PluginSettingsDecision<z.input<Schema>, Result>;
    try {
      decision = mutate(deepFreeze(structuredClone(loaded.values)));
    } catch {
      return invalid(revision, "mutator_threw");
    } finally {
      this.activeMutations.delete(definition.id);
    }
    if (active.reentryDetected) return invalid(revision, "reentrant_access");
    if (isThenable(decision)) return invalid(revision, "thenable_returned");
    if (decision.status === "unchanged") {
      // A migration still has to land once, even when the mutator keeps the values.
      if (!loaded.migrated) {
        return { status: "unchanged", values: loaded.values, revision, result: decision.result };
      }
      const saved = await this.commit(definition, loaded.values, notify);
      return { ...saved, status: "saved", result: decision.result };
    }
    let next: z.output<Schema>;
    try {
      next = await definition.schema.parseAsync(decision.values);
      z.json().parse(next);
    } catch (error) {
      return invalid(revision, "next_invalid", message(error));
    }
    const saved = await this.commit(definition, next, notify);
    return { ...saved, status: "saved", result: decision.result };
  }

  private async write<Schema extends ZodType>(
    definition: SettingsDefinition<Schema>,
    revision: string,
    values: unknown,
    intent: "save" | "reset",
    notify: (state: PluginSettingsState<Schema>) => void,
  ): Promise<SettingsWriteState<Schema>> {
    const stored = await this.stored(definition.id);
    if (stored.revision !== revision)
      return {
        status: "conflict",
        error: "Settings changed on another client. Reload before saving again.",
      };
    let parsed: z.output<Schema>;
    try {
      if (intent === "save" && stored.raw !== null) {
        const envelope = envelopeSchema.parse(JSON.parse(stored.raw));
        if (envelope.version !== definition.version)
          throw new Error("Reload or reset settings before saving a different schema version");
      }
      parsed = await definition.schema.parseAsync(values);
      z.json().parse(parsed);
    } catch (error) {
      return { status: "invalid", error: message(error) };
    }
    return { ...(await this.commit(definition, parsed, notify)), status: "saved" };
  }

  /** Every committed document, whatever its origin, reaches subscribers and clients exactly once. */
  private async commit<Schema extends ZodType>(
    definition: SettingsDefinition<Schema>,
    values: z.output<Schema>,
    notify: (state: PluginSettingsState<Schema>) => void,
  ): Promise<{ status: "ready"; values: z.output<Schema>; revision: string }> {
    const revision = await this.persist(definition, values);
    const state = { status: "ready" as const, values, revision };
    notify(state);
    this.changed(definition.id);
    return state;
  }

  private async persist<Schema extends ZodType>(
    definition: SettingsDefinition<Schema>,
    values: z.output<Schema>,
  ) {
    const jsonValues = z.json().parse(values);
    await mkdir(this.directory, { recursive: true });
    const target = path.join(this.directory, `${definition.id}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const raw = JSON.stringify({ version: definition.version, values: jsonValues });
    try {
      await writeFile(temporary, raw, { mode: 0o600 });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
    return revisionOf(raw);
  }
}
