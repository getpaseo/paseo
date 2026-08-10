import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
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
  getCheckoutRefDerivedState,
  getCheckoutSnapshotFacts,
  getCheckoutShortstat,
  getCheckoutStatus,
  getCheckoutWorktreeState,
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
import {
  createRealpathAwarePathMatcher,
  getRealpathAwareRelativePath,
  isRealpathInsideRoot,
} from "../utils/path.js";
import { runGitCommand } from "../utils/run-git-command.js";
import { branchNameFromRef } from "../utils/worktree-metadata.js";
import { listPaseoWorktrees, type PaseoWorktreeInfo } from "../utils/worktree.js";
import { READ_ONLY_GIT_ENV } from "./checkout-git-utils.js";
import { classifyGitMetadataPath, getPrunedGitMetadataPaths } from "./git-metadata-event-rules.js";
import {
  fetchWorkspaceGitRemote,
  type WorkspaceGitFetchResult,
  type WorkspaceGitFetchObserver,
  type WorkspaceGitRemoteRefChange,
} from "./workspace-git-fetch.js";
import { deriveProjectSlug } from "./workspace-git-metadata.js";
import {
  type FileChange,
  type FileObserverDiagnostics,
  type FileObserverCallback,
  type FileObserver,
  type FileObserverOptions,
  type FileObserverSubscription,
  type SubscribeToFileChanges,
  createFileObserver,
} from "./file-observer/index.js";
import { checkoutLiteFromGitSnapshot } from "./workspace-registry-model.js";

const WORKSPACE_GIT_WATCH_DEBOUNCE_MS = 1_000;
const BACKGROUND_GIT_FETCH_INTERVAL_MS = 180_000;
const FETCH_METADATA_ECHO_TTL_MS = 5_000;
export const WORKSPACE_GIT_SELF_HEAL_INTERVAL_MS = 60_000;
const FORGE_PR_STATUS_POLL_FAST_INTERVAL_MS = 20_000;
const FORGE_PR_STATUS_POLL_SLOW_INTERVAL_MS = 120_000;
const FORGE_PR_STATUS_POLL_ERROR_BACKOFF_CAP_MS = 300_000;
const DEGRADED_GIT_POLL_INTERVAL_MS = 5_000;
// Keep whole workspace pipelines below the lower-level Git process pool so daemon control work
// retains subprocess and event-loop headroom during large workspace reconciliation bursts.
export const WORKSPACE_GIT_REFRESH_CONCURRENCY = 4;
export const WORKSPACE_GIT_OBSERVATION_SETUP_CONCURRENCY = 2;
export const WORKSPACE_GIT_WATCHER_SUBSCRIBE_TIMEOUT_MS = 10_000;
const WATCH_RECOVERY_BASE_DELAY_MS = 30_000;
const WATCH_RECOVERY_MAX_ATTEMPTS = 3;
// Auxiliary reads may reuse cached values within this window; snapshots do not expire on read.
const WORKSPACE_GIT_AUXILIARY_READ_TTL_MS = 15_000;
// Non-forced refresh triggers share this minimum gap to absorb watcher/self-heal bursts; force bypasses it.
const WORKSPACE_GIT_INTERNAL_MIN_GAP_MS = 2_000;
// Heavy values (multi-MB highlighted diffs); cap aggressively. Ephemeral worktree cwds would otherwise pile up forever.
const WORKSPACE_GIT_CHECKOUT_DIFF_CACHE_MAX = 64;
// Small values (booleans, short strings, small arrays); generous cap.
const WORKSPACE_GIT_AUXILIARY_CACHE_MAX = 256;

function mergeSets<T>(
  left: ReadonlySet<T>,
  right: ReadonlySet<T>,
): { merged: Set<T>; added: boolean } {
  const merged = new Set(left);
  let added = false;
  for (const value of right) {
    if (!merged.has(value)) {
      merged.add(value);
      added = true;
    }
  }
  return { merged, added };
}

export function getWorkspaceGitSelfHealPhaseMs(cwd: string): number {
  return (
    createHash("sha256").update(cwd).digest().readUInt32BE(0) % WORKSPACE_GIT_SELF_HEAL_INTERVAL_MS
  );
}

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
    upstreamRef: string | null;
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
  getMetrics(): WorkspaceGitServiceMetrics;
  dispose(): void;
}

export interface WorkspaceGitServiceMetrics {
  workspaceTargetCount: number;
  workspaceListenerCount: number;
  repositoryTargetCount: number;
  repositoryWorkspaceLinkCount: number;
  workingTreeWatchTargetCount: number;
  workingTreeWatchListenerCount: number;
  workspaceObservationSetupInFlightCount: number;
  workingTreeWatchSetupInFlightCount: number;
  workspaceRefreshInFlightCount: number;
  workspaceRefreshQueuedCount: number;
  workspaceRefreshAdmissionActiveCount: number;
  workspaceRefreshAdmissionPendingCount: number;
  workspaceObservationSetupAdmissionActiveCount: number;
  workspaceObservationSetupAdmissionPendingCount: number;
  fetchInFlightCount: number;
  snapshotUpdatedListenerCount: number;
  watcherErrorCallbackCount: number;
  fileObserver: FileObserverDiagnostics;
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
  refreshStructure: boolean;
  refreshWorktree: boolean;
  includeForge: boolean;
  emitUnchanged?: boolean;
  reason: string;
  notify: boolean;
  queueIfBusy: boolean;
  movedRemoteRefs: Set<string>;
}

interface ScheduledWorkspaceGitRefreshOptions {
  force?: boolean;
  scope?: "refs" | "structure" | "worktree";
  includeForge?: boolean;
  emitUnchanged?: boolean;
  reason?: string;
  queueIfBusy?: boolean;
  movedRemoteRefs?: ReadonlySet<string>;
}

type WorkspaceGitRefreshState =
  | {
      status: "idle";
    }
  | {
      status: "in-flight";
      promise: Promise<WorkspaceGitRuntimeSnapshot>;
      request: WorkspaceGitRefreshRequest;
      queued: WorkspaceGitRefreshRequest | null;
    };

interface WorkspaceGitServiceDependencies {
  subscribe: SubscribeToFileChanges;
  getCheckoutSnapshotFacts: typeof getCheckoutSnapshotFacts;
  getCheckoutRefDerivedState: typeof getCheckoutRefDerivedState;
  getCheckoutStatus: typeof getCheckoutStatus;
  getCheckoutShortstat: typeof getCheckoutShortstat;
  getCheckoutWorktreeState: typeof getCheckoutWorktreeState;
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
  runGitFetch: (
    cwd: string,
    observer: WorkspaceGitFetchObserver,
  ) => Promise<WorkspaceGitFetchResult>;
  runGitCommand: typeof runGitCommand;
  getWorkspaceGitSelfHealPhaseMs: typeof getWorkspaceGitSelfHealPhaseMs;
  now: () => Date;
}

interface WorkspaceGitServiceOptions {
  logger: pino.Logger;
  paseoHome: string;
  worktreesRoot?: string;
  fileObserver?: FileObserver;
  deps?: Partial<WorkspaceGitServiceDependencies>;
}

class WorkspaceGitServiceDisposedError extends Error {
  constructor() {
    super("WorkspaceGitService is disposed");
    this.name = "WorkspaceGitServiceDisposedError";
  }
}

class WorkspaceGitWatcherSubscriptionTimeoutError extends Error {
  constructor(watchPath: string) {
    super(
      `Watcher subscription for ${watchPath} timed out after ${WORKSPACE_GIT_WATCHER_SUBSCRIBE_TIMEOUT_MS}ms`,
    );
    this.name = "WorkspaceGitWatcherSubscriptionTimeoutError";
  }
}

interface WorkspaceGitTarget {
  cwd: string;
  listeners: Set<WorkspaceGitListener>;
  workingTreeWatchTarget: WorkingTreeWatchTarget | null;
  debounceTimer: NodeJS.Timeout | null;
  pendingDebounceRequest: WorkspaceGitRefreshRequest | null;
  selfHealTimer: NodeJS.Timeout | null;
  forgePrStatusPollSubscription: { unsubscribe: () => void } | null;
  forgePrStatusPollKey: string | null;
  refreshState: WorkspaceGitRefreshState;
  latestGit: WorkspaceGitRuntimeSnapshot["git"] | null;
  latestGitLoadedAtMs: number | null;
  latestStructuralRefreshAtMs: number | null;
  latestWorktreeRefreshAtMs: number | null;
  auditWindowStartedAtMs: number | null;
  latestForge: WorkspaceGitRuntimeSnapshot["forge"] | null;
  latestForgeLoadedAtMs: number | null;
  latestSnapshot: WorkspaceGitRuntimeSnapshot | null;
  latestSnapshotLoadedAtMs: number | null;
  latestFacts: CheckoutSnapshotFacts | null;
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
  subscription: FileObserverSubscription | null;
  fallbackPolling: boolean;
  fallbackPollTimer: NodeJS.Timeout | null;
  recovery: WatchRecoveryState;
  intervalId: NodeJS.Timeout | null;
  fetchInFlight: boolean;
  bufferedFetchMetadataEvents: FileChange[];
  recentFetchRemoteRefChanges: Map<
    string,
    { change: WorkspaceGitRemoteRefChange; expiresAtMs: number }
  >;
  knownRemoteRefs: Set<string> | null;
  closed: boolean;
}

interface RepoMetadataWorkspaceRefresh {
  refreshBase: boolean;
  structural: boolean;
  movedRemoteRefs: Set<string>;
  queueIfBusy: boolean;
}

interface WorkingTreeWatchTarget {
  cwd: string;
  watchPath: string;
  repoRoot: string | null;
  subscription: FileObserverSubscription | null;
  ignoredDirectories: Set<string>;
  ignoredDirectoriesRefreshPromise: Promise<void> | null;
  aliases: Set<string>;
  workspaceKeys: Set<string>;
  fallbackPolling: boolean;
  fallbackPollTimer: NodeJS.Timeout | null;
  recovery: WatchRecoveryState;
  listeners: Set<() => void>;
  closed: boolean;
}

interface WatchRecoveryState {
  attemptCount: number;
  timer: NodeJS.Timeout | null;
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

type WorkingTreeWatchFallbackReason =
  | "not_a_git_checkout"
  | "watcher_error"
  | "watcher_setup_failed"
  | "watcher_update_failed";

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

function buildDefaultWorkspaceGitServiceDeps(
  subscribe: SubscribeToFileChanges,
): WorkspaceGitServiceDependencies {
  return {
    subscribe,
    getCheckoutSnapshotFacts,
    getCheckoutRefDerivedState,
    getCheckoutStatus,
    getCheckoutShortstat,
    getCheckoutWorktreeState,
    getCheckoutDiff,
    getPullRequestStatus,
    resolveBranchCheckout,
    resolveRepositoryDefaultBranch,
    listBranchSuggestions,
    listPaseoWorktrees,
    resolveAbsoluteGitDir,
    hasOriginRemote,
    runGitFetch: fetchWorkspaceGitRemote,
    runGitCommand,
    getWorkspaceGitSelfHealPhaseMs,
    now: () => new Date(),
  };
}

function resolveWorkspaceGitServiceDeps(
  subscribe: SubscribeToFileChanges,
  deps: Partial<WorkspaceGitServiceDependencies> | undefined,
): WorkspaceGitServiceDependencies {
  return { ...buildDefaultWorkspaceGitServiceDeps(subscribe), ...deps };
}

export class WorkspaceGitServiceImpl implements WorkspaceGitService {
  private readonly logger: pino.Logger;
  private readonly paseoHome: string;
  private readonly worktreesRoot: string | undefined;
  private readonly fileObserver: FileObserver;
  private readonly deps: WorkspaceGitServiceDependencies;
  private readonly forgeResolver: ForgeResolver;
  private readonly workspaceRefreshLimit = pLimit({
    concurrency: WORKSPACE_GIT_REFRESH_CONCURRENCY,
    rejectOnClear: true,
  });
  private readonly workspaceObservationSetupLimit = pLimit({
    concurrency: WORKSPACE_GIT_OBSERVATION_SETUP_CONCURRENCY,
    rejectOnClear: true,
  });
  private readonly disposeController = new AbortController();
  private disposed = false;
  private readonly snapshotUpdatedListeners = new Set<WorkspaceGitSnapshotUpdatedListener>();
  private readonly workspaceTargets = new Map<string, WorkspaceGitTarget>();
  private readonly repoTargets = new Map<string, RepoGitTarget>();
  private readonly workingTreeWatchTargets = new Map<string, WorkingTreeWatchTarget>();
  private readonly workingTreeWatchSetups = new Map<string, Promise<WorkingTreeWatchTarget>>();
  private readonly workingTreeWatchResolutions = new Map<string, Promise<WorkingTreeWatchTarget>>();
  private readonly workingTreeWatchAliases = new Map<string, string>();
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
  private watcherErrorCallbackCount = 0;
  constructor(options: WorkspaceGitServiceOptions) {
    this.logger = options.logger.child({ module: "workspace-git-service" });
    this.paseoHome = options.paseoHome;
    this.worktreesRoot = options.worktreesRoot;
    this.fileObserver = options.fileObserver ?? createFileObserver();
    this.deps = resolveWorkspaceGitServiceDeps(
      this.fileObserver.subscribe.bind(this.fileObserver),
      options.deps,
    );
    this.forgeResolver = createForgeResolver({
      createService: (forge) => this.deps.forgeOverrides?.[forge] ?? createForgeService(forge),
    });
  }

  resolveForge(cwd: string): Promise<ForgeResolution | null> {
    this.assertNotDisposed();
    return this.forgeResolver.resolve(resolve(cwd));
  }

  registerWorkspace(
    params: { cwd: string },
    listener: WorkspaceGitListener,
  ): WorkspaceGitSubscription {
    this.assertNotDisposed();
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
    this.assertNotDisposed();
    this.snapshotUpdatedListeners.add(listener);
    return {
      unsubscribe: () => {
        this.snapshotUpdatedListeners.delete(listener);
      },
    };
  }

  getMetrics(): WorkspaceGitServiceMetrics {
    let workspaceListenerCount = 0;
    let repositoryWorkspaceLinkCount = 0;
    let workingTreeWatchListenerCount = 0;
    let workspaceRefreshInFlightCount = 0;
    let workspaceRefreshQueuedCount = 0;
    let workspaceObservationSetupInFlightCount = 0;
    let fetchInFlightCount = 0;

    for (const target of this.workspaceTargets.values()) {
      workspaceListenerCount += target.listeners.size;
      if (target.observationSetupPromise) {
        workspaceObservationSetupInFlightCount += 1;
      }
      if (target.refreshState.status === "in-flight") {
        workspaceRefreshInFlightCount += 1;
        if (target.refreshState.queued) {
          workspaceRefreshQueuedCount += 1;
        }
      }
    }
    for (const target of this.repoTargets.values()) {
      repositoryWorkspaceLinkCount += target.workspaceKeys.size;
      if (target.fetchInFlight) {
        fetchInFlightCount += 1;
      }
    }
    for (const target of this.workingTreeWatchTargets.values()) {
      workingTreeWatchListenerCount += target.listeners.size;
    }

    return {
      workspaceTargetCount: this.workspaceTargets.size,
      workspaceListenerCount,
      repositoryTargetCount: this.repoTargets.size,
      repositoryWorkspaceLinkCount,
      workingTreeWatchTargetCount: this.workingTreeWatchTargets.size,
      workingTreeWatchListenerCount,
      workspaceObservationSetupInFlightCount,
      workingTreeWatchSetupInFlightCount: this.workingTreeWatchSetups.size,
      workspaceRefreshInFlightCount,
      workspaceRefreshQueuedCount,
      workspaceRefreshAdmissionActiveCount: this.workspaceRefreshLimit.activeCount,
      workspaceRefreshAdmissionPendingCount: this.workspaceRefreshLimit.pendingCount,
      workspaceObservationSetupAdmissionActiveCount:
        this.workspaceObservationSetupLimit.activeCount,
      workspaceObservationSetupAdmissionPendingCount:
        this.workspaceObservationSetupLimit.pendingCount,
      fetchInFlightCount,
      snapshotUpdatedListenerCount: this.snapshotUpdatedListeners.size,
      watcherErrorCallbackCount: this.watcherErrorCallbackCount,
      fileObserver: this.fileObserver.getDiagnostics(),
    };
  }

  async getSnapshot(
    cwd: string,
    options?: WorkspaceGitSnapshotOptions,
  ): Promise<WorkspaceGitRuntimeSnapshot> {
    this.assertNotDisposed();
    cwd = resolve(cwd);
    const request = this.normalizeRefreshRequest(options, "getSnapshot", true);
    const target = this.ensureWorkspaceTarget(cwd);
    if (!request.force && target.latestSnapshot) {
      return target.latestSnapshot;
    }

    return this.requestWorkspaceSnapshot(target, request);
  }

  async getCheckout(cwd: string): Promise<ProjectCheckoutLitePayload> {
    this.assertNotDisposed();
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
    this.assertNotDisposed();
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

  private invalidateCheckoutDiffCache(cwd: string, mode: CheckoutDiffCompare["mode"]): void {
    for (const key of this.checkoutDiffCache.keys()) {
      const [kind, cachedCwd, cachedMode] = JSON.parse(key) as unknown[];
      if (kind === "checkout-diff" && cachedCwd === cwd && cachedMode === mode) {
        this.checkoutDiffCache.delete(key);
      }
    }
  }

  validateBranchRef(
    cwd: string,
    ref: string,
    options?: WorkspaceGitReadOptions,
  ): Promise<WorkspaceGitBranchValidationResult> {
    this.assertNotDisposed();
    const normalizedCwd = resolve(cwd);
    const normalizedRef = ref.trim();
    const key = JSON.stringify(["branch-validation", normalizedCwd, normalizedRef]);
    return this.readAuxiliaryCache(this.branchValidationCache, key, options, () =>
      this.deps.resolveBranchCheckout(normalizedCwd, normalizedRef),
    );
  }

  hasLocalBranch(cwd: string, branch: string, options?: WorkspaceGitReadOptions): Promise<boolean> {
    this.assertNotDisposed();
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
    this.assertNotDisposed();
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
    this.assertNotDisposed();
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
    this.assertNotDisposed();
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
    this.assertNotDisposed();
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
    this.assertNotDisposed();
    cwd = resolve(cwd);
    const target = this.ensureWorkspaceTarget(cwd);
    await this.refreshWorkspaceTarget(target, {
      force: false,
      refreshStructure: true,
      refreshWorktree: true,
      includeForge: false,
      reason: "refresh",
      notify: true,
      queueIfBusy: false,
      movedRemoteRefs: new Set(),
    });
    this.scheduleWorkspaceObservationSetup(target);
  }

  async requestWorkingTreeWatch(
    cwd: string,
    onChange: () => void,
  ): Promise<{ repoRoot: string | null; unsubscribe: () => void }> {
    this.assertNotDisposed();
    cwd = resolve(cwd);
    const target = await this.ensureWorkingTreeWatchTarget(cwd);
    target.listeners.add(onChange);

    return {
      repoRoot: target.repoRoot,
      unsubscribe: () => {
        this.removeWorkingTreeWatchListener(target.cwd, onChange);
      },
    };
  }

  scheduleRefreshForCwd(cwd: string): void {
    this.assertNotDisposed();
    cwd = resolve(cwd);
    const target = this.workspaceTargets.get(cwd);
    if (target) {
      this.scheduleWorkspaceRefresh(target, { queueIfBusy: false });
    }
  }

  onWorkspaceStateMayHaveChanged(cwd: string): void {
    this.assertNotDisposed();
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
    this.assertNotDisposed();
    this.forgeResolver.invalidate(resolve(cwd));
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.disposeController.abort(new WorkspaceGitServiceDisposedError());
    this.workspaceRefreshLimit.clearQueue();
    this.workspaceObservationSetupLimit.clearQueue();

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
    this.workingTreeWatchResolutions.clear();
    this.workingTreeWatchAliases.clear();
    this.snapshotUpdatedListeners.clear();
    void this.fileObserver.close();
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new WorkspaceGitServiceDisposedError();
    }
  }

  private ensureWorkspaceTarget(cwd: string): WorkspaceGitTarget {
    this.assertNotDisposed();
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
    this.assertNotDisposed();
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

  private ensureWorkingTreeWatchTarget(cwd: string): Promise<WorkingTreeWatchTarget> {
    this.assertNotDisposed();
    const targetCwd = this.workingTreeWatchAliases.get(cwd);
    if (targetCwd) {
      const existingTarget = this.workingTreeWatchTargets.get(targetCwd);
      if (existingTarget) {
        return Promise.resolve(existingTarget);
      }
      this.workingTreeWatchAliases.delete(cwd);
    }

    const existingResolution = this.workingTreeWatchResolutions.get(cwd);
    if (existingResolution) {
      return existingResolution;
    }

    const resolution = this.resolveWorkingTreeWatchTarget(cwd).finally(() => {
      if (this.workingTreeWatchResolutions.get(cwd) === resolution) {
        this.workingTreeWatchResolutions.delete(cwd);
      }
    });
    this.workingTreeWatchResolutions.set(cwd, resolution);
    return resolution;
  }

  private async resolveWorkingTreeWatchTarget(cwd: string): Promise<WorkingTreeWatchTarget> {
    const repoRoot = await this.resolveCheckoutWatchRoot(cwd);
    const targetCwd = repoRoot ?? cwd;
    const existingTarget = this.workingTreeWatchTargets.get(targetCwd);
    if (existingTarget) {
      this.rememberWorkingTreeWatchAlias(existingTarget, cwd);
      return existingTarget;
    }

    const existingSetup = this.workingTreeWatchSetups.get(targetCwd);
    if (existingSetup) {
      const target = await existingSetup;
      this.rememberWorkingTreeWatchAlias(target, cwd);
      return target;
    }

    const watchPath = repoRoot && createRealpathAwarePathMatcher(repoRoot)(cwd) ? cwd : targetCwd;
    const setup = this.createWorkingTreeWatchTarget(targetCwd, watchPath, repoRoot).finally(() => {
      if (this.workingTreeWatchSetups.get(targetCwd) === setup) {
        this.workingTreeWatchSetups.delete(targetCwd);
      }
    });
    this.workingTreeWatchSetups.set(targetCwd, setup);
    const target = await setup;
    this.rememberWorkingTreeWatchAlias(target, cwd);
    return target;
  }

  private rememberWorkingTreeWatchAlias(target: WorkingTreeWatchTarget, cwd: string): void {
    target.aliases.add(cwd);
    this.workingTreeWatchAliases.set(cwd, target.cwd);
  }

  private createWorkspaceTarget(cwd: string): WorkspaceGitTarget {
    const target: WorkspaceGitTarget = {
      cwd,
      listeners: new Set(),
      workingTreeWatchTarget: null,
      debounceTimer: null,
      pendingDebounceRequest: null,
      selfHealTimer: null,
      forgePrStatusPollSubscription: null,
      forgePrStatusPollKey: null,
      refreshState: { status: "idle" },
      latestGit: null,
      latestGitLoadedAtMs: null,
      latestStructuralRefreshAtMs: null,
      latestWorktreeRefreshAtMs: null,
      auditWindowStartedAtMs: null,
      latestForge: null,
      latestForgeLoadedAtMs: null,
      latestSnapshot: null,
      latestSnapshotLoadedAtMs: null,
      latestFacts: null,
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
        refreshStructure: true,
        refreshWorktree: true,
        includeForge: true,
        reason: "initial",
        notify: true,
        queueIfBusy: false,
        movedRemoteRefs: new Set(),
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

    target.observationSetupPromise = this.workspaceObservationSetupLimit(async () => {
      if (!this.isActiveObservedWorkspaceTarget(target)) {
        return;
      }
      await this.setupWorkspaceObservation(target);
    })
      .catch((error) => {
        if (this.disposed || !this.isActiveObservedWorkspaceTarget(target)) {
          return;
        }
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
    if (!this.isActiveObservedWorkspaceTarget(target)) {
      return;
    }
    const watchCwd = facts.isGit ? facts.worktreeRoot : target.cwd;
    const workingTreeTargetPromise = this.ensureWorkingTreeWatchTarget(watchCwd);
    const workingTreeTarget = await workingTreeTargetPromise;
    if (!this.isActiveObservedWorkspaceTarget(target)) {
      queueMicrotask(() => this.closeWorkingTreeWatchTargetIfUnused(workingTreeTarget));
      return;
    }
    if (target.workingTreeWatchTarget !== workingTreeTarget) {
      if (target.workingTreeWatchTarget) {
        this.removeWorkspaceWorkingTreeLink(target.workingTreeWatchTarget, target.cwd);
      }
      target.workingTreeWatchTarget = workingTreeTarget;
    }
    workingTreeTarget.workspaceKeys.add(target.cwd);

    if (!facts.isGit || !facts.absoluteGitDir) {
      target.observationSetupComplete = true;
      return;
    }
    await this.promoteWorkingTreeWatchTarget(workingTreeTarget, facts.worktreeRoot);
    const gitDir = facts.absoluteGitDir;
    const repoGitRoot = facts.gitCommonDir ?? (await this.resolveWorkspaceGitRefsRoot(gitDir));
    if (!this.isActiveObservedWorkspaceTarget(target)) {
      return;
    }
    target.repoGitRoot = repoGitRoot;
    await this.ensureRepoTarget(target);
    if (this.isActiveObservedWorkspaceTarget(target)) {
      target.observationSetupComplete = true;
    }
  }

  private async getFactsForObservation(target: WorkspaceGitTarget): Promise<CheckoutSnapshotFacts> {
    if (target.latestFacts) {
      return target.latestFacts;
    }
    return this.loadCheckoutFacts(target, {
      paseoHome: this.paseoHome,
      logger: this.logger,
    });
  }

  private loadCheckoutFacts(
    target: WorkspaceGitTarget,
    context: CheckoutContext,
  ): Promise<CheckoutSnapshotFacts> {
    if (target.factsPromise) {
      return target.factsPromise;
    }

    const promise = this.deps
      .getCheckoutSnapshotFacts(target.cwd, context)
      .then((facts) => {
        target.latestFacts = facts;
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

  private async createWorkingTreeWatchTarget(
    cwd: string,
    watchPath: string,
    repoRoot: string | null,
  ): Promise<WorkingTreeWatchTarget> {
    const ignoredDirectories = repoRoot ? await this.loadIgnoredDirs(watchPath) : new Set<string>();
    const target: WorkingTreeWatchTarget = {
      cwd,
      watchPath,
      repoRoot,
      subscription: null,
      ignoredDirectories,
      ignoredDirectoriesRefreshPromise: null,
      aliases: new Set([cwd]),
      workspaceKeys: new Set(),
      fallbackPolling: false,
      fallbackPollTimer: null,
      recovery: { attemptCount: 0, timer: null },
      listeners: new Set(),
      closed: false,
    };

    this.workingTreeWatchTargets.set(cwd, target);
    this.workingTreeWatchAliases.set(cwd, cwd);
    await this.startWorkingTreeSubscription(target);
    this.assertNotDisposed();

    if (repoRoot === null) {
      this.startWorkingTreeWatchFallback(target, "not_a_git_checkout");
    }

    return target;
  }

  private async subscribeWithDeadline(
    watchPath: string,
    callback: FileObserverCallback,
    options: FileObserverOptions,
    onSubscribeSettled: () => void,
  ): Promise<FileObserverSubscription> {
    this.assertNotDisposed();
    const signal = this.disposeController.signal;
    let outcome: "pending" | "accepted" | "expired" = "pending";
    let timeout: NodeJS.Timeout | null = null;
    let removeAbortListener = () => {};
    let unsubscribePromise: Promise<void> | null = null;
    let subscriptionPromise: Promise<FileObserverSubscription>;
    try {
      subscriptionPromise = this.deps
        .subscribe(watchPath, callback, options)
        .finally(onSubscribeSettled);
    } catch (error) {
      onSubscribeSettled();
      throw error;
    }
    void subscriptionPromise.then(
      (subscription) => {
        if (outcome === "expired" || signal.aborted) {
          unsubscribePromise ??= this.unsubscribeWatcherSubscription(subscription, watchPath);
          return unsubscribePromise;
        }
        return undefined;
      },
      () => undefined,
    );
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        outcome = "expired";
        reject(new WorkspaceGitWatcherSubscriptionTimeoutError(watchPath));
      }, WORKSPACE_GIT_WATCHER_SUBSCRIBE_TIMEOUT_MS);
    });
    const disposalPromise = new Promise<never>((_resolve, reject) => {
      const rejectForDisposal = () => {
        outcome = "expired";
        reject(signal.reason);
      };
      if (signal.aborted) {
        rejectForDisposal();
        return;
      }
      signal.addEventListener("abort", rejectForDisposal, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", rejectForDisposal);
    });

    try {
      const subscription = await Promise.race([
        subscriptionPromise,
        timeoutPromise,
        disposalPromise,
      ]);
      if (signal.aborted) {
        outcome = "expired";
        unsubscribePromise ??= this.unsubscribeWatcherSubscription(subscription, watchPath);
        await unsubscribePromise;
        throw signal.reason;
      }
      outcome = "accepted";
      return subscription;
    } finally {
      if (outcome === "pending") {
        outcome = "expired";
      }
      if (timeout) {
        clearTimeout(timeout);
      }
      removeAbortListener();
    }
  }

  private async unsubscribeWatcherSubscription(
    subscription: FileObserverSubscription,
    watchPath: string,
  ): Promise<void> {
    try {
      await subscription.unsubscribe();
    } catch (error) {
      this.logger.warn({ err: error, watchPath }, "Failed to stop watcher subscription");
    }
  }

  private async startWorkingTreeSubscription(
    target: WorkingTreeWatchTarget,
    options?: { replaceFallback?: boolean },
  ): Promise<boolean> {
    const ignore = [join(target.watchPath, ".git"), ...target.ignoredDirectories];
    let watcherErrored = false;
    let subscribeSettled = false;
    const markSubscribeSettled = () => {
      subscribeSettled = true;
      if (watcherErrored) {
        this.scheduleWorkingTreeWatchRecovery(target);
      }
    };
    try {
      const subscription = await this.subscribeWithDeadline(
        target.watchPath,
        (error, events) => {
          if (error) {
            if (watcherErrored) {
              return;
            }
            watcherErrored = true;
            this.watcherErrorCallbackCount += 1;
            this.logger.warn(
              { err: error, cwd: target.cwd },
              "Working tree watcher error; using degraded polling",
            );
            this.degradeWorkingTreeWatch(target, "watcher_error");
            if (subscribeSettled) {
              this.scheduleWorkingTreeWatchRecovery(target);
            }
            return;
          }
          if (watcherErrored) {
            return;
          }
          if (!this.hasRelevantWorkingTreeEvent(target, events)) {
            return;
          }
          this.notifyWorkingTreeChanged(target, "working-tree-watch");
        },
        { ignore },
        markSubscribeSettled,
      );
      if (watcherErrored) {
        await this.unsubscribeWatcherSubscription(subscription, target.watchPath);
        return false;
      }
      if (
        target.closed ||
        (target.fallbackPolling && !options?.replaceFallback) ||
        target.subscription
      ) {
        await this.unsubscribeWatcherSubscription(subscription, target.watchPath);
        return false;
      }
      target.subscription = subscription;
      if (options?.replaceFallback && target.repoRoot !== null) {
        target.fallbackPolling = false;
        if (target.fallbackPollTimer) {
          clearTimeout(target.fallbackPollTimer);
          target.fallbackPollTimer = null;
        }
      }
      return true;
    } catch (error) {
      if (watcherErrored) {
        return false;
      }
      if (this.disposed || target.closed) {
        throw error;
      }
      this.logger.warn(
        { err: error, cwd: target.cwd },
        "Failed to start working tree watcher; using degraded polling",
      );
      if (!options?.replaceFallback) {
        this.startWorkingTreeWatchFallback(target, "watcher_setup_failed");
      }
      return false;
    }
  }

  private startWorkingTreeWatchFallback(
    target: WorkingTreeWatchTarget,
    reason: WorkingTreeWatchFallbackReason,
  ): void {
    if (this.disposed || target.closed || target.fallbackPolling) {
      return;
    }
    target.fallbackPolling = true;
    const { cwd } = target;
    const poll = async () => {
      target.fallbackPollTimer = null;
      if (target.closed || this.workingTreeWatchTargets.get(target.cwd) !== target) {
        return;
      }
      await Promise.all(
        Array.from(target.workspaceKeys, async (workspaceKey) => {
          const workspaceTarget = this.workspaceTargets.get(workspaceKey);
          if (!workspaceTarget) {
            return;
          }
          await this.refreshWorkspaceTarget(workspaceTarget, {
            force: false,
            refreshStructure: target.repoRoot === null,
            refreshWorktree: true,
            includeForge: false,
            reason: "working-tree-watch-fallback",
            notify: true,
            queueIfBusy: true,
            movedRemoteRefs: new Set(),
          });
          if (target.repoRoot === null && workspaceTarget.latestGit?.isGit === true) {
            workspaceTarget.observationSetupComplete = false;
            this.scheduleWorkspaceObservationSetup(workspaceTarget);
          }
        }),
      );
      this.notifyWorkingTreeConsumers(target);
      if (!target.closed && (target.subscription === null || target.repoRoot === null)) {
        target.fallbackPollTimer = setTimeout(poll, DEGRADED_GIT_POLL_INTERVAL_MS);
      } else {
        target.fallbackPolling = false;
      }
    };
    target.fallbackPollTimer = setTimeout(poll, DEGRADED_GIT_POLL_INTERVAL_MS);
    this.logger.warn(
      {
        cwd,
        intervalMs: DEGRADED_GIT_POLL_INTERVAL_MS,
        reason,
      },
      "Working tree watcher unavailable; using bounded polling fallback",
    );
  }

  private degradeWorkingTreeWatch(target: WorkingTreeWatchTarget, reason: "watcher_error"): void {
    const subscription = target.subscription;
    target.subscription = null;
    if (subscription) {
      void this.unsubscribeWatcherSubscription(subscription, target.watchPath);
    }
    this.notifyWorkingTreeChanged(target, "working-tree-watch-error");
    this.startWorkingTreeWatchFallback(target, reason);
  }

  private scheduleWorkingTreeWatchRecovery(target: WorkingTreeWatchTarget): void {
    if (
      target.closed ||
      target.subscription ||
      target.recovery.timer ||
      target.recovery.attemptCount >= WATCH_RECOVERY_MAX_ATTEMPTS
    ) {
      return;
    }
    target.recovery.attemptCount += 1;
    const delayMs = WATCH_RECOVERY_BASE_DELAY_MS * 2 ** (target.recovery.attemptCount - 1);
    target.recovery.timer = setTimeout(() => {
      target.recovery.timer = null;
      void this.recoverWorkingTreeWatch(target);
    }, delayMs);
  }

  private async recoverWorkingTreeWatch(target: WorkingTreeWatchTarget): Promise<void> {
    if (target.closed || target.subscription) {
      return;
    }
    await this.refreshWorkingTreeIgnoredDirectories(target);
    if (target.closed || target.subscription) {
      return;
    }
    const recovered = await this.startWorkingTreeSubscription(target, { replaceFallback: true });
    if (!recovered) {
      this.scheduleWorkingTreeWatchRecovery(target);
      return;
    }
    this.logger.info({ cwd: target.cwd }, "Working tree watcher recovered");
    this.notifyWorkingTreeChanged(target, "working-tree-watch-recovered");
  }

  private async promoteWorkingTreeWatchTarget(
    target: WorkingTreeWatchTarget,
    repoRoot: string,
  ): Promise<void> {
    if (target.repoRoot !== null) {
      return;
    }
    target.repoRoot = repoRoot;
    if (target.subscription && target.fallbackPolling) {
      target.fallbackPolling = false;
      if (target.fallbackPollTimer) {
        clearTimeout(target.fallbackPollTimer);
        target.fallbackPollTimer = null;
      }
    }
    await this.refreshWorkingTreeIgnoredDirectories(target);
  }

  private hasRelevantWorkingTreeEvent(
    target: WorkingTreeWatchTarget,
    events: FileChange[],
  ): boolean {
    const gitDir = join(target.watchPath, ".git");
    const matchesWatchPath = createRealpathAwarePathMatcher(target.watchPath);
    return events.some((event) => {
      // Directory metadata changes at the watch root do not change Git state.
      // FSEvents may emit these when every changed descendant was ignored.
      if (matchesWatchPath(event.path)) {
        return false;
      }
      if (isRealpathInsideRoot(gitDir, event.path)) {
        return false;
      }
      for (const ignoredDirectory of target.ignoredDirectories) {
        if (isRealpathInsideRoot(ignoredDirectory, event.path)) {
          return false;
        }
      }
      return true;
    });
  }

  private refreshWorkingTreeIgnoredDirectories(target: WorkingTreeWatchTarget): Promise<void> {
    if (target.closed || target.repoRoot === null) {
      return Promise.resolve();
    }
    if (target.ignoredDirectoriesRefreshPromise) {
      return target.ignoredDirectoriesRefreshPromise;
    }

    const refreshPromise = this.replaceWorkingTreeIgnoredDirectories(target)
      .catch((error) => {
        this.logger.warn(
          { err: error, cwd: target.cwd },
          "Failed to refresh working tree watcher ignore paths",
        );
      })
      .finally(() => {
        if (target.ignoredDirectoriesRefreshPromise === refreshPromise) {
          target.ignoredDirectoriesRefreshPromise = null;
        }
      });
    target.ignoredDirectoriesRefreshPromise = refreshPromise;
    return refreshPromise;
  }

  private async replaceWorkingTreeIgnoredDirectories(
    target: WorkingTreeWatchTarget,
  ): Promise<void> {
    const ignoredDirectories = await this.loadIgnoredDirs(target.watchPath);
    if (target.closed || this.haveSamePaths(target.ignoredDirectories, ignoredDirectories)) {
      return;
    }

    target.ignoredDirectories = ignoredDirectories;
    if (target.fallbackPolling) {
      return;
    }
    const subscription = target.subscription;
    if (subscription) {
      try {
        await subscription.updateIgnore([join(target.watchPath, ".git"), ...ignoredDirectories]);
      } catch (error) {
        target.subscription = null;
        if (!target.closed && !target.fallbackPolling) {
          this.startWorkingTreeWatchFallback(target, "watcher_update_failed");
          this.scheduleWorkingTreeWatchRecovery(target);
        }
        this.logger.warn(
          { err: error, cwd: target.cwd },
          "Failed to update working tree watcher ignore paths",
        );
        return;
      }
    }
    if (target.closed || target.fallbackPolling) {
      return;
    }
    this.notifyWorkingTreeChanged(target, "working-tree-watch-reconfigured");
  }

  private haveSamePaths(first: Set<string>, second: Set<string>): boolean {
    if (first.size !== second.size) {
      return false;
    }
    for (const path of first) {
      if (!second.has(path)) {
        return false;
      }
    }
    return true;
  }

  private notifyWorkingTreeChanged(target: WorkingTreeWatchTarget, reason: string): void {
    if (target.closed) {
      return;
    }
    this.notifyWorkingTreeConsumers(target);
    this.scheduleWorkingTreeRefreshes(target, reason);
  }

  private notifyWorkingTreeConsumers(target: WorkingTreeWatchTarget): void {
    for (const alias of target.aliases) {
      this.invalidateCheckoutDiffCache(alias, "uncommitted");
    }
    for (const listener of target.listeners) {
      listener();
    }
  }

  private scheduleWorkingTreeRefreshes(target: WorkingTreeWatchTarget, reason: string): void {
    for (const workspaceKey of target.workspaceKeys) {
      const workspaceTarget = this.workspaceTargets.get(workspaceKey);
      if (workspaceTarget) {
        this.scheduleWorkspaceRefresh(workspaceTarget, { scope: "worktree", reason });
      }
    }
  }

  private getWorkingTreeWatchTargetForWorkspace(
    workspaceTarget: WorkspaceGitTarget,
  ): WorkingTreeWatchTarget | null {
    const target = workspaceTarget.workingTreeWatchTarget;
    return target && !target.closed ? target : null;
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

    const repoTarget: RepoGitTarget = {
      repoGitRoot,
      cwd: workspaceTarget.cwd,
      workspaceKeys: new Set([workspaceTarget.cwd]),
      subscription: null,
      fallbackPolling: false,
      fallbackPollTimer: null,
      recovery: { attemptCount: 0, timer: null },
      intervalId: null,
      fetchInFlight: false,
      bufferedFetchMetadataEvents: [],
      recentFetchRemoteRefChanges: new Map(),
      knownRemoteRefs: null,
      closed: false,
    };
    this.repoTargets.set(repoGitRoot, repoTarget);
    await this.startRepoMetadataObservation(repoTarget);
    if (repoTarget.closed || this.repoTargets.get(repoGitRoot) !== repoTarget) {
      return;
    }

    const fetchWorkspaceTarget = Array.from(repoTarget.workspaceKeys)
      .map((workspaceKey) => this.workspaceTargets.get(workspaceKey))
      .find(
        (candidate): candidate is WorkspaceGitTarget =>
          candidate !== undefined && this.isActiveObservedWorkspaceTarget(candidate),
      );
    if (!fetchWorkspaceTarget) {
      return;
    }
    repoTarget.cwd = fetchWorkspaceTarget.cwd;
    const facts = fetchWorkspaceTarget.latestFacts;
    const hasOrigin =
      facts?.isGit === true
        ? facts.remoteUrl !== null
        : await this.deps.hasOriginRemote(fetchWorkspaceTarget.cwd);
    if (repoTarget.closed || this.repoTargets.get(repoGitRoot) !== repoTarget) {
      return;
    }
    if (!hasOrigin) {
      return;
    }
    repoTarget.intervalId = setInterval(() => {
      void this.runRepoFetch(repoTarget);
    }, BACKGROUND_GIT_FETCH_INTERVAL_MS);
    void this.runRepoFetch(repoTarget);
  }

  private async startRepoMetadataObservation(
    target: RepoGitTarget,
    options?: { replaceFallback?: boolean },
  ): Promise<boolean> {
    const ignore = getPrunedGitMetadataPaths("common").map((path) =>
      join(target.repoGitRoot, path),
    );
    const matchesRepoGitRoot = createRealpathAwarePathMatcher(target.repoGitRoot);
    let watcherErrored = false;
    let subscribeSettled = false;
    const markSubscribeSettled = () => {
      subscribeSettled = true;
      if (watcherErrored) {
        this.scheduleRepoMetadataWatchRecovery(target);
      }
    };
    try {
      const subscription = await this.subscribeWithDeadline(
        target.repoGitRoot,
        (error, events) => {
          if (error) {
            if (watcherErrored) {
              return;
            }
            watcherErrored = true;
            this.watcherErrorCallbackCount += 1;
            this.logger.warn(
              { err: error, repoGitRoot: target.repoGitRoot },
              "Repository metadata watcher error; using degraded polling",
            );
            this.degradeRepoMetadataWatch(target);
            if (subscribeSettled) {
              this.scheduleRepoMetadataWatchRecovery(target);
            }
            return;
          }
          if (watcherErrored) {
            return;
          }
          const relevantEvents = events.filter(
            (event) =>
              !matchesRepoGitRoot(event.path) &&
              ignore.every((ignoredPath) => !isRealpathInsideRoot(ignoredPath, event.path)),
          );
          if (relevantEvents.length > 0) {
            const immediateEvents = target.fetchInFlight
              ? relevantEvents.filter((event) => {
                  if (this.isFetchRemoteMetadataEvent(target, event)) {
                    target.bufferedFetchMetadataEvents.push(event);
                    return false;
                  }
                  return true;
                })
              : relevantEvents;
            if (immediateEvents.length > 0) {
              const routedRefreshes = this.routeRepoMetadataEvents(target, immediateEvents);
              this.scheduleRepoMetadataRefresh(
                target,
                "git-metadata-watch",
                routedRefreshes === null || [...routedRefreshes.values()].some((r) => r.structural),
                routedRefreshes,
              );
            }
          }
        },
        { ignore },
        markSubscribeSettled,
      );
      if (watcherErrored) {
        await this.unsubscribeWatcherSubscription(subscription, target.repoGitRoot);
        return false;
      }
      if (
        target.closed ||
        (target.fallbackPolling && !options?.replaceFallback) ||
        this.repoTargets.get(target.repoGitRoot) !== target
      ) {
        await this.unsubscribeWatcherSubscription(subscription, target.repoGitRoot);
        return false;
      }
      target.subscription = subscription;
      if (options?.replaceFallback) {
        target.fallbackPolling = false;
        if (target.fallbackPollTimer) {
          clearTimeout(target.fallbackPollTimer);
          target.fallbackPollTimer = null;
        }
      }
      return true;
    } catch (error) {
      if (watcherErrored) {
        return false;
      }
      if (this.disposed || target.closed) {
        throw error;
      }
      this.logger.warn(
        { err: error, repoGitRoot: target.repoGitRoot },
        "Failed to start repository metadata watcher; using degraded polling",
      );
      if (!options?.replaceFallback) {
        this.startRepoMetadataFallback(target);
      }
      return false;
    }
  }

  private degradeRepoMetadataWatch(target: RepoGitTarget): void {
    const subscription = target.subscription;
    target.subscription = null;
    if (subscription) {
      void this.unsubscribeWatcherSubscription(subscription, target.repoGitRoot);
    }
    this.scheduleRepoMetadataRefresh(target, "git-metadata-watch-error", true);
    this.startRepoMetadataFallback(target);
  }

  private scheduleRepoMetadataWatchRecovery(target: RepoGitTarget): void {
    if (
      target.closed ||
      target.subscription ||
      target.recovery.timer ||
      target.recovery.attemptCount >= WATCH_RECOVERY_MAX_ATTEMPTS
    ) {
      return;
    }
    target.recovery.attemptCount += 1;
    const delayMs = WATCH_RECOVERY_BASE_DELAY_MS * 2 ** (target.recovery.attemptCount - 1);
    target.recovery.timer = setTimeout(() => {
      target.recovery.timer = null;
      void this.recoverRepoMetadataWatch(target);
    }, delayMs);
  }

  private async recoverRepoMetadataWatch(target: RepoGitTarget): Promise<void> {
    if (target.closed || target.subscription) {
      return;
    }
    const recovered = await this.startRepoMetadataObservation(target, { replaceFallback: true });
    if (!recovered) {
      this.scheduleRepoMetadataWatchRecovery(target);
      return;
    }
    this.logger.info({ repoGitRoot: target.repoGitRoot }, "Repository metadata watcher recovered");
  }

  private routeRepoMetadataEvents(
    target: RepoGitTarget,
    events: FileChange[],
  ): Map<string, RepoMetadataWorkspaceRefresh> | null {
    const refreshes = new Map<string, RepoMetadataWorkspaceRefresh>();
    const matchesRepoGitRoot = createRealpathAwarePathMatcher(target.repoGitRoot);

    for (const event of events) {
      if (!this.routeRepoMetadataEvent(target, event, matchesRepoGitRoot, refreshes)) return null;
    }

    return refreshes;
  }

  private isFetchRemoteMetadataEvent(target: RepoGitTarget, event: FileChange): boolean {
    const relativePath = getRealpathAwareRelativePath(target.repoGitRoot, event.path);
    const effect = classifyGitMetadataPath("common", relativePath ?? "");
    return (
      (effect.kind === "ref" && effect.namespace === "remote") ||
      (effect.kind === "all" &&
        (relativePath === "packed-refs" || relativePath?.startsWith("reftable/") === true))
    );
  }

  private routeRepoMetadataEvent(
    target: RepoGitTarget,
    event: FileChange,
    matchesRepoGitRoot: ReturnType<typeof createRealpathAwarePathMatcher>,
    refreshes: Map<string, RepoMetadataWorkspaceRefresh>,
  ): boolean {
    if (this.routePrivateGitDirEvent(target, event, matchesRepoGitRoot, refreshes)) return true;

    const commonRelativePath = getRealpathAwareRelativePath(target.repoGitRoot, event.path);
    const effect = classifyGitMetadataPath("common", commonRelativePath ?? "");
    switch (effect.kind) {
      case "ignore":
        return true;
      case "owner":
        this.routeMainCheckoutMetadata(target, matchesRepoGitRoot, effect.refreshBase, refreshes);
        return true;
      case "ref":
        if (effect.namespace === "local") {
          this.routeLocalBranchRef(target, effect.ref, refreshes);
        } else {
          if (event.type === "delete") {
            target.recentFetchRemoteRefChanges.delete(effect.ref);
            target.knownRemoteRefs = null;
            return false;
          }
          const recent = target.recentFetchRemoteRefChanges.get(effect.ref);
          if (recent && recent.expiresAtMs >= this.deps.now().getTime()) {
            this.routeRemoteBranchRef(target, effect.ref, refreshes, {
              narrow: recent.change.kind === "moved",
            });
          } else {
            target.recentFetchRemoteRefChanges.delete(effect.ref);
            if (target.knownRemoteRefs?.has(effect.ref)) {
              this.routeRemoteBranchRef(target, effect.ref, refreshes, { narrow: true });
            } else if (
              event.type === "create" &&
              target.knownRemoteRefs &&
              [...target.knownRemoteRefs].some((ref) => ref.startsWith(`${effect.ref}/`))
            ) {
              return true;
            } else {
              return false;
            }
          }
        }
        return true;
      case "all":
        if (
          commonRelativePath === "packed-refs" ||
          commonRelativePath?.startsWith("reftable/") === true
        ) {
          target.knownRemoteRefs = null;
        }
        return false;
    }
  }

  private routePrivateGitDirEvent(
    target: RepoGitTarget,
    event: FileChange,
    matchesRepoGitRoot: ReturnType<typeof createRealpathAwarePathMatcher>,
    refreshes: Map<string, RepoMetadataWorkspaceRefresh>,
  ): boolean {
    let matched = false;
    for (const workspaceKey of target.workspaceKeys) {
      const facts = this.workspaceTargets.get(workspaceKey)?.latestFacts;
      if (!facts?.isGit || !facts.absoluteGitDir || matchesRepoGitRoot(facts.absoluteGitDir)) {
        continue;
      }
      const relativePath = getRealpathAwareRelativePath(facts.absoluteGitDir, event.path);
      if (relativePath === null) continue;
      matched = true;
      const effect = classifyGitMetadataPath("worktree", relativePath);
      if (effect.kind === "owner") {
        this.addWorkspaceMetadataRefresh(refreshes, workspaceKey, effect.refreshBase);
      } else if (effect.kind !== "ignore") {
        throw new Error(`Invalid ${effect.kind} effect for worktree metadata`);
      }
    }
    return matched;
  }

  private routeMainCheckoutMetadata(
    target: RepoGitTarget,
    matchesRepoGitRoot: ReturnType<typeof createRealpathAwarePathMatcher>,
    refreshBase: boolean,
    refreshes: Map<string, RepoMetadataWorkspaceRefresh>,
  ): void {
    for (const workspaceKey of target.workspaceKeys) {
      const facts = this.workspaceTargets.get(workspaceKey)?.latestFacts;
      if (facts?.isGit && facts.absoluteGitDir && matchesRepoGitRoot(facts.absoluteGitDir)) {
        this.addWorkspaceMetadataRefresh(refreshes, workspaceKey, refreshBase);
      }
    }
  }

  private routeLocalBranchRef(
    target: RepoGitTarget,
    branch: string,
    refreshes: Map<string, RepoMetadataWorkspaceRefresh>,
  ): void {
    for (const workspaceKey of target.workspaceKeys) {
      const facts = this.workspaceTargets.get(workspaceKey)?.latestFacts;
      if (!facts?.isGit) continue;
      const dependentRefs = [
        facts.storedBaseRef,
        facts.resolvedBaseRef,
        facts.comparisonBaseRef,
        facts.upstreamStatus?.ref,
      ];
      const usesBranch = dependentRefs.some(
        (ref) => ref === branch || ref === `refs/heads/${branch}`,
      );
      if (facts.currentBranch === branch || usesBranch) {
        this.addWorkspaceMetadataRefresh(refreshes, workspaceKey, true);
      }
    }
  }

  private routeRemoteBranchRef(
    target: RepoGitTarget,
    remoteRef: string,
    refreshes: Map<string, RepoMetadataWorkspaceRefresh>,
    options?: { narrow?: boolean; queueIfBusy?: boolean },
  ): void {
    const qualifiedRemoteRef = `refs/remotes/${remoteRef}`;
    for (const workspaceKey of target.workspaceKeys) {
      const facts = this.workspaceTargets.get(workspaceKey)?.latestFacts;
      if (!facts?.isGit) continue;
      const trackedBranch = facts.branchMergeRef?.startsWith("refs/heads/")
        ? facts.branchMergeRef.slice("refs/heads/".length)
        : null;
      const configuredRemoteRef =
        facts.branchRemoteName && facts.branchRemoteName !== "." && trackedBranch
          ? `${facts.branchRemoteName}/${trackedBranch}`
          : null;
      const shortstatRemoteRef =
        facts.currentBranch &&
        (!facts.resolvedBaseRef || branchNameFromRef(facts.resolvedBaseRef) === facts.currentBranch)
          ? `origin/${facts.currentBranch}`
          : null;
      const refs = [
        facts.storedBaseRef,
        facts.resolvedBaseRef,
        facts.comparisonBaseRef,
        facts.upstreamStatus?.ref,
        configuredRemoteRef,
        shortstatRemoteRef,
      ];
      const usesRemoteRef = refs.some((ref) => ref === remoteRef || ref === qualifiedRemoteRef);
      if (usesRemoteRef) {
        this.addWorkspaceMetadataRefresh(refreshes, workspaceKey, true, {
          structural: options?.narrow !== true,
          movedRemoteRef: options?.narrow === true ? remoteRef : undefined,
          queueIfBusy: options?.queueIfBusy,
        });
      }
    }
  }

  private addWorkspaceMetadataRefresh(
    refreshes: Map<string, RepoMetadataWorkspaceRefresh>,
    workspaceKey: string,
    refreshBase: boolean,
    options?: {
      structural?: boolean;
      movedRemoteRef?: string;
      queueIfBusy?: boolean;
    },
  ): void {
    const previous = refreshes.get(workspaceKey);
    const movedRemoteRefs = new Set(previous?.movedRemoteRefs);
    if (options?.movedRemoteRef) {
      movedRemoteRefs.add(options.movedRemoteRef);
    }
    refreshes.set(workspaceKey, {
      refreshBase: previous?.refreshBase === true || refreshBase,
      structural: previous?.structural === true || options?.structural !== false,
      movedRemoteRefs,
      queueIfBusy: (previous?.queueIfBusy ?? false) || (options?.queueIfBusy ?? true),
    });
  }

  private scheduleRepoMetadataRefresh(
    target: RepoGitTarget,
    reason: string,
    refreshWorktree: boolean,
    routedRefreshes: Map<string, RepoMetadataWorkspaceRefresh> | null = null,
  ): void {
    if (target.closed || this.repoTargets.get(target.repoGitRoot) !== target) {
      return;
    }
    const workingTreeTargets = new Set<WorkingTreeWatchTarget>();
    const refreshes =
      routedRefreshes ??
      new Map(
        Array.from(target.workspaceKeys, (workspaceKey) => [
          workspaceKey,
          {
            refreshBase: true,
            structural: true,
            movedRemoteRefs: new Set<string>(),
            queueIfBusy: true,
          },
        ]),
      );
    for (const [workspaceKey, refresh] of refreshes) {
      const workspaceTarget = this.workspaceTargets.get(workspaceKey);
      if (workspaceTarget) {
        let scope: ScheduledWorkspaceGitRefreshOptions["scope"];
        if (!refreshWorktree) {
          scope = refresh.structural ? "structure" : "refs";
        }
        if (refresh.refreshBase) {
          this.invalidateCheckoutDiffCache(workspaceTarget.cwd, "base");
          if (workspaceTarget.latestFacts?.isGit) {
            this.invalidateCheckoutDiffCache(workspaceTarget.latestFacts.worktreeRoot, "base");
          }
        }
        if (refreshWorktree) {
          const workingTreeTarget = this.getWorkingTreeWatchTargetForWorkspace(workspaceTarget);
          if (workingTreeTarget) {
            workingTreeTargets.add(workingTreeTarget);
          }
        }
        this.scheduleWorkspaceRefresh(workspaceTarget, {
          scope,
          emitUnchanged: refresh.refreshBase,
          reason,
          queueIfBusy: refresh.queueIfBusy,
          movedRemoteRefs: refresh.movedRemoteRefs,
        });
      }
    }
    for (const workingTreeTarget of workingTreeTargets) {
      this.notifyWorkingTreeConsumers(workingTreeTarget);
    }
  }

  private startRepoMetadataFallback(target: RepoGitTarget): void {
    if (target.fallbackPolling || target.closed) {
      return;
    }
    target.fallbackPolling = true;
    const poll = async () => {
      target.fallbackPollTimer = null;
      if (target.closed || this.repoTargets.get(target.repoGitRoot) !== target) {
        return;
      }
      const workingTreeTargets = new Set<WorkingTreeWatchTarget>();
      await Promise.all(
        Array.from(target.workspaceKeys, async (workspaceKey) => {
          const workspaceTarget = this.workspaceTargets.get(workspaceKey);
          if (!workspaceTarget) {
            return;
          }
          this.invalidateCheckoutDiffCache(workspaceTarget.cwd, "base");
          if (workspaceTarget.latestFacts?.isGit) {
            this.invalidateCheckoutDiffCache(workspaceTarget.latestFacts.worktreeRoot, "base");
          }
          const workingTreeTarget = this.getWorkingTreeWatchTargetForWorkspace(workspaceTarget);
          if (workingTreeTarget) {
            workingTreeTargets.add(workingTreeTarget);
          }
          await this.refreshWorkspaceTarget(workspaceTarget, {
            force: false,
            refreshStructure: true,
            refreshWorktree: true,
            includeForge: false,
            emitUnchanged: true,
            reason: "git-metadata-watch-fallback",
            notify: true,
            queueIfBusy: true,
            movedRemoteRefs: new Set(),
          });
        }),
      );
      for (const workingTreeTarget of workingTreeTargets) {
        this.notifyWorkingTreeConsumers(workingTreeTarget);
      }
      if (!target.closed && target.subscription === null) {
        target.fallbackPollTimer = setTimeout(poll, DEGRADED_GIT_POLL_INTERVAL_MS);
      } else {
        target.fallbackPolling = false;
      }
    };
    target.fallbackPollTimer = setTimeout(poll, DEGRADED_GIT_POLL_INTERVAL_MS);
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
      target.auditWindowStartedAtMs = this.deps.now().getTime();
      const runSelfHealTick = () => {
        if (!this.isActiveObservedWorkspaceTarget(target)) {
          target.selfHealTimer = null;
          return;
        }
        target.selfHealTimer = setTimeout(runSelfHealTick, WORKSPACE_GIT_SELF_HEAL_INTERVAL_MS);
        this.scheduleWorkspaceObservationSetup(target);
        const auditWindowStartedAtMs = target.auditWindowStartedAtMs;
        target.auditWindowStartedAtMs = this.deps.now().getTime();
        if (auditWindowStartedAtMs === null) {
          return;
        }
        const workingTreeTarget = this.getWorkingTreeWatchTargetForWorkspace(target);
        if (workingTreeTarget) {
          void this.refreshWorkingTreeIgnoredDirectories(workingTreeTarget);
        }
        const refreshStructure =
          target.latestStructuralRefreshAtMs === null ||
          target.latestStructuralRefreshAtMs < auditWindowStartedAtMs;
        const refreshWorktree =
          refreshStructure ||
          target.latestWorktreeRefreshAtMs === null ||
          target.latestWorktreeRefreshAtMs < auditWindowStartedAtMs;
        if (!refreshStructure && !refreshWorktree) {
          return;
        }
        if (refreshWorktree) {
          if (workingTreeTarget) {
            this.notifyWorkingTreeConsumers(workingTreeTarget);
          }
        }
        this.refreshWorkspaceTarget(target, {
          force: false,
          refreshStructure,
          refreshWorktree,
          includeForge: false,
          reason: "self-heal-git",
          notify: true,
          queueIfBusy: true,
          movedRemoteRefs: new Set(),
        }).catch((error) => {
          this.logger.warn(
            { err: error, cwd: target.cwd, reason: "self-heal-git" },
            "Failed to run workspace git self-heal refresh",
          );
        });
      };
      target.selfHealTimer = setTimeout(
        runSelfHealTick,
        this.deps.getWorkspaceGitSelfHealPhaseMs(target.cwd),
      );
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

  private async loadIgnoredDirs(rootPath: string): Promise<Set<string>> {
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
      if (this.disposed || target.closed) {
        return;
      }
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
      const active = target.refreshState.request;
      const addsWork =
        (request.force && !active.force) ||
        (request.refreshStructure && !active.refreshStructure) ||
        (request.refreshWorktree && !active.refreshWorktree) ||
        (request.includeForge && !active.includeForge) ||
        (request.emitUnchanged === true && active.emitUnchanged !== true) ||
        [...request.movedRemoteRefs].some((ref) => !active.movedRemoteRefs.has(ref));
      if (request.queueIfBusy || addsWork) {
        target.refreshState.queued = this.mergeRefreshRequests(target.refreshState.queued, request);
      }
      return target.refreshState.promise;
    }

    if (!request.force && !request.queueIfBusy && this.shouldThrottleNonForcedRefresh(target)) {
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
      request,
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
      refreshStructure: true,
      refreshWorktree: true,
      includeForge: options?.includeForge ?? true,
      reason: options?.reason ?? defaultReason,
      notify,
      queueIfBusy: false,
      movedRemoteRefs: new Set(),
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
    const scope = options?.scope;
    return {
      force: options?.force === true,
      refreshStructure: scope !== "worktree" && scope !== "refs",
      refreshWorktree: scope !== "structure" && scope !== "refs",
      includeForge: options?.includeForge ?? false,
      emitUnchanged: options?.emitUnchanged,
      reason: options?.reason ?? "watch",
      notify: true,
      queueIfBusy: options?.queueIfBusy ?? true,
      movedRemoteRefs: new Set(options?.movedRemoteRefs),
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
    const upgradesStructure = request.refreshStructure && !pending.refreshStructure;
    const upgradesWorktree = request.refreshWorktree && !pending.refreshWorktree;
    const upgradesForge = request.includeForge && !pending.includeForge;
    const upgradesEmit = request.emitUnchanged === true && pending.emitUnchanged !== true;
    const { merged: movedRemoteRefs, added: upgradesMovedRefs } = mergeSets(
      pending.movedRemoteRefs,
      request.movedRemoteRefs,
    );
    return {
      force,
      refreshStructure: pending.refreshStructure || request.refreshStructure,
      refreshWorktree: pending.refreshWorktree || request.refreshWorktree,
      includeForge: pending.includeForge || request.includeForge,
      emitUnchanged: pending.emitUnchanged === true || request.emitUnchanged === true,
      reason:
        upgradesForce ||
        upgradesStructure ||
        upgradesWorktree ||
        upgradesForge ||
        upgradesEmit ||
        upgradesMovedRefs
          ? request.reason
          : pending.reason,
      notify: pending.notify || request.notify,
      queueIfBusy: pending.queueIfBusy || request.queueIfBusy,
      movedRemoteRefs,
    };
  }

  private async runWorkspaceRefreshLoop(
    target: WorkspaceGitTarget,
    initialRequest: WorkspaceGitRefreshRequest,
  ): Promise<WorkspaceGitRuntimeSnapshot> {
    let request = initialRequest;
    let snapshot = target.latestSnapshot ?? buildNotGitSnapshot(target.cwd);
    let failure: { error: unknown } | null = null;

    while (true) {
      if (
        request.emitUnchanged === true &&
        request.movedRemoteRefs.size === 0 &&
        target.latestSnapshot
      ) {
        this.rememberSnapshot(target, target.latestSnapshot, {
          notify: request.notify,
          forceEmit: true,
        });
      }
      try {
        const admittedSnapshot = await this.workspaceRefreshLimit(() => {
          if (target.closed || this.workspaceTargets.get(target.cwd) !== target) {
            return null;
          }
          return this.refreshSnapshot(target, request);
        });
        if (!admittedSnapshot) {
          break;
        }
        snapshot = admittedSnapshot;
        this.rememberSnapshot(target, snapshot, {
          notify: request.notify,
          forceEmit:
            request.force || (request.emitUnchanged === true && request.movedRemoteRefs.size > 0),
        });
        failure = null;
      } catch (error) {
        failure = { error };
      }

      if (this.disposed || target.closed || this.workspaceTargets.get(target.cwd) !== target) {
        break;
      }

      const state = target.refreshState;
      if (state.status !== "in-flight" || !state.queued) {
        break;
      }

      request = state.queued;
      state.queued = null;
      state.request = request;
    }

    if (failure) {
      throw failure.error;
    }
    return snapshot;
  }

  private async refreshSnapshot(
    target: WorkspaceGitTarget,
    request: WorkspaceGitRefreshRequest,
  ): Promise<WorkspaceGitRuntimeSnapshot> {
    let facts = target.latestFacts;
    if (request.movedRemoteRefs.size > 0 && !request.refreshStructure && !request.refreshWorktree) {
      if (facts?.isGit && target.latestGit?.isGit) {
        try {
          await this.refreshRefDerivedSnapshot(target, facts, request.movedRemoteRefs);
          return this.combineSnapshot(target);
        } catch (error) {
          this.logger.debug(
            { err: error, cwd: target.cwd, movedRemoteRefs: [...request.movedRemoteRefs] },
            "Narrow remote ref refresh failed; using structural refresh",
          );
        }
      }
      facts = await this.refreshGitSnapshot(target, {
        ...request,
        refreshStructure: true,
        refreshWorktree: true,
      });
      return this.combineSnapshot(target);
    }
    if (request.refreshStructure || !facts || !target.latestGit) {
      facts = await this.refreshGitSnapshot(target, request);
    } else if (request.refreshWorktree) {
      await this.refreshWorktreeSnapshot(target, facts);
    }
    if (!facts) {
      facts = await this.refreshGitSnapshot(target, request);
    }
    if (request.includeForge) {
      await this.refreshForgeSnapshot(target, request, facts);
    }

    const snapshot = this.combineSnapshot(target);
    target.latestSnapshotLoadedAtMs = this.deps.now().getTime();
    return snapshot;
  }

  private async refreshRefDerivedSnapshot(
    target: WorkspaceGitTarget,
    facts: Extract<CheckoutSnapshotFacts, { isGit: true }>,
    movedRemoteRefs: ReadonlySet<string>,
  ): Promise<void> {
    const latestGit = target.latestGit;
    if (!latestGit?.isGit) {
      throw new Error("Remote ref refresh requires a warmed Git snapshot");
    }
    target.lastShellOutAtMs = this.deps.now().getTime();
    const derived = await this.deps.getCheckoutRefDerivedState(
      target.cwd,
      facts,
      { aheadBehind: latestGit.aheadBehind, diffStat: latestGit.diffStat },
      movedRemoteRefs,
      { paseoHome: this.paseoHome, worktreesRoot: this.worktreesRoot, logger: this.logger, facts },
    );
    target.latestFacts = { ...facts, upstreamStatus: derived.upstreamStatus };
    target.latestGit = {
      ...latestGit,
      aheadBehind: derived.aheadBehind,
      diffStat: derived.diffStat,
      upstreamRef: derived.upstreamStatus?.ref ?? null,
      aheadOfOrigin: derived.upstreamStatus?.aheadBehind.ahead ?? null,
      behindOfOrigin: derived.upstreamStatus?.aheadBehind.behind ?? null,
    };
    const loadedAtMs = this.deps.now().getTime();
    target.latestGitLoadedAtMs = loadedAtMs;
  }

  private async refreshWorktreeSnapshot(
    target: WorkspaceGitTarget,
    facts: CheckoutSnapshotFacts,
  ): Promise<void> {
    const latestGit = target.latestGit;
    if (!latestGit || !facts.isGit) {
      return;
    }

    target.lastShellOutAtMs = this.deps.now().getTime();
    const context: CheckoutContext = {
      paseoHome: this.paseoHome,
      worktreesRoot: this.worktreesRoot,
      logger: this.logger,
      facts,
    };
    const worktree = await this.deps.getCheckoutWorktreeState(target.cwd, context);
    target.latestGit = {
      ...latestGit,
      isDirty: worktree.isDirty,
      diffStat: worktree.diffStat,
    };
    const loadedAtMs = this.deps.now().getTime();
    target.latestGitLoadedAtMs = loadedAtMs;
    target.latestWorktreeRefreshAtMs = loadedAtMs;
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
    const facts = await this.loadCheckoutFacts(target, baseContext);
    const context: CheckoutContext = { ...baseContext, facts };
    const checkoutStatus = await this.deps.getCheckoutStatus(cwd, context);
    if (!checkoutStatus.isGit) {
      target.latestGit = buildNotGitSnapshot(cwd).git;
      const loadedAtMs = this.deps.now().getTime();
      target.latestGitLoadedAtMs = loadedAtMs;
      target.latestStructuralRefreshAtMs = loadedAtMs;
      target.latestWorktreeRefreshAtMs = loadedAtMs;
      target.latestForge = buildForgeUnavailableSnapshot();
      target.latestForgeLoadedAtMs = target.latestGitLoadedAtMs;
      return facts;
    }

    const refreshWorktree = request.refreshWorktree || target.latestGit === null;
    const diffStat = refreshWorktree
      ? await this.deps
          .getCheckoutShortstat(cwd, context, {
            force: request.force || target.latestGit !== null,
          })
          .catch(() => null)
      : (target.latestGit?.diffStat ?? null);

    target.latestGit = {
      isGit: true,
      repoRoot: checkoutStatus.repoRoot,
      mainRepoRoot: checkoutStatus.mainRepoRoot,
      currentBranch: checkoutStatus.currentBranch,
      remoteUrl: checkoutStatus.remoteUrl,
      isPaseoOwnedWorktree: checkoutStatus.isPaseoOwnedWorktree,
      isDirty: refreshWorktree
        ? checkoutStatus.isDirty
        : (target.latestGit?.isDirty ?? checkoutStatus.isDirty),
      baseRef: checkoutStatus.baseRef,
      aheadBehind: checkoutStatus.aheadBehind,
      upstreamRef: checkoutStatus.upstreamRef,
      aheadOfOrigin: checkoutStatus.aheadOfOrigin,
      behindOfOrigin: checkoutStatus.behindOfOrigin,
      hasRemote: checkoutStatus.hasRemote,
      diffStat,
    };
    const loadedAtMs = this.deps.now().getTime();
    target.latestGitLoadedAtMs = loadedAtMs;
    target.latestStructuralRefreshAtMs = loadedAtMs;
    if (refreshWorktree) {
      target.latestWorktreeRefreshAtMs = loadedAtMs;
    }

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

    let result: WorkspaceGitFetchResult | null = null;
    const eventsBeforeFetchSnapshot: FileChange[] = [];
    try {
      result = await this.deps.runGitFetch(target.cwd, {
        onRefSnapshot: (phase) => {
          const events = target.bufferedFetchMetadataEvents.splice(0);
          if (phase === "before") {
            eventsBeforeFetchSnapshot.push(...events);
          }
        },
      });
    } catch (error) {
      this.logger.warn(
        { err: error, repoGitRoot: target.repoGitRoot, cwd: target.cwd },
        "Background git fetch failed",
      );
    } finally {
      target.fetchInFlight = false;
    }
    this.flushFetchMetadataEvents(target, eventsBeforeFetchSnapshot);
    if (!result || result.changes === null) {
      target.recentFetchRemoteRefChanges.clear();
      target.knownRemoteRefs = null;
      this.flushBufferedFetchMetadataEvents(target);
      if (result) {
        this.logger.warn(
          { err: result.error, repoGitRoot: target.repoGitRoot, cwd: target.cwd },
          "Background git fetch ref classification failed; using structural refresh",
        );
      }
      this.scheduleRepoMetadataRefresh(target, "repo-fetch-unclassified", false);
      return;
    }
    if (result.error) {
      this.logger.warn(
        { err: result.error, repoGitRoot: target.repoGitRoot, cwd: target.cwd },
        "Background git fetch completed with errors after changing refs",
      );
    }
    const expiresAtMs = this.deps.now().getTime() + FETCH_METADATA_ECHO_TTL_MS;
    const remoteRefShapeChanged =
      target.knownRemoteRefs !== null &&
      result.remoteRefs !== undefined &&
      !setsEqual(target.knownRemoteRefs, result.remoteRefs);
    if (result.remoteRefs) {
      target.knownRemoteRefs = new Set(result.remoteRefs);
    }
    target.recentFetchRemoteRefChanges.clear();
    for (const change of result.changes) {
      target.recentFetchRemoteRefChanges.set(change.ref, { change, expiresAtMs });
    }
    this.flushBufferedFetchMetadataEvents(target);
    if (
      result.nonRemoteRefsChanged === true ||
      remoteRefShapeChanged ||
      result.changes.some((change) => change.kind !== "moved")
    ) {
      this.scheduleRepoMetadataRefresh(target, "repo-fetch-ref-shape", false);
      return;
    }
    if (result.changes.length === 0) {
      return;
    }
    const refreshes = new Map<string, RepoMetadataWorkspaceRefresh>();
    for (const change of result.changes) {
      this.routeRemoteBranchRef(target, change.ref, refreshes, { narrow: true });
    }
    this.scheduleRepoMetadataRefresh(target, "repo-fetch", false, refreshes);
  }

  private flushBufferedFetchMetadataEvents(target: RepoGitTarget): void {
    this.flushFetchMetadataEvents(target, target.bufferedFetchMetadataEvents.splice(0));
  }

  private flushFetchMetadataEvents(target: RepoGitTarget, events: FileChange[]): void {
    if (events.length === 0) {
      return;
    }
    const routedRefreshes = this.routeRepoMetadataEvents(target, events);
    this.scheduleRepoMetadataRefresh(
      target,
      "git-metadata-watch-after-fetch",
      routedRefreshes === null ||
        [...routedRefreshes.values()].some((refresh) => refresh.structural),
      routedRefreshes,
    );
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
      } else if (repoTarget?.cwd === target.cwd) {
        repoTarget.cwd = repoTarget.workspaceKeys.values().next().value ?? repoTarget.cwd;
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
    if (target.listeners.size > 0 || target.workspaceKeys.size > 0) {
      return;
    }

    this.closeWorkingTreeWatchTarget(target);
    this.workingTreeWatchTargets.delete(cwd);
  }

  private removeWorkspaceWorkingTreeLink(
    target: WorkingTreeWatchTarget,
    workspaceKey: string,
  ): void {
    target.workspaceKeys.delete(workspaceKey);
    if (target.workspaceKeys.size > 0 || target.listeners.size > 0) {
      return;
    }
    this.closeWorkingTreeWatchTarget(target);
    if (this.workingTreeWatchTargets.get(target.cwd) === target) {
      this.workingTreeWatchTargets.delete(target.cwd);
    }
  }

  private closeWorkingTreeWatchTargetIfUnused(target: WorkingTreeWatchTarget): void {
    if (
      target.closed ||
      target.workspaceKeys.size > 0 ||
      target.listeners.size > 0 ||
      this.workingTreeWatchTargets.get(target.cwd) !== target
    ) {
      return;
    }
    this.closeWorkingTreeWatchTarget(target);
    this.workingTreeWatchTargets.delete(target.cwd);
  }

  private closeWorkspaceTarget(target: WorkspaceGitTarget): void {
    target.closed = true;
    if (target.workingTreeWatchTarget) {
      this.removeWorkspaceWorkingTreeLink(target.workingTreeWatchTarget, target.cwd);
      target.workingTreeWatchTarget = null;
    }
    if (target.debounceTimer) {
      clearTimeout(target.debounceTimer);
      target.debounceTimer = null;
    }
    if (target.selfHealTimer) {
      clearTimeout(target.selfHealTimer);
      target.selfHealTimer = null;
    }
    this.stopForgePrStatusPollForTarget(target);
    target.listeners.clear();
  }

  private closeWorkingTreeWatchTarget(target: WorkingTreeWatchTarget): void {
    target.closed = true;
    for (const alias of target.aliases) {
      if (this.workingTreeWatchAliases.get(alias) === target.cwd) {
        this.workingTreeWatchAliases.delete(alias);
      }
    }
    target.aliases.clear();
    if (target.fallbackPollTimer) {
      clearTimeout(target.fallbackPollTimer);
      target.fallbackPollTimer = null;
    }
    target.fallbackPolling = false;
    if (target.recovery.timer) {
      clearTimeout(target.recovery.timer);
      target.recovery.timer = null;
    }

    if (target.subscription) {
      const subscription = target.subscription;
      target.subscription = null;
      void subscription.unsubscribe().catch((error) => {
        this.logger.warn({ err: error, cwd: target.cwd }, "Failed to stop working tree watcher");
      });
    }
    target.workspaceKeys.clear();
    target.listeners.clear();
  }

  private closeRepoTarget(target: RepoGitTarget): void {
    target.closed = true;
    if (target.intervalId) {
      clearInterval(target.intervalId);
      target.intervalId = null;
    }
    if (target.fallbackPollTimer) {
      clearTimeout(target.fallbackPollTimer);
      target.fallbackPollTimer = null;
    }
    target.fallbackPolling = false;
    if (target.recovery.timer) {
      clearTimeout(target.recovery.timer);
      target.recovery.timer = null;
    }
    if (target.subscription) {
      const subscription = target.subscription;
      target.subscription = null;
      void subscription.unsubscribe().catch((error) => {
        this.logger.warn(
          { err: error, repoGitRoot: target.repoGitRoot },
          "Failed to stop repository metadata watcher",
        );
      });
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
      upstreamRef: null,
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
