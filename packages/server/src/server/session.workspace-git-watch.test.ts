import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { watchCalls, watchMock } = vi.hoisted(() => {
  const hoistedWatchCalls: Array<{
    path: string;
    listener: () => void;
    close: ReturnType<typeof vi.fn>;
  }> = [];

  const hoistedWatchMock = vi.fn(
    (watchPath: string, _options: { recursive: boolean }, listener: () => void) => {
      const close = vi.fn();
      const watcher = {
        close,
        on: vi.fn().mockReturnThis(),
      };
      hoistedWatchCalls.push({
        path: watchPath,
        listener,
        close,
      });
      return watcher as any;
    },
  );

  return {
    watchCalls: hoistedWatchCalls,
    watchMock: hoistedWatchMock,
  };
});

const resolveCheckoutGitDirMock = vi.hoisted(() => vi.fn(async () => null));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    watch: watchMock,
  };
});

vi.mock("./checkout-git-utils.js", () => ({
  READ_ONLY_GIT_ENV: {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
  },
  resolveCheckoutGitDir: resolveCheckoutGitDirMock,
  toCheckoutError: vi.fn((error: unknown) => ({
    message: error instanceof Error ? error.message : String(error),
  })),
}));

import { Session } from "./session.js";

function createSessionForWorkspaceGitWatchTests(): {
  session: Session;
  emitted: Array<{ type: string; payload: unknown }>;
  backgroundGitFetchManager: {
    subscribe: ReturnType<typeof vi.fn>;
    subscriptions: Array<{
      params: { repoGitRoot: string; cwd: string };
      listener: () => void;
      unsubscribe: ReturnType<typeof vi.fn>;
    }>;
  };
  logger: {
    child: () => unknown;
    trace: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
} {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const projects = new Map<string, any>();
  const workspaces = new Map<string, any>();
  const backgroundGitFetchSubscriptions: Array<{
    params: { repoGitRoot: string; cwd: string };
    listener: () => void;
    unsubscribe: ReturnType<typeof vi.fn>;
  }> = [];
  const logger = {
    child: () => logger,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const backgroundGitFetchManager = {
    subscribe: vi.fn(async (params: { repoGitRoot: string; cwd: string }, listener: () => void) => {
      const unsubscribe = vi.fn();
      backgroundGitFetchSubscriptions.push({
        params,
        listener,
        unsubscribe,
      });
      return { unsubscribe };
    }),
  };

  const session = new Session({
    clientId: "test-client",
    onMessage: (message) => emitted.push(message as any),
    logger: logger as any,
    downloadTokenStore: {} as any,
    pushTokenStore: {} as any,
    paseoHome: "/tmp/paseo-test",
    agentManager: {
      subscribe: () => () => {},
      listAgents: () => [],
      getAgent: () => null,
    } as any,
    agentStorage: {
      list: async () => [],
      get: async () => null,
    } as any,
    projectRegistry: {
      initialize: async () => {},
      existsOnDisk: async () => true,
      list: async () => Array.from(projects.values()),
      get: async (projectId: string) => projects.get(projectId) ?? null,
      upsert: async (record: any) => {
        projects.set(record.projectId, record);
      },
      archive: async (projectId: string, archivedAt: string) => {
        const existing = projects.get(projectId);
        if (!existing) {
          return;
        }
        projects.set(projectId, {
          ...existing,
          archivedAt,
          updatedAt: archivedAt,
        });
      },
      remove: async (projectId: string) => {
        projects.delete(projectId);
      },
    } as any,
    workspaceRegistry: {
      initialize: async () => {},
      existsOnDisk: async () => true,
      list: async () => Array.from(workspaces.values()),
      get: async (workspaceId: string) => workspaces.get(workspaceId) ?? null,
      upsert: async (record: any) => {
        workspaces.set(record.workspaceId, record);
      },
      archive: async (workspaceId: string, archivedAt: string) => {
        const existing = workspaces.get(workspaceId);
        if (!existing) {
          return;
        }
        workspaces.set(workspaceId, {
          ...existing,
          archivedAt,
          updatedAt: archivedAt,
        });
      },
      remove: async (workspaceId: string) => {
        workspaces.delete(workspaceId);
      },
    } as any,
    checkoutDiffManager: {
      subscribe: async () => ({
        initial: { cwd: "/tmp", files: [], error: null },
        unsubscribe: () => {},
      }),
      scheduleRefreshForCwd: () => {},
      getMetrics: () => ({
        checkoutDiffTargetCount: 0,
        checkoutDiffSubscriptionCount: 0,
        checkoutDiffWatcherCount: 0,
        checkoutDiffFallbackRefreshTargetCount: 0,
      }),
      dispose: () => {},
    } as any,
    backgroundGitFetchManager: backgroundGitFetchManager as any,
    mcpBaseUrl: null,
    stt: null,
    tts: null,
    terminalManager: null,
  }) as any;

  session.listAgentPayloads = async () => [];

  return {
    session,
    emitted,
    backgroundGitFetchManager: {
      subscribe: backgroundGitFetchManager.subscribe,
      subscriptions: backgroundGitFetchSubscriptions,
    },
    logger,
  };
}

describe("workspace git watch targets", () => {
  beforeEach(() => {
    watchCalls.length = 0;
    watchMock.mockClear();
    resolveCheckoutGitDirMock.mockReset();
    resolveCheckoutGitDirMock.mockResolvedValue(null);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("debounces watcher events and skips unchanged branch/diff snapshots", async () => {
    const { session, emitted } = createSessionForWorkspaceGitWatchTests();
    const sessionAny = session as any;

    sessionAny.buildProjectPlacement = async (cwd: string) => ({
      projectKey: cwd,
      projectName: "repo",
      checkout: {
        cwd,
        isGit: true,
        currentBranch: "main",
        remoteUrl: "https://github.com/acme/repo.git",
        worktreeRoot: cwd,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    });
    resolveCheckoutGitDirMock.mockResolvedValue("/tmp/repo/.git");
    sessionAny.workspaceUpdatesSubscription = {
      subscriptionId: "sub-1",
      filter: undefined,
      isBootstrapping: false,
      pendingUpdatesByWorkspaceId: new Map(),
    };
    sessionAny.reconcileActiveWorkspaceRecords = async () => new Set();

    let descriptor = {
      id: "/tmp/repo",
      projectId: "/tmp/repo",
      projectDisplayName: "repo",
      projectRootPath: "/tmp/repo",
      projectKind: "git",
      workspaceKind: "local_checkout",
      name: "main",
      status: "done",
      activityAt: null,
      diffStat: { additions: 1, deletions: 0 },
    };

    sessionAny.buildWorkspaceDescriptorMap = async () => new Map([[descriptor.id, descriptor]]);

    await sessionAny.ensureWorkspaceRegistered("/tmp/repo");
    sessionAny.primeWorkspaceGitWatchFingerprints([descriptor]);

    expect(watchCalls.map((entry) => entry.path).sort()).toEqual([
      "/tmp/repo/.git/HEAD",
      "/tmp/repo/.git/refs/heads",
    ]);

    watchCalls[0]!.listener();
    watchCalls[1]!.listener();
    await vi.advanceTimersByTimeAsync(500);

    expect(emitted.filter((message) => message.type === "workspace_update")).toHaveLength(0);

    descriptor = {
      ...descriptor,
      name: "renamed-branch",
    };
    watchCalls[0]!.listener();
    await vi.advanceTimersByTimeAsync(500);

    const workspaceUpdates = emitted.filter(
      (message) => message.type === "workspace_update",
    ) as any[];
    expect(workspaceUpdates).toHaveLength(1);
    expect(workspaceUpdates[0]?.payload).toMatchObject({
      kind: "upsert",
      workspace: {
        id: "/tmp/repo",
        name: "renamed-branch",
        diffStat: { additions: 1, deletions: 0 },
      },
    });

    descriptor = {
      ...descriptor,
      diffStat: { additions: 3, deletions: 1 },
    };
    watchCalls[1]!.listener();
    await vi.advanceTimersByTimeAsync(500);

    expect(emitted.filter((message) => message.type === "workspace_update")).toHaveLength(2);

    await session.cleanup();
  });

  test("closes watchers when a workspace is archived and when the session closes", async () => {
    const { session } = createSessionForWorkspaceGitWatchTests();
    const sessionAny = session as any;

    sessionAny.buildProjectPlacement = async (cwd: string) => ({
      projectKey: cwd,
      projectName: path.basename(cwd),
      checkout: {
        cwd,
        isGit: true,
        currentBranch: "main",
        remoteUrl: "https://github.com/acme/repo.git",
        worktreeRoot: cwd,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    });

    resolveCheckoutGitDirMock.mockImplementation(async (cwd: string) => path.join(cwd, ".git"));

    await sessionAny.ensureWorkspaceRegistered("/tmp/repo-one");
    expect(sessionAny.workspaceGitWatchTargets.size).toBe(1);
    expect(watchCalls).toHaveLength(2);

    await sessionAny.archiveWorkspaceRecord("/tmp/repo-one", "2026-03-21T00:00:00.000Z");

    expect(sessionAny.workspaceGitWatchTargets.size).toBe(0);
    expect(watchCalls.every((entry) => entry.close.mock.calls.length === 1)).toBe(true);

    watchCalls.length = 0;
    watchMock.mockClear();

    await sessionAny.ensureWorkspaceRegistered("/tmp/repo-two");
    expect(sessionAny.workspaceGitWatchTargets.size).toBe(1);
    expect(watchCalls).toHaveLength(2);

    await session.cleanup();

    expect(sessionAny.workspaceGitWatchTargets.size).toBe(0);
    expect(watchCalls.every((entry) => entry.close.mock.calls.length === 1)).toBe(true);
  });

  test("resolves refs from the shared git dir for linked worktrees", async () => {
    const { session } = createSessionForWorkspaceGitWatchTests();
    const sessionAny = session as any;
    const tempDir = mkdtempSync(path.join(tmpdir(), "session-workspace-git-watch-"));
    const gitDir = path.join(tempDir, "repo", ".git", "worktrees", "feature");

    mkdirSync(gitDir, { recursive: true });
    writeFileSync(path.join(gitDir, "commondir"), "../..\n");

    try {
      expect(await sessionAny.resolveWorkspaceGitRefsRoot(gitDir)).toBe(
        path.join(tempDir, "repo", ".git"),
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      await session.cleanup();
    }
  });

  test("subscribes to the background fetch manager when a git watch target is created", async () => {
    const { session, backgroundGitFetchManager } = createSessionForWorkspaceGitWatchTests();
    const sessionAny = session as any;

    sessionAny.buildProjectPlacement = async (cwd: string) => ({
      projectKey: cwd,
      projectName: path.basename(cwd),
      checkout: {
        cwd,
        isGit: true,
        currentBranch: "main",
        remoteUrl: "https://github.com/acme/repo.git",
        worktreeRoot: cwd,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    });
    resolveCheckoutGitDirMock.mockResolvedValue("/tmp/repo/.git");

    await sessionAny.ensureWorkspaceRegistered("/tmp/repo");

    expect(backgroundGitFetchManager.subscribe).toHaveBeenCalledWith(
      { repoGitRoot: "/tmp/repo/.git", cwd: "/tmp/repo" },
      expect.any(Function),
    );
    expect(sessionAny.workspaceGitFetchSubscriptions.size).toBe(1);

    await session.cleanup();
  });

  test("stores separate background fetch subscriptions per workspace and unsubscribes removed targets", async () => {
    const { session, backgroundGitFetchManager } = createSessionForWorkspaceGitWatchTests();
    const sessionAny = session as any;

    sessionAny.buildProjectPlacement = async (cwd: string) => ({
      projectKey: cwd,
      projectName: path.basename(cwd),
      checkout: {
        cwd,
        isGit: true,
        currentBranch: "main",
        remoteUrl: "https://github.com/acme/repo.git",
        worktreeRoot: cwd,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    });
    resolveCheckoutGitDirMock.mockImplementation(async (cwd: string) =>
      cwd === "/tmp/repo" ? "/tmp/repo/.git" : "/tmp/repo/.git/worktrees/feature",
    );
    sessionAny.resolveWorkspaceGitRefsRoot = vi.fn(async () => "/tmp/repo/.git");

    await sessionAny.ensureWorkspaceRegistered("/tmp/repo");
    await sessionAny.ensureWorkspaceRegistered("/tmp/repo-feature");

    expect(backgroundGitFetchManager.subscribe).toHaveBeenCalledTimes(2);
    expect(backgroundGitFetchManager.subscriptions[0]?.params).toEqual({
      repoGitRoot: "/tmp/repo/.git",
      cwd: "/tmp/repo",
    });
    expect(backgroundGitFetchManager.subscriptions[1]?.params).toEqual({
      repoGitRoot: "/tmp/repo/.git",
      cwd: "/tmp/repo-feature",
    });

    sessionAny.removeWorkspaceGitWatchTarget("/tmp/repo");

    expect(backgroundGitFetchManager.subscriptions[0]?.unsubscribe).toHaveBeenCalledTimes(1);
    expect(backgroundGitFetchManager.subscriptions[1]?.unsubscribe).not.toHaveBeenCalled();
    expect(sessionAny.workspaceGitFetchSubscriptions.size).toBe(1);

    await session.cleanup();
  });

  test("refreshes the workspace when the background fetch manager callback fires and unsubscribes on cleanup", async () => {
    const { session, emitted, backgroundGitFetchManager } =
      createSessionForWorkspaceGitWatchTests();
    const sessionAny = session as any;

    sessionAny.buildProjectPlacement = async (cwd: string) => ({
      projectKey: cwd,
      projectName: path.basename(cwd),
      checkout: {
        cwd,
        isGit: true,
        currentBranch: "main",
        remoteUrl: "https://github.com/acme/repo.git",
        worktreeRoot: cwd,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    });
    resolveCheckoutGitDirMock.mockResolvedValue("/tmp/repo/.git");
    sessionAny.workspaceUpdatesSubscription = {
      subscriptionId: "sub-1",
      filter: undefined,
      isBootstrapping: false,
      pendingUpdatesByWorkspaceId: new Map(),
    };
    sessionAny.reconcileActiveWorkspaceRecords = async () => new Set();

    let descriptor = {
      id: "/tmp/repo",
      projectId: "/tmp/repo",
      projectDisplayName: "repo",
      projectRootPath: "/tmp/repo",
      projectKind: "git",
      workspaceKind: "local_checkout",
      name: "main",
      status: "done",
      activityAt: null,
      diffStat: { additions: 1, deletions: 0 },
    };

    sessionAny.buildWorkspaceDescriptorMap = async () => new Map([[descriptor.id, descriptor]]);

    await sessionAny.ensureWorkspaceRegistered("/tmp/repo");
    sessionAny.primeWorkspaceGitWatchFingerprints([descriptor]);

    descriptor = {
      ...descriptor,
      name: "updated-after-fetch",
    };

    backgroundGitFetchManager.subscriptions[0]?.listener();
    await vi.advanceTimersByTimeAsync(500);

    const workspaceUpdates = emitted.filter(
      (message) => message.type === "workspace_update",
    ) as any[];
    expect(workspaceUpdates).toHaveLength(1);
    expect(workspaceUpdates[0]?.payload).toMatchObject({
      kind: "upsert",
      workspace: {
        id: "/tmp/repo",
        name: "updated-after-fetch",
      },
    });

    await session.cleanup();

    expect(backgroundGitFetchManager.subscriptions[0]?.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
