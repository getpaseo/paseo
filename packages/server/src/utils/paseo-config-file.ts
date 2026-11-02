import { constants, type Stats } from "node:fs";
import { open, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import pLimit from "p-limit";
import { withTimeout } from "./promise-timeout.js";
import { setImmediate as nextTurn } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import {
  PaseoConfigRawSchema,
  PaseoConfigSchema,
  type PaseoConfig,
  type PaseoConfigRaw,
  type PaseoConfigRevision,
  type ProjectConfigRpcError,
} from "@getpaseo/protocol/paseo-config-schema";
export {
  PaseoConfigRevisionSchema,
  ProjectConfigRpcErrorSchema,
  type PaseoConfigRevision,
  type ProjectConfigRpcError,
} from "@getpaseo/protocol/paseo-config-schema";

export const PASEO_CONFIG_FILE_NAME = "paseo.json";
// Configuration is deliberately small. Bound both IO and main-thread JSON/schema work.
export const MAX_PASEO_CONFIG_BYTES = 256 * 1024;

export type ReadPaseoConfigForEditResult =
  | { ok: true; config: PaseoConfigRaw | null; revision: PaseoConfigRevision | null }
  | { ok: false; error: ProjectConfigRpcError };
export type ReadPaseoConfigResult =
  | { ok: true; config: PaseoConfig | null }
  | { ok: false; configPath: string; error: unknown };
export type WritePaseoConfigForEditResult =
  | { ok: true; config: PaseoConfigRaw; revision: PaseoConfigRevision }
  | { ok: false; error: ProjectConfigRpcError };
export interface WritePaseoConfigForEditInput {
  repoRoot: string;
  config: PaseoConfigRaw;
  expectedRevision: PaseoConfigRevision | null;
}

export function resolvePaseoConfigPath(repoRoot: string): string {
  return join(repoRoot, PASEO_CONFIG_FILE_NAME);
}

function revision(stats: Stats): PaseoConfigRevision {
  return { mtimeMs: stats.mtimeMs, size: stats.size };
}

async function inspect(repoRoot: string): Promise<Stats | null> {
  try {
    return await stat(resolvePaseoConfigPath(repoRoot));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function statPaseoConfigPath(repoRoot: string): Promise<PaseoConfigRevision | null> {
  const stats = await inspect(repoRoot);
  return stats ? revision(stats) : null;
}

function admit(stats: Stats): void {
  if (!stats.isFile() || stats.size > MAX_PASEO_CONFIG_BYTES) {
    throw new Error(`paseo.json must be a regular file of at most ${MAX_PASEO_CONFIG_BYTES} bytes`);
  }
}

function fingerprint(stats: Stats | null): string {
  return stats
    ? `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`
    : "missing";
}

// The record schema validates every script synchronously. Validate bounded groups
// through the same schemas so thousands of script entries do not monopolize a turn.
async function validateConfig(json: unknown): Promise<{
  edit: ReturnType<typeof PaseoConfigRawSchema.safeParse>;
  runtime: PaseoConfig;
}> {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    return { edit: PaseoConfigRawSchema.safeParse(json), runtime: PaseoConfigSchema.parse(json) };
  }
  const scripts = (json as Record<string, unknown>).scripts;
  if (scripts === null || typeof scripts !== "object" || Array.isArray(scripts)) {
    return { edit: PaseoConfigRawSchema.safeParse(json), runtime: PaseoConfigSchema.parse(json) };
  }
  const withoutScripts = { ...json, scripts: {} };
  let edit = PaseoConfigRawSchema.safeParse(withoutScripts);
  const runtime = PaseoConfigSchema.parse(withoutScripts);
  const entries = Object.entries(scripts);
  if (entries.length > 32) await nextTurn();
  let lastYield = performance.now();
  for (let offset = 0; offset < entries.length; offset += 32) {
    const group = { scripts: Object.fromEntries(entries.slice(offset, offset + 32)) };
    if (edit.success) {
      const parsed = PaseoConfigRawSchema.safeParse(group);
      if (parsed.success) Object.assign(edit.data.scripts!, parsed.data.scripts);
      else edit = parsed;
    }
    Object.assign(runtime.scripts!, PaseoConfigSchema.parse(group).scripts);
    if (performance.now() - lastYield >= 2) {
      await nextTurn();
      lastYield = performance.now();
    }
  }
  return { edit, runtime };
}

interface Snapshot {
  fingerprint: string;
  edit: ReadPaseoConfigForEditResult;
  runtime: ReadPaseoConfigResult;
}

/** Owns config admission, snapshots and daemon read/modify/write ordering for every consumer. */
class ProjectConfigOwner {
  // A stalled mount retains its slot until the OS returns; never consume the whole fs pool.
  private readonly filesystemOperations = pLimit(2);
  private readonly pendingAliases = new Map<string, Promise<string>>();
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly pending = new Map<
    string,
    { kind: "read" | "write"; promise: Promise<unknown> }
  >();

  async resolveRoot(repoRoot: string, activeRoots: Set<string>): Promise<string | null> {
    const root = resolve(repoRoot);
    if (activeRoots.has(root)) return root;
    let pending = this.pendingAliases.get(root);
    if (!pending) {
      pending = this.filesystemOperations(() => realpath(root)).finally(() =>
        this.pendingAliases.delete(root),
      );
      this.pendingAliases.set(root, pending);
    }
    try {
      const alias = await withTimeout(pending, 5_000, "Project root unavailable");
      return activeRoots.has(alias) ? alias : null;
    } catch {
      return null;
    }
  }

  private async serialized<T>(
    root: string,
    kind: "read" | "write",
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.pending.get(root);
    if (kind === "read" && previous?.kind === "read") return previous.promise as Promise<T>;
    const next = (async () => {
      await previous?.promise.catch(() => undefined);
      return this.filesystemOperations(operation);
    })();
    this.pending.set(root, { kind, promise: next });
    try {
      return await next;
    } finally {
      if (this.pending.get(root)?.promise === next) this.pending.delete(root);
    }
  }

  private remember(root: string, snapshot: Snapshot): Snapshot {
    this.snapshots.delete(root);
    this.snapshots.set(root, snapshot);
    // Worktrees come and go; retain only a bounded set of reusable snapshots.
    if (this.snapshots.size > 256) this.snapshots.delete(this.snapshots.keys().next().value!);
    return snapshot;
  }

  async read(repoRoot: string): Promise<Snapshot> {
    const root = resolve(repoRoot);
    return withTimeout(
      this.serialized(root, "read", () => this.load(root)),
      5_000,
      "Project config unavailable",
    );
  }

  private async load(root: string): Promise<Snapshot> {
    const stats = await inspect(root);
    if (stats) admit(stats);
    const key = fingerprint(stats);
    const cached = this.snapshots.get(root);
    if (cached?.fingerprint === key) return this.remember(root, cached);
    let json: unknown = null;
    if (stats) {
      // O_NONBLOCK prevents a regular-file -> FIFO replacement between stat and open
      // from waiting for a writer. Check the opened descriptor again before any read.
      const handle = await open(
        resolvePaseoConfigPath(root),
        constants.O_RDONLY | constants.O_NONBLOCK,
      );
      try {
        const openedStats = await handle.stat();
        admit(openedStats);
        const bytes = Buffer.alloc(MAX_PASEO_CONFIG_BYTES + 1);
        let length = 0;
        while (length < bytes.length) {
          const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
          if (bytesRead === 0) break;
          length += bytesRead;
        }
        if (length > MAX_PASEO_CONFIG_BYTES) throw new Error("paseo.json exceeds byte limit");
        // Never publish bytes under a revision that did not describe the opened file.
        if (fingerprint(await handle.stat()) !== fingerprint(openedStats)) {
          throw new Error("paseo.json changed while reading; retry the operation");
        }
        try {
          json = JSON.parse(bytes.toString("utf8", 0, length));
        } catch (error) {
          return this.remember(root, {
            fingerprint: key,
            edit: { ok: false, error: { code: "invalid_project_config" } },
            runtime: { ok: false, configPath: resolvePaseoConfigPath(root), error },
          });
        }
        if (fingerprint(openedStats) !== key) {
          throw new Error("paseo.json was replaced while reading; retry the operation");
        }
      } finally {
        await handle.close();
      }
    }
    const validated = json === null ? null : await validateConfig(json);
    const parsed = validated?.edit ?? null;
    let edit: ReadPaseoConfigForEditResult = { ok: true, config: null, revision: null };
    if (parsed !== null) {
      edit = parsed.success
        ? { ok: true, config: parsed.data, revision: stats ? revision(stats) : null }
        : { ok: false, error: { code: "invalid_project_config" } };
    }
    return this.remember(root, {
      fingerprint: key,
      edit,
      runtime: { ok: true, config: validated?.runtime ?? null },
    });
  }

  async write(input: WritePaseoConfigForEditInput): Promise<WritePaseoConfigForEditResult> {
    const root = resolve(input.repoRoot);
    return this.serialized(root, "write", async () => {
      const { edit: parsed } = await validateConfig(input.config);
      if (!parsed.success) return { ok: false, error: { code: "invalid_project_config" } };
      const content = `${JSON.stringify(parsed.data, null, 2)}\n`;
      if (Buffer.byteLength(content) > MAX_PASEO_CONFIG_BYTES) {
        return { ok: false, error: { code: "invalid_project_config" } };
      }
      const tempPath = join(root, `.${PASEO_CONFIG_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`);
      try {
        await writeFile(tempPath, content, { flag: "wx" });
        const savedRevision = revision(await stat(tempPath));
        const currentStats = await inspect(root);
        if (currentStats) admit(currentStats);
        const currentRevision = currentStats ? revision(currentStats) : null;
        if (!paseoConfigRevisionsEqual(currentRevision, input.expectedRevision)) {
          return { ok: false, error: { code: "stale_project_config", currentRevision } };
        }
        // Serialized against daemon edits. External writers still have the existing
        // optimistic stat/rename race; revision tokens remain mtime + size.
        await rename(tempPath, resolvePaseoConfigPath(root));
        this.snapshots.delete(root);
        return { ok: true, config: parsed.data, revision: savedRevision };
      } catch {
        return { ok: false, error: { code: "write_failed" } };
      } finally {
        await rm(tempPath, { force: true }).catch(() => undefined);
      }
    });
  }
}

const projectConfig = new ProjectConfigOwner();

export function resolveProjectConfigRoot(
  repoRoot: string,
  activeRoots: Set<string>,
): Promise<string | null> {
  return projectConfig.resolveRoot(repoRoot, activeRoots);
}

export async function readPaseoConfig(repoRoot: string): Promise<ReadPaseoConfigResult> {
  try {
    return (await projectConfig.read(repoRoot)).runtime;
  } catch (error) {
    return { ok: false, configPath: resolvePaseoConfigPath(repoRoot), error };
  }
}

export async function readPaseoConfigForEdit(
  repoRoot: string,
): Promise<ReadPaseoConfigForEditResult> {
  try {
    return (await projectConfig.read(repoRoot)).edit;
  } catch {
    return { ok: false, error: { code: "invalid_project_config" } };
  }
}

export function writePaseoConfigForEdit(
  input: WritePaseoConfigForEditInput,
): Promise<WritePaseoConfigForEditResult> {
  return projectConfig.write(input);
}

function paseoConfigRevisionsEqual(
  left: PaseoConfigRevision | null,
  right: PaseoConfigRevision | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.mtimeMs === right.mtimeMs && left.size === right.size;
}
