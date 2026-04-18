import { watch, type FSWatcher } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type pino from "pino";
import type { CheckoutContext } from "../utils/checkout-git.js";
import {
  getCheckoutShortstat,
  getCheckoutStatus,
  getPullRequestStatus,
  hasOriginRemote,
  resolveAbsoluteGitDir,
} from "../utils/checkout-git.js";
import { createGitHubService, type GitHubService } from "../services/github-service.js";
import { parseGitRevParsePath } from "../utils/git-rev-parse-path.js";
import { runGitCommand } from "../utils/run-git-command.js";
import { READ_ONLY_GIT_ENV } from "./checkout-git-utils.js";
import { normalizeWorkspaceId } from "./workspace-registry-model.js";

const WORKSPACE_GIT_WATCH_DEBOUNCE_MS = 500;
const BACKGROUND_GIT_FETCH_INTERVAL_MS = 180_000;
const WORKING_TREE_WATCH_FALLBACK_REFRESH_MS = 5_000;

export type WorkspaceGitRuntimeSnapshot = {
  cwd: string;
  git: {
    isGit: boolean;
    repoRoot: string | null;
    mainRepoRoot: string | null;
    currentBranch: string | null;
    remoteUrl: string | null;
    isPaseoOwnedWorktree: boolean;
    isDirty: boolean | null;
    aheadBehind: { ahead: number; behind: number } | null;
    aheadOfOrigin: number | null;
    behindOfOrigin: number | null;
    diffStat: { additions: number; deletions: number } | null;
  };
  github: {
    featuresEnabled: boolean;
    pullRequest: {
      url: string;
      title: string;
      state: string;
      baseRefName: string;
      headRefName: string;
      isMerged: boolean;
    } | null;
    error: { message: string } | null;
    refreshedAt: string | null;
  };
};

export interface WorkspaceGitService {
  subscribe(
    params: { cwd: string },
    listener: WorkspaceGitListener,
  ): Promise<{
    initial: WorkspaceGitRuntimeSnapshot;
    unsubscribe: () => void;
  }>;

  peekSnapshot(cwd: string): WorkspaceGitRuntimeSnapshot | null;
  getSnapshot(cwd: string): Promise<WorkspaceGitRuntimeSnapshot>;
  refresh(cwd: string, options?: { priority?: "normal" | "high" }): Promise<void>;
  requestWorkingTreeWatch(
    cwd: string,
    onChange: () => void,
  ): Promise<{ repoRoot: string | null; unsubscribe: () => void }>;
  scheduleRefreshForCwd(cwd: string): void;
  dispose(): void;
}

export type WorkspaceGitListener = (snapshot: WorkspaceGitRuntimeSnapshot) => void;

interface WorkspaceGitServiceDependencies {
  watch: typeof watch;
  readdir: typeof readdir;
  getCheckoutStatus: typeof getCheckoutStatus;
  getCheckoutShortstat: typeof getCheckoutShortstat;
  getPullRequestStatus: typeof getPullRequestStatus;
  github: GitHubService;
  resolveAbsoluteGitDir: (cwd: string) => Promise<string | null>;
  hasOriginRemote: (cwd: string) => Promise<boolean>;
  runGitFetch: (cwd: string) => Promise<void>;
  runGitCommand: typeof runGitCommand;
  now: () => Date;
}

interface WorkspaceGitServiceOptions {
  logger: pino.Logger;
  paseoHome: string;
  deps?: Partial<WorkspaceGitServiceDependencies>;
}

interface WorkspaceGitTarget {
  cwd: string;
  listeners: Set<WorkspaceGitListener>;
  watchers: FSWatcher[];
  debounceTimer: NodeJS.Timeout | null;
  refreshPromise: Promise<void> | null;
  refreshQueued: boolean;
  latestSnapshot: WorkspaceGitRuntimeSnapshot | null;
  latestFingerprint: string | null;
  repoGitRoot: string | null;
}

interface RepoGitTarget {
  repoGitRoot: string;
  cwd: string;
  workspaceKeys: Set<string>;
  intervalId: NodeJS.Timeout | null;
  fetchInFlight: boolean;
}

interface WorkingTreeWatchTarget {
  cwd: string;
  repoRoot: string | null;
  repoWatchPath: string | null;
  watchers: FSWatcher[];
  watchedPaths: Set<string>;
  fallbackRefreshInterval: NodeJS.Timeout | null;
  linuxTreeRefreshPromise: Promise<void> | null;
  linuxTreeRefreshQueued: boolean;
  listeners: Set<() => void>;
}

export class WorkspaceGitServiceImpl implements WorkspaceGitService {
  private readonly logger: pino.Logger;
  private readonly paseoHome: string;
  private readonly deps: WorkspaceGitServiceDependencies;
  private readonly workspaceTargets = new Map<string, WorkspaceGitTarget>();
  private readonly repoTargets = new Map<string, RepoGitTarget>();
  private readonly workspaceTargetSetups = new Map<string, Promise<WorkspaceGitTarget>>();
  private readonly workingTreeWatchTargets = new Map<string, WorkingTreeWatchTarget>();
  private readonly workingTreeWatchSetups = new Map<string, Promise<WorkingTreeWatchTarget>>();

  constructor(options: WorkspaceGitServiceOptions) {
    this.logger = options.logger.child({ module: "workspace-git-service" });
    this.paseoHome = options.paseoHome;
    this.deps = {
      watch: options.deps?.watch ?? watch,
      readdir: options.deps?.readdir ?? readdir,
      getCheckoutStatus: options.deps?.getCheckoutStatus ?? getCheckoutStatus,
      getCheckoutShortstat: options.deps?.getCheckoutShortstat ?? getCheckoutShortstat,
      getPullRequestStatus: options.deps?.getPullRequestStatus ?? getPullRequestStatus,
      github: options.deps?.github ?? createGitHubService(),
      resolveAbsoluteGitDir: options.deps?.resolveAbsoluteGitDir ?? resolveAbsoluteGitDir,
      hasOriginRemote: options.deps?.hasOriginRemote ?? hasOriginRemote,
      runGitFetch: options.deps?.runGitFetch ?? runGitFetch,
      runGitCommand: options.deps?.runGitCommand ?? runGitCommand,
      now: options.deps?.now ?? (() => new Date()),
    };
  }

  async subscribe(
    params: { cwd: string },
    listener: WorkspaceGitListener,
  ): Promise<{
    initial: WorkspaceGitRuntimeSnapshot;
    unsubscribe: () => void;
  }> {
    const cwd = normalizeWorkspaceId(params.cwd);
    const target = await this.ensureWorkspaceTarget(cwd);
    target.listeners.add(listener);

    return {
      initial: target.latestSnapshot ?? (await this.getSnapshot(cwd)),
      unsubscribe: () => {
        this.removeWorkspaceListener(cwd, listener);
      },
    };
  }

  async getSnapshot(cwd: string): Promise<WorkspaceGitRuntimeSnapshot> {
    cwd = normalizeWorkspaceId(cwd);
    const target = this.workspaceTargets.get(cwd);
    if (target?.latestSnapshot) {
      return target.latestSnapshot;
    }

    const ensuredTarget = await this.ensureWorkspaceTarget(cwd);
    return ensuredTarget.latestSnapshot ?? (await this.refreshSnapshot(cwd));
  }

  peekSnapshot(cwd: string): WorkspaceGitRuntimeSnapshot | null {
    cwd = normalizeWorkspaceId(cwd);
    return this.workspaceTargets.get(cwd)?.latestSnapshot ?? null;
  }

  async refresh(cwd: string, _options?: { priority?: "normal" | "high" }): Promise<void> {
    cwd = normalizeWorkspaceId(cwd);
    const target = this.workspaceTargets.get(cwd);
    if (target) {
      await this.refreshWorkspaceTarget(target);
      return;
    }

    await this.ensureWorkspaceTarget(cwd);
  }

  async requestWorkingTreeWatch(
    cwd: string,
    onChange: () => void,
  ): Promise<{ repoRoot: string | null; unsubscribe: () => void }> {
    cwd = normalizeWorkspaceId(cwd);
    const target = await this.ensureWorkingTreeWatchTarget(cwd);
    target.listeners.add(onChange);

    return {
      repoRoot: target.repoRoot,
      unsubscribe: () => {
        this.removeWorkingTreeWatchListener(cwd, onChange);
      },
    };
  }

  scheduleRefreshForCwd(cwd: string): void {
    cwd = normalizeWorkspaceId(cwd);
    const target = this.workspaceTargets.get(cwd);
    if (target) {
      this.scheduleWorkspaceRefresh(target);
    }
  }

  dispose(): void {
    for (const target of this.workspaceTargets.values()) {
      this.closeWorkspaceTarget(target);
    }
    this.workspaceTargets.clear();
    this.workspaceTargetSetups.clear();

    for (const target of this.repoTargets.values()) {
      this.closeRepoTarget(target);
    }
    this.repoTargets.clear();

    for (const target of this.workingTreeWatchTargets.values()) {
      this.closeWorkingTreeWatchTarget(target);
    }
    this.workingTreeWatchTargets.clear();
    this.workingTreeWatchSetups.clear();
  }

  private async ensureWorkspaceTarget(cwd: string): Promise<WorkspaceGitTarget> {
    const existingTarget = this.workspaceTargets.get(cwd);
    if (existingTarget) {
      return existingTarget;
    }

    const existingSetup = this.workspaceTargetSetups.get(cwd);
    if (existingSetup) {
      return existingSetup;
    }

    const setup = this.createWorkspaceTarget(cwd).finally(() => {
      this.workspaceTargetSetups.delete(cwd);
    });
    this.workspaceTargetSetups.set(cwd, setup);
    return setup;
  }

  private async ensureWorkingTreeWatchTarget(cwd: string): Promise<WorkingTreeWatchTarget> {
    const existingTarget = this.workingTreeWatchTargets.get(cwd);
    if (existingTarget) {
      return existingTarget;
    }

    const existingSetup = this.workingTreeWatchSetups.get(cwd);
    if (existingSetup) {
      return existingSetup;
    }

    const setup = this.createWorkingTreeWatchTarget(cwd).finally(() => {
      this.workingTreeWatchSetups.delete(cwd);
    });
    this.workingTreeWatchSetups.set(cwd, setup);
    return setup;
  }

  private async createWorkspaceTarget(cwd: string): Promise<WorkspaceGitTarget> {
    const target: WorkspaceGitTarget = {
      cwd,
      listeners: new Set(),
      watchers: [],
      debounceTimer: null,
      refreshPromise: null,
      refreshQueued: false,
      latestSnapshot: null,
      latestFingerprint: null,
      repoGitRoot: null,
    };

    const initial = await this.refreshSnapshot(cwd);
    this.rememberSnapshot(target, initial);
    this.workspaceTargets.set(cwd, target);

    const gitDir = await this.deps.resolveAbsoluteGitDir(cwd);
    if (!gitDir) {
      return target;
    }

    const repoGitRoot = await this.resolveWorkspaceGitRefsRoot(gitDir);
    target.repoGitRoot = repoGitRoot;
    this.startWorkspaceWatchers(target, gitDir, repoGitRoot);
    await this.ensureRepoTarget(target);
    return target;
  }

  private async createWorkingTreeWatchTarget(cwd: string): Promise<WorkingTreeWatchTarget> {
    const repoRoot = await this.resolveCheckoutWatchRoot(cwd);
    const target: WorkingTreeWatchTarget = {
      cwd,
      repoRoot,
      repoWatchPath: null,
      watchers: [],
      watchedPaths: new Set<string>(),
      fallbackRefreshInterval: null,
      linuxTreeRefreshPromise: null,
      linuxTreeRefreshQueued: false,
      listeners: new Set(),
    };

    const repoWatchPath = repoRoot ?? cwd;
    target.repoWatchPath = repoWatchPath;
    const watchPaths = new Set<string>([repoWatchPath]);
    const gitDir = await this.deps.resolveAbsoluteGitDir(cwd);
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
      const watcherIsRecursive = this.addWorkingTreeWatcher(target, watchPath, shouldTryRecursive);
      if (watchPath === repoWatchPath && watcherIsRecursive) {
        hasRecursiveRepoCoverage = true;
      }
    }

    const missingRepoCoverage = repoRoot === null || !hasRecursiveRepoCoverage;
    if (target.watchers.length === 0 || missingRepoCoverage) {
      target.fallbackRefreshInterval = setInterval(() => {
        this.scheduleWorkspaceRefresh(cwd);
        for (const listener of target.listeners) {
          listener();
        }
      }, WORKING_TREE_WATCH_FALLBACK_REFRESH_MS);
      this.logger.warn(
        {
          cwd,
          intervalMs: WORKING_TREE_WATCH_FALLBACK_REFRESH_MS,
          reason:
            target.watchers.length === 0 ? "no_watchers" : "missing_recursive_repo_root_coverage",
        },
        "Working tree watchers unavailable; using timed refresh fallback",
      );
    }

    this.workingTreeWatchTargets.set(cwd, target);
    return target;
  }

  private async resolveCheckoutWatchRoot(cwd: string): Promise<string | null> {
    try {
      const { stdout } = await this.deps.runGitCommand(["rev-parse", "--show-toplevel"], {
        cwd,
        env: READ_ONLY_GIT_ENV,
      });
      return parseGitRevParsePath(stdout);
    } catch {
      return null;
    }
  }

  private async resolveWorkspaceGitRefsRoot(gitDir: string): Promise<string> {
    try {
      const commonDir = (await readFile(join(gitDir, "commondir"), "utf8")).trim();
      if (commonDir.length > 0) {
        return resolve(gitDir, commonDir);
      }
    } catch {
      return gitDir;
    }

    return gitDir;
  }

  private startWorkspaceWatchers(
    target: WorkspaceGitTarget,
    gitDir: string,
    repoGitRoot: string,
  ): void {
    for (const watchPath of new Set([join(gitDir, "HEAD"), join(repoGitRoot, "refs", "heads")])) {
      let watcher: FSWatcher | null = null;
      try {
        watcher = this.deps.watch(watchPath, { recursive: false }, () => {
          this.scheduleWorkspaceRefresh(target);
        });
      } catch (error) {
        this.logger.warn(
          { err: error, cwd: target.cwd, watchPath },
          "Failed to start workspace git watcher",
        );
      }

      if (!watcher) {
        continue;
      }

      watcher.on("error", (error) => {
        this.logger.warn({ err: error, cwd: target.cwd, watchPath }, "Workspace git watcher error");
      });
      target.watchers.push(watcher);
    }
  }

  private async ensureRepoTarget(workspaceTarget: WorkspaceGitTarget): Promise<void> {
    const repoGitRoot = workspaceTarget.repoGitRoot;
    if (!repoGitRoot) {
      return;
    }

    const existingTarget = this.repoTargets.get(repoGitRoot);
    if (existingTarget) {
      existingTarget.workspaceKeys.add(workspaceTarget.cwd);
      return;
    }

    const hasOrigin = await this.deps.hasOriginRemote(workspaceTarget.cwd);
    if (!hasOrigin) {
      return;
    }

    const targetAfterProbe = this.repoTargets.get(repoGitRoot);
    if (targetAfterProbe) {
      targetAfterProbe.workspaceKeys.add(workspaceTarget.cwd);
      return;
    }

    const repoTarget: RepoGitTarget = {
      repoGitRoot,
      cwd: workspaceTarget.cwd,
      workspaceKeys: new Set([workspaceTarget.cwd]),
      intervalId: setInterval(() => {
        void this.runRepoFetch(repoTarget);
      }, BACKGROUND_GIT_FETCH_INTERVAL_MS),
      fetchInFlight: false,
    };
    this.repoTargets.set(repoGitRoot, repoTarget);
    void this.runRepoFetch(repoTarget);
  }

  private scheduleWorkspaceRefresh(targetOrCwd: WorkspaceGitTarget | string): void {
    const target =
      typeof targetOrCwd === "string"
        ? this.workspaceTargets.get(normalizeWorkspaceId(targetOrCwd))
        : targetOrCwd;
    if (!target) {
      return;
    }

    if (target.debounceTimer) {
      clearTimeout(target.debounceTimer);
    }

    target.debounceTimer = setTimeout(() => {
      target.debounceTimer = null;
      void this.refreshWorkspaceTarget(target);
    }, WORKSPACE_GIT_WATCH_DEBOUNCE_MS);
  }

  private addWorkingTreeWatcher(
    target: WorkingTreeWatchTarget,
    watchPath: string,
    shouldTryRecursive: boolean,
  ): boolean {
    if (target.watchedPaths.has(watchPath)) {
      return false;
    }

    const { cwd } = target;
    const onChange = () => {
      if (process.platform === "linux" && target.repoWatchPath) {
        void this.refreshLinuxRepoTreeWatchers(target);
      }
      this.scheduleWorkspaceRefresh(cwd);
      for (const listener of target.listeners) {
        listener();
      }
    };
    const createWatcher = (recursive: boolean): FSWatcher =>
      this.deps.watch(watchPath, { recursive }, () => {
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
            { err: error, watchPath, cwd },
            "Working tree recursive watch unavailable; using non-recursive fallback",
          );
        } catch (fallbackError) {
          this.logger.warn(
            { err: fallbackError, watchPath, cwd },
            "Failed to start working tree watcher",
          );
        }
      } else {
        this.logger.warn({ err: error, watchPath, cwd }, "Failed to start working tree watcher");
      }
    }

    if (!watcher) {
      return false;
    }

    watcher.on("error", (error) => {
      this.logger.warn({ err: error, watchPath, cwd }, "Working tree watcher error");
    });
    target.watchers.push(watcher);
    target.watchedPaths.add(watchPath);
    return watcherIsRecursive;
  }

  private async ensureLinuxRepoTreeWatchers(
    target: WorkingTreeWatchTarget,
    rootPath: string,
  ): Promise<boolean> {
    const directories = await this.listLinuxWatchDirectories(rootPath);
    let complete = true;
    for (const directory of directories) {
      const watcherWasRecursive = this.addWorkingTreeWatcher(target, directory, false);
      if (!watcherWasRecursive && !target.watchedPaths.has(directory)) {
        complete = false;
      }
    }
    return complete && target.watchedPaths.has(rootPath);
  }

  private async refreshLinuxRepoTreeWatchers(target: WorkingTreeWatchTarget): Promise<void> {
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
              rootPath,
            },
            "Failed to refresh Linux working tree watchers",
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
        entries = await this.deps.readdir(directory, { withFileTypes: true });
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

  private async refreshWorkspaceTarget(target: WorkspaceGitTarget): Promise<void> {
    if (target.refreshPromise) {
      target.refreshQueued = true;
      return;
    }

    target.refreshPromise = (async () => {
      do {
        target.refreshQueued = false;
        try {
          const snapshot = await this.refreshSnapshot(target.cwd);
          this.rememberSnapshot(target, snapshot, { notify: true });
        } catch (error) {
          this.logger.warn(
            { err: error, cwd: target.cwd },
            "Failed to refresh workspace git snapshot",
          );
        }
      } while (target.refreshQueued);
    })();

    try {
      await target.refreshPromise;
    } finally {
      target.refreshPromise = null;
    }
  }

  private async refreshSnapshot(cwd: string): Promise<WorkspaceGitRuntimeSnapshot> {
    return loadWorkspaceGitRuntimeSnapshot(
      cwd,
      { paseoHome: this.paseoHome },
      this.deps.now(),
      this.deps,
    );
  }

  private rememberSnapshot(
    target: WorkspaceGitTarget,
    snapshot: WorkspaceGitRuntimeSnapshot,
    options?: { notify?: boolean },
  ): void {
    target.latestSnapshot = snapshot;
    const fingerprint = JSON.stringify(snapshot);
    if (target.latestFingerprint === fingerprint) {
      return;
    }
    target.latestFingerprint = fingerprint;
    if (!options?.notify) {
      return;
    }
    for (const listener of target.listeners) {
      listener(snapshot);
    }
  }

  private async runRepoFetch(target: RepoGitTarget): Promise<void> {
    if (target.fetchInFlight) {
      return;
    }

    target.fetchInFlight = true;
    this.logger.debug(
      { repoGitRoot: target.repoGitRoot, cwd: target.cwd },
      "Running background git fetch",
    );

    try {
      await this.deps.runGitFetch(target.cwd);
    } catch (error) {
      this.logger.warn(
        { err: error, repoGitRoot: target.repoGitRoot, cwd: target.cwd },
        "Background git fetch failed",
      );
    } finally {
      target.fetchInFlight = false;
      await Promise.all(
        Array.from(target.workspaceKeys, async (workspaceKey) => {
          const workspaceTarget = this.workspaceTargets.get(workspaceKey);
          if (!workspaceTarget) {
            return;
          }
          await this.refreshWorkspaceTarget(workspaceTarget);
        }),
      );
    }
  }

  private removeWorkspaceListener(cwd: string, listener: WorkspaceGitListener): void {
    const target = this.workspaceTargets.get(cwd);
    if (!target) {
      return;
    }

    target.listeners.delete(listener);
    if (target.listeners.size > 0) {
      return;
    }

    this.removeWorkspaceTarget(target);
  }

  private removeWorkspaceTarget(target: WorkspaceGitTarget): void {
    if (target.repoGitRoot) {
      const repoTarget = this.repoTargets.get(target.repoGitRoot);
      repoTarget?.workspaceKeys.delete(target.cwd);
      if (repoTarget && repoTarget.workspaceKeys.size === 0) {
        this.closeRepoTarget(repoTarget);
        this.repoTargets.delete(target.repoGitRoot);
      }
    }

    this.closeWorkspaceTarget(target);
    this.workspaceTargets.delete(target.cwd);
  }

  private removeWorkingTreeWatchListener(cwd: string, listener: () => void): void {
    const target = this.workingTreeWatchTargets.get(cwd);
    if (!target) {
      return;
    }

    target.listeners.delete(listener);
    if (target.listeners.size > 0) {
      return;
    }

    this.closeWorkingTreeWatchTarget(target);
    this.workingTreeWatchTargets.delete(cwd);
  }

  private closeWorkspaceTarget(target: WorkspaceGitTarget): void {
    if (target.debounceTimer) {
      clearTimeout(target.debounceTimer);
      target.debounceTimer = null;
    }

    for (const watcher of target.watchers) {
      watcher.close();
    }
    target.watchers = [];
    target.listeners.clear();
  }

  private closeWorkingTreeWatchTarget(target: WorkingTreeWatchTarget): void {
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

  private closeRepoTarget(target: RepoGitTarget): void {
    if (target.intervalId) {
      clearInterval(target.intervalId);
      target.intervalId = null;
    }
    target.workspaceKeys.clear();
  }
}

async function loadWorkspaceGitRuntimeSnapshot(
  cwd: string,
  context: CheckoutContext,
  now: Date,
  deps: Pick<
    WorkspaceGitServiceDependencies,
    "getCheckoutStatus" | "getCheckoutShortstat" | "getPullRequestStatus" | "github"
  >,
): Promise<WorkspaceGitRuntimeSnapshot> {
  const checkoutStatus = await deps.getCheckoutStatus(cwd, context);
  if (!checkoutStatus.isGit) {
    return buildNotGitSnapshot(cwd);
  }

  const [diffStat, github] = await Promise.all([
    deps.getCheckoutShortstat(cwd, context),
    loadGitHubSnapshot({
      cwd,
      remoteUrl: checkoutStatus.remoteUrl,
      now,
      deps,
    }),
  ]);

  return {
    cwd,
    git: {
      isGit: true,
      repoRoot: checkoutStatus.repoRoot,
      mainRepoRoot: checkoutStatus.isPaseoOwnedWorktree ? checkoutStatus.mainRepoRoot : null,
      currentBranch: checkoutStatus.currentBranch,
      remoteUrl: checkoutStatus.remoteUrl,
      isPaseoOwnedWorktree: checkoutStatus.isPaseoOwnedWorktree,
      isDirty: checkoutStatus.isDirty,
      aheadBehind: checkoutStatus.aheadBehind,
      aheadOfOrigin: checkoutStatus.aheadOfOrigin,
      behindOfOrigin: checkoutStatus.behindOfOrigin,
      diffStat,
    },
    github,
  };
}

async function loadGitHubSnapshot(options: {
  cwd: string;
  remoteUrl: string | null;
  now: Date;
  deps: Pick<WorkspaceGitServiceDependencies, "getPullRequestStatus" | "github">;
}): Promise<WorkspaceGitRuntimeSnapshot["github"]> {
  if (!hasGitHubRemoteUrl(options.remoteUrl)) {
    return {
      featuresEnabled: false,
      pullRequest: null,
      error: null,
      refreshedAt: null,
    };
  }

  try {
    await options.deps.github.isAuthenticated({ cwd: options.cwd });
  } catch {
    return {
      featuresEnabled: false,
      pullRequest: null,
      error: null,
      refreshedAt: null,
    };
  }

  try {
    const result = await options.deps.getPullRequestStatus(options.cwd, options.deps.github);
    return {
      featuresEnabled: true,
      pullRequest: result.status,
      error: null,
      refreshedAt: options.now.toISOString(),
    };
  } catch (error) {
    return {
      featuresEnabled: true,
      pullRequest: null,
      error: {
        message: error instanceof Error ? error.message : String(error),
      },
      refreshedAt: options.now.toISOString(),
    };
  }
}

function hasGitHubRemoteUrl(remoteUrl: string | null): boolean {
  if (!remoteUrl) {
    return false;
  }

  return (
    remoteUrl.includes("github.com/") ||
    remoteUrl.startsWith("git@github.com:") ||
    remoteUrl.startsWith("ssh://git@github.com/")
  );
}

function buildNotGitSnapshot(cwd: string): WorkspaceGitRuntimeSnapshot {
  return {
    cwd,
    git: {
      isGit: false,
      repoRoot: null,
      mainRepoRoot: null,
      currentBranch: null,
      remoteUrl: null,
      isPaseoOwnedWorktree: false,
      isDirty: null,
      aheadBehind: null,
      aheadOfOrigin: null,
      behindOfOrigin: null,
      diffStat: null,
    },
    github: {
      featuresEnabled: false,
      pullRequest: null,
      error: null,
      refreshedAt: null,
    },
  };
}

async function runGitFetch(cwd: string): Promise<void> {
  await runGitCommand(["fetch", "origin", "--prune"], {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    },
    timeout: 120_000,
  });
}
