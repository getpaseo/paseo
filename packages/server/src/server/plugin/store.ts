import {
  access,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve, sep } from "node:path";
import type { z } from "zod";
import {
  PluginEntrySchema,
  PluginIdSchema,
  PluginManifestSchema,
  PluginStateFileSchema,
  type InstalledPlugin,
  type PluginManifest,
  type PluginSource,
  type PluginStateFile,
} from "@getpaseo/protocol/plugin/types";
import { writeJsonFileAtomic } from "../atomic-file.js";
import { satisfiesVersionRange } from "./version-range.js";

export const PLUGIN_MANIFEST_FILENAME = "paseo-plugin.json";
const STATE_FILENAME = "installed.json";
/** Stands in for an install time the state file does not have. */
const EPOCH_ISO = new Date(0).toISOString();
const PluginStateEntrySchema = PluginStateFileSchema.shape.plugins.element;

/** The requested plugin has no directory under `$PASEO_HOME/plugins/`. */
export class PluginNotInstalledError extends Error {
  /**
   * `reason` covers the case where the operation itself succeeded and the
   * plugin was gone by the time it was listed back — a concurrent uninstall.
   * "is not installed" reads as if the install failed, which it did not.
   */
  constructor(
    public readonly pluginId: string,
    reason?: string,
  ) {
    super(reason ?? `Plugin "${pluginId}" is not installed`);
    this.name = "PluginNotInstalledError";
  }
}

/** The plugin exists but does not ship the requested entry file. */
export class PluginEntryNotFoundError extends Error {
  constructor(
    public readonly pluginId: string,
    public readonly entry: string,
  ) {
    super(`Plugin "${pluginId}" has no entry "${entry}"`);
    this.name = "PluginEntryNotFoundError";
  }
}

/** The plugin is installed but disabled or unavailable, so its HTML is not served. */
export class PluginEntryUnavailableError extends Error {
  constructor(
    public readonly pluginId: string,
    public readonly reason: string,
  ) {
    super(`Plugin "${pluginId}" is not available: ${reason}`);
    this.name = "PluginEntryUnavailableError";
  }
}

/**
 * A plugin id or entry name that would resolve outside the plugin's own
 * directory. This is a security boundary: the protocol schemas already reject
 * separators and traversal segments, and the resolved path is re-checked before
 * any read.
 */
export class PluginPathTraversalError extends Error {
  constructor(
    public readonly pluginId: string,
    public readonly entry: string,
  ) {
    super(`Refused plugin path outside the plugin directory: ${pluginId}/${entry}`);
    this.name = "PluginPathTraversalError";
  }
}

interface PluginStateEntry {
  id: string;
  enabled: boolean;
  installedAt: string;
  source: PluginSource;
}

export interface PluginStoreOptions {
  /** `$PASEO_HOME/plugins`. */
  dir: string;
  /** Daemon version a manifest's `paseoVersion` range is matched against. */
  daemonVersion: string;
  now?: () => Date;
}

function placeholderManifest(pluginId: string): PluginManifest {
  return { id: pluginId, name: pluginId, version: "0.0.0", contributes: {} };
}

function entryFilenames(manifest: PluginManifest): string[] {
  return [
    ...(manifest.contributes.filePreviews ?? []).map((contribution) => contribution.entry),
    ...(manifest.contributes.sidebarPanels ?? []).map((contribution) => contribution.entry),
  ];
}

/**
 * `.trash-<id>-<uuid>` back to `<id>`. Returns null when the name is not that
 * shape, so a stray directory is deleted rather than restored to a guess.
 */
function trashedPluginId(dirName: string): string | null {
  const match = /^\.trash-(.+)-[0-9a-f-]{36}$/.exec(dirName);
  return match?.[1] ?? null;
}

function describeManifestIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}

/**
 * Owns `$PASEO_HOME/plugins/`: the plugin directories themselves plus the
 * daemon-owned `installed.json` holding enabled state and install source.
 *
 * A directory that is present but broken is never dropped from the listing — it
 * comes back with `unavailableReason` set so the user can see why it is not
 * running.
 */
export class PluginStore {
  private readonly dir: string;
  private readonly daemonVersion: string;
  private readonly now: () => Date;
  private mutations: Promise<unknown> = Promise.resolve();
  private readonly pluginMutations = new Map<string, Promise<unknown>>();
  private ready: Promise<void> | null = null;

  constructor(options: PluginStoreOptions) {
    this.dir = options.dir;
    this.daemonVersion = options.daemonVersion;
    this.now = options.now ?? (() => new Date());
  }

  async list(): Promise<InstalledPlugin[]> {
    await this.initialize();
    const { directories, state } = await this.reconcileState();
    const plugins = await Promise.all(
      directories.map(async (pluginId) => this.describe(pluginId, state)),
    );
    return plugins.sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
  }

  /**
   * Creates the plugins directory and deals with scratch directories left
   * behind by a daemon that died mid-install. They are invisible to `list()`
   * because a plugin id can never start with a dot.
   *
   * `.staging-*` is a partial download; delete it. `.trash-<id>-*` is the
   * user's previous copy, moved aside during a swap — if `<id>` is not there,
   * the swap did not complete and the trash is the only copy left, so restore
   * it rather than deleting the plugin the user installed.
   */
  private async initialize(): Promise<void> {
    const pending = (this.ready ??= (async () => {
      await mkdir(this.dir, { recursive: true });
      const entries = await readdir(this.dir, { withFileTypes: true });
      const names = new Set(entries.map((entry) => entry.name));
      await Promise.all(
        entries
          .filter((entry) => entry.isDirectory() && entry.name.startsWith(".staging-"))
          .map(async (entry) => rm(join(this.dir, entry.name), { recursive: true, force: true })),
      );
      // Sequential, and `names` grows as we go: two interrupted swaps can leave
      // two `.trash-<id>-*` for the same id, and in parallel both would see the
      // slot free and race to rename into it. The loser's ENOTEMPTY would reject
      // `initialize()`, whose promise is cached — every later list/read/install
      // would fail until the daemon restarted.
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith(".trash-")) {
          continue;
        }
        const pluginId = trashedPluginId(entry.name);
        const source = join(this.dir, entry.name);
        if (pluginId && !names.has(pluginId)) {
          try {
            await rename(source, join(this.dir, pluginId));
            names.add(pluginId);
          } catch {
            // Leave it: it may be the only copy. It stays invisible to `list()`
            // and gets another attempt next boot.
          }
          continue;
        }
        await rm(source, { recursive: true, force: true });
      }
    })());
    try {
      await pending;
    } catch (error) {
      // Uncached on failure. The promise is memoised so the scan runs once, but
      // memoising a rejection makes a transient `mkdir`/`readdir` failure — a
      // full disk, a home directory not mounted yet — reject every later
      // list/read/install until the daemon restarts. Dropping it lets the next
      // caller retry.
      //
      // Unconditional, and `pending` is deliberately not compared against
      // `this.ready` first: every caller awaiting the same rejection resumes in
      // one microtask batch, so nothing can install a newer promise in between
      // and there is no in-flight retry to discard. A guard here would be
      // unreachable, which is exactly how it read — a test could not make it
      // fail.
      this.ready = null;
      throw error;
    }
  }

  async get(pluginId: string): Promise<InstalledPlugin | null> {
    const plugins = await this.list();
    return plugins.find((plugin) => plugin.manifest.id === pluginId) ?? null;
  }

  /**
   * Reads a contribution's HTML. Only an enabled, available plugin's declared
   * contributions are served, and the resolved file is re-checked after
   * `realpath` so a symlink cannot point out of the plugin directory.
   */
  async readEntry(pluginId: string, entry: string): Promise<string> {
    const filePath = this.resolveEntryPath(pluginId, entry);
    const plugin = await this.get(pluginId);
    if (!plugin) {
      throw new PluginNotInstalledError(pluginId);
    }
    if (!plugin.enabled) {
      throw new PluginEntryUnavailableError(pluginId, "the plugin is disabled");
    }
    if (plugin.unavailableReason !== null) {
      throw new PluginEntryUnavailableError(pluginId, plugin.unavailableReason);
    }
    if (!entryFilenames(plugin.manifest).includes(entry.trim())) {
      throw new PluginEntryNotFoundError(pluginId, entry);
    }

    let realPath: string;
    try {
      realPath = await realpath(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new PluginEntryNotFoundError(pluginId, entry);
      }
      throw error;
    }
    const realPluginDir = await realpath(this.pluginDir(pluginId));
    if (!realPath.startsWith(`${realPluginDir}${sep}`)) {
      throw new PluginPathTraversalError(pluginId, entry);
    }

    try {
      return await readFile(realPath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new PluginEntryNotFoundError(pluginId, entry);
      }
      throw error;
    }
  }

  /**
   * Replaces a plugin directory with verified bytes. The files land in a
   * scratch directory first and are renamed into place, so an interrupted
   * install never leaves a half-written plugin behind, and the copy being
   * replaced is only deleted once the new one is in place.
   *
   * The whole body is serialized per plugin id, so two installs of one id, or
   * an install racing an uninstall, cannot interleave into a half-installed
   * directory with no state entry.
   */
  async install(options: {
    pluginId: string;
    files: ReadonlyArray<{ name: string; bytes: Uint8Array }>;
    manifest: PluginManifest;
    source: PluginSource;
  }): Promise<void> {
    const pluginId = PluginIdSchema.parse(options.pluginId);
    await this.serializePluginMutation(pluginId, async () => {
      await this.initialize();
      const pluginDir = this.pluginDir(pluginId);
      const stagingDir = join(this.dir, `.staging-${pluginId}-${randomUUID()}`);
      const trashDir = join(this.dir, `.trash-${pluginId}-${randomUUID()}`);
      await mkdir(stagingDir, { recursive: true });
      let installed = false;
      try {
        await writeFile(
          join(stagingDir, PLUGIN_MANIFEST_FILENAME),
          `${JSON.stringify(options.manifest, null, 2)}\n`,
        );
        for (const file of options.files) {
          const name = PluginEntrySchema.parse(file.name);
          await writeFile(join(stagingDir, name), file.bytes);
        }
        const replaced = await renameIfExists(pluginDir, trashDir);
        try {
          await rename(stagingDir, pluginDir);
          installed = true;
        } catch (error) {
          if (replaced) {
            await rename(trashDir, pluginDir);
          }
          throw error;
        }
      } finally {
        if (!installed) {
          await rm(stagingDir, { recursive: true, force: true });
        }
        // Only once the new copy is in place. If the swap failed *and* the
        // restore rename also failed, the trash holds the user's only surviving
        // plugin — deleting it here is the very data loss this dance avoids.
        // `initialize()` restores it on the next start.
        if (installed) {
          await rm(trashDir, { recursive: true, force: true });
        }
      }

      await this.mutateState((state) => [
        ...state.filter((entry) => entry.id !== pluginId),
        {
          id: pluginId,
          enabled: true,
          installedAt: this.now().toISOString(),
          source: options.source,
        },
      ]);
    });
  }

  async setEnabled(pluginId: string, enabled: boolean): Promise<void> {
    const id = PluginIdSchema.parse(pluginId);
    await this.serializePluginMutation(id, async () => {
      const directories = await this.listPluginDirectories();
      if (!directories.includes(id)) {
        throw new PluginNotInstalledError(id);
      }
      await this.mutateState((state) => {
        const existing = state.find((entry) => entry.id === id);
        if (!existing) {
          return [
            ...state,
            {
              id,
              enabled,
              installedAt: this.now().toISOString(),
              source: { kind: "local" as const },
            },
          ];
        }
        return state.map((entry) => (entry.id === id ? { ...entry, enabled } : entry));
      });
    });
  }

  async uninstall(pluginId: string): Promise<void> {
    const id = PluginIdSchema.parse(pluginId);
    await this.serializePluginMutation(id, async () => {
      const directories = await this.listPluginDirectories();
      if (!directories.includes(id)) {
        throw new PluginNotInstalledError(id);
      }
      await rm(this.pluginDir(id), { recursive: true, force: true });
      await this.mutateState((state) => state.filter((entry) => entry.id !== id));
    });
  }

  /** Same shape as `ScheduleStore.serializeScheduleMutation`. */
  private async serializePluginMutation<T>(
    pluginId: string,
    mutation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.pluginMutations.get(pluginId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(mutation);
    this.pluginMutations.set(pluginId, next);
    try {
      return await next;
    } finally {
      if (this.pluginMutations.get(pluginId) === next) {
        this.pluginMutations.delete(pluginId);
      }
    }
  }

  private pluginDir(pluginId: string): string {
    return join(this.dir, pluginId);
  }

  private resolveEntryPath(pluginId: string, entry: string): string {
    const id = PluginIdSchema.safeParse(pluginId);
    const name = PluginEntrySchema.safeParse(entry);
    if (!id.success || !name.success) {
      throw new PluginPathTraversalError(pluginId, entry);
    }
    const pluginDir = resolve(this.dir, id.data);
    const filePath = resolve(pluginDir, name.data);
    if (!filePath.startsWith(`${pluginDir}${sep}`)) {
      throw new PluginPathTraversalError(pluginId, entry);
    }
    return filePath;
  }

  /**
   * A plugin's identity is its directory, not its manifest. A directory whose
   * manifest went missing still lists — with `unavailableReason` — so the
   * user's enabled state and install source survive a broken manifest.
   */
  private async listPluginDirectories(): Promise<string[]> {
    await mkdir(this.dir, { recursive: true });
    const entries = await readdir(this.dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && PluginIdSchema.safeParse(entry.name).success)
      .map((entry) => entry.name)
      .sort();
  }

  private async describe(
    pluginId: string,
    state: readonly PluginStateEntry[],
  ): Promise<InstalledPlugin> {
    const stateEntry = state.find((entry) => entry.id === pluginId);
    const base = {
      enabled: stateEntry?.enabled ?? true,
      // `reconcileState` puts an entry there for every directory in the same
      // snapshot, so this fallback is unreachable. The epoch rather than `now()`
      // if it ever is reached: a plugin listed as installed seconds ago reads as
      // a fact, and this one would be an invention.
      installedAt: stateEntry?.installedAt ?? EPOCH_ISO,
      source: stateEntry?.source ?? ({ kind: "local" } as const),
    };

    let raw: string;
    try {
      raw = await readFile(join(this.pluginDir(pluginId), PLUGIN_MANIFEST_FILENAME), "utf-8");
    } catch {
      return {
        ...base,
        manifest: placeholderManifest(pluginId),
        unavailableReason: "Manifest file is missing",
      };
    }

    const parsed = PluginManifestSchema.safeParse(safeJsonParse(raw));
    if (!parsed.success) {
      return {
        ...base,
        manifest: placeholderManifest(pluginId),
        unavailableReason: `Manifest is invalid: ${describeManifestIssues(parsed.error)}`,
      };
    }

    // The directory name is the identity; a manifest that disagrees is broken,
    // but it still has to list under the id the caller can address it by.
    const manifest = { ...parsed.data, id: pluginId };
    if (parsed.data.id !== pluginId) {
      return {
        ...base,
        manifest,
        unavailableReason: `Manifest id "${parsed.data.id}" does not match directory "${pluginId}"`,
      };
    }

    const range = manifest.paseoVersion;
    if (range && !satisfiesVersionRange(this.daemonVersion, range)) {
      return {
        ...base,
        manifest,
        unavailableReason: `Requires Paseo ${range}, this daemon is ${this.daemonVersion}`,
      };
    }

    const missing = await this.findMissingEntry(pluginId, manifest);
    if (missing) {
      return { ...base, manifest, unavailableReason: `Missing entry file "${missing}"` };
    }

    return { ...base, manifest, unavailableReason: null };
  }

  private async findMissingEntry(
    pluginId: string,
    manifest: PluginManifest,
  ): Promise<string | null> {
    for (const entry of entryFilenames(manifest)) {
      try {
        // `access`, not `readFile`: entries are inlined-JS HTML and this runs on
        // every list, which every client triggers on connect.
        await access(this.resolveEntryPath(pluginId, entry));
      } catch {
        return entry;
      }
    }
    return null;
  }

  private statePath(): string {
    return join(this.dir, STATE_FILENAME);
  }

  /**
   * Read per entry rather than all-or-nothing: one unreadable entry, or a
   * `version` a newer daemon wrote, must not wipe every plugin's enabled state.
   */
  private async readState(): Promise<PluginStateEntry[]> {
    try {
      const raw = await readFile(this.statePath(), "utf-8");
      const plugins = (safeJsonParse(raw) as { plugins?: unknown } | null)?.plugins;
      if (!Array.isArray(plugins)) {
        return [];
      }
      return plugins.flatMap((entry) => {
        const parsed = PluginStateEntrySchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  private async writeState(plugins: readonly PluginStateEntry[]): Promise<void> {
    const file: PluginStateFile = PluginStateFileSchema.parse({ version: 1, plugins });
    await writeJsonFileAtomic(this.statePath(), file);
  }

  /**
   * The callback must not call `mutateState` itself, directly or through
   * anything that does. It runs inside the link it is appending to, so a nested
   * call waits on a promise that cannot settle until it returns.
   */
  private async mutateState(
    mutate: (
      state: readonly PluginStateEntry[],
    ) => PluginStateEntry[] | Promise<PluginStateEntry[]>,
  ): Promise<PluginStateEntry[]> {
    const next = this.mutations
      .catch(() => undefined)
      .then(async () => {
        const current = await this.readState();
        const updated = await mutate(current);
        // `list()` reconciles on every call; skip the write when it changed
        // nothing. ponytail: JSON compare, both sides are built in schema key
        // order, and a false mismatch only costs one redundant write.
        if (JSON.stringify(updated) !== JSON.stringify(current)) {
          await this.writeState(updated);
        }
        return updated;
      });
    this.mutations = next;
    return next;
  }

  /**
   * Adopts directories dropped in by hand and forgets entries whose directory
   * is gone, so a hand-installed plugin gets a stable `installedAt` instead of
   * a new one on every list.
   */
  private async reconcileState(): Promise<{
    directories: string[];
    state: PluginStateEntry[];
  }> {
    let directories: string[] = [];
    // The directory listing is taken inside the serialized chain, not by the
    // caller beforehand. A snapshot read before a concurrent `uninstall` removed
    // the directory, whose reconcile then lands after that uninstall's filter,
    // re-adds the removed plugin with a fresh `installedAt` — it self-heals on
    // the next list, but reports the plugin as installed-with-missing-manifest
    // in between.
    const state = await this.mutateState(async (current) => {
      directories = await this.listPluginDirectories();
      const kept = current.filter((entry) => directories.includes(entry.id));
      const discovered = directories
        .filter((pluginId) => !kept.some((entry) => entry.id === pluginId))
        .map((pluginId) => ({
          id: pluginId,
          enabled: true,
          installedAt: this.now().toISOString(),
          source: { kind: "local" as const },
        }));
      return [...kept, ...discovered];
    });
    return { directories, state };
  }
}

/** Renames `from` to `to`, reporting whether there was anything to rename. */
async function renameIfExists(from: string, to: string): Promise<boolean> {
  try {
    await rename(from, to);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
