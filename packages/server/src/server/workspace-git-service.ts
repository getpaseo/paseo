import { watch, type FSWatcher } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type pino from "pino";
import type { CheckoutContext } from "../utils/checkout-git.js";
import {
  type BranchCheckoutResolution,
  type BranchSuggestion,
  type CheckoutDiffCompare,
  type CheckoutDiffResult,
  getCheckoutDiff,
  getCheckoutShortstat,
  getCheckoutStatus,
  getPullRequestStatus,
  hasOriginRemote,
  listBranchSuggestions,
  resolveRepositoryDefaultBranch,
  resolveBranchCheckout,
  resolveAbsoluteGitDir,
} from "../utils/checkout-git.js";
import { createGitHubService, type GitHubService } from "../services/github-service.js";
import { parseGitRevParsePath } from "../utils/git-rev-parse-path.js";
import { runGitCommand } from "../utils/run-git-command.js";
import { listPaseoWorktrees, type PaseoWorktreeInfo } from "../utils/worktree.js";
import { READ_ONLY_GIT_ENV } from "./checkout-git-utils.js";
import {
  buildWorkspaceGitMetadataFromSnapshot,
  type WorkspaceGitMetadata,
} from "./workspace-git-metadata.js";
import { normalizeWorkspaceId } from "./workspace-registry-model.js";

const WORKSPACE_GIT_WATCH_DEBOUNCE_MS = 500;
const BACKGROUND_GIT_FETCH_INTERVAL_MS = 180_000;
export const WORKSPACE_GIT_SELF_HEAL_INTERVAL_MS = 60_000;
const WORKING_TREE_WATCH_FALLBACK_REFRESH_MS = 5_000;
// Consumer reads may reuse cached values within this window; older peeks cold-load through the service.
const WORKSPACE_GIT_CONSUMER_TTL_MS = 15_000;
// Non-forced refresh triggers share this minimum gap to absorb watcher/self-heal bursts; force bypasses it.
const WORKSPACE_GIT_INTERNAL_MIN_GAP_MS = 2_000;

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
    baseRef: string | null;
    aheadBehind: { ahead: number; behind: number } | null;
    aheadOfOrigin: number | null;
    behindOfOrigin: number | null;
    hasRemote: boolean;
    diffStat: { additions: number; deletions: number } | null;
  };
  github: {
    featuresEnabled: boolean;
    pullRequest: {
      number?: number;
      repoOwner?: string;
      repoName?: string;
      url: string;
      title: string;
      state: string;
      baseRefName: string;
      headRefName: string;
      isMerged: boolean;
      isDraft?: boolean;
      checks?: Array<{
        name: string;
        status: "success" | "failure" | "pending" | "skipped" | "cancelled";
        url: string | null;
        workflow?: string;
        duration?: string;
      }>;
      checksStatus?: "none" | "pending" | "success" | "failure";
      reviewDecision?: "approved" | "changes_requested" | "pending" | null;
    } | null;
    error: { message: string } | null;
  };
};

export interface WorkspaceGitService {
  registerWorkspace(
    params: { cwd: string },
    listener: WorkspaceGitListener,
  ): WorkspaceGitSubscription;

  peekSnapshot(cwd: string): WorkspaceGitRuntimeSnapshot | null;
  getSnapshot(
    cwd: string,
    options?: WorkspaceGitSnapshotOptions,
  ): Promise<WorkspaceGitRuntimeSnapshot>;
  getCheckoutDiff(
    cwd: string,
    options: CheckoutDiffCompare,
    readOptions?: WorkspaceGitReadOptions,
  ): Promise<CheckoutDiffResult>;
  validateBranchRef(
    cwd: string,
    ref: string,
    options?: WorkspaceGitReadOptions,
  ): Promise<WorkspaceGitBranchValidationResult>;
  hasLocalBranch(cwd: string, branch: string, options?: WorkspaceGitReadOptions): Promise<boolean>;
  suggestBranchesForCwd(
    cwd: string,
    options?: WorkspaceGitBranchSuggestionsOptions,
    readOptions?: WorkspaceGitReadOptions,
  ): Promise<WorkspaceGitBranchSuggestion[]>;
  listStashes(
    cwd: string,
    options?: WorkspaceGitStashListOptions,
    readOptions?: WorkspaceGitReadOptions,
  ): Promise<WorkspaceGitStashEntry[]>;
  listWorktrees(
    cwdOrRepoRoot: string,
    options?: WorkspaceGitReadOptions,
  ): Promise<WorkspaceGitWorktreeInfo[]>;
  getWorkspaceGitMetadata(
    cwd: string,
    options?: WorkspaceGitReadOptions & { directoryName?: string },
  ): Promise<WorkspaceGitMetadata>;
  resolveRepoRoot(cwd: string, options?: WorkspaceGitReadOptions): Promise<string>;
  resolveDefaultBranch(cwdOrRepoRoot: string, options?: WorkspaceGitReadOptions): Promise<string>;
  resolveRepoRemoteUrl(cwd: string, options?: WorkspaceGitReadOptions): Promise<string | null>;
  refresh(cwd: string, options?: { priority?: "normal" | "high" }): Promise<void>;
  requestWorkingTreeWatch(
    cwd: string,
    onChange: () => void,
  ): Promise<{ repoRoot: string | null; unsubscribe: () => void }>;
  scheduleRefreshForCwd(cwd: string): void;
  dispose(): void;
}

export type WorkspaceGitListener = (snapshot: WorkspaceGitRuntimeSnapshot) => void;

export type WorkspaceGitSubscription = {
  unsubscribe: () => void;
};

export type WorkspaceGitReadOptions =
  | {
      force?: false;
      reason?: string;
    }
  | {
      force: true;
      reason: string;
    };

export interface WorkspaceGitBranchSuggestionsOptions {
  query?: string;
  limit?: number;
}

export interface WorkspaceGitStashListOptions {
  paseoOnly?: boolean;
}

export interface WorkspaceGitStashEntry {
  index: number;
  message: string;
  branch: string | null;
  isPaseo: boolean;
}

export type WorkspaceGitBranchValidationResult = BranchCheckoutResolution;
export type WorkspaceGitBranchSuggestion = BranchSuggestion;
export type WorkspaceGitWorktreeInfo = PaseoWorktreeInfo;

export type WorkspaceGitSnapshotOptions =
  | {
      force?: false;
      includeGitHub?: boolean;
      reason?: string;
    }
  | {
      force: true;
      includeGitHub?: boolean;
      reason: string;
    };

interface WorkspaceGitRefreshRequest {
  force: boolean;
  includeGitHub: boolean;
  reason: string;
  notify: boolean;
}

interface QueuedWorkspaceGitRefresh {
  force: boolean;
  includeGitHub: boolean;
  reason: string;
  notify: boolean;
}

type WorkspaceGitRefreshState =
  | {
      status: "idle";
    }
  | {
      status: "in-flight";
      promise: Promise<WorkspaceGitRuntimeSnapshot>;
      force: boolean;
      includeGitHub: boolean;
      queued: QueuedWorkspaceGitRefresh | null;
    };

interface WorkspaceGitServiceDependencies {
  watch: typeof watch;
  readdir: typeof readdir;
  getCheckoutStatus: typeof getCheckoutStatus;
  getCheckoutShortstat: typeof getCheckoutShortstat;
  getCheckoutDiff: typeof getCheckoutDiff;
  getPullRequestStatus: typeof getPullRequestStatus;
  resolveBranchCheckout: typeof resolveBranchCheckout;
  resolveRepositoryDefaultBranch: typeof resolveRepositoryDefaultBranch;
  listBranchSuggestions: typeof listBranchSuggestions;
  listPaseoWorktrees: typeof listPaseoWorktrees;
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
  selfHealTimer: NodeJS.Timeout | null;
  githubPollSubscription: { unsubscribe: () => void } | null;
  githubPollHeadRef: string | null;
  refreshState: WorkspaceGitRefreshState;
  latestSnapshot: WorkspaceGitRuntimeSnapshot | null;
  latestSnapshotLoadedAtMs: number | null;
  latestFingerprint: string | null;
  lastShellOutAtMs: number | null;
  repoGitRoot: string | null;
  observationSetupPromise: Promise<void> | null;
  observationSetupComplete: boolean;
  closed: boolean;
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

interface WorkspaceGitAuxiliaryReadCacheEntry<T> {
  value: T | null;
  loadedAtMs: number | null;
  lastShellOutAtMs: number | null;
  inFlight: Promise<T> | null;
}

export class WorkspaceGitServiceImpl implements WorkspaceGitService {
  private readonly logger: pino.Logger;
  private readonly paseoHome: string;
  private readonly deps: WorkspaceGitServiceDependencies;
  private readonly workspaceTargets = new Map<string, WorkspaceGitTarget>();
  private readonly repoTargets = new Map<string, RepoGitTarget>();
  private readonly workingTreeWatchTargets = new Map<string, WorkingTreeWatchTarget>();
  private readonly workingTreeWatchSetups = new Map<string, Promise<WorkingTreeWatchTarget>>();
  private readonly branchValidationCache = new Map<
    string,
    WorkspaceGitAuxiliaryReadCacheEntry<WorkspaceGitBranchValidationResult>
  >();
  private readonly localBranchCache = new Map<
    string,
    WorkspaceGitAuxiliaryReadCacheEntry<boolean>
  >();
  private readonly branchSuggestionsCache = new Map<
    string,
    WorkspaceGitAuxiliaryReadCacheEntry<WorkspaceGitBranchSuggestion[]>
  >();
  private readonly stashListCache = new Map<
    string,
    WorkspaceGitAuxiliaryReadCacheEntry<WorkspaceGitStashEntry[]>
  >();
  private readonly worktreeListCache = new Map<
    string,
    WorkspaceGitAuxiliaryReadCacheEntry<WorkspaceGitWorktreeInfo[]>
  >();
  private readonly defaultBranchCache = new Map<
    string,
    WorkspaceGitAuxiliaryReadCacheEntry<string>
  >();
  private readonly checkoutDiffCache = new Map<
    string,
    WorkspaceGitAuxiliaryReadCacheEntry<CheckoutDiffResult>
  >();

  constructor(options: WorkspaceGitServiceOptions) {
    this.logger = options.logger.child({ module: "workspace-git-service" });
    this.paseoHome = options.paseoHome;
    this.deps = {
      watch: options.deps?.watch ?? watch,
      readdir: options.deps?.readdir ?? readdir,
      getCheckoutStatus: options.deps?.getCheckoutStatus ?? getCheckoutStatus,
      getCheckoutShortstat: options.deps?.getCheckoutShortstat ?? getCheckoutShortstat,
      getCheckoutDiff: options.deps?.getCheckoutDiff ?? getCheckoutDiff,
      getPullRequestStatus: options.deps?.getPullRequestStatus ?? getPullRequestStatus,
      resolveBranchCheckout: options.deps?.resolveBranchCheckout ?? resolveBranchCheckout,
      resolveRepositoryDefaultBranch:
        options.deps?.resolveRepositoryDefaultBranch ?? resolveRepositoryDefaultBranch,
      listBranchSuggestions: options.deps?.listBranchSuggestions ?? listBranchSuggestions,
      listPaseoWorktrees: options.deps?.listPaseoWorktrees ?? listPaseoWorktrees,
      github: options.deps?.github ?? createGitHubService(),
      resolveAbsoluteGitDir: options.deps?.resolveAbsoluteGitDir ?? resolveAbsoluteGitDir,
      hasOriginRemote: options.deps?.hasOriginRemote ?? hasOriginRemote,
      runGitFetch: options.deps?.runGitFetch ?? runGitFetch,
      runGitCommand: options.deps?.runGitCommand ?? runGitCommand,
      now: options.deps?.now ?? (() => new Date()),
    };
  }

  registerWorkspace(
    params: { cwd: string },
    listener: WorkspaceGitListener,
  ): WorkspaceGitSubscription {
    const cwd = normalizeWorkspaceId(params.cwd);
    const target = this.ensureWorkspaceTarget(cwd);
    target.listeners.add(listener);
    if (target.listeners.size === 1) {
      this.startWorkspaceSubscriptionTimers(target);
    }
    if (!target.latestSnapshot) {
      this.scheduleInitialWorkspaceRefresh(target);
    }
    this.scheduleWorkspaceObservationSetup(target);

    return {
      unsubscribe: () => {
        this.removeWorkspaceListener(cwd, listener);
      },
    };
  }

  async getSnapshot(
    cwd: string,
    options?: WorkspaceGitSnapshotOptions,
  ): Promise<WorkspaceGitRuntimeSnapshot> {
    cwd = normalizeWorkspaceId(cwd);
    const request = this.normalizeRefreshRequest(options, "getSnapshot", true);
    const target = this.ensureWorkspaceTarget(cwd);
    if (!request.force && this.isSnapshotWarm(target)) {
      return target.latestSnapshot;
    }

    return this.requestWorkspaceSnapshot(target, request);
  }

  peekSnapshot(cwd: string): WorkspaceGitRuntimeSnapshot | null {
    cwd = normalizeWorkspaceId(cwd);
    return this.workspaceTargets.get(cwd)?.latestSnapshot ?? null;
  }

  getCheckoutDiff(
    cwd: string,
    options: CheckoutDiffCompare,
    readOptions?: WorkspaceGitReadOptions,
  ): Promise<CheckoutDiffResult> {
    const normalizedCwd = normalizeWorkspaceId(cwd);
    const normalizedOptions = this.normalizeCheckoutDiffOptions(options);
    const key = this.buildCheckoutDiffCacheKey(normalizedCwd, normalizedOptions);
    return this.readAuxiliaryCache(this.checkoutDiffCache, key, readOptions, () =>
      this.deps.getCheckoutDiff(normalizedCwd, normalizedOptions, { paseoHome: this.paseoHome }),
    );
  }

  private normalizeCheckoutDiffOptions(options: CheckoutDiffCompare): CheckoutDiffCompare {
    return {
      mode: options.mode,
      ...(options.mode === "base" && options.baseRef !== undefined
        ? { baseRef: options.baseRef }
        : {}),
      ...(options.ignoreWhitespace === true ? { ignoreWhitespace: true } : {}),
      ...(options.includeStructured === true ? { includeStructured: true } : {}),
    };
  }

  private buildCheckoutDiffCacheKey(cwd: string, options: CheckoutDiffCompare): string {
    // Diff content varies by compare signature. Keep the cache per exact diff read shape so
    // hot diff panes coalesce while base refs and rendering options never share stale patches.
    return JSON.stringify([
      "checkout-diff",
      cwd,
      options.mode,
      options.mode === "base" ? (options.baseRef ?? null) : null,
      options.ignoreWhitespace === true,
      options.includeStructured === true,
    ]);
  }

  validateBranchRef(
    cwd: string,
    ref: string,
    options?: WorkspaceGitReadOptions,
  ): Promise<WorkspaceGitBranchValidationResult> {
    const normalizedCwd = normalizeWorkspaceId(cwd);
    const normalizedRef = ref.trim();
    const key = JSON.stringify(["branch-validation", normalizedCwd, normalizedRef]);
    return this.readAuxiliaryCache(this.branchValidationCache, key, options, () =>
      this.deps.resolveBranchCheckout(normalizedCwd, normalizedRef),
    );
  }

  hasLocalBranch(cwd: string, branch: string, options?: WorkspaceGitReadOptions): Promise<boolean> {
    const normalizedCwd = normalizeWorkspaceId(cwd);
    const normalizedBranch = branch.trim();
    const ref = `refs/heads/${normalizedBranch}`;
    const key = JSON.stringify(["local-branch", normalizedCwd, ref]);
    return this.readAuxiliaryCache(this.localBranchCache, key, options, async () => {
      const result = await this.deps.runGitCommand(["rev-parse", "--verify", "--quiet", ref], {
        cwd: normalizedCwd,
        env: READ_ONLY_GIT_ENV,
        acceptExitCodes: [0, 1],
      });
      return result.exitCode === 0;
    });
  }

  suggestBranchesForCwd(
    cwd: string,
    options?: WorkspaceGitBranchSuggestionsOptions,
    readOptions?: WorkspaceGitReadOptions,
  ): Promise<WorkspaceGitBranchSuggestion[]> {
    const normalizedCwd = normalizeWorkspaceId(cwd);
    const query = options?.query ?? "";
    const limit = options?.limit;
    const key = JSON.stringify(["branch-suggestions", normalizedCwd, query, limit ?? null]);
    return this.readAuxiliaryCache(this.branchSuggestionsCache, key, readOptions, () =>
      this.deps.listBranchSuggestions(normalizedCwd, options),
    );
  }

  listStashes(
    cwd: string,
    options?: WorkspaceGitStashListOptions,
    readOptions?: WorkspaceGitReadOptions,
  ): Promise<WorkspaceGitStashEntry[]> {
    const normalizedCwd = normalizeWorkspaceId(cwd);
    const paseoOnly = options?.paseoOnly !== false;
    const key = JSON.stringify(["stashes", normalizedCwd, paseoOnly]);
    return this.readAuxiliaryCache(this.stashListCache, key, readOptions, async () => {
      const { stdout } = await this.deps.runGitCommand(["stash", "list", "--format=%gd%x00%s"], {
        cwd: normalizedCwd,
        env: READ_ONLY_GIT_ENV,
      });
      return parseWorkspaceGitStashList(stdout, { paseoOnly });
    });
  }

  async listWorktrees(
    cwdOrRepoRoot: string,
    options?: WorkspaceGitReadOptions,
  ): Promise<WorkspaceGitWorktreeInfo[]> {
    const repoRoot = await this.resolveRepoRoot(cwdOrRepoRoot, options);
    const key = JSON.stringify(["worktrees", repoRoot]);
    return this.readAuxiliaryCache(this.worktreeListCache, key, options, () =>
      this.deps.listPaseoWorktrees({
        cwd: repoRoot,
        paseoHome: this.paseoHome,
      }),
    );
  }

  async resolveRepoRoot(cwd: string, options?: WorkspaceGitReadOptions): Promise<string> {
    const snapshot = await this.getSnapshot(cwd, options);
    if (!snapshot.git.isGit) {
      throw new Error("Create worktree requires a git repository");
    }

    return snapshot.git.isPaseoOwnedWorktree
      ? (snapshot.git.mainRepoRoot ?? snapshot.git.repoRoot ?? normalizeWorkspaceId(cwd))
      : (snapshot.git.repoRoot ?? normalizeWorkspaceId(cwd));
  }

  async resolveDefaultBranch(
    cwdOrRepoRoot: string,
    options?: WorkspaceGitReadOptions,
  ): Promise<string> {
    const cwd = normalizeWorkspaceId(cwdOrRepoRoot);
    const key = JSON.stringify(["default-branch", cwd]);
    return this.readAuxiliaryCache(this.defaultBranchCache, key, options, async () => {
      const defaultBranch = await this.deps.resolveRepositoryDefaultBranch(cwd);
      if (!defaultBranch) {
        throw new Error("Unable to resolve repository default branch");
      }
      return defaultBranch;
    });
  }

  async getWorkspaceGitMetadata(
    cwd: string,
    options?: WorkspaceGitReadOptions & { directoryName?: string },
  ): Promise<WorkspaceGitMetadata> {
    const snapshot = await this.getSnapshot(cwd, options);
    const directoryName =
      options?.directoryName ??
      normalizeWorkspaceId(cwd).split(/[\\/]/).filter(Boolean).at(-1) ??
      cwd;
    return buildWorkspaceGitMetadataFromSnapshot({
      cwd: normalizeWorkspaceId(cwd),
      directoryName,
      isGit: snapshot.git.isGit,
      repoRoot: snapshot.git.repoRoot,
      mainRepoRoot: snapshot.git.mainRepoRoot,
      currentBranch: snapshot.git.currentBranch,
      remoteUrl: snapshot.git.remoteUrl,
    });
  }

  async resolveRepoRemoteUrl(
    cwd: string,
    options?: WorkspaceGitReadOptions,
  ): Promise<string | null> {
    const snapshot = await this.getSnapshot(cwd, options);
    return snapshot.git.remoteUrl;
  }

  async refresh(cwd: string, _options?: { priority?: "normal" | "high" }): Promise<void> {
    cwd = normalizeWorkspaceId(cwd);
    const target = this.ensureWorkspaceTarget(cwd);
    await this.refreshWorkspaceTarget(target, {
      force: false,
      includeGitHub: false,
      reason: "refresh",
      notify: true,
    });
    this.scheduleWorkspaceObservationSetup(target);
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

  private ensureWorkspaceTarget(cwd: string): WorkspaceGitTarget {
    const existingTarget = this.workspaceTargets.get(cwd);
    if (existingTarget) {
      return existingTarget;
    }

    return this.createWorkspaceTarget(cwd);
  }

  private readAuxiliaryCache<T>(
    cache: Map<string, WorkspaceGitAuxiliaryReadCacheEntry<T>>,
    key: string,
    options: WorkspaceGitReadOptions | undefined,
    load: () => Promise<T>,
  ): Promise<T> {
    if (options?.force && !options.reason) {
      throw new Error("WorkspaceGitService forced read requires a reason");
    }

    const entry = this.ensureAuxiliaryCacheEntry(cache, key);
    const nowMs = this.deps.now().getTime();
    if (!options?.force && entry.value !== null && entry.loadedAtMs !== null) {
      const ageMs = nowMs - entry.loadedAtMs;
      if (ageMs <= WORKSPACE_GIT_CONSUMER_TTL_MS) {
        return Promise.resolve(entry.value);
      }
      if (
        entry.lastShellOutAtMs !== null &&
        nowMs - entry.lastShellOutAtMs < WORKSPACE_GIT_INTERNAL_MIN_GAP_MS
      ) {
        return Promise.resolve(entry.value);
      }
    }

    if (entry.inFlight) {
      return entry.inFlight;
    }

    entry.lastShellOutAtMs = nowMs;
    entry.inFlight = load()
      .then((value) => {
        entry.value = value;
        entry.loadedAtMs = this.deps.now().getTime();
        return value;
      })
      .finally(() => {
        entry.inFlight = null;
      });
    return entry.inFlight;
  }

  private ensureAuxiliaryCacheEntry<T>(
    cache: Map<string, WorkspaceGitAuxiliaryReadCacheEntry<T>>,
    key: string,
  ): WorkspaceGitAuxiliaryReadCacheEntry<T> {
    const existing = cache.get(key);
    if (existing) {
      return existing;
    }

    const entry: WorkspaceGitAuxiliaryReadCacheEntry<T> = {
      value: null,
      loadedAtMs: null,
      lastShellOutAtMs: null,
      inFlight: null,
    };
    cache.set(key, entry);
    return entry;
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

  private createWorkspaceTarget(cwd: string): WorkspaceGitTarget {
    const target: WorkspaceGitTarget = {
      cwd,
      listeners: new Set(),
      watchers: [],
      debounceTimer: null,
      selfHealTimer: null,
      githubPollSubscription: null,
      githubPollHeadRef: null,
      refreshState: { status: "idle" },
      latestSnapshot: null,
      latestSnapshotLoadedAtMs: null,
      latestFingerprint: null,
      lastShellOutAtMs: null,
      repoGitRoot: null,
      observationSetupPromise: null,
      observationSetupComplete: false,
      closed: false,
    };

    this.workspaceTargets.set(cwd, target);
    return target;
  }

  private scheduleInitialWorkspaceRefresh(target: WorkspaceGitTarget): void {
    queueMicrotask(() => {
      if (!this.isActiveObservedWorkspaceTarget(target) || target.latestSnapshot) {
        return;
      }
      void this.refreshWorkspaceTarget(target, {
        force: false,
        includeGitHub: true,
        reason: "initial",
        notify: true,
      });
    });
  }

  private scheduleWorkspaceObservationSetup(target: WorkspaceGitTarget): void {
    if (
      target.observationSetupComplete ||
      target.observationSetupPromise ||
      !this.isActiveObservedWorkspaceTarget(target)
    ) {
      return;
    }

    target.observationSetupPromise = Promise.resolve()
      .then(() => this.setupWorkspaceObservation(target))
      .catch((error) => {
        this.logger.warn(
          { err: error, cwd: target.cwd },
          "Failed to set up workspace git observation",
        );
      })
      .finally(() => {
        target.observationSetupPromise = null;
      });
  }

  private async setupWorkspaceObservation(target: WorkspaceGitTarget): Promise<void> {
    try {
      const gitDir = await this.deps.resolveAbsoluteGitDir(target.cwd);
      if (!this.isActiveObservedWorkspaceTarget(target)) {
        return;
      }
      if (!gitDir) {
        target.observationSetupComplete = true;
        return;
      }

      const repoGitRoot = await this.resolveWorkspaceGitRefsRoot(gitDir);
      if (!this.isActiveObservedWorkspaceTarget(target)) {
        return;
      }
      target.repoGitRoot = repoGitRoot;
      this.startWorkspaceWatchers(target, gitDir, repoGitRoot);
      await this.ensureRepoTarget(target);
      if (this.isActiveObservedWorkspaceTarget(target)) {
        target.observationSetupComplete = true;
      }
    } catch (error) {
      throw error;
    }
  }

  private isActiveObservedWorkspaceTarget(target: WorkspaceGitTarget): boolean {
    return (
      !target.closed &&
      target.listeners.size > 0 &&
      this.workspaceTargets.get(target.cwd) === target
    );
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
        this.scheduleWorkspaceRefresh(cwd, {
          force: true,
          reason: "working-tree-watch-fallback",
        });
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
    if (!repoGitRoot || !this.isActiveObservedWorkspaceTarget(workspaceTarget)) {
      return;
    }

    const existingTarget = this.repoTargets.get(repoGitRoot);
    if (existingTarget) {
      existingTarget.workspaceKeys.add(workspaceTarget.cwd);
      return;
    }

    const hasOrigin = await this.deps.hasOriginRemote(workspaceTarget.cwd);
    if (!this.isActiveObservedWorkspaceTarget(workspaceTarget)) {
      return;
    }
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

  private scheduleWorkspaceRefresh(
    targetOrCwd: WorkspaceGitTarget | string,
    options?: { force?: boolean; reason?: string },
  ): void {
    const target =
      typeof targetOrCwd === "string"
        ? this.workspaceTargets.get(normalizeWorkspaceId(targetOrCwd))
        : targetOrCwd;
    if (!target || target.closed || this.workspaceTargets.get(target.cwd) !== target) {
      return;
    }

    if (target.debounceTimer) {
      clearTimeout(target.debounceTimer);
    }

    target.debounceTimer = setTimeout(() => {
      if (target.closed || this.workspaceTargets.get(target.cwd) !== target) {
        return;
      }
      target.debounceTimer = null;
      void this.refreshWorkspaceTarget(target, {
        force: options?.force === true,
        includeGitHub: false,
        reason: options?.reason ?? "watch",
        notify: true,
      });
    }, WORKSPACE_GIT_WATCH_DEBOUNCE_MS);
  }

  private startWorkspaceSubscriptionTimers(target: WorkspaceGitTarget): void {
    if (!target.selfHealTimer) {
      target.selfHealTimer = setInterval(() => {
        this.scheduleWorkspaceObservationSetup(target);
        this.getSnapshot(target.cwd, { reason: "self-heal-git" }).catch((error) => {
          this.logger.warn(
            { err: error, cwd: target.cwd, reason: "self-heal-git" },
            "Failed to run workspace git self-heal refresh",
          );
        });
      }, WORKSPACE_GIT_SELF_HEAL_INTERVAL_MS);
    }

    this.updateGitHubPollForTarget(target);
  }

  private updateGitHubPollForTarget(target: WorkspaceGitTarget): void {
    if (target.listeners.size === 0) {
      this.stopGitHubPollForTarget(target);
      return;
    }

    const snapshot = target.latestSnapshot;
    if (!snapshot || !this.deps.github.retainCurrentPullRequestStatusPoll) {
      this.stopGitHubPollForTarget(target);
      return;
    }

    const headRef = snapshot.git.currentBranch;
    if (!headRef || !hasGitHubRemoteUrl(snapshot.git.remoteUrl)) {
      this.stopGitHubPollForTarget(target);
      return;
    }
    if (target.githubPollHeadRef === headRef && target.githubPollSubscription) {
      return;
    }

    this.stopGitHubPollForTarget(target);
    target.githubPollHeadRef = headRef;
    target.githubPollSubscription = this.deps.github.retainCurrentPullRequestStatusPoll({
      cwd: target.cwd,
      headRef,
      onStatus: () => {
        if (!this.isActiveObservedWorkspaceTarget(target)) {
          return;
        }
        void this.refreshWorkspaceTarget(target, {
          force: false,
          includeGitHub: true,
          reason: "self-heal-github",
          notify: true,
        });
      },
      onError: (error) => {
        this.logger.warn(
          { err: error, cwd: target.cwd, headRef, reason: "self-heal-github" },
          "Failed to run GitHub self-heal refresh",
        );
      },
    });
  }

  private stopGitHubPollForTarget(target: WorkspaceGitTarget): void {
    target.githubPollSubscription?.unsubscribe();
    target.githubPollSubscription = null;
    target.githubPollHeadRef = null;
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
      this.scheduleWorkspaceRefresh(cwd, {
        force: true,
        reason: "working-tree-watch",
      });
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

  private async refreshWorkspaceTarget(
    target: WorkspaceGitTarget,
    request: WorkspaceGitRefreshRequest,
  ): Promise<void> {
    if (target.closed || this.workspaceTargets.get(target.cwd) !== target) {
      return;
    }
    try {
      await this.requestWorkspaceSnapshot(target, request);
    } catch (error) {
      this.logger.warn(
        { err: error, cwd: target.cwd, reason: request.reason },
        "Failed to refresh workspace git snapshot",
      );
    }
  }

  private requestWorkspaceSnapshot(
    target: WorkspaceGitTarget,
    request: WorkspaceGitRefreshRequest,
  ): Promise<WorkspaceGitRuntimeSnapshot> {
    if (target.refreshState.status === "in-flight") {
      if (request.force && !target.refreshState.force) {
        target.refreshState.queued = this.mergeQueuedRefresh(target.refreshState.queued, request);
      }
      return target.refreshState.promise;
    }

    if (!request.force && this.shouldThrottleNonForcedRefresh(target)) {
      return Promise.resolve(target.latestSnapshot);
    }

    const promise = this.runWorkspaceRefreshLoop(target, request).finally(() => {
      const state = target.refreshState;
      if (state.status === "in-flight" && state.promise === promise) {
        target.refreshState = { status: "idle" };
      }
    });
    target.refreshState = {
      status: "in-flight",
      promise,
      force: request.force,
      includeGitHub: request.includeGitHub,
      queued: null,
    };

    return promise;
  }

  private normalizeRefreshRequest(
    options: WorkspaceGitSnapshotOptions | undefined,
    defaultReason: string,
    notify: boolean,
  ): WorkspaceGitRefreshRequest {
    if (options?.force && !options.reason) {
      throw new Error("WorkspaceGitService.getSnapshot force refresh requires a reason");
    }

    const force = options?.force === true;
    return {
      force,
      includeGitHub: options?.includeGitHub ?? force,
      reason: options?.reason ?? defaultReason,
      notify,
    };
  }

  private isSnapshotWarm(target: WorkspaceGitTarget): target is WorkspaceGitTarget & {
    latestSnapshot: WorkspaceGitRuntimeSnapshot;
    latestSnapshotLoadedAtMs: number;
  } {
    if (!target.latestSnapshot || target.latestSnapshotLoadedAtMs === null) {
      return false;
    }

    return (
      this.deps.now().getTime() - target.latestSnapshotLoadedAtMs <= WORKSPACE_GIT_CONSUMER_TTL_MS
    );
  }

  private shouldThrottleNonForcedRefresh(
    target: WorkspaceGitTarget,
  ): target is WorkspaceGitTarget & {
    latestSnapshot: WorkspaceGitRuntimeSnapshot;
  } {
    if (!target.latestSnapshot || target.lastShellOutAtMs === null) {
      return false;
    }

    return this.deps.now().getTime() - target.lastShellOutAtMs < WORKSPACE_GIT_INTERNAL_MIN_GAP_MS;
  }

  private mergeQueuedRefresh(
    queued: QueuedWorkspaceGitRefresh | null,
    request: WorkspaceGitRefreshRequest,
  ): QueuedWorkspaceGitRefresh {
    if (!queued) {
      return {
        force: request.force,
        includeGitHub: request.includeGitHub,
        reason: request.reason,
        notify: request.notify,
      };
    }

    const force = queued.force || request.force;
    return {
      force,
      includeGitHub: queued.includeGitHub || request.includeGitHub,
      reason: request.force && !queued.force ? request.reason : queued.reason,
      notify: queued.notify || request.notify,
    };
  }

  private async runWorkspaceRefreshLoop(
    target: WorkspaceGitTarget,
    initialRequest: WorkspaceGitRefreshRequest,
  ): Promise<WorkspaceGitRuntimeSnapshot> {
    let request = initialRequest;
    let snapshot!: WorkspaceGitRuntimeSnapshot;

    while (true) {
      snapshot = await this.refreshSnapshot(target, request);
      this.rememberSnapshot(target, snapshot, {
        notify: request.notify,
        forceEmit: request.force,
      });

      const state = target.refreshState;
      if (state.status !== "in-flight" || !state.queued) {
        break;
      }

      request = state.queued;
      state.queued = null;
      state.force = request.force;
      state.includeGitHub = request.includeGitHub;
    }

    return snapshot;
  }

  private async refreshSnapshot(
    target: WorkspaceGitTarget,
    request: WorkspaceGitRefreshRequest,
  ): Promise<WorkspaceGitRuntimeSnapshot> {
    const now = this.deps.now();
    target.lastShellOutAtMs = now.getTime();
    const forceGitHub = request.force && request.includeGitHub;
    if (forceGitHub) {
      this.deps.github.invalidate({ cwd: target.cwd });
    }
    const snapshot = await loadWorkspaceGitRuntimeSnapshot(
      target.cwd,
      { paseoHome: this.paseoHome },
      now,
      this.deps,
      { force: request.force, forceGitHub, reason: request.reason },
    );
    target.latestSnapshotLoadedAtMs = now.getTime();
    return snapshot;
  }

  private rememberSnapshot(
    target: WorkspaceGitTarget,
    snapshot: WorkspaceGitRuntimeSnapshot,
    options?: { forceEmit?: boolean; notify?: boolean },
  ): void {
    target.latestSnapshot = snapshot;
    if (target.listeners.size > 0) {
      this.updateGitHubPollForTarget(target);
    }
    const fingerprint = JSON.stringify(snapshot);
    const fingerprintMatches = target.latestFingerprint === fingerprint;
    if (fingerprintMatches && !options?.forceEmit) {
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
          await this.refreshWorkspaceTarget(workspaceTarget, {
            force: false,
            includeGitHub: false,
            reason: "repo-fetch",
            notify: true,
          });
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
    target.closed = true;
    if (target.debounceTimer) {
      clearTimeout(target.debounceTimer);
      target.debounceTimer = null;
    }
    if (target.selfHealTimer) {
      clearInterval(target.selfHealTimer);
      target.selfHealTimer = null;
    }
    this.stopGitHubPollForTarget(target);

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
  options?: { force?: boolean; forceGitHub?: boolean; reason?: string },
): Promise<WorkspaceGitRuntimeSnapshot> {
  const checkoutStatus = await deps.getCheckoutStatus(cwd, context);
  if (!checkoutStatus.isGit) {
    return buildNotGitSnapshot(cwd);
  }

  const [diffStat, github] = await Promise.all([
    deps.getCheckoutShortstat(cwd, context, { force: options?.force }),
    loadGitHubSnapshot({
      cwd,
      remoteUrl: checkoutStatus.remoteUrl,
      now,
      deps,
      force: options?.forceGitHub,
      reason: options?.reason,
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
      baseRef: checkoutStatus.baseRef,
      aheadBehind: checkoutStatus.aheadBehind,
      aheadOfOrigin: checkoutStatus.aheadOfOrigin,
      behindOfOrigin: checkoutStatus.behindOfOrigin,
      hasRemote: checkoutStatus.hasRemote,
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
  force?: boolean;
  reason?: string;
}): Promise<WorkspaceGitRuntimeSnapshot["github"]> {
  if (!hasGitHubRemoteUrl(options.remoteUrl)) {
    return {
      featuresEnabled: false,
      pullRequest: null,
      error: null,
    };
  }

  try {
    await options.deps.github.isAuthenticated({ cwd: options.cwd });
  } catch {
    return {
      featuresEnabled: false,
      pullRequest: null,
      error: null,
    };
  }

  try {
    const result = await options.deps.getPullRequestStatus(options.cwd, options.deps.github, {
      force: options.force,
      reason: options.reason,
    });
    return {
      featuresEnabled: true,
      pullRequest: result.status,
      error: null,
    };
  } catch (error) {
    return {
      featuresEnabled: true,
      pullRequest: null,
      error: {
        message: error instanceof Error ? error.message : String(error),
      },
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

function parseWorkspaceGitStashList(
  stdout: string,
  options: { paseoOnly: boolean },
): WorkspaceGitStashEntry[] {
  const entries: WorkspaceGitStashEntry[] = [];
  const lines = stdout.trim().split("\n").filter(Boolean);

  for (const line of lines) {
    const sepIdx = line.indexOf("\0");
    if (sepIdx < 0) {
      continue;
    }

    const refPart = line.slice(0, sepIdx);
    const subject = line.slice(sepIdx + 1);
    const indexMatch = refPart.match(/\{(\d+)\}/);
    if (!indexMatch) {
      continue;
    }

    const index = Number(indexMatch[1]);
    const prefix = "paseo-auto-stash:";
    const prefixIdx = subject.indexOf(prefix);
    const isPaseo = prefixIdx >= 0;
    const branch = isPaseo ? subject.slice(prefixIdx + prefix.length).trim() || null : null;

    if (options.paseoOnly && !isPaseo) {
      continue;
    }

    entries.push({ index, message: subject, branch, isPaseo });
  }

  return entries;
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
      baseRef: null,
      aheadBehind: null,
      aheadOfOrigin: null,
      behindOfOrigin: null,
      hasRemote: false,
      diffStat: null,
    },
    github: {
      featuresEnabled: false,
      pullRequest: null,
      error: null,
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
