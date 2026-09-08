import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { defineSettings, type SettingsDefinition } from "@getpaseo/plugin";
import { settingsRpc } from "@getpaseo/plugin";

const envelopeSchema = z.object({ version: z.number().int().positive(), values: z.json() });
function message(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues.map((issue) => issue.message).join("\n");
  return error instanceof Error ? error.message : String(error);
}
const revisionOf = (raw: string) => createHash("sha256").update(raw).digest("hex");

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

  register(definition: SettingsDefinition) {
    defineSettings(definition);
    if (this.definitions.has(definition.id))
      throw new Error(`Duplicate settings: ${definition.id}`);
    this.definitions.set(definition.id, definition);
    const rpc = settingsRpc(definition.id);
    return {
      read: { contract: rpc.read, handle: () => this.serial(() => this.read(definition)) },
      write: {
        contract: rpc.write,
        handle: (input: z.output<typeof rpc.write.input>) =>
          this.serial(() => this.write(definition, input.revision, input.values, "save")),
      },
      reset: {
        contract: rpc.reset,
        handle: (input: z.output<typeof rpc.reset.input>) =>
          this.serial(() => this.write(definition, input.revision, {}, "reset")),
      },
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

  private async read(
    definition: SettingsDefinition,
  ): Promise<z.output<ReturnType<typeof settingsRpc>["read"]["output"]>> {
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
      const parsed = z.json().parse(await definition.schema.parseAsync(values));
      const revision =
        envelope && envelope.version !== definition.version
          ? await this.persist(definition, parsed)
          : stored.revision;
      return { status: "ready", values: parsed, revision };
    } catch (error) {
      return { status: "invalid", revision: stored.revision, error: message(error) };
    }
  }

  private async write(
    definition: SettingsDefinition,
    revision: string,
    values: unknown,
    intent: "save" | "reset",
  ): Promise<z.output<ReturnType<typeof settingsRpc>["write"]["output"]>> {
    const stored = await this.stored(definition.id);
    if (stored.revision !== revision)
      return {
        status: "conflict",
        error: "Settings changed on another client. Reload before saving again.",
      };
    let parsed: z.output<ReturnType<typeof z.json>>;
    try {
      if (intent === "save" && stored.raw !== null) {
        const envelope = envelopeSchema.parse(JSON.parse(stored.raw));
        if (envelope.version !== definition.version)
          throw new Error("Reload or reset settings before saving a different schema version");
      }
      parsed = z.json().parse(await definition.schema.parseAsync(values));
    } catch (error) {
      return { status: "invalid", error: message(error) };
    }
    return { status: "saved", values: parsed, revision: await this.persist(definition, parsed) };
  }

  private async persist(
    definition: SettingsDefinition,
    values: z.output<ReturnType<typeof z.json>>,
  ) {
    await mkdir(this.directory, { recursive: true });
    const target = path.join(this.directory, `${definition.id}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const raw = JSON.stringify({ version: definition.version, values });
    try {
      await writeFile(temporary, raw, { mode: 0o600 });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
    this.changed(definition.id);
    return revisionOf(raw);
  }
}
