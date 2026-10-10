import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z, type ZodType } from "zod";
import { defineSettings, settingsRpc, type SettingsDefinition } from "@getpaseo/plugin";
import type { PluginSettings, PluginSettingsState } from "@getpaseo/plugin/server";

const envelopeSchema = z.object({ version: z.number().int().positive(), values: z.json() });
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

function reportListenerError(id: string, error: unknown): void {
  console.error(`Plugin settings subscriber failed for ${id}`, error);
}

function copySettingsState<Schema extends ZodType>(
  state: PluginSettingsState<Schema>,
): PluginSettingsState<Schema> {
  if (state.status === "invalid") return { ...state };
  return { ...state, values: structuredClone(state.values) };
}

/** One instance per installation. The subprocess lifetime gives writes a single owner. */
export class PluginSettingsStore {
  private readonly definitions = new Map<string, SettingsDefinition>();
  private queue: Promise<unknown> = Promise.resolve();

  private readonly directory: string;
  private readonly changed: (id: string) => void;
  constructor(directory: string, changed: (id: string) => void) {
    this.directory = directory;
    this.changed = changed;
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
      read,
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    return {
      settings,
      read: { contract: rpc.read, handle: read },
      write: { contract: rpc.write, handle: write },
      reset: { contract: rpc.reset, handle: reset },
    };
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(work);
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  private async stored(id: string) {
    try {
      const raw = await readFile(path.join(this.directory, `${id}.json`), "utf8");
      return { raw, revision: revisionOf(raw) };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        return { raw: null, revision: "missing" };
      throw error;
    }
  }

  private async read<Schema extends ZodType>(
    definition: SettingsDefinition<Schema>,
    notify: (state: PluginSettingsState<Schema>) => void,
  ): Promise<PluginSettingsState<Schema>> {
    const stored = await this.stored(definition.id);
    try {
      const envelope = stored.raw === null ? null : envelopeSchema.parse(JSON.parse(stored.raw));
      let values: unknown = envelope?.values ?? {};
      if (envelope && envelope.version !== definition.version) {
        if (envelope.version > definition.version)
          throw new Error("Settings were saved by a newer plugin version");
        if (!definition.migrate)
          throw new Error(`Settings version ${envelope.version} requires a migration`);
        values = await definition.migrate(values, envelope.version);
      }
      const parsed = await definition.schema.parseAsync(values);
      z.json().parse(parsed);
      const migrated = envelope !== null && envelope.version !== definition.version;
      const revision = migrated ? await this.persist(definition, parsed) : stored.revision;
      const result: PluginSettingsState<Schema> = {
        status: "ready",
        values: parsed,
        revision,
      };
      if (migrated) {
        notify(result);
        this.changed(definition.id);
      }
      return result;
    } catch (error) {
      return { status: "invalid", revision: stored.revision, error: message(error) };
    }
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
    const nextRevision = await this.persist(definition, parsed);
    notify({ status: "ready", values: parsed, revision: nextRevision });
    this.changed(definition.id);
    return { status: "saved", values: parsed, revision: nextRevision };
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
