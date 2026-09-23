import path from "node:path";
import { pathToFileURL } from "node:url";
import type pino from "pino";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CheckoutSnapshotFacts, CheckoutStatusGit } from "../utils/checkout-git.js";
import { CheckoutDiffManager } from "./checkout-diff-manager.js";
import type { FileObserver } from "./file-observer/index.js";
import { WorkspaceGitServiceImpl } from "./workspace-git-service.js";

const REPO_CWD = path.resolve("/tmp/paseo-observation-repo");
const GIT_DIR = path.join(REPO_CWD, ".git");
// Checkout observation must not depend on installed forge CLIs or host-auth probes.
const REMOTE_URL = pathToFileURL(path.join(REPO_CWD, "remote.git")).href;
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
  updateIgnore: ReturnType<typeof vi.fn>;
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
      const updateIgnore = vi.fn(async (paths: string[]) => {
        const record = records.find((candidate) => candidate.updateIgnore === updateIgnore);
        if (record) record.ignore = paths;
      });
      const unsubscribe = vi.fn(async () => {});
      records.push({
        directory,
        callback,
        ignore: options?.ignore ?? [],
        updateIgnore,
        unsubscribe,
      });
      return { updateIgnore, unsubscribe };
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

// Recovery backoff ladder: base 30s, doubling each attempt, capped at 300s
// (base * 2 ** 4). Mirrors WATCH_RECOVERY_BASE_DELAY_MS /
// WATCH_RECOVERY_MAX_BACKOFF_STEPS / WATCH_RECOVERY_MAX_DELAY_MS in
// workspace-git-service.ts.
const WATCH_RECOVERY_LADDER_DELAYS_MS = [30_000, 60_000, 120_000, 240_000, 300_000, 300_000];

/**
 * Drives a watch target (working tree or repository metadata) through six
 * recovery cycles, proving three things about `advanceWatchRecoveryLadder`:
 *  - recovery keeps retrying well past the old cap of 3 attempts (this walks
 *    it to 6, i.e. 7 total subscriptions),
 *  - the delay between attempts follows 30s/60s/120s/240s and then plateaus
 *    at 300s rather than growing without bound, and
 *  - a recovered subscription that emits an event (proving it is live) and
 *    then errors again immediately — before surviving the 300s durability
 *    window — does NOT reset the ladder back to the 30s base. Each "advance
 *    by 30s only" check below would observe a premature retry if a reset had
 *    happened.
 */
async function driveWatchRecoveryLadder(
  watcher: ReturnType<typeof createWatcherHarness>,
  directory: string,
): Promise<void> {
  for (const [index, delayMs] of WATCH_RECOVERY_LADDER_DELAYS_MS.entries()) {
    const expectedCallCount = index + 2;
    if (delayMs > 30_000) {
      await vi.advanceTimersByTimeAsync(30_000);
      // Not yet reset to the 30s base: no new attempt after only 30s.
      expect(getWatcherSubscribeCallCount(watcher, directory)).toBe(expectedCallCount - 1);
      await vi.advanceTimersByTimeAsync(delayMs - 30_000);
    } else {
      await vi.advanceTimersByTimeAsync(delayMs);
    }
    await vi.waitFor(() => {
      expect(getWatcherSubscribeCallCount(watcher, directory)).toBe(expectedCallCount);
    });
    const recoveredWatcher = getWatcherRecordsForDirectory(watcher, directory)[index + 1];
    recoveredWatcher?.callback(null, [
      { path: path.join(directory, `recovered-${index + 1}.txt`), type: "update" },
    ]);
    recoveredWatcher?.callback(new Error(`recovered watcher stopped ${index + 1}`), []);
  }
}

function createService(
  watcher: ReturnType<typeof createWatcherHarness>,
  overrides?: Record<string, unknown>,
  logger: pino.Logger = createLogger(),
  fileObserver?: FileObserver,
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
    fileObserver,
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
      createWatcherLivenessCanary: vi.fn(() => ({
        path: "",
        filterEvents: (events) => events,
        verify: vi.fn(async () => {}),
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

  test("waits for the initial watcher inventory before building a cold diff", async () => {
    const watcher = createWatcherHarness();
    const inventoryFinished = createDeferred<void>();
    let builds = 0;
    const service = createService(watcher, {
      subscribe: async (...args: Parameters<typeof watcher.subscribe>) => {
        await inventoryFinished.promise;
        return watcher.subscribe(...args);
      },
      getCheckoutDiff: async () => {
        builds += 1;
        return { diff: "", structured: [] };
      },
    });
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, () => {});
    try {
      const read = service.getCheckoutDiff(REPO_CWD, { mode: "uncommitted" });
      await flushPromises();
      expect(builds).toBe(0);
      inventoryFinished.resolve();
      await read;
      expect(builds).toBe(1);
    } finally {
      inventoryFinished.resolve();
      subscription.unsubscribe();
      await service.dispose();
    }
  });

  test("dispose waits for file observation to finish closing", async () => {
    const watcher = createWatcherHarness();
    const closeFinished = createDeferred<void>();
    let closeCalls = 0;
    const fileObserver: FileObserver = {
      subscribe: watcher.subscribe as FileObserver["subscribe"],
      getDiagnostics: () => {
        throw new Error("Diagnostics are not used by this lifecycle test");
      },
      close: () => {
        closeCalls += 1;
        return closeFinished.promise;
      },
    };
    const service = createService(watcher, undefined, createLogger(), fileObserver);

    const disposal = service.dispose();
    const repeatedDisposal = service.dispose();

    expect(disposal).toBeInstanceOf(Promise);
    expect(repeatedDisposal).toBe(disposal);
    expect(closeCalls).toBe(1);
    const status = await Promise.race([
      disposal.then(() => "disposed" as const),
      Promise.resolve("pending" as const),
    ]);
    expect(status).toBe("pending");

    closeFinished.resolve();
    await disposal;
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
    openedSubscription.resolve({
      updateIgnore: vi.fn(async () => {}),
      unsubscribe: unsubscribeWatcher,
    });

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
      remoteUrl: REMOTE_URL,
      resolvedBaseRef: "main",
      comparisonBaseRef: "origin/main",
    }));
    const getCheckoutRefDerivedState = vi.fn(async (_cwd, facts, current) => ({
      ...current,
      upstreamStatus: facts.upstreamStatus,
    }));
    const runGitFetch = vi.fn(async (_cwd, observer) => {
      observer?.onRefSnapshot("before");
      await releaseFetch.promise;
      observer?.onRefSnapshot("after");
      return {
        changes: [{ kind: "moved" as const, ref: "origin/main", beforeOid: "a", afterOid: "b" }],
        error: null,
      };
    });
    const service = createService(watcher, {
      getCheckoutSnapshotFacts,
      getCheckoutRefDerivedState,
      getCheckoutStatus: vi.fn(async (cwd: string) =>
        createCheckoutStatus(cwd, {
          currentBranch: "feature",
          baseRef: "main",
          hasRemote: true,
          remoteUrl: REMOTE_URL,
        }),
      ),
      hasOriginRemote: vi.fn(async () => true),
      runGitFetch,
    });
    const listener = vi.fn();
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, listener);
    await service.getSnapshot(REPO_CWD);
    await vi.waitFor(() => {
      expect(runGitFetch).toHaveBeenCalledTimes(1);
      expect(service.getMetrics().fetchInFlightCount).toBe(1);
    });
    expect(service.getMetrics().workspaceRefreshInFlightCount).toBe(0);
    listener.mockClear();

    watcher.records
      .find((record) => record.directory === GIT_DIR)
      ?.callback(null, [
        { path: path.join(GIT_DIR, "refs", "remotes", "origin", "main"), type: "create" },
      ]);
    releaseFetch.resolve();
    await vi.waitFor(() => {
      expect(service.getMetrics().fetchInFlightCount).toBe(0);
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(getCheckoutRefDerivedState).toHaveBeenCalledTimes(1);
    });

    expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);

    subscription.unsubscribe();
    service.dispose();
  });

  test("a packed-refs event covered by the fetch snapshot uses the exact ref delta", async () => {
    const watcher = createWatcherHarness();
    const fetchWindowOpen = createDeferred<void>();
    const releaseFetch = createDeferred<void>();
    const getCheckoutSnapshotFacts = vi.fn(async (cwd: string) => ({
      ...createCheckoutFacts(cwd),
      currentBranch: "feature",
      remoteUrl: REMOTE_URL,
      resolvedBaseRef: "main",
      comparisonBaseRef: "origin/main",
    }));
    const getCheckoutRefDerivedState = vi.fn();
    const service = createService(watcher, {
      getCheckoutSnapshotFacts,
      getCheckoutRefDerivedState,
      hasOriginRemote: vi.fn(async () => true),
      runGitFetch: vi.fn(async (_cwd, observer) => {
        observer.onRefSnapshot("before");
        fetchWindowOpen.resolve();
        await releaseFetch.promise;
        observer.onRefSnapshot("after");
        return {
          changes: [
            {
              kind: "moved" as const,
              ref: "origin/unrelated",
              beforeOid: "a",
              afterOid: "b",
            },
          ],
          nonRemoteRefsChanged: false,
          remoteRefs: new Set(["origin/main", "origin/unrelated"]),
          error: null,
        };
      }),
    });
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());
    await fetchWindowOpen.promise;
    await vi.waitFor(() => {
      expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(1);
    });

    watcher.records
      .find((record) => record.directory === GIT_DIR)
      ?.callback(null, [{ path: path.join(GIT_DIR, "packed-refs"), type: "update" }]);
    releaseFetch.resolve();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(1);
    expect(getCheckoutRefDerivedState).not.toHaveBeenCalled();

    subscription.unsubscribe();
    service.dispose();
  });

  test.each(["before", "after"] as const)(
    "a packed-refs event %s the fetch snapshot remains conservative",
    async (phase) => {
      const watcher = createWatcherHarness();
      const afterSnapshot = createDeferred<void>();
      const releaseFetch = createDeferred<void>();
      const getCheckoutSnapshotFacts = vi.fn(async (cwd: string) => ({
        ...createCheckoutFacts(cwd),
        remoteUrl: REMOTE_URL,
      }));
      const runGitFetch = vi.fn(async (_cwd, observer) => {
        if (phase === "before") {
          await releaseFetch.promise;
          observer.onRefSnapshot("before");
          observer.onRefSnapshot("after");
        } else {
          observer.onRefSnapshot("before");
          observer.onRefSnapshot("after");
          afterSnapshot.resolve();
          await releaseFetch.promise;
        }
        return {
          changes: [],
          nonRemoteRefsChanged: false,
          remoteRefs: new Set(["origin/main"]),
          error: null,
        };
      });
      const service = createService(watcher, {
        getCheckoutSnapshotFacts,
        hasOriginRemote: vi.fn(async () => true),
        runGitFetch,
      });
      const subscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());
      await vi.waitFor(() => {
        expect(runGitFetch).toHaveBeenCalledTimes(1);
        expect(getWatcherRecordsForDirectory(watcher, GIT_DIR)).toHaveLength(1);
      });
      if (phase === "after") await afterSnapshot.promise;

      watcher.records
        .find((record) => record.directory === GIT_DIR)
        ?.callback(null, [{ path: path.join(GIT_DIR, "packed-refs"), type: "update" }]);
      releaseFetch.resolve();
      await vi.waitFor(() => {
        expect(service.getMetrics().fetchInFlightCount).toBe(0);
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => {
        expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(2);
      });

      subscription.unsubscribe();
      service.dispose();
    },
  );

  test("a post-snapshot delete overrides the fetch's moved-ref classification", async () => {
    const watcher = createWatcherHarness();
    const afterSnapshot = createDeferred<void>();
    const releaseFetch = createDeferred<void>();
    const getCheckoutSnapshotFacts = vi.fn(async (cwd: string) => ({
      ...createCheckoutFacts(cwd),
      remoteUrl: REMOTE_URL,
    }));
    const getCheckoutRefDerivedState = vi.fn();
    const service = createService(watcher, {
      getCheckoutSnapshotFacts,
      getCheckoutRefDerivedState,
      hasOriginRemote: vi.fn(async () => true),
      runGitFetch: vi.fn(async (_cwd, observer) => {
        observer.onRefSnapshot("before");
        observer.onRefSnapshot("after");
        afterSnapshot.resolve();
        await releaseFetch.promise;
        return {
          changes: [{ kind: "moved" as const, ref: "origin/main", beforeOid: "a", afterOid: "b" }],
          nonRemoteRefsChanged: false,
          remoteRefs: new Set(["origin/main"]),
          error: null,
        };
      }),
    });
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());
    await afterSnapshot.promise;
    await vi.waitFor(() => {
      expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(1);
    });

    watcher.records
      .find((record) => record.directory === GIT_DIR)
      ?.callback(null, [
        { path: path.join(GIT_DIR, "refs", "remotes", "origin", "main"), type: "delete" },
      ]);
    releaseFetch.resolve();
    await vi.waitFor(() => {
      expect(service.getMetrics().fetchInFlightCount).toBe(0);
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(2);
    });
    expect(getCheckoutRefDerivedState).not.toHaveBeenCalled();

    subscription.unsubscribe();
    service.dispose();
  });

  test("known packed remote refs materialize narrowly while namespace directories are ignored", async () => {
    const watcher = createWatcherHarness();
    const getCheckoutSnapshotFacts = vi.fn(async (cwd: string) => ({
      ...createCheckoutFacts(cwd),
      currentBranch: "feature",
      remoteUrl: REMOTE_URL,
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
      hasOriginRemote: vi.fn(async () => true),
      runGitFetch: vi.fn(async (_cwd, observer) => {
        observer.onRefSnapshot("before");
        observer.onRefSnapshot("after");
        return {
          changes: [],
          nonRemoteRefsChanged: false,
          remoteRefs: new Set(["origin/main", "origin/load/00001"]),
          error: null,
        };
      }),
    });
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());
    await vi.waitFor(() => {
      expect(service.getMetrics().fetchInFlightCount).toBe(0);
      expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(1);
    });

    const repoWatcher = watcher.records.find((record) => record.directory === GIT_DIR);
    repoWatcher?.callback(null, [
      { path: path.join(GIT_DIR, "refs", "remotes", "origin", "load"), type: "create" },
      {
        path: path.join(GIT_DIR, "refs", "remotes", "origin", "load", "00001"),
        type: "create",
      },
    ]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(1);
    expect(getCheckoutRefDerivedState).not.toHaveBeenCalled();

    repoWatcher?.callback(null, [
      { path: path.join(GIT_DIR, "refs", "remotes", "origin", "main"), type: "create" },
    ]);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(getCheckoutRefDerivedState).toHaveBeenCalledTimes(1);
    });
    expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(1);

    subscription.unsubscribe();
    service.dispose();
  });

  test("a second remote-ref move during a narrow refresh queues a final calculation", async () => {
    const watcher = createWatcherHarness();
    const firstRefRefresh = createDeferred<CheckoutStatusGit>();
    const getCheckoutSnapshotFacts = vi.fn(async (cwd: string) => ({
      ...createCheckoutFacts(cwd),
      currentBranch: "feature",
      remoteUrl: REMOTE_URL,
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
    const runGitFetch = vi.fn(async () => ({
      changes: [{ kind: "moved" as const, ref: "origin/main", beforeOid: "a", afterOid: "b" }],
      error: null,
    }));
    const service = createService(watcher, {
      getCheckoutSnapshotFacts,
      getCheckoutRefDerivedState,
      getCheckoutStatus: vi.fn(async (cwd: string) =>
        createCheckoutStatus(cwd, {
          currentBranch: "feature",
          baseRef: "main",
          hasRemote: true,
          remoteUrl: REMOTE_URL,
        }),
      ),
      hasOriginRemote: vi.fn(async () => true),
      runGitFetch,
    });
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());

    await service.getSnapshot(REPO_CWD);
    await vi.waitFor(() => {
      expect(runGitFetch).toHaveBeenCalledTimes(1);
      expect(service.getMetrics().fetchInFlightCount).toBe(0);
    });
    expect(service.getMetrics().workspaceRefreshInFlightCount).toBe(0);
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
      remoteUrl: REMOTE_URL,
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
          remoteUrl: REMOTE_URL,
        }),
      ),
      hasOriginRemote: vi.fn(async () => true),
      runGitFetch: vi.fn(async (_cwd, observer) => {
        observer?.onRefSnapshot("before");
        observer?.onRefSnapshot("after");
        fetchSnapshotRead.resolve();
        await releaseFetch.promise;
        return { changes: [], nonRemoteRefsChanged: false, error: null };
      }),
    });
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());
    await fetchSnapshotRead.promise;
    // Observation setup also reads facts. Wait for the initial snapshot to be
    // published before injecting an event that must produce a second refresh.
    await vi.waitFor(() => {
      expect(service.peekSnapshot(REPO_CWD)?.git.currentBranch).toBe("feature");
      expect(service.getMetrics().workspaceRefreshInFlightCount).toBe(0);
    });
    expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => {
      expect(getWatcherRecordsForDirectory(watcher, GIT_DIR)).toHaveLength(1);
    });
    const [repoWatcher] = getWatcherRecordsForDirectory(watcher, GIT_DIR);
    if (!repoWatcher) throw new Error("Repository watcher was not registered");
    repoWatcher.callback(null, [
      { path: path.join(GIT_DIR, "refs", "remotes", "origin", "main"), type: "update" },
    ]);
    releaseFetch.resolve();
    await vi.waitFor(() => {
      expect(service.getMetrics().fetchInFlightCount).toBe(0);
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(2);
    });

    subscription.unsubscribe();
    service.dispose();
  });

  test("origin/main refreshes a main checkout without configured upstream", async () => {
    const watcher = createWatcherHarness();
    const releaseInitialFacts = createDeferred<void>();
    const getCheckoutSnapshotFacts = vi.fn(async (cwd: string) => {
      await releaseInitialFacts.promise;
      return {
        ...createCheckoutFacts(cwd),
        currentBranch: "main",
        remoteUrl: REMOTE_URL,
        resolvedBaseRef: "main",
        comparisonBaseRef: null,
        branchRemoteName: null,
        branchMergeRef: null,
        upstreamStatus: null,
      };
    });
    const runGitFetch = vi.fn(async () => ({
      changes: [],
      nonRemoteRefsChanged: false,
      error: null,
    }));
    const service = createService(watcher, { getCheckoutSnapshotFacts, runGitFetch });
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());
    await vi.waitFor(() => {
      expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(1);
    });

    releaseInitialFacts.resolve();
    await vi.waitFor(() => {
      expect(getWatcherRecordsForDirectory(watcher, GIT_DIR)).toHaveLength(1);
      expect(service.getMetrics().workspaceRefreshInFlightCount).toBe(0);
      expect(service.getMetrics().workspaceObservationSetupInFlightCount).toBe(0);
      expect(service.getMetrics().fetchInFlightCount).toBe(0);
      expect(runGitFetch).toHaveBeenCalledTimes(1);
    });
    expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(1);
    const repoWatcher = getWatcherRecordsForDirectory(watcher, GIT_DIR)[0]!;
    repoWatcher.callback(null, [
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
    expect(runGitFetch).toHaveBeenLastCalledWith(
      worktrees[1],
      expect.anything(),
      expect.anything(),
    );

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

  test("degraded polling backs off while the snapshot is unchanged and resets on a change", async () => {
    // A repository large enough to defeat the recursive watcher makes every degraded refresh
    // expensive, so a fixed cadence keeps the daemon shelling out Git on an untouched workspace.
    const watcher = createWatcherHarness({ failDirectories: new Set([REPO_CWD]) });
    let isDirty = false;
    const getCheckoutStatus = vi.fn(async (cwd: string) => createCheckoutStatus(cwd, { isDirty }));
    const service = createService(watcher, { getCheckoutStatus });
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());

    await vi.waitFor(() => {
      expect(service.getMetrics().workingTreeWatchTargetCount).toBe(1);
      expect(getCheckoutStatus).toHaveBeenCalledTimes(1);
    });

    // Quiet ticks at 5s, 10s, 20s, 40s, then the 60s ceiling.
    for (const [elapsedMs, expectedCalls] of [
      [5_000, 2],
      [10_000, 3],
      [20_000, 4],
      [40_000, 5],
      [60_000, 6],
      [60_000, 7],
    ] as const) {
      await vi.advanceTimersByTimeAsync(elapsedMs);
      expect(getCheckoutStatus).toHaveBeenCalledTimes(expectedCalls);
    }

    // A fixed 5s cadence would have run 39 polls over the same 195s.
    expect(getCheckoutStatus.mock.calls.length).toBeLessThan(10);

    // A real change snaps the loop back to the base interval.
    isDirty = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getCheckoutStatus).toHaveBeenCalledTimes(8);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getCheckoutStatus).toHaveBeenCalledTimes(9);

    subscription.unsubscribe();
    service.dispose();
  });

  test("degraded repository-metadata polling backs off and resets on a change", async () => {
    // Only the Git-directory watcher fails, so the metadata fallback is the one poll loop running.
    const watcher = createWatcherHarness({ failDirectories: new Set([GIT_DIR]) });
    let isDirty = false;
    const getCheckoutStatus = vi.fn(async (cwd: string) => createCheckoutStatus(cwd, { isDirty }));
    const service = createService(watcher, { getCheckoutStatus });
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());

    await vi.waitFor(() => {
      expect(service.getMetrics().workspaceObservationSetupInFlightCount).toBe(0);
      expect(service.getMetrics().workspaceRefreshInFlightCount).toBe(0);
    });
    const callsBeforePolling = getCheckoutStatus.mock.calls.length;
    function pollCount(): number {
      return getCheckoutStatus.mock.calls.length - callsBeforePolling;
    }

    // Quiet ticks at 5s, 10s, 20s, 40s, then the 60s ceiling.
    for (const [elapsedMs, expectedPolls] of [
      [5_000, 1],
      [10_000, 2],
      [20_000, 3],
      [40_000, 4],
      [60_000, 5],
      [60_000, 6],
    ] as const) {
      await vi.advanceTimersByTimeAsync(elapsedMs);
      expect(pollCount()).toBe(expectedPolls);
    }

    isDirty = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pollCount()).toBe(7);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(pollCount()).toBe(8);

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

  test("watcher runtime error is closed, counted, and switches to scoped polling", async () => {
    const watcher = createWatcherHarness();
    let ignoredDirectories = "node_modules/\n";
    const runGitCommand = vi.fn(async (args: string[]) => ({
      stdout: args[0] === "rev-parse" ? `${REPO_CWD}\n` : ignoredDirectories,
      stderr: "",
      truncated: false,
      exitCode: 0,
      signal: null,
    }));
    const getCheckoutSnapshotFacts = vi.fn(async (cwd: string) => createCheckoutFacts(cwd));
    const getCheckoutStatus = vi.fn(async (cwd: string) => createCheckoutStatus(cwd));
    const service = createService(watcher, {
      getCheckoutSnapshotFacts,
      getCheckoutStatus,
      getWorkspaceGitSelfHealPhaseMs: () => 1_000_000,
      runGitCommand,
    });
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());

    await vi.waitFor(() => {
      expect(service.peekSnapshot(REPO_CWD)).not.toBeNull();
      expect(service.getMetrics().workspaceObservationSetupInFlightCount).toBe(0);
    });
    const checkoutWatcher = watcher.records.find((record) => record.directory === REPO_CWD);
    expect(checkoutWatcher).toBeDefined();

    checkoutWatcher?.callback(new Error("watcher stopped"), []);
    expect(checkoutWatcher?.unsubscribe).toHaveBeenCalledTimes(1);
    expect(service.getMetrics().watcherErrorCallbackCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(getCheckoutStatus).toHaveBeenCalledTimes(2);
    });

    expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(1);
    expect(service.getMetrics().workspaceRefreshQueuedCount).toBe(0);

    ignoredDirectories = "node_modules/\nbuild/\n";
    await vi.advanceTimersByTimeAsync(29_000);
    await vi.waitFor(() => {
      expect(getWatcherRecordsForDirectory(watcher, REPO_CWD)).toHaveLength(2);
    });
    const recoveredWatcher = getWatcherRecordsForDirectory(watcher, REPO_CWD)[1];
    expect(recoveredWatcher?.ignore).toContain(path.join(REPO_CWD, "build"));
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

  test("repository watcher canary timeout closes the subscription and starts fallback polling", async () => {
    const watcher = createWatcherHarness();
    const logger = createLogger();
    const getCheckoutStatus = vi.fn(async (cwd: string) => createCheckoutStatus(cwd));
    const verifyCanary = vi.fn(async () => {
      throw new Error("watcher did not report its liveness canary");
    });
    const service = createService(
      watcher,
      {
        getCheckoutStatus,
        createWatcherLivenessCanary: vi.fn(() => ({
          path: path.join(GIT_DIR, "paseo", ".watcher-canary-timeout"),
          filterEvents: (events: WatchEvent[]) => events,
          verify: verifyCanary,
        })),
      },
      logger,
    );
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());

    await vi.waitFor(() => {
      expect(service.getMetrics().workspaceObservationSetupInFlightCount).toBe(0);
    });
    const repositoryWatcher = getWatcherRecordsForDirectory(watcher, GIT_DIR)[0];
    expect(repositoryWatcher?.unsubscribe).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ repoGitRoot: GIT_DIR }),
      "Failed to start repository metadata watcher; using degraded polling",
    );

    const statusCallsBeforePoll = getCheckoutStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => {
      expect(getCheckoutStatus.mock.calls.length).toBeGreaterThan(statusCallsBeforePoll);
    });

    subscription.unsubscribe();
    service.dispose();
  });

  test("setup-time watcher error defers recovery until subscribe settles", async () => {
    const watcher = createWatcherHarness();
    const openedSubscription = createDeferred<{
      updateIgnore: (paths: string[]) => Promise<void>;
      unsubscribe: () => Promise<void>;
    }>();
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

    openedSubscription.resolve({
      updateIgnore: vi.fn(async () => {}),
      unsubscribe: erroredUnsubscribe,
    });
    await vi.waitFor(() => {
      expect(service.getMetrics().workspaceObservationSetupInFlightCount).toBe(0);
    });
    const statusCallsAfterSetup = getCheckoutStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(29_000);
    expect(getWatcherSubscribeCallCount(watcher, REPO_CWD)).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(getWatcherSubscribeCallCount(watcher, REPO_CWD)).toBe(2);
    });
    expect(erroredUnsubscribe).toHaveBeenCalledTimes(1);
    // Recovery schedules a debounced refresh. Advance the fake clock past the debounce
    // explicitly; vi.waitFor alone runs out of real time before it on a slow runner.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(getCheckoutStatus.mock.calls.length).toBeGreaterThan(statusCallsAfterSetup);

    subscription.unsubscribe();
    service.dispose();
  });

  test("watcher error during subscription setup closes the terminal observer", async () => {
    const watcher = createWatcherHarness();
    const erroredUnsubscribe = vi.fn(async () => {});
    const updateIgnore = vi.fn(async () => {});
    watcher.subscribe.mockImplementationOnce(async (_directory, callback) => {
      callback(new Error("watcher stopped during setup"), []);
      return { updateIgnore, unsubscribe: erroredUnsubscribe };
    });
    const service = createService(watcher);

    const subscription = await service.requestWorkingTreeWatch(REPO_CWD, vi.fn());

    expect(erroredUnsubscribe).toHaveBeenCalledTimes(1);
    expect(service.getMetrics().watcherErrorCallbackCount).toBe(1);

    subscription.unsubscribe();
    service.dispose();
  });

  test("repository watcher runtime error is closed, counted, and recovered", async () => {
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

    expect(repositoryWatcher?.unsubscribe).toHaveBeenCalledTimes(1);
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

  test("watcher recovery keeps retrying past the old attempt cap and the ladder does not reset on immediate re-failure", async () => {
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
    await driveWatchRecoveryLadder(watcher, REPO_CWD);

    // Past the old cap of 3 recovery attempts (4 total subscriptions), the
    // service keeps retrying instead of giving up permanently.
    expect(getWatcherSubscribeCallCount(watcher, REPO_CWD)).toBe(
      WATCH_RECOVERY_LADDER_DELAYS_MS.length + 1,
    );
    const statusCallsAfterLadder = getCheckoutStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(300_000);
    await vi.waitFor(() => {
      expect(getWatcherSubscribeCallCount(watcher, REPO_CWD)).toBe(
        WATCH_RECOVERY_LADDER_DELAYS_MS.length + 2,
      );
    });
    expect(getCheckoutStatus.mock.calls.length).toBeGreaterThan(statusCallsAfterLadder);

    subscription.unsubscribe();
    service.dispose();
  });

  test("repository watcher recovery keeps retrying past the old attempt cap and the ladder does not reset on immediate re-failure", async () => {
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
    await driveWatchRecoveryLadder(watcher, GIT_DIR);

    // Past the old cap of 3 recovery attempts (4 total subscriptions), the
    // service keeps retrying instead of giving up permanently.
    expect(getWatcherSubscribeCallCount(watcher, GIT_DIR)).toBe(
      WATCH_RECOVERY_LADDER_DELAYS_MS.length + 1,
    );
    const statusCallsAfterLadder = getCheckoutStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(300_000);
    await vi.waitFor(() => {
      expect(getWatcherSubscribeCallCount(watcher, GIT_DIR)).toBe(
        WATCH_RECOVERY_LADDER_DELAYS_MS.length + 2,
      );
    });
    expect(getCheckoutStatus.mock.calls.length).toBeGreaterThan(statusCallsAfterLadder);

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
    checkoutWatcher?.callback(null, [{ path: path.join(REPO_CWD, ".gitignore"), type: "update" }]);
    await vi.waitFor(() => {
      expect(runGitCommand).toHaveBeenCalledTimes(3);
      expect(checkoutWatcher?.updateIgnore).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(service.getMetrics().workspaceRefreshInFlightCount).toBe(0);
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

  test("pruneKnownDirectories case-folds a Windows-shaped watch root", () => {
    // `pruneKnownDirectories` only needs to fold case when the watch root
    // *looks* like a Windows path (drive letter or UNC) — see
    // `looksLikeDefiniteWindowsPath` in `../utils/path.js`, the same rule
    // `isPathInsideRoot`/`isRealpathInsideRoot` used before this method was
    // rewritten from realpath comparisons to string prefixes (see the
    // class-level comment on `pruneKnownDirectories`). macOS's real
    // filesystem is already case-insensitive, so a test built from real
    // directories on disk would pass whether or not that fold logic
    // exists — a synthetic Windows-shaped root exercises the comparison
    // logic itself instead of relying on host filesystem behavior.
    //
    // Driven directly against the private target rather than through
    // `registerWorkspace`, for two independent reasons, both checked before
    // settling on this shape:
    //
    // 1. Reachability: `registerWorkspace` resolves `cwd` through
    //    `node:path`'s `resolve()` before anything else runs, and on this
    //    POSIX test host that rewrites a drive-letter path into an ordinary
    //    POSIX one, destroying the shape this test depends on. This step can
    //    be routed around — mocking `git rev-parse --show-toplevel`'s stdout
    //    lets `target.watchPath` carry the raw Windows-shaped string, since
    //    `parseGitRevParsePath` does not call `resolve()` — but
    //    `loadIgnoredDirs` then calls `resolve(rootPath, rel)` on that same
    //    watch path to build `ignoredDirectories`, which on POSIX prefixes it
    //    with `process.cwd()` and breaks the shared prefix the fold logic
    //    compares against. Two independent `resolve()` calls, each assuming
    //    host-platform semantics, block the public path from both sides.
    // 2. Observability: even granting reachability, `knownDirectories` has
    //    exactly one reader outside this method — the Set-lookup fast path in
    //    `noteWorkingTreeDirectories` — and that method's fallback branch
    //    re-derives ignored-ness via `isPathInsideRoot`, which already folds
    //    case correctly on its own. Verified by deleting this method's fold
    //    logic (forcing `foldCase = false`) and running this file plus the
    //    integration suite: only this test failed. No public-surface
    //    assertion distinguishes a correctly pruned directory from one left
    //    stale, because the redundant check downstream produces the same
    //    outcome either way.
    const service = createService(createWatcherHarness());
    const target = {
      watchPath: "C:/Users/dev/Repo",
      knownDirectories: new Set<string>(["C:/Users/dev/Repo/Deps/package-a"]),
      ignoredDirectories: new Set<string>(["C:/Users/dev/Repo/deps"]),
    };

    (
      service as unknown as { pruneKnownDirectories: (t: typeof target) => void }
    ).pruneKnownDirectories(target);

    expect(target.knownDirectories.has("C:/Users/dev/Repo/Deps/package-a")).toBe(false);

    service.dispose();
  });

  test("a previously unseen directory refreshes the ignore set", async () => {
    const watcher = createWatcherHarness();
    // A fresh worktree has no ignored directories on disk yet.
    let ignoredDirectories = "";
    const runGitCommand = vi.fn(async (args: string[]) => ({
      stdout: args[0] === "rev-parse" ? `${REPO_CWD}\n` : ignoredDirectories,
      stderr: "",
      truncated: false,
      exitCode: 0,
      signal: null,
    }));
    const service = createService(watcher, {
      getWorkspaceGitSelfHealPhaseMs: () => 1_000,
      runGitCommand,
    });
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());

    await vi.waitFor(() => {
      expect(getWatcherRecordsForDirectory(watcher, REPO_CWD)).toHaveLength(1);
      expect(service.getMetrics().workspaceObservationSetupInFlightCount).toBe(0);
    });
    const checkoutWatcher = watcher.records.find((record) => record.directory === REPO_CWD);
    expect(checkoutWatcher?.ignore).not.toContain(path.join(REPO_CWD, "deps"));

    // Dependencies get installed. No .gitignore is touched.
    ignoredDirectories = "deps/\n";
    checkoutWatcher?.callback(null, [
      { path: path.join(REPO_CWD, "deps", "package-a", "index.js"), type: "create" },
    ]);
    await vi.advanceTimersByTimeAsync(2_000);

    await vi.waitFor(() => {
      expect(checkoutWatcher?.updateIgnore).toHaveBeenCalledWith(
        expect.arrayContaining([path.join(REPO_CWD, "deps")]),
      );
    });

    subscription.unsubscribe();
    service.dispose();
  });

  test("a failed ignore refresh does not permanently mark a directory known", async () => {
    // Regression for the failure path reintroducing the original #4558 bug:
    // `noteWorkingTreeDirectories` marks a newly seen directory known and
    // schedules a debounced refresh, but `loadIgnoredDirs` deliberately keeps
    // the previous ignore set when `git ls-files` fails (a transient failure
    // must not un-ignore the whole dependency tree). If that success/failure
    // distinction is not carried back, the directory stays "known" forever
    // with the fast-path Set lookup in `noteWorkingTreeDirectories` skipping
    // it on every later event — so no refresh is ever attempted again and
    // the directory is watched forever, same as before #4558 was fixed.
    const watcher = createWatcherHarness();
    let ignoredDirectories = "";
    let lsFilesCallCount = 0;
    const runGitCommand = vi.fn(async (args: string[]) => {
      if (args[0] === "rev-parse") {
        return { stdout: `${REPO_CWD}\n`, stderr: "", truncated: false, exitCode: 0, signal: null };
      }
      lsFilesCallCount += 1;
      // The seed load at registration (call 1) succeeds. The refresh
      // triggered by the newly discovered "deps" directory (call 2) fails
      // transiently.
      if (lsFilesCallCount === 2) {
        throw new Error("git ls-files timed out");
      }
      return {
        stdout: ignoredDirectories,
        stderr: "",
        truncated: false,
        exitCode: 0,
        signal: null,
      };
    });
    const service = createService(watcher, {
      getWorkspaceGitSelfHealPhaseMs: () => 1_000,
      runGitCommand,
    });
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());

    await vi.waitFor(() => {
      expect(getWatcherRecordsForDirectory(watcher, REPO_CWD)).toHaveLength(1);
      expect(service.getMetrics().workspaceObservationSetupInFlightCount).toBe(0);
    });
    const checkoutWatcher = watcher.records.find((record) => record.directory === REPO_CWD);
    expect(lsFilesCallCount).toBe(1);

    // Dependencies get installed. No .gitignore is touched, so this only
    // schedules a refresh via directory discovery — the one wired to fail.
    ignoredDirectories = "deps/\n";
    checkoutWatcher?.callback(null, [
      { path: path.join(REPO_CWD, "deps", "package-a", "index.js"), type: "create" },
    ]);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => {
      expect(lsFilesCallCount).toBe(2);
    });
    // The failed refresh must not have applied "deps" to the live watcher.
    expect(checkoutWatcher?.updateIgnore).not.toHaveBeenCalled();

    // A later write under the same directory. If the directory were left
    // permanently "known" by the failed refresh, `noteWorkingTreeDirectories`
    // would silently skip it here and no second refresh would ever happen.
    checkoutWatcher?.callback(null, [
      { path: path.join(REPO_CWD, "deps", "package-a", "index2.js"), type: "create" },
    ]);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => {
      expect(lsFilesCallCount).toBe(3);
      expect(checkoutWatcher?.updateIgnore).toHaveBeenCalledWith(
        expect.arrayContaining([path.join(REPO_CWD, "deps")]),
      );
    });

    subscription.unsubscribe();
    service.dispose();
  });

  test("repeat writes in known directories do not re-run git ls-files", async () => {
    const watcher = createWatcherHarness();
    let ignoredDirectories = "";
    const runGitCommand = vi.fn(async (args: string[]) => ({
      stdout: args[0] === "rev-parse" ? `${REPO_CWD}\n` : ignoredDirectories,
      stderr: "",
      truncated: false,
      exitCode: 0,
      signal: null,
    }));
    const service = createService(watcher, {
      getWorkspaceGitSelfHealPhaseMs: () => 1_000,
      runGitCommand,
    });
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());
    await vi.waitFor(() => {
      expect(getWatcherRecordsForDirectory(watcher, REPO_CWD)).toHaveLength(1);
      expect(service.getMetrics().workspaceObservationSetupInFlightCount).toBe(0);
    });
    const checkoutWatcher = watcher.records.find((record) => record.directory === REPO_CWD);
    // Registration itself performs one ls-files call to seed the ignore set. Measure the
    // burst's effect as a delta from this baseline, not an absolute count, so the assertion
    // cannot pass vacuously off of setup's own call.
    const lsFilesAtSetup = runGitCommand.mock.calls.filter(
      (call) => call[0][0] === "ls-files",
    ).length;

    // One burst in a new directory: one debounced refresh, not one per event.
    ignoredDirectories = "deps/\n";
    for (let index = 0; index < 500; index += 1) {
      checkoutWatcher?.callback(null, [
        { path: path.join(REPO_CWD, "deps", `module-${index}.js`), type: "create" },
      ]);
    }
    await vi.advanceTimersByTimeAsync(3_000);
    const lsFilesAfterBurst = runGitCommand.mock.calls.filter(
      (call) => call[0][0] === "ls-files",
    ).length;
    // The burst must have refreshed the ignore set at least once...
    expect(lsFilesAfterBurst - lsFilesAtSetup).toBeGreaterThanOrEqual(1);
    // ...but debounced into at most 2 calls, not one per event. (The brief's original absolute
    // bound was <= 3 total calls with a baseline of 1 from setup, i.e. at most 2 burst-triggered
    // refreshes — preserve that numeric intent here as a delta.)
    expect(lsFilesAfterBurst - lsFilesAtSetup).toBeLessThanOrEqual(2);

    // The directory is known now. Further writes trigger nothing.
    for (let index = 0; index < 200; index += 1) {
      checkoutWatcher?.callback(null, [
        { path: path.join(REPO_CWD, "src", `file-${index}.ts`), type: "update" },
      ]);
    }
    await vi.advanceTimersByTimeAsync(3_000);
    const lsFilesAtEnd = runGitCommand.mock.calls.filter(
      (call) => call[0][0] === "ls-files",
    ).length;
    expect(lsFilesAtEnd).toBeLessThanOrEqual(lsFilesAfterBurst + 1);

    subscription.unsubscribe();
    service.dispose();
  });

  test("a deleted known directory is dropped, so a later event under it re-runs git ls-files", async () => {
    // Regression for the finding that `knownDirectories` only ever grows:
    // nothing previously removed an entry once its directory was deleted
    // from disk, so a long-lived daemon over a churning tree (deps
    // installed and removed, build output cycling) would accumulate
    // tombstones for the life of the target and slow every future
    // `pruneKnownDirectories` pass. `removeDeletedKnownDirectories` must
    // drop a directory (and anything nested under it) once a `delete`
    // event reports the directory path itself — proven here by making a
    // write reappear under the same path afterward and asserting it costs
    // a fresh `git ls-files` refresh rather than being silently skipped by
    // the known-directory fast path.
    const watcher = createWatcherHarness();
    const runGitCommand = vi.fn(async (args: string[]) => ({
      stdout: args[0] === "rev-parse" ? `${REPO_CWD}\n` : "",
      stderr: "",
      truncated: false,
      exitCode: 0,
      signal: null,
    }));
    const service = createService(watcher, {
      getWorkspaceGitSelfHealPhaseMs: () => 1_000,
      runGitCommand,
    });
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());
    await vi.waitFor(() => {
      expect(getWatcherRecordsForDirectory(watcher, REPO_CWD)).toHaveLength(1);
      expect(service.getMetrics().workspaceObservationSetupInFlightCount).toBe(0);
    });
    const checkoutWatcher = watcher.records.find((record) => record.directory === REPO_CWD);
    const lsFilesCallCount = () =>
      runGitCommand.mock.calls.filter((call) => call[0][0] === "ls-files").length;
    const lsFilesAtSetup = lsFilesCallCount();

    const depsDir = path.join(REPO_CWD, "deps");
    // First sight of `deps`: marks it known and schedules one debounced refresh.
    checkoutWatcher?.callback(null, [{ path: path.join(depsDir, "index.js"), type: "create" }]);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => {
      expect(lsFilesCallCount()).toBeGreaterThan(lsFilesAtSetup);
    });
    const lsFilesAfterDepsDiscovery = lsFilesCallCount();

    // A nested directory under `deps` becomes known too. A directory delete
    // does not guarantee a delete event for everything beneath it, so
    // removal must drop this along with `deps` itself.
    const nestedDir = path.join(depsDir, "nested");
    checkoutWatcher?.callback(null, [{ path: path.join(nestedDir, "index.js"), type: "create" }]);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => {
      expect(lsFilesCallCount()).toBeGreaterThan(lsFilesAfterDepsDiscovery);
    });
    const lsFilesAfterNestedDiscovery = lsFilesCallCount();

    // Steady state: another write in a known directory triggers nothing.
    checkoutWatcher?.callback(null, [{ path: path.join(depsDir, "index2.js"), type: "update" }]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(lsFilesCallCount()).toBe(lsFilesAfterNestedDiscovery);

    // `deps` (the parent) is deleted from disk. The watcher reports the
    // directory path itself, not just files under it.
    checkoutWatcher?.callback(null, [{ path: depsDir, type: "delete" }]);

    // A write reappears directly under `deps`. If the delete had not
    // dropped it from `knownDirectories`, the known-directory fast path
    // would skip this event and no refresh would run.
    checkoutWatcher?.callback(null, [
      { path: path.join(depsDir, "reinstalled.js"), type: "create" },
    ]);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => {
      expect(lsFilesCallCount()).toBeGreaterThan(lsFilesAfterNestedDiscovery);
    });
    const lsFilesAfterDepsRediscovery = lsFilesCallCount();

    // The formerly nested `deps/nested` must have been dropped too, even
    // though only `deps` itself received a delete event.
    checkoutWatcher?.callback(null, [
      { path: path.join(nestedDir, "reinstalled.js"), type: "create" },
    ]);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => {
      expect(lsFilesCallCount()).toBeGreaterThan(lsFilesAfterDepsRediscovery);
    });

    subscription.unsubscribe();
    service.dispose();
  });

  test("a large event batch refreshes ignored roots without scanning every new directory", async () => {
    const watcher = createWatcherHarness();
    const runGitCommand = vi.fn(async (args: string[]) => ({
      stdout: args[0] === "rev-parse" ? `${REPO_CWD}\n` : "",
      stderr: "",
      truncated: false,
      exitCode: 0,
      signal: null,
    }));
    const service = createService(watcher, {
      getWorkspaceGitSelfHealPhaseMs: () => 1_000,
      runGitCommand,
    });
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());
    await vi.waitFor(() => {
      expect(getWatcherRecordsForDirectory(watcher, REPO_CWD)).toHaveLength(1);
      expect(service.getMetrics().workspaceObservationSetupInFlightCount).toBe(0);
    });
    const checkoutWatcher = watcher.records.find((record) => record.directory === REPO_CWD);
    const lsFilesCallCount = () =>
      runGitCommand.mock.calls.filter((call) => call[0][0] === "ls-files").length;
    const lsFilesAtSetup = lsFilesCallCount();

    // Establish one directory as known and steady before the flood.
    const markerDir = path.join(REPO_CWD, "marker");
    checkoutWatcher?.callback(null, [{ path: path.join(markerDir, "file.js"), type: "create" }]);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => {
      expect(lsFilesCallCount()).toBeGreaterThan(lsFilesAtSetup);
    });
    const lsFilesAfterMarker = lsFilesCallCount();

    // Steady state: another write under the marker directory triggers nothing.
    checkoutWatcher?.callback(null, [{ path: path.join(markerDir, "file2.js"), type: "update" }]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(lsFilesCallCount()).toBe(lsFilesAfterMarker);

    // A single discovery refreshes Git's complete ignored-directory inventory.
    // The other directories in this batch need not enter the known cache.
    const floodEvents = Array.from({ length: 50_000 }, (_, index) => ({
      path: path.join(REPO_CWD, "gen", `d${index}`, "file.js"),
      type: "create" as const,
    }));
    checkoutWatcher?.callback(null, floodEvents);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => {
      expect(lsFilesCallCount()).toBeGreaterThan(lsFilesAfterMarker);
    });
    const lsFilesAfterFlood = lsFilesCallCount();

    // The flood must not evict an unrelated known directory by processing
    // every entry before the cap is checked. Its later edit stays on the
    // cache fast path and does not trigger a redundant Git refresh.
    checkoutWatcher?.callback(null, [{ path: path.join(markerDir, "file3.js"), type: "create" }]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(lsFilesCallCount()).toBe(lsFilesAfterFlood);

    subscription.unsubscribe();
    service.dispose();
  });

  test("watcher recovery keeps retrying after repeated failures", async () => {
    // The initial subscribe must succeed so the target starts out healthy; only subscribe
    // attempts made *after* that (i.e. recovery attempts) should fail. `failDirectories` is
    // read live on every `subscribe()` call, so mutating it after registration is enough —
    // no need to fork the harness.
    const failDirectories = new Set<string>();
    const watcher = createWatcherHarness({ failDirectories });
    let ignoredDirectories = "node_modules/\n";
    const runGitCommand = vi.fn(async (args: string[]) => ({
      stdout: args[0] === "rev-parse" ? `${REPO_CWD}\n` : ignoredDirectories,
      stderr: "",
      truncated: false,
      exitCode: 0,
      signal: null,
    }));
    const service = createService(watcher, {
      getWorkspaceGitSelfHealPhaseMs: () => 1_000,
      runGitCommand,
    });
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());
    await vi.waitFor(() => {
      expect(getWatcherRecordsForDirectory(watcher, REPO_CWD)).toHaveLength(1);
      expect(service.getMetrics().workspaceObservationSetupInFlightCount).toBe(0);
    });
    const checkoutWatcher = watcher.records.find((record) => record.directory === REPO_CWD);
    const subscribeCallsBeforeFailure = getWatcherSubscribeCallCount(watcher, REPO_CWD);

    // From here on, every further subscribe attempt for this directory fails — a watcher that
    // cannot be re-established (permission error, unmounted volume, etc).
    failDirectories.add(REPO_CWD);

    // Force the live subscription to fail and enter recovery. A rejected updateIgnore is the
    // most direct trigger: it nulls target.subscription and schedules recovery.
    checkoutWatcher?.updateIgnore.mockRejectedValueOnce(new Error("update failed"));
    ignoredDirectories = "node_modules/\nbuild/\n";
    checkoutWatcher?.callback(null, [{ path: path.join(REPO_CWD, ".gitignore"), type: "update" }]);

    // Recovery backs off at WATCH_RECOVERY_BASE_DELAY_MS * 2**(attempt-1) with base 30_000ms,
    // landing at 30s, 60s, 120s, 240s for the first 4 attempts (WATCH_RECOVERY_MAX_BACKOFF_STEPS
    // caps the exponent at 4, and WATCH_RECOVERY_MAX_DELAY_MS's 300s ceiling doesn't bind until
    // the 5th). A 4th recovery attempt needs the first four delays to have elapsed:
    // 30_000 + 60_000 + 120_000 + 240_000 = 450_000ms. Advance past that with headroom.
    await vi.advanceTimersByTimeAsync(500_000);

    const subscribeCallsAfterRecoveryWindow = getWatcherSubscribeCallCount(watcher, REPO_CWD);
    // 1 initial success + 3 capped recovery attempts = 4 total. A 5th call would prove recovery
    // keeps retrying past the hard cap instead of giving up on this target forever.
    expect(subscribeCallsAfterRecoveryWindow).toBeGreaterThan(subscribeCallsBeforeFailure + 3);

    subscription.unsubscribe();
    service.dispose();
  });

  test("removing an ignored directory updates the watcher without replacement", async () => {
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
    originalWatcher?.callback(null, [{ path: path.join(REPO_CWD, ".gitignore"), type: "update" }]);
    await vi.waitFor(() => {
      expect(originalWatcher?.updateIgnore).toHaveBeenCalledTimes(1);
      expect(service.getMetrics().workspaceRefreshInFlightCount).toBe(0);
    });

    expect(getWatcherRecordsForDirectory(watcher, REPO_CWD)).toHaveLength(1);
    expect(originalWatcher?.unsubscribe).not.toHaveBeenCalled();
    expect(originalWatcher?.ignore).not.toContain(path.join(REPO_CWD, "build"));
    const statusCallsAfterRefresh = getCheckoutStatus.mock.calls.length;
    originalWatcher?.callback(null, [
      { path: path.join(REPO_CWD, "build", "output.js"), type: "update" },
    ]);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(getCheckoutStatus).toHaveBeenCalledTimes(statusCallsAfterRefresh + 1);
    });

    subscription.unsubscribe();
    service.dispose();
  });

  test("repository exclude changes update working-tree filtering", async () => {
    const watcher = createWatcherHarness();
    let ignoredDirectories = "node_modules/\n";
    const runGitCommand = vi.fn(async (args: string[]) => ({
      stdout: args[0] === "rev-parse" ? `${REPO_CWD}\n` : ignoredDirectories,
      stderr: "",
      truncated: false,
      exitCode: 0,
      signal: null,
    }));
    const service = createService(watcher, { runGitCommand });
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());

    await vi.waitFor(() => {
      expect(service.getMetrics().workspaceObservationSetupInFlightCount).toBe(0);
    });
    const checkoutWatcher = getWatcherRecordsForDirectory(watcher, REPO_CWD)[0];
    const repositoryWatcher = getWatcherRecordsForDirectory(watcher, GIT_DIR)[0];
    ignoredDirectories = "node_modules/\nbuild/\n";

    repositoryWatcher?.callback(null, [
      { path: path.join(GIT_DIR, "info", "exclude"), type: "update" },
    ]);
    await vi.waitFor(() => {
      expect(checkoutWatcher?.updateIgnore).toHaveBeenCalledTimes(1);
    });
    expect(checkoutWatcher?.ignore).toContain(path.join(REPO_CWD, "build"));

    subscription.unsubscribe();
    service.dispose();
  });

  test("ignore events during a refresh trigger a trailing recomputation", async () => {
    const watcher = createWatcherHarness();
    const blockedRefresh = createDeferred<{
      stdout: string;
      stderr: string;
      truncated: boolean;
      exitCode: number;
      signal: null;
    }>();
    let lsFilesCallCount = 0;
    const runGitCommand = vi.fn(async (args: string[]) => {
      if (args[0] === "rev-parse") {
        return {
          stdout: `${REPO_CWD}\n`,
          stderr: "",
          truncated: false,
          exitCode: 0,
          signal: null,
        };
      }
      lsFilesCallCount += 1;
      if (lsFilesCallCount === 2) return blockedRefresh.promise;
      return {
        stdout: lsFilesCallCount === 1 ? "node_modules/\n" : "node_modules/\nbuild/\n",
        stderr: "",
        truncated: false,
        exitCode: 0,
        signal: null,
      };
    });
    const service = createService(watcher, { runGitCommand });
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());

    await vi.waitFor(() => {
      expect(service.getMetrics().workspaceObservationSetupInFlightCount).toBe(0);
    });
    const checkoutWatcher = getWatcherRecordsForDirectory(watcher, REPO_CWD)[0];
    checkoutWatcher?.callback(null, [{ path: path.join(REPO_CWD, ".gitignore"), type: "update" }]);
    await vi.waitFor(() => expect(lsFilesCallCount).toBe(2));
    checkoutWatcher?.callback(null, [{ path: path.join(REPO_CWD, ".gitignore"), type: "update" }]);
    blockedRefresh.resolve({
      stdout: "node_modules/\n",
      stderr: "",
      truncated: false,
      exitCode: 0,
      signal: null,
    });

    await vi.waitFor(() => expect(lsFilesCallCount).toBe(3));
    expect(checkoutWatcher?.ignore).toContain(path.join(REPO_CWD, "build"));

    subscription.unsubscribe();
    service.dispose();
  });

  test("ignore watcher update failure enters polling with a distinct reason", async () => {
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
    checkoutWatcher?.updateIgnore.mockRejectedValueOnce(new Error("update failed"));
    ignoredDirectories = "node_modules/\n";

    checkoutWatcher?.callback(null, [{ path: path.join(REPO_CWD, ".gitignore"), type: "update" }]);
    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "watcher_update_failed" }),
        "Working tree watcher unavailable; using bounded polling fallback",
      );
    });
    expect(service.getMetrics().watcherErrorCallbackCount).toBe(0);
    const statusCallsBeforePoll = getCheckoutStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => {
      expect(getCheckoutStatus.mock.calls.length).toBeGreaterThan(statusCallsBeforePoll);
    });
    await vi.advanceTimersByTimeAsync(25_000);
    await vi.waitFor(() => {
      expect(getWatcherRecordsForDirectory(watcher, REPO_CWD)).toHaveLength(2);
    });

    subscription.unsubscribe();
    service.dispose();
  });

  test("a working-tree watcher event refreshes summary and diff subscribers", async () => {
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

    getWatcherRecordsForDirectory(watcher, REPO_CWD)[0]?.callback(null, [
      { path: path.join(REPO_CWD, "tracked.txt"), type: "update" },
    ]);
    await vi.advanceTimersByTimeAsync(1_000);
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
