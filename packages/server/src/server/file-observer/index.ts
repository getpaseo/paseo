import { type Dirent, type FSWatcher, watch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

const DEFAULT_MAX_WATCHED_DIRECTORIES = 5_000;
const DEFAULT_MAX_TRACKED_NATIVE_ENTRIES = 250_000;
const EVENT_BATCH_DELAY_MS = 10;
const RECONCILIATION_DELAY_MS = 50;
const NATIVE_AUDIT_QUIET_MS = 500;
const NATIVE_AUDIT_MAX_DIRTY_MS = 5_000;
const NATIVE_CHANGE_SCOPE_FRESH_MS = 5_000;
const NATIVE_FULL_AUDIT_QUIET_MS = 30_000;
const NATIVE_FULL_AUDIT_MIN_INTERVAL_MS = 30_000;
const NATIVE_FULL_AUDIT_MAX_DIRTY_MS = 5 * 60_000;

const activeObservers = new Set<RecursiveFileObserver>();
let reconciliationCount = 0;
let scopedReconciliationCount = 0;
let fullReconciliationCount = 0;
let reconciliationFailureCount = 0;
let observerFailureCount = 0;
let directoryLimitFailureCount = 0;
let nativeEventCount = 0;
let nativeChangeEventCount = 0;
let nativeRenameEventCount = 0;
let nativePathlessEventCount = 0;
let nativeClassificationCount = 0;
let nativeShallowScanCount = 0;
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
  nativeTrackedFileCount: number;
  pendingEventCount: number;
  reconciliationInFlightCount: number;
  reconciliationCount: number;
  scopedReconciliationCount: number;
  fullReconciliationCount: number;
  reconciliationFailureCount: number;
  observerFailureCount: number;
  directoryLimitFailureCount: number;
  nativeEventCount: number;
  nativeChangeEventCount: number;
  nativeRenameEventCount: number;
  nativePathlessEventCount: number;
  nativeClassificationCount: number;
  nativeShallowScanCount: number;
  lastReconciliationDurationMs: number;
  maxReconciliationDurationMs: number;
}

export type SubscribeToFileChanges = typeof subscribeToFileChanges;

/** Aggregate health without exposing watched paths or platform topology. */
export function getFileObserverDiagnostics(): FileObserverDiagnostics {
  let nativeHandleCount = 0;
  let nativeTrackedFileCount = 0;
  let pendingEventCount = 0;
  let reconciliationInFlightCount = 0;
  for (const observer of activeObservers) {
    const diagnostics = observer.getDiagnostics();
    nativeHandleCount += diagnostics.nativeHandleCount;
    nativeTrackedFileCount += diagnostics.nativeTrackedFileCount;
    pendingEventCount += diagnostics.pendingEventCount;
    reconciliationInFlightCount += diagnostics.reconciliationInFlight ? 1 : 0;
  }
  return {
    activeObservationCount: activeObservers.size,
    nativeHandleCount,
    nativeTrackedFileCount,
    pendingEventCount,
    reconciliationInFlightCount,
    reconciliationCount,
    scopedReconciliationCount,
    fullReconciliationCount,
    reconciliationFailureCount,
    observerFailureCount,
    directoryLimitFailureCount,
    nativeEventCount,
    nativeChangeEventCount,
    nativeRenameEventCount,
    nativePathlessEventCount,
    nativeClassificationCount,
    nativeShallowScanCount,
    lastReconciliationDurationMs,
    maxReconciliationDurationMs,
  };
}

interface DirectorySnapshot {
  directories: Set<string>;
  filesDiscoveredBeforeCoverage: Set<string>;
}

interface NativeDirectoryEntry {
  directories: Set<string>;
  files: Set<string>;
}

interface NativeInventory {
  directories: Set<string>;
  entries: Map<string, NativeDirectoryEntry>;
  files: Set<string>;
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
  private nativeFiles = new Set<string>();
  private nativeDirectories = new Set<string>();
  private nativeEntries = new Map<string, NativeDirectoryEntry>();
  private readonly nativeDirectoryInventoryAt = new Map<string, number>();
  private nativeAuditTimer: NodeJS.Timeout | null = null;
  private nativeFullAuditTimer: NodeJS.Timeout | null = null;
  private readonly pendingNativeAuditScopes = new Set<string>();
  private readonly pendingNativeRecursiveAuditScopes = new Set<string>();
  private nativeFullAuditRequested = false;
  private nativeAuditDirty = false;
  private nativeAuditDirtySince: number | null = null;
  private nativeAuditLastDirtyAt: number | null = null;
  private nativeAuditQueued = false;
  private nativeAuditRunning = false;
  private nativeSafetyAuditPending = false;
  private nativeSafetyAuditDirtySince: number | null = null;
  private nativeSafetyAuditLastDirtyAt: number | null = null;
  private lastNativeFullAuditAt = Number.NEGATIVE_INFINITY;
  private nativeInventoryGeneration = 0;
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
      this.nativeFullAuditRequested = true;
      this.nativeAuditQueued = true;
      try {
        await this.enqueueNativeAudit(false, this.nativeInventoryGeneration);
      } catch (error) {
        await this.close();
        throw error;
      }
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
    if (supportsNativeRecursiveWatch(process.platform)) {
      this.nativeInventoryGeneration += 1;
      this.cancelNativeAudit();
      this.nativeFullAuditRequested = true;
      this.nativeAuditQueued = true;
      try {
        await this.enqueueNativeAudit(true, this.nativeInventoryGeneration);
      } catch (error) {
        this.fail(toError(error));
        throw error;
      }
    } else {
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
    this.cancelNativeAudit();
    this.pendingEvents.clear();
    this.closePromise = this.finishClose();
    return this.closePromise;
  }

  getDiagnostics(): {
    nativeHandleCount: number;
    nativeTrackedFileCount: number;
    pendingEventCount: number;
    reconciliationInFlight: boolean;
  } {
    return {
      nativeHandleCount: this.watchers.size,
      nativeTrackedFileCount: this.nativeFiles.size,
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
    this.nativeFiles.clear();
    this.nativeDirectories.clear();
    this.nativeEntries.clear();
    this.nativeDirectoryInventoryAt.clear();
    activeObservers.delete(this);
  }

  private watchNativeRecursive(): void {
    const watcher = watch(this.root, { recursive: true }, (eventType, filename) => {
      if (this.closed || this.failed) return;
      nativeEventCount += 1;
      if (!filename) {
        nativePathlessEventCount += 1;
        this.queueEvent("update", this.root);
        this.requestNativeAudit(this.root);
        return;
      }
      const path = resolve(this.root, filename.toString());
      if (this.isIgnored(path)) return;
      const scope = path === this.root ? this.root : dirname(path);
      if (eventType === "change") {
        nativeChangeEventCount += 1;
        this.queueEvent("update", path);
        this.requestNativeChangeAudit(scope);
      } else {
        nativeRenameEventCount += 1;
        this.classifyRenameEvent(path);
        this.requestNativeAudit(scope);
      }
      if (this.nativeDirectories.has(path)) this.requestNativeAudit(path, false, true);
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

  private enqueueNativeAudit(emitDiff: boolean, generation: number): Promise<void> {
    const result = this.reconcileTail.then(() => this.runNativeAudit(emitDiff, generation));
    this.reconcileTail = result.catch(() => undefined);
    return result;
  }

  private async runNativeAudit(emitDiff: boolean, generation: number): Promise<void> {
    this.nativeAuditQueued = false;
    if (!this.canCommitNativeAudit(generation)) return;
    const fullAudit = this.nativeFullAuditRequested;
    const localScopes = [...this.pendingNativeAuditScopes];
    const recursiveScopes = [...this.pendingNativeRecursiveAuditScopes];
    this.nativeFullAuditRequested = false;
    this.pendingNativeAuditScopes.clear();
    this.pendingNativeRecursiveAuditScopes.clear();
    if (fullAudit) {
      this.nativeSafetyAuditPending = false;
      this.nativeSafetyAuditDirtySince = null;
      this.nativeSafetyAuditLastDirtyAt = null;
      if (this.nativeFullAuditTimer) {
        clearTimeout(this.nativeFullAuditTimer);
        this.nativeFullAuditTimer = null;
      }
    }
    this.nativeAuditRunning = true;
    this.nativeAuditDirty = false;
    this.nativeAuditDirtySince = null;
    this.nativeAuditLastDirtyAt = null;
    this.reconcileInFlight = true;
    const startedAt = performance.now();
    try {
      if (fullAudit) {
        const nextInventory = await this.scanNativeTree(this.root);
        if (!this.canCommitNativeAudit(generation)) return;
        if (emitDiff) this.queueNativeInventoryDiff(nextInventory.files, this.nativeFiles);
        this.replaceNativeInventory(nextInventory);
        this.lastNativeFullAuditAt = performance.now();
        fullReconciliationCount += 1;
      } else {
        await this.reconcileNativeScopes(localScopes, recursiveScopes, generation);
        scopedReconciliationCount += 1;
      }
    } catch (error) {
      reconciliationFailureCount += 1;
      throw error;
    } finally {
      const durationMs = performance.now() - startedAt;
      reconciliationCount += 1;
      lastReconciliationDurationMs = durationMs;
      maxReconciliationDurationMs = Math.max(maxReconciliationDurationMs, durationMs);
      this.reconcileInFlight = false;
      this.nativeAuditRunning = false;
      if (this.nativeSafetyAuditPending && !this.closed && !this.failed)
        this.scheduleNativeFullAudit();
      if (this.nativeAuditDirty && !this.closed && !this.failed) this.scheduleNativeAudit();
    }
  }

  private async scanNativeTree(root: string): Promise<NativeInventory> {
    const files = new Set<string>();
    const directories = new Set<string>();
    const entries = new Map<string, NativeDirectoryEntry>();
    const pending = [root];
    while (pending.length > 0 && !this.closed && !this.failed) {
      const directory = pending.pop();
      if (!directory) continue;
      let children: Dirent[];
      try {
        children = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (isMissingPathError(error) && this.closed) return { directories, entries, files };
        if (!isMissingPathError(error) || directory === this.root) throw error;
        continue;
      }
      directories.add(directory);
      if (files.size + directories.size > DEFAULT_MAX_TRACKED_NATIVE_ENTRIES) {
        throw new Error(
          `Recursive file observation exceeded ${DEFAULT_MAX_TRACKED_NATIVE_ENTRIES} entries under ${this.root}`,
        );
      }
      const entry: NativeDirectoryEntry = { directories: new Set(), files: new Set() };
      for (const child of children) {
        const path = join(directory, child.name);
        if (this.isIgnored(path)) continue;
        if (child.isDirectory()) {
          entry.directories.add(path);
          pending.push(path);
          continue;
        }
        entry.files.add(path);
        files.add(path);
        if (files.size + directories.size > DEFAULT_MAX_TRACKED_NATIVE_ENTRIES) {
          throw new Error(
            `Recursive file observation exceeded ${DEFAULT_MAX_TRACKED_NATIVE_ENTRIES} entries under ${this.root}`,
          );
        }
      }
      entries.set(directory, entry);
    }
    return { directories, entries, files };
  }

  private queueNativeInventoryDiff(nextFiles: Set<string>, previousFiles: Set<string>): void {
    for (const path of nextFiles) {
      if (!previousFiles.has(path)) this.queueEvent("create", path);
    }
    for (const path of previousFiles) {
      if (!nextFiles.has(path)) this.queueEvent("delete", path);
    }
  }

  private replaceNativeInventory(inventory: NativeInventory): void {
    this.nativeFiles = inventory.files;
    this.nativeDirectories = inventory.directories;
    this.nativeEntries = inventory.entries;
    this.nativeDirectoryInventoryAt.clear();
  }

  private async reconcileNativeScopes(
    localScopes: string[],
    recursiveScopes: string[],
    generation: number,
  ): Promise<void> {
    for (const directory of new Set(localScopes)) {
      await this.reconcileNativeDirectory(directory, generation);
      if (!this.canCommitNativeAudit(generation)) return;
    }
    for (const directory of new Set(recursiveScopes)) {
      await this.reconcileNativeSubtree(directory, generation);
      if (!this.canCommitNativeAudit(generation)) return;
    }
  }

  private async reconcileNativeDirectory(directory: string, generation: number): Promise<void> {
    if (this.isIgnored(directory)) {
      this.removeNativeSubtree(directory, false);
      return;
    }
    if (directory !== this.root && !this.nativeDirectories.has(directory)) {
      await this.reconcileUnknownNativeSubtree(directory, generation);
      return;
    }
    const next = await this.readNativeDirectoryEntry(directory);
    if (!this.canCommitNativeAudit(generation)) return;
    if (!next) {
      this.removeNativeSubtree(directory, true);
      return;
    }
    this.nativeDirectoryInventoryAt.set(directory, performance.now());

    const previous = this.nativeEntries.get(directory) ?? {
      directories: new Set<string>(),
      files: new Set<string>(),
    };

    for (const path of previous.files) {
      if (!next.files.has(path)) {
        this.nativeFiles.delete(path);
        this.queueEvent("delete", path);
      }
    }
    for (const path of previous.directories) {
      if (!next.directories.has(path)) this.removeNativeSubtree(path, true);
    }
    for (const path of next.files) {
      if (!previous.files.has(path)) {
        this.nativeFiles.add(path);
        this.queueEvent("create", path);
      }
    }
    for (const path of next.directories) {
      if (previous.directories.has(path)) continue;
      const inventory = await this.scanNativeTree(path);
      if (!this.canCommitNativeAudit(generation)) return;
      if (!inventory.directories.has(path)) {
        next.directories.delete(path);
        continue;
      }
      this.mergeNativeInventory(inventory, true);
    }
    this.nativeDirectories.add(directory);
    this.nativeEntries.set(directory, next);
    this.assertNativeInventoryWithinLimit();
  }

  private async reconcileUnknownNativeSubtree(
    directory: string,
    generation: number,
  ): Promise<void> {
    const inventory = await this.scanNativeTree(directory);
    if (!this.canCommitNativeAudit(generation)) return;
    if (!inventory.directories.has(directory)) {
      this.removeNativeSubtree(directory, true);
      return;
    }
    this.nativeEntries.get(dirname(directory))?.directories.add(directory);
    this.mergeNativeInventory(inventory, true);
  }

  private async readNativeDirectoryEntry(directory: string): Promise<NativeDirectoryEntry | null> {
    nativeShallowScanCount += 1;
    let children: Dirent[];
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (!isMissingPathError(error) || directory === this.root) throw error;
      return null;
    }
    const entry: NativeDirectoryEntry = { directories: new Set(), files: new Set() };
    for (const child of children) {
      const path = join(directory, child.name);
      if (this.isIgnored(path)) continue;
      if (child.isDirectory()) entry.directories.add(path);
      else entry.files.add(path);
    }
    return entry;
  }

  private async reconcileNativeSubtree(directory: string, generation: number): Promise<void> {
    if (!this.nativeDirectories.has(directory) || this.isIgnored(directory)) return;
    const inventory = await this.scanNativeTree(directory);
    if (!this.canCommitNativeAudit(generation)) return;
    const previousFiles = new Set(
      [...this.nativeFiles].filter((path) => isPathInside(directory, path)),
    );
    this.queueNativeInventoryDiff(inventory.files, previousFiles);
    this.removeNativeSubtree(directory, false);
    this.mergeNativeInventory(inventory, false);
  }

  private mergeNativeInventory(inventory: NativeInventory, emitCreates: boolean): void {
    for (const directory of inventory.directories) this.nativeDirectories.add(directory);
    for (const [directory, entry] of inventory.entries) this.nativeEntries.set(directory, entry);
    for (const path of inventory.files) {
      const added = !this.nativeFiles.has(path);
      this.nativeFiles.add(path);
      if (emitCreates && added) this.queueEvent("create", path);
    }
    this.assertNativeInventoryWithinLimit();
  }

  private removeNativeSubtree(root: string, emitDeletes: boolean): void {
    for (const path of this.nativeFiles) {
      if (!isPathInside(root, path)) continue;
      this.nativeFiles.delete(path);
      if (emitDeletes) this.queueEvent("delete", path);
    }
    for (const directory of this.nativeDirectories) {
      if (!isPathInside(root, directory)) continue;
      this.nativeDirectories.delete(directory);
      this.nativeEntries.delete(directory);
    }
    for (const directory of this.nativeDirectoryInventoryAt.keys()) {
      if (isPathInside(root, directory)) this.nativeDirectoryInventoryAt.delete(directory);
    }
    const parentEntry = this.nativeEntries.get(dirname(root));
    parentEntry?.directories.delete(root);
    parentEntry?.files.delete(root);
  }

  private assertNativeInventoryWithinLimit(): void {
    if (this.nativeFiles.size + this.nativeDirectories.size <= DEFAULT_MAX_TRACKED_NATIVE_ENTRIES)
      return;
    throw new Error(
      `Recursive file observation exceeded ${DEFAULT_MAX_TRACKED_NATIVE_ENTRIES} entries under ${this.root}`,
    );
  }

  private canCommitNativeAudit(generation: number): boolean {
    return !this.closed && !this.failed && generation === this.nativeInventoryGeneration;
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

  private requestNativeAudit(scope: string, fullAudit = false, recursiveAudit = false): void {
    if (this.closed || this.failed) return;
    if (fullAudit) {
      this.requestNativeSafetyAudit();
      return;
    }
    if (recursiveAudit) this.pendingNativeRecursiveAuditScopes.add(scope);
    else this.pendingNativeAuditScopes.add(scope);
    this.requestNativeSafetyAudit();
    const now = performance.now();
    this.nativeAuditDirty = true;
    this.nativeAuditDirtySince ??= now;
    this.nativeAuditLastDirtyAt = now;
    if (this.nativeAuditQueued || this.nativeAuditRunning) return;
    this.scheduleNativeAudit();
  }

  private requestNativeChangeAudit(scope: string): void {
    const inventoriedAt = this.nativeDirectoryInventoryAt.get(scope);
    if (
      inventoriedAt !== undefined &&
      performance.now() - inventoriedAt < NATIVE_CHANGE_SCOPE_FRESH_MS
    ) {
      this.requestNativeSafetyAudit();
      return;
    }
    this.requestNativeAudit(scope);
  }

  private requestNativeSafetyAudit(): void {
    if (this.closed || this.failed) return;
    const now = performance.now();
    this.nativeSafetyAuditPending = true;
    this.nativeSafetyAuditDirtySince ??= now;
    this.nativeSafetyAuditLastDirtyAt = now;
    this.scheduleNativeFullAudit();
  }

  private scheduleNativeAudit(): void {
    if (
      this.closed ||
      this.failed ||
      !this.nativeAuditDirty ||
      this.nativeAuditQueued ||
      this.nativeAuditRunning ||
      this.nativeAuditTimer
    )
      return;
    const now = performance.now();
    const dirtySince = this.nativeAuditDirtySince ?? now;
    const quietDeadline = (this.nativeAuditLastDirtyAt ?? now) + NATIVE_AUDIT_QUIET_MS;
    const starvationDeadline = dirtySince + NATIVE_AUDIT_MAX_DIRTY_MS;
    const deadline = Math.min(quietDeadline, starvationDeadline);
    this.nativeAuditTimer = setTimeout(
      () => {
        this.nativeAuditTimer = null;
        const nextNow = performance.now();
        const nextQuietDeadline = (this.nativeAuditLastDirtyAt ?? nextNow) + NATIVE_AUDIT_QUIET_MS;
        const nextStarvationDeadline =
          (this.nativeAuditDirtySince ?? nextNow) + NATIVE_AUDIT_MAX_DIRTY_MS;
        if (nextNow < Math.min(nextQuietDeadline, nextStarvationDeadline)) {
          this.scheduleNativeAudit();
          return;
        }
        this.nativeAuditQueued = true;
        void this.enqueueNativeAudit(true, this.nativeInventoryGeneration).catch((error: unknown) =>
          this.fail(toError(error)),
        );
      },
      Math.max(0, deadline - performance.now()),
    );
    this.nativeAuditTimer.unref();
  }

  private scheduleNativeFullAudit(): void {
    if (
      this.closed ||
      this.failed ||
      !this.nativeSafetyAuditPending ||
      this.nativeAuditRunning ||
      this.nativeFullAuditTimer
    )
      return;
    const now = performance.now();
    const dirtySince = this.nativeSafetyAuditDirtySince ?? now;
    const quietDeadline = (this.nativeSafetyAuditLastDirtyAt ?? now) + NATIVE_FULL_AUDIT_QUIET_MS;
    const intervalDeadline = this.lastNativeFullAuditAt + NATIVE_FULL_AUDIT_MIN_INTERVAL_MS;
    const starvationDeadline = dirtySince + NATIVE_FULL_AUDIT_MAX_DIRTY_MS;
    const deadline = Math.min(starvationDeadline, Math.max(intervalDeadline, quietDeadline));
    this.nativeFullAuditTimer = setTimeout(
      () => {
        this.nativeFullAuditTimer = null;
        if (this.closed || this.failed || !this.nativeSafetyAuditPending) return;
        if (this.nativeAuditRunning) return;
        const nextNow = performance.now();
        const nextQuietDeadline =
          (this.nativeSafetyAuditLastDirtyAt ?? nextNow) + NATIVE_FULL_AUDIT_QUIET_MS;
        const nextIntervalDeadline = this.lastNativeFullAuditAt + NATIVE_FULL_AUDIT_MIN_INTERVAL_MS;
        const nextStarvationDeadline =
          (this.nativeSafetyAuditDirtySince ?? nextNow) + NATIVE_FULL_AUDIT_MAX_DIRTY_MS;
        if (
          nextNow <
          Math.min(nextStarvationDeadline, Math.max(nextIntervalDeadline, nextQuietDeadline))
        ) {
          this.scheduleNativeFullAudit();
          return;
        }
        this.nativeSafetyAuditPending = false;
        this.nativeFullAuditRequested = true;
        this.nativeAuditDirty = true;
        this.nativeAuditDirtySince ??= performance.now();
        this.scheduleNativeAudit();
      },
      Math.max(0, deadline - performance.now()),
    );
    this.nativeFullAuditTimer.unref();
  }

  private cancelQueuedReconciliation(): void {
    if (this.reconcileTimer) {
      clearTimeout(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    this.pendingReconciliationScopes.clear();
  }

  private cancelNativeAudit(): void {
    if (this.nativeAuditTimer) {
      clearTimeout(this.nativeAuditTimer);
      this.nativeAuditTimer = null;
    }
    if (this.nativeFullAuditTimer) {
      clearTimeout(this.nativeFullAuditTimer);
      this.nativeFullAuditTimer = null;
    }
    this.pendingNativeAuditScopes.clear();
    this.pendingNativeRecursiveAuditScopes.clear();
    this.nativeDirectoryInventoryAt.clear();
    this.nativeFullAuditRequested = false;
    this.nativeSafetyAuditPending = false;
    this.nativeSafetyAuditDirtySince = null;
    this.nativeSafetyAuditLastDirtyAt = null;
    this.nativeAuditDirty = false;
    this.nativeAuditDirtySince = null;
    this.nativeAuditLastDirtyAt = null;
  }

  private classifyRenameEvent(path: string): void {
    nativeClassificationCount += 1;
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
    this.cancelNativeAudit();
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
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function isExpectedWatchDisappearance(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || (process.platform === "win32" && code === "EPERM");
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
