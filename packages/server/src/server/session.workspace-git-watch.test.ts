import { describe, expect, test, vi } from "vitest";
import { Session } from "./session.js";
import type {
  WorkspaceGitListener,
  WorkspaceGitRuntimeSnapshot,
  WorkspaceGitService,
} from "./workspace-git-service.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
} from "./workspace-registry.js";

function createWorkspaceRuntimeSnapshot(
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
      aheadBehind: { ahead: 0, behind: 0 },
      aheadOfOrigin: 0,
      behindOfOrigin: 0,
      diffStat: { additions: 1, deletions: 0 },
    },
    github: {
      featuresEnabled: true,
      pullRequest: null,
      error: null,
      refreshedAt: "2026-04-12T00:00:00.000Z",
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

function createSessionForWorkspaceGitWatchTests(): {
  session: Session;
  emitted: Array<{ type: string; payload: unknown }>;
  projects: Map<string, ReturnType<typeof createPersistedProjectRecord>>;
  workspaces: Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>;
  workspaceGitService: WorkspaceGitService & {
    subscribe: ReturnType<typeof vi.fn>;
    peekSnapshot: ReturnType<typeof vi.fn>;
    getSnapshot: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
    requestWorkingTreeWatch: ReturnType<typeof vi.fn>;
    scheduleRefreshForCwd: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  };
  subscriptions: Array<{
    params: { cwd: string };
    listener: WorkspaceGitListener;
    unsubscribe: ReturnType<typeof vi.fn>;
  }>;
} {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const projects = new Map<string, ReturnType<typeof createPersistedProjectRecord>>();
  const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>();
  const subscriptions: Array<{
    params: { cwd: string };
    listener: WorkspaceGitListener;
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
  const workspaceGitService = {
    subscribe: vi.fn(async (params: { cwd: string }, listener: WorkspaceGitListener) => {
      const unsubscribe = vi.fn();
      subscriptions.push({
        params,
        listener,
        unsubscribe,
      });
      return {
        initial: createWorkspaceRuntimeSnapshot(params.cwd),
        unsubscribe,
      };
    }),
    peekSnapshot: vi.fn((cwd: string) => createWorkspaceRuntimeSnapshot(cwd)),
    getSnapshot: vi.fn(async (cwd: string) => createWorkspaceRuntimeSnapshot(cwd)),
    refresh: vi.fn(async () => {}),
    requestWorkingTreeWatch: vi.fn(async (cwd: string) => ({
      repoRoot: cwd,
      unsubscribe: vi.fn(),
    })),
    scheduleRefreshForCwd: vi.fn(),
    dispose: vi.fn(),
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
      upsert: async (record: ReturnType<typeof createPersistedProjectRecord>) => {
        projects.set(record.projectId, record);
      },
      archive: async (projectId: string, archivedAt: string) => {
        const existing = projects.get(projectId);
        if (!existing) return;
        projects.set(projectId, { ...existing, archivedAt, updatedAt: archivedAt });
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
      upsert: async (record: ReturnType<typeof createPersistedWorkspaceRecord>) => {
        workspaces.set(record.workspaceId, record);
      },
      archive: async (workspaceId: string, archivedAt: string) => {
        const existing = workspaces.get(workspaceId);
        if (!existing) return;
        workspaces.set(workspaceId, { ...existing, archivedAt, updatedAt: archivedAt });
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
    workspaceGitService: workspaceGitService as any,
    mcpBaseUrl: null,
    stt: null,
    tts: null,
    terminalManager: null,
  }) as any;

  (session as any).listAgentPayloads = async () => [];

  return {
    session,
    emitted,
    projects,
    workspaces,
    workspaceGitService: workspaceGitService as any,
    subscriptions,
  };
}

function seedGitWorkspace(input: {
  projects: Map<string, ReturnType<typeof createPersistedProjectRecord>>;
  workspaces: Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>;
  projectId: string;
  workspaceId: string;
  cwd: string;
  name: string;
}) {
  input.projects.set(
    input.projectId,
    createPersistedProjectRecord({
      projectId: input.projectId,
      rootPath: "/tmp/repo",
      displayName: "repo",
      kind: "git",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
    }),
  );
  input.workspaces.set(
    input.workspaceId,
    createPersistedWorkspaceRecord({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      cwd: input.cwd,
      displayName: input.name,
      kind: "local_checkout",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
    }),
  );
}

describe("workspace git watch targets", () => {
  test("emits one workspace_update when the workspace git service emits a changed snapshot", async () => {
    const { session, emitted, projects, workspaces, workspaceGitService, subscriptions } =
      createSessionForWorkspaceGitWatchTests();
    const sessionAny = session as any;
    seedGitWorkspace({
      projects,
      workspaces,
      projectId: "proj-1",
      workspaceId: "ws-10",
      cwd: "/tmp/repo",
      name: "main",
    });
    sessionAny.workspaceUpdatesSubscription = {
      subscriptionId: "sub-1",
      filter: undefined,
      isBootstrapping: false,
      pendingUpdatesByWorkspaceId: new Map(),
      lastEmittedByWorkspaceId: new Map(),
    };

    let descriptor = {
      id: "ws-10",
      projectId: "proj-1",
      projectDisplayName: "repo",
      projectRootPath: "/tmp/repo",
      projectKind: "git",
      workspaceKind: "local_checkout",
      name: "main",
      status: "done",
      activityAt: null,
      diffStat: { additions: 1, deletions: 0 },
      workspaceDirectory: "/tmp/repo",
    };

    sessionAny.buildWorkspaceDescriptorMap = async () => new Map([[descriptor.id, descriptor]]);

    await sessionAny.syncWorkspaceGitWatchTarget("/tmp/repo", { isGit: true });

    expect(workspaceGitService.subscribe).toHaveBeenCalledWith(
      { cwd: "/tmp/repo" },
      expect.any(Function),
    );

    descriptor = {
      ...descriptor,
      name: "renamed-branch",
    };

    subscriptions[0]?.listener(
      createWorkspaceRuntimeSnapshot("/tmp/repo", {
        git: {
          currentBranch: "renamed-branch",
        },
      }),
    );

    await Promise.resolve();
    await Promise.resolve();

    const workspaceUpdates = emitted.filter(
      (message) => message.type === "workspace_update",
    ) as any[];
    expect(workspaceUpdates).toHaveLength(1);
    expect(workspaceUpdates[0]?.payload).toMatchObject({
      kind: "upsert",
      workspace: {
        id: "ws-10",
        name: "renamed-branch",
        diffStat: { additions: 1, deletions: 0 },
      },
    });

    await session.cleanup();
  });

  test("checkout_pr_status_request reads pull request status from the workspace git service snapshot", async () => {
    const { session, emitted, workspaceGitService } = createSessionForWorkspaceGitWatchTests();

    workspaceGitService.getSnapshot.mockResolvedValue(
      createWorkspaceRuntimeSnapshot("/tmp/repo", {
        github: {
          featuresEnabled: true,
          pullRequest: {
            url: "https://github.com/acme/repo/pull/456",
            title: "Runtime centralization",
            state: "merged",
            baseRefName: "main",
            headRefName: "workspace-git-service",
            isMerged: true,
          },
          refreshedAt: "2026-04-12T00:05:00.000Z",
        },
      }),
    );

    await session.handleMessage({
      type: "checkout_pr_status_request",
      cwd: "/tmp/repo",
      requestId: "req-pr-status",
    });

    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith("/tmp/repo");
    expect(
      emitted.find((message) => message.type === "checkout_pr_status_response")?.payload,
    ).toEqual({
      cwd: "/tmp/repo",
      status: {
        url: "https://github.com/acme/repo/pull/456",
        title: "Runtime centralization",
        state: "merged",
        baseRefName: "main",
        headRefName: "workspace-git-service",
        isMerged: true,
      },
      githubFeaturesEnabled: true,
      error: null,
      requestId: "req-pr-status",
    });
  });

  test("checkout_pr_status_request reads cached snapshot without forcing a refresh", async () => {
    const { session, emitted, workspaceGitService } = createSessionForWorkspaceGitWatchTests();

    await session.handleMessage({
      type: "checkout_pr_status_request",
      cwd: "/tmp/repo",
      requestId: "req-pr-cached",
    });

    expect(workspaceGitService.refresh).not.toHaveBeenCalled();
    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith("/tmp/repo");
    expect(emitted.find((message) => message.type === "checkout_pr_status_response")).toBeDefined();
  });
});
