import { type Dirent, type FSWatcher, watch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { BackendDiagnostics, ObservationBackend, ObservationHost } from "./contracts.js";
import type { ObserverPaths } from "./paths.js";
import { isMissingPathError, toError } from "./paths.js";

const MAX_WATCHED_DIRECTORIES = 5_000;
const RECONCILIATION_DELAY_MS = 50;

interface DirectorySnapshot {
  directories: Set<string>;
  filesDiscoveredBeforeCoverage: Set<string>;
}

export function createLinuxBackend(
  host: ObservationHost,
  paths: ObserverPaths,
): ObservationBackend {
  return new LinuxBackend(host, paths);
}

class LinuxBackend implements ObservationBackend {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly classifications = new Set<Promise<void>>();
  private readonly pendingScopes = new Set<string>();
  private reconcileTail: Promise<void> = Promise.resolve();
  private queueDepth = 0;
  private inFlight = false;
  private timer: NodeJS.Timeout | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly host: ObservationHost,
    private readonly paths: ObserverPaths,
  ) {}

  async start(): Promise<void> {
    this.watchDirectory(this.host.root);
    await this.enqueue([this.host.root]);
  }

  async updateIgnore(): Promise<void> {
    for (const [directory, watcher] of this.watchers) {
      if (directory !== this.host.root && this.host.isIgnored(directory)) {
        watcher.close();
        this.watchers.delete(directory);
      }
    }
    this.cancelQueued();
    await this.enqueue([this.host.root]);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.cancelQueued();
    for (const watcher of this.watchers.values()) watcher.close();
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
        this.queueDepth +
        Number(this.timer !== null),
      reconciliationInFlight: this.inFlight,
    };
  }

  private async finishClose(): Promise<void> {
    await this.reconcileTail;
    await Promise.allSettled(this.classifications);
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }

  private watchDirectory(directory: string): void {
    if (!this.host.isActive() || this.watchers.has(directory) || this.host.isIgnored(directory)) {
      return;
    }
    if (this.watchers.size >= MAX_WATCHED_DIRECTORIES) {
      this.host.metrics.directoryLimitFailureCount += 1;
      throw new Error(
        `Recursive file observation exceeded ${MAX_WATCHED_DIRECTORIES} directories under ${this.host.root}`,
      );
    }
    const watcher = watch(directory, (eventType, filename) => {
      if (!this.host.isActive()) return;
      const path = filename ? resolve(directory, filename.toString()) : directory;
      if (!this.host.isIgnored(path)) {
        if (eventType === "change") this.host.queueEvent("update", path);
        else this.classify(path);
      }
      if (eventType === "rename" || !filename) this.requestReconcile(path);
    });
    this.attachWatcher(directory, watcher);
  }

  private attachWatcher(directory: string, watcher: FSWatcher): void {
    watcher.on("error", (error) => {
      if (!this.host.isActive()) return;
      if (this.paths.isExpectedWatchDisappearance(error)) {
        watcher.close();
        if (this.watchers.get(directory) === watcher) this.watchers.delete(directory);
        if (directory === this.host.root) {
          this.host.fail(toError(error));
          return;
        }
        this.requestReconcile(directory);
        return;
      }
      this.host.fail(toError(error));
    });
    this.watchers.set(directory, watcher);
  }

  private requestReconcile(scope: string): void {
    if (!this.host.isActive()) return;
    this.pendingScopes.add(scope);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const scopes = [...this.pendingScopes];
      this.pendingScopes.clear();
      void this.enqueue(scopes).catch((error: unknown) => this.host.fail(toError(error)));
    }, RECONCILIATION_DELAY_MS);
    this.timer.unref();
  }

  private enqueue(scopes: string[]): Promise<void> {
    this.queueDepth += 1;
    const result = this.reconcileTail
      .then(() => this.run(scopes))
      .finally(() => {
        this.queueDepth -= 1;
      });
    this.reconcileTail = result.catch(() => undefined);
    return result;
  }

  private async run(scopes: string[]): Promise<void> {
    if (!this.host.isActive()) return;
    this.inFlight = true;
    const startedAt = performance.now();
    try {
      await this.reconcile(this.paths.collapse(scopes));
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

  private async reconcile(scopes: string[]): Promise<void> {
    for (const scope of scopes) {
      const snapshot = await this.scan(scope);
      if (!this.host.isActive()) return;
      for (const directory of snapshot.directories) {
        if (!this.watchSnapshotDirectory(directory)) snapshot.directories.delete(directory);
      }
      for (const path of snapshot.filesDiscoveredBeforeCoverage) {
        this.host.queueEvent("create", path);
      }
      for (const [directory, watcher] of this.watchers) {
        const disappeared =
          directory !== this.host.root &&
          this.host.isPathInside(scope, directory) &&
          !snapshot.directories.has(directory);
        if (!disappeared) continue;
        watcher.close();
        this.watchers.delete(directory);
        this.host.queueEvent("delete", directory);
      }
    }
  }

  private watchSnapshotDirectory(directory: string): boolean {
    try {
      this.watchDirectory(directory);
      return true;
    } catch (error) {
      if (!this.paths.isExpectedWatchDisappearance(error) || directory === this.host.root) {
        throw error;
      }
      return false;
    }
  }

  private async scan(scope: string): Promise<DirectorySnapshot> {
    let scopeStats;
    try {
      scopeStats = await stat(scope);
    } catch (error) {
      if (!isMissingPathError(error) || scope === this.host.root) throw error;
      return { directories: new Set(), filesDiscoveredBeforeCoverage: new Set() };
    }
    if (!scopeStats.isDirectory()) {
      return { directories: new Set(), filesDiscoveredBeforeCoverage: new Set() };
    }
    const directories = new Set<string>([scope]);
    const filesDiscoveredBeforeCoverage = new Set<string>();
    const pending = [scope];
    while (pending.length > 0 && this.host.isActive()) {
      const directory = pending.pop();
      if (!directory) continue;
      let entries: Dirent[];
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
        if (directory === this.host.root && this.host.isActive()) throw error;
        continue;
      }
      for (const entry of entries) {
        const child = resolve(directory, entry.name);
        if (this.host.isIgnored(child)) continue;
        if (!entry.isDirectory()) {
          if (!this.watchers.has(directory)) filesDiscoveredBeforeCoverage.add(child);
          continue;
        }
        directories.add(child);
        if (directories.size > MAX_WATCHED_DIRECTORIES) {
          this.host.metrics.directoryLimitFailureCount += 1;
          throw new Error(
            `Recursive file observation exceeded ${MAX_WATCHED_DIRECTORIES} directories under ${this.host.root}`,
          );
        }
        pending.push(child);
      }
    }
    return { directories, filesDiscoveredBeforeCoverage };
  }

  private classify(path: string): void {
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
      .finally(() => this.classifications.delete(classification));
    this.classifications.add(classification);
  }

  private cancelQueued(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pendingScopes.clear();
  }
}
