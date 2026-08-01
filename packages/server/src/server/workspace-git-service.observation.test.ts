import path from "node:path";
import type pino from "pino";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CheckoutSnapshotFacts, CheckoutStatusGit } from "../utils/checkout-git.js";
import { CheckoutDiffManager } from "./checkout-diff-manager.js";
import { WorkspaceGitServiceImpl } from "./workspace-git-service.js";

const REPO_CWD = path.resolve("/tmp/paseo-observation-repo");
const GIT_DIR = path.join(REPO_CWD, ".git");

interface WatchEvent {
  path: string;
  type: "create" | "update" | "delete";
}

interface WatchRecord {
  directory: string;
  callback: (error: Error | null, events: WatchEvent[]) => void;
  ignore: Array<string | RegExp>;
  unsubscribe: ReturnType<typeof vi.fn>;
}

function createWatcherHarness(harnessOptions?: { failDirectories?: Set<string> }) {
  const records: WatchRecord[] = [];
  const subscribe = vi.fn(
    async (
      directory: string,
      callback: WatchRecord["callback"],
      options?: { ignore?: Array<string | RegExp> },
    ) => {
      if (harnessOptions?.failDirectories?.has(directory)) {
        throw new Error(`watch failed: ${directory}`);
      }
      const unsubscribe = vi.fn(async () => {});
      records.push({
        directory,
        callback,
        ignore: options?.ignore ?? [],
        unsubscribe,
      });
      return { unsubscribe };
    },
  );

  return { records, subscribe };
}

function createCheckoutFacts(cwd: string): CheckoutSnapshotFacts {
  return {
    isGit: true,
    worktreeRoot: cwd,
    currentBranch: "main",
    remoteUrl: null,
    absoluteGitDir: path.join(cwd, ".git"),
    gitCommonDir: path.join(cwd, ".git"),
    paseoWorktree: { isPaseoOwnedWorktree: false },
    storedBaseRef: null,
    resolvedBaseRef: "main",
    mainRepoRoot: null,
    comparisonBaseRef: null,
    branchRemoteName: null,
    branchMergeRef: null,
    pullRequestLookupTarget: { headRef: "main" },
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
    aheadOfOrigin: null,
    behindOfOrigin: null,
    hasRemote: false,
    remoteUrl: null,
    isPaseoOwnedWorktree: false,
    ...overrides,
  };
}

function createLogger(): pino.Logger {
  const logger = {
    child: () => logger,
    debug: vi.fn(),
    warn: vi.fn(),
  };
  return logger as unknown as pino.Logger;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createService(
  watcher: ReturnType<typeof createWatcherHarness>,
  overrides?: Record<string, unknown>,
) {
  const defaultGetCheckoutStatus = vi.fn(async (cwd: string) => createCheckoutStatus(cwd));
  const defaultGetCheckoutShortstat = vi.fn(async () => null);
  const getCheckoutStatus =
    (overrides?.getCheckoutStatus as typeof defaultGetCheckoutStatus | undefined) ??
    defaultGetCheckoutStatus;
  const getCheckoutShortstat =
    (overrides?.getCheckoutShortstat as typeof defaultGetCheckoutShortstat | undefined) ??
    defaultGetCheckoutShortstat;
  return new WorkspaceGitServiceImpl({
    logger: createLogger(),
    paseoHome: "/tmp/paseo-home",
    deps: {
      subscribe: watcher.subscribe,
      getCheckoutSnapshotFacts: vi.fn(async (cwd: string) => createCheckoutFacts(cwd)),
      getCheckoutStatus,
      getCheckoutShortstat,
      getCheckoutWorktreeState: vi.fn(async (cwd: string) => {
        const status = await getCheckoutStatus(cwd);
        if (!status.isGit) {
          throw new Error("Expected a git checkout");
        }
        return {
          isDirty: status.isDirty,
          diffStat: await getCheckoutShortstat(),
        };
      }),
      resolveAbsoluteGitDir: vi.fn(async () => GIT_DIR),
      hasOriginRemote: vi.fn(async () => false),
      runGitCommand: vi.fn(async () => ({
        stdout: `${REPO_CWD}\n`,
        stderr: "",
        truncated: false,
        exitCode: 0,
        signal: null,
      })),
      ...overrides,
    } as never,
  });
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

describe("WorkspaceGitService checkout observation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("shares one recursive checkout observer between cwd-equivalent consumers", async () => {
    const watcher = createWatcherHarness();
    const runGitCommand = vi.fn(async (args: string[]) => ({
      stdout: args[0] === "rev-parse" ? `${REPO_CWD}\n` : "",
      stderr: "",
      truncated: false,
      exitCode: 0,
      signal: null,
    }));
    const service = createService(watcher, { runGitCommand });
    const firstListener = vi.fn();
    const secondListener = vi.fn();

    const first = await service.requestWorkingTreeWatch(REPO_CWD, firstListener);
    const second = await service.requestWorkingTreeWatch(path.join(REPO_CWD, "."), secondListener);

    expect(first.repoRoot).toBe(REPO_CWD);
    expect(second.repoRoot).toBe(REPO_CWD);
    expect(watcher.subscribe).toHaveBeenCalledTimes(1);
    expect(runGitCommand).toHaveBeenCalledTimes(2);
    expect(watcher.records[0]).toMatchObject({ directory: REPO_CWD });
    expect(watcher.records[0]?.ignore).toContain(GIT_DIR);

    watcher.records[0]?.callback(null, [
      { path: path.join(REPO_CWD, "tracked.txt"), type: "update" },
    ]);
    expect(firstListener).toHaveBeenCalledTimes(1);
    expect(secondListener).toHaveBeenCalledTimes(1);

    first.unsubscribe();
    expect(watcher.records[0]?.unsubscribe).not.toHaveBeenCalled();
    second.unsubscribe();
    await vi.waitFor(() => {
      expect(watcher.records[0]?.unsubscribe).toHaveBeenCalledTimes(1);
    });

    service.dispose();
  });

  test("a second workspace client adds no observation or Git work", async () => {
    const watcher = createWatcherHarness();
    const getCheckoutSnapshotFacts = vi.fn(async (cwd: string) => createCheckoutFacts(cwd));
    const getCheckoutStatus = vi.fn(async (cwd: string) => createCheckoutStatus(cwd));
    const runGitCommand = vi.fn(async (args: string[]) => ({
      stdout: args[0] === "rev-parse" ? `${REPO_CWD}\n` : "",
      stderr: "",
      truncated: false,
      exitCode: 0,
      signal: null,
    }));
    const service = createService(watcher, {
      getCheckoutSnapshotFacts,
      getCheckoutStatus,
      runGitCommand,
    });

    const first = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());
    const second = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());
    await vi.waitFor(() => {
      expect(service.peekSnapshot(REPO_CWD)).not.toBeNull();
      expect(service.getMetrics().workspaceObservationSetupInFlightCount).toBe(0);
      expect(service.getMetrics().workspaceRefreshInFlightCount).toBe(0);
    });

    expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(1);
    expect(getCheckoutStatus).toHaveBeenCalledTimes(1);
    expect(runGitCommand).toHaveBeenCalledTimes(2);
    expect(watcher.records.filter((record) => record.directory === REPO_CWD)).toHaveLength(1);
    expect(watcher.records.filter((record) => record.directory === GIT_DIR)).toHaveLength(1);

    first.unsubscribe();
    second.unsubscribe();
    service.dispose();
  });

  test("a tracked edit refreshes summary and active uncommitted diff without structural or forge work", async () => {
    const watcher = createWatcherHarness();
    const getCheckoutSnapshotFacts = vi.fn(async (cwd: string) => createCheckoutFacts(cwd));
    let diffStat = { additions: 1, deletions: 0 };
    let diffFile = { path: "tracked.txt", additions: 1, deletions: 0, status: "modified" };
    const getCheckoutStatus = vi.fn(async (cwd: string) =>
      createCheckoutStatus(cwd, { isDirty: true }),
    );
    const getCheckoutShortstat = vi.fn(async () => diffStat);
    const getPullRequestStatus = vi.fn();
    const getCheckoutDiff = vi.fn(async () => ({ diff: "", structured: [diffFile] }));
    const service = createService(watcher, {
      getCheckoutSnapshotFacts,
      getCheckoutStatus,
      getCheckoutShortstat,
      getPullRequestStatus,
      getCheckoutDiff,
    });
    const diffManager = new CheckoutDiffManager({
      logger: createLogger(),
      paseoHome: "/tmp/paseo-home",
      workspaceGitService: service,
    });
    const summaryListener = vi.fn();
    const diffListener = vi.fn();

    await service.getSnapshot(REPO_CWD);
    const summarySubscription = service.registerWorkspace({ cwd: REPO_CWD }, summaryListener);
    const diffSubscription = await diffManager.subscribe(
      { cwd: REPO_CWD, compare: { mode: "uncommitted" } },
      diffListener,
    );
    await vi.waitFor(() => {
      expect(watcher.subscribe).toHaveBeenCalledWith(
        REPO_CWD,
        expect.any(Function),
        expect.any(Object),
      );
      expect(service.getMetrics().workingTreeWatchTargetCount).toBe(1);
      expect(service.getMetrics().workspaceObservationSetupInFlightCount).toBe(0);
      expect(service.getMetrics().workspaceRefreshInFlightCount).toBe(0);
    });

    diffStat = { additions: 4, deletions: 2 };
    diffFile = { path: "tracked.txt", additions: 4, deletions: 2, status: "modified" };
    watcher.records[0]?.callback(null, [
      { path: path.join(REPO_CWD, "tracked.txt"), type: "update" },
    ]);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(summaryListener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          git: expect.objectContaining({
            isDirty: true,
            diffStat: { additions: 4, deletions: 2 },
          }),
        }),
      );
      expect(diffListener).toHaveBeenLastCalledWith({
        cwd: REPO_CWD,
        files: [{ path: "tracked.txt", additions: 4, deletions: 2, status: "modified" }],
        error: null,
      });
    });
    await flushPromises();

    expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(1);
    expect(getPullRequestStatus).not.toHaveBeenCalled();

    diffSubscription.unsubscribe();
    summarySubscription.unsubscribe();
    diffManager.dispose();
    service.dispose();
  });

  test("worktree and metadata events invalidate only their matching diff projections", async () => {
    const watcher = createWatcherHarness();
    const getCheckoutDiff = vi.fn(async () => ({ diff: "", structured: [] }));
    const service = createService(watcher, { getCheckoutDiff });
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());

    await vi.waitFor(() => {
      expect(service.peekSnapshot(REPO_CWD)).not.toBeNull();
      expect(service.getMetrics().workspaceObservationSetupInFlightCount).toBe(0);
    });
    await service.getCheckoutDiff(REPO_CWD, { mode: "uncommitted" });
    await service.getCheckoutDiff(REPO_CWD, { mode: "base", baseRef: "main" });
    expect(getCheckoutDiff).toHaveBeenCalledTimes(2);

    watcher.records
      .find((record) => record.directory === REPO_CWD)
      ?.callback(null, [{ path: path.join(REPO_CWD, "tracked.txt"), type: "update" }]);
    await service.getCheckoutDiff(REPO_CWD, { mode: "uncommitted" });
    await service.getCheckoutDiff(REPO_CWD, { mode: "base", baseRef: "main" });
    expect(getCheckoutDiff).toHaveBeenCalledTimes(3);
    expect(getCheckoutDiff.mock.calls[2]?.[1]).toMatchObject({ mode: "uncommitted" });

    watcher.records
      .find((record) => record.directory === GIT_DIR)
      ?.callback(null, [{ path: path.join(GIT_DIR, "HEAD"), type: "update" }]);
    await service.getCheckoutDiff(REPO_CWD, { mode: "base", baseRef: "main" });
    expect(getCheckoutDiff).toHaveBeenCalledTimes(4);
    expect(getCheckoutDiff.mock.calls[3]?.[1]).toMatchObject({ mode: "base" });

    subscription.unsubscribe();
    service.dispose();
  });

  test("metadata refreshes notify ref-dependent consumers when the summary is unchanged", async () => {
    const watcher = createWatcherHarness();
    const getCheckoutSnapshotFacts = vi.fn(async (cwd: string) => createCheckoutFacts(cwd));
    const service = createService(watcher, { getCheckoutSnapshotFacts });
    const listener = vi.fn();
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, listener);

    await vi.waitFor(() => {
      expect(service.getMetrics().workspaceObservationSetupInFlightCount).toBe(0);
      expect(service.getMetrics().workspaceRefreshInFlightCount).toBe(0);
    });
    listener.mockClear();

    watcher.records
      .find((record) => record.directory === GIT_DIR)
      ?.callback(null, [{ path: path.join(GIT_DIR, "packed-refs"), type: "update" }]);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(2);
    });

    expect(listener).toHaveBeenCalledTimes(1);

    subscription.unsubscribe();
    service.dispose();
  });

  test("metadata-only changes refresh worktree summary and active uncommitted diff", async () => {
    const watcher = createWatcherHarness();
    let isDirty = true;
    let diffStat = { additions: 3, deletions: 1 };
    let diffFiles = [{ path: "tracked.txt", additions: 3, deletions: 1, status: "modified" }];
    const getCheckoutStatus = vi.fn(async (cwd: string) => createCheckoutStatus(cwd, { isDirty }));
    const getCheckoutShortstat = vi.fn(async () => diffStat);
    const getCheckoutDiff = vi.fn(async () => ({ diff: "", structured: diffFiles }));
    const service = createService(watcher, {
      getCheckoutStatus,
      getCheckoutShortstat,
      getCheckoutDiff,
    });
    const diffManager = new CheckoutDiffManager({
      logger: createLogger(),
      paseoHome: "/tmp/paseo-home",
      workspaceGitService: service,
    });
    const summaryListener = vi.fn();
    const diffListener = vi.fn();
    const summarySubscription = service.registerWorkspace({ cwd: REPO_CWD }, summaryListener);
    const diffSubscription = await diffManager.subscribe(
      { cwd: REPO_CWD, compare: { mode: "uncommitted" } },
      diffListener,
    );

    await vi.waitFor(() => {
      expect(service.getMetrics().workspaceObservationSetupInFlightCount).toBe(0);
      expect(service.getMetrics().workspaceRefreshInFlightCount).toBe(0);
    });
    isDirty = false;
    diffStat = { additions: 0, deletions: 0 };
    diffFiles = [];

    watcher.records
      .find((record) => record.directory === GIT_DIR)
      ?.callback(null, [{ path: path.join(GIT_DIR, "index"), type: "update" }]);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(summaryListener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          git: expect.objectContaining({
            isDirty: false,
            diffStat: { additions: 0, deletions: 0 },
          }),
        }),
      );
      expect(diffListener).toHaveBeenLastCalledWith({
        cwd: REPO_CWD,
        files: [],
        error: null,
      });
    });

    diffSubscription.unsubscribe();
    summarySubscription.unsubscribe();
    diffManager.dispose();
    service.dispose();
  });

  test("base diff projections follow metadata but ignore volatile worktree updates", async () => {
    const watcher = createWatcherHarness();
    const getCheckoutDiff = vi.fn(async () => ({ diff: "", structured: [] }));
    const getCheckoutWorktreeState = vi.fn(async () => ({
      isDirty: true,
      diffStat: { additions: 4, deletions: 2 },
    }));
    const service = createService(watcher, { getCheckoutDiff, getCheckoutWorktreeState });
    const diffManager = new CheckoutDiffManager({
      logger: createLogger(),
      paseoHome: "/tmp/paseo-home",
      workspaceGitService: service,
    });
    const diffSubscription = await diffManager.subscribe(
      { cwd: REPO_CWD, compare: { mode: "base", baseRef: "main" } },
      vi.fn(),
    );

    await vi.waitFor(() => {
      expect(service.getMetrics().workspaceObservationSetupInFlightCount).toBe(0);
    });
    expect(getCheckoutDiff).toHaveBeenCalledTimes(1);

    watcher.records
      .find((record) => record.directory === REPO_CWD)
      ?.callback(null, [{ path: path.join(REPO_CWD, "tracked.txt"), type: "update" }]);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    expect(getCheckoutDiff).toHaveBeenCalledTimes(1);

    watcher.records
      .find((record) => record.directory === GIT_DIR)
      ?.callback(null, [{ path: path.join(GIT_DIR, "packed-refs"), type: "update" }]);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(150);
    await vi.waitFor(() => {
      expect(getCheckoutDiff).toHaveBeenCalledTimes(2);
    });

    diffSubscription.unsubscribe();
    diffManager.dispose();
    service.dispose();
  });

  test("an event burst during an in-flight refresh produces one final follow-up", async () => {
    const watcher = createWatcherHarness();
    const firstRefresh = createDeferred<CheckoutStatusGit>();
    const getCheckoutStatus = vi
      .fn<() => Promise<CheckoutStatusGit>>()
      .mockResolvedValueOnce(createCheckoutStatus(REPO_CWD))
      .mockImplementationOnce(() => firstRefresh.promise)
      .mockResolvedValue(createCheckoutStatus(REPO_CWD, { isDirty: true }));
    const getCheckoutShortstat = vi
      .fn()
      .mockResolvedValueOnce({ additions: 0, deletions: 0 })
      .mockResolvedValueOnce({ additions: 1, deletions: 0 })
      .mockResolvedValue({ additions: 100, deletions: 25 });
    const service = createService(watcher, { getCheckoutStatus, getCheckoutShortstat });
    const listener = vi.fn();

    await service.getSnapshot(REPO_CWD);
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, listener);
    await vi.waitFor(() => {
      expect(service.getMetrics().workspaceObservationSetupInFlightCount).toBe(0);
    });

    const edit = { path: path.join(REPO_CWD, "tracked.txt"), type: "update" as const };
    watcher.records[0]?.callback(null, [edit]);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(getCheckoutStatus).toHaveBeenCalledTimes(2);
    });

    for (let event = 0; event < 100; event += 1) {
      watcher.records[0]?.callback(null, [edit]);
    }
    await vi.advanceTimersByTimeAsync(1_000);
    expect(service.getMetrics().workspaceRefreshQueuedCount).toBe(1);

    firstRefresh.resolve(createCheckoutStatus(REPO_CWD, { isDirty: true }));
    await vi.waitFor(() => {
      expect(getCheckoutStatus).toHaveBeenCalledTimes(3);
      expect(service.getMetrics().workspaceRefreshInFlightCount).toBe(0);
    });

    expect(getCheckoutStatus).toHaveBeenCalledTimes(3);
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({
        git: expect.objectContaining({
          isDirty: true,
          diffStat: { additions: 100, deletions: 25 },
        }),
      }),
    );
    expect(service.getMetrics().workspaceRefreshQueuedCount).toBe(0);

    subscription.unsubscribe();
    service.dispose();
  });

  test("an event queued during a failed refresh still reaches final state", async () => {
    const watcher = createWatcherHarness();
    const failedRefresh = createDeferred<CheckoutStatusGit>();
    const getCheckoutStatus = vi
      .fn<() => Promise<CheckoutStatusGit>>()
      .mockResolvedValueOnce(createCheckoutStatus(REPO_CWD))
      .mockImplementationOnce(() => failedRefresh.promise)
      .mockResolvedValue(createCheckoutStatus(REPO_CWD, { isDirty: true }));
    const getCheckoutShortstat = vi
      .fn()
      .mockResolvedValueOnce({ additions: 0, deletions: 0 })
      .mockResolvedValue({ additions: 42, deletions: 7 });
    const service = createService(watcher, { getCheckoutStatus, getCheckoutShortstat });
    const listener = vi.fn();

    await service.getSnapshot(REPO_CWD);
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, listener);
    await vi.waitFor(() => {
      expect(service.getMetrics().workspaceObservationSetupInFlightCount).toBe(0);
    });

    const edit = { path: path.join(REPO_CWD, "tracked.txt"), type: "update" as const };
    watcher.records[0]?.callback(null, [edit]);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(getCheckoutStatus).toHaveBeenCalledTimes(2);
    });

    watcher.records[0]?.callback(null, [edit]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(service.getMetrics().workspaceRefreshQueuedCount).toBe(1);

    failedRefresh.reject(new Error("transient Git read failure"));
    await vi.waitFor(() => {
      expect(getCheckoutStatus).toHaveBeenCalledTimes(3);
      expect(service.getMetrics().workspaceRefreshInFlightCount).toBe(0);
    });
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({
        git: expect.objectContaining({
          isDirty: true,
          diffStat: { additions: 42, deletions: 7 },
        }),
      }),
    );

    subscription.unsubscribe();
    service.dispose();
  });

  test("ten worktrees share one repository metadata and fetch observer while retaining checkout state", async () => {
    const watcher = createWatcherHarness();
    const fetch = createDeferred<void>();
    const runGitFetch = vi.fn(() => fetch.promise);
    const commonGitDir = path.resolve("/tmp/paseo-shared-repository.git");
    const worktrees = Array.from({ length: 10 }, (_, index) =>
      path.resolve(`/tmp/paseo-shared-worktree-${index}`),
    );
    const getCheckoutSnapshotFacts = vi.fn(
      async (cwd: string): Promise<CheckoutSnapshotFacts> => ({
        ...createCheckoutFacts(cwd),
        remoteUrl: "https://github.com/acme/shared.git",
        absoluteGitDir: path.join(commonGitDir, "worktrees", path.basename(cwd)),
        gitCommonDir: commonGitDir,
      }),
    );
    const getCheckoutStatus = vi.fn(async (cwd: string) => createCheckoutStatus(cwd));
    const runGitCommand = vi.fn(async (_args: string[], options: { cwd: string }) => ({
      stdout: `${options.cwd}\n`,
      stderr: "",
      truncated: false,
      exitCode: 0,
      signal: null,
    }));
    const service = createService(watcher, {
      getCheckoutSnapshotFacts,
      getCheckoutStatus,
      runGitCommand,
      runGitFetch,
    });
    const subscriptions = worktrees.map((cwd) => service.registerWorkspace({ cwd }, vi.fn()));

    await vi.waitFor(() => {
      expect(service.getMetrics().workspaceObservationSetupInFlightCount).toBe(0);
      expect(service.getMetrics().workingTreeWatchSetupInFlightCount).toBe(0);
      expect(runGitFetch).toHaveBeenCalledTimes(1);
    });

    expect(service.getMetrics()).toMatchObject({
      workspaceTargetCount: 10,
      repositoryTargetCount: 1,
      repositoryWorkspaceLinkCount: 10,
      workingTreeWatchTargetCount: 10,
    });
    expect(watcher.records.filter((record) => record.directory === commonGitDir)).toHaveLength(1);
    expect(watcher.records.filter((record) => worktrees.includes(record.directory))).toHaveLength(
      10,
    );

    subscriptions[0]?.unsubscribe();
    fetch.resolve();
    await vi.waitFor(() => {
      expect(service.getMetrics().fetchInFlightCount).toBe(0);
    });
    await vi.advanceTimersByTimeAsync(180_000);
    await vi.waitFor(() => {
      expect(runGitFetch).toHaveBeenCalledTimes(2);
    });
    expect(runGitFetch).toHaveBeenLastCalledWith(worktrees[1]);

    for (const subscription of subscriptions.slice(1)) {
      subscription.unsubscribe();
    }
    service.dispose();
  });

  test("watcher setup failure uses scoped non-overlapping polling", async () => {
    const watcher = createWatcherHarness({ failDirectories: new Set([REPO_CWD]) });
    const blockedPoll = createDeferred<CheckoutStatusGit>();
    const getCheckoutSnapshotFacts = vi.fn(async (cwd: string) => createCheckoutFacts(cwd));
    const getCheckoutStatus = vi
      .fn<() => Promise<CheckoutStatusGit>>()
      .mockResolvedValueOnce(createCheckoutStatus(REPO_CWD))
      .mockImplementationOnce(() => blockedPoll.promise)
      .mockResolvedValue(createCheckoutStatus(REPO_CWD, { isDirty: true }));
    const getPullRequestStatus = vi.fn();
    const service = createService(watcher, {
      getCheckoutSnapshotFacts,
      getCheckoutStatus,
      getPullRequestStatus,
    });
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());

    await vi.waitFor(() => {
      expect(watcher.subscribe).toHaveBeenCalledWith(
        REPO_CWD,
        expect.any(Function),
        expect.any(Object),
      );
      expect(service.getMetrics().workingTreeWatchTargetCount).toBe(1);
      expect(service.getMetrics().workspaceObservationSetupInFlightCount).toBe(0);
      expect(service.getMetrics().workspaceRefreshInFlightCount).toBe(0);
      expect(service.peekSnapshot(REPO_CWD)).not.toBeNull();
      expect(getCheckoutStatus).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(7_000);
    await vi.waitFor(() => {
      expect(getCheckoutStatus).toHaveBeenCalledTimes(2);
    });

    await vi.advanceTimersByTimeAsync(15_000);
    expect(getCheckoutStatus).toHaveBeenCalledTimes(2);
    expect(service.getMetrics().workspaceRefreshQueuedCount).toBe(0);
    expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(1);
    expect(getPullRequestStatus).not.toHaveBeenCalled();

    blockedPoll.resolve(createCheckoutStatus(REPO_CWD, { isDirty: true }));
    await vi.waitFor(() => {
      expect(service.getMetrics().workspaceRefreshInFlightCount).toBe(0);
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => {
      expect(getCheckoutStatus).toHaveBeenCalledTimes(3);
    });

    subscription.unsubscribe();
    service.dispose();
  });

  test("watcher runtime error switches to scoped polling", async () => {
    const watcher = createWatcherHarness();
    const getCheckoutSnapshotFacts = vi.fn(async (cwd: string) => createCheckoutFacts(cwd));
    const getCheckoutStatus = vi.fn(async (cwd: string) => createCheckoutStatus(cwd));
    const service = createService(watcher, {
      getCheckoutSnapshotFacts,
      getCheckoutStatus,
    });
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());

    await vi.waitFor(() => {
      expect(service.peekSnapshot(REPO_CWD)).not.toBeNull();
      expect(service.getMetrics().workspaceObservationSetupInFlightCount).toBe(0);
    });
    const checkoutWatcher = watcher.records.find((record) => record.directory === REPO_CWD);
    expect(checkoutWatcher).toBeDefined();

    checkoutWatcher?.callback(new Error("watcher stopped"), []);
    await vi.waitFor(() => {
      expect(checkoutWatcher?.unsubscribe).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => {
      expect(getCheckoutStatus).toHaveBeenCalledTimes(2);
    });

    expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(1);
    expect(service.getMetrics().workspaceRefreshQueuedCount).toBe(0);

    subscription.unsubscribe();
    service.dispose();
  });

  test("a missed watcher event converges through the deterministic audit", async () => {
    const watcher = createWatcherHarness();
    let isDirty = false;
    let diffStat = { additions: 0, deletions: 0 };
    let diffFiles: Array<{
      path: string;
      additions: number;
      deletions: number;
      status: string;
    }> = [];
    const getCheckoutStatus = vi.fn(async (cwd: string) => createCheckoutStatus(cwd, { isDirty }));
    const getCheckoutShortstat = vi.fn(async () => diffStat);
    const getCheckoutDiff = vi.fn(async () => ({ diff: "", structured: diffFiles }));
    const service = createService(watcher, {
      getCheckoutStatus,
      getCheckoutShortstat,
      getCheckoutDiff,
      getWorkspaceGitSelfHealPhaseMs: () => 10_000,
    });
    const diffManager = new CheckoutDiffManager({
      logger: createLogger(),
      paseoHome: "/tmp/paseo-home",
      workspaceGitService: service,
    });
    const listener = vi.fn();
    const diffListener = vi.fn();
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, listener);
    const diffSubscription = await diffManager.subscribe(
      { cwd: REPO_CWD, compare: { mode: "uncommitted" } },
      diffListener,
    );

    await vi.waitFor(() => {
      expect(service.peekSnapshot(REPO_CWD)).not.toBeNull();
      expect(service.getMetrics().workspaceObservationSetupInFlightCount).toBe(0);
    });
    isDirty = true;
    diffStat = { additions: 7, deletions: 3 };
    diffFiles = [{ path: "tracked.txt", additions: 7, deletions: 3, status: "modified" }];

    await vi.advanceTimersByTimeAsync(70_000);
    await vi.waitFor(() => {
      expect(listener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          git: expect.objectContaining({
            isDirty: true,
            diffStat: { additions: 7, deletions: 3 },
          }),
        }),
      );
      expect(diffListener).toHaveBeenLastCalledWith({
        cwd: REPO_CWD,
        files: [{ path: "tracked.txt", additions: 7, deletions: 3, status: "modified" }],
        error: null,
      });
    });
    expect(getCheckoutStatus).toHaveBeenCalledTimes(2);

    diffSubscription.unsubscribe();
    subscription.unsubscribe();
    diffManager.dispose();
    service.dispose();
  });
});
