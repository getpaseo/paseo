import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

// How long a resolved path is used before PATH is searched again in the background. It bounds
// how long a moved or newly shadowed binary keeps being started from its old location.
const RESOLUTION_TTL_MS = 10_000;

interface Resolution {
  path: string | null;
  resolvedAtMs: number;
}

const resolutions = new Map<string, Resolution>();
const refreshes = new Map<string, Promise<void>>();

export interface ResolveSpawnCommandOptions {
  platform?: NodeJS.Platform;
  nowMs?: number;
}

/**
 * Returns the absolute path of a bare command name when it is known, so the spawn does not
 * search PATH, and otherwise the command unchanged.
 *
 * On macOS libuv searches PATH itself by calling posix_spawn once per directory until one
 * succeeds. Each miss creates and tears down a kernel process while the calling thread waits,
 * and that thread is the event loop. With a few hundred PATH entries one `git` spawn blocks the
 * loop for 20 to 150 ms, and the daemon runs several Git commands per second. Linux spawns search
 * PATH in the forked child; resolving there too only keeps the platforms alike.
 *
 * Lookups are asynchronous: the first spawn of a command searches PATH as before while the
 * resolution runs, and later spawns use its result. A resolution older than the TTL is still
 * used while a fresh one runs.
 *
 * Never resolves on Windows (the spawn wrapper owns PATHEXT and command shims), names with a path
 * separator, or a PATH with an empty or relative entry before the match (those resolve against
 * the child's cwd).
 */
export function resolveSpawnCommand(
  command: string,
  pathValue: string | undefined,
  options: ResolveSpawnCommandOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  if (platform === "win32" || !command || command.includes("/") || !pathValue) {
    return command;
  }
  const nowMs = options.nowMs ?? Date.now();
  const key = `${pathValue}\0${command}`;
  const resolution = resolutions.get(key);
  if (!resolution || nowMs - resolution.resolvedAtMs >= RESOLUTION_TTL_MS) {
    startRefresh(key, command, pathValue, nowMs);
  }
  return resolution?.path ?? command;
}

/** Resolves once every PATH search started so far has finished. */
export async function settleSpawnCommandResolutions(): Promise<void> {
  await Promise.all(refreshes.values());
}

export function clearSpawnCommandResolutions(): void {
  resolutions.clear();
}

function startRefresh(key: string, command: string, pathValue: string, nowMs: number): void {
  if (refreshes.has(key)) return;
  refreshes.set(key, refresh(key, command, pathValue, nowMs));
}

async function refresh(
  key: string,
  command: string,
  pathValue: string,
  nowMs: number,
): Promise<void> {
  try {
    resolutions.set(key, { path: await searchPath(command, pathValue), resolvedAtMs: nowMs });
  } catch {
    resolutions.delete(key);
  } finally {
    refreshes.delete(key);
  }
}

async function searchPath(command: string, pathValue: string): Promise<string | null> {
  const directories = pathValue.split(delimiter);
  const firstUnusable = directories.findIndex((directory) => !directory || !isAbsolute(directory));
  const candidates = directories
    .slice(0, firstUnusable === -1 ? undefined : firstUnusable)
    .map((directory) => join(directory, command));
  // Check every candidate at once. A sequential search waits one event-loop turn per PATH entry,
  // and on a loop that is already slow that takes longer than the TTL.
  const executable = await Promise.all(candidates.map(isExecutableFile));
  return candidates[executable.indexOf(true)] ?? null;
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    if (!(await stat(candidate)).isFile()) {
      return false;
    }
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    // ENOENT, ENOTDIR, EACCES and the like: libuv's search skips these candidates too.
    return false;
  }
}
