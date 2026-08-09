import { type Dirent, type FSWatcher, watch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const DEFAULT_MAX_WATCHED_DIRECTORIES = 5_000;
const EVENT_BATCH_DELAY_MS = 10;
const RECONCILIATION_DELAY_MS = 50;

const activeObservers = new Set<RecursiveFileObserver>();
let reconciliationCount = 0;
let reconciliationFailureCount = 0;
let observerFailureCount = 0;
let directoryLimitFailureCount = 0;
let lastReconciliationDurationMs = 0;
let maxReconciliationDurationMs = 0;

export type FileChangeType = "create" | "update" | "delete";

export interface FileChange {
  path: string;
  type: FileChangeType;
}

export interface FileObserverOptions {
  ignore?: string[];
}

export type FileObserverCallback = (error: Error | null, events: FileChange[]) => void;

export interface FileObserverSubscription {
  /** Replace the excluded subtrees without exposing watcher topology to the caller. */
  updateIgnore(paths: string[]): Promise<void>;
  /** Idempotently stop all observation work. */
  unsubscribe(): Promise<void>;
}

export interface FileObserverDiagnostics {
  activeObservationCount: number;
  nativeHandleCount: number;
  pendingEventCount: number;
  reconciliationInFlightCount: number;
  reconciliationCount: number;
  reconciliationFailureCount: number;
  observerFailureCount: number;
  directoryLimitFailureCount: number;
  lastReconciliationDurationMs: number;
  maxReconciliationDurationMs: number;
}

export type SubscribeToFileChanges = typeof subscribeToFileChanges;

/** Aggregate health without exposing watched paths or platform topology. */
export function getFileObserverDiagnostics(): FileObserverDiagnostics {
  let nativeHandleCount = 0;
  let pendingEventCount = 0;
  let reconciliationInFlightCount = 0;
  for (const observer of activeObservers) {
    const diagnostics = observer.getDiagnostics();
    nativeHandleCount += diagnostics.nativeHandleCount;
    pendingEventCount += diagnostics.pendingEventCount;
    reconciliationInFlightCount += diagnostics.reconciliationInFlight ? 1 : 0;
  }
  return {
    activeObservationCount: activeObservers.size,
    nativeHandleCount,
    pendingEventCount,
    reconciliationInFlightCount,
    reconciliationCount,
    reconciliationFailureCount,
    observerFailureCount,
    directoryLimitFailureCount,
    lastReconciliationDurationMs,
    maxReconciliationDurationMs,
  };
}

interface DirectorySnapshot {
  directories: Set<string>;
  filesDiscoveredBeforeCoverage: Set<string>;
}

/**
 * Recursively observes a directory while keeping platform watcher details, topology
 * reconciliation, exclusion changes, batching, and teardown inside this module.
 */
export async function subscribeToFileChanges(
  directory: string,
  callback: FileObserverCallback,
  options: FileObserverOptions = {},
): Promise<FileObserverSubscription> {
  const observer = new RecursiveFileObserver(resolve(directory), callback, options.ignore ?? []);
  await observer.start();
  activeObservers.add(observer);
  return {
    updateIgnore: (paths) => observer.updateIgnore(paths),
    unsubscribe: () => observer.close(),
  };
}

class RecursiveFileObserver {
  private readonly watchers = new Map<string, FSWatcher>();
  private ignoredRoots: string[];
  private closed = false;
  private failed = false;
  private closePromise: Promise<void> | null = null;
  private reconcileTail: Promise<void> = Promise.resolve();
  private reconcileInFlight = false;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private readonly pendingReconciliationScopes = new Set<string>();
  private readonly pathClassifications = new Set<Promise<void>>();
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly pendingEvents = new Map<string, FileChange>();

  constructor(
    private readonly root: string,
    private readonly callback: FileObserverCallback,
    ignoredRoots: string[],
  ) {
    this.ignoredRoots = normalizeIgnoredRoots(root, ignoredRoots);
  }

  async start(): Promise<void> {
    const rootStats = await stat(this.root);
    if (!rootStats.isDirectory()) {
      throw new Error(`File observation requires a directory: ${this.root}`);
    }

    if (supportsNativeRecursiveWatch(process.platform)) {
      this.watchNativeRecursive();
      return;
    }

    // Install the root watcher before walking. Events racing the initial walk queue
    // another reconciliation, closing the create-directory/populate-directory gap.
    this.watchDirectory(this.root);
    try {
      await this.enqueueReconcile([this.root]);
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async updateIgnore(paths: string[]): Promise<void> {
    if (this.closed || this.failed) return;
    const nextIgnoredRoots = normalizeIgnoredRoots(this.root, paths);
    if (samePaths(this.ignoredRoots, nextIgnoredRoots)) return;
    this.ignoredRoots = nextIgnoredRoots;
    for (const path of this.pendingEvents.keys()) {
      if (this.isIgnored(path)) this.pendingEvents.delete(path);
    }

    for (const [directory, watcher] of this.watchers) {
      if (directory !== this.root && this.isIgnored(directory)) {
        watcher.close();
        this.watchers.delete(directory);
      }
    }
    if (!supportsNativeRecursiveWatch(process.platform)) {
      try {
        this.cancelQueuedReconciliation();
        await this.enqueueReconcile([this.root]);
      } catch (error) {
        this.fail(toError(error));
        throw error;
      }
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.cancelQueuedReconciliation();
    this.pendingEvents.clear();
    this.closePromise = this.finishClose();
    return this.closePromise;
  }

  getDiagnostics(): {
    nativeHandleCount: number;
    pendingEventCount: number;
    reconciliationInFlight: boolean;
  } {
    return {
      nativeHandleCount: this.watchers.size,
      pendingEventCount: this.pendingEvents.size,
      reconciliationInFlight: this.reconcileInFlight,
    };
  }

  private async finishClose(): Promise<void> {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    await this.reconcileTail;
    await Promise.allSettled(this.pathClassifications);
    // A scan already in flight can only observe `closed` and return, but close any
    // handle defensively before resolving the lifecycle barrier.
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    activeObservers.delete(this);
  }

  private watchNativeRecursive(): void {
    const watcher = watch(this.root, { recursive: true }, (eventType, filename) => {
      if (this.closed || this.failed) return;
      if (!filename) {
        this.queueEvent("update", this.root);
        return;
      }
      const path = resolve(this.root, filename.toString());
      if (this.isIgnored(path)) return;
      if (eventType === "change") this.queueEvent("update", path);
      else this.classifyRenameEvent(path);
    });
    this.attachWatcher(this.root, watcher);
  }

  private watchDirectory(directory: string): void {
    if (this.closed || this.failed || this.watchers.has(directory) || this.isIgnored(directory)) {
      return;
    }
    if (this.watchers.size >= DEFAULT_MAX_WATCHED_DIRECTORIES) {
      directoryLimitFailureCount += 1;
      throw new Error(
        `Recursive file observation exceeded ${DEFAULT_MAX_WATCHED_DIRECTORIES} directories under ${this.root}`,
      );
    }

    const watcher = watch(directory, (eventType, filename) => {
      if (this.closed || this.failed) return;
      const path = filename ? resolve(directory, filename.toString()) : directory;
      if (!this.isIgnored(path)) {
        if (eventType === "change") this.queueEvent("update", path);
        else this.classifyRenameEvent(path);
      }
      if (eventType === "rename" || !filename) this.requestReconcile(path);
    });
    this.attachWatcher(directory, watcher);
  }

  private attachWatcher(directory: string, watcher: FSWatcher): void {
    watcher.on("error", (error) => {
      if (this.closed || this.failed) return;
      if (isExpectedWatchDisappearance(error)) {
        watcher.close();
        if (this.watchers.get(directory) === watcher) this.watchers.delete(directory);
        if (directory === this.root) {
          this.fail(toError(error));
          return;
        }
        this.requestReconcile(directory);
        return;
      }
      this.fail(toError(error));
    });
    this.watchers.set(directory, watcher);
  }

  private enqueueReconcile(scopes: string[]): Promise<void> {
    const result = this.reconcileTail.then(() => this.runQueuedReconcile(scopes));
    this.reconcileTail = result.catch(() => undefined);
    return result;
  }

  private async runQueuedReconcile(scopes: string[]): Promise<void> {
    if (this.closed || this.failed) return;
    this.reconcileInFlight = true;
    try {
      await this.reconcileDirectoryWatchers(collapsePaths(scopes));
    } finally {
      this.reconcileInFlight = false;
    }
  }

  private async reconcileDirectoryWatchers(scopes: string[]): Promise<void> {
    const startedAt = performance.now();
    try {
      for (const scope of scopes) {
        const snapshot = await this.scanDirectories(scope);
        if (this.closed || this.failed) return;

        for (const directory of snapshot.directories) {
          if (!this.watchSnapshotDirectory(directory)) snapshot.directories.delete(directory);
        }
        for (const path of snapshot.filesDiscoveredBeforeCoverage) {
          this.queueEvent("create", path);
        }
        for (const [directory, watcher] of this.watchers) {
          if (
            directory !== this.root &&
            isPathInside(scope, directory) &&
            !snapshot.directories.has(directory)
          ) {
            watcher.close();
            this.watchers.delete(directory);
            this.queueEvent("delete", directory);
          }
        }
      }
    } catch (error) {
      reconciliationFailureCount += 1;
      throw error;
    } finally {
      const durationMs = performance.now() - startedAt;
      reconciliationCount += 1;
      lastReconciliationDurationMs = durationMs;
      maxReconciliationDurationMs = Math.max(maxReconciliationDurationMs, durationMs);
    }
  }

  private watchSnapshotDirectory(directory: string): boolean {
    try {
      this.watchDirectory(directory);
      return true;
    } catch (error) {
      if (!isExpectedWatchDisappearance(error)) throw error;
      if (directory === this.root) throw error;
      return false;
    }
  }

  private async scanDirectories(scope: string): Promise<DirectorySnapshot> {
    let scopeStats;
    try {
      scopeStats = await stat(scope);
    } catch (error) {
      if (!isMissingPathError(error) || scope === this.root) throw error;
      return { directories: new Set(), filesDiscoveredBeforeCoverage: new Set() };
    }
    if (!scopeStats.isDirectory()) {
      return { directories: new Set(), filesDiscoveredBeforeCoverage: new Set() };
    }
    const directories = new Set<string>([scope]);
    const filesDiscoveredBeforeCoverage = new Set<string>();
    const pending = [scope];
    while (pending.length > 0 && !this.closed && !this.failed) {
      const directory = pending.pop();
      if (!directory) continue;
      let entries: Dirent[];
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
        if (directory === this.root && !this.closed) throw error;
        continue;
      }
      for (const entry of entries) {
        const child = join(directory, entry.name);
        if (this.isIgnored(child)) continue;
        if (!entry.isDirectory()) {
          if (!this.watchers.has(directory)) filesDiscoveredBeforeCoverage.add(child);
          continue;
        }
        directories.add(child);
        if (directories.size > DEFAULT_MAX_WATCHED_DIRECTORIES) {
          directoryLimitFailureCount += 1;
          throw new Error(
            `Recursive file observation exceeded ${DEFAULT_MAX_WATCHED_DIRECTORIES} directories under ${this.root}`,
          );
        }
        pending.push(child);
      }
    }
    return { directories, filesDiscoveredBeforeCoverage };
  }

  private queueEvent(type: FileChangeType, path: string): void {
    if (this.closed || this.failed || this.isIgnored(path)) return;
    const previous = this.pendingEvents.get(path);
    this.pendingEvents.set(path, mergeChange(previous, { path, type }));
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.closed || this.failed || this.pendingEvents.size === 0) return;
      const events = [...this.pendingEvents.values()];
      this.pendingEvents.clear();
      this.callback(null, events);
    }, EVENT_BATCH_DELAY_MS);
  }

  private requestReconcile(scope: string): void {
    if (this.closed || this.failed) return;
    this.pendingReconciliationScopes.add(scope);
    if (this.reconcileTimer) return;
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      const scopes = [...this.pendingReconciliationScopes];
      this.pendingReconciliationScopes.clear();
      void this.enqueueReconcile(scopes).catch((error: unknown) => this.fail(toError(error)));
    }, RECONCILIATION_DELAY_MS);
    this.reconcileTimer.unref();
  }

  private cancelQueuedReconciliation(): void {
    if (this.reconcileTimer) {
      clearTimeout(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    this.pendingReconciliationScopes.clear();
  }

  private classifyRenameEvent(path: string): void {
    let classification!: Promise<void>;
    classification = stat(path)
      .then(() => this.queueEvent("create", path))
      .catch((error: unknown) => {
        if (isMissingPathError(error)) {
          this.queueEvent("delete", path);
          return;
        }
        this.fail(toError(error));
      })
      .finally(() => this.pathClassifications.delete(classification));
    this.pathClassifications.add(classification);
  }

  private isIgnored(path: string): boolean {
    return this.ignoredRoots.some((ignoredRoot) => isPathInside(ignoredRoot, path));
  }

  private fail(error: Error): void {
    if (this.closed || this.failed) return;
    this.failed = true;
    observerFailureCount += 1;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.cancelQueuedReconciliation();
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.pendingEvents.clear();
    activeObservers.delete(this);
    this.callback(error, []);
  }
}

function supportsNativeRecursiveWatch(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "win32";
}

function normalizeIgnoredRoots(root: string, paths: string[]): string[] {
  return [
    ...new Set(
      paths
        .map((path) => resolve(path))
        .filter((path) => path !== root && isPathInside(root, path)),
    ),
  ]
    .sort((left, right) => left.length - right.length)
    .filter(
      (path, index, all) => !all.slice(0, index).some((parent) => isPathInside(parent, path)),
    );
}

function samePaths(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

function collapsePaths(paths: string[]): string[] {
  return [...new Set(paths)]
    .sort((left, right) => left.length - right.length)
    .filter(
      (path, index, all) => !all.slice(0, index).some((parent) => isPathInside(parent, path)),
    );
}

function isPathInside(root: string, path: string): boolean {
  const comparedRoot = process.platform === "win32" ? root.toLowerCase() : root;
  const comparedPath = process.platform === "win32" ? path.toLowerCase() : path;
  return comparedPath === comparedRoot || comparedPath.startsWith(`${comparedRoot}${sep}`);
}

function mergeChange(previous: FileChange | undefined, next: FileChange): FileChange {
  if (!previous) return next;
  if (previous.type === "create" && next.type === "delete") return { ...next, type: "update" };
  if (previous.type === "delete" && next.type === "create") return { ...next, type: "update" };
  if (previous.type === "create") return previous;
  return next;
}

function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isExpectedWatchDisappearance(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || (process.platform === "win32" && code === "EPERM");
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
