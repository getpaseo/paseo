import { promises as fsp, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";

/**
 * Per-workspace recursive fs watcher with debouncing. Emits a coalesced
 * `change` event whenever any file under the workspace's `cwd` changes
 * after a quiet period. The owner triggers an incremental reindex via the
 * crg MCP tool.
 *
 * Notes:
 *   - Tries `fs.watch` recursive first (fast path: macOS, Windows, Linux 6+).
 *     On older Linux, automatically falls back to per-directory non-recursive
 *     watchers with dynamic attach for new dirs (see `startNonRecursiveWatcher`).
 *   - Watch list (.code-review-graph/, node_modules/, dist/, etc.) is
 *     filtered before debounce.
 */

export interface WorkspaceWatcherDeps {
  logger: Logger;
  workspaceId: string;
  cwd: string;
  /** Glob-fragments to ignore (substring match against the relative path). */
  ignorePatterns?: string[];
  /** ms to wait quiet before flushing a coalesced change event. */
  debounceMs?: number;
  /** Inject for tests; default uses node:fs.watch with `recursive: true`. */
  watchFactory?: (cwd: string, onChange: (relpath: string) => void) => { close(): void } | null;
}

export interface WorkspaceWatcherEvents {
  change: (info: { workspaceId: string; changedPaths: string[] }) => void;
  error: (err: Error) => void;
}

const DEFAULT_DEBOUNCE_MS = 1500;
const DEFAULT_IGNORES = [
  ".code-review-graph/",
  ".git/",
  "node_modules/",
  "dist/",
  "build/",
  ".next/",
  "__pycache__/",
];

export class WorkspaceFsWatcher {
  private readonly logger: Logger;
  private readonly workspaceId: string;
  private readonly cwd: string;
  private readonly ignorePatterns: string[];
  private readonly debounceMs: number;
  private readonly watchFactory: NonNullable<WorkspaceWatcherDeps["watchFactory"]>;

  private watcher: { close(): void } | null = null;
  private pendingChanges: Set<string> = new Set();
  private debounceHandle: NodeJS.Timeout | null = null;
  private listeners = new Set<(info: { workspaceId: string; changedPaths: string[] }) => void>();
  private errorListeners = new Set<(err: Error) => void>();

  constructor(deps: WorkspaceWatcherDeps) {
    this.logger = deps.logger.child({ module: "fs-watcher", workspaceId: deps.workspaceId });
    this.workspaceId = deps.workspaceId;
    this.cwd = deps.cwd;
    this.ignorePatterns = deps.ignorePatterns ?? DEFAULT_IGNORES;
    this.debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.watchFactory = deps.watchFactory ?? defaultWatchFactory;
  }

  start(): void {
    if (this.watcher) return;
    try {
      this.watcher = this.watchFactory(this.cwd, (rel) => this.onChange(rel));
      if (!this.watcher) {
        this.logger.warn(
          { cwd: this.cwd },
          "fs.watch recursive not supported on this platform; manual reindex only",
        );
      }
    } catch (err) {
      this.emitError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  stop(): void {
    if (this.debounceHandle) {
      clearTimeout(this.debounceHandle);
      this.debounceHandle = null;
    }
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch (err) {
        this.logger.warn({ err }, "Failed to close watcher");
      }
      this.watcher = null;
    }
    this.pendingChanges.clear();
  }

  /**
   * Force-flush any pending changes and emit a synthetic `change` event.
   * Useful for tests and the "Rebuild" button.
   */
  pulse(): void {
    this.flush(true);
  }

  on(
    event: "change",
    cb: (info: { workspaceId: string; changedPaths: string[] }) => void,
  ): () => void;
  on(event: "error", cb: (err: Error) => void): () => void;
  on(event: "change" | "error", cb: any): () => void {
    if (event === "change") {
      this.listeners.add(cb);
      return () => this.listeners.delete(cb);
    }
    this.errorListeners.add(cb);
    return () => this.errorListeners.delete(cb);
  }

  private onChange(relpath: string): void {
    if (this.shouldIgnore(relpath)) return;
    this.pendingChanges.add(relpath);
    if (this.debounceHandle) clearTimeout(this.debounceHandle);
    this.debounceHandle = setTimeout(() => this.flush(false), this.debounceMs);
  }

  private flush(force: boolean): void {
    if (this.debounceHandle) {
      clearTimeout(this.debounceHandle);
      this.debounceHandle = null;
    }
    const changedPaths = [...this.pendingChanges];
    this.pendingChanges.clear();
    if (changedPaths.length === 0 && !force) return;
    for (const cb of this.listeners) {
      try {
        cb({ workspaceId: this.workspaceId, changedPaths });
      } catch (err) {
        this.logger.warn({ err }, "fs-watcher change listener threw");
      }
    }
  }

  private shouldIgnore(relpath: string): boolean {
    for (const pattern of this.ignorePatterns) {
      if (relpath.includes(pattern)) return true;
    }
    return false;
  }

  private emitError(err: Error): void {
    for (const cb of this.errorListeners) {
      try {
        cb(err);
      } catch (innerErr) {
        this.logger.warn({ err: innerErr }, "fs-watcher error listener threw");
      }
    }
  }
}

function defaultWatchFactory(
  cwd: string,
  onChange: (relpath: string) => void,
): { close(): void } | null {
  // 1. Try recursive (fast path: macOS, Windows, modern Linux 6.x).
  try {
    const watcher = watch(cwd, { recursive: true }, (_event, filename) => {
      if (filename == null) return;
      onChange(typeof filename === "string" ? filename : (filename as Buffer).toString("utf8"));
    });
    return { close: () => watcher.close() };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM" && code !== "ENOTSUP") {
      throw err;
    }
  }
  // 2. Fallback: per-directory non-recursive watchers (Linux pre-6.x).
  return startNonRecursiveWatcher(cwd, onChange);
}

/**
 * Linux fallback: walk the tree, watch every directory non-recursively,
 * and dynamically attach watchers to new dirs as they appear.
 *
 * Caveats vs. recursive watch:
 *   - Higher fd usage (one per dir). Capped at MAX_WATCHED_DIRS to bound
 *     resource pressure; very large monorepos may need to widen ignores.
 *   - Tiny race window when a directory is created and immediately gets
 *     children — a follow-up event for the parent dir always re-triggers,
 *     so the change is observed albeit with a slight delay.
 *
 * The default ignore list (`node_modules/`, `.git/`, etc.) keeps fd usage
 * sane on typical projects.
 */
const MAX_WATCHED_DIRS = 4096;
const FALLBACK_INTERNAL_IGNORES = ["node_modules", ".git", ".code-review-graph"];

function startNonRecursiveWatcher(
  rootCwd: string,
  onChange: (relpath: string) => void,
): { close(): void } | null {
  const watchers = new Map<string, FSWatcher>();
  let closed = false;

  const watchDir = (absDir: string): void => {
    if (closed) return;
    if (watchers.has(absDir)) return;
    if (watchers.size >= MAX_WATCHED_DIRS) return;
    let watcher: FSWatcher;
    try {
      watcher = watch(absDir, (_event, filename) => {
        if (closed || filename == null) return;
        const name =
          typeof filename === "string" ? filename : (filename as Buffer).toString("utf8");
        const abs = path.join(absDir, name);
        const rel = path.relative(rootCwd, abs);
        if (rel === "" || rel.startsWith("..")) return;
        if (FALLBACK_INTERNAL_IGNORES.some((seg) => rel.split(path.sep).includes(seg))) return;
        onChange(rel);
        // Newly-created directory: pick it up.
        fsp
          .stat(abs)
          .then((st) => {
            if (st.isDirectory() && !watchers.has(abs)) watchDir(abs);
          })
          .catch(() => undefined);
      });
    } catch {
      // Permission denied, dir gone, etc. — best-effort, skip silently.
      return;
    }
    watcher.on("error", () => undefined);
    watchers.set(absDir, watcher);
  };

  const walkAndWatch = async (dir: string): Promise<void> => {
    if (closed) return;
    if (FALLBACK_INTERNAL_IGNORES.some((seg) => dir.split(path.sep).includes(seg))) return;
    watchDir(dir);
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => walkAndWatch(path.join(dir, entry.name))),
    );
  };

  // Kick off initial walk asynchronously; the root watcher is set up
  // synchronously so events from the root are never lost.
  watchDir(rootCwd);
  void walkAndWatch(rootCwd);

  return {
    close() {
      closed = true;
      for (const w of watchers.values()) {
        try {
          w.close();
        } catch {
          /* fd already gone */
        }
      }
      watchers.clear();
    },
  };
}

/**
 * Multi-workspace coordinator. Tracks one watcher per workspace; subscribes
 * the IndexingService to its events. Owns lifecycle so the service can
 * just call `set(workspaceId, cwd)` and `clear(workspaceId)`.
 */
export class WorkspaceFsWatcherRegistry {
  private readonly logger: Logger;
  private readonly watchers = new Map<string, WorkspaceFsWatcher>();
  private readonly factory: (deps: WorkspaceWatcherDeps) => WorkspaceFsWatcher;
  private readonly subscriptions = new Map<string, () => void>();

  constructor(deps: {
    logger: Logger;
    factory?: (deps: WorkspaceWatcherDeps) => WorkspaceFsWatcher;
  }) {
    this.logger = deps.logger.child({ module: "fs-watcher-registry" });
    this.factory = deps.factory ?? ((d) => new WorkspaceFsWatcher(d));
  }

  set(
    workspaceId: string,
    cwd: string,
    onChange: (info: { workspaceId: string; changedPaths: string[] }) => void,
    ignorePatterns?: string[],
    onError?: (workspaceId: string, err: Error) => void,
  ): void {
    this.clear(workspaceId);
    const watcher = this.factory({
      logger: this.logger,
      workspaceId,
      cwd,
      ignorePatterns,
    });
    const offChange = watcher.on("change", onChange);
    const offError = onError
      ? watcher.on("error", (err: Error) => onError(workspaceId, err))
      : () => {};
    this.subscriptions.set(workspaceId, () => {
      offChange();
      offError();
    });
    watcher.start();
    this.watchers.set(workspaceId, watcher);
  }

  clear(workspaceId: string): void {
    const sub = this.subscriptions.get(workspaceId);
    if (sub) sub();
    this.subscriptions.delete(workspaceId);
    const watcher = this.watchers.get(workspaceId);
    if (watcher) {
      watcher.stop();
      this.watchers.delete(workspaceId);
    }
  }

  has(workspaceId: string): boolean {
    return this.watchers.has(workspaceId);
  }

  activeWorkspaceIds(): string[] {
    return [...this.watchers.keys()];
  }

  pulse(workspaceId: string): void {
    this.watchers.get(workspaceId)?.pulse();
  }

  size(): number {
    return this.watchers.size;
  }

  closeAll(): void {
    for (const id of [...this.watchers.keys()]) this.clear(id);
  }
}
