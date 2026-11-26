import { type Dirent, type FSWatcher, watch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { BackendDiagnostics, ObservationBackend, ObservationHost } from "./contracts.js";
import type { ObserverPaths } from "./paths.js";
import { isMissingPathError, toError } from "./paths.js";
import { createScanSliceBudget, type ScanSliceBudget } from "./scan-slice.js";

const MAX_WATCHED_DIRECTORIES = 5_000;
const RECONCILIATION_DELAY_MS = 50;
// fs.stat runs on the libuv threadpool, which is four threads and shared by the
// whole daemon. One stat per native event pins it and unrelated filesystem work
// stalls. The concurrency limit bounds that.
//
// Unlike the native backend, this backend keeps no file-level inventory
// (nativeTrackedFileCount is always 0, and its own reconcile() diffs
// directories, never files) and runs no periodic full-tree safety audit. A
// classification shed here can never be recovered later, so overflow must
// fail the observation loudly instead of silently dropping a create or
// delete. WorkspaceGit already handles this failure mode: it catches the
// existing MAX_WATCHED_DIRECTORIES overflow and falls back to bounded
// polling. The cap is generous — it should only trip under genuine
// pathology, not an ordinary large burst.
const MAX_CONCURRENT_CLASSIFICATIONS = 32;
const MAX_QUEUED_CLASSIFICATIONS = 16_384;
const MAX_WATCH_ATTACH_ATTEMPTS = 3;
const MAX_DIRECTORY_RESCANS = 3;

// "baseline" establishes coverage of what already exists when the subscription
// starts, so it reports nothing. "changes" scans topology that appeared while
// observed, so files found before their directory was covered are creates.
type ReconcileMode = "baseline" | "changes";

interface DirectoryIdentity {
  dev: bigint;
  ino: bigint;
}

interface WatchedDirectory {
  watcher: FSWatcher;
  identity: DirectoryIdentity;
}

interface DirectorySnapshot {
  directories: Set<string>;
  filesDiscoveredBeforeCoverage: Set<string>;
}

type DirectoryScanOutcome = "ok" | "aborted" | "ignored" | "replaced";

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

type WatchDirectory = (
  directory: string,
  listener: (eventType: string, filename: string | null) => void,
) => FSWatcher;

const watchDirectory: WatchDirectory = (directory, listener) => watch(directory, listener);

export function createLinuxBackend(
  host: ObservationHost,
  paths: ObserverPaths,
  observe: WatchDirectory = watchDirectory,
): ObservationBackend {
  return new LinuxBackend(host, paths, observe);
}

class LinuxBackend implements ObservationBackend {
  private readonly watchers = new Map<string, WatchedDirectory>();
  private readonly classifications = new Set<Promise<void>>();
  private readonly classificationQueue: Array<{ path: string }> = [];
  private readonly pendingScopes = new Set<string>();
  private reconcileTail: Promise<void> = Promise.resolve();
  private queueDepth = 0;
  private inFlight = false;
  private timer: NodeJS.Timeout | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly host: ObservationHost,
    private readonly paths: ObserverPaths,
    private readonly observe: WatchDirectory,
  ) {}

  async start(): Promise<void> {
    const rootIdentity = await this.statDirectoryIdentity(this.host.root);
    if (!rootIdentity || !this.host.isActive()) return;
    this.watchDirectory(this.host.root, rootIdentity);
    await this.enqueue([this.host.root], "baseline");
  }

  async updateIgnore(): Promise<void> {
    this.discardIgnoredClassifications();
    const inFlight = [...this.classifications];
    for (const [directory, entry] of this.watchers) {
      if (directory !== this.host.root && this.host.isIgnored(directory)) {
        entry.watcher.close();
        this.watchers.delete(directory);
      }
    }
    this.cancelQueued();
    await this.enqueue([this.host.root], "changes");
    await Promise.allSettled(inFlight);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.cancelQueued();
    for (const entry of this.watchers.values()) entry.watcher.close();
    this.watchers.clear();
    this.closePromise = this.finishClose();
    return this.closePromise;
  }

  getDiagnostics(): BackendDiagnostics {
    return {
      nativeHandleCount: this.watchers.size,
      nativeTrackedFileCount: 0,
      pendingReconciliationWorkCount:
        this.pendingScopes.size +
        this.classifications.size +
        this.classificationQueue.length +
        this.queueDepth +
        Number(this.timer !== null),
      pendingClassificationCount: this.classifications.size + this.classificationQueue.length,
      reconciliationInFlight: this.inFlight,
    };
  }

  private async finishClose(): Promise<void> {
    await this.reconcileTail;
    this.classificationQueue.length = 0;
    await Promise.allSettled(this.classifications);
    for (const entry of this.watchers.values()) entry.watcher.close();
    this.watchers.clear();
  }

  private closeWatcher(directory: string): void {
    const existing = this.watchers.get(directory);
    if (!existing) return;
    existing.watcher.close();
    this.watchers.delete(directory);
  }

  private watchDirectory(directory: string, identity: DirectoryIdentity): void {
    if (!this.host.isActive() || this.watchers.has(directory) || this.host.isIgnored(directory)) {
      return;
    }
    if (this.watchers.size >= MAX_WATCHED_DIRECTORIES) {
      this.host.metrics.directoryLimitFailureCount += 1;
      throw new Error(
        `Recursive file observation exceeded ${MAX_WATCHED_DIRECTORIES} directories under ${this.host.root}`,
      );
    }
    const watcher = this.observe(directory, (eventType, filename) => {
      if (!this.host.isActive()) return;
      const path = filename ? resolve(directory, filename.toString()) : directory;
      if (!this.host.isIgnored(path)) {
        if (eventType === "change") this.host.queueEvent("update", path);
        else this.classify(path);
      }
      if (eventType === "rename" || !filename) this.requestReconcile(path);
    });
    this.attachWatcher(directory, watcher, identity);
  }

  private attachWatcher(directory: string, watcher: FSWatcher, identity: DirectoryIdentity): void {
    watcher.on("error", (error) => {
      if (!this.host.isActive()) return;
      if (this.paths.isExpectedWatchDisappearance(error)) {
        watcher.close();
        if (this.watchers.get(directory)?.watcher === watcher) this.watchers.delete(directory);
        if (directory === this.host.root) {
          this.host.fail(toError(error));
          return;
        }
        this.requestReconcile(directory);
        return;
      }
      this.host.fail(toError(error));
    });
    this.watchers.set(directory, { watcher, identity });
  }

  private requestReconcile(scope: string): void {
    if (!this.host.isActive()) return;
    this.pendingScopes.add(scope);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const scopes = [...this.pendingScopes];
      this.pendingScopes.clear();
      void this.enqueue(scopes, "changes").catch((error: unknown) =>
        this.host.fail(toError(error)),
      );
    }, RECONCILIATION_DELAY_MS);
    this.timer.unref();
  }

  private enqueue(scopes: string[], mode: ReconcileMode): Promise<void> {
    this.queueDepth += 1;
    const result = this.reconcileTail
      .then(() => this.run(scopes, mode))
      .finally(() => {
        this.queueDepth -= 1;
      });
    this.reconcileTail = result.catch(() => undefined);
    return result;
  }

  private async run(scopes: string[], mode: ReconcileMode): Promise<void> {
    if (!this.host.isActive()) return;
    this.inFlight = true;
    const startedAt = performance.now();
    try {
      await this.reconcile(this.paths.collapse(scopes), mode);
    } catch (error) {
      this.host.metrics.reconciliationFailureCount += 1;
      throw error;
    } finally {
      const durationMs = performance.now() - startedAt;
      this.host.metrics.reconciliationCount += 1;
      this.host.metrics.scopedReconciliationCount += 1;
      this.host.metrics.lastReconciliationDurationMs = durationMs;
      this.host.metrics.maxReconciliationDurationMs = Math.max(
        this.host.metrics.maxReconciliationDurationMs,
        durationMs,
      );
      this.inFlight = false;
    }
  }

  private async reconcile(scopes: string[], mode: ReconcileMode): Promise<void> {
    for (const scope of scopes) {
      const snapshot = await this.scan(scope, mode);
      if (!this.host.isActive()) return;
      if (mode === "changes") {
        for (const path of snapshot.filesDiscoveredBeforeCoverage) {
          this.host.queueEvent("create", path);
        }
      }
      for (const [directory, entry] of this.watchers) {
        const disappeared =
          directory !== this.host.root &&
          this.host.isPathInside(scope, directory) &&
          !snapshot.directories.has(directory);
        if (!disappeared) continue;
        entry.watcher.close();
        this.watchers.delete(directory);
        this.host.queueEvent("delete", directory);
      }
    }
  }

  private watchSnapshotDirectory(directory: string, identity: DirectoryIdentity): boolean {
    try {
      this.watchDirectory(directory, identity);
      return true;
    } catch (error) {
      if (!this.paths.isExpectedWatchDisappearance(error) || directory === this.host.root) {
        throw error;
      }
      return false;
    }
  }

  private async statDirectoryIdentity(directory: string): Promise<DirectoryIdentity | null> {
    try {
      const stats = await stat(directory, { bigint: true });
      if (!stats.isDirectory()) return null;
      return { dev: stats.dev, ino: stats.ino };
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      if (directory === this.host.root && this.host.isActive()) throw error;
      return null;
    }
  }

  // Linux inotify watches are pinned to a directory inode, not its path. Verify
  // that the live path still resolves to the watched (dev, ino) before reusing
  // a watcher, and verify after attaching a new watch so concurrent swaps are
  // never left watching a moved-away directory.
  private async ensureDirectoryWatch(
    directory: string,
  ): Promise<{ identity: DirectoryIdentity; discovered: boolean } | null> {
    for (let attempt = 0; attempt < MAX_WATCH_ATTACH_ATTEMPTS; attempt += 1) {
      if (!this.host.isActive() || this.host.isIgnored(directory)) return null;
      const before = await this.statDirectoryIdentity(directory);
      if (!before || !this.host.isActive() || this.host.isIgnored(directory)) return null;
      const existing = this.watchers.get(directory);
      if (existing && sameDirectoryIdentity(existing.identity, before)) {
        return { identity: before, discovered: false };
      }
      if (existing) this.closeWatcher(directory);
      if (!this.watchSnapshotDirectory(directory, before)) return null;
      const after = await this.statDirectoryIdentity(directory);
      if (!after || !this.host.isActive() || this.host.isIgnored(directory)) {
        this.closeWatcher(directory);
        return null;
      }
      if (sameDirectoryIdentity(before, after)) {
        return { identity: before, discovered: true };
      }
      this.closeWatcher(directory);
    }
    this.requestReconcile(directory);
    return null;
  }

  private async readDirectoryForScan(directory: string): Promise<{
    entries: Dirent[];
    identity: DirectoryIdentity;
    discovered: boolean;
  } | null> {
    // Establish inotify coverage before taking the directory snapshot so files
    // written during readdir() or mid-directory scan yields are never missed.
    const watched = await this.ensureDirectoryWatch(directory);
    if (!watched) return null;
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      return { entries, identity: watched.identity, discovered: watched.discovered };
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      if (directory === this.host.root && this.host.isActive()) throw error;
      if (watched.discovered) this.closeWatcher(directory);
      return null;
    }
  }

  private async isDirectoryIdentityCurrent(
    directory: string,
    identity: DirectoryIdentity,
    discovered: boolean,
  ): Promise<boolean> {
    const current = await this.statDirectoryIdentity(directory);
    if (current && sameDirectoryIdentity(current, identity)) return true;
    this.closeWatcher(directory);
    if (!current && !discovered && directory !== this.host.root) {
      this.host.queueEvent("delete", directory);
    }
    return false;
  }

  private async scan(scope: string, mode: ReconcileMode): Promise<DirectorySnapshot> {
    const scopeIdentity = await this.statDirectoryIdentity(scope);
    if (!scopeIdentity || !this.host.isActive() || this.host.isIgnored(scope)) {
      return { directories: new Set(), filesDiscoveredBeforeCoverage: new Set() };
    }
    const directories = new Set<string>([scope]);
    const filesDiscoveredBeforeCoverage = new Set<string>();
    const pending = [scope];
    const rescanAttempts = new Map<string, number>();
    const slice = createScanSliceBudget();
    while (pending.length > 0 && this.host.isActive()) {
      const directory = pending.pop();
      if (!directory) continue;
      if (this.host.isIgnored(directory)) {
        directories.delete(directory);
        continue;
      }
      const scanned = await this.readDirectoryForScan(directory);
      if (!scanned) {
        directories.delete(directory);
        continue;
      }
      if (!this.host.isActive()) {
        return { directories, filesDiscoveredBeforeCoverage };
      }
      if (this.host.isIgnored(directory)) {
        directories.delete(directory);
        continue;
      }
      const outcome = await this.scanDirectoryEntries({
        directory,
        entries: scanned.entries,
        identity: scanned.identity,
        discovered: scanned.discovered,
        collectDiscoveredFiles: mode === "changes" && scanned.discovered,
        directories,
        filesDiscoveredBeforeCoverage,
        pending,
        slice,
      });
      if (outcome === "aborted") {
        return { directories, filesDiscoveredBeforeCoverage };
      }
      if (outcome === "replaced") {
        const retries = (rescanAttempts.get(directory) ?? 0) + 1;
        if (retries <= MAX_DIRECTORY_RESCANS) {
          rescanAttempts.set(directory, retries);
          pending.push(directory);
        } else {
          directories.delete(directory);
          this.requestReconcile(directory);
        }
        continue;
      }
      if (slice.isExpired()) {
        await slice.yield();
      }
    }
    return { directories, filesDiscoveredBeforeCoverage };
  }

  private async scanDirectoryEntries(input: {
    directory: string;
    entries: Dirent[];
    identity: DirectoryIdentity;
    discovered: boolean;
    collectDiscoveredFiles: boolean;
    directories: Set<string>;
    filesDiscoveredBeforeCoverage: Set<string>;
    pending: string[];
    slice: ScanSliceBudget;
  }): Promise<DirectoryScanOutcome> {
    const {
      directory,
      entries,
      identity,
      discovered,
      collectDiscoveredFiles,
      directories,
      filesDiscoveredBeforeCoverage,
      pending,
      slice,
    } = input;
    const childDirectories: string[] = [];
    const childFiles: string[] = [];
    for (const entry of entries) {
      if (slice.shouldYield()) {
        await slice.yield();
        if (!this.host.isActive()) return "aborted";
        if (this.host.isIgnored(directory)) {
          directories.delete(directory);
          return "ignored";
        }
        if (!(await this.isDirectoryIdentityCurrent(directory, identity, discovered))) {
          return "replaced";
        }
      }
      const child = resolve(directory, entry.name);
      if (this.host.isIgnoredRoot(child)) continue;
      if (!entry.isDirectory()) {
        if (collectDiscoveredFiles) childFiles.push(child);
        continue;
      }
      if (directories.size + childDirectories.length + 1 > MAX_WATCHED_DIRECTORIES) {
        this.host.metrics.directoryLimitFailureCount += 1;
        throw new Error(
          `Recursive file observation exceeded ${MAX_WATCHED_DIRECTORIES} directories under ${this.host.root}`,
        );
      }
      childDirectories.push(child);
    }
    if (!(await this.isDirectoryIdentityCurrent(directory, identity, discovered))) {
      return "replaced";
    }
    if (!this.host.isActive()) return "aborted";
    for (const file of childFiles) filesDiscoveredBeforeCoverage.add(file);
    for (const child of childDirectories) {
      directories.add(child);
      pending.push(child);
    }
    return "ok";
  }

  private classify(path: string): void {
    if (this.classificationQueue.length >= MAX_QUEUED_CLASSIFICATIONS) {
      // This backend has no file-level inventory and no full-tree safety
      // audit to fall back on (see the comment on MAX_QUEUED_CLASSIFICATIONS
      // above), so a shed here would silently and permanently lose this
      // create/delete. Fail loudly instead, the same degradation path as
      // MAX_WATCHED_DIRECTORIES overflow.
      this.host.fail(
        new Error(
          `Recursive file observation exceeded ${MAX_QUEUED_CLASSIFICATIONS} queued classifications under ${this.host.root}`,
        ),
      );
      return;
    }
    this.classificationQueue.push({ path });
    this.pumpClassifications();
  }

  private discardIgnoredClassifications(): void {
    let kept = 0;
    for (const classification of this.classificationQueue) {
      if (!this.host.isIgnored(classification.path)) {
        this.classificationQueue[kept++] = classification;
      }
    }
    this.classificationQueue.length = kept;
  }

  private pumpClassifications(): void {
    while (
      this.classifications.size < MAX_CONCURRENT_CLASSIFICATIONS &&
      this.classificationQueue.length > 0
    ) {
      const next = this.classificationQueue.shift();
      if (!next) return;
      this.startClassification(next.path);
    }
  }

  private startClassification(path: string): void {
    this.host.metrics.nativeClassificationCount += 1;
    let classification!: Promise<void>;
    classification = stat(path)
      .then(() => this.host.queueEvent("create", path))
      .catch((error: unknown) => {
        if (isMissingPathError(error)) {
          this.host.queueEvent("delete", path);
          return;
        }
        this.host.fail(toError(error));
      })
      .finally(() => {
        this.classifications.delete(classification);
        if (this.host.isActive()) this.pumpClassifications();
      });
    this.classifications.add(classification);
  }

  private cancelQueued(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pendingScopes.clear();
  }
}
