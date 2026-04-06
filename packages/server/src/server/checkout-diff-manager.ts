import { watch, type FSWatcher } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { exec } from "child_process";
import { promisify } from "util";
import type pino from "pino";
import type { SubscribeCheckoutDiffRequest, SessionOutboundMessage } from "./messages.js";
import { getCheckoutDiff } from "../utils/checkout-git.js";
import { expandTilde } from "../utils/path.js";
import { READ_ONLY_GIT_ENV, resolveCheckoutGitDir, toCheckoutError } from "./checkout-git-utils.js";

const execAsync = promisify(exec);

const CHECKOUT_DIFF_WATCH_DEBOUNCE_MS = 150;
const CHECKOUT_DIFF_FALLBACK_REFRESH_MS = 5_000;

export type CheckoutDiffCompareInput = SubscribeCheckoutDiffRequest["compare"];

export type CheckoutDiffSnapshotPayload = Omit<
  Extract<SessionOutboundMessage, { type: "checkout_diff_update" }>["payload"],
  "subscriptionId"
>;

export type CheckoutDiffMetrics = {
  checkoutDiffTargetCount: number;
  checkoutDiffSubscriptionCount: number;
  checkoutDiffWatcherCount: number;
  checkoutDiffFallbackRefreshTargetCount: number;
};

type CheckoutDiffWatchTarget = {
  key: string;
  cwd: string;
  diffCwd: string;
  compare: CheckoutDiffCompareInput;
  listeners: Set<(snapshot: CheckoutDiffSnapshotPayload) => void>;
  watchers: FSWatcher[];
  fallbackRefreshInterval: NodeJS.Timeout | null;
  debounceTimer: NodeJS.Timeout | null;
  refreshPromise: Promise<void> | null;
  refreshQueued: boolean;
  latestPayload: CheckoutDiffSnapshotPayload | null;
  latestFingerprint: string | null;
  watchedPaths: Set<string>;
  repoWatchPath: string | null;
  linuxTreeRefreshPromise: Promise<void> | null;
  linuxTreeRefreshQueued: boolean;
};

export class CheckoutDiffManager {
  private readonly logger: pino.Logger;
  private readonly paseoHome: string;
  private readonly targets = new Map<string, CheckoutDiffWatchTarget>();

  constructor(options: { logger: pino.Logger; paseoHome: string }) {
    this.logger = options.logger.child({ module: "checkout-diff-manager" });
    this.paseoHome = options.paseoHome;
  }

  async subscribe(
    params: {
      cwd: string;
      compare: CheckoutDiffCompareInput;
    },
    listener: (snapshot: CheckoutDiffSnapshotPayload) => void,
  ): Promise<{ initial: CheckoutDiffSnapshotPayload; unsubscribe: () => void }> {
    const cwd = params.cwd;
    const compare = this.normalizeCompare(params.compare);
    const target = await this.ensureTarget(cwd, compare);
    target.listeners.add(listener);

    const initial =
      target.latestPayload ??
      (await this.computeCheckoutDiffSnapshot(target.cwd, target.compare, {
        diffCwd: target.diffCwd,
      }));
    target.latestPayload = initial;
    target.latestFingerprint = JSON.stringify(initial);
    return {
      initial,
      unsubscribe: () => {
        this.removeListener(target.key, listener);
      },
    };
  }

  scheduleRefreshForCwd(cwd: string): void {
    const resolvedCwd = expandTilde(cwd);
    for (const target of this.targets.values()) {
      if (target.cwd !== resolvedCwd && target.diffCwd !== resolvedCwd) {
        continue;
      }
      this.scheduleTargetRefresh(target);
    }
  }

  getMetrics(): CheckoutDiffMetrics {
    let checkoutDiffSubscriptionCount = 0;
    let checkoutDiffWatcherCount = 0;
    let checkoutDiffFallbackRefreshTargetCount = 0;

    for (const target of this.targets.values()) {
      checkoutDiffSubscriptionCount += target.listeners.size;
      checkoutDiffWatcherCount += target.watchers.length;
      if (target.fallbackRefreshInterval) {
        checkoutDiffFallbackRefreshTargetCount += 1;
      }
    }

    return {
      checkoutDiffTargetCount: this.targets.size,
      checkoutDiffSubscriptionCount,
      checkoutDiffWatcherCount,
      checkoutDiffFallbackRefreshTargetCount,
    };
  }

  dispose(): void {
    for (const target of this.targets.values()) {
      this.closeTarget(target);
    }
    this.targets.clear();
  }

  private normalizeCompare(compare: CheckoutDiffCompareInput): CheckoutDiffCompareInput {
    const ignoreWhitespace = compare.ignoreWhitespace === true;
    if (compare.mode === "uncommitted") {
      return { mode: "uncommitted", ignoreWhitespace };
    }
    const trimmedBaseRef = compare.baseRef?.trim();
    return trimmedBaseRef
      ? { mode: "base", baseRef: trimmedBaseRef, ignoreWhitespace }
      : { mode: "base", ignoreWhitespace };
  }

  private buildTargetKey(cwd: string, compare: CheckoutDiffCompareInput): string {
    return JSON.stringify([
      cwd,
      compare.mode,
      compare.mode === "base" ? (compare.baseRef ?? "") : "",
      compare.ignoreWhitespace === true,
    ]);
  }

  private closeTarget(target: CheckoutDiffWatchTarget): void {
    if (target.debounceTimer) {
      clearTimeout(target.debounceTimer);
      target.debounceTimer = null;
    }
    if (target.fallbackRefreshInterval) {
      clearInterval(target.fallbackRefreshInterval);
      target.fallbackRefreshInterval = null;
    }
    for (const watcher of target.watchers) {
      watcher.close();
    }
    target.watchers = [];
    target.watchedPaths.clear();
    target.listeners.clear();
  }

  private removeListener(
    targetKey: string,
    listener: (snapshot: CheckoutDiffSnapshotPayload) => void,
  ): void {
    const target = this.targets.get(targetKey);
    if (!target) {
      return;
    }
    target.listeners.delete(listener);
    if (target.listeners.size > 0) {
      return;
    }
    this.closeTarget(target);
    this.targets.delete(targetKey);
  }

  private async resolveCheckoutWatchRoot(cwd: string): Promise<string | null> {
    try {
      const { stdout } = await execAsync("git rev-parse --path-format=absolute --show-toplevel", {
        cwd,
        env: READ_ONLY_GIT_ENV,
      });
      const root = stdout.trim();
      return root.length > 0 ? root : null;
    } catch {
      return null;
    }
  }

  private scheduleTargetRefresh(target: CheckoutDiffWatchTarget): void {
    if (target.debounceTimer) {
      clearTimeout(target.debounceTimer);
    }
    target.debounceTimer = setTimeout(() => {
      target.debounceTimer = null;
      void this.refreshTarget(target);
    }, CHECKOUT_DIFF_WATCH_DEBOUNCE_MS);
  }

  private async computeCheckoutDiffSnapshot(
    cwd: string,
    compare: CheckoutDiffCompareInput,
    options?: { diffCwd?: string },
  ): Promise<CheckoutDiffSnapshotPayload> {
    const diffCwd = options?.diffCwd ?? cwd;
    try {
      const diffResult = await getCheckoutDiff(
        diffCwd,
        {
          mode: compare.mode,
          baseRef: compare.baseRef,
          ignoreWhitespace: compare.ignoreWhitespace,
          includeStructured: true,
        },
        { paseoHome: this.paseoHome },
      );
      const files = [...(diffResult.structured ?? [])];
      files.sort((a, b) => {
        if (a.path === b.path) return 0;
        return a.path < b.path ? -1 : 1;
      });
      return {
        cwd,
        files,
        error: null,
      };
    } catch (error) {
      return {
        cwd,
        files: [],
        error: toCheckoutError(error),
      };
    }
  }

  private async refreshTarget(target: CheckoutDiffWatchTarget): Promise<void> {
    if (target.refreshPromise) {
      target.refreshQueued = true;
      return;
    }

    target.refreshPromise = (async () => {
      do {
        target.refreshQueued = false;
        const snapshot = await this.computeCheckoutDiffSnapshot(target.cwd, target.compare, {
          diffCwd: target.diffCwd,
        });
        target.latestPayload = snapshot;
        const fingerprint = JSON.stringify(snapshot);
        if (fingerprint !== target.latestFingerprint) {
          target.latestFingerprint = fingerprint;
          for (const listener of target.listeners) {
            listener(snapshot);
          }
        }
      } while (target.refreshQueued);
    })();

    try {
      await target.refreshPromise;
    } finally {
      target.refreshPromise = null;
    }
  }

  private async ensureTarget(
    cwd: string,
    compare: CheckoutDiffCompareInput,
  ): Promise<CheckoutDiffWatchTarget> {
    const targetKey = this.buildTargetKey(cwd, compare);
    const existing = this.targets.get(targetKey);
    if (existing) {
      return existing;
    }

    const watchRoot = await this.resolveCheckoutWatchRoot(cwd);
    const target: CheckoutDiffWatchTarget = {
      key: targetKey,
      cwd,
      diffCwd: watchRoot ?? cwd,
      compare,
      listeners: new Set(),
      watchers: [],
      fallbackRefreshInterval: null,
      debounceTimer: null,
      refreshPromise: null,
      refreshQueued: false,
      latestPayload: null,
      latestFingerprint: null,
      watchedPaths: new Set<string>(),
      repoWatchPath: null,
      linuxTreeRefreshPromise: null,
      linuxTreeRefreshQueued: false,
    };

    const repoWatchPath = watchRoot ?? cwd;
    target.repoWatchPath = repoWatchPath;
    const watchPaths = new Set<string>([repoWatchPath]);
    const gitDir = await resolveCheckoutGitDir(cwd);
    if (gitDir) {
      watchPaths.add(gitDir);
    }

    let hasRecursiveRepoCoverage = false;
    const allowRecursiveRepoWatch = process.platform !== "linux";
    if (process.platform === "linux") {
      hasRecursiveRepoCoverage = await this.ensureLinuxRepoTreeWatchers(target, repoWatchPath);
    }
    for (const watchPath of watchPaths) {
      if (process.platform === "linux" && watchPath === repoWatchPath) {
        continue;
      }
      const shouldTryRecursive = watchPath === repoWatchPath && allowRecursiveRepoWatch;
      const watcherIsRecursive = this.addWatcher(target, watchPath, shouldTryRecursive);
      if (watchPath === repoWatchPath && watcherIsRecursive) {
        hasRecursiveRepoCoverage = true;
      }
    }

    const missingRepoCoverage = !hasRecursiveRepoCoverage;
    if (target.watchers.length === 0 || missingRepoCoverage) {
      target.fallbackRefreshInterval = setInterval(() => {
        this.scheduleTargetRefresh(target);
      }, CHECKOUT_DIFF_FALLBACK_REFRESH_MS);
      this.logger.warn(
        {
          cwd,
          compare,
          intervalMs: CHECKOUT_DIFF_FALLBACK_REFRESH_MS,
          reason:
            target.watchers.length === 0 ? "no_watchers" : "missing_recursive_repo_root_coverage",
        },
        "Checkout diff watchers unavailable; using timed refresh fallback",
      );
    }

    this.targets.set(targetKey, target);
    return target;
  }

  private addWatcher(
    target: CheckoutDiffWatchTarget,
    watchPath: string,
    shouldTryRecursive: boolean,
  ): boolean {
    if (target.watchedPaths.has(watchPath)) {
      return false;
    }

    const { cwd, compare } = target;
    const onChange = () => {
      if (process.platform === "linux" && target.repoWatchPath) {
        void this.refreshLinuxRepoTreeWatchers(target);
      }
      this.scheduleTargetRefresh(target);
    };
    const createWatcher = (recursive: boolean): FSWatcher =>
      watch(watchPath, { recursive }, () => {
        onChange();
      });

    let watcher: FSWatcher | null = null;
    let watcherIsRecursive = false;
    try {
      if (shouldTryRecursive) {
        watcher = createWatcher(true);
        watcherIsRecursive = true;
      } else {
        watcher = createWatcher(false);
      }
    } catch (error) {
      if (shouldTryRecursive) {
        try {
          watcher = createWatcher(false);
          this.logger.warn(
            { err: error, watchPath, cwd, compare },
            "Checkout diff recursive watch unavailable; using non-recursive fallback",
          );
        } catch (fallbackError) {
          this.logger.warn(
            { err: fallbackError, watchPath, cwd, compare },
            "Failed to start checkout diff watcher",
          );
        }
      } else {
        this.logger.warn(
          { err: error, watchPath, cwd, compare },
          "Failed to start checkout diff watcher",
        );
      }
    }

    if (!watcher) {
      return false;
    }

    watcher.on("error", (error) => {
      this.logger.warn({ err: error, watchPath, cwd, compare }, "Checkout diff watcher error");
    });
    target.watchers.push(watcher);
    target.watchedPaths.add(watchPath);
    return watcherIsRecursive;
  }

  private async ensureLinuxRepoTreeWatchers(
    target: CheckoutDiffWatchTarget,
    rootPath: string,
  ): Promise<boolean> {
    const directories = await this.listLinuxWatchDirectories(rootPath);
    let complete = true;
    for (const directory of directories) {
      const watcherWasRecursive = this.addWatcher(target, directory, false);
      if (!watcherWasRecursive && !target.watchedPaths.has(directory)) {
        complete = false;
      }
    }
    return complete && target.watchedPaths.has(rootPath);
  }

  private async refreshLinuxRepoTreeWatchers(target: CheckoutDiffWatchTarget): Promise<void> {
    if (process.platform !== "linux" || !target.repoWatchPath) {
      return;
    }
    const rootPath = target.repoWatchPath;
    if (target.linuxTreeRefreshPromise) {
      target.linuxTreeRefreshQueued = true;
      return;
    }

    target.linuxTreeRefreshPromise = (async () => {
      do {
        target.linuxTreeRefreshQueued = false;
        try {
          await this.ensureLinuxRepoTreeWatchers(target, rootPath);
        } catch (error) {
          this.logger.warn(
            {
              err: error,
              cwd: target.cwd,
              compare: target.compare,
              rootPath,
            },
            "Failed to refresh Linux checkout diff tree watchers",
          );
        }
      } while (target.linuxTreeRefreshQueued);
    })();

    try {
      await target.linuxTreeRefreshPromise;
    } finally {
      target.linuxTreeRefreshPromise = null;
    }
  }

  private async listLinuxWatchDirectories(rootPath: string): Promise<string[]> {
    const directories: string[] = [];
    const pending = [rootPath];

    while (pending.length > 0) {
      const directory = pending.pop();
      if (!directory) {
        continue;
      }
      directories.push(directory);

      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === ".git") {
          continue;
        }
        pending.push(join(directory, entry.name));
      }
    }

    return directories;
  }
}
