import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { toCheckoutErrorMock } = vi.hoisted(() => ({
  toCheckoutErrorMock: vi.fn((error: unknown) => ({
    message: error instanceof Error ? error.message : String(error),
  })),
}));

vi.mock("./checkout-git-utils.js", () => ({
  toCheckoutError: toCheckoutErrorMock,
}));

import type pino from "pino";
import { CheckoutDiffManager } from "./checkout-diff-manager.js";
import type { WorkspaceGitRuntimeSnapshot, WorkspaceGitService } from "./workspace-git-service.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createWorkspaceSnapshot(
  overrides?: Partial<WorkspaceGitRuntimeSnapshot["git"]>,
): WorkspaceGitRuntimeSnapshot {
  return {
    cwd: "/tmp/repo",
    git: {
      isGit: true,
      repoRoot: "/tmp/repo",
      mainRepoRoot: null,
      currentBranch: "feature",
      remoteUrl: "https://github.com/acme/repo.git",
      isPaseoOwnedWorktree: false,
      isDirty: false,
      baseRef: "main",
      aheadBehind: { ahead: 1, behind: 0 },
      aheadOfOrigin: 1,
      behindOfOrigin: 0,
      hasRemote: true,
      diffStat: { additions: 1, deletions: 0 },
      ...overrides,
    },
    forge: {
      featuresEnabled: false,
      authState: "no_remote",
      pullRequest: null,
      error: null,
    },
  };
}

function createPendingManager() {
  const watches: Array<{
    cwd: string;
    onChange: () => void;
    unsubscribeCalls: number;
    resolve(): void;
  }> = [];
  const workspaceGitService = {
    getCheckoutDiff: async () => ({ diff: "", structured: [] }),
    getSnapshot: async () => createWorkspaceSnapshot(),
    peekSnapshot: () => null,
    registerWorkspace: () => ({ unsubscribe: () => {} }),
    requestWorkingTreeWatch: (cwd: string, onChange: () => void) => {
      const pending = createDeferred<{ repoRoot: string | null; unsubscribe: () => void }>();
      const watch = {
        cwd,
        onChange,
        unsubscribeCalls: 0,
        resolve: () => {
          pending.resolve({
            repoRoot: "/tmp/repo",
            unsubscribe: () => {
              watch.unsubscribeCalls += 1;
            },
          });
        },
      };
      watches.push(watch);
      return pending.promise;
    },
  };
  const logger = { child: () => logger, warn: () => {} };
  const manager = new CheckoutDiffManager({
    logger: logger as unknown as pino.Logger,
    paseoHome: "/tmp/paseo-test",
    workspaceGitService,
  });
  return { manager, watches };
}

describe("CheckoutDiffManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    toCheckoutErrorMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createManager(options?: {
    repoRoot?: string | null;
    getCheckoutDiffImplementation?: ReturnType<typeof vi.fn>;
  }) {
    const unsubscribe = vi.fn();
    const workspaceUnsubscribe = vi.fn();
    let onChange: (() => void) | null = null;
    let onWorkspaceSnapshot: ((snapshot: WorkspaceGitRuntimeSnapshot) => void) | null = null;
    const mockRequestWorkingTreeWatch = vi.fn(async (_cwd: string, listener: () => void) => {
      onChange = listener;
      return {
        repoRoot: options?.repoRoot === undefined ? "/tmp/repo" : options.repoRoot,
        unsubscribe,
      };
    });

    const workspaceGitService = {
      subscribe: vi.fn(),
      peekSnapshot: vi.fn(),
      registerWorkspace: vi.fn(
        (_params: { cwd: string }, listener: (snapshot: WorkspaceGitRuntimeSnapshot) => void) => {
          onWorkspaceSnapshot = listener;
          return { unsubscribe: workspaceUnsubscribe };
        },
      ),
      getSnapshot: vi.fn(async () => createWorkspaceSnapshot()),
      getCheckoutDiff:
        options?.getCheckoutDiffImplementation ?? vi.fn(async () => ({ diff: "", structured: [] })),
      refresh: vi.fn(),
      scheduleRefreshForCwd: vi.fn(),
      requestWorkingTreeWatch: mockRequestWorkingTreeWatch,
      dispose: vi.fn(),
    };

    const logger = {
      child: () => logger,
      warn: vi.fn(),
    };

    const manager = new CheckoutDiffManager({
      logger: logger as unknown as pino.Logger,
      paseoHome: "/tmp/paseo-test",
      workspaceGitService: workspaceGitService as unknown as WorkspaceGitService,
    });

    return {
      manager,
      workspaceGitService,
      mockRequestWorkingTreeWatch,
      unsubscribe,
      getOnChange: () => onChange,
      getOnWorkspaceSnapshot: () => onWorkspaceSnapshot,
      workspaceUnsubscribe,
    };
  }

  test("subscribe requests a working tree watch with the correct cwd", async () => {
    const { manager, mockRequestWorkingTreeWatch } = createManager();

    await manager.subscribe(
      {
        cwd: "/tmp/repo/packages/server",
        compare: { mode: "uncommitted" },
      },
      () => {},
    );

    expect(mockRequestWorkingTreeWatch).toHaveBeenCalledWith(
      "/tmp/repo/packages/server",
      expect.any(Function),
    );
  });

  test("unsubscribe calls the working tree watch unsubscribe", async () => {
    const { manager, unsubscribe } = createManager();

    const subscription = await manager.subscribe(
      {
        cwd: "/tmp/repo/packages/server",
        compare: { mode: "uncommitted" },
      },
      () => {},
    );

    subscription.unsubscribe();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  test("cancels a subscription while its working tree watch is still opening", async () => {
    const { manager, watches } = createPendingManager();
    const abort = new AbortController();

    const pendingSubscription = manager.subscribe(
      {
        cwd: "/tmp/repo/packages/server",
        compare: { mode: "uncommitted" },
        signal: abort.signal,
      },
      () => {},
    );
    abort.abort();
    watches[0].resolve();
    await pendingSubscription;

    expect(watches[0].unsubscribeCalls).toBe(1);
    expect(manager.getMetrics()).toEqual({
      checkoutDiffTargetCount: 0,
      checkoutDiffSubscriptionCount: 0,
      checkoutDiffWatcherCount: 0,
      checkoutDiffFallbackRefreshTargetCount: 0,
    });
  });

  test("shares one opening target between concurrent subscriptions", async () => {
    const { manager, watches } = createPendingManager();

    const firstSubscription = manager.subscribe(
      { cwd: "/tmp/repo/packages/server", compare: { mode: "uncommitted" } },
      () => {},
    );
    const secondSubscription = manager.subscribe(
      { cwd: "/tmp/repo/packages/server", compare: { mode: "uncommitted" } },
      () => {},
    );

    expect(watches).toHaveLength(1);
    watches[0].resolve();
    const [first, second] = await Promise.all([firstSubscription, secondSubscription]);
    expect(manager.getMetrics().checkoutDiffSubscriptionCount).toBe(2);

    first.unsubscribe();
    expect(watches[0].unsubscribeCalls).toBe(0);
    second.unsubscribe();
    expect(watches[0].unsubscribeCalls).toBe(1);
  });

  test("diffCwd uses repoRoot from the working tree watch result", async () => {
    const { manager, workspaceGitService } = createManager({ repoRoot: "/tmp/repo" });

    await manager.subscribe(
      {
        cwd: "/tmp/repo/packages/server",
        compare: { mode: "uncommitted" },
      },
      () => {},
    );

    expect(workspaceGitService.getCheckoutDiff).toHaveBeenCalledWith(
      "/tmp/repo",
      expect.objectContaining({ mode: "uncommitted", includeStructured: true }),
      undefined,
    );
  });

  test("diff refresh is triggered when the working tree watch callback fires", async () => {
    const getCheckoutDiff = vi
      .fn()
      .mockResolvedValueOnce({
        diff: "",
        structured: [{ path: "a.ts", additions: 1, deletions: 0, status: "modified" }],
      })
      .mockResolvedValueOnce({
        diff: "",
        structured: [{ path: "b.ts", additions: 2, deletions: 0, status: "modified" }],
      });

    const { manager, getOnChange } = createManager({
      getCheckoutDiffImplementation: getCheckoutDiff,
    });
    const listener = vi.fn();

    await manager.subscribe(
      {
        cwd: "/tmp/repo/packages/server",
        compare: { mode: "uncommitted" },
      },
      listener,
    );

    const onChange = getOnChange();
    expect(onChange).toBeTypeOf("function");

    onChange?.();
    await vi.advanceTimersByTimeAsync(150);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      cwd: "/tmp/repo/packages/server",
      files: [{ path: "b.ts", additions: 2, deletions: 0, status: "modified" }],
      error: null,
    });
  });

  test("watch-triggered refresh forces a cache bypass on getCheckoutDiff", async () => {
    const getCheckoutDiff = vi
      .fn()
      .mockResolvedValueOnce({
        diff: "",
        structured: [{ path: "a.ts", additions: 1, deletions: 0, status: "modified" }],
      })
      .mockResolvedValueOnce({
        diff: "",
        structured: [{ path: "b.ts", additions: 2, deletions: 0, status: "modified" }],
      });

    const { manager, getOnChange } = createManager({
      getCheckoutDiffImplementation: getCheckoutDiff,
    });

    await manager.subscribe(
      {
        cwd: "/tmp/repo/packages/server",
        compare: { mode: "uncommitted" },
      },
      vi.fn(),
    );

    expect(getCheckoutDiff).toHaveBeenNthCalledWith(
      1,
      "/tmp/repo",
      expect.objectContaining({ mode: "uncommitted" }),
      undefined,
    );

    const onChange = getOnChange();
    onChange?.();
    await vi.advanceTimersByTimeAsync(150);

    expect(getCheckoutDiff).toHaveBeenCalledTimes(2);
    const watchFiredCall = getCheckoutDiff.mock.calls[1];
    expect(watchFiredCall[2]).toEqual({
      force: true,
      reason: expect.stringContaining("working-tree"),
    });
  });

  test("an edit during an in-flight diff refresh produces one final follow-up", async () => {
    const inFlightDiff = createDeferred<{
      diff: string;
      structured: Array<{
        path: string;
        additions: number;
        deletions: number;
        status: "modified";
      }>;
    }>();
    const getCheckoutDiff = vi
      .fn()
      .mockResolvedValueOnce({
        diff: "",
        structured: [{ path: "tracked.ts", additions: 1, deletions: 0, status: "modified" }],
      })
      .mockImplementationOnce(() => inFlightDiff.promise)
      .mockResolvedValue({
        diff: "",
        structured: [{ path: "tracked.ts", additions: 100, deletions: 25, status: "modified" }],
      });
    const { manager, getOnChange } = createManager({
      getCheckoutDiffImplementation: getCheckoutDiff,
    });
    const listener = vi.fn();

    await manager.subscribe({ cwd: "/tmp/repo", compare: { mode: "uncommitted" } }, listener);
    getOnChange()?.();
    await vi.advanceTimersByTimeAsync(150);
    expect(getCheckoutDiff).toHaveBeenCalledTimes(2);

    for (let event = 0; event < 100; event += 1) {
      getOnChange()?.();
    }
    await vi.advanceTimersByTimeAsync(150);
    expect(getCheckoutDiff).toHaveBeenCalledTimes(2);

    inFlightDiff.resolve({
      diff: "",
      structured: [{ path: "tracked.ts", additions: 2, deletions: 1, status: "modified" }],
    });
    await vi.waitFor(() => {
      expect(getCheckoutDiff).toHaveBeenCalledTimes(3);
      expect(listener).toHaveBeenLastCalledWith({
        cwd: "/tmp/repo",
        files: [{ path: "tracked.ts", additions: 100, deletions: 25, status: "modified" }],
        error: null,
      });
    });
  });

  test("base diff subscriptions ignore ordinary working tree edits", async () => {
    const getCheckoutDiff = vi.fn(async () => ({
      diff: "",
      structured: [{ path: "committed.ts", additions: 1, deletions: 0, status: "modified" }],
    }));
    const { manager, getOnChange, mockRequestWorkingTreeWatch } = createManager({
      getCheckoutDiffImplementation: getCheckoutDiff,
    });

    await manager.subscribe(
      { cwd: "/tmp/repo", compare: { mode: "base", baseRef: "main" } },
      vi.fn(),
    );
    getOnChange()?.();
    await vi.advanceTimersByTimeAsync(150);

    expect(getCheckoutDiff).toHaveBeenCalledTimes(1);
    expect(mockRequestWorkingTreeWatch).not.toHaveBeenCalled();
  });

  test("base diff subscriptions ignore worktree-only workspace snapshot updates", async () => {
    const getCheckoutDiff = vi.fn(async () => ({ diff: "", structured: [] }));
    const { manager, getOnWorkspaceSnapshot } = createManager({
      getCheckoutDiffImplementation: getCheckoutDiff,
    });

    await manager.subscribe(
      { cwd: "/tmp/repo", compare: { mode: "base", baseRef: "main" } },
      vi.fn(),
    );

    getOnWorkspaceSnapshot()?.(
      createWorkspaceSnapshot({
        isDirty: true,
        diffStat: { additions: 5, deletions: 2 },
      }),
    );
    await vi.advanceTimersByTimeAsync(150);

    expect(getCheckoutDiff).toHaveBeenCalledTimes(1);
  });

  test("base diff subscriptions refresh for structural workspace changes", async () => {
    const getCheckoutDiff = vi.fn(async () => ({ diff: "", structured: [] }));
    const { manager, getOnWorkspaceSnapshot, workspaceGitService } = createManager({
      getCheckoutDiffImplementation: getCheckoutDiff,
    });

    await manager.subscribe(
      { cwd: "/tmp/repo", compare: { mode: "base", baseRef: "main" } },
      vi.fn(),
    );

    expect(workspaceGitService.registerWorkspace).toHaveBeenCalledTimes(1);
    getOnWorkspaceSnapshot()?.(
      createWorkspaceSnapshot({
        currentBranch: "feature-2",
        isDirty: true,
        diffStat: { additions: 5, deletions: 2 },
      }),
    );
    await vi.advanceTimersByTimeAsync(150);
    expect(getCheckoutDiff).toHaveBeenCalledTimes(2);
    expect(getCheckoutDiff.mock.calls[1]?.[2]).toBeUndefined();

    getOnWorkspaceSnapshot()?.(createWorkspaceSnapshot({ aheadBehind: { ahead: 2, behind: 0 } }));
    await vi.advanceTimersByTimeAsync(150);
    expect(getCheckoutDiff).toHaveBeenCalledTimes(3);
  });

  test("falls back to cwd when the working tree watch returns no repo root", async () => {
    const { manager, workspaceGitService } = createManager({ repoRoot: null });

    await manager.subscribe(
      {
        cwd: "/tmp/plain",
        compare: { mode: "uncommitted" },
      },
      () => {},
    );

    expect(workspaceGitService.getCheckoutDiff).toHaveBeenCalledWith(
      "/tmp/plain",
      expect.objectContaining({ mode: "uncommitted", includeStructured: true }),
      undefined,
    );
  });
});
