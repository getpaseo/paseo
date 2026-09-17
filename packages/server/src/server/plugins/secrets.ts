import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/**
 * Per-plugin secret storage that never leaves the daemon host.
 *
 * Plugin settings are the wrong place for an API token. `settings.<id>.read` is
 * an ordinary RPC and the id is derivable from the plugin, so every connected
 * client can fetch that document — a token stored there reaches every phone
 * attached to the daemon. This store has no RPC surface at all. A plugin that
 * wants a settings screen exposes its own write-only RPC on top and reports
 * status rather than the value.
 *
 * Settings documents live in the same directory as `<settings id>.json`. A settings id must start
 * with a lowercase letter, so the leading underscore keeps a plugin's `secrets` settings document —
 * which any client can reset or overwrite — from ever landing on this file.
 */
const SECRETS_FILE = "_secrets.json";
// COMPAT(pluginSecretsFileName): added 2026-09-16 on feat/plugin-host-infrastructure, remove after
// 2027-03-16 once hosts no longer hold secrets under the legacy name.
const LEGACY_SECRETS_FILE = "secrets.json";
const SecretsFileSchema = z.record(z.string(), z.string());
const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;

function assertKey(key: string): void {
  if (!KEY_PATTERN.test(key)) {
    throw new Error(`Invalid plugin secret key: ${key}`);
  }
}

export class PluginSecretStore {
  private readonly file: string;
  private readonly directory: string;
  private queue: Promise<unknown> = Promise.resolve();
  private migration: Promise<void> | null = null;

  constructor(directory: string) {
    this.directory = directory;
    this.file = path.join(directory, SECRETS_FILE);
  }

  async get(key: string): Promise<string | null> {
    assertKey(key);
    const entries = await this.read();
    return entries[key] ?? null;
  }

  async has(key: string): Promise<boolean> {
    assertKey(key);
    const entries = await this.read();
    return Object.hasOwn(entries, key);
  }

  /** Key names only. Values never leave this store except through `get`. */
  async keys(): Promise<string[]> {
    const entries = await this.read();
    return Object.keys(entries).sort();
  }

  // `async` so an invalid key rejects instead of throwing synchronously: every
  // other method on this store is awaited, and a caller's `.catch()` would miss
  // a synchronous throw.
  async set(key: string, value: string): Promise<void> {
    assertKey(key);
    await this.mutate((entries) => ({ ...entries, [key]: value }));
  }

  async delete(key: string): Promise<void> {
    assertKey(key);
    await this.mutate((entries) => {
      const { [key]: _removed, ...rest } = entries;
      return rest;
    });
  }

  private async read(): Promise<Record<string, string>> {
    await this.migrateLegacyFile();
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch {
      return {};
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }
    const entries = SecretsFileSchema.safeParse(parsed);
    return entries.success ? entries.data : {};
  }

  /** Writes are serialized so two plugin calls cannot lose each other's key. */
  private mutate(
    apply: (entries: Record<string, string>) => Record<string, string>,
  ): Promise<void> {
    const previous = this.queue;
    const next = (async () => {
      await previous;
      const entries = apply(await this.read());
      await this.persist(entries);
    })();
    this.queue = next.catch(() => undefined);
    return next;
  }

  // COMPAT(pluginSecretsFileName): moves a legacy `secrets.json` once. Only a flat string map is
  // ours; a settings document stored under that name keeps its `{ version, values }` envelope and
  // stays where it is.
  private migrateLegacyFile(): Promise<void> {
    this.migration ??= (async () => {
      try {
        await access(this.file);
        return;
      } catch {
        // No current file yet; a legacy one may hold this plugin's secrets.
      }
      const legacy = path.join(this.directory, LEGACY_SECRETS_FILE);
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(legacy, "utf8"));
      } catch {
        return;
      }
      const entries = SecretsFileSchema.safeParse(parsed);
      if (!entries.success) return;
      await this.persist(entries.data);
      await rm(legacy, { force: true });
    })().catch((error: unknown) => {
      this.migration = null;
      throw error;
    });
    return this.migration;
  }

  private async persist(entries: Record<string, string>): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(entries), { mode: 0o600 });
      await rename(temporary, this.file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
