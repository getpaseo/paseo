import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import os from "node:os";
import path, { join } from "node:path";
import type { FSWatcher } from "node:fs";
import type pino from "pino";
import type { ForgeService } from "../services/forge-service.js";
import type {
  CheckoutSnapshotFacts,
  CheckoutStatusGit,
  PullRequestStatusResult,
} from "../utils/checkout-git.js";
import {
  WORKSPACE_GIT_OBSERVATION_SETUP_CONCURRENCY,
  WORKSPACE_GIT_REFRESH_CONCURRENCY,
  WorkspaceGitServiceImpl,
  type WorkspaceGitRuntimeSnapshot,
} from "./workspace-git-service.js";
import { isPlatform } from "../test-utils/platform.js";

const REPO_CWD = path.resolve("/tmp/repo");

function createLogger() {
  const logger = {
    child: () => logger,
    debug: vi.fn(),
    warn: vi.fn(),
  };
  return logger;
}

function createSnapshot(
  cwd: string,
  overrides?: {
    git?: Partial<WorkspaceGitRuntimeSnapshot["git"]>;
    forge?: Partial<WorkspaceGitRuntimeSnapshot["forge"]>;
  },
): WorkspaceGitRuntimeSnapshot {
  const base: WorkspaceGitRuntimeSnapshot = {
    cwd,
    git: {
      isGit: true,
      repoRoot: cwd,
      mainRepoRoot: null,
      currentBranch: "main",
      remoteUrl: "https://github.com/acme/repo.git",
      isPaseoOwnedWorktree: false,
      isDirty: false,
      baseRef: "main",
      aheadBehind: { ahead: 0, behind: 0 },
      aheadOfOrigin: 0,
      behindOfOrigin: 0,
      hasRemote: true,
      diffStat: { additions: 1, deletions: 0 },
    },
    forge: {
      featuresEnabled: true,
      pullRequest: {
        url: "https://github.com/acme/repo/pull/123",
        title: "Update feature",
        state: "open",
        baseRefName: "main",
        headRefName: "feature",
        isMerged: false,
      },
      error: null,
    },
  };

  const featuresEnabled = overrides?.forge?.featuresEnabled ?? base.forge.featuresEnabled;
  const authState =
    overrides?.forge?.authState ?? (featuresEnabled ? "authenticated" : "no_remote");
  const forgeName = resolveSnapshotForgeName(featuresEnabled, overrides);
  return {
    cwd,
    git: {
      ...base.git,
      ...overrides?.git,
    },
    forge: {
      ...base.forge,
      ...overrides?.forge,
      featuresEnabled,
      authState,
      ...(forgeName ? { forge: forgeName } : {}),
      pullRequest: resolveSnapshotPullRequest(base, overrides),
      error: resolveSnapshotError(base, overrides),
    },
  };
}

function hasForgeOverride(
  overrides: { forge?: Partial<WorkspaceGitRuntimeSnapshot["forge"]> } | undefined,
  key: keyof WorkspaceGitRuntimeSnapshot["forge"],
): boolean {
  return Boolean(overrides?.forge && key in overrides.forge);
}

function resolveSnapshotForgeName(
  featuresEnabled: boolean,
  overrides: { forge?: Partial<WorkspaceGitRuntimeSnapshot["forge"]> } | undefined,
): string | undefined {
  if (hasForgeOverride(overrides, "forge")) {
    return overrides?.forge?.forge;
  }
  return featuresEnabled ? "github" : undefined;
}

function resolveSnapshotPullRequest(
  base: WorkspaceGitRuntimeSnapshot,
  overrides: { forge?: Partial<WorkspaceGitRuntimeSnapshot["forge"]> } | undefined,
): WorkspaceGitRuntimeSnapshot["forge"]["pullRequest"] {
  if (hasForgeOverride(overrides, "pullRequest")) {
    return overrides?.forge?.pullRequest ?? null;
  }
  return base.forge.pullRequest;
}

function resolveSnapshotError(
  base: WorkspaceGitRuntimeSnapshot,
  overrides: { forge?: Partial<WorkspaceGitRuntimeSnapshot["forge"]> } | undefined,
): WorkspaceGitRuntimeSnapshot["forge"]["error"] {
  if (hasForgeOverride(overrides, "error")) {
    return overrides?.forge?.error ?? null;
  }
  return base.forge.error;
}

function createCheckoutStatus(
  cwd: string,
  overrides?: Partial<CheckoutStatusGit>,
): CheckoutStatusGit {
  return {
    isGit: true,
    repoRoot: cwd,
    mainRepoRoot: null,
    currentBranch: "main",
    isDirty: false,
    baseRef: "main",
    aheadBehind: { ahead: 0, behind: 0 },
    aheadOfOrigin: 0,
    behindOfOrigin: 0,
    hasRemote: true,
    remoteUrl: "https://github.com/acme/repo.git",
    isPaseoOwnedWorktree: false,
    ...overrides,
  };
}

function createCheckoutSnapshotFacts(cwd: string): CheckoutSnapshotFacts {
  return {
    isGit: true,
    worktreeRoot: cwd,
    currentBranch: "main",
    remoteUrl: "https://github.com/acme/repo.git",
    absoluteGitDir: join(cwd, ".git"),
    gitCommonDir: join(cwd, ".git"),
    paseoWorktree: { isPaseoOwnedWorktree: false },
    storedBaseRef: null,
    resolvedBaseRef: "main",
    mainRepoRoot: null,
    comparisonBaseRef: null,
    branchRemoteName: "origin",
    branchMergeRef: "refs/heads/main",
    pullRequestLookupTarget: { headRef: "main" },
  };
}

function createPullRequestStatusResult(
  overrides?: Partial<PullRequestStatusResult>,
): PullRequestStatusResult {
  return {
    status: {
      url: "https://github.com/acme/repo/pull/123",
      title: "Update feature",
      state: "open",
      baseRefName: "main",
      headRefName: "feature",
      isMerged: false,
    },
    authState: "authenticated",
    featuresEnabled: true,
    githubFeaturesEnabled: true,
    ...overrides,
  };
}

function createWatcher(): FSWatcher & { close: ReturnType<typeof vi.fn> } {
  const watcher = {
    close: vi.fn(),
    on: vi.fn().mockReturnThis(),
  };
  return watcher as unknown as FSWatcher & { close: ReturnType<typeof vi.fn> };
}

function createDirent(name: string, isDirectory: boolean) {
  return {
    name,
    isDirectory: () => isDirectory,
  };
}

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createGitHubServiceStub(): ForgeService {
  return {
    listPullRequests: vi.fn(async () => []),
    listIssues: vi.fn(async () => []),
    searchIssuesAndPrs: vi.fn(async () => ({
      items: [],
      featuresEnabled: true,
      githubFeaturesEnabled: true,
    })),
    getPullRequest: vi.fn(async () => ({
      number: 1,
      title: "PR",
      url: "https://github.com/acme/repo/pull/1",
      state: "OPEN",
      body: null,
      baseRefName: "main",
      headRefName: "feature",
      labels: [],
    })),
    getPullRequestHeadRef: vi.fn(async () => "feature"),
    getPullRequestCheckoutTarget: vi.fn(async ({ number }) => ({
      number,
      baseRefName: "main",
      headRefName: "feature",
      headOwnerLogin: null,
      headRepositorySshUrl: null,
      headRepositoryUrl: null,
      isCrossRepository: false,
    })),
    getCurrentPullRequestStatus: vi.fn(async () => null),
    createPullRequest: vi.fn(async () => ({
      url: "https://github.com/acme/repo/pull/1",
      number: 1,
    })),
    mergePullRequest: vi.fn(async () => ({ success: true })),
    isAuthenticated: vi.fn(async () => true),
    authProbeCanThrow: true,
    invalidate: vi.fn(),
  };
}

interface CreateServiceTestOptions {
  getCheckoutStatus?: ReturnType<typeof vi.fn>;
  getCheckoutSnapshotFacts?: ReturnType<typeof vi.fn>;
  getCheckoutShortstat?: ReturnType<typeof vi.fn>;
  getPullRequestStatus?: ReturnType<typeof vi.fn>;
  github?: ForgeService;
  resolveAbsoluteGitDir?: ReturnType<typeof vi.fn>;
  hasOriginRemote?: ReturnType<typeof vi.fn>;
  runGitFetch?: ReturnType<typeof vi.fn>;
  runGitCommand?: ReturnType<typeof vi.fn>;
  readdir?: ReturnType<typeof vi.fn>;
  watch?: ReturnType<typeof vi.fn>;
  now?: () => Date;
}

function buildDefaultTestServiceDeps() {
  return {
    watch: (() => createWatcher()) as unknown as typeof import("node:fs").watch,
    readdir: vi.fn(async () => []),
    getCheckoutSnapshotFacts: vi.fn(async (cwd: string) => createCheckoutSnapshotFacts(cwd)),
    getCheckoutStatus: vi.fn(async (cwd: string) => createCheckoutStatus(cwd)),
    getCheckoutShortstat: vi.fn(async () => ({
      additions: 1,
      deletions: 0,
    })),
    getPullRequestStatus: vi.fn(async () => createPullRequestStatusResult()),
    forgeOverrides: { github: createGitHubServiceStub() },
    resolveAbsoluteGitDir: vi.fn(async () => join(REPO_CWD, ".git")),
    hasOriginRemote: vi.fn(async () => false),
    runGitFetch: vi.fn(async () => {}),
    runGitCommand: vi.fn(async () => ({
      stdout: `${REPO_CWD}\n`,
      stderr: "",
      truncated: false,
      exitCode: 0,
      signal: null,
    })),
    now: () => new Date("2026-04-12T00:00:00.000Z"),
  };
}

function createService(options?: CreateServiceTestOptions) {
  return new WorkspaceGitServiceImpl({
    logger: createLogger() as unknown as pino.Logger,
    paseoHome: "/tmp/paseo-test",
    deps: { ...buildDefaultTestServiceDeps(), ...options },
  });
}

describe("WorkspaceGitServiceImpl", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("registerWorkspace returns a subscription without an initial snapshot contract", async () => {
    const service = createService();

    const listener = vi.fn();
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, listener);

    expect(subscription).toEqual({ unsubscribe: expect.any(Function) });
    expect("initial" in subscription).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(service.peekSnapshot(REPO_CWD)).toBeNull();

    subscription.unsubscribe();
    service.dispose();
  });

  test("onSnapshotUpdated emits only for observed workspace snapshots and can unsubscribe", async () => {
    const service = createService();
    const snapshotListener = vi.fn();
    const snapshotSubscription = service.onSnapshotUpdated(snapshotListener);

    await service.getSnapshot(REPO_CWD, { force: true, reason: "unobserved" });

    expect(snapshotListener).not.toHaveBeenCalled();

    const workspaceSubscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());
    await service.getSnapshot(REPO_CWD, { force: true, reason: "observed" });

    expect(snapshotListener).toHaveBeenCalledTimes(1);
    expect(snapshotListener).toHaveBeenCalledWith(createSnapshot(REPO_CWD));

    snapshotSubscription.unsubscribe();
    await service.getSnapshot(REPO_CWD, { force: true, reason: "after-unsubscribe" });

    expect(snapshotListener).toHaveBeenCalledTimes(1);

    workspaceSubscription.unsubscribe();
    service.dispose();
  });

  test("getSnapshot populates github pull request state in the runtime snapshot", async () => {
    const getPullRequestStatus = vi.fn(async () =>
      createPullRequestStatusResult({
        status: {
          url: "https://github.com/acme/repo/pull/999",
          title: "Ship runtime centralization",
          state: "open",
          baseRefName: "main",
          headRefName: "workspace-git-service",
          isMerged: false,
        },
      }),
    );

    const service = createService({
      getPullRequestStatus,
      now: () => new Date("2026-04-12T02:03:04.000Z"),
    });

    await expect(service.getSnapshot(REPO_CWD)).resolves.toEqual(
      createSnapshot(REPO_CWD, {
        forge: {
          pullRequest: {
            url: "https://github.com/acme/repo/pull/999",
            title: "Ship runtime centralization",
            state: "open",
            baseRefName: "main",
            headRefName: "workspace-git-service",
            isMerged: false,
          },
        },
      }),
    );
    expect(getPullRequestStatus).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  test("getSnapshot does not probe isAuthenticated for a forge adapter that never throws from it", async () => {
    const gitlabIsAuthenticated = vi.fn(async () => false);
    const gitlabStub: ForgeService = {
      ...createGitHubServiceStub(),
      isAuthenticated: gitlabIsAuthenticated,
      authProbeCanThrow: undefined,
    };
    const getPullRequestStatus = vi.fn(async () => createPullRequestStatusResult());

    const service = createService({
      getCheckoutStatus: vi.fn(async (cwd: string) =>
        createCheckoutStatus(cwd, { remoteUrl: "https://gitlab.com/acme/repo.git" }),
      ),
      getPullRequestStatus,
      forgeOverrides: { gitlab: gitlabStub },
    });

    await service.getSnapshot(REPO_CWD);

    expect(gitlabIsAuthenticated).not.toHaveBeenCalled();
    expect(getPullRequestStatus).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  test("getSnapshot keeps plain git classification when shortstat lookup fails", async () => {
    const getCheckoutShortstat = vi.fn(async () => {
      throw new Error(
        "Missing Paseo worktree base metadata: /tmp/repo/.git/worktrees/feature/paseo/worktree.json",
      );
    });
    const service = createService({
      getCheckoutStatus: vi.fn(async (cwd: string) =>
        createCheckoutStatus(cwd, {
          repoRoot: cwd,
          currentBranch: "feature/worktree",
          isPaseoOwnedWorktree: false,
          mainRepoRoot: "/tmp/main-repo",
        }),
      ),
      getCheckoutShortstat,
    });

    await expect(service.getSnapshot(REPO_CWD)).resolves.toEqual(
      createSnapshot(REPO_CWD, {
        git: {
          repoRoot: REPO_CWD,
          currentBranch: "feature/worktree",
          isPaseoOwnedWorktree: false,
          mainRepoRoot: "/tmp/main-repo",
          diffStat: null,
        },
      }),
    );
  });

  test("non-forced workspace refresh does not reload GitHub or emit when state is unchanged", async () => {
    let nowMs = Date.parse("2026-04-12T00:00:00.000Z");
    const getPullRequestStatus = vi.fn(async () => createPullRequestStatusResult());
    const service = createService({
      getPullRequestStatus,
      now: () => new Date(nowMs),
    });
    const listener = vi.fn();
    await service.getSnapshot(REPO_CWD);
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, listener);

    nowMs += 3_000;
    await service.refresh(REPO_CWD);

    expect(getPullRequestStatus).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();

    subscription.unsubscribe();
    service.dispose();
  });

  test("cold getSnapshot calls share one workspace target setup and cache the snapshot", async () => {
    const checkoutStatusDeferred = createDeferred<CheckoutStatusGit>();
    const getCheckoutStatus = vi.fn(async () => checkoutStatusDeferred.promise);
    const getPullRequestStatus = vi.fn(async () => createPullRequestStatusResult());
    const resolveAbsoluteGitDir = vi.fn(async () => join(REPO_CWD, ".git"));

    const service = createService({
      getCheckoutStatus,
      getPullRequestStatus,
      resolveAbsoluteGitDir,
    });

    const firstSnapshotPromise = service.getSnapshot(REPO_CWD);
    const secondSnapshotPromise = service.getSnapshot(join(REPO_CWD, "."));
    await flushPromises();

    expect(getCheckoutStatus).toHaveBeenCalledTimes(1);
    expect(getPullRequestStatus).toHaveBeenCalledTimes(0);
    expect(resolveAbsoluteGitDir).toHaveBeenCalledTimes(0);

    checkoutStatusDeferred.resolve(createCheckoutStatus(REPO_CWD));

    await expect(Promise.all([firstSnapshotPromise, secondSnapshotPromise])).resolves.toEqual([
      createSnapshot(REPO_CWD),
      createSnapshot(REPO_CWD),
    ]);

    expect(getCheckoutStatus).toHaveBeenCalledTimes(1);
    expect(getPullRequestStatus).toHaveBeenCalledTimes(1);
    expect(resolveAbsoluteGitDir).toHaveBeenCalledTimes(0);
    expect(service.peekSnapshot(REPO_CWD)).toEqual(createSnapshot(REPO_CWD));

    await expect(service.getSnapshot(REPO_CWD)).resolves.toEqual(createSnapshot(REPO_CWD));
    expect(getCheckoutStatus).toHaveBeenCalledTimes(1);
    expect(getPullRequestStatus).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  test("bounds and coalesces refresh admission across 120 workspace subscriptions", async () => {
    const workspaceCount = 120;
    const factsGate = createDeferred<void>();
    let activeFactsReads = 0;
    let maxActiveFactsReads = 0;
    const getCheckoutSnapshotFacts = vi.fn(async (cwd: string) => {
      activeFactsReads += 1;
      maxActiveFactsReads = Math.max(maxActiveFactsReads, activeFactsReads);
      await factsGate.promise;
      activeFactsReads -= 1;
      return { ...createCheckoutSnapshotFacts(cwd), remoteUrl: null };
    });
    const watch = vi.fn(() => {
      throw new Error("watch unavailable in admission harness");
    }) as unknown as typeof import("node:fs").watch;
    const getCheckoutStatus = vi.fn(async (cwd: string) => createCheckoutStatus(cwd));
    const service = createService({ getCheckoutSnapshotFacts, getCheckoutStatus, watch });
    const cwds = Array.from({ length: workspaceCount }, (_, index) => `/tmp/repo-${index}`);
    const subscriptions = cwds.map((cwd) => service.registerWorkspace({ cwd }, vi.fn()));

    await flushPromises();

    expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(WORKSPACE_GIT_REFRESH_CONCURRENCY);
    expect(maxActiveFactsReads).toBe(WORKSPACE_GIT_REFRESH_CONCURRENCY);
    expect(service.getMetrics()).toMatchObject({
      workspaceTargetCount: workspaceCount,
      workspaceRefreshInFlightCount: workspaceCount,
      workspaceRefreshQueuedCount: 0,
      workspaceRefreshAdmissionActiveCount: WORKSPACE_GIT_REFRESH_CONCURRENCY,
      workspaceRefreshAdmissionPendingCount: workspaceCount - WORKSPACE_GIT_REFRESH_CONCURRENCY,
      workspaceObservationSetupAdmissionActiveCount: 0,
      workspaceObservationSetupAdmissionPendingCount: 0,
    });

    for (const cwd of cwds) {
      for (let repeat = 0; repeat < 5; repeat += 1) {
        service.scheduleRefreshForCwd(cwd);
      }
    }
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();

    expect(service.getMetrics()).toMatchObject({
      workspaceRefreshInFlightCount: workspaceCount,
      workspaceRefreshQueuedCount: workspaceCount,
      workspaceRefreshAdmissionActiveCount: WORKSPACE_GIT_REFRESH_CONCURRENCY,
      workspaceRefreshAdmissionPendingCount: workspaceCount - WORKSPACE_GIT_REFRESH_CONCURRENCY,
    });

    await vi.advanceTimersByTimeAsync(59_000);
    await flushPromises();
    expect(service.getMetrics()).toMatchObject({
      workspaceRefreshAdmissionActiveCount: WORKSPACE_GIT_REFRESH_CONCURRENCY,
      workspaceRefreshAdmissionPendingCount: workspaceCount - WORKSPACE_GIT_REFRESH_CONCURRENCY,
      workspaceObservationSetupAdmissionActiveCount: WORKSPACE_GIT_OBSERVATION_SETUP_CONCURRENCY,
      workspaceObservationSetupAdmissionPendingCount:
        workspaceCount - WORKSPACE_GIT_OBSERVATION_SETUP_CONCURRENCY,
    });

    const forcedCwd = cwds[cwds.length - 1];
    const forcedRefresh = service.getSnapshot(forcedCwd, {
      force: true,
      reason: "test-force-during-refresh-backlog",
    });
    expect(service.getMetrics().workspaceRefreshQueuedCount).toBe(workspaceCount);

    factsGate.resolve();
    await forcedRefresh;
    expect(getCheckoutSnapshotFacts.mock.calls.filter(([cwd]) => cwd === forcedCwd)).toHaveLength(
      2,
    );

    await vi.waitFor(() => {
      expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(workspaceCount + 1);
      expect(getCheckoutStatus).toHaveBeenCalledTimes(workspaceCount * 2);
    });
    expect(maxActiveFactsReads).toBeLessThanOrEqual(
      WORKSPACE_GIT_REFRESH_CONCURRENCY + WORKSPACE_GIT_OBSERVATION_SETUP_CONCURRENCY,
    );

    for (const subscription of subscriptions) {
      subscription.unsubscribe();
    }
    service.dispose();
  });

  test("marks cached facts stale during blocked and failed refresh work", async () => {
    const refreshGate = createDeferred<CheckoutStatusGit>();
    const getCheckoutStatus = vi
      .fn<(cwd: string) => Promise<CheckoutStatusGit>>()
      .mockImplementationOnce(async (cwd) => createCheckoutStatus(cwd))
      .mockImplementationOnce(async () => refreshGate.promise);
    const service = createService({ getCheckoutStatus });

    await service.getSnapshot(REPO_CWD);
    expect(service.isSnapshotStale(REPO_CWD)).toBe(false);

    const forcedRefresh = service.getSnapshot(REPO_CWD, {
      force: true,
      reason: "test-blocked-stale-snapshot",
    });
    await flushPromises();

    expect(service.peekSnapshot(REPO_CWD)).toEqual(createSnapshot(REPO_CWD));
    expect(service.isSnapshotStale(REPO_CWD)).toBe(true);

    refreshGate.resolve(createCheckoutStatus(REPO_CWD, { currentBranch: "fresh-branch" }));
    await forcedRefresh;

    expect(service.isSnapshotStale(REPO_CWD)).toBe(false);
    expect(service.peekSnapshot(REPO_CWD)?.git.currentBranch).toBe("fresh-branch");

    getCheckoutStatus.mockRejectedValueOnce(new Error("git refresh failed"));
    await expect(
      service.getSnapshot(REPO_CWD, {
        force: true,
        reason: "test-failed-stale-snapshot",
      }),
    ).rejects.toThrow("git refresh failed");
    expect(service.isSnapshotStale(REPO_CWD)).toBe(true);
    expect(service.peekSnapshot(REPO_CWD)?.git.currentBranch).toBe("fresh-branch");

    service.dispose();
  });

  test("replays a queued force and forge upgrade after the current generation rejects", async () => {
    const rejectedGitRefresh = createDeferred<CheckoutStatusGit>();
    const getCheckoutStatus = vi
      .fn<(cwd: string) => Promise<CheckoutStatusGit>>()
      .mockImplementationOnce(async () => rejectedGitRefresh.promise)
      .mockImplementationOnce(async (cwd) =>
        createCheckoutStatus(cwd, { currentBranch: "validated-generation" }),
      );
    const getPullRequestStatus = vi.fn(async () =>
      createPullRequestStatusResult({
        status: {
          url: "https://github.com/acme/repo/pull/123",
          title: "Validated after rejection",
          state: "open",
          baseRefName: "main",
          headRefName: "validated-generation",
          isMerged: false,
        },
      }),
    );
    const service = createService({ getCheckoutStatus, getPullRequestStatus });

    const gitOnly = service.getSnapshot(REPO_CWD, {
      force: true,
      includeForge: false,
      reason: "failing-git-only-generation",
    });
    await flushPromises();
    const validation = service.getSnapshot(REPO_CWD, {
      force: true,
      includeForge: true,
      reason: "queued-validation-generation",
    });
    const gitOnlyFailure = expect(gitOnly).rejects.toThrow("first generation failed");

    rejectedGitRefresh.reject(new Error("first generation failed"));

    await gitOnlyFailure;
    await expect(validation).resolves.toMatchObject({
      git: { currentBranch: "validated-generation" },
      forge: { pullRequest: { title: "Validated after rejection" } },
    });
    expect(getCheckoutStatus).toHaveBeenCalledTimes(2);
    expect(getPullRequestStatus).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  test("replays an ordinary watcher generation and stays stale until it completes", async () => {
    let nowMs = 0;
    const activeRefresh = createDeferred<CheckoutStatusGit>();
    const watcherReplay = createDeferred<CheckoutStatusGit>();
    const getCheckoutStatus = vi
      .fn<(cwd: string) => Promise<CheckoutStatusGit>>()
      .mockImplementationOnce(async (cwd) => createCheckoutStatus(cwd))
      .mockImplementationOnce(async () => activeRefresh.promise)
      .mockImplementationOnce(async () => watcherReplay.promise);
    const service = createService({
      getCheckoutStatus,
      now: () => new Date(nowMs),
    });

    await service.getSnapshot(REPO_CWD);
    nowMs = 3_000;
    const refresh = service.refresh(REPO_CWD);
    await flushPromises();

    service.scheduleRefreshForCwd(REPO_CWD);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();

    expect(getCheckoutStatus).toHaveBeenCalledTimes(2);
    expect(service.isSnapshotStale(REPO_CWD)).toBe(true);

    activeRefresh.resolve(createCheckoutStatus(REPO_CWD, { currentBranch: "intermediate" }));
    await refresh;
    await vi.waitFor(() => {
      expect(getCheckoutStatus).toHaveBeenCalledTimes(3);
    });

    expect(service.peekSnapshot(REPO_CWD)?.git.currentBranch).toBe("intermediate");
    expect(service.isSnapshotStale(REPO_CWD)).toBe(true);

    watcherReplay.resolve(createCheckoutStatus(REPO_CWD, { currentBranch: "watcher-result" }));
    await vi.waitFor(() => {
      expect(service.peekSnapshot(REPO_CWD)?.git.currentBranch).toBe("watcher-result");
      expect(service.isSnapshotStale(REPO_CWD)).toBe(false);
    });

    service.dispose();
  });

  test("reconciles a ref change that happens while workspace watchers attach", async () => {
    let currentBranch = "main";
    const getCheckoutSnapshotFacts = vi.fn(async (cwd: string) => ({
      ...createCheckoutSnapshotFacts(cwd),
      remoteUrl: null,
    }));
    const getCheckoutStatus = vi.fn(async (cwd: string) =>
      createCheckoutStatus(cwd, {
        currentBranch,
        hasRemote: false,
        remoteUrl: null,
      }),
    );
    const watch = vi.fn(() => {
      currentBranch = "changed-during-attach";
      return createWatcher();
    }) as unknown as typeof import("node:fs").watch;
    const service = createService({ getCheckoutSnapshotFacts, getCheckoutStatus, watch });

    await service.getSnapshot(REPO_CWD);
    const listener = vi.fn();
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, listener);

    await vi.waitFor(() => {
      expect(service.peekSnapshot(REPO_CWD)?.git.currentBranch).toBe("changed-during-attach");
      expect(service.isSnapshotStale(REPO_CWD)).toBe(false);
    });
    expect(watch).toHaveBeenCalledTimes(2);
    expect(getCheckoutStatus).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        git: expect.objectContaining({ currentBranch: "changed-during-attach" }),
      }),
    );

    subscription.unsubscribe();
    service.dispose();
  });

  test("dispose rejects refresh admission and clears queued refresh and observation work", async () => {
    const refreshGate = createDeferred<void>();
    const getCheckoutSnapshotFacts = vi.fn(async (cwd: string) => {
      await refreshGate.promise;
      return createCheckoutSnapshotFacts(cwd);
    });
    const getCheckoutStatus = vi.fn(async (cwd: string) => createCheckoutStatus(cwd));
    const service = createService({ getCheckoutSnapshotFacts, getCheckoutStatus });
    const refreshPromises = Array.from({ length: 6 }, (_, index) =>
      service.getSnapshot(`/tmp/dispose-refresh-${index}`),
    );
    const refreshSettlements = Promise.allSettled(refreshPromises);

    await flushPromises();
    expect(service.getMetrics()).toMatchObject({
      workspaceRefreshAdmissionActiveCount: WORKSPACE_GIT_REFRESH_CONCURRENCY,
      workspaceRefreshAdmissionPendingCount: 2,
    });

    service.dispose();
    const settled = await refreshSettlements;
    expect(settled).toHaveLength(6);
    for (const result of settled) {
      expect(result).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({ name: "AbortError" }),
      });
    }
    expect(service.getMetrics().workspaceRefreshAdmissionPendingCount).toBe(0);
    await expect(service.getSnapshot("/tmp/after-dispose")).rejects.toMatchObject({
      name: "AbortError",
    });

    refreshGate.resolve();
    await vi.waitFor(() => {
      expect(service.getMetrics().workspaceRefreshAdmissionActiveCount).toBe(0);
    });
    expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(WORKSPACE_GIT_REFRESH_CONCURRENCY);
    expect(getCheckoutStatus).not.toHaveBeenCalled();

    let nowMs = 0;
    let blockObservationFacts = false;
    const observationGate = createDeferred<void>();
    const observationFacts = vi.fn(async (cwd: string) => {
      if (blockObservationFacts) {
        await observationGate.promise;
      }
      return createCheckoutSnapshotFacts(cwd);
    });
    const observationService = createService({
      getCheckoutSnapshotFacts: observationFacts,
      now: () => new Date(nowMs),
    });
    const observationCwds = Array.from(
      { length: WORKSPACE_GIT_OBSERVATION_SETUP_CONCURRENCY + 2 },
      (_, index) => `/tmp/dispose-observation-${index}`,
    );
    await Promise.all(observationCwds.map((cwd) => observationService.getSnapshot(cwd)));
    nowMs = 2_000;
    blockObservationFacts = true;
    for (const cwd of observationCwds) {
      observationService.registerWorkspace({ cwd }, vi.fn());
    }
    await flushPromises();

    expect(observationService.getMetrics()).toMatchObject({
      workspaceObservationSetupAdmissionActiveCount: WORKSPACE_GIT_OBSERVATION_SETUP_CONCURRENCY,
      workspaceObservationSetupAdmissionPendingCount: 2,
    });
    observationService.dispose();
    await flushPromises();
    expect(observationService.getMetrics().workspaceObservationSetupAdmissionPendingCount).toBe(0);

    observationGate.resolve();
    await vi.waitFor(() => {
      expect(observationService.getMetrics().workspaceObservationSetupAdmissionActiveCount).toBe(0);
    });
    expect(observationFacts).toHaveBeenCalledTimes(
      observationCwds.length + WORKSPACE_GIT_OBSERVATION_SETUP_CONCURRENCY,
    );
  });

  test("multiple listeners on the same workspace share one observation setup", async () => {
    const getPullRequestStatus = vi.fn(async () => createPullRequestStatusResult());
    const getCheckoutSnapshotFacts = vi.fn(async (cwd: string) => createCheckoutSnapshotFacts(cwd));
    const resolveAbsoluteGitDir = vi.fn(async () => join(REPO_CWD, ".git"));

    let nowMs = Date.parse("2026-04-12T00:00:00.000Z");
    const service = createService({
      getCheckoutSnapshotFacts,
      getPullRequestStatus,
      resolveAbsoluteGitDir,
      now: () => new Date(nowMs),
    });

    const first = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());
    const second = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());
    await flushPromises();

    expect(getPullRequestStatus).toHaveBeenCalledTimes(0);
    expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(1);
    expect(resolveAbsoluteGitDir).toHaveBeenCalledTimes(0);

    first.unsubscribe();
    second.unsubscribe();
    service.dispose();
  });

  test("equivalent cwd strings share one workspace target across service entry points", async () => {
    const getPullRequestStatus = vi.fn(async () => createPullRequestStatusResult());
    const resolveAbsoluteGitDir = vi.fn(async () => join(REPO_CWD, ".git"));

    let nowMs = Date.parse("2026-04-12T00:00:00.000Z");
    const service = createService({
      getPullRequestStatus,
      resolveAbsoluteGitDir,
      now: () => new Date(nowMs),
    });

    const subscription = service.registerWorkspace({ cwd: join(REPO_CWD, ".") }, vi.fn());

    await expect(service.getSnapshot(join(REPO_CWD, "."))).resolves.toEqual(
      createSnapshot(REPO_CWD),
    );
    expect(service.peekSnapshot(REPO_CWD)).toEqual(createSnapshot(REPO_CWD));

    nowMs += 3_000;
    await service.refresh(REPO_CWD);
    await expect(service.getSnapshot(join(REPO_CWD, "."))).resolves.toEqual(
      createSnapshot(REPO_CWD),
    );

    expect(getPullRequestStatus).toHaveBeenCalledTimes(1);
    expect(resolveAbsoluteGitDir).toHaveBeenCalledTimes(0);

    subscription.unsubscribe();
    service.dispose();
  });

  test("repo-level fetch intervals are shared for workspaces in the same repo", async () => {
    const runGitFetch = vi.fn(async () => {});
    const hasOriginRemote = vi.fn(async () => true);
    const getCheckoutSnapshotFacts = vi.fn(async (cwd: string) => ({
      ...createCheckoutSnapshotFacts(cwd),
      gitCommonDir: join(REPO_CWD, ".git"),
      absoluteGitDir: join(REPO_CWD, ".git"),
    }));
    const resolveAbsoluteGitDir = vi.fn(async () => join(REPO_CWD, ".git"));

    const service = createService({
      getCheckoutSnapshotFacts,
      resolveAbsoluteGitDir,
      hasOriginRemote,
      runGitFetch,
    });

    const first = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());
    const second = service.registerWorkspace(
      { cwd: join(REPO_CWD, "packages", "server") },
      vi.fn(),
    );
    await vi.waitFor(() => {
      expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(4);
      expect(runGitFetch).toHaveBeenCalledTimes(1);
    });

    expect(resolveAbsoluteGitDir).toHaveBeenCalledTimes(0);
    expect(hasOriginRemote).toHaveBeenCalledTimes(0);
    expect(runGitFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(180_000);
    await flushPromises();

    expect(runGitFetch).toHaveBeenCalledTimes(2);

    first.unsubscribe();
    second.unsubscribe();
    service.dispose();
  });

  test("explicit forced snapshot refresh recomputes github state and notifies listeners", async () => {
    const getPullRequestStatus = vi
      .fn<() => Promise<PullRequestStatusResult>>()
      .mockResolvedValueOnce(
        createPullRequestStatusResult({
          status: {
            url: "https://github.com/acme/repo/pull/123",
            title: "Before refresh",
            state: "open",
            baseRefName: "main",
            headRefName: "feature",
            isMerged: false,
          },
        }),
      )
      .mockResolvedValueOnce(
        createPullRequestStatusResult({
          status: {
            url: "https://github.com/acme/repo/pull/123",
            title: "After refresh",
            state: "merged",
            baseRefName: "main",
            headRefName: "feature",
            isMerged: true,
          },
        }),
      );

    const nowValues = [new Date("2026-04-12T00:00:00.000Z"), new Date("2026-04-12T00:05:00.000Z")];
    const service = createService({
      getPullRequestStatus,
      now: () => nowValues.shift() ?? new Date("2026-04-12T00:05:00.000Z"),
    });

    const listener = vi.fn();
    const initialSnapshot = await service.getSnapshot(REPO_CWD);
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, listener);

    expect(initialSnapshot.forge.pullRequest?.title).toBe("Before refresh");

    await service.getSnapshot(REPO_CWD, {
      force: true,
      reason: "test-force-github-refresh",
    });
    await flushPromises();

    expect(getPullRequestStatus).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      createSnapshot(REPO_CWD, {
        forge: {
          pullRequest: {
            url: "https://github.com/acme/repo/pull/123",
            title: "After refresh",
            state: "merged",
            baseRefName: "main",
            headRefName: "feature",
            isMerged: true,
          },
        },
      }),
    );

    subscription.unsubscribe();
    service.dispose();
  });

  test("unchanged runtime snapshots do not emit duplicate updates", async () => {
    const getCheckoutStatus = vi
      .fn<() => Promise<CheckoutStatusGit>>()
      .mockResolvedValueOnce(createCheckoutStatus(REPO_CWD, { remoteUrl: null }))
      .mockResolvedValueOnce(
        createCheckoutStatus(REPO_CWD, {
          currentBranch: "feature/runtime-payloads",
          remoteUrl: null,
          aheadBehind: { ahead: 2, behind: 0 },
          aheadOfOrigin: 2,
        }),
      )
      .mockResolvedValueOnce(
        createCheckoutStatus(REPO_CWD, {
          currentBranch: "feature/runtime-payloads",
          remoteUrl: null,
          aheadBehind: { ahead: 2, behind: 0 },
          aheadOfOrigin: 2,
        }),
      );
    const getPullRequestStatus = vi.fn<() => Promise<PullRequestStatusResult>>().mockResolvedValue(
      createPullRequestStatusResult({
        status: {
          url: "https://github.com/acme/repo/pull/123",
          title: "Runtime payloads",
          state: "open",
          baseRefName: "main",
          headRefName: "feature/runtime-payloads",
          isMerged: false,
        },
      }),
    );

    let nowMs = Date.parse("2026-04-12T00:00:00.000Z");
    const service = createService({
      getCheckoutStatus,
      getPullRequestStatus,
      now: () => new Date(nowMs),
    });

    const listener = vi.fn();
    const initialSnapshot = await service.getSnapshot(REPO_CWD);
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, listener);

    expect(initialSnapshot.git.currentBranch).toBe("main");

    nowMs += 3_000;
    await service.refresh(REPO_CWD);
    await flushPromises();

    nowMs += 3_000;
    await service.refresh(REPO_CWD);
    await flushPromises();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      createSnapshot(REPO_CWD, {
        git: {
          currentBranch: "feature/runtime-payloads",
          remoteUrl: null,
          aheadBehind: { ahead: 2, behind: 0 },
          aheadOfOrigin: 2,
        },
        forge: {
          featuresEnabled: false,
          pullRequest: null,
        },
      }),
    );

    subscription.unsubscribe();
    service.dispose();
  });

  test("forced snapshot refresh emits even when the fingerprint matches", async () => {
    const getCheckoutStatus = vi.fn(async () => createCheckoutStatus(REPO_CWD));
    const getPullRequestStatus = vi.fn(async () => createPullRequestStatusResult());
    let nowMs = Date.parse("2026-04-12T00:00:00.000Z");
    const service = createService({
      getCheckoutStatus,
      getPullRequestStatus,
      now: () => new Date(nowMs),
    });

    const listener = vi.fn();
    await service.getSnapshot(REPO_CWD);
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, listener);

    await service.getSnapshot(REPO_CWD, {
      force: true,
      reason: "test-force-emit",
    });
    await flushPromises();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(createSnapshot(REPO_CWD));

    subscription.unsubscribe();
    service.dispose();
  });

  // POSIX-only: this asserts Linux recursive-watch fallback behavior.
  test.skipIf(isPlatform("win32"))("watches nested repository directories on Linux", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "linux",
    });

    const watchCalls: Array<{ path: string; close: ReturnType<typeof vi.fn> }> = [];
    const watch = vi.fn((watchPath: string) => {
      const watcher = createWatcher();
      watchCalls.push({ path: watchPath, close: watcher.close });
      return watcher;
    });
    const readdir = vi.fn(async (directory: string) => {
      if (directory === REPO_CWD) {
        return [
          createDirent("packages", true),
          createDirent(".git", true),
          createDirent("README.md", false),
        ];
      }
      if (directory === path.join(REPO_CWD, "packages")) {
        return [createDirent("server", true), createDirent("app", true)];
      }
      if (directory === path.join(REPO_CWD, "packages", "server")) {
        return [createDirent("src", true)];
      }
      if (directory === path.join(REPO_CWD, "packages", "server", "src")) {
        return [createDirent("server", true)];
      }
      return [];
    });

    const service = createService({ watch, readdir });
    const subscription = await service.requestWorkingTreeWatch(
      path.join(REPO_CWD, "packages", "server"),
      vi.fn(),
    );

    expect(subscription.repoRoot).toBe(REPO_CWD);
    expect(watchCalls.map((entry) => entry.path).sort()).toEqual([
      REPO_CWD,
      join(REPO_CWD, ".git"),
      join(REPO_CWD, "packages"),
      join(REPO_CWD, "packages", "app"),
      join(REPO_CWD, "packages", "server"),
      join(REPO_CWD, "packages", "server", "src"),
      join(REPO_CWD, "packages", "server", "src", "server"),
    ]);

    subscription.unsubscribe();
    service.dispose();
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
  });

  test("requestWorkingTreeWatch reference-counts watchers by cwd", async () => {
    const watchers = [createWatcher(), createWatcher()];
    const watch = vi.fn().mockReturnValueOnce(watchers[0]).mockReturnValueOnce(watchers[1]);
    const service = createService({ watch });

    const firstListener = vi.fn();
    const secondListener = vi.fn();
    const first = await service.requestWorkingTreeWatch(REPO_CWD, firstListener);
    const second = await service.requestWorkingTreeWatch(join(REPO_CWD, "."), secondListener);

    expect(first.repoRoot).toBe(REPO_CWD);
    expect(second.repoRoot).toBe(REPO_CWD);
    expect(watch).toHaveBeenCalledTimes(2);

    first.unsubscribe();
    expect(watchers[0].close).not.toHaveBeenCalled();
    expect(watchers[1].close).not.toHaveBeenCalled();

    second.unsubscribe();
    expect(watchers[0].close).toHaveBeenCalledTimes(1);
    expect(watchers[1].close).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  test("sets a 5-second fallback polling interval when recursive watch is unavailable", async () => {
    if (process.platform === "linux") {
      // On Linux, recursive watch is never attempted — the service uses per-directory
      // watchers from the start. This scenario only applies to macOS/Windows where
      // recursive watch is tried first and may fail.
      return;
    }

    const recursiveUnsupported = new Error("recursive unsupported");
    const watch = vi
      .fn()
      .mockImplementationOnce((_watchPath: string, options: { recursive: boolean }) => {
        if (options.recursive) {
          throw recursiveUnsupported;
        }
        return createWatcher();
      })
      .mockImplementationOnce(() => createWatcher());

    const service = createService({ watch });
    const subscription = await service.requestWorkingTreeWatch(REPO_CWD, vi.fn());

    expect(vi.getTimerCount()).toBe(1);

    subscription.unsubscribe();
    service.dispose();
  });

  test("non-git directories fall back to watching cwd with polling", async () => {
    const watch = vi.fn(() => createWatcher());
    const runGitCommand = vi.fn(async () => {
      throw new Error("not a git repository");
    });
    const resolveAbsoluteGitDir = vi.fn(async () => null);
    const service = createService({
      watch,
      runGitCommand,
      resolveAbsoluteGitDir,
    });

    const plainCwd = path.join(os.tmpdir(), "plain");
    const subscription = await service.requestWorkingTreeWatch(plainCwd, vi.fn());

    expect(subscription.repoRoot).toBeNull();
    const expectedRecursive = process.platform !== "linux";
    expect(watch).toHaveBeenCalledWith(
      plainCwd,
      { recursive: expectedRecursive },
      expect.any(Function),
    );
    expect(vi.getTimerCount()).toBe(1);

    subscription.unsubscribe();
    service.dispose();
  });

  test("working tree changes notify watch listeners immediately", async () => {
    const watchCallbacks: Array<() => void> = [];
    const watch = vi.fn(
      (_watchPath: string, _options: { recursive: boolean }, callback: () => void) => {
        watchCallbacks.push(callback);
        return createWatcher();
      },
    );
    const service = createService({ watch });
    const listener = vi.fn();

    const subscription = await service.requestWorkingTreeWatch(REPO_CWD, listener);
    expect(watchCallbacks).toHaveLength(2);

    watchCallbacks[0]?.();

    expect(listener).toHaveBeenCalledTimes(1);

    subscription.unsubscribe();
    service.dispose();
  });

  test("working tree changes force a fresh diff stat for workspace subscribers", async () => {
    const watchCallbacks: Array<{ path: string; callback: () => void }> = [];
    const watch = vi.fn(
      (watchPath: string, _options: { recursive: boolean }, callback: () => void) => {
        watchCallbacks.push({ path: watchPath, callback });
        return createWatcher();
      },
    );
    const getCheckoutShortstat = vi
      .fn()
      .mockResolvedValueOnce({ additions: 1, deletions: 0 })
      .mockResolvedValueOnce({ additions: 8, deletions: 3 });
    const service = createService({ getCheckoutShortstat, watch });
    const workspaceListener = vi.fn();

    const initialSnapshot = await service.getSnapshot(REPO_CWD);
    const workspaceSubscription = service.registerWorkspace({ cwd: REPO_CWD }, workspaceListener);
    const diffSubscription = await service.requestWorkingTreeWatch(REPO_CWD, vi.fn());

    expect(initialSnapshot.git.diffStat).toEqual({ additions: 1, deletions: 0 });
    const repoRootWatch = watchCallbacks.find((entry) => entry.path === REPO_CWD);
    expect(repoRootWatch).toBeDefined();

    repoRootWatch?.callback();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();

    expect(getCheckoutShortstat).toHaveBeenLastCalledWith(
      REPO_CWD,
      expect.objectContaining({ paseoHome: "/tmp/paseo-test" }),
      { force: true },
    );
    expect(workspaceListener).toHaveBeenCalledWith(
      createSnapshot(REPO_CWD, {
        git: { diffStat: { additions: 8, deletions: 3 } },
      }),
    );

    diffSubscription.unsubscribe();
    workspaceSubscription.unsubscribe();
    service.dispose();
  });

  test("checkoutDiffCache evicts least-recently-used entries past its size cap", async () => {
    vi.useRealTimers();
    const getCheckoutDiff = vi.fn(async (cwd: string) => ({
      diff: `diff for ${cwd}`,
    }));
    const service = createService({
      getCheckoutDiff: getCheckoutDiff as unknown as ReturnType<typeof vi.fn>,
    });

    const CACHE_MAX = 64;
    const OVERFLOW = 5;

    for (let i = 0; i < CACHE_MAX + OVERFLOW; i++) {
      await service.getCheckoutDiff(`/tmp/repo-${i}`, { mode: "uncommitted" });
    }
    expect(getCheckoutDiff).toHaveBeenCalledTimes(CACHE_MAX + OVERFLOW);

    await service.getCheckoutDiff(`/tmp/repo-${CACHE_MAX - 1}`, { mode: "uncommitted" });
    expect(getCheckoutDiff).toHaveBeenCalledTimes(CACHE_MAX + OVERFLOW);

    await service.getCheckoutDiff("/tmp/repo-0", { mode: "uncommitted" });
    expect(getCheckoutDiff).toHaveBeenCalledTimes(CACHE_MAX + OVERFLOW + 1);

    service.dispose();
  });
});
