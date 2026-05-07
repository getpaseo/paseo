import { describe, expect, test, vi } from "vitest";
import path from "node:path";
import type pino from "pino";
import { Session, type SessionOptions } from "./session.js";
import { asInternals, createStub } from "./test-utils/class-mocks.js";
import type {
  WorkspaceGitListener,
  WorkspaceGitRuntimeSnapshot,
  WorkspaceGitService,
} from "./workspace-git-service.js";
import type { SessionOutboundMessage } from "./messages.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
} from "./workspace-registry.js";
import { createNoopWorkspaceGitService } from "./test-utils/workspace-git-service-stub.js";

interface SessionInternals {
  workspaceUpdatesSubscription: {
    subscriptionId: string;
    filter: undefined;
    isBootstrapping: boolean;
    pendingUpdatesByWorkspaceId: Map<string, unknown>;
    lastEmittedByWorkspaceId: Map<string, unknown>;
  };
  buildWorkspaceDescriptorMap: () => Promise<Map<string, unknown>>;
  syncWorkspaceGitObserver(cwd: string, details: { isGit: boolean }): void;
  listAgentPayloads: () => Promise<unknown[]>;
}

type CheckoutStatusUpdatePayload = Extract<
  SessionOutboundMessage,
  { type: "checkout_status_update" }
>["payload"];
type WorkspaceUpdatePayload = Extract<
  SessionOutboundMessage,
  { type: "workspace_update" }
>["payload"];

const REPO_CWD = path.resolve("/tmp/repo");
const REPO_SUBSCRIPTION_REQUEST_ID = `subscription:${REPO_CWD}`;

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
      baseRef: "main",
      aheadBehind: { ahead: 0, behind: 0 },
      aheadOfOrigin: 0,
      behindOfOrigin: 0,
      hasRemote: true,
      diffStat: { additions: 1, deletions: 0 },
    },
    github: {
      featuresEnabled: true,
      pullRequest: null,
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

function createSessionForWorkspaceGitWatchTests(): {
  session: Session;
  emitted: Array<{ type: string; payload: unknown }>;
  projects: Map<string, ReturnType<typeof createPersistedProjectRecord>>;
  workspaces: Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>;
  workspaceGitService: WorkspaceGitService & {
    registerWorkspace: ReturnType<typeof vi.fn>;
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
    ...createNoopWorkspaceGitService(),
    registerWorkspace: vi.fn((params: { cwd: string }, listener: WorkspaceGitListener) => {
      const unsubscribe = vi.fn();
      subscriptions.push({
        params,
        listener,
        unsubscribe,
      });
      return {
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
    onMessage: (message) => emitted.push(message as { type: string; payload: unknown }),
    logger: createStub<pino.Logger>(logger),
    downloadTokenStore: createStub<SessionOptions["downloadTokenStore"]>({}),
    pushTokenStore: createStub<SessionOptions["pushTokenStore"]>({}),
    paseoHome: "/tmp/paseo-test",
    agentManager: createStub<SessionOptions["agentManager"]>({
      subscribe: () => () => {},
      listAgents: () => [],
      getAgent: () => null,
    }),
    agentStorage: createStub<SessionOptions["agentStorage"]>({
      list: async () => [],
      get: async () => null,
    }),
    projectRegistry: createStub<SessionOptions["projectRegistry"]>({
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
    }),
    workspaceRegistry: createStub<SessionOptions["workspaceRegistry"]>({
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
    }),
    checkoutDiffManager: createStub<SessionOptions["checkoutDiffManager"]>({
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
    }),
    workspaceGitService,
    mcpBaseUrl: null,
    stt: null,
    tts: null,
    terminalManager: null,
  });

  asInternals<SessionInternals>(session).listAgentPayloads = async () => [];

  return {
    session,
    emitted,
    projects,
    workspaces,
    workspaceGitService,
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
      rootPath: input.cwd,
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
    const sessionAny = asInternals<SessionInternals>(session);
    seedGitWorkspace({
      projects,
      workspaces,
      projectId: "proj-1",
      workspaceId: "ws-10",
      cwd: REPO_CWD,
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
      projectRootPath: REPO_CWD,
      projectKind: "git",
      workspaceKind: "local_checkout",
      name: "main",
      status: "done",
      activityAt: null,
      diffStat: { additions: 1, deletions: 0 },
      workspaceDirectory: REPO_CWD,
    };

    sessionAny.buildWorkspaceDescriptorMap = async () => new Map([[descriptor.id, descriptor]]);

    sessionAny.syncWorkspaceGitObserver(REPO_CWD, { isGit: true });

    expect(workspaceGitService.registerWorkspace).toHaveBeenCalledWith(
      { cwd: REPO_CWD },
      expect.any(Function),
    );

    descriptor = {
      ...descriptor,
      name: "renamed-branch",
    };

    subscriptions[0]?.listener(
      createWorkspaceRuntimeSnapshot(REPO_CWD, {
        git: {
          currentBranch: "renamed-branch",
        },
      }),
    );

    await Promise.resolve();
    await Promise.resolve();

    const workspaceUpdates = emitted.filter(
      (message) => message.type === "workspace_update",
    ) as Array<{ type: "workspace_update"; payload: WorkspaceUpdatePayload }>;
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

  test("emits checkout_status_update to a client subscribed to the workspace git target", async () => {
    const { session, emitted, projects, workspaces, workspaceGitService, subscriptions } =
      createSessionForWorkspaceGitWatchTests();
    const sessionAny = asInternals<SessionInternals>(session);
    seedGitWorkspace({
      projects,
      workspaces,
      projectId: "proj-1",
      workspaceId: "ws-10",
      cwd: REPO_CWD,
      name: "main",
    });
    sessionAny.workspaceUpdatesSubscription = {
      subscriptionId: "sub-1",
      filter: undefined,
      isBootstrapping: false,
      pendingUpdatesByWorkspaceId: new Map(),
      lastEmittedByWorkspaceId: new Map(),
    };

    sessionAny.syncWorkspaceGitObserver(REPO_CWD, { isGit: true });
    emitted.length = 0;

    subscriptions[0]?.listener(
      createWorkspaceRuntimeSnapshot(REPO_CWD, {
        git: {
          currentBranch: "feature/server-push",
          isDirty: true,
          aheadBehind: { ahead: 3, behind: 1 },
          aheadOfOrigin: 3,
          behindOfOrigin: 1,
        },
      }),
    );

    const statusUpdates = emitted.filter(
      (message) => message.type === "checkout_status_update",
    ) as Array<{ type: "checkout_status_update"; payload: CheckoutStatusUpdatePayload }>;
    expect(statusUpdates).toHaveLength(1);
    expect(statusUpdates[0]?.payload).toMatchObject({
      cwd: REPO_CWD,
      isGit: true,
      repoRoot: REPO_CWD,
      currentBranch: "feature/server-push",
      isDirty: true,
      baseRef: "main",
      aheadBehind: { ahead: 3, behind: 1 },
      aheadOfOrigin: 3,
      behindOfOrigin: 1,
      hasRemote: true,
      remoteUrl: "https://github.com/acme/repo.git",
      isPaseoOwnedWorktree: false,
      error: null,
      requestId: REPO_SUBSCRIPTION_REQUEST_ID,
    });
    expect(workspaceGitService.registerWorkspace).toHaveBeenCalledWith(
      { cwd: REPO_CWD },
      expect.any(Function),
    );

    await session.cleanup();
  });

  test("embeds PR status in checkout_status_update for GitHub-inclusive snapshot pushes", async () => {
    const { session, emitted, projects, workspaces, subscriptions } =
      createSessionForWorkspaceGitWatchTests();
    const sessionAny = asInternals<SessionInternals>(session);
    seedGitWorkspace({
      projects,
      workspaces,
      projectId: "proj-1",
      workspaceId: "ws-10",
      cwd: REPO_CWD,
      name: "main",
    });
    sessionAny.workspaceUpdatesSubscription = {
      subscriptionId: "sub-1",
      filter: undefined,
      isBootstrapping: false,
      pendingUpdatesByWorkspaceId: new Map(),
      lastEmittedByWorkspaceId: new Map(),
    };

    sessionAny.syncWorkspaceGitObserver(REPO_CWD, { isGit: true });
    emitted.length = 0;

    subscriptions[0]?.listener(
      createWorkspaceRuntimeSnapshot(REPO_CWD, {
        github: {
          featuresEnabled: true,
          pullRequest: {
            number: 456,
            url: "https://github.com/acme/repo/pull/456",
            title: "Runtime centralization",
            state: "open",
            baseRefName: "main",
            headRefName: "workspace-git-service",
            isMerged: false,
            checks: [
              {
                name: "test",
                status: "success",
                url: "https://github.com/acme/repo/actions/runs/1",
              },
            ],
            checksStatus: "success",
            reviewDecision: "approved",
          },
          error: null,
        },
      }),
    );

    const statusUpdate = emitted.find((message) => message.type === "checkout_status_update") as
      | { payload: CheckoutStatusUpdatePayload }
      | undefined;
    expect(statusUpdate?.payload.prStatus).toEqual({
      cwd: REPO_CWD,
      status: {
        number: 456,
        url: "https://github.com/acme/repo/pull/456",
        title: "Runtime centralization",
        state: "open",
        repoOwner: undefined,
        repoName: undefined,
        baseRefName: "main",
        headRefName: "workspace-git-service",
        isMerged: false,
        isDraft: false,
        checks: [
          {
            name: "test",
            status: "success",
            url: "https://github.com/acme/repo/actions/runs/1",
          },
        ],
        checksStatus: "success",
        reviewDecision: "approved",
      },
      githubFeaturesEnabled: true,
      error: null,
      requestId: REPO_SUBSCRIPTION_REQUEST_ID,
    });

    await session.cleanup();
  });

  test("checkout_pr_status_request reads pull request status from the workspace git service snapshot", async () => {
    const { session, emitted, workspaceGitService } = createSessionForWorkspaceGitWatchTests();

    workspaceGitService.getSnapshot.mockResolvedValue(
      createWorkspaceRuntimeSnapshot(REPO_CWD, {
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
        },
      }),
    );

    await session.handleMessage({
      type: "checkout_pr_status_request",
      cwd: REPO_CWD,
      requestId: "req-pr-status",
    });

    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith(REPO_CWD);
    expect(
      emitted.find((message) => message.type === "checkout_pr_status_response")?.payload,
    ).toEqual({
      cwd: REPO_CWD,
      status: {
        number: undefined,
        url: "https://github.com/acme/repo/pull/456",
        title: "Runtime centralization",
        state: "merged",
        repoOwner: undefined,
        repoName: undefined,
        baseRefName: "main",
        headRefName: "workspace-git-service",
        isMerged: true,
        isDraft: false,
        checks: [],
        checksStatus: undefined,
        reviewDecision: undefined,
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
      cwd: REPO_CWD,
      requestId: "req-pr-cached",
    });

    expect(workspaceGitService.refresh).not.toHaveBeenCalled();
    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith(REPO_CWD);
    expect(emitted.find((message) => message.type === "checkout_pr_status_response")).toBeDefined();
  });
});
