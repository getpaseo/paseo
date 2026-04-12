import { execFile } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type pino from "pino";
import type { CheckoutContext } from "../utils/checkout-git.js";
import {
  getCheckoutShortstat,
  getCheckoutStatus,
  getPullRequestStatus,
  hasOriginRemote,
  resolveGhPath,
  resolveAbsoluteGitDir,
} from "../utils/checkout-git.js";
import { normalizeWorkspaceId } from "./workspace-registry-model.js";

const execFileAsync = promisify(execFile);

const WORKSPACE_GIT_WATCH_DEBOUNCE_MS = 500;
const BACKGROUND_GIT_FETCH_INTERVAL_MS = 180_000;

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
  dispose(): void;
}

export type WorkspaceGitListener = (snapshot: WorkspaceGitRuntimeSnapshot) => void;

interface WorkspaceGitServiceDependencies {
  watch: typeof watch;
  getCheckoutStatus: typeof getCheckoutStatus;
  getCheckoutShortstat: typeof getCheckoutShortstat;
  getPullRequestStatus: typeof getPullRequestStatus;
  resolveGhPath: typeof resolveGhPath;
  resolveAbsoluteGitDir: (cwd: string) => Promise<string | null>;
  hasOriginRemote: (cwd: string) => Promise<boolean>;
  runGitFetch: (cwd: string) => Promise<void>;
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

export class WorkspaceGitServiceImpl implements WorkspaceGitService {
  private readonly logger: pino.Logger;
  private readonly paseoHome: string;
  private readonly deps: WorkspaceGitServiceDependencies;
  private readonly workspaceTargets = new Map<string, WorkspaceGitTarget>();
  private readonly repoTargets = new Map<string, RepoGitTarget>();
  private readonly workspaceTargetSetups = new Map<string, Promise<WorkspaceGitTarget>>();

  constructor(options: WorkspaceGitServiceOptions) {
    this.logger = options.logger.child({ module: "workspace-git-service" });
    this.paseoHome = options.paseoHome;
    this.deps = {
      watch,
      getCheckoutStatus: options.deps?.getCheckoutStatus ?? getCheckoutStatus,
      getCheckoutShortstat: options.deps?.getCheckoutShortstat ?? getCheckoutShortstat,
      getPullRequestStatus: options.deps?.getPullRequestStatus ?? getPullRequestStatus,
      resolveGhPath: options.deps?.resolveGhPath ?? resolveGhPath,
      resolveAbsoluteGitDir: options.deps?.resolveAbsoluteGitDir ?? resolveAbsoluteGitDir,
      hasOriginRemote: options.deps?.hasOriginRemote ?? hasOriginRemote,
      runGitFetch: options.deps?.runGitFetch ?? runGitFetch,
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
    return this.refreshSnapshot(cwd);
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

  dispose(): void {
    for (const target of this.workspaceTargets.values()) {
      this.closeWorkspaceTarget(target);
    }
    this.workspaceTargets.clear();

    for (const target of this.repoTargets.values()) {
      this.closeRepoTarget(target);
    }
    this.repoTargets.clear();
    this.workspaceTargetSetups.clear();
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

  private scheduleWorkspaceRefresh(target: WorkspaceGitTarget): void {
    if (target.debounceTimer) {
      clearTimeout(target.debounceTimer);
    }

    target.debounceTimer = setTimeout(() => {
      target.debounceTimer = null;
      void this.refreshWorkspaceTarget(target);
    }, WORKSPACE_GIT_WATCH_DEBOUNCE_MS);
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
    "getCheckoutStatus" | "getCheckoutShortstat" | "getPullRequestStatus" | "resolveGhPath"
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
  deps: Pick<WorkspaceGitServiceDependencies, "getPullRequestStatus" | "resolveGhPath">;
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
    await options.deps.resolveGhPath();
  } catch {
    return {
      featuresEnabled: false,
      pullRequest: null,
      error: null,
      refreshedAt: null,
    };
  }

  try {
    const result = await options.deps.getPullRequestStatus(options.cwd);
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
  await execFileAsync("git", ["fetch", "origin", "--prune"], {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}
