import { watch, type FSWatcher } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { LRUCache } from "lru-cache";
import pLimit from "p-limit";
import type pino from "pino";
import type { ProjectCheckoutLitePayload } from "@getpaseo/protocol/messages";
import { parseGitRemoteLocation } from "@getpaseo/protocol/git-remote";
import type { CheckoutContext } from "../utils/checkout-git.js";
import {
  type BranchCheckoutResolution,
  type BranchSuggestion,
  type CheckoutSnapshotFacts,
  type CheckoutDiffCompare,
  type CheckoutDiffResult,
  getCheckoutDiff,
  getCheckoutSnapshotFacts,
  getCheckoutShortstat,
  getCheckoutStatus,
  getPullRequestStatus,
  forgeAuthStateFromError,
  hasOriginRemote,
  listBranchSuggestions,
  resolveRepositoryDefaultBranch,
  resolveBranchCheckout,
  resolveAbsoluteGitDir,
} from "../utils/checkout-git.js";
import type {
  ForgeAuthState,
  ForgeService,
  ForgeSpecificStatusFacts,
  PullRequestMergeable,
} from "../services/forge-service.js";
import { createForgeService } from "../services/forge-registry.js";
import {
  createForgeResolver,
  type ForgeResolution,
  type ForgeResolver,
} from "../services/forge-resolver.js";
import { parseGitRevParsePath } from "../utils/git-rev-parse-path.js";
import { runGitCommand } from "../utils/run-git-command.js";
import { listPaseoWorktrees, type PaseoWorktreeInfo } from "../utils/worktree.js";
import { READ_ONLY_GIT_ENV } from "./checkout-git-utils.js";
import { deriveProjectSlug } from "./workspace-git-metadata.js";
import { checkoutLiteFromGitSnapshot } from "./workspace-registry-model.js";

const WORKSPACE_GIT_WATCH_DEBOUNCE_MS = 1_000;
const BACKGROUND_GIT_FETCH_INTERVAL_MS = 180_000;
export const WORKSPACE_GIT_SELF_HEAL_INTERVAL_MS = 60_000;
const FORGE_PR_STATUS_POLL_FAST_INTERVAL_MS = 20_000;
const FORGE_PR_STATUS_POLL_SLOW_INTERVAL_MS = 120_000;
const FORGE_PR_STATUS_POLL_ERROR_BACKOFF_CAP_MS = 300_000;
const WORKING_TREE_WATCH_FALLBACK_REFRESH_MS = 5_000;
// Auxiliary reads may reuse cached values within this window; snapshots do not expire on read.
const WORKSPACE_GIT_AUXILIARY_READ_TTL_MS = 15_000;
// Non-forced refresh triggers share this minimum gap to absorb watcher/self-heal bursts; force bypasses it.
const WORKSPACE_GIT_INTERNAL_MIN_GAP_MS = 2_000;
// Heavy values (multi-MB highlighted diffs); cap aggressively. Ephemeral worktree cwds would otherwise pile up forever.
const WORKSPACE_GIT_CHECKOUT_DIFF_CACHE_MAX = 64;
// Small values (booleans, short strings, small arrays); generous cap.
const WORKSPACE_GIT_AUXILIARY_CACHE_MAX = 256;
const WORKSPACE_GIT_FACTS_REUSE_TTL_MS = 1_000;
const LINUX_WATCH_MAX_DIRS = 5_000;
const LINUX_WATCH_REFRESH_COOLDOWN_MS = 2_000;
const LINUX_WATCH_IGNORE_TTL_MS = 5 * 60 * 1_000;

const linuxWatchReaddirConcurrency =
  parseInt(process.env.PASEO_LINUX_WATCH_READDIR_CONCURRENCY ?? "16", 10) || 16;
const linuxWatchReaddirLimit = pLimit(linuxWatchReaddirConcurrency);

export interface WorkspaceGitRuntimeSnapshot {
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
  forge: {
    featuresEnabled: boolean;
    authState: ForgeAuthState;
    /**
     * Forge resolved for this workspace from its remote — including the per-host
     * probe, so self-managed GitLab hosts (no "gitlab" in the name) are labeled
     * correctly. The wire projection prefers this over the bare name heuristic.
     */
    forge?: string;
    pullRequest: {
      number?: number;
      repoOwner?: string;
      repoName?: string;
      projectPath?: string;
      url: string;
      title: string;
      state: string;
      baseRefName: string;
      headRefName: string;
      isMerged: boolean;
      isDraft?: boolean;
      mergeable?: PullRequestMergeable;
      checks?: Array<{
        name: string;
        status: "success" | "failure" | "pending" | "skipped" | "cancelled";
        url: string | null;
        workflow?: string;
        duration?: string;
      }>;
      checksStatus?: "none" | "pending" | "success" | "failure";
      reviewDecision?: "approved" | "changes_requested" | "pending" | null;
      forgeSpecific?: ForgeSpecificStatusFacts;
    } | null;
    error: { message: string } | null;
  };
}

export interface WorkspaceGitService {
  registerWorkspace(
    params: { cwd: string },
    listener: WorkspaceGitListener,
  ): WorkspaceGitSubscription;

  onSnapshotUpdated(listener: WorkspaceGitSnapshotUpdatedListener): WorkspaceGitSubscription;
  peekSnapshot(cwd: string): WorkspaceGitRuntimeSnapshot | null;
  getCheckout(cwd: string): Promise<ProjectCheckoutLitePayload>;
  getSnapshot(
    cwd: string,
    options?: WorkspaceGitSnapshotOptions,
  ): Promise<WorkspaceGitRuntimeSnapshot>;
  resolveForge(cwd: string): Promise<ForgeResolution | null>;
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
  getProjectSlug(cwd: string, options?: WorkspaceGitReadOptions): Promise<string>;
  resolveRepoRoot(cwd: string, options?: WorkspaceGitReadOptions): Promise<string>;
  resolveDefaultBranch(cwdOrRepoRoot: string, options?: WorkspaceGitReadOptions): Promise<string>;
  resolveRepoRemoteUrl(cwd: string, options?: WorkspaceGitReadOptions): Promise<string | null>;
  refresh(cwd: string, options?: { priority?: "normal" | "high" }): Promise<void>;
  requestWorkingTreeWatch(
    cwd: string,
    onChange: () => void,
  ): Promise<{ repoRoot: string | null; unsubscribe: () => void }>;
  scheduleRefreshForCwd(cwd: string): void;
  onWorkspaceStateMayHaveChanged(cwd: string): void;
  invalidateForge(cwd: string): void;
  dispose(): void;
}

export type WorkspaceGitListener = (snapshot: WorkspaceGitRuntimeSnapshot) => void;
export type WorkspaceGitSnapshotUpdatedListener = (snapshot: WorkspaceGitRuntimeSnapshot) => void;

export interface WorkspaceGitSubscription {
  unsubscribe: () => void;
}

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
      includeForge?: boolean;
      reason?: string;
    }
  | {
      force: true;
      includeForge?: boolean;
      reason: string;
    };

interface WorkspaceGitRefreshRequest {
  force: boolean;
  includeForge: boolean;
  reason: string;
  notify: boolean;
}

interface ScheduledWorkspaceGitRefreshOptions {
  force?: boolean;
  includeForge?: boolean;
  reason?: string;
}

type WorkspaceGitRefreshState =
  | {
      status: "idle";
    }
  | {
      status: "in-flight";
      promise: Promise<WorkspaceGitRuntimeSnapshot>;
      force: boolean;
      includeForge: boolean;
      queued: WorkspaceGitRefreshRequest | null;
    };

interface WorkspaceGitServiceDependencies {
  watch: typeof watch;
  readdir: typeof readdir;
  getCheckoutSnapshotFacts: typeof getCheckoutSnapshotFacts;
  getCheckoutStatus: typeof getCheckoutStatus;
  getCheckoutShortstat: typeof getCheckoutShortstat;
  getCheckoutDiff: typeof getCheckoutDiff;
  getPullRequestStatus: typeof getPullRequestStatus;
  resolveBranchCheckout: typeof resolveBranchCheckout;
  resolveRepositoryDefaultBranch: typeof resolveRepositoryDefaultBranch;
  listBranchSuggestions: typeof listBranchSuggestions;
  listPaseoWorktrees: typeof listPaseoWorktrees;
  /**
   * Adapter instances to bind by forge id instead of building from the registry
   * — the injection seam for the daemon's shared GitHub adapter and for test
   * fakes. Any forge not listed here is built (and cached once) by the registry.
   */
  forgeOverrides?: Record<string, ForgeService>;
  resolveAbsoluteGitDir: (cwd: string) => Promise<string | null>;
  hasOriginRemote: (cwd: string) => Promise<boolean>;
  runGitFetch: (cwd: string) => Promise<void>;
  runGitCommand: typeof runGitCommand;
  now: () => Date;
}

interface WorkspaceGitServiceOptions {
  logger: pino.Logger;
  paseoHome: string;
  worktreesRoot?: string;
  deps?: Partial<WorkspaceGitServiceDependencies>;
}

interface WorkspaceGitTarget {
  cwd: string;
  listeners: Set<WorkspaceGitListener>;
  watchers: FSWatcher[];
  debounceTimer: NodeJS.Timeout | null;
  pendingDebounceRequest: WorkspaceGitRefreshRequest | null;
  selfHealTimer: NodeJS.Timeout | null;
  forgePrStatusPollSubscription: { unsubscribe: () => void } | null;
  forgePrStatusPollKey: string | null;
  refreshState: WorkspaceGitRefreshState;
  latestGit: WorkspaceGitRuntimeSnapshot["git"] | null;
  latestGitLoadedAtMs: number | null;
  latestForge: WorkspaceGitRuntimeSnapshot["forge"] | null;
  latestForgeLoadedAtMs: number | null;
  latestSnapshot: WorkspaceGitRuntimeSnapshot | null;
  latestSnapshotLoadedAtMs: number | null;
  latestFacts: CheckoutSnapshotFacts | null;
  latestFactsLoadedAtMs: number | null;
  factsPromise: Promise<CheckoutSnapshotFacts> | null;
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

interface WorkspaceForgePrStatusPollTarget {
  headRef: string;
  headSha?: string;
  headRepositoryOwner?: string;
}

function buildDefaultWorkspaceGitServiceDeps(): WorkspaceGitServiceDependencies {
  return {
    watch,
    readdir,
    getCheckoutSnapshotFacts,
    getCheckoutStatus,
    getCheckoutShortstat,
    getCheckoutDiff,
    getPullRequestStatus,
    resolveBranchCheckout,
    resolveRepositoryDefaultBranch,
    listBranchSuggestions,
    listPaseoWorktrees,
    resolveAbsoluteGitDir,
    hasOriginRemote,
    runGitFetch,
    runGitCommand,
    now: () => new Date(),
  };
}

function resolveWorkspaceGitServiceDeps(
  deps: Partial<WorkspaceGitServiceDependencies> | undefined,
): WorkspaceGitServiceDependencies {
  return { ...buildDefaultWorkspaceGitServiceDeps(), ...deps };
}

export class WorkspaceGitServiceImpl implements WorkspaceGitService {
  private readonly logger: pino.Logger;
  private readonly paseoHome: string;
  private readonly worktreesRoot: string | undefined;
  private readonly deps: WorkspaceGitServiceDependencies;
  private readonly forgeResolver: ForgeResolver;
  private readonly snapshotUpdatedListeners = new Set<WorkspaceGitSnapshotUpdatedListener>();
  private readonly workspaceTargets = new Map<string, WorkspaceGitTarget>();
  private readonly repoTargets = new Map<string, RepoGitTarget>();
  private readonly workingTreeWatchTargets = new Map<string, WorkingTreeWatchTarget>();
  private readonly workingTreeWatchSetups = new Map<string, Promise<WorkingTreeWatchTarget>>();
  private readonly linuxIgnoredDirsCache = new Map<string, { ignored: Set<string>; ts: number }>();
  private readonly branchValidationCache = new LRUCache<
    string,
    WorkspaceGitAuxiliaryReadCacheEntry<WorkspaceGitBranchValidationResult>
  >({ max: WORKSPACE_GIT_AUXILIARY_CACHE_MAX });
  private readonly localBranchCache = new LRUCache<
    string,
    WorkspaceGitAuxiliaryReadCacheEntry<boolean>
  >({ max: WORKSPACE_GIT_AUXILIARY_CACHE_MAX });
  private readonly branchSuggestionsCache = new LRUCache<
    string,
    WorkspaceGitAuxiliaryReadCacheEntry<WorkspaceGitBranchSuggestion[]>
  >({ max: WORKSPACE_GIT_AUXILIARY_CACHE_MAX });
  private readonly stashListCache = new LRUCache<
    string,
    WorkspaceGitAuxiliaryReadCacheEntry<WorkspaceGitStashEntry[]>
  >({ max: WORKSPACE_GIT_AUXILIARY_CACHE_MAX });
  private readonly worktreeListCache = new LRUCache<
    string,
    WorkspaceGitAuxiliaryReadCacheEntry<WorkspaceGitWorktreeInfo[]>
  >({ max: WORKSPACE_GIT_AUXILIARY_CACHE_MAX });
  private readonly defaultBranchCache = new LRUCache<
    string,
    WorkspaceGitAuxiliaryReadCacheEntry<string>
  >({ max: WORKSPACE_GIT_AUXILIARY_CACHE_MAX });
  private readonly checkoutDiffCache = new LRUCache<
    string,
    WorkspaceGitAuxiliaryReadCacheEntry<CheckoutDiffResult>
  >({ max: WORKSPACE_GIT_CHECKOUT_DIFF_CACHE_MAX });
  constructor(options: WorkspaceGitServiceOptions) {
    this.logger = options.logger.child({ module: "workspace-git-service" });
    this.paseoHome = options.paseoHome;
    this.worktreesRoot = options.worktreesRoot;
    this.deps = resolveWorkspaceGitServiceDeps(options.deps);
    this.forgeResolver = createForgeResolver({
      createService: (forge) => this.deps.forgeOverrides?.[forge] ?? createForgeService(forge),
    });
  }

  resolveForge(cwd: string): Promise<ForgeResolution | null> {
    return this.forgeResolver.resolve(resolve(cwd));
  }

  registerWorkspace(
    params: { cwd: string },
    listener: WorkspaceGitListener,
  ): WorkspaceGitSubscription {
    const cwd = resolve(params.cwd);
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

  onSnapshotUpdated(listener: WorkspaceGitSnapshotUpdatedListener): WorkspaceGitSubscription {
    this.snapshotUpdatedListeners.add(listener);
    return {
      unsubscribe: () => {
        this.snapshotUpdatedListeners.delete(listener);
      },
    };
  }

  async getSnapshot(
    cwd: string,
    options?: WorkspaceGitSnapshotOptions,
  ): Promise<WorkspaceGitRuntimeSnapshot> {
    cwd = resolve(cwd);
    const request = this.normalizeRefreshRequest(options, "getSnapshot", true);
    const target = this.ensureWorkspaceTarget(cwd);
    if (!request.force && target.latestSnapshot) {
      return target.latestSnapshot;
    }

    return this.requestWorkspaceSnapshot(target, request);
  }

  async getCheckout(cwd: string): Promise<ProjectCheckoutLitePayload> {
    const normalizedCwd = resolve(cwd);
    const status = await this.deps.getCheckoutStatus(normalizedCwd, {
      paseoHome: this.paseoHome,
      worktreesRoot: this.worktreesRoot,
      logger: this.logger,
    });
    if (!status.isGit) {
      return checkoutLiteFromGitSnapshot(normalizedCwd, {
        isGit: false,
        currentBranch: null,
        remoteUrl: null,
        repoRoot: null,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      });
    }
    return checkoutLiteFromGitSnapshot(normalizedCwd, {
      isGit: true,
      currentBranch: status.currentBranch,
      remoteUrl: status.remoteUrl,
      repoRoot: status.repoRoot,
      isPaseoOwnedWorktree: status.isPaseoOwnedWorktree,
      mainRepoRoot: status.mainRepoRoot,
    });
  }

  peekSnapshot(cwd: string): WorkspaceGitRuntimeSnapshot | null {
    cwd = resolve(cwd);
    return this.workspaceTargets.get(cwd)?.latestSnapshot ?? null;
  }

  getCheckoutDiff(
    cwd: string,
    options: CheckoutDiffCompare,
    readOptions?: WorkspaceGitReadOptions,
  ): Promise<CheckoutDiffResult> {
    const normalizedCwd = resolve(cwd);
    const normalizedOptions = this.normalizeCheckoutDiffOptions(options);
    const key = this.buildCheckoutDiffCacheKey(normalizedCwd, normalizedOptions);
    return this.readAuxiliaryCache(this.checkoutDiffCache, key, readOptions, () =>
      this.deps.getCheckoutDiff(normalizedCwd, normalizedOptions, {
        paseoHome: this.paseoHome,
        worktreesRoot: this.worktreesRoot,
      }),
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
    const normalizedCwd = resolve(cwd);
    const normalizedRef = ref.trim();
    const key = JSON.stringify(["branch-validation", normalizedCwd, normalizedRef]);
    return this.readAuxiliaryCache(this.branchValidationCache, key, options, () =>
      this.deps.resolveBranchCheckout(normalizedCwd, normalizedRef),
    );
  }

  hasLocalBranch(cwd: string, branch: string, options?: WorkspaceGitReadOptions): Promise<boolean> {
    const normalizedCwd = resolve(cwd);
    const normalizedBranch = branch.trim();
    const ref = `refs/heads/${normalizedBranch}`;
    const key = JSON.stringify(["local-branch", normalizedCwd, ref]);
    return this.readAuxiliaryCache(this.localBranchCache, key, options, async () => {
      const result = await this.deps.runGitCommand(["rev-parse", "--verify", "--quiet", ref], {
        cwd: normalizedCwd,
        envOverlay: READ_ONLY_GIT_ENV,
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
    const normalizedCwd = resolve(cwd);
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
    const normalizedCwd = resolve(cwd);
    const paseoOnly = options?.paseoOnly !== false;
    const key = JSON.stringify(["stashes", normalizedCwd, paseoOnly]);
    return this.readAuxiliaryCache(this.stashListCache, key, readOptions, async () => {
      const { stdout } = await this.deps.runGitCommand(["stash", "list", "--format=%gd%x00%s"], {
        cwd: normalizedCwd,
        envOverlay: READ_ONLY_GIT_ENV,
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
        worktreesRoot: this.worktreesRoot,
      }),
    );
  }

  async resolveRepoRoot(cwd: string, options?: WorkspaceGitReadOptions): Promise<string> {
    const snapshot = await this.getSnapshot(cwd, options);
    if (!snapshot.git.isGit) {
      throw new Error("Create worktree requires a git repository");
    }

    return snapshot.git.isPaseoOwnedWorktree
      ? (snapshot.git.mainRepoRoot ?? snapshot.git.repoRoot ?? resolve(cwd))
      : (snapshot.git.repoRoot ?? resolve(cwd));
  }

  async resolveDefaultBranch(
    cwdOrRepoRoot: string,
    options?: WorkspaceGitReadOptions,
  ): Promise<string> {
    const cwd = resolve(cwdOrRepoRoot);
    const key = JSON.stringify(["default-branch", cwd]);
    return this.readAuxiliaryCache(this.defaultBranchCache, key, options, async () => {
      const defaultBranch = await this.deps.resolveRepositoryDefaultBranch(cwd);
      if (!defaultBranch) {
        throw new Error("Unable to resolve repository default branch");
      }
      return defaultBranch;
    });
  }

  async getProjectSlug(cwd: string, options?: WorkspaceGitReadOptions): Promise<string> {
    const snapshot = await this.getSnapshot(cwd, options);
    return deriveProjectSlug(resolve(cwd), snapshot.git.isGit ? snapshot.git.remoteUrl : null);
  }

  async resolveRepoRemoteUrl(
    cwd: string,
    options?: WorkspaceGitReadOptions,
  ): Promise<string | null> {
    const snapshot = await this.getSnapshot(cwd, options);
    return snapshot.git.remoteUrl;
  }

  async refresh(cwd: string, _options?: { priority?: "normal" | "high" }): Promise<void> {
    cwd = resolve(cwd);
    const target = this.ensureWorkspaceTarget(cwd);
    await this.refreshWorkspaceTarget(target, {
      force: false,
      includeForge: false,
      reason: "refresh",
      notify: true,
    });
    this.scheduleWorkspaceObservationSetup(target);
  }

  async requestWorkingTreeWatch(
    cwd: string,
    onChange: () => void,
  ): Promise<{ repoRoot: string | null; unsubscribe: () => void }> {
    cwd = resolve(cwd);
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
    cwd = resolve(cwd);
    const target = this.workspaceTargets.get(cwd);
    if (target) {
      this.scheduleWorkspaceRefresh(target);
    }
  }

  onWorkspaceStateMayHaveChanged(cwd: string): void {
    const normalizedCwd = resolve(cwd);
    const target = this.workspaceTargets.get(normalizedCwd);
    if (!target || target.closed) {
      return;
    }
    this.invalidateForge(normalizedCwd);
    this.scheduleWorkspaceRefresh(target, {
      force: true,
      includeForge: true,
      reason: "external-state-change",
    });
  }

  /**
   * Drop the resolved forge adapter's cached state for a cwd. Goes through the
   * resolver so it targets the same adapter instance the poller reads — used by
   * git mutations to force a fresh forge status on the next refresh.
   */
  invalidateForge(cwd: string): void {
    this.forgeResolver.invalidate(resolve(cwd));
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
    this.snapshotUpdatedListeners.clear();
  }

  private ensureWorkspaceTarget(cwd: string): WorkspaceGitTarget {
    const existingTarget = this.workspaceTargets.get(cwd);
    if (existingTarget) {
      return existingTarget;
    }

    return this.createWorkspaceTarget(cwd);
  }

  private readAuxiliaryCache<T>(
    cache: LRUCache<string, WorkspaceGitAuxiliaryReadCacheEntry<T>>,
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
      if (ageMs <= WORKSPACE_GIT_AUXILIARY_READ_TTL_MS) {
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
    cache: LRUCache<string, WorkspaceGitAuxiliaryReadCacheEntry<T>>,
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
      pendingDebounceRequest: null,
      selfHealTimer: null,
      forgePrStatusPollSubscription: null,
      forgePrStatusPollKey: null,
      refreshState: { status: "idle" },
      latestGit: null,
      latestGitLoadedAtMs: null,
      latestForge: null,
      latestForgeLoadedAtMs: null,
      latestSnapshot: null,
      latestSnapshotLoadedAtMs: null,
      latestFacts: null,
      latestFactsLoadedAtMs: null,
      factsPromise: null,
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
        includeForge: true,
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
    const facts = await this.getFactsForObservation(target);
    const gitDir = facts?.isGit ? facts.absoluteGitDir : null;
    if (!this.isActiveObservedWorkspaceTarget(target)) {
      return;
    }
    if (!gitDir) {
      target.observationSetupComplete = true;
      return;
    }

    const repoGitRoot =
      facts?.isGit && facts.gitCommonDir
        ? facts.gitCommonDir
        : await this.resolveWorkspaceGitRefsRoot(gitDir);
    if (!this.isActiveObservedWorkspaceTarget(target)) {
      return;
    }
    target.repoGitRoot = repoGitRoot;
    this.startWorkspaceWatchers(target, gitDir, repoGitRoot);
    await this.ensureRepoTarget(target);
    if (this.isActiveObservedWorkspaceTarget(target)) {
      target.observationSetupComplete = true;
    }
  }

  private async getFactsForObservation(
    target: WorkspaceGitTarget,
  ): Promise<CheckoutSnapshotFacts | null> {
    return this.loadCheckoutFacts(target, {
      paseoHome: this.paseoHome,
      logger: this.logger,
      allowRecent: true,
    });
  }

  private loadCheckoutFacts(
    target: WorkspaceGitTarget,
    options: CheckoutContext & { allowRecent: boolean },
  ): Promise<CheckoutSnapshotFacts> {
    if (options.allowRecent && target.latestFacts && target.latestFactsLoadedAtMs !== null) {
      const ageMs = this.deps.now().getTime() - target.latestFactsLoadedAtMs;
      if (ageMs < WORKSPACE_GIT_FACTS_REUSE_TTL_MS) {
        return Promise.resolve(target.latestFacts);
      }
    }

    if (target.factsPromise) {
      return target.factsPromise;
    }

    const { allowRecent: _allowRecent, ...context } = options;
    const promise = this.deps
      .getCheckoutSnapshotFacts(target.cwd, context)
      .then((facts) => {
        target.latestFacts = facts;
        target.latestFactsLoadedAtMs = this.deps.now().getTime();
        return facts;
      })
      .finally(() => {
        if (target.factsPromise === promise) {
          target.factsPromise = null;
        }
      });
    target.factsPromise = promise;
    return promise;
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
        envOverlay: READ_ONLY_GIT_ENV,
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

    const facts = workspaceTarget.latestFacts;
    const hasOrigin =
      facts?.isGit === true
        ? facts.remoteUrl !== null
        : await this.deps.hasOriginRemote(workspaceTarget.cwd);
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
    options?: ScheduledWorkspaceGitRefreshOptions,
  ): void {
    const target =
      typeof targetOrCwd === "string"
        ? this.workspaceTargets.get(resolve(targetOrCwd))
        : targetOrCwd;
    if (!target || target.closed || this.workspaceTargets.get(target.cwd) !== target) {
      return;
    }

    const request = this.buildScheduledRefreshRequest(options);
    target.pendingDebounceRequest = this.mergeRefreshRequests(
      target.pendingDebounceRequest,
      request,
    );

    if (target.debounceTimer) {
      clearTimeout(target.debounceTimer);
    }

    target.debounceTimer = setTimeout(() => {
      if (target.closed || this.workspaceTargets.get(target.cwd) !== target) {
        return;
      }
      target.debounceTimer = null;
      const merged = target.pendingDebounceRequest;
      target.pendingDebounceRequest = null;
      if (merged) {
        void this.refreshWorkspaceTarget(target, merged);
      }
    }, WORKSPACE_GIT_WATCH_DEBOUNCE_MS);
  }

  private startWorkspaceSubscriptionTimers(target: WorkspaceGitTarget): void {
    if (!target.selfHealTimer) {
      target.selfHealTimer = setInterval(() => {
        this.scheduleWorkspaceObservationSetup(target);
        this.refreshWorkspaceTarget(target, {
          force: false,
          includeForge: false,
          reason: "self-heal-git",
          notify: true,
        }).catch((error) => {
          this.logger.warn(
            { err: error, cwd: target.cwd, reason: "self-heal-git" },
            "Failed to run workspace git self-heal refresh",
          );
        });
      }, WORKSPACE_GIT_SELF_HEAL_INTERVAL_MS);
    }

    this.updateForgePrStatusPollForTarget(target);
  }

  private updateForgePrStatusPollForTarget(target: WorkspaceGitTarget): void {
    if (target.listeners.size === 0) {
      this.stopForgePrStatusPollForTarget(target);
      return;
    }

    const git = target.latestGit;
    if (!git?.remoteUrl) {
      this.stopForgePrStatusPollForTarget(target);
      return;
    }

    const resolution = this.forgeResolver.resolveFromRemoteUrl(git.remoteUrl);
    if (!resolution) {
      this.stopForgePrStatusPollForTarget(target);
      return;
    }

    const pollTarget = this.resolveForgePrStatusPollTarget(target);
    const remoteUrl = git.remoteUrl;
    if (!pollTarget) {
      this.stopForgePrStatusPollForTarget(target);
      return;
    }
    const pollKey = buildWorkspaceForgePrStatusPollKey({
      forge: resolution.forge,
      remoteUrl,
      target: pollTarget,
    });
    const previousPollKey = target.forgePrStatusPollKey;
    if (target.forgePrStatusPollKey === pollKey && target.forgePrStatusPollSubscription) {
      return;
    }
    const pollImmediately = previousPollKey !== null && previousPollKey !== pollKey;

    this.stopForgePrStatusPollForTarget(target);
    target.forgePrStatusPollKey = pollKey;
    if (resolution.service.retainCurrentPullRequestStatusPoll) {
      target.forgePrStatusPollSubscription = resolution.service.retainCurrentPullRequestStatusPoll({
        cwd: target.cwd,
        headRef: pollTarget.headRef,
        ...(pollTarget.headSha ? { headSha: pollTarget.headSha } : {}),
        ...(pollTarget.headRepositoryOwner
          ? { headRepositoryOwner: pollTarget.headRepositoryOwner }
          : {}),
        onStatus: (status) => {
          if (!this.isActiveObservedWorkspaceTarget(target)) {
            return;
          }
          this.rememberForgePrStatusSnapshot(
            target,
            buildForgeSnapshotFromStatus(status, resolution.forge),
            {
              notify: true,
            },
          );
        },
        onError: (error) => {
          this.logger.warn(
            {
              err: error,
              cwd: target.cwd,
              forge: resolution.forge,
              headRef: pollTarget.headRef,
              headRepositoryOwner: pollTarget.headRepositoryOwner,
              reason: "self-heal-forge-pr-status",
            },
            "Failed to run forge PR status self-heal refresh",
          );
        },
      });
      return;
    }

    target.forgePrStatusPollSubscription = this.retainGenericForgePrStatusPoll({
      target,
      forge: resolution.forge,
      service: resolution.service,
      pollTarget,
      pollImmediately,
    });
  }

  private retainGenericForgePrStatusPoll({
    target,
    forge,
    service,
    pollTarget,
    pollImmediately,
  }: {
    target: WorkspaceGitTarget;
    forge: string;
    service: ForgeService;
    pollTarget: WorkspaceForgePrStatusPollTarget;
    pollImmediately: boolean;
  }): { unsubscribe: () => void } {
    let closed = false;
    let timer: NodeJS.Timeout | null = null;
    let latestStatus: WorkspaceGitRuntimeSnapshot["forge"]["pullRequest"] =
      target.latestForge?.pullRequest ?? null;
    let consecutiveErrors = 0;

    const schedule = (delayMs: number) => {
      if (closed) {
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        void poll();
      }, delayMs);
    };

    const poll = async () => {
      if (closed || !this.isActiveObservedWorkspaceTarget(target)) {
        return;
      }
      try {
        const status = await service.getCurrentPullRequestStatus({
          cwd: target.cwd,
          headRef: pollTarget.headRef,
          ...(pollTarget.headSha ? { headSha: pollTarget.headSha } : {}),
          ...(pollTarget.headRepositoryOwner
            ? { headRepositoryOwner: pollTarget.headRepositoryOwner }
            : {}),
          reason: "self-heal-forge-pr-status",
        });
        if (!closed && this.isActiveObservedWorkspaceTarget(target)) {
          latestStatus = status;
          consecutiveErrors = 0;
          this.rememberForgePrStatusSnapshot(target, buildForgeSnapshotFromStatus(status, forge), {
            notify: true,
          });
        }
      } catch (error) {
        consecutiveErrors += 1;
        this.logger.warn(
          {
            err: error,
            cwd: target.cwd,
            forge,
            headRef: pollTarget.headRef,
            headRepositoryOwner: pollTarget.headRepositoryOwner,
            reason: "self-heal-forge-pr-status",
          },
          "Failed to run forge PR status self-heal refresh",
        );
      } finally {
        schedule(computeGenericForgeNextInterval(latestStatus, consecutiveErrors));
      }
    };

    // A git-only refresh clears forge state when the commit-aware poll identity
    // changes. Revalidate that new identity immediately instead of leaving the
    // PR panel empty for the full stable polling interval.
    schedule(
      pollImmediately ? 0 : computeGenericForgeNextInterval(latestStatus, consecutiveErrors),
    );
    return {
      unsubscribe: () => {
        closed = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      },
    };
  }

  private resolveForgePrStatusPollTarget(
    target: WorkspaceGitTarget,
  ): WorkspaceForgePrStatusPollTarget | null {
    const git = target.latestGit;
    if (!git?.currentBranch) {
      return null;
    }

    const lookupTarget =
      target.latestFacts?.isGit && target.latestFacts.currentBranch === git.currentBranch
        ? target.latestFacts.pullRequestLookupTarget
        : null;
    if (lookupTarget) {
      return lookupTarget;
    }

    return { headRef: git.currentBranch };
  }

  private stopForgePrStatusPollForTarget(target: WorkspaceGitTarget): void {
    target.forgePrStatusPollSubscription?.unsubscribe();
    target.forgePrStatusPollSubscription = null;
    target.forgePrStatusPollKey = null;
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
        if (target.linuxTreeRefreshQueued) {
          await new Promise((r) => setTimeout(r, LINUX_WATCH_REFRESH_COOLDOWN_MS));
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
    const ignored = await this.loadLinuxIgnoredDirs(rootPath);
    const directories: string[] = [];
    let currentLevel: string[] = [rootPath];
    let capped = false;

    while (currentLevel.length > 0) {
      directories.push(...currentLevel);
      if (directories.length >= LINUX_WATCH_MAX_DIRS) {
        capped = true;
        break;
      }
      const readResults = await Promise.all(
        currentLevel.map((directory) =>
          linuxWatchReaddirLimit(async () => {
            try {
              return await this.deps.readdir(directory, { withFileTypes: true });
            } catch {
              return null;
            }
          }),
        ),
      );
      const nextLevel: string[] = [];
      for (let i = 0; i < currentLevel.length; i += 1) {
        const directory = currentLevel[i];
        const entries = readResults[i];
        if (!directory || !entries) continue;
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name === ".git") {
            continue;
          }
          const childPath = join(directory, entry.name);
          if (ignored.has(childPath)) {
            continue;
          }
          nextLevel.push(childPath);
        }
      }
      currentLevel = nextLevel;
    }

    if (capped) {
      this.logger.warn(
        { rootPath, limit: LINUX_WATCH_MAX_DIRS, walked: directories.length },
        "Linux working tree exceeds watcher cap; skipping deeper directories",
      );
    }

    return directories;
  }

  private async loadLinuxIgnoredDirs(rootPath: string): Promise<Set<string>> {
    const cached = this.linuxIgnoredDirsCache.get(rootPath);
    if (cached && Date.now() - cached.ts < LINUX_WATCH_IGNORE_TTL_MS) {
      return cached.ignored;
    }

    const ignored = new Set<string>();
    try {
      const result = await this.deps.runGitCommand(
        ["ls-files", "-o", "-i", "--directory", "--exclude-standard"],
        { cwd: rootPath, env: READ_ONLY_GIT_ENV },
      );
      for (const raw of result.stdout.split("\n")) {
        if (!raw.endsWith("/")) {
          continue;
        }
        const rel = raw.replace(/\/+$/, "");
        if (!rel) {
          continue;
        }
        ignored.add(resolve(rootPath, rel));
      }
    } catch (error) {
      this.logger.debug(
        { err: error, rootPath },
        "Failed to load gitignore directories; falling back to name-based skip only",
      );
    }

    this.linuxIgnoredDirsCache.set(rootPath, { ignored, ts: Date.now() });
    return ignored;
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
      const needsForcedRefresh = request.force && !target.refreshState.force;
      const needsGitHubRefresh =
        request.force && request.includeForge && !target.refreshState.includeForge;
      if (needsForcedRefresh || needsGitHubRefresh) {
        target.refreshState.queued = this.mergeRefreshRequests(target.refreshState.queued, request);
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
      includeForge: request.includeForge,
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
      includeForge: options?.includeForge ?? true,
      reason: options?.reason ?? defaultReason,
      notify,
    };
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

  private buildScheduledRefreshRequest(
    options: ScheduledWorkspaceGitRefreshOptions | undefined,
  ): WorkspaceGitRefreshRequest {
    return {
      force: options?.force === true,
      includeForge: options?.includeForge ?? false,
      reason: options?.reason ?? "watch",
      notify: true,
    };
  }

  private mergeRefreshRequests(
    pending: WorkspaceGitRefreshRequest | null,
    request: WorkspaceGitRefreshRequest,
  ): WorkspaceGitRefreshRequest {
    if (!pending) {
      return request;
    }

    const force = pending.force || request.force;
    const upgradesForce = request.force && !pending.force;
    const upgradesForge = request.includeForge && !pending.includeForge;
    return {
      force,
      includeForge: pending.includeForge || request.includeForge,
      reason: upgradesForce || upgradesForge ? request.reason : pending.reason,
      notify: pending.notify || request.notify,
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
      state.includeForge = request.includeForge;
    }

    return snapshot;
  }

  private async refreshSnapshot(
    target: WorkspaceGitTarget,
    request: WorkspaceGitRefreshRequest,
  ): Promise<WorkspaceGitRuntimeSnapshot> {
    const facts = await this.refreshGitSnapshot(target, request);
    if (request.includeForge) {
      await this.refreshForgeSnapshot(target, request, facts);
    }

    const snapshot = this.combineSnapshot(target);
    target.latestSnapshotLoadedAtMs = this.deps.now().getTime();
    return snapshot;
  }

  private async refreshGitSnapshot(
    target: WorkspaceGitTarget,
    request: WorkspaceGitRefreshRequest,
  ): Promise<CheckoutSnapshotFacts> {
    const now = this.deps.now();
    target.lastShellOutAtMs = now.getTime();

    const cwd = target.cwd;
    const previousForgePrStatusPollKey = this.getForgePrStatusPollKey(target);
    const baseContext: CheckoutContext = {
      paseoHome: this.paseoHome,
      worktreesRoot: this.worktreesRoot,
      logger: this.logger,
    };
    const facts = await this.loadCheckoutFacts(target, {
      ...baseContext,
      allowRecent: !request.force,
    });
    const context: CheckoutContext = { ...baseContext, facts };
    const checkoutStatus = await this.deps.getCheckoutStatus(cwd, context);
    if (!checkoutStatus.isGit) {
      target.latestGit = buildNotGitSnapshot(cwd).git;
      target.latestGitLoadedAtMs = this.deps.now().getTime();
      target.latestForge = buildForgeUnavailableSnapshot();
      target.latestForgeLoadedAtMs = target.latestGitLoadedAtMs;
      return facts;
    }

    const diffStat = await this.deps
      .getCheckoutShortstat(cwd, context, { force: request.force })
      .catch(() => null);

    target.latestGit = {
      isGit: true,
      repoRoot: checkoutStatus.repoRoot,
      mainRepoRoot: checkoutStatus.mainRepoRoot,
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
    };
    target.latestGitLoadedAtMs = this.deps.now().getTime();

    if (previousForgePrStatusPollKey !== this.getForgePrStatusPollKey(target)) {
      target.latestForge = buildForgeUnavailableSnapshot();
      target.latestForgeLoadedAtMs = target.latestGitLoadedAtMs;
    }
    return facts;
  }

  private async refreshForgeSnapshot(
    target: WorkspaceGitTarget,
    request: WorkspaceGitRefreshRequest,
    facts: CheckoutSnapshotFacts,
  ): Promise<void> {
    const remoteUrl = target.latestGit?.remoteUrl ?? null;
    const resolution = await this.forgeResolver.resolveFromRemoteUrlAsync(remoteUrl);
    // Every forge gates on the resolver alone: a cloud host matches synchronously
    // and a self-hosted/Enterprise host is recognized by the adapter probe (which
    // this async resolution populates), so GitHub Enterprise is no longer gated
    // out by a cloud-only identity check.
    if (!resolution) {
      target.latestForge = buildUnresolvedRemoteForgeSnapshot(remoteUrl);
      target.latestForgeLoadedAtMs = this.deps.now().getTime();
      return;
    }
    const forgeService: ForgeService = resolution.service;
    const forceForge = request.force && request.includeForge;
    if (forceForge) {
      forgeService.invalidate({ cwd: target.cwd });
    }

    const forgeSnapshot = await loadForgeSnapshot({
      cwd: target.cwd,
      forgeService,
      now: this.deps.now(),
      deps: this.deps,
      force: forceForge,
      reason: request.reason,
      facts,
    });
    // Carry the resolved forge (probe-aware) so the wire projection labels
    // self-managed GitLab hosts correctly instead of falling back to "github".
    target.latestForge = { ...forgeSnapshot, forge: resolution.forge };
    target.latestForgeLoadedAtMs = this.deps.now().getTime();
  }

  private combineSnapshot(target: WorkspaceGitTarget): WorkspaceGitRuntimeSnapshot {
    if (!target.latestGit) {
      return target.latestSnapshot ?? buildNotGitSnapshot(target.cwd);
    }

    return {
      cwd: target.cwd,
      git: target.latestGit,
      forge: target.latestForge ?? buildForgeUnavailableSnapshot(),
    };
  }

  private getForgePrStatusPollKey(target: WorkspaceGitTarget): string | null {
    const git = target.latestGit;
    if (!git?.currentBranch || !git.remoteUrl) {
      return null;
    }

    const resolution = this.forgeResolver.resolveFromRemoteUrl(git.remoteUrl);
    if (!resolution) {
      return null;
    }

    const pollTarget = this.resolveForgePrStatusPollTarget(target);
    if (!pollTarget) {
      return null;
    }

    return buildWorkspaceForgePrStatusPollKey({
      forge: resolution.forge,
      remoteUrl: git.remoteUrl,
      target: pollTarget,
    });
  }

  private rememberForgePrStatusSnapshot(
    target: WorkspaceGitTarget,
    github: WorkspaceGitRuntimeSnapshot["forge"],
    options?: { notify?: boolean },
  ): void {
    if (target.closed || this.workspaceTargets.get(target.cwd) !== target) {
      return;
    }

    target.latestForge = github;
    target.latestForgeLoadedAtMs = this.deps.now().getTime();
    this.rememberSnapshot(target, this.combineSnapshot(target), {
      notify: options?.notify,
      forceEmit: false,
    });
  }

  private rememberSnapshot(
    target: WorkspaceGitTarget,
    snapshot: WorkspaceGitRuntimeSnapshot,
    options?: { forceEmit?: boolean; notify?: boolean },
  ): void {
    target.latestSnapshot = snapshot;
    if (target.listeners.size > 0) {
      this.updateForgePrStatusPollForTarget(target);
    }
    const fingerprint = JSON.stringify(snapshot);
    const fingerprintMatches = target.latestFingerprint === fingerprint;
    if (fingerprintMatches && !options?.forceEmit) {
      return;
    }
    target.latestFingerprint = fingerprint;
    if (!options?.notify || target.listeners.size === 0) {
      return;
    }
    for (const listener of target.listeners) {
      listener(snapshot);
    }
    for (const listener of this.snapshotUpdatedListeners) {
      try {
        listener(snapshot);
      } catch (error) {
        this.logger.warn(
          { err: error, cwd: snapshot.cwd },
          "Workspace git snapshot listener threw",
        );
      }
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
            includeForge: false,
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
    this.stopForgePrStatusPollForTarget(target);

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
    if (target.repoWatchPath) {
      this.linuxIgnoredDirsCache.delete(target.repoWatchPath);
    }
  }

  private closeRepoTarget(target: RepoGitTarget): void {
    if (target.intervalId) {
      clearInterval(target.intervalId);
      target.intervalId = null;
    }
    target.workspaceKeys.clear();
  }
}

async function loadForgeSnapshot(options: {
  cwd: string;
  forgeService: ForgeService | null;
  now: Date;
  deps: Pick<WorkspaceGitServiceDependencies, "getPullRequestStatus">;
  force?: boolean;
  reason?: string;
  facts?: CheckoutSnapshotFacts;
}): Promise<WorkspaceGitRuntimeSnapshot["forge"]> {
  const forgeService = options.forgeService;
  if (!forgeService) {
    return buildForgeSnapshot("no_remote", null, null);
  }

  // GitHub's isAuthenticated throws the precise CLI-missing / auth error; GitLab's
  // and Gitea's return false without throwing (the precise kind surfaces from
  // the PR-status lookup below instead), so probing them here can't change the
  // outcome and would just be a wasted CLI spawn on every refresh.
  if (forgeService.authProbeCanThrow) {
    try {
      await forgeService.isAuthenticated({ cwd: options.cwd });
    } catch (error) {
      return buildForgeSnapshot(forgeAuthStateFromError(error), null, null);
    }
  }

  try {
    const result = await options.deps.getPullRequestStatus(
      options.cwd,
      forgeService,
      {
        force: options.force,
        reason: options.reason,
      },
      { facts: options.facts },
    );
    return buildForgeSnapshot(result.authState, result.status, null);
  } catch (error) {
    // The auth probe succeeded, so a failure here is a command error, not an
    // auth problem — surface it as an error while keeping features enabled.
    return buildForgeSnapshot("authenticated", null, {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function buildForgeSnapshot(
  authState: ForgeAuthState,
  pullRequest: WorkspaceGitRuntimeSnapshot["forge"]["pullRequest"],
  error: WorkspaceGitRuntimeSnapshot["forge"]["error"],
): WorkspaceGitRuntimeSnapshot["forge"] {
  return {
    featuresEnabled: authState === "authenticated",
    authState,
    pullRequest,
    error,
  };
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
    forge: buildForgeUnavailableSnapshot(),
  };
}

function buildForgeUnavailableSnapshot(): WorkspaceGitRuntimeSnapshot["forge"] {
  return buildForgeSnapshot("no_remote", null, null);
}

/**
 * Snapshot for a remote whose host matched no registered forge and no
 * CLI-authenticated host. Deliberate choice: expose the hostname as the open
 * `forge` id with `authState: "unauthenticated"`, because a self-hosted
 * GitLab/Gitea becomes resolvable the moment its CLI is authenticated for
 * that host — so "authenticate" is the actionable next step. The trade-off:
 * a genuinely unsupported host (e.g. Bitbucket) also reads as a login
 * problem; clients that want to distinguish can check the id against the
 * forge registry.
 */
function buildUnresolvedRemoteForgeSnapshot(
  remoteUrl: string | null,
): WorkspaceGitRuntimeSnapshot["forge"] {
  const host = remoteUrl ? parseGitRemoteLocation(remoteUrl)?.host : null;
  if (!host) {
    return buildForgeUnavailableSnapshot();
  }
  return { ...buildForgeSnapshot("unauthenticated", null, null), forge: host };
}

function buildForgeSnapshotFromStatus(
  status: WorkspaceGitRuntimeSnapshot["forge"]["pullRequest"],
  forge: string,
): WorkspaceGitRuntimeSnapshot["forge"] {
  return { ...buildForgeSnapshot("authenticated", status, null), forge };
}

function buildWorkspaceForgePrStatusPollKey({
  forge,
  remoteUrl,
  target,
}: {
  forge: string;
  remoteUrl: string;
  target: WorkspaceForgePrStatusPollTarget;
}): string {
  return JSON.stringify([
    forge,
    remoteUrl,
    target.headRef,
    target.headSha ?? null,
    target.headRepositoryOwner ?? null,
  ]);
}

function computeGenericForgeNextInterval(
  status: WorkspaceGitRuntimeSnapshot["forge"]["pullRequest"],
  consecutiveErrors: number,
): number {
  const isPending =
    status?.checksStatus === "pending" ||
    status?.checks?.some((check) => check.status === "pending") === true;
  const baseInterval = isPending
    ? FORGE_PR_STATUS_POLL_FAST_INTERVAL_MS
    : FORGE_PR_STATUS_POLL_SLOW_INTERVAL_MS;
  if (consecutiveErrors <= 1) {
    return baseInterval;
  }
  return Math.min(
    baseInterval * 2 ** (consecutiveErrors - 1),
    FORGE_PR_STATUS_POLL_ERROR_BACKOFF_CAP_MS,
  );
}

async function runGitFetch(cwd: string): Promise<void> {
  await runGitCommand(["fetch", "origin", "--prune"], {
    cwd,
    envOverlay: { GIT_TERMINAL_PROMPT: "0" },
    timeout: 120_000,
  });
}
