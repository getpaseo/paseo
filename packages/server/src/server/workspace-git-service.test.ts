import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import path from "node:path";
import type { FSWatcher } from "node:fs";
import type pino from "pino";
import type { GitHubService } from "../services/github-service.js";
import type { CheckoutStatusGit, PullRequestStatusResult } from "../utils/checkout-git.js";
import {
  WorkspaceGitServiceImpl,
  type WorkspaceGitRuntimeSnapshot,
} from "./workspace-git-service.js";

interface ServiceInternals {
  workingTreeWatchTargets: Map<string, { fallbackRefreshInterval: unknown; repoWatchPath: string }>;
  scheduleWorkspaceRefresh(cwd: string, options: { force: boolean; reason: string }): void;
}

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
  await Promise.resolve();
  await Promise.resolve();
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
    createPullRequest: vi.fn(async () => ({
      url: "https://github.com/acme/repo/pull/1",
      number: 1,
    })),
    isAuthenticated: vi.fn(async () => true),
    invalidate: vi.fn(),
  };
}

interface CreateServiceTestOptions {
  getCheckoutStatus?: ReturnType<typeof vi.fn>;
  getCheckoutShortstat?: ReturnType<typeof vi.fn>;
  getPullRequestStatus?: ReturnType<typeof vi.fn>;
  github?: GitHubService;
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
    getCheckoutStatus: vi.fn(async (cwd: string) => createCheckoutStatus(cwd)),
    getCheckoutShortstat: vi.fn(async () => ({
      additions: 1,
      deletions: 0,
    })),
    getPullRequestStatus: vi.fn(async () => createPullRequestStatusResult()),
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
    const subscription = service.registerWorkspace({ cwd: "/tmp/repo" }, listener);

    expect(subscription).toEqual({ unsubscribe: expect.any(Function) });
    expect("initial" in subscription).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(service.peekSnapshot("/tmp/repo")).toBeNull();

    subscription.unsubscribe();
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

    await expect(service.getSnapshot("/tmp/repo")).resolves.toEqual(
      createSnapshot("/tmp/repo", {
        github: {
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

    await expect(service.getSnapshot("/tmp/repo")).resolves.toEqual(
      createSnapshot("/tmp/repo", {
        git: {
          repoRoot: "/tmp/repo",
          currentBranch: "feature/worktree",
          isPaseoOwnedWorktree: false,
          mainRepoRoot: "/tmp/main-repo",
          diffStat: null,
        },
      }),
    );
  });

  test("non-forced GitHub refresh does not emit when pull request state is unchanged", async () => {
    let nowMs = Date.parse("2026-04-12T00:00:00.000Z");
    const getPullRequestStatus = vi.fn(async () => createPullRequestStatusResult());
    const service = createService({
      getPullRequestStatus,
      now: () => new Date(nowMs),
    });
    const listener = vi.fn();
    await service.getSnapshot("/tmp/repo");
    const subscription = service.registerWorkspace({ cwd: "/tmp/repo" }, listener);

    nowMs += 3_000;
    await service.refresh("/tmp/repo");

    expect(getPullRequestStatus).toHaveBeenCalledTimes(2);
    expect(listener).not.toHaveBeenCalled();

    subscription.unsubscribe();
    service.dispose();
  });

  test("cold getSnapshot calls share one workspace target setup and cache the snapshot", async () => {
    const checkoutStatusDeferred = createDeferred<CheckoutStatusGit>();
    const getCheckoutStatus = vi.fn(async () => checkoutStatusDeferred.promise);
    const getPullRequestStatus = vi.fn(async () => createPullRequestStatusResult());
    const resolveAbsoluteGitDir = vi.fn(async () => "/tmp/repo/.git");

    const service = createService({
      getCheckoutStatus,
      getPullRequestStatus,
      resolveAbsoluteGitDir,
    });

    const firstSnapshotPromise = service.getSnapshot("/tmp/repo");
    const secondSnapshotPromise = service.getSnapshot("/tmp/repo/.");
    await flushPromises();

    expect(getCheckoutStatus).toHaveBeenCalledTimes(1);
    expect(getPullRequestStatus).toHaveBeenCalledTimes(0);
    expect(resolveAbsoluteGitDir).toHaveBeenCalledTimes(0);

    checkoutStatusDeferred.resolve(createCheckoutStatus("/tmp/repo"));

    await expect(Promise.all([firstSnapshotPromise, secondSnapshotPromise])).resolves.toEqual([
      createSnapshot("/tmp/repo"),
      createSnapshot("/tmp/repo"),
    ]);

    expect(getCheckoutStatus).toHaveBeenCalledTimes(1);
    expect(getPullRequestStatus).toHaveBeenCalledTimes(1);
    expect(resolveAbsoluteGitDir).toHaveBeenCalledTimes(0);
    expect(service.peekSnapshot("/tmp/repo")).toEqual(createSnapshot("/tmp/repo"));

    await expect(service.getSnapshot("/tmp/repo")).resolves.toEqual(createSnapshot("/tmp/repo"));
    expect(getCheckoutStatus).toHaveBeenCalledTimes(1);
    expect(getPullRequestStatus).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  test("multiple listeners on the same workspace share one GitHub pull request lookup", async () => {
    const getPullRequestStatus = vi.fn(async () => createPullRequestStatusResult());
    const resolveAbsoluteGitDir = vi.fn(async () => "/tmp/repo/.git");

    let nowMs = Date.parse("2026-04-12T00:00:00.000Z");
    const service = createService({
      getPullRequestStatus,
      resolveAbsoluteGitDir,
      now: () => new Date(nowMs),
    });

    const first = service.registerWorkspace({ cwd: "/tmp/repo" }, vi.fn());
    const second = service.registerWorkspace({ cwd: "/tmp/repo" }, vi.fn());
    await flushPromises();

    expect(getPullRequestStatus).toHaveBeenCalledTimes(1);
    expect(resolveAbsoluteGitDir).toHaveBeenCalledTimes(1);

    first.unsubscribe();
    second.unsubscribe();
    service.dispose();
  });

  test("equivalent cwd strings share one workspace target across service entry points", async () => {
    const getPullRequestStatus = vi.fn(async () => createPullRequestStatusResult());
    const resolveAbsoluteGitDir = vi.fn(async () => "/tmp/repo/.git");

    let nowMs = Date.parse("2026-04-12T00:00:00.000Z");
    const service = createService({
      getPullRequestStatus,
      resolveAbsoluteGitDir,
      now: () => new Date(nowMs),
    });

    const subscription = service.registerWorkspace({ cwd: "/tmp/repo/." }, vi.fn());

    await expect(service.getSnapshot("/tmp/repo/.")).resolves.toEqual(createSnapshot("/tmp/repo"));
    expect(service.peekSnapshot("/tmp/repo")).toEqual(createSnapshot("/tmp/repo"));

    nowMs += 3_000;
    await service.refresh("/tmp/repo");
    await expect(service.getSnapshot("/tmp/repo/.")).resolves.toEqual(createSnapshot("/tmp/repo"));

    expect(getPullRequestStatus).toHaveBeenCalledTimes(2);
    expect(resolveAbsoluteGitDir).toHaveBeenCalledTimes(1);

    subscription.unsubscribe();
    service.dispose();
  });

  test("repo-level fetch intervals are shared for workspaces in the same repo", async () => {
    const runGitFetch = vi.fn(async () => {});
    const hasOriginRemote = vi.fn(async () => true);
    const resolveAbsoluteGitDir = vi.fn(async () => "/tmp/repo/.git");

    const service = createService({
      resolveAbsoluteGitDir,
      hasOriginRemote,
      runGitFetch,
    });

    const first = service.registerWorkspace({ cwd: "/tmp/repo" }, vi.fn());
    const second = service.registerWorkspace({ cwd: "/tmp/repo/packages/server" }, vi.fn());
    await vi.waitFor(() => {
      expect(resolveAbsoluteGitDir).toHaveBeenCalledTimes(2);
      expect(runGitFetch).toHaveBeenCalledTimes(1);
    });

    expect(hasOriginRemote).toHaveBeenCalledTimes(1);
    expect(runGitFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(180_000);
    await flushPromises();

    expect(runGitFetch).toHaveBeenCalledTimes(2);

    first.unsubscribe();
    second.unsubscribe();
    service.dispose();
  });

  test("explicit refresh recomputes github state and notifies listeners", async () => {
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
    const initialSnapshot = await service.getSnapshot("/tmp/repo");
    const subscription = service.registerWorkspace({ cwd: "/tmp/repo" }, listener);

    expect(initialSnapshot.github.pullRequest?.title).toBe("Before refresh");

    await service.refresh("/tmp/repo");
    await flushPromises();

    expect(getPullRequestStatus).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      createSnapshot("/tmp/repo", {
        github: {
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
      .mockResolvedValueOnce(createCheckoutStatus("/tmp/repo", { remoteUrl: null }))
      .mockResolvedValueOnce(
        createCheckoutStatus("/tmp/repo", {
          currentBranch: "feature/runtime-payloads",
          remoteUrl: null,
          aheadBehind: { ahead: 2, behind: 0 },
          aheadOfOrigin: 2,
        }),
      )
      .mockResolvedValueOnce(
        createCheckoutStatus("/tmp/repo", {
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
    const initialSnapshot = await service.getSnapshot("/tmp/repo");
    const subscription = service.registerWorkspace({ cwd: "/tmp/repo" }, listener);

    expect(initialSnapshot.git.currentBranch).toBe("main");

    nowMs += 3_000;
    await service.refresh("/tmp/repo");
    await flushPromises();

    nowMs += 3_000;
    await service.refresh("/tmp/repo");
    await flushPromises();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      createSnapshot("/tmp/repo", {
        git: {
          currentBranch: "feature/runtime-payloads",
          remoteUrl: null,
          aheadBehind: { ahead: 2, behind: 0 },
          aheadOfOrigin: 2,
        },
        github: {
          featuresEnabled: false,
          pullRequest: null,
        },
      }),
    );

    subscription.unsubscribe();
    service.dispose();
  });

  test("forced snapshot refresh emits even when the fingerprint matches", async () => {
    const getCheckoutStatus = vi.fn(async () => createCheckoutStatus("/tmp/repo"));
    const getPullRequestStatus = vi.fn(async () => createPullRequestStatusResult());
    let nowMs = Date.parse("2026-04-12T00:00:00.000Z");
    const service = createService({
      getCheckoutStatus,
      getPullRequestStatus,
      now: () => new Date(nowMs),
    });

    const listener = vi.fn();
    await service.getSnapshot("/tmp/repo");
    const subscription = service.registerWorkspace({ cwd: "/tmp/repo" }, listener);

    await service.getSnapshot("/tmp/repo", {
      force: true,
      reason: "test-force-emit",
    });
    await flushPromises();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(createSnapshot("/tmp/repo"));

    subscription.unsubscribe();
    service.dispose();
  });

  test("watches nested repository directories on Linux", async () => {
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
      if (directory === "/tmp/repo") {
        return [
          createDirent("packages", true),
          createDirent(".git", true),
          createDirent("README.md", false),
        ];
      }
      if (directory === path.join("/tmp/repo", "packages")) {
        return [createDirent("server", true), createDirent("app", true)];
      }
      if (directory === path.join("/tmp/repo", "packages", "server")) {
        return [createDirent("src", true)];
      }
      if (directory === path.join("/tmp/repo", "packages", "server", "src")) {
        return [createDirent("server", true)];
      }
      return [];
    });

    const service = createService({ watch, readdir });
    const subscription = await service.requestWorkingTreeWatch(
      path.join("/tmp/repo", "packages", "server"),
      vi.fn(),
    );

    expect(subscription.repoRoot).toBe("/tmp/repo");
    expect(watchCalls.map((entry) => entry.path).sort()).toEqual([
      "/tmp/repo",
      "/tmp/repo/.git",
      "/tmp/repo/packages",
      "/tmp/repo/packages/app",
      "/tmp/repo/packages/server",
      "/tmp/repo/packages/server/src",
      "/tmp/repo/packages/server/src/server",
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
    const first = await service.requestWorkingTreeWatch("/tmp/repo", firstListener);
    const second = await service.requestWorkingTreeWatch("/tmp/repo/.", secondListener);

    expect(first.repoRoot).toBe("/tmp/repo");
    expect(second.repoRoot).toBe("/tmp/repo");
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
    const subscription = await service.requestWorkingTreeWatch("/tmp/repo", vi.fn());
    const target = (service as unknown as ServiceInternals).workingTreeWatchTargets.get(
      "/tmp/repo",
    );

    expect(target?.fallbackRefreshInterval).not.toBeNull();

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

    const subscription = await service.requestWorkingTreeWatch("/tmp/plain", vi.fn());
    const target = (service as unknown as ServiceInternals).workingTreeWatchTargets.get(
      "/tmp/plain",
    );

    expect(subscription.repoRoot).toBeNull();
    const expectedRecursive = process.platform !== "linux";
    expect(watch).toHaveBeenCalledWith(
      "/tmp/plain",
      { recursive: expectedRecursive },
      expect.any(Function),
    );
    expect(target?.repoWatchPath).toBe("/tmp/plain");
    expect(target?.fallbackRefreshInterval).not.toBeNull();

    subscription.unsubscribe();
    service.dispose();
  });

  test("working tree changes notify listeners and schedule workspace refresh", async () => {
    const watchCallbacks: Array<() => void> = [];
    const watch = vi.fn(
      (_watchPath: string, _options: { recursive: boolean }, callback: () => void) => {
        watchCallbacks.push(callback);
        return createWatcher();
      },
    );
    const service = createService({ watch });
    const refreshSpy = vi.spyOn(service as unknown as ServiceInternals, "scheduleWorkspaceRefresh");
    const listener = vi.fn();

    const subscription = await service.requestWorkingTreeWatch("/tmp/repo", listener);
    expect(watchCallbacks).toHaveLength(2);

    watchCallbacks[0]?.();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(refreshSpy).toHaveBeenCalledWith("/tmp/repo", {
      force: true,
      reason: "working-tree-watch",
    });

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

    const initialSnapshot = await service.getSnapshot("/tmp/repo");
    const workspaceSubscription = service.registerWorkspace(
      { cwd: "/tmp/repo" },
      workspaceListener,
    );
    const diffSubscription = await service.requestWorkingTreeWatch("/tmp/repo", vi.fn());

    expect(initialSnapshot.git.diffStat).toEqual({ additions: 1, deletions: 0 });
    const repoRootWatch = watchCallbacks.find((entry) => entry.path === "/tmp/repo");
    expect(repoRootWatch).toBeDefined();

    repoRootWatch?.callback();
    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();

    expect(getCheckoutShortstat).toHaveBeenLastCalledWith(
      "/tmp/repo",
      { paseoHome: "/tmp/paseo-test" },
      { force: true },
    );
    expect(workspaceListener).toHaveBeenCalledWith(
      createSnapshot("/tmp/repo", {
        git: { diffStat: { additions: 8, deletions: 3 } },
      }),
    );

    diffSubscription.unsubscribe();
    workspaceSubscription.unsubscribe();
    service.dispose();
  });
});
