import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createGitHubService,
  type GitHubCurrentPullRequestStatus,
  type GitHubService,
} from "../services/github-service.js";
import {
  getCheckoutDiff as getCheckoutDiffUncached,
  getCheckoutStatus as getCheckoutStatusUncached,
  type CheckoutDiffCompare,
  type CheckoutDiffResult,
  type CheckoutStatusGit,
  type PullRequestStatusResult,
} from "../utils/checkout-git.js";
import {
  WorkspaceGitServiceImpl,
  type WorkspaceGitRuntimeSnapshot,
} from "./workspace-git-service.js";

function createLogger() {
  const logger = {
    child: () => logger,
    debug: vi.fn(),
    warn: vi.fn(),
  };
  return logger;
}

function createWatcher() {
  return {
    close: vi.fn(),
    on: vi.fn().mockReturnThis(),
  };
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

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
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

function createPullRequestStatusResult(): PullRequestStatusResult {
  return {
    status: {
      url: "https://github.com/acme/repo/pull/123",
      title: "Update feature",
      state: "open",
      baseRefName: "main",
      headRefName: "feature",
      isMerged: false,
    },
    githubFeaturesEnabled: true,
  };
}

function currentPullRequestJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    number: 123,
    url: "https://github.com/acme/repo/pull/123",
    title: "Update feature",
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    headRefName: "feature",
    mergedAt: null,
    statusCheckRollup: [],
    reviewDecision: "REVIEW_REQUIRED",
    ...overrides,
  });
}

function createSnapshot(
  cwd: string,
  overrides?: {
    git?: Partial<WorkspaceGitRuntimeSnapshot["git"]>;
    github?: Partial<WorkspaceGitRuntimeSnapshot["github"]>;
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
    github: {
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

  return {
    cwd,
    git: {
      ...base.git,
      ...overrides?.git,
    },
    github: {
      ...base.github,
      ...overrides?.github,
      pullRequest:
        overrides?.github && "pullRequest" in overrides.github
          ? (overrides.github.pullRequest ?? null)
          : base.github.pullRequest,
      error:
        overrides?.github && "error" in overrides.github
          ? (overrides.github.error ?? null)
          : base.github.error,
    },
  };
}

function createGitHubServiceStub(): GitHubService {
  return {
    listPullRequests: vi.fn(async () => []),
    listIssues: vi.fn(async () => []),
    searchIssuesAndPrs: vi.fn(async () => ({ items: [], githubFeaturesEnabled: true })),
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
    getCurrentPullRequestStatus: vi.fn(async () => null),
    getPullRequestTimeline: vi.fn(async () => ({
      pullRequest: null,
      events: [],
    })),
    createPullRequest: vi.fn(async () => ({
      url: "https://github.com/acme/repo/pull/1",
      number: 1,
    })),
    isAuthenticated: vi.fn(async () => true),
    invalidate: vi.fn(),
  };
}

interface CreateServiceOptions {
  getCheckoutStatus?: ReturnType<typeof vi.fn>;
  getCheckoutShortstat?: ReturnType<typeof vi.fn>;
  getPullRequestStatus?: ReturnType<typeof vi.fn>;
  getCheckoutDiff?: ReturnType<typeof vi.fn>;
  resolveBranchCheckout?: ReturnType<typeof vi.fn>;
  resolveRepositoryDefaultBranch?: ReturnType<typeof vi.fn>;
  listBranchSuggestions?: ReturnType<typeof vi.fn>;
  listPaseoWorktrees?: ReturnType<typeof vi.fn>;
  github?: GitHubService;
  resolveAbsoluteGitDir?: ReturnType<typeof vi.fn>;
  hasOriginRemote?: ReturnType<typeof vi.fn>;
  runGitFetch?: ReturnType<typeof vi.fn>;
  runGitCommand?: ReturnType<typeof vi.fn>;
  watch?: ReturnType<typeof vi.fn>;
  now?: () => Date;
}

function buildDefaultServiceDeps() {
  return {
    watch: (() => createWatcher()) as never,
    readdir: vi.fn(async () => []),
    getCheckoutStatus: vi.fn(async (cwd: string) => createCheckoutStatus(cwd)),
    getCheckoutShortstat: vi.fn(async () => ({
      additions: 1,
      deletions: 0,
    })),
    getPullRequestStatus: vi.fn(async () => createPullRequestStatusResult()),
    getCheckoutDiff: vi.fn(async () => ({ diff: "", structured: [] })),
    resolveBranchCheckout: vi.fn(async () => ({ kind: "not-found" })),
    resolveRepositoryDefaultBranch: vi.fn(async () => "main"),
    listBranchSuggestions: vi.fn(async () => []),
    listPaseoWorktrees: vi.fn(async () => []),
    github: createGitHubServiceStub(),
    resolveAbsoluteGitDir: vi.fn(async () => "/tmp/repo/.git"),
    hasOriginRemote: vi.fn(async () => false),
    runGitFetch: vi.fn(async () => {}),
    runGitCommand: vi.fn(async () => ({
      stdout: "/tmp/repo\n",
      stderr: "",
      truncated: false,
      exitCode: 0,
      signal: null,
    })),
    now: () => new Date("2026-04-12T00:00:00.000Z"),
  };
}

function buildServiceDeps(options?: CreateServiceOptions) {
  return { ...buildDefaultServiceDeps(), ...options };
}

function createService(options?: CreateServiceOptions) {
  return new WorkspaceGitServiceImpl({
    logger: createLogger() as never,
    paseoHome: "/tmp/paseo-test",
    deps: buildServiceDeps(options),
  });
}

describe("WorkspaceGitServiceImpl primitive refresh entrypoint", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("getSnapshot returns cached warm value without shelling out within consumer TTL", async () => {
    let nowMs = Date.parse("2026-04-12T00:00:00.000Z");
    const getCheckoutStatus = vi.fn(async (cwd: string) => createCheckoutStatus(cwd));
    const service = createService({
      getCheckoutStatus,
      now: () => new Date(nowMs),
    });

    await expect(service.getSnapshot("/tmp/repo")).resolves.toEqual(createSnapshot("/tmp/repo"));
    nowMs += 1_000;
    await expect(service.getSnapshot("/tmp/repo")).resolves.toEqual(createSnapshot("/tmp/repo"));

    expect(getCheckoutStatus).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  test("getSnapshot cold-loads when no snapshot exists yet with one shell burst", async () => {
    const getCheckoutStatus = vi.fn(async (cwd: string) => createCheckoutStatus(cwd));
    const getCheckoutShortstat = vi.fn(async () => ({ additions: 1, deletions: 0 }));
    const getPullRequestStatus = vi.fn(async () => createPullRequestStatusResult());
    const service = createService({
      getCheckoutStatus,
      getCheckoutShortstat,
      getPullRequestStatus,
    });

    await expect(service.getSnapshot("/tmp/repo")).resolves.toEqual(createSnapshot("/tmp/repo"));

    expect(getCheckoutStatus).toHaveBeenCalledTimes(1);
    expect(getCheckoutShortstat).toHaveBeenCalledTimes(1);
    expect(getPullRequestStatus).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  test("registerWorkspace returns a subscription without waiting for a cold snapshot", async () => {
    const checkoutStatusDeferred = createDeferred<CheckoutStatusGit>();
    const getCheckoutStatus = vi.fn(async () => checkoutStatusDeferred.promise);
    const service = createService({ getCheckoutStatus });
    const listener = vi.fn();

    const subscription = service.registerWorkspace({ cwd: "/tmp/repo" }, listener);

    expect(subscription).toEqual({ unsubscribe: expect.any(Function) });
    expect(getCheckoutStatus).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(service.peekSnapshot("/tmp/repo")).toBeNull();

    await flushPromises();

    expect(getCheckoutStatus).toHaveBeenCalledTimes(1);
    expect(service.peekSnapshot("/tmp/repo")).toBeNull();

    checkoutStatusDeferred.resolve(createCheckoutStatus("/tmp/repo"));

    await expect(service.getSnapshot("/tmp/repo")).resolves.toEqual(createSnapshot("/tmp/repo"));
    expect(service.peekSnapshot("/tmp/repo")).toEqual(createSnapshot("/tmp/repo"));

    subscription.unsubscribe();
    service.dispose();
  });

  test("forced getSnapshot bypasses the internal min-gap and re-shells", async () => {
    let nowMs = 0;
    const getCheckoutStatus = vi.fn(async (cwd: string) => createCheckoutStatus(cwd));
    const service = createService({
      getCheckoutStatus,
      now: () => new Date(nowMs),
    });

    await service.getSnapshot("/tmp/repo");
    nowMs = 1;
    await service.getSnapshot("/tmp/repo", { force: true, reason: "test" });

    expect(getCheckoutStatus).toHaveBeenCalledTimes(2);

    service.dispose();
  });

  test("forced getSnapshot emits even when the fingerprint matches", async () => {
    const getCheckoutStatus = vi.fn(async (cwd: string) => createCheckoutStatus(cwd));
    const service = createService({ getCheckoutStatus });
    await service.getSnapshot("/tmp/repo");

    const listener = vi.fn();
    const subscription = service.registerWorkspace({ cwd: "/tmp/repo" }, listener);

    await service.getSnapshot("/tmp/repo", { force: true, reason: "test" });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(createSnapshot("/tmp/repo"));

    subscription.unsubscribe();
    service.dispose();
  });

  test("non-forced refresh with a matching fingerprint does not emit", async () => {
    let nowMs = 0;
    const getCheckoutStatus = vi.fn(async (cwd: string) =>
      createCheckoutStatus(cwd, { remoteUrl: null }),
    );
    const service = createService({
      getCheckoutStatus,
      now: () => new Date(nowMs),
    });
    await service.getSnapshot("/tmp/repo");

    const listener = vi.fn();
    const subscription = service.registerWorkspace({ cwd: "/tmp/repo" }, listener);

    nowMs = 3_000;
    await service.refresh("/tmp/repo");

    expect(listener).not.toHaveBeenCalled();

    subscription.unsubscribe();
    service.dispose();
  });

  test("two concurrent getSnapshot calls produce one shell burst and share the result", async () => {
    const checkoutStatusDeferred = createDeferred<CheckoutStatusGit>();
    const getCheckoutStatus = vi.fn(async () => checkoutStatusDeferred.promise);
    const service = createService({ getCheckoutStatus });

    const first = service.getSnapshot("/tmp/repo");
    const second = service.getSnapshot("/tmp/repo/.");
    await flushPromises();

    expect(getCheckoutStatus).toHaveBeenCalledTimes(1);

    checkoutStatusDeferred.resolve(createCheckoutStatus("/tmp/repo"));

    await expect(Promise.all([first, second])).resolves.toEqual([
      createSnapshot("/tmp/repo"),
      createSnapshot("/tmp/repo"),
    ]);
    expect(getCheckoutStatus).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  test("warm non-forced getSnapshot calls attach to an in-flight refresh instead of returning stale cache", async () => {
    let nowMs = Date.parse("2026-04-12T00:00:00.000Z");
    const refreshStatus = createDeferred<CheckoutStatusGit>();
    const getCheckoutStatus = vi
      .fn<(cwd: string) => Promise<CheckoutStatusGit>>()
      .mockImplementationOnce(async (cwd: string) => createCheckoutStatus(cwd))
      .mockImplementationOnce(async () => {
        const status = await refreshStatus.promise;
        return { ...status, currentBranch: "feature" };
      });
    const getCheckoutShortstat = vi.fn(async () => ({ additions: 4, deletions: 2 }));
    const service = createService({
      getCheckoutStatus,
      getCheckoutShortstat,
      now: () => new Date(nowMs),
    });

    await expect(service.getSnapshot("/tmp/repo")).resolves.toEqual(
      createSnapshot("/tmp/repo", {
        git: { diffStat: { additions: 4, deletions: 2 } },
      }),
    );

    nowMs += 16_000;
    const first = service.getSnapshot("/tmp/repo");
    await flushPromises();
    const second = service.getSnapshot("/tmp/repo");
    await flushPromises();

    expect(getCheckoutStatus).toHaveBeenCalledTimes(2);
    expect(getCheckoutShortstat).toHaveBeenCalledTimes(1);

    refreshStatus.resolve(createCheckoutStatus("/tmp/repo", { currentBranch: "feature" }));

    const freshSnapshot = createSnapshot("/tmp/repo", {
      git: {
        currentBranch: "feature",
        diffStat: { additions: 4, deletions: 2 },
      },
    });
    await expect(Promise.all([first, second])).resolves.toEqual([freshSnapshot, freshSnapshot]);
    expect(getCheckoutStatus).toHaveBeenCalledTimes(2);
    expect(getCheckoutShortstat).toHaveBeenCalledTimes(2);

    service.dispose();
  });

  test("five ref-watch-triggered refreshes within debounce produce one shell burst", async () => {
    let nowMs = 0;
    const getCheckoutStatus = vi.fn(async (cwd: string) => createCheckoutStatus(cwd));
    const service = createService({
      getCheckoutStatus,
      now: () => new Date(nowMs),
    });
    await service.getSnapshot("/tmp/repo");

    nowMs = 3_000;
    for (let index = 0; index < 5; index += 1) {
      service.scheduleRefreshForCwd("/tmp/repo");
    }
    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();

    expect(getCheckoutStatus).toHaveBeenCalledTimes(2);

    service.dispose();
  });

  test("a forced call during an in-flight non-forced refresh queues one forced re-run", async () => {
    let nowMs = 0;
    const secondRefresh = createDeferred<CheckoutStatusGit>();
    const getCheckoutStatus = vi
      .fn<() => Promise<CheckoutStatusGit>>()
      .mockImplementationOnce(async () => createCheckoutStatus("/tmp/repo"))
      .mockImplementationOnce(async () => secondRefresh.promise)
      .mockImplementation(async () => createCheckoutStatus("/tmp/repo"));
    const service = createService({
      getCheckoutStatus,
      now: () => new Date(nowMs),
    });
    await service.getSnapshot("/tmp/repo");

    nowMs = 3_000;
    const refreshPromise = service.refresh("/tmp/repo");
    await flushPromises();
    const forcedPromise = service.getSnapshot("/tmp/repo", { force: true, reason: "test" });
    const duplicateForcedPromise = service.getSnapshot("/tmp/repo", {
      force: true,
      reason: "test",
    });
    await flushPromises();

    expect(getCheckoutStatus).toHaveBeenCalledTimes(2);

    secondRefresh.resolve(createCheckoutStatus("/tmp/repo"));
    await Promise.all([refreshPromise, forcedPromise, duplicateForcedPromise]);

    expect(getCheckoutStatus).toHaveBeenCalledTimes(3);

    service.dispose();
  });

  test("a forced call during an in-flight forced refresh does not queue another re-run", async () => {
    const forcedRefresh = createDeferred<CheckoutStatusGit>();
    const getCheckoutStatus = vi
      .fn<() => Promise<CheckoutStatusGit>>()
      .mockImplementationOnce(async () => createCheckoutStatus("/tmp/repo"))
      .mockImplementationOnce(async () => forcedRefresh.promise);
    const service = createService({ getCheckoutStatus });
    await service.getSnapshot("/tmp/repo");

    const first = service.getSnapshot("/tmp/repo", { force: true, reason: "test" });
    await flushPromises();
    const second = service.getSnapshot("/tmp/repo", { force: true, reason: "test" });
    await flushPromises();

    expect(getCheckoutStatus).toHaveBeenCalledTimes(2);

    forcedRefresh.resolve(createCheckoutStatus("/tmp/repo"));
    await Promise.all([first, second]);

    expect(getCheckoutStatus).toHaveBeenCalledTimes(2);

    service.dispose();
  });

  test("ref-watch firing during an in-flight forced refresh does not produce an extra shell burst", async () => {
    const forcedRefresh = createDeferred<CheckoutStatusGit>();
    const getCheckoutStatus = vi
      .fn<() => Promise<CheckoutStatusGit>>()
      .mockImplementationOnce(async () => createCheckoutStatus("/tmp/repo"))
      .mockImplementationOnce(async () => forcedRefresh.promise);
    const service = createService({ getCheckoutStatus });
    await service.getSnapshot("/tmp/repo");

    const forcePromise = service.getSnapshot("/tmp/repo", { force: true, reason: "test" });
    await flushPromises();
    service.scheduleRefreshForCwd("/tmp/repo");
    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();

    forcedRefresh.resolve(createCheckoutStatus("/tmp/repo"));
    await forcePromise;

    expect(getCheckoutStatus).toHaveBeenCalledTimes(2);

    service.dispose();
  });

  test("internal min-gap throttles back-to-back non-forced refreshes", async () => {
    let nowMs = 0;
    const getCheckoutStatus = vi.fn(async (cwd: string) => createCheckoutStatus(cwd));
    const service = createService({
      getCheckoutStatus,
      now: () => new Date(nowMs),
    });
    await service.getSnapshot("/tmp/repo");

    nowMs = 3_000;
    await service.refresh("/tmp/repo");
    nowMs = 3_001;
    await service.refresh("/tmp/repo");

    expect(getCheckoutStatus).toHaveBeenCalledTimes(2);

    service.dispose();
  });

  test("consumer TTL triggers cold-load after expiry on getSnapshot", async () => {
    let nowMs = 0;
    const getCheckoutStatus = vi.fn(async (cwd: string) => createCheckoutStatus(cwd));
    const service = createService({
      getCheckoutStatus,
      now: () => new Date(nowMs),
    });
    await service.getSnapshot("/tmp/repo");

    nowMs = 16_000;
    await service.getSnapshot("/tmp/repo");

    expect(getCheckoutStatus).toHaveBeenCalledTimes(2);

    service.dispose();
  });

  test("self-heal timer fires at the interval and calls getSnapshot without force", async () => {
    let nowMs = 0;
    const getCheckoutStatus = vi.fn(async (cwd: string) => createCheckoutStatus(cwd));
    const getPullRequestStatus = vi.fn(async () => createPullRequestStatusResult());
    const service = createService({
      getCheckoutStatus,
      getPullRequestStatus,
      now: () => new Date(nowMs),
    });
    const subscription = service.registerWorkspace({ cwd: "/tmp/repo" }, vi.fn());
    await flushPromises();

    nowMs = 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    await flushPromises();

    expect(getCheckoutStatus).toHaveBeenCalledTimes(2);
    expect(getPullRequestStatus).toHaveBeenLastCalledWith("/tmp/repo", expect.anything(), {
      force: false,
      reason: "self-heal-git",
    });

    subscription.unsubscribe();
    service.dispose();
  });

  test("self-heal retries workspace observation setup while a listener remains active", async () => {
    let nowMs = 0;
    const resolveAbsoluteGitDir = vi
      .fn<() => Promise<string | null>>()
      .mockRejectedValueOnce(new Error("git dir temporarily unavailable"))
      .mockResolvedValue("/tmp/repo/.git");
    const watch = vi.fn(() => createWatcher() as never);
    const service = createService({
      resolveAbsoluteGitDir,
      watch,
      now: () => new Date(nowMs),
    });

    const subscription = service.registerWorkspace({ cwd: "/tmp/repo" }, vi.fn());
    await flushPromises();

    expect(resolveAbsoluteGitDir).toHaveBeenCalledTimes(1);
    expect(watch).not.toHaveBeenCalled();

    nowMs = 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    await flushPromises();

    expect(resolveAbsoluteGitDir).toHaveBeenCalledTimes(2);
    expect(resolveAbsoluteGitDir).toHaveBeenLastCalledWith("/tmp/repo");

    subscription.unsubscribe();
    service.dispose();
  });

  test("stale workspace watcher callbacks do not refresh after unsubscribe", async () => {
    const watchCallbacks: Array<() => void> = [];
    const watch = vi.fn(
      (_watchPath: string, _options: { recursive: boolean }, callback: () => void) => {
        watchCallbacks.push(callback);
        return createWatcher() as never;
      },
    );
    const getCheckoutStatus = vi.fn(async (cwd: string) => createCheckoutStatus(cwd));
    const service = createService({
      getCheckoutStatus,
      resolveAbsoluteGitDir: vi.fn(async () => "/tmp/repo/.git"),
      watch,
    });

    const subscription = service.registerWorkspace({ cwd: "/tmp/repo" }, vi.fn());
    await flushPromises();

    await vi.waitFor(() => {
      expect(watchCallbacks.length).toBeGreaterThan(0);
    });
    const callsBeforeStaleCallback = getCheckoutStatus.mock.calls.length;

    subscription.unsubscribe();
    watchCallbacks[0]?.();
    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();

    expect(getCheckoutStatus).toHaveBeenCalledTimes(callsBeforeStaleCallback);

    service.dispose();
  });

  test("stale GitHub poll callbacks do not refresh after unsubscribe", async () => {
    let pollStatus: (() => void) | null = null;
    const pollUnsubscribe = vi.fn();
    const github = {
      ...createGitHubServiceStub(),
      retainCurrentPullRequestStatusPoll: vi.fn((options: { onStatus: () => void }) => {
        pollStatus = options.onStatus;
        return { unsubscribe: pollUnsubscribe };
      }),
    };
    const getCheckoutStatus = vi.fn(async (cwd: string) => createCheckoutStatus(cwd));
    const service = createService({
      getCheckoutStatus,
      github,
    });

    const subscription = service.registerWorkspace({ cwd: "/tmp/repo" }, vi.fn());
    await flushPromises();

    await vi.waitFor(() => {
      expect(github.retainCurrentPullRequestStatusPoll).toHaveBeenCalledTimes(1);
    });
    const callsBeforeStaleCallback = getCheckoutStatus.mock.calls.length;

    subscription.unsubscribe();
    pollStatus?.();
    await flushPromises();

    expect(pollUnsubscribe).toHaveBeenCalledTimes(1);
    expect(getCheckoutStatus).toHaveBeenCalledTimes(callsBeforeStaleCallback);

    service.dispose();
  });

  test("subscription starts GitHub self-heal reads within the fast poll window", async () => {
    let nowMs = 0;
    const githubReadCalls: Array<{ reason: string | undefined; tickMs: number }> = [];
    const github = createGitHubService({
      ttlMs: 0,
      runner: vi.fn(async () => ({
        stdout: currentPullRequestJson({
          statusCheckRollup: [{ __typename: "StatusContext", context: "ci", state: "PENDING" }],
        }),
        stderr: "",
      })),
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => nowMs,
    });
    const getCurrentPullRequestStatus = github.getCurrentPullRequestStatus.bind(github);
    github.getCurrentPullRequestStatus = vi.fn(
      async (options): Promise<GitHubCurrentPullRequestStatus | null> => {
        githubReadCalls.push({ reason: options.reason, tickMs: nowMs });
        return getCurrentPullRequestStatus(options);
      },
    );
    const getCheckoutStatus = vi.fn(async (cwd: string) =>
      createCheckoutStatus(cwd, { currentBranch: "feature" }),
    );
    const service = createService({
      getCheckoutStatus,
      github,
      now: () => new Date(nowMs),
    });
    const subscription = service.registerWorkspace({ cwd: "/tmp/repo" }, vi.fn());
    await flushPromises();

    nowMs = 20_000;
    await vi.advanceTimersByTimeAsync(20_000);
    await flushPromises();

    expect(githubReadCalls).toContainEqual({
      reason: "self-heal-github",
      tickMs: 20_000,
    });

    subscription.unsubscribe();
    service.dispose();
    github.dispose?.();
  });

  test("subscription skips GitHub self-heal polling when the checkout has no GitHub remote", async () => {
    const retainCurrentPullRequestStatusPoll = vi.fn(() => ({ unsubscribe: vi.fn() }));
    const github = {
      ...createGitHubServiceStub(),
      retainCurrentPullRequestStatusPoll,
    };
    const getCheckoutStatus = vi.fn(async (cwd: string) =>
      createCheckoutStatus(cwd, {
        hasRemote: false,
        remoteUrl: null,
      }),
    );
    const service = createService({
      getCheckoutStatus,
      github,
    });
    const subscription = service.registerWorkspace({ cwd: "/tmp/repo" }, vi.fn());
    await flushPromises();

    expect(retainCurrentPullRequestStatusPoll).not.toHaveBeenCalled();

    subscription.unsubscribe();
    service.dispose();
  });

  test("subscription starts GitHub self-heal polling for ssh.github.com remotes", async () => {
    const retainCurrentPullRequestStatusPoll = vi.fn(() => ({ unsubscribe: vi.fn() }));
    const github = {
      ...createGitHubServiceStub(),
      retainCurrentPullRequestStatusPoll,
    };
    const getCheckoutStatus = vi.fn(async (cwd: string) =>
      createCheckoutStatus(cwd, {
        remoteUrl: "ssh://git@ssh.github.com/acme/repo.git",
      }),
    );
    const service = createService({
      getCheckoutStatus,
      github,
    });
    const subscription = service.registerWorkspace({ cwd: "/tmp/repo" }, vi.fn());
    await flushPromises();

    await vi.waitFor(() => {
      expect(retainCurrentPullRequestStatusPoll).toHaveBeenCalledTimes(1);
    });

    subscription.unsubscribe();
    service.dispose();
  });

  test("multiple subscribers on the same target share one self-heal timer", async () => {
    let nowMs = 0;
    const getCheckoutStatus = vi.fn(async (cwd: string) => createCheckoutStatus(cwd));
    const service = createService({
      getCheckoutStatus,
      now: () => new Date(nowMs),
    });
    const first = service.registerWorkspace({ cwd: "/tmp/repo" }, vi.fn());
    const second = service.registerWorkspace({ cwd: "/tmp/repo/." }, vi.fn());
    await flushPromises();

    nowMs = 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    await flushPromises();

    expect(getCheckoutStatus).toHaveBeenCalledTimes(2);

    first.unsubscribe();
    second.unsubscribe();
    service.dispose();
  });

  test("unsubscribe with no remaining subscribers clears the self-heal timer", async () => {
    let nowMs = 0;
    const getCheckoutStatus = vi.fn(async (cwd: string) => createCheckoutStatus(cwd));
    const service = createService({
      getCheckoutStatus,
      now: () => new Date(nowMs),
    });
    const subscription = service.registerWorkspace({ cwd: "/tmp/repo" }, vi.fn());

    subscription.unsubscribe();
    nowMs = 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    await flushPromises();

    expect(getCheckoutStatus).toHaveBeenCalledTimes(0);

    service.dispose();
  });

  test("service disposal clears all self-heal timers", async () => {
    let nowMs = 0;
    const getCheckoutStatus = vi.fn(async (cwd: string) => createCheckoutStatus(cwd));
    const service = createService({
      getCheckoutStatus,
      now: () => new Date(nowMs),
    });
    service.registerWorkspace({ cwd: "/tmp/repo" }, vi.fn());

    service.dispose();
    nowMs = 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    await flushPromises();

    expect(getCheckoutStatus).toHaveBeenCalledTimes(0);
  });

  test("self-heal poll coalesces with a concurrent direct getSnapshot call", async () => {
    let nowMs = 0;
    const selfHealRefresh = createDeferred<CheckoutStatusGit>();
    const getCheckoutStatus = vi
      .fn<() => Promise<CheckoutStatusGit>>()
      .mockImplementationOnce(async () => createCheckoutStatus("/tmp/repo"))
      .mockImplementationOnce(async () => selfHealRefresh.promise);
    const service = createService({
      getCheckoutStatus,
      now: () => new Date(nowMs),
    });
    const subscription = service.registerWorkspace({ cwd: "/tmp/repo" }, vi.fn());
    await flushPromises();

    nowMs = 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    await flushPromises();
    const directRead = service.getSnapshot("/tmp/repo");
    await flushPromises();

    expect(getCheckoutStatus).toHaveBeenCalledTimes(2);

    selfHealRefresh.resolve(createCheckoutStatus("/tmp/repo"));
    await directRead;

    expect(getCheckoutStatus).toHaveBeenCalledTimes(2);

    subscription.unsubscribe();
    service.dispose();
  });
});

describe("WorkspaceGitServiceImpl D2 read methods", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("validateBranchRef cold-loads, warms, forces, and coalesces per cwd/ref", async () => {
    let nowMs = 0;
    const branchResolution = createDeferred<{ kind: "local"; name: string }>();
    const resolveBranchCheckout = vi
      .fn()
      .mockImplementationOnce(async () => branchResolution.promise)
      .mockResolvedValue({ kind: "local", name: "feature" });
    const service = createService({
      resolveBranchCheckout,
      now: () => new Date(nowMs),
    });

    const first = service.validateBranchRef("/tmp/repo", "feature");
    const second = service.validateBranchRef("/tmp/repo/.", "feature");
    await flushPromises();

    expect(resolveBranchCheckout).toHaveBeenCalledTimes(1);
    branchResolution.resolve({ kind: "local", name: "feature" });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: "local", name: "feature" },
      { kind: "local", name: "feature" },
    ]);

    nowMs = 1_000;
    await service.validateBranchRef("/tmp/repo", "feature");
    expect(resolveBranchCheckout).toHaveBeenCalledTimes(1);

    await service.validateBranchRef("/tmp/repo", "feature", { force: true, reason: "test" });
    expect(resolveBranchCheckout).toHaveBeenCalledTimes(2);

    service.dispose();
  });

  test("hasLocalBranch cold-loads, warms, forces, and coalesces per cwd/ref", async () => {
    let nowMs = 0;
    const branchLookup = createDeferred<{
      stdout: string;
      stderr: string;
      truncated: boolean;
      exitCode: number;
      signal: NodeJS.Signals | null;
    }>();
    const runGitCommand = vi
      .fn()
      .mockImplementationOnce(async () => branchLookup.promise)
      .mockResolvedValue({
        stdout: "",
        stderr: "",
        truncated: false,
        exitCode: 1,
        signal: null,
      });
    const service = createService({
      runGitCommand,
      now: () => new Date(nowMs),
    });

    const first = service.hasLocalBranch("/tmp/repo", "feature");
    const second = service.hasLocalBranch("/tmp/repo/.", "feature");
    await flushPromises();

    expect(runGitCommand).toHaveBeenCalledTimes(1);
    expect(runGitCommand).toHaveBeenCalledWith(
      ["rev-parse", "--verify", "--quiet", "refs/heads/feature"],
      expect.objectContaining({
        cwd: "/tmp/repo",
        acceptExitCodes: [0, 1],
      }),
    );
    branchLookup.resolve({
      stdout: "",
      stderr: "",
      truncated: false,
      exitCode: 0,
      signal: null,
    });
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);

    nowMs = 1_000;
    await expect(service.hasLocalBranch("/tmp/repo", "feature")).resolves.toBe(true);
    expect(runGitCommand).toHaveBeenCalledTimes(1);

    await expect(
      service.hasLocalBranch("/tmp/repo", "feature", { force: true, reason: "test" }),
    ).resolves.toBe(false);
    expect(runGitCommand).toHaveBeenCalledTimes(2);

    service.dispose();
  });

  test("validateBranchRef serves stale cache during internal min-gap after a failed refresh", async () => {
    let nowMs = 0;
    const resolveBranchCheckout = vi
      .fn()
      .mockResolvedValueOnce({ kind: "local", name: "feature-old" })
      .mockRejectedValueOnce(new Error("git is busy"))
      .mockResolvedValue({ kind: "local", name: "feature-new" });
    const service = createService({
      resolveBranchCheckout,
      now: () => new Date(nowMs),
    });

    await expect(service.validateBranchRef("/tmp/repo", "feature")).resolves.toEqual({
      kind: "local",
      name: "feature-old",
    });

    nowMs = 16_000;
    resolveBranchCheckout.mockClear();
    await expect(service.validateBranchRef("/tmp/repo", "feature")).rejects.toThrow("git is busy");
    expect(resolveBranchCheckout).toHaveBeenCalledTimes(1);

    nowMs = 16_500;
    await expect(service.validateBranchRef("/tmp/repo", "feature")).resolves.toEqual({
      kind: "local",
      name: "feature-old",
    });
    expect(resolveBranchCheckout).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  test("suggestBranchesForCwd cold-loads, warms, forces, and coalesces per query", async () => {
    let nowMs = 0;
    const suggestions = [{ name: "feature", committerDate: 1, hasLocal: true, hasRemote: false }];
    const suggestionsDeferred = createDeferred<typeof suggestions>();
    const listBranchSuggestions = vi
      .fn()
      .mockImplementationOnce(async () => suggestionsDeferred.promise)
      .mockResolvedValue(suggestions);
    const service = createService({
      listBranchSuggestions,
      now: () => new Date(nowMs),
    });

    const first = service.suggestBranchesForCwd("/tmp/repo", { query: "feat", limit: 5 });
    const second = service.suggestBranchesForCwd("/tmp/repo/.", {
      query: "feat",
      limit: 5,
    });
    await flushPromises();

    expect(listBranchSuggestions).toHaveBeenCalledTimes(1);
    suggestionsDeferred.resolve(suggestions);
    await expect(Promise.all([first, second])).resolves.toEqual([suggestions, suggestions]);

    nowMs = 1_000;
    await service.suggestBranchesForCwd("/tmp/repo", { query: "feat", limit: 5 });
    expect(listBranchSuggestions).toHaveBeenCalledTimes(1);

    await service.suggestBranchesForCwd(
      "/tmp/repo",
      { query: "feat", limit: 5 },
      { force: true, reason: "test" },
    );
    expect(listBranchSuggestions).toHaveBeenCalledTimes(2);

    service.dispose();
  });

  test("listStashes cold-loads, warms, forces, and coalesces per cwd", async () => {
    let nowMs = 0;
    const stashOutput = "stash@{0}\u0000paseo-auto-stash: feature\n";
    const stashDeferred = createDeferred<{
      stdout: string;
      stderr: string;
      truncated: boolean;
      exitCode: number;
      signal: null;
    }>();
    const runGitCommand = vi
      .fn()
      .mockImplementationOnce(async () => stashDeferred.promise)
      .mockResolvedValue({
        stdout: stashOutput,
        stderr: "",
        truncated: false,
        exitCode: 0,
        signal: null,
      });
    const service = createService({
      runGitCommand,
      now: () => new Date(nowMs),
    });

    const first = service.listStashes("/tmp/repo", { paseoOnly: true });
    const second = service.listStashes("/tmp/repo/.", { paseoOnly: true });
    await flushPromises();

    expect(runGitCommand).toHaveBeenCalledTimes(1);
    stashDeferred.resolve({
      stdout: stashOutput,
      stderr: "",
      truncated: false,
      exitCode: 0,
      signal: null,
    });
    await expect(Promise.all([first, second])).resolves.toEqual([
      [{ index: 0, message: "paseo-auto-stash: feature", branch: "feature", isPaseo: true }],
      [{ index: 0, message: "paseo-auto-stash: feature", branch: "feature", isPaseo: true }],
    ]);

    nowMs = 1_000;
    await service.listStashes("/tmp/repo", { paseoOnly: true });
    expect(runGitCommand).toHaveBeenCalledTimes(1);

    await service.listStashes("/tmp/repo", { paseoOnly: true }, { force: true, reason: "test" });
    expect(runGitCommand).toHaveBeenCalledTimes(2);

    service.dispose();
  });

  test("listWorktrees cold-loads, warms, forces, and coalesces per repo root", async () => {
    let nowMs = 0;
    const worktrees = [
      {
        path: "/tmp/paseo-home/worktrees/repo/feature",
        createdAt: "2026-04-12T00:00:00.000Z",
        branchName: "feature",
      },
    ];
    const listPaseoWorktrees = vi.fn().mockResolvedValue(worktrees);
    const service = createService({
      listPaseoWorktrees,
      now: () => new Date(nowMs),
    });

    const first = service.listWorktrees("/tmp/repo");
    const second = service.listWorktrees("/tmp/repo/.");
    await expect(Promise.all([first, second])).resolves.toEqual([worktrees, worktrees]);
    expect(listPaseoWorktrees).toHaveBeenCalledTimes(1);

    nowMs = 1_000;
    await service.listWorktrees("/tmp/repo");
    expect(listPaseoWorktrees).toHaveBeenCalledTimes(1);

    await service.listWorktrees("/tmp/repo", { force: true, reason: "test" });
    expect(listPaseoWorktrees).toHaveBeenCalledTimes(2);

    service.dispose();
  });

  test("listWorktrees shares one repo-root scoped read across sibling workspace cwds", async () => {
    const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "workspace-git-service-")));
    const repoDir = join(tempDir, "repo");
    const nestedWorkspaceDir = join(repoDir, "packages", "app");
    mkdirSync(nestedWorkspaceDir, { recursive: true });
    execSync("git init -b main", { cwd: repoDir, stdio: "pipe" });

    const worktrees = [
      {
        path: join(tempDir, "paseo-home", "worktrees", "repo", "feature"),
        createdAt: "2026-04-12T00:00:00.000Z",
        branchName: "feature",
      },
    ];
    const listPaseoWorktrees = vi.fn(async () => worktrees);
    const service = createService({
      getCheckoutStatus: getCheckoutStatusUncached as never,
      listPaseoWorktrees,
    });

    try {
      await expect(
        Promise.all([service.listWorktrees(repoDir), service.listWorktrees(nestedWorkspaceDir)]),
      ).resolves.toEqual([worktrees, worktrees]);
      await expect(service.listWorktrees(nestedWorkspaceDir)).resolves.toEqual(worktrees);

      expect(listPaseoWorktrees).toHaveBeenCalledTimes(1);
      expect(listPaseoWorktrees).toHaveBeenCalledWith({
        cwd: repoDir,
        paseoHome: "/tmp/paseo-test",
      });
    } finally {
      service.dispose();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("resolveDefaultBranch cold-loads, warms, forces, and coalesces per cwd", async () => {
    let nowMs = 0;
    const defaultBranch = createDeferred<string | null>();
    const resolveRepositoryDefaultBranch = vi
      .fn()
      .mockImplementationOnce(async () => defaultBranch.promise)
      .mockResolvedValue("trunk");
    const service = createService({
      resolveRepositoryDefaultBranch,
      now: () => new Date(nowMs),
    });

    const first = service.resolveDefaultBranch("/tmp/repo");
    const second = service.resolveDefaultBranch("/tmp/repo/.");
    await flushPromises();

    expect(resolveRepositoryDefaultBranch).toHaveBeenCalledTimes(1);
    defaultBranch.resolve("main");
    await expect(Promise.all([first, second])).resolves.toEqual(["main", "main"]);

    nowMs = 1_000;
    await service.resolveDefaultBranch("/tmp/repo");
    expect(resolveRepositoryDefaultBranch).toHaveBeenCalledTimes(1);

    await service.resolveDefaultBranch("/tmp/repo", { force: true, reason: "test" });
    expect(resolveRepositoryDefaultBranch).toHaveBeenCalledTimes(2);

    service.dispose();
  });

  test("resolveRepoRoot cold-loads, warms, forces, and coalesces through snapshots", async () => {
    let nowMs = 0;
    const checkoutDeferred = createDeferred<CheckoutStatusGit>();
    const getCheckoutStatus = vi
      .fn()
      .mockImplementationOnce(async () => checkoutDeferred.promise)
      .mockResolvedValue(createCheckoutStatus("/tmp/repo"));
    const service = createService({
      getCheckoutStatus,
      now: () => new Date(nowMs),
    });

    const first = service.resolveRepoRoot("/tmp/repo");
    const second = service.resolveRepoRoot("/tmp/repo/.");
    await flushPromises();

    expect(getCheckoutStatus).toHaveBeenCalledTimes(1);
    checkoutDeferred.resolve(createCheckoutStatus("/tmp/repo"));
    await expect(Promise.all([first, second])).resolves.toEqual(["/tmp/repo", "/tmp/repo"]);

    nowMs = 1_000;
    await service.resolveRepoRoot("/tmp/repo");
    expect(getCheckoutStatus).toHaveBeenCalledTimes(1);

    await service.resolveRepoRoot("/tmp/repo", { force: true, reason: "test" });
    expect(getCheckoutStatus).toHaveBeenCalledTimes(2);

    service.dispose();
  });

  test("resolveRepoRemoteUrl reads remote URL through the snapshot cache", async () => {
    let nowMs = 0;
    const getCheckoutStatus = vi.fn(async (cwd: string) =>
      createCheckoutStatus(cwd, {
        remoteUrl: "https://github.com/getpaseo/paseo.git",
      }),
    );
    const service = createService({
      getCheckoutStatus,
      now: () => new Date(nowMs),
    });

    await expect(service.resolveRepoRemoteUrl("/tmp/repo")).resolves.toBe(
      "https://github.com/getpaseo/paseo.git",
    );
    nowMs = 1_000;
    await expect(service.resolveRepoRemoteUrl("/tmp/repo/.")).resolves.toBe(
      "https://github.com/getpaseo/paseo.git",
    );

    expect(getCheckoutStatus).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  test("getWorkspaceGitMetadata derives reconciliation metadata from the snapshot cache", async () => {
    let nowMs = 0;
    const getCheckoutStatus = vi.fn(async (cwd: string) =>
      createCheckoutStatus(cwd, {
        currentBranch: "feature/service-metadata",
        remoteUrl: "https://github.com/getpaseo/paseo.git",
        repoRoot: "/tmp/repo",
      }),
    );
    const service = createService({
      getCheckoutStatus,
      now: () => new Date(nowMs),
    });

    await expect(
      service.getWorkspaceGitMetadata("/tmp/repo", { directoryName: "Local Repo" }),
    ).resolves.toEqual({
      projectKind: "git",
      projectDisplayName: "getpaseo/paseo",
      workspaceDisplayName: "feature/service-metadata",
      gitRemote: "https://github.com/getpaseo/paseo.git",
      isWorktree: false,
      projectSlug: "paseo",
      repoRoot: "/tmp/repo",
      currentBranch: "feature/service-metadata",
      remoteUrl: "https://github.com/getpaseo/paseo.git",
    });

    nowMs = 1_000;
    await service.getWorkspaceGitMetadata("/tmp/repo/.", { directoryName: "Local Repo" });
    expect(getCheckoutStatus).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  test("getCheckoutDiff returns real staged and unstaged changes from a temp git repo", async () => {
    const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "workspace-git-service-diff-")));
    const repoDir = join(tempDir, "repo");
    mkdirSync(repoDir, { recursive: true });
    execSync("git init -b main", { cwd: repoDir, stdio: "pipe" });
    execSync("git config user.email 'test@test.com'", { cwd: repoDir, stdio: "pipe" });
    execSync("git config user.name 'Test'", { cwd: repoDir, stdio: "pipe" });
    writeFileSync(join(repoDir, "tracked.txt"), "before\n");
    execSync("git add tracked.txt", { cwd: repoDir, stdio: "pipe" });
    execSync("git -c commit.gpgsign=false commit -m 'initial'", {
      cwd: repoDir,
      stdio: "pipe",
    });
    writeFileSync(join(repoDir, "tracked.txt"), "before\nafter\n");
    writeFileSync(join(repoDir, "staged.txt"), "staged\n");
    execSync("git add staged.txt", { cwd: repoDir, stdio: "pipe" });

    const service = createService({
      getCheckoutDiff: getCheckoutDiffUncached as never,
    });

    try {
      const diff = await service.getCheckoutDiff(repoDir, {
        mode: "uncommitted",
        includeStructured: true,
      });

      expect(diff.diff).toContain("tracked.txt");
      expect(diff.diff).toContain("staged.txt");
      expect(diff.structured?.map((file) => file.path).sort()).toEqual([
        "staged.txt",
        "tracked.txt",
      ]);
    } finally {
      service.dispose();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("getCheckoutDiff coalesces concurrent callers per cwd and compare options", async () => {
    const diffDeferred = createDeferred<CheckoutDiffResult>();
    const getCheckoutDiff = vi
      .fn<(cwd: string, compare: CheckoutDiffCompare) => Promise<CheckoutDiffResult>>()
      .mockImplementationOnce(async () => diffDeferred.promise)
      .mockResolvedValue({ diff: "second" });
    const service = createService({ getCheckoutDiff, now: () => new Date(0) });

    const first = service.getCheckoutDiff("/tmp/repo", { mode: "uncommitted" });
    const second = service.getCheckoutDiff("/tmp/repo/.", { mode: "uncommitted" });
    await flushPromises();

    expect(getCheckoutDiff).toHaveBeenCalledTimes(1);
    diffDeferred.resolve({ diff: "shared" });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { diff: "shared" },
      { diff: "shared" },
    ]);
    expect(getCheckoutDiff).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  test("forced getCheckoutDiff bypasses warm cache and internal min-gap", async () => {
    let nowMs = 0;
    const getCheckoutDiff = vi
      .fn()
      .mockResolvedValueOnce({ diff: "first" })
      .mockResolvedValueOnce({ diff: "forced" });
    const service = createService({
      getCheckoutDiff,
      now: () => new Date(nowMs),
    });

    await expect(service.getCheckoutDiff("/tmp/repo", { mode: "uncommitted" })).resolves.toEqual({
      diff: "first",
    });
    nowMs = 1;
    await expect(
      service.getCheckoutDiff(
        "/tmp/repo",
        { mode: "uncommitted" },
        { force: true, reason: "test" },
      ),
    ).resolves.toEqual({ diff: "forced" });

    expect(getCheckoutDiff).toHaveBeenCalledTimes(2);

    service.dispose();
  });

  test("getCheckoutDiff serves cached value within the internal min-gap for non-forced reads", async () => {
    let nowMs = 0;
    const getCheckoutDiff = vi
      .fn()
      .mockResolvedValueOnce({ diff: "first" })
      .mockRejectedValueOnce(new Error("git is busy"))
      .mockResolvedValueOnce({ diff: "second" });
    const service = createService({
      getCheckoutDiff,
      now: () => new Date(nowMs),
    });

    await expect(service.getCheckoutDiff("/tmp/repo", { mode: "uncommitted" })).resolves.toEqual({
      diff: "first",
    });
    nowMs = 16_000;
    await expect(service.getCheckoutDiff("/tmp/repo", { mode: "uncommitted" })).rejects.toThrow(
      "git is busy",
    );
    nowMs = 16_500;
    await expect(service.getCheckoutDiff("/tmp/repo", { mode: "uncommitted" })).resolves.toEqual({
      diff: "first",
    });

    expect(getCheckoutDiff).toHaveBeenCalledTimes(2);

    service.dispose();
  });

  test("getCheckoutDiff uses different cache keys for different compare arguments", async () => {
    const getCheckoutDiff = vi
      .fn()
      .mockResolvedValueOnce({ diff: "main" })
      .mockResolvedValueOnce({ diff: "release" })
      .mockResolvedValueOnce({ diff: "main-whitespace" });
    const service = createService({
      getCheckoutDiff,
      now: () => new Date(0),
    });

    await expect(
      service.getCheckoutDiff("/tmp/repo", { mode: "base", baseRef: "main" }),
    ).resolves.toEqual({ diff: "main" });
    await expect(
      service.getCheckoutDiff("/tmp/repo", { mode: "base", baseRef: "release" }),
    ).resolves.toEqual({ diff: "release" });
    await expect(
      service.getCheckoutDiff("/tmp/repo", {
        mode: "base",
        baseRef: "main",
        ignoreWhitespace: true,
      }),
    ).resolves.toEqual({ diff: "main-whitespace" });

    expect(getCheckoutDiff).toHaveBeenCalledTimes(3);

    service.dispose();
  });
});
