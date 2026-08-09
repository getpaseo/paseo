import path from "node:path";
import type pino from "pino";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CheckoutSnapshotFacts, CheckoutStatusGit } from "../utils/checkout-git.js";
import { CheckoutDiffManager } from "./checkout-diff-manager.js";
import { WorkspaceGitServiceImpl } from "./workspace-git-service.js";

const REPO_CWD = path.resolve("/tmp/paseo-observation-repo");
const GIT_DIR = path.join(REPO_CWD, ".git");
const WORKTREE_A = path.resolve("/tmp/paseo-observation-worktree-a");
const WORKTREE_B = path.resolve("/tmp/paseo-observation-worktree-b");

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

function createLinkedCheckoutFacts(cwd: string): CheckoutSnapshotFacts {
  const worktreeName = path.basename(cwd);
  return {
    ...createCheckoutFacts(cwd),
    currentBranch: worktreeName,
    absoluteGitDir: path.join(GIT_DIR, "worktrees", worktreeName),
    gitCommonDir: GIT_DIR,
    resolvedBaseRef: "main",
    pullRequestLookupTarget: { headRef: worktreeName },
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
    info: vi.fn(),
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

function getCalledCwds(mock: ReturnType<typeof vi.fn>): string[] {
  return mock.mock.calls.map(([cwd]) => cwd as string);
}

function getWatcherRecordsForDirectory(
  watcher: ReturnType<typeof createWatcherHarness>,
  directory: string,
): WatchRecord[] {
  return watcher.records.filter((record) => record.directory === directory);
}

function getWatcherSubscribeCallCount(
  watcher: ReturnType<typeof createWatcherHarness>,
  directory: string,
): number {
  return watcher.subscribe.mock.calls.filter(([calledDirectory]) => calledDirectory === directory)
    .length;
}

function createService(
  watcher: ReturnType<typeof createWatcherHarness>,
  overrides?: Record<string, unknown>,
  logger: pino.Logger = createLogger(),
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
    logger,
    paseoHome: "/tmp/paseo-home",
    deps: {
      subscribe: watcher.subscribe,
      getCheckoutSnapshotFacts: vi.fn(async (cwd: string) => createCheckoutFacts(cwd)),
      getCheckoutRefDerivedState: vi.fn(async (_cwd, facts, current) => ({
        ...current,
        upstreamStatus: facts.upstreamStatus,
      })),
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

  test("an observer abandoned during async setup is closed", async () => {
    const watcher = createWatcherHarness();
    const openedSubscription = createDeferred<{ unsubscribe: () => Promise<void> }>();
    const unsubscribeWatcher = vi.fn(async () => {});
    watcher.subscribe.mockImplementationOnce(async () => openedSubscription.promise);
    const service = createService(watcher);
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());

    await vi.waitFor(() => {
      expect(watcher.subscribe).toHaveBeenCalledTimes(1);
    });
    subscription.unsubscribe();
    openedSubscription.resolve({ unsubscribe: unsubscribeWatcher });

    await vi.waitFor(() => {
      expect(unsubscribeWatcher).toHaveBeenCalledTimes(1);
      expect(service.getMetrics().workingTreeWatchTargetCount).toBe(0);
    });

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

  test("worktree events invalidate uncommitted diffs and metadata events invalidate both", async () => {
    const watcher = createWatcherHarness();
    const projectionVersions = { uncommitted: 0, base: 0 };
    const getCheckoutDiff = vi.fn(
      async (_cwd: string, options: { mode: "uncommitted" | "base" }) => {
        projectionVersions[options.mode] += 1;
        return { diff: `${options.mode}-${projectionVersions[options.mode]}`, structured: [] };
      },
    );
    const service = createService(watcher, { getCheckoutDiff });
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());

    await vi.waitFor(() => {
      expect(service.peekSnapshot(REPO_CWD)).not.toBeNull();
      expect(service.getMetrics().workspaceObservationSetupInFlightCount).toBe(0);
    });
    const initialUncommitted = await service.getCheckoutDiff(REPO_CWD, { mode: "uncommitted" });
    const initialBase = await service.getCheckoutDiff(REPO_CWD, { mode: "base", baseRef: "main" });
    expect(initialUncommitted.diff).toBe("uncommitted-1");
    expect(initialBase.diff).toBe("base-1");

    watcher.records
      .find((record) => record.directory === REPO_CWD)
      ?.callback(null, [{ path: path.join(REPO_CWD, "tracked.txt"), type: "update" }]);
    const changedUncommitted = await service.getCheckoutDiff(REPO_CWD, { mode: "uncommitted" });
    const cachedBase = await service.getCheckoutDiff(REPO_CWD, { mode: "base", baseRef: "main" });
    expect(changedUncommitted.diff).toBe("uncommitted-2");
    expect(cachedBase.diff).toBe("base-1");

    watcher.records
      .find((record) => record.directory === GIT_DIR)
      ?.callback(null, [{ path: path.join(GIT_DIR, "HEAD"), type: "update" }]);
    const changedByMetadata = await service.getCheckoutDiff(REPO_CWD, { mode: "uncommitted" });
    const changedBase = await service.getCheckoutDiff(REPO_CWD, {
      mode: "base",
      baseRef: "main",
    });
    expect(changedByMetadata.diff).toBe("uncommitted-3");
    expect(changedBase.diff).toBe("base-2");

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

  test("a loose remote-ref watcher echo during fetch coalesces into the narrow refresh", async () => {
    const watcher = createWatcherHarness();
    const releaseFetch = createDeferred<void>();
    const getCheckoutSnapshotFacts = vi.fn(async (cwd: string) => ({
      ...createCheckoutFacts(cwd),
      currentBranch: "feature",
      remoteUrl: "https://example.com/repo.git",
      resolvedBaseRef: "main",
      comparisonBaseRef: "origin/main",
    }));
    const getCheckoutRefDerivedState = vi.fn(async (_cwd, facts, current) => ({
      ...current,
      upstreamStatus: facts.upstreamStatus,
    }));
    const service = createService(watcher, {
      getCheckoutSnapshotFacts,
      getCheckoutRefDerivedState,
      getCheckoutStatus: vi.fn(async (cwd: string) =>
        createCheckoutStatus(cwd, {
          currentBranch: "feature",
          baseRef: "main",
          hasRemote: true,
          remoteUrl: "https://example.com/repo.git",
        }),
      ),
      hasOriginRemote: vi.fn(async () => true),
      runGitFetch: vi.fn(async () => {
        await releaseFetch.promise;
        return {
          changes: [{ kind: "moved" as const, ref: "origin/main", beforeOid: "a", afterOid: "b" }],
          error: null,
        };
      }),
    });
    const listener = vi.fn();
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, listener);
    await vi.waitFor(() => {
      expect(service.getMetrics().fetchInFlightCount).toBe(1);
      expect(service.getMetrics().workspaceRefreshInFlightCount).toBe(0);
    });
    listener.mockClear();

    watcher.records
      .find((record) => record.directory === GIT_DIR)
      ?.callback(null, [
        { path: path.join(GIT_DIR, "refs", "remotes", "origin", "main"), type: "create" },
      ]);
    releaseFetch.resolve();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(getCheckoutRefDerivedState).toHaveBeenCalledTimes(1);
    });

    expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);

    subscription.unsubscribe();
    service.dispose();
  });

  test("a second remote-ref move during a narrow refresh queues a final calculation", async () => {
    const watcher = createWatcherHarness();
    const firstRefRefresh = createDeferred<CheckoutStatusGit>();
    const getCheckoutSnapshotFacts = vi.fn(async (cwd: string) => ({
      ...createCheckoutFacts(cwd),
      currentBranch: "feature",
      remoteUrl: "https://example.com/repo.git",
      resolvedBaseRef: "main",
      comparisonBaseRef: "origin/main",
    }));
    const getCheckoutRefDerivedState = vi
      .fn<
        (
          cwd: string,
          facts: CheckoutSnapshotFacts,
          current: CheckoutStatusGit,
        ) => Promise<CheckoutStatusGit>
      >()
      .mockImplementationOnce(() => firstRefRefresh.promise)
      .mockImplementation(async (_cwd, facts, current) => ({
        ...current,
        upstreamStatus: facts.upstreamStatus,
      }));
    const service = createService(watcher, {
      getCheckoutSnapshotFacts,
      getCheckoutRefDerivedState,
      getCheckoutStatus: vi.fn(async (cwd: string) =>
        createCheckoutStatus(cwd, {
          currentBranch: "feature",
          baseRef: "main",
          hasRemote: true,
          remoteUrl: "https://example.com/repo.git",
        }),
      ),
      hasOriginRemote: vi.fn(async () => true),
      runGitFetch: vi.fn(async () => ({
        changes: [{ kind: "moved" as const, ref: "origin/main", beforeOid: "a", afterOid: "b" }],
        error: null,
      })),
    });
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(getCheckoutRefDerivedState).toHaveBeenCalledTimes(1);
    });

    watcher.records
      .find((record) => record.directory === GIT_DIR)
      ?.callback(null, [
        { path: path.join(GIT_DIR, "refs", "remotes", "origin", "main"), type: "update" },
      ]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(service.getMetrics().workspaceRefreshQueuedCount).toBe(1);

    firstRefRefresh.resolve(createCheckoutStatus(REPO_CWD, { currentBranch: "feature" }));
    await vi.waitFor(() => {
      expect(getCheckoutRefDerivedState).toHaveBeenCalledTimes(2);
      expect(service.getMetrics().workspaceRefreshInFlightCount).toBe(0);
    });

    subscription.unsubscribe();
    service.dispose();
  });

  test("an unmatched remote-ref event buffered after the fetch snapshot is refreshed", async () => {
    const watcher = createWatcherHarness();
    const fetchSnapshotRead = createDeferred<void>();
    const releaseFetch = createDeferred<void>();
    const getCheckoutSnapshotFacts = vi.fn(async (cwd: string) => ({
      ...createCheckoutFacts(cwd),
      currentBranch: "feature",
      remoteUrl: "https://example.com/repo.git",
      resolvedBaseRef: "main",
      comparisonBaseRef: "origin/main",
    }));
    const service = createService(watcher, {
      getCheckoutSnapshotFacts,
      getCheckoutStatus: vi.fn(async (cwd: string) =>
        createCheckoutStatus(cwd, {
          currentBranch: "feature",
          baseRef: "main",
          hasRemote: true,
          remoteUrl: "https://example.com/repo.git",
        }),
      ),
      hasOriginRemote: vi.fn(async () => true),
      runGitFetch: vi.fn(async () => {
        fetchSnapshotRead.resolve();
        await releaseFetch.promise;
        return { changes: [], nonRemoteRefsChanged: false, error: null };
      }),
    });
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());
    await fetchSnapshotRead.promise;
    await vi.waitFor(() => {
      expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(1);
    });

    watcher.records
      .find((record) => record.directory === GIT_DIR)
      ?.callback(null, [
        { path: path.join(GIT_DIR, "refs", "remotes", "origin", "main"), type: "update" },
      ]);
    releaseFetch.resolve();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(2);
    });

    subscription.unsubscribe();
    service.dispose();
  });

  test("origin/main refreshes a main checkout without configured upstream", async () => {
    const watcher = createWatcherHarness();
    const getCheckoutSnapshotFacts = vi.fn(async (cwd: string) => ({
      ...createCheckoutFacts(cwd),
      currentBranch: "main",
      remoteUrl: "https://example.com/repo.git",
      resolvedBaseRef: "main",
      comparisonBaseRef: null,
      branchRemoteName: null,
      branchMergeRef: null,
      upstreamStatus: null,
    }));
    const service = createService(watcher, { getCheckoutSnapshotFacts });
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());
    await vi.waitFor(() => {
      expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(1);
    });

    watcher.records
      .find((record) => record.directory === GIT_DIR)
      ?.callback(null, [
        { path: path.join(GIT_DIR, "refs", "remotes", "origin", "main"), type: "update" },
      ]);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(2);
    });

    subscription.unsubscribe();
    service.dispose();
  });

  test("routes private worktree metadata to its owner and shared base refs to dependents", async () => {
    const watcher = createWatcherHarness();
    const getCheckoutSnapshotFacts = vi.fn(async (cwd: string) => createLinkedCheckoutFacts(cwd));
    const getCheckoutStatus = vi.fn(async (cwd: string) =>
      createCheckoutStatus(cwd, { currentBranch: path.basename(cwd) }),
    );
    const service = createService(watcher, { getCheckoutSnapshotFacts, getCheckoutStatus });
    const first = service.registerWorkspace({ cwd: WORKTREE_A }, vi.fn());
    const second = service.registerWorkspace({ cwd: WORKTREE_B }, vi.fn());

    await vi.waitFor(() => {
      expect(service.getMetrics()).toMatchObject({
        repositoryTargetCount: 1,
        repositoryWorkspaceLinkCount: 2,
        workspaceObservationSetupInFlightCount: 0,
        workspaceRefreshInFlightCount: 0,
      });
    });
    const repoWatcher = watcher.records.find((record) => record.directory === GIT_DIR);
    expect(repoWatcher).toBeDefined();
    getCheckoutStatus.mockClear();

    repoWatcher?.callback(null, [{ path: path.join(GIT_DIR, "packed-refs.lock"), type: "create" }]);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    expect(getCheckoutStatus).not.toHaveBeenCalled();

    repoWatcher?.callback(null, [
      {
        path: path.join(createLinkedCheckoutFacts(WORKTREE_A).absoluteGitDir, "COMMIT_EDITMSG"),
        type: "update",
      },
    ]);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    expect(getCheckoutStatus).not.toHaveBeenCalled();

    repoWatcher?.callback(null, [
      {
        path: path.join(createLinkedCheckoutFacts(WORKTREE_A).absoluteGitDir, "index"),
        type: "update",
      },
    ]);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(getCalledCwds(getCheckoutStatus)).toEqual([WORKTREE_A]);
    });
    getCheckoutStatus.mockClear();

    repoWatcher?.callback(null, [
      { path: path.join(GIT_DIR, "refs", "heads", "main"), type: "update" },
    ]);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(getCalledCwds(getCheckoutStatus).sort()).toEqual([WORKTREE_A, WORKTREE_B].sort());
    });

    first.unsubscribe();
    second.unsubscribe();
    service.dispose();
  });

  test("routes the main checkout index to the main checkout only", async () => {
    const watcher = createWatcherHarness();
    const getCheckoutSnapshotFacts = vi.fn(async (cwd: string) =>
      cwd === REPO_CWD ? createCheckoutFacts(cwd) : createLinkedCheckoutFacts(cwd),
    );
    const getCheckoutStatus = vi.fn(async (cwd: string) => createCheckoutStatus(cwd));
    const service = createService(watcher, { getCheckoutSnapshotFacts, getCheckoutStatus });
    const main = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());
    const linked = service.registerWorkspace({ cwd: WORKTREE_A }, vi.fn());

    await vi.waitFor(() => {
      expect(service.getMetrics()).toMatchObject({
        repositoryTargetCount: 1,
        repositoryWorkspaceLinkCount: 2,
        workspaceObservationSetupInFlightCount: 0,
        workspaceRefreshInFlightCount: 0,
      });
    });
    getCheckoutStatus.mockClear();
    watcher.records
      .find((record) => record.directory === GIT_DIR)
      ?.callback(null, [{ path: path.join(GIT_DIR, "index"), type: "update" }]);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(getCalledCwds(getCheckoutStatus)).toEqual([REPO_CWD]);
    });

    main.unsubscribe();
    linked.unsubscribe();
    service.dispose();
  });

  test("a newly created remote tracking ref refreshes every repository workspace", async () => {
    const watcher = createWatcherHarness();
    const getCheckoutSnapshotFacts = vi.fn(async (cwd: string) => {
      const facts = createLinkedCheckoutFacts(cwd);
      const branch = path.basename(cwd);
      return {
        ...facts,
        currentBranch: branch,
        storedBaseRef: "refs/heads/main",
        resolvedBaseRef: "refs/heads/main",
        comparisonBaseRef: "refs/heads/main",
        branchRemoteName: "origin",
        branchMergeRef: `refs/heads/${branch}`,
        upstreamStatus: null,
      } satisfies CheckoutSnapshotFacts;
    });
    const getCheckoutStatus = vi.fn(async (cwd: string) =>
      createCheckoutStatus(cwd, { currentBranch: path.basename(cwd) }),
    );
    const service = createService(watcher, { getCheckoutSnapshotFacts, getCheckoutStatus });
    const first = service.registerWorkspace({ cwd: WORKTREE_A }, vi.fn());
    const second = service.registerWorkspace({ cwd: WORKTREE_B }, vi.fn());

    await vi.waitFor(() => {
      expect(service.getMetrics()).toMatchObject({
        repositoryTargetCount: 1,
        repositoryWorkspaceLinkCount: 2,
        workspaceObservationSetupInFlightCount: 0,
        workspaceRefreshInFlightCount: 0,
      });
    });
    getCheckoutStatus.mockClear();
    watcher.records
      .find((record) => record.directory === GIT_DIR)
      ?.callback(null, [
        {
          path: path.join(GIT_DIR, "refs", "remotes", "origin", path.basename(WORKTREE_A)),
          type: "create",
        },
      ]);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(getCalledCwds(getCheckoutStatus)).toEqual([WORKTREE_A, WORKTREE_B]);
    });

    first.unsubscribe();
    second.unsubscribe();
    service.dispose();
  });

  test("repository metadata observation ignores root and pruned-directory noise", async () => {
    const watcher = createWatcherHarness();
    const getCheckoutSnapshotFacts = vi.fn(async (cwd: string) => createCheckoutFacts(cwd));
    const getCheckoutStatus = vi.fn(async (cwd: string) => createCheckoutStatus(cwd));
    const service = createService(watcher, { getCheckoutSnapshotFacts, getCheckoutStatus });
    const listener = vi.fn();
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, listener);

    await vi.waitFor(() => {
      expect(service.getMetrics().workspaceObservationSetupInFlightCount).toBe(0);
      expect(service.getMetrics().workspaceRefreshInFlightCount).toBe(0);
    });
    getCheckoutSnapshotFacts.mockClear();
    getCheckoutStatus.mockClear();
    listener.mockClear();

    watcher.records
      .find((record) => record.directory === GIT_DIR)
      ?.callback(null, [
        { path: GIT_DIR, type: "update" },
        { path: path.join(GIT_DIR, "objects", "pack", "temporary.pack"), type: "update" },
      ]);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();

    expect(getCheckoutSnapshotFacts).not.toHaveBeenCalled();
    expect(getCheckoutStatus).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();

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
    const runGitFetch = vi.fn(async () => {
      await fetch.promise;
      return { changes: [], error: null };
    });
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

  test("non-Git fallback promotes an externally initialized checkout", async () => {
    const watcher = createWatcherHarness();
    let isGit = false;
    const getCheckoutSnapshotFacts = vi.fn(
      async (cwd: string): Promise<CheckoutSnapshotFacts> =>
        isGit ? createCheckoutFacts(cwd) : { isGit: false },
    );
    const getCheckoutStatus = vi.fn(async (cwd: string) =>
      isGit ? createCheckoutStatus(cwd) : ({ isGit: false } as const),
    );
    const runGitCommand = vi.fn(async (args: string[]) => {
      if (args[0] === "rev-parse") {
        if (!isGit) {
          throw new Error("not a git repository");
        }
        return {
          stdout: `${REPO_CWD}\n`,
          stderr: "",
          truncated: false,
          exitCode: 0,
          signal: null,
        };
      }
      if (args[0] === "ls-files") {
        return {
          stdout: "",
          stderr: "",
          truncated: false,
          exitCode: 0,
          signal: null,
        };
      }
      throw new Error(`Unexpected Git command: ${args.join(" ")}`);
    });
    const service = createService(watcher, {
      getCheckoutSnapshotFacts,
      getCheckoutStatus,
      getWorkspaceGitSelfHealPhaseMs: () => 60_000,
      runGitCommand,
    });
    const summarySubscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());

    await vi.waitFor(() => {
      expect(service.peekSnapshot(REPO_CWD)?.git.isGit).toBe(false);
      expect(service.getMetrics()).toMatchObject({
        workspaceObservationSetupInFlightCount: 0,
        workspaceRefreshInFlightCount: 0,
      });
    });
    expect(watcher.records.filter((record) => record.directory === GIT_DIR)).toHaveLength(0);

    isGit = true;
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => {
      expect(service.peekSnapshot(REPO_CWD)?.git.isGit).toBe(true);
      expect(service.getMetrics()).toMatchObject({
        repositoryTargetCount: 1,
        repositoryWorkspaceLinkCount: 1,
        workspaceObservationSetupInFlightCount: 0,
        workspaceRefreshInFlightCount: 0,
      });
    });
    expect(watcher.records.filter((record) => record.directory === GIT_DIR)).toHaveLength(1);
    expect(watcher.records.filter((record) => record.directory === REPO_CWD)).toHaveLength(1);

    const factsCallCount = getCheckoutSnapshotFacts.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(factsCallCount);

    summarySubscription.unsubscribe();
    service.dispose();
  });

  test("watcher runtime error is abandoned, counted, and switches to scoped polling", async () => {
    const watcher = createWatcherHarness();
    const getCheckoutSnapshotFacts = vi.fn(async (cwd: string) => createCheckoutFacts(cwd));
    const getCheckoutStatus = vi.fn(async (cwd: string) => createCheckoutStatus(cwd));
    const service = createService(watcher, {
      getCheckoutSnapshotFacts,
      getCheckoutStatus,
      getWorkspaceGitSelfHealPhaseMs: () => 1_000_000,
    });
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());

    await vi.waitFor(() => {
      expect(service.peekSnapshot(REPO_CWD)).not.toBeNull();
      expect(service.getMetrics().workspaceObservationSetupInFlightCount).toBe(0);
    });
    const checkoutWatcher = watcher.records.find((record) => record.directory === REPO_CWD);
    expect(checkoutWatcher).toBeDefined();

    checkoutWatcher?.callback(new Error("watcher stopped"), []);
    expect(checkoutWatcher?.unsubscribe).not.toHaveBeenCalled();
    expect(service.getMetrics().watcherErrorCallbackCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(getCheckoutStatus).toHaveBeenCalledTimes(2);
    });

    expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(1);
    expect(service.getMetrics().workspaceRefreshQueuedCount).toBe(0);

    await vi.advanceTimersByTimeAsync(29_000);
    await vi.waitFor(() => {
      expect(getWatcherRecordsForDirectory(watcher, REPO_CWD)).toHaveLength(2);
    });
    const recoveredWatcher = getWatcherRecordsForDirectory(watcher, REPO_CWD)[1];
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(service.getMetrics().workspaceRefreshInFlightCount).toBe(0);
    });
    const statusCallsAfterRecovery = getCheckoutStatus.mock.calls.length;
    recoveredWatcher?.callback(null, [
      { path: path.join(REPO_CWD, "recovered.txt"), type: "update" },
    ]);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(getCheckoutStatus).toHaveBeenCalledTimes(statusCallsAfterRecovery + 1);
    });
    const statusCallsAfterEvent = getCheckoutStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(getCheckoutStatus).toHaveBeenCalledTimes(statusCallsAfterEvent);

    subscription.unsubscribe();
    service.dispose();
  });

  test("setup-time watcher error defers recovery until subscribe settles", async () => {
    const watcher = createWatcherHarness();
    const openedSubscription = createDeferred<{ unsubscribe: () => Promise<void> }>();
    const erroredUnsubscribe = vi.fn(async () => {});
    watcher.subscribe.mockImplementationOnce(async (_directory, callback) => {
      callback(new Error("watcher stopped during setup"), []);
      return openedSubscription.promise;
    });
    const getCheckoutStatus = vi.fn(async (cwd: string) => createCheckoutStatus(cwd));
    const service = createService(watcher, {
      getCheckoutStatus,
      getWorkspaceGitSelfHealPhaseMs: () => 1_000_000,
    });

    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());
    await vi.waitFor(() => {
      expect(watcher.subscribe).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(35_000);
    expect(service.getMetrics().workingTreeWatchSetupInFlightCount).toBe(0);
    expect(service.getMetrics().workspaceObservationSetupAdmissionActiveCount).toBe(0);
    expect(getWatcherSubscribeCallCount(watcher, REPO_CWD)).toBe(1);

    openedSubscription.resolve({ unsubscribe: erroredUnsubscribe });
    await vi.waitFor(() => {
      expect(service.getMetrics().workspaceObservationSetupInFlightCount).toBe(0);
    });
    const statusCallsAfterSetup = getCheckoutStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => {
      expect(getCheckoutStatus.mock.calls.length).toBeGreaterThan(statusCallsAfterSetup);
    });
    await vi.advanceTimersByTimeAsync(24_000);
    expect(getWatcherSubscribeCallCount(watcher, REPO_CWD)).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(getWatcherSubscribeCallCount(watcher, REPO_CWD)).toBe(2);
    });
    expect(erroredUnsubscribe).not.toHaveBeenCalled();

    subscription.unsubscribe();
    service.dispose();
  });

  test("watcher error during subscription setup is abandoned without native teardown", async () => {
    const watcher = createWatcherHarness();
    const erroredUnsubscribe = vi.fn(async () => {});
    watcher.subscribe.mockImplementationOnce(async (_directory, callback) => {
      callback(new Error("watcher stopped during setup"), []);
      return { unsubscribe: erroredUnsubscribe };
    });
    const service = createService(watcher);

    const subscription = await service.requestWorkingTreeWatch(REPO_CWD, vi.fn());

    expect(erroredUnsubscribe).not.toHaveBeenCalled();
    expect(service.getMetrics().watcherErrorCallbackCount).toBe(1);

    subscription.unsubscribe();
    service.dispose();
  });

  test("repository watcher runtime error is abandoned, counted, and recovered", async () => {
    const watcher = createWatcherHarness();
    const getCheckoutStatus = vi.fn(async (cwd: string) => createCheckoutStatus(cwd));
    const service = createService(watcher, {
      getCheckoutStatus,
      getWorkspaceGitSelfHealPhaseMs: () => 1_000_000,
    });
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());

    await vi.waitFor(() => {
      expect(service.getMetrics().workspaceObservationSetupInFlightCount).toBe(0);
    });
    const repositoryWatcher = watcher.records.find((record) => record.directory === GIT_DIR);
    expect(repositoryWatcher).toBeDefined();

    repositoryWatcher?.callback(new Error("repository watcher stopped"), []);

    expect(repositoryWatcher?.unsubscribe).not.toHaveBeenCalled();
    expect(service.getMetrics().watcherErrorCallbackCount).toBe(1);

    const statusCallsBeforeReconciliation = getCheckoutStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(getCheckoutStatus).toHaveBeenCalledTimes(statusCallsBeforeReconciliation + 1);
    });

    await vi.advanceTimersByTimeAsync(29_000);
    await vi.waitFor(() => {
      expect(getWatcherRecordsForDirectory(watcher, GIT_DIR)).toHaveLength(2);
    });
    const recoveredWatcher = getWatcherRecordsForDirectory(watcher, GIT_DIR)[1];
    const statusCallsAfterRecovery = getCheckoutStatus.mock.calls.length;
    recoveredWatcher?.callback(null, [{ path: path.join(GIT_DIR, "HEAD"), type: "update" }]);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(getCheckoutStatus).toHaveBeenCalledTimes(statusCallsAfterRecovery + 1);
    });
    const statusCallsAfterEvent = getCheckoutStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(getCheckoutStatus).toHaveBeenCalledTimes(statusCallsAfterEvent);

    subscription.unsubscribe();
    service.dispose();
  });

  test("watcher recovery remains capped when recovered subscriptions emit events before failing", async () => {
    const watcher = createWatcherHarness();
    const getCheckoutStatus = vi.fn(async (cwd: string) => createCheckoutStatus(cwd));
    const service = createService(watcher, {
      getCheckoutStatus,
      getWorkspaceGitSelfHealPhaseMs: () => 1_000_000,
    });
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());

    await vi.waitFor(() => {
      expect(service.getMetrics().workspaceObservationSetupInFlightCount).toBe(0);
    });
    const checkoutWatcher = getWatcherRecordsForDirectory(watcher, REPO_CWD)[0];

    checkoutWatcher?.callback(new Error("watcher stopped"), []);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => {
      expect(getWatcherRecordsForDirectory(watcher, REPO_CWD)).toHaveLength(2);
    });
    getWatcherRecordsForDirectory(watcher, REPO_CWD)[1]?.callback(null, [
      { path: path.join(REPO_CWD, "recovered-1.txt"), type: "update" },
    ]);
    getWatcherRecordsForDirectory(watcher, REPO_CWD)[1]?.callback(
      new Error("recovered watcher stopped"),
      [],
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => {
      expect(getWatcherRecordsForDirectory(watcher, REPO_CWD)).toHaveLength(3);
    });
    getWatcherRecordsForDirectory(watcher, REPO_CWD)[2]?.callback(null, [
      { path: path.join(REPO_CWD, "recovered-2.txt"), type: "update" },
    ]);
    getWatcherRecordsForDirectory(watcher, REPO_CWD)[2]?.callback(
      new Error("recovered watcher stopped again"),
      [],
    );
    await vi.advanceTimersByTimeAsync(120_000);
    await vi.waitFor(() => {
      expect(getWatcherSubscribeCallCount(watcher, REPO_CWD)).toBe(4);
    });
    getWatcherRecordsForDirectory(watcher, REPO_CWD)[3]?.callback(null, [
      { path: path.join(REPO_CWD, "recovered-3.txt"), type: "update" },
    ]);
    getWatcherRecordsForDirectory(watcher, REPO_CWD)[3]?.callback(
      new Error("last recovered watcher stopped"),
      [],
    );

    const statusCallsAtCap = getCheckoutStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(getWatcherSubscribeCallCount(watcher, REPO_CWD)).toBe(4);
    expect(getCheckoutStatus.mock.calls.length).toBeGreaterThan(statusCallsAtCap);

    subscription.unsubscribe();
    service.dispose();
  });

  test("repository watcher recovery remains capped after recovered subscriptions emit events", async () => {
    const watcher = createWatcherHarness();
    const getCheckoutStatus = vi.fn(async (cwd: string) => createCheckoutStatus(cwd));
    const service = createService(watcher, {
      getCheckoutStatus,
      getWorkspaceGitSelfHealPhaseMs: () => 1_000_000,
    });
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());

    await vi.waitFor(() => {
      expect(service.getMetrics().workspaceObservationSetupInFlightCount).toBe(0);
    });
    getWatcherRecordsForDirectory(watcher, GIT_DIR)[0]?.callback(
      new Error("repository watcher stopped"),
      [],
    );

    for (const [recoveryIndex, delayMs] of [30_000, 60_000, 120_000].entries()) {
      await vi.advanceTimersByTimeAsync(delayMs);
      await vi.waitFor(() => {
        expect(getWatcherRecordsForDirectory(watcher, GIT_DIR)).toHaveLength(recoveryIndex + 2);
      });
      const recoveredWatcher = getWatcherRecordsForDirectory(watcher, GIT_DIR)[recoveryIndex + 1];
      recoveredWatcher?.callback(null, [{ path: path.join(GIT_DIR, "HEAD"), type: "update" }]);
      recoveredWatcher?.callback(new Error("recovered repository watcher stopped"), []);
    }

    const statusCallsAtCap = getCheckoutStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(getWatcherSubscribeCallCount(watcher, GIT_DIR)).toBe(4);
    expect(getCheckoutStatus.mock.calls.length).toBeGreaterThan(statusCallsAtCap);

    subscription.unsubscribe();
    service.dispose();
  });

  test("non-Git discovery polling survives watcher recovery", async () => {
    const watcher = createWatcherHarness();
    const getCheckoutSnapshotFacts = vi.fn(
      async (): Promise<CheckoutSnapshotFacts> => ({
        isGit: false,
      }),
    );
    const getCheckoutStatus = vi.fn(async () => ({ isGit: false }) as const);
    const runGitCommand = vi.fn(async () => {
      throw new Error("not a git repository");
    });
    const service = createService(watcher, {
      getCheckoutSnapshotFacts,
      getCheckoutStatus,
      getWorkspaceGitSelfHealPhaseMs: () => 1_000_000,
      runGitCommand,
    });
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());

    await vi.waitFor(() => {
      expect(service.getMetrics().workspaceObservationSetupInFlightCount).toBe(0);
    });
    const checkoutWatcher = getWatcherRecordsForDirectory(watcher, REPO_CWD)[0];
    checkoutWatcher?.callback(new Error("watcher stopped"), []);

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => {
      expect(getWatcherRecordsForDirectory(watcher, REPO_CWD)).toHaveLength(2);
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(service.getMetrics().workspaceRefreshInFlightCount).toBe(0);
    });
    const statusCallsAfterRecovery = getCheckoutStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => {
      expect(getCheckoutStatus.mock.calls.length).toBeGreaterThan(statusCallsAfterRecovery);
    });

    subscription.unsubscribe();
    service.dispose();
  });

  test("adding ignored directories updates filtering without replacing the watcher", async () => {
    const watcher = createWatcherHarness();
    let ignoredDirectories = "node_modules/\n";
    const runGitCommand = vi.fn(async (args: string[]) => {
      return {
        stdout: args[0] === "rev-parse" ? `${REPO_CWD}\n` : ignoredDirectories,
        stderr: "",
        truncated: false,
        exitCode: 0,
        signal: null,
      };
    });
    const getCheckoutStatus = vi.fn(async (cwd: string) => createCheckoutStatus(cwd));
    const service = createService(watcher, {
      getCheckoutStatus,
      getWorkspaceGitSelfHealPhaseMs: () => 1_000,
      runGitCommand,
    });
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());

    await vi.waitFor(() => {
      expect(getWatcherRecordsForDirectory(watcher, REPO_CWD)).toHaveLength(1);
      expect(service.getMetrics().workspaceObservationSetupInFlightCount).toBe(0);
    });
    const checkoutWatcher = watcher.records.find((record) => record.directory === REPO_CWD);
    expect(checkoutWatcher?.ignore).toContain(path.join(REPO_CWD, "node_modules"));

    ignoredDirectories = "node_modules/\nbuild/\n";
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(runGitCommand).toHaveBeenCalledTimes(3);
    });

    expect(getWatcherRecordsForDirectory(watcher, REPO_CWD)).toHaveLength(1);
    expect(checkoutWatcher?.unsubscribe).not.toHaveBeenCalled();
    const statusCallsAfterRefresh = getCheckoutStatus.mock.calls.length;
    checkoutWatcher?.callback(null, [
      { path: path.join(REPO_CWD, "build", "output.js"), type: "update" },
    ]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(getCheckoutStatus).toHaveBeenCalledTimes(statusCallsAfterRefresh);

    checkoutWatcher?.callback(null, [{ path: path.join(REPO_CWD, "tracked.txt"), type: "update" }]);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(getCheckoutStatus).toHaveBeenCalledTimes(statusCallsAfterRefresh + 1);
    });

    subscription.unsubscribe();
    service.dispose();
  });

  test("removing an ignored directory replaces the watcher", async () => {
    const watcher = createWatcherHarness();
    let ignoredDirectories = "node_modules/\nbuild/\n";
    const runGitCommand = vi.fn(async (args: string[]) => {
      return {
        stdout: args[0] === "rev-parse" ? `${REPO_CWD}\n` : ignoredDirectories,
        stderr: "",
        truncated: false,
        exitCode: 0,
        signal: null,
      };
    });
    const getCheckoutStatus = vi.fn(async (cwd: string) => createCheckoutStatus(cwd));
    const service = createService(watcher, {
      getCheckoutStatus,
      getWorkspaceGitSelfHealPhaseMs: () => 1_000,
      runGitCommand,
    });
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());

    await vi.waitFor(() => {
      expect(getWatcherRecordsForDirectory(watcher, REPO_CWD)).toHaveLength(1);
      expect(service.getMetrics().workspaceObservationSetupInFlightCount).toBe(0);
    });
    const originalWatcher = watcher.records.find((record) => record.directory === REPO_CWD);

    ignoredDirectories = "node_modules/\n";
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(getWatcherRecordsForDirectory(watcher, REPO_CWD)).toHaveLength(2);
    });

    expect(originalWatcher?.unsubscribe).toHaveBeenCalledTimes(1);
    const replacementWatcher = getWatcherRecordsForDirectory(watcher, REPO_CWD)[1];
    expect(replacementWatcher?.ignore).not.toContain(path.join(REPO_CWD, "build"));
    const statusCallsAfterRefresh = getCheckoutStatus.mock.calls.length;
    replacementWatcher?.callback(null, [
      { path: path.join(REPO_CWD, "build", "output.js"), type: "update" },
    ]);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(getCheckoutStatus).toHaveBeenCalledTimes(statusCallsAfterRefresh + 1);
    });

    subscription.unsubscribe();
    service.dispose();
  });

  test("ignore watcher teardown failure enters polling with a distinct reason", async () => {
    const watcher = createWatcherHarness();
    const logger = createLogger();
    let ignoredDirectories = "node_modules/\nbuild/\n";
    const runGitCommand = vi.fn(async (args: string[]) => ({
      stdout: args[0] === "rev-parse" ? `${REPO_CWD}\n` : ignoredDirectories,
      stderr: "",
      truncated: false,
      exitCode: 0,
      signal: null,
    }));
    const getCheckoutStatus = vi.fn(async (cwd: string) => createCheckoutStatus(cwd));
    const service = createService(
      watcher,
      {
        getCheckoutStatus,
        getWorkspaceGitSelfHealPhaseMs: () => 1_000,
        runGitCommand,
      },
      logger,
    );
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());

    await vi.waitFor(() => {
      expect(getWatcherRecordsForDirectory(watcher, REPO_CWD)).toHaveLength(1);
      expect(service.getMetrics().workspaceObservationSetupInFlightCount).toBe(0);
    });
    const checkoutWatcher = getWatcherRecordsForDirectory(watcher, REPO_CWD)[0];
    checkoutWatcher?.unsubscribe.mockRejectedValueOnce(new Error("teardown failed"));
    ignoredDirectories = "node_modules/\n";

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "watcher_teardown_failed" }),
        "Working tree watcher unavailable; using bounded polling fallback",
      );
    });
    expect(service.getMetrics().watcherErrorCallbackCount).toBe(0);
    const statusCallsBeforePoll = getCheckoutStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => {
      expect(getCheckoutStatus.mock.calls.length).toBeGreaterThan(statusCallsBeforePoll);
    });

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
