import { createWorkspaceRuntimeStore } from "./workspace-runtime-store/index.js";
import { createAgentMessageDeliveryStub } from "./test-utils/session-stubs.js";
import {
  createMessageReceiptsStub,
  createTestCreationService,
  asDaemonConfigStore,
  asTerminalManager,
} from "./test-utils/session-stubs.js";
import { describe, expect, test, vi } from "vitest";
import path from "node:path";
import type pino from "pino";
import { createBranchChangeRouteHandler } from "./script-route-branch-handler.js";
import { createServiceProxySubsystem, type ServiceProxySubsystem } from "./service-proxy.js";
import { Session, type SessionOptions } from "./session.js";
import { OWNER_PERMISSIONS } from "./authorization/index.js";
import { asInternals, createStub } from "./test-utils/class-mocks.js";
import { createProviderSnapshotManagerStub } from "./test-utils/session-stubs.js";
import { createTestLogger } from "../test-utils/test-logger.js";
import { WorkspaceScriptRuntimeStore } from "./workspace-script-runtime-store.js";
import type {
  WorkspaceGitListener,
  WorkspaceGitRuntimeSnapshot,
  WorkspaceGitService,
} from "./workspace-git-service.js";
import type { SessionOutboundMessage, WorkspaceDescriptorPayload } from "./messages.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
} from "./workspace-registry.js";
import { createNoopWorkspaceGitService } from "./test-utils/workspace-git-service-stub.js";
import type { WorkspaceGitObserverService } from "./session/workspace-git-observer/workspace-git-observer-service.js";
import { WORKSPACE_LIVENESS_WINDOW_MS } from "./session/workspace-git-observer/workspace-liveness.js";
import type { TerminalsChangedEvent } from "../terminal/terminal-manager.js";
import { getOpenAgentTabLabel } from "@getpaseo/protocol/agent-labels";

interface SessionInternals {
  buildWorkspaceDescriptorMap: () => Promise<Map<string, unknown>>;
  workspaceGitObserver: WorkspaceGitObserverService;
  listAgentPayloads: () => Promise<unknown[]>;
}

// The observer's single public registration entry is syncObservers(descriptors); these
// integration tests drive it with a minimal git descriptor for one workspace, then push
// snapshots through the captured WorkspaceGitService listener.
function syncGitObserver(session: Session, cwd: string, workspaceId: string): void {
  asInternals<SessionInternals>(session).workspaceGitObserver.syncObservers([
    {
      id: workspaceId,
      workspaceDirectory: cwd,
      projectKind: "git",
    } as unknown as WorkspaceDescriptorPayload,
  ]);
}

type CheckoutStatusUpdatePayload = Extract<
  SessionOutboundMessage,
  { type: "checkout_status_update" }
>["payload"];
type WorkspaceUpdatePayload = Extract<
  SessionOutboundMessage,
  { type: "workspace_update" }
>["payload"];

function getWorkspaceUpdates(
  emitted: Array<{ type: string; payload: unknown }>,
): Array<{ type: "workspace_update"; payload: WorkspaceUpdatePayload }> {
  return emitted.filter((message) => message.type === "workspace_update") as Array<{
    type: "workspace_update";
    payload: WorkspaceUpdatePayload;
  }>;
}

const REPO_CWD = path.resolve("/tmp/repo");
const REPO_SUBSCRIPTION_REQUEST_ID = `subscription:${REPO_CWD}`;

function createWorkspaceRuntimeSnapshot(
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
      forge: "github",
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
    forge: {
      ...base.forge,
      ...overrides?.forge,
      pullRequest:
        overrides?.forge && "pullRequest" in overrides.forge
          ? (overrides.forge.pullRequest ?? null)
          : base.forge.pullRequest,
      error:
        overrides?.forge && "error" in overrides.forge
          ? (overrides.forge.error ?? null)
          : base.forge.error,
    },
  };
}

function createSessionForWorkspaceGitWatchTests(options?: {
  onBranchChanged?: (
    workspaceId: string,
    oldBranch: string | null,
    newBranch: string | null,
  ) => void;
  serviceProxy?: ServiceProxySubsystem;
  scriptRuntimeStore?: WorkspaceScriptRuntimeStore;
  agents?: Array<{
    workspaceId?: string;
    lifecycle: "initializing" | "idle" | "running" | "error" | "closed";
    labels: Record<string, string>;
  }>;
  storedAgents?: Array<{
    id: string;
    workspaceId?: string;
    labels: Record<string, string>;
    archivedAt?: string | null;
  }>;
  terminalManager?: SessionOptions["terminalManager"];
  workspaceRuntimeStore?: ReturnType<typeof createWorkspaceRuntimeStore>;
  autoArchiveAfterMerge?: boolean;
}): {
  session: Session;
  emitted: Array<{ type: string; payload: unknown }>;
  projects: Map<string, ReturnType<typeof createPersistedProjectRecord>>;
  workspaces: Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>;
  workspaceGitService: WorkspaceGitService & {
    registerWorkspace: ReturnType<typeof vi.fn>;

    getSnapshot: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
    requestWorkingTreeWatch: ReturnType<typeof vi.fn>;
    scheduleRefreshForCwd: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  };
  workspaceRuntimeStore: ReturnType<typeof createWorkspaceRuntimeStore>;
  agentEventListeners: Array<(event: unknown) => void>;
  subscriptions: Array<{
    params: { cwd: string };
    listener: WorkspaceGitListener;
    unsubscribe: ReturnType<typeof vi.fn>;
  }>;
  setAutoArchiveAfterMerge: (enabled: boolean) => void;
  livenessReads: {
    listAgents: ReturnType<typeof vi.fn>;
    listActiveAgentRecords: ReturnType<typeof vi.fn>;
  };
} {
  let autoArchiveAfterMerge = options?.autoArchiveAfterMerge ?? false;
  const configListeners = new Set<(config: { autoArchiveAfterMerge: boolean }) => void>();
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
  const workspaceRuntimeStore = options?.workspaceRuntimeStore ?? createWorkspaceRuntimeStore();
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

    // Bootstrap wires the service's snapshot listener to the runtime store the descriptor reads.
    getSnapshot: vi.fn(async (cwd: string) => {
      const snapshot = createWorkspaceRuntimeSnapshot(cwd);
      workspaceRuntimeStore.set(snapshot);
      return snapshot;
    }),
    refresh: vi.fn(async () => {}),
    requestWorkingTreeWatch: vi.fn(async (cwd: string) => ({
      repoRoot: cwd,
      unsubscribe: vi.fn(),
    })),
    scheduleRefreshForCwd: vi.fn(),
    dispose: vi.fn(),
  };

  const agentEventListeners: Array<(event: unknown) => void> = [];
  const listAgents = vi.fn(() => options?.agents ?? []);
  const listActiveAgentRecords = vi.fn(async () =>
    (options?.storedAgents ?? []).filter((record) => !record.archivedAt),
  );

  const session = new Session({
    workspaceRuntimeStore,
    messageReceipts: createMessageReceiptsStub(),
    agentMessages: createAgentMessageDeliveryStub(),
    creationService: createTestCreationService(),
    clientId: "test-client",
    permissions: OWNER_PERMISSIONS,
    onMessage: (message) => emitted.push(message as { type: string; payload: unknown }),
    logger: createStub<pino.Logger>(logger),
    downloadTokenStore: createStub<SessionOptions["downloadTokenStore"]>({}),
    pushNotifications: createStub<SessionOptions["pushNotifications"]>({}),
    paseoHome: "/tmp/paseo-test",
    agentManager: createStub<SessionOptions["agentManager"]>({
      subscribe: (listener: (event: unknown) => void) => {
        agentEventListeners.push(listener);
        return () => {
          const index = agentEventListeners.indexOf(listener);
          if (index >= 0) agentEventListeners.splice(index, 1);
        };
      },
      listAgents,
      listProviderSubagentActivity: () => [],
      getAgent: () => null,
    }),
    agentStorage: createStub<SessionOptions["agentStorage"]>({
      listAll: async () => options?.storedAgents ?? [],
      listActive: listActiveAgentRecords,
      listByWorkspaces: async () => [],
      lastUserMessageAtByWorkspace: async () => new Map<string, string>(),
      get: async () => null,
    }),
    projectRegistry: createStub<SessionOptions["projectRegistry"]>({
      subscribeToMutations: () => () => {},
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
      subscribeToMutations: () => () => {},
      initialize: async () => {},
      existsOnDisk: async () => true,
      listAll: async () => Array.from(workspaces.values()),
      listActive: async () =>
        Array.from(workspaces.values()).filter((record) => !record.archivedAt),
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
      onWorkspaceStateMayHaveChanged: () => {},
      invalidateForge: () => {},
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
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
    terminalManager: options?.terminalManager ?? null,
    serviceProxy: options?.serviceProxy,
    scriptRuntimeStore: options?.scriptRuntimeStore,
    onBranchChanged: options?.onBranchChanged,
    getDaemonTcpPort: () => 6767,
    daemonConfigStore: asDaemonConfigStore({
      get: () => ({ autoArchiveAfterMerge: autoArchiveAfterMerge }),
      onChange: (listener: (config: { autoArchiveAfterMerge: boolean }) => void) => {
        configListeners.add(listener);
        return () => configListeners.delete(listener);
      },
    }),
  });

  asInternals<SessionInternals>(session).listAgentPayloads = async () => [];

  const setAutoArchiveAfterMerge = (enabled: boolean) => {
    autoArchiveAfterMerge = enabled;
    for (const listener of configListeners) listener({ autoArchiveAfterMerge: enabled });
  };

  return {
    session,
    emitted,
    projects,
    workspaces,
    workspaceGitService,
    workspaceRuntimeStore,
    agentEventListeners,
    subscriptions,
    setAutoArchiveAfterMerge,
    livenessReads: { listAgents, listActiveAgentRecords },
  };
}

function seedGitWorkspace(input: {
  projects: Map<string, ReturnType<typeof createPersistedProjectRecord>>;
  workspaces: Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>;
  projectId: string;
  workspaceId: string;
  cwd: string;
  name: string;
  updatedAt?: string;
  isPaseoOwnedWorktree?: boolean;
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
      isPaseoOwnedWorktree: input.isPaseoOwnedWorktree ?? false,
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: input.updatedAt ?? "2026-03-01T12:00:00.000Z",
    }),
  );
}

describe("workspace git watch targets", () => {
  test("emits one workspace_update when the workspace git service emits a changed snapshot", async () => {
    // A cached snapshot keeps the quiet workspace out of the one-shot fill so the count below is
    // only the update this watch emits.
    const workspaceRuntimeStore = createWorkspaceRuntimeStore();
    workspaceRuntimeStore.set(createWorkspaceRuntimeSnapshot(REPO_CWD));
    const { session, emitted, projects, workspaces, workspaceGitService, subscriptions } =
      createSessionForWorkspaceGitWatchTests({ workspaceRuntimeStore });
    const sessionAny = asInternals<SessionInternals>(session);
    seedGitWorkspace({
      projects,
      workspaces,
      projectId: "proj-1",
      workspaceId: "ws-10",
      cwd: REPO_CWD,
      name: "main",
    });
    await session.handleMessage({
      type: "fetch_workspaces_request",
      requestId: "workspace-demand",
      subscribe: {},
    });

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

    syncGitObserver(session, REPO_CWD, "ws-10");

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

    await vi.waitFor(() => expect(getWorkspaceUpdates(emitted)).toHaveLength(1));

    const workspaceUpdates = getWorkspaceUpdates(emitted);
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
    seedGitWorkspace({
      projects,
      workspaces,
      projectId: "proj-1",
      workspaceId: "ws-10",
      cwd: REPO_CWD,
      name: "main",
    });
    await session.handleMessage({
      type: "fetch_workspaces_request",
      requestId: "workspace-demand",
      subscribe: {},
    });

    syncGitObserver(session, REPO_CWD, "ws-10");
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

  test("updates running service script URLs when the git branch changes", async () => {
    const serviceProxy = createServiceProxySubsystem({ logger: createTestLogger() });
    serviceProxy.registerWorkspaceService({
      port: 4321,
      workspaceId: "ws-10",
      projectSlug: "paseo",
      branchName: "old-branch",
      scriptName: "app",
    });
    const runtimeStore = new WorkspaceScriptRuntimeStore();
    runtimeStore.set({
      workspaceId: "ws-10",
      scriptName: "app",
      type: "service",
      lifecycle: "running",
      terminalId: "term-app",
      exitCode: null,
    });

    const handleBranchChange = createBranchChangeRouteHandler({
      serviceProxy,
      onRoutesChanged: vi.fn(),
    });
    const { session, projects, workspaces, subscriptions } = createSessionForWorkspaceGitWatchTests(
      {
        serviceProxy,
        scriptRuntimeStore: runtimeStore,
        onBranchChanged: handleBranchChange,
      },
    );
    seedGitWorkspace({
      projects,
      workspaces,
      projectId: "proj-1",
      workspaceId: "ws-10",
      cwd: "/tmp/repo",
      name: "old-branch",
    });

    await session.handleMessage({
      type: "fetch_workspaces_request",
      requestId: "branch-demand",
      subscribe: {},
    });
    await session.syncWorkspaceGitObserversForExternalWorkspaceIds(["ws-10"]);

    subscriptions[0]?.listener(
      createWorkspaceRuntimeSnapshot("/tmp/repo", {
        git: {
          currentBranch: "new-branch",
        },
      }),
    );

    expect(serviceProxy.getWorkspaceHealthTargets("ws-10")).toEqual([
      expect.objectContaining({
        hostname: "app--new-branch--paseo.localhost",
        scriptName: "app",
      }),
    ]);
    await session.cleanup();
  });

  test("archiving a workspace clears its script runtime entries by opaque workspace id", async () => {
    const runtimeStore = new WorkspaceScriptRuntimeStore();
    runtimeStore.set({
      workspaceId: "ws-10",
      scriptName: "app",
      type: "service",
      lifecycle: "running",
      terminalId: "term-app",
      exitCode: null,
    });

    const { session, projects, workspaces } = createSessionForWorkspaceGitWatchTests({
      scriptRuntimeStore: runtimeStore,
    });
    seedGitWorkspace({
      projects,
      workspaces,
      projectId: "proj-1",
      workspaceId: "ws-10",
      cwd: "/tmp/repo",
      name: "main",
    });

    await asInternals<{ archiveWorkspaceRecord: (workspaceId: string) => Promise<void> }>(
      session,
    ).archiveWorkspaceRecord("ws-10");

    expect(runtimeStore.listForWorkspace("ws-10")).toEqual([]);

    await session.cleanup();
  });

  test("archiving a workspace releases its git watch subscription for the directory", async () => {
    const { session, projects, workspaces, subscriptions } =
      createSessionForWorkspaceGitWatchTests();
    const sessionAny = asInternals<
      SessionInternals & { archiveWorkspaceRecord: (workspaceId: string) => Promise<void> }
    >(session);
    seedGitWorkspace({
      projects,
      workspaces,
      projectId: "proj-1",
      workspaceId: "ws-10",
      cwd: REPO_CWD,
      name: "main",
    });

    syncGitObserver(session, REPO_CWD, "ws-10");
    expect(subscriptions).toHaveLength(1);

    await sessionAny.archiveWorkspaceRecord("ws-10");

    // Re-observing the directory establishes a fresh subscription only if archive
    // tore down the prior one, which is keyed by cwd — not the opaque workspace id.
    syncGitObserver(session, REPO_CWD, "ws-10");
    expect(subscriptions).toHaveLength(2);

    await session.cleanup();
  });

  test("embeds PR status in checkout_status_update for GitHub-inclusive snapshot pushes", async () => {
    const { session, emitted, projects, workspaces, subscriptions } =
      createSessionForWorkspaceGitWatchTests();
    seedGitWorkspace({
      projects,
      workspaces,
      projectId: "proj-1",
      workspaceId: "ws-10",
      cwd: REPO_CWD,
      name: "main",
    });
    await session.handleMessage({
      type: "fetch_workspaces_request",
      requestId: "workspace-demand",
      subscribe: {},
    });

    syncGitObserver(session, REPO_CWD, "ws-10");
    emitted.length = 0;

    subscriptions[0]?.listener(
      createWorkspaceRuntimeSnapshot(REPO_CWD, {
        forge: {
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
            forgeSpecific: {
              forge: "github",
              mergeStateStatus: "CLEAN",
              autoMergeRequest: null,
              viewerCanEnableAutoMerge: true,
              viewerCanDisableAutoMerge: false,
              viewerCanMergeAsAdmin: false,
              viewerCanUpdateBranch: true,
              repository: {
                autoMergeAllowed: true,
                mergeCommitAllowed: true,
                squashMergeAllowed: true,
                rebaseMergeAllowed: false,
                viewerDefaultMergeMethod: "SQUASH",
              },
              isMergeQueueEnabled: false,
              isInMergeQueue: false,
            },
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
        forge: "github",
        number: 456,
        url: "https://github.com/acme/repo/pull/456",
        title: "Runtime centralization",
        state: "open",
        repoOwner: undefined,
        repoName: undefined,
        baseRefName: "main",
        headRefName: "workspace-git-service",
        isMerged: false,
        mergeable: "UNKNOWN",
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
        forgeSpecific: {
          forge: "github",
          mergeStateStatus: "CLEAN",
          autoMergeRequest: null,
          viewerCanEnableAutoMerge: true,
          viewerCanDisableAutoMerge: false,
          viewerCanMergeAsAdmin: false,
          viewerCanUpdateBranch: true,
          repository: {
            autoMergeAllowed: true,
            mergeCommitAllowed: true,
            squashMergeAllowed: true,
            rebaseMergeAllowed: false,
            viewerDefaultMergeMethod: "SQUASH",
          },
          isMergeQueueEnabled: false,
          isInMergeQueue: false,
        },
        github: {
          mergeStateStatus: "CLEAN",
          autoMergeRequest: null,
          viewerCanEnableAutoMerge: true,
          viewerCanDisableAutoMerge: false,
          viewerCanMergeAsAdmin: false,
          viewerCanUpdateBranch: true,
          repository: {
            autoMergeAllowed: true,
            mergeCommitAllowed: true,
            squashMergeAllowed: true,
            rebaseMergeAllowed: false,
            viewerDefaultMergeMethod: "SQUASH",
          },
          isMergeQueueEnabled: false,
          isInMergeQueue: false,
        },
      },
      forge: "github",
      authState: undefined,
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
        forge: {
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
        forge: "github",
        number: undefined,
        url: "https://github.com/acme/repo/pull/456",
        title: "Runtime centralization",
        state: "merged",
        repoOwner: undefined,
        repoName: undefined,
        baseRefName: "main",
        headRefName: "workspace-git-service",
        isMerged: true,
        mergeable: "UNKNOWN",
        isDraft: false,
        checks: [],
        checksStatus: undefined,
        reviewDecision: undefined,
      },
      forge: "github",
      authState: undefined,
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

describe("live workspace observation", () => {
  const OLD = "2026-03-01T00:00:00.000Z";

  function watchedCwds(workspaceGitService: {
    registerWorkspace: ReturnType<typeof vi.fn>;
  }): string[] {
    return workspaceGitService.registerWorkspace.mock.calls
      .map((call) => (call[0] as { cwd: string }).cwd)
      .sort();
  }

  /**
   * Drives the terminal-change events the session subscribes to, and counts the terminal
   * directory reads each one causes, so a test can tell a reconcile from a no-op.
   */
  function createTerminalEvents(input: { cwd: string }): {
    terminalManager: SessionOptions["terminalManager"];
    terminalList: (workspaceId: string) => TerminalsChangedEvent["terminals"];
    emit: (terminals: TerminalsChangedEvent["terminals"]) => void;
    lookups: () => number;
  } {
    const listeners: Array<(event: TerminalsChangedEvent) => void> = [];
    let terminals: TerminalsChangedEvent["terminals"] = [];
    let lookups = 0;
    const terminalManager = asTerminalManager({
      listDirectories: () => [input.cwd],
      getTerminals: async (cwd: string) => {
        lookups += 1;
        return cwd === input.cwd ? [...terminals] : [];
      },
      subscribeTerminalsChanged: (listener: (event: TerminalsChangedEvent) => void) => {
        listeners.push(listener);
        return () => {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        };
      },
    });
    return {
      terminalManager,
      terminalList: (workspaceId) => [
        { id: "terminal-1", name: "bash", cwd: input.cwd, workspaceId, activity: null },
      ],
      emit(nextTerminals) {
        terminals = nextTerminals;
        for (const listener of listeners) {
          listener({ cwd: input.cwd, terminals: nextTerminals });
        }
      },
      lookups: () => lookups,
    };
  }

  function createTerminalManager(input: {
    cwd: string;
    workspaceId: string;
  }): SessionOptions["terminalManager"] {
    const terminal = {
      id: "terminal-1",
      cwd: input.cwd,
      workspaceId: input.workspaceId,
      getActivity: () => null,
    };
    return asTerminalManager({
      listDirectories: () => [input.cwd],
      getTerminals: async (cwd: string) => (cwd === input.cwd ? [terminal] : []),
      subscribeTerminalsChanged: () => () => {},
    });
  }

  /**
   * Captures the terminal list at call time and can delay the next lookup, so a test can
   * resolve a reconcile with the terminals that existed before a later change.
   */
  function createSlowTerminalManager(cwd: string): {
    terminalManager: SessionOptions["terminalManager"];
    addTerminal: (workspaceId: string) => void;
    delayNextLookup: (delayMs: number) => void;
    lookupCount: () => number;
  } {
    let terminals: Array<{
      id: string;
      cwd: string;
      workspaceId: string;
      getActivity: () => null;
    }> = [];
    let nextLookupDelayMs = 0;
    let lookups = 0;

    const terminalManager = asTerminalManager({
      listDirectories: () => [cwd],
      getTerminals: async (lookupCwd: string) => {
        const snapshot = lookupCwd === cwd ? [...terminals] : [];
        lookups += 1;
        const delayMs = nextLookupDelayMs;
        nextLookupDelayMs = 0;
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        return snapshot;
      },
      subscribeTerminalsChanged: () => () => {},
    });

    return {
      terminalManager,
      addTerminal(workspaceId) {
        terminals = [...terminals, { id: "terminal-1", cwd, workspaceId, getActivity: () => null }];
      },
      delayNextLookup(delayMs) {
        nextLookupDelayMs = delayMs;
      },
      lookupCount() {
        return lookups;
      },
    };
  }

  function reconcileObservers(session: Session): Promise<void> {
    return asInternals<{ reconcileWorkspaceGitObservers: () => Promise<void> }>(
      session,
    ).reconcileWorkspaceGitObservers();
  }

  test("an unfiltered workspace list subscribes to nothing and checkout status watches only live workspaces", async () => {
    const terminalCwd = "/tmp/terminal-workspace";
    const terminalManager = createTerminalManager({
      cwd: terminalCwd,
      workspaceId: "ws-terminal",
    });
    const { session, projects, workspaces, workspaceGitService } =
      createSessionForWorkspaceGitWatchTests({
        terminalManager,
        agents: [{ workspaceId: "ws-agent", lifecycle: "idle", labels: {} }],
      });
    seedGitWorkspace({
      projects,
      workspaces,
      projectId: "proj-1",
      workspaceId: "ws-agent",
      cwd: "/tmp/agent-workspace",
      name: "agent",
      updatedAt: OLD,
    });
    seedGitWorkspace({
      projects,
      workspaces,
      projectId: "proj-1",
      workspaceId: "ws-terminal",
      cwd: terminalCwd,
      name: "terminal",
      updatedAt: OLD,
    });
    seedGitWorkspace({
      projects,
      workspaces,
      projectId: "proj-1",
      workspaceId: "ws-fresh",
      cwd: "/tmp/fresh-workspace",
      name: "fresh",
      updatedAt: new Date().toISOString(),
    });
    seedGitWorkspace({
      projects,
      workspaces,
      projectId: "proj-1",
      workspaceId: "ws-idle",
      cwd: "/tmp/idle-workspace",
      name: "idle",
      updatedAt: OLD,
    });

    const explicitSubscriptions = asInternals<{
      listExplicitWorkspaceSubscriptions: () => Array<{ id: string }>;
    }>(session);

    await session.handleMessage({
      type: "fetch_workspaces_request",
      requestId: "workspace-list",
      subscribe: {},
    });
    expect(explicitSubscriptions.listExplicitWorkspaceSubscriptions()).toEqual([]);

    await session.handleMessage({
      type: "session.events.set_subscription.request",
      requestId: "events-1",
      events: ["checkout_status_update"],
    });
    expect(watchedCwds(workspaceGitService)).toEqual(
      ["/tmp/agent-workspace", terminalCwd, "/tmp/fresh-workspace"].sort(),
    );

    await session.handleMessage({
      type: "fetch_workspaces_request",
      requestId: "filtered-list",
      subscribe: {},
      filter: { query: "idle" },
    });
    expect(
      explicitSubscriptions.listExplicitWorkspaceSubscriptions().map((workspace) => workspace.id),
    ).toEqual(["ws-idle"]);

    await session.cleanup();
  });

  test("picks up a workspace that becomes live without a fresh checkout request", async () => {
    const agents: Array<{
      workspaceId?: string;
      lifecycle: "initializing" | "idle" | "running" | "error" | "closed";
      labels: Record<string, string>;
    }> = [];
    const { session, projects, workspaces, workspaceGitService, agentEventListeners } =
      createSessionForWorkspaceGitWatchTests({ agents });
    seedGitWorkspace({
      projects,
      workspaces,
      projectId: "proj-1",
      workspaceId: "ws-idle",
      cwd: "/tmp/idle-workspace",
      name: "idle",
      updatedAt: OLD,
    });

    await session.handleMessage({
      type: "session.events.set_subscription.request",
      requestId: "events-1",
      events: ["checkout_status_update"],
    });
    expect(watchedCwds(workspaceGitService)).toEqual([]);

    const agent = { workspaceId: "ws-idle", lifecycle: "running" as const, labels: {} };
    agents.push(agent);
    for (const listener of agentEventListeners) {
      listener({ type: "agent_state", agent });
    }

    await vi.waitFor(() =>
      expect(watchedCwds(workspaceGitService)).toEqual(["/tmp/idle-workspace"]),
    );

    await session.cleanup();
  });

  test("keeps auto-archive worktrees and known open pull requests watched", async () => {
    const workspaceRuntimeStore = createWorkspaceRuntimeStore();
    workspaceRuntimeStore.set(
      createWorkspaceRuntimeSnapshot("/tmp/pull-request-workspace", {
        forge: {
          pullRequest: {
            url: "https://github.com/acme/repo/pull/7",
            title: "Open work",
            state: "open",
            baseRefName: "main",
            headRefName: "feature",
            isMerged: false,
          },
        },
      }),
    );
    const { session, projects, workspaces, workspaceGitService } =
      createSessionForWorkspaceGitWatchTests({
        workspaceRuntimeStore,
        autoArchiveAfterMerge: true,
      });
    seedGitWorkspace({
      projects,
      workspaces,
      projectId: "proj-1",
      workspaceId: "ws-worktree",
      cwd: "/tmp/paseo-worktree",
      name: "worktree",
      updatedAt: OLD,
      isPaseoOwnedWorktree: true,
    });
    seedGitWorkspace({
      projects,
      workspaces,
      projectId: "proj-1",
      workspaceId: "ws-pull-request",
      cwd: "/tmp/pull-request-workspace",
      name: "pull-request",
      updatedAt: OLD,
    });
    seedGitWorkspace({
      projects,
      workspaces,
      projectId: "proj-1",
      workspaceId: "ws-idle",
      cwd: "/tmp/idle-workspace",
      name: "idle",
      updatedAt: OLD,
    });

    await session.handleMessage({
      type: "session.events.set_subscription.request",
      requestId: "events-1",
      events: ["checkout_status_update"],
    });

    expect(watchedCwds(workspaceGitService)).toEqual(
      ["/tmp/paseo-worktree", "/tmp/pull-request-workspace"].sort(),
    );

    await session.cleanup();
  });

  test("enabling auto-archive after merge starts watching quiet owned worktrees", async () => {
    const { session, projects, workspaces, workspaceGitService, setAutoArchiveAfterMerge } =
      createSessionForWorkspaceGitWatchTests();
    seedGitWorkspace({
      projects,
      workspaces,
      projectId: "proj-1",
      workspaceId: "ws-worktree",
      cwd: "/tmp/quiet-worktree",
      name: "worktree",
      updatedAt: OLD,
      isPaseoOwnedWorktree: true,
    });

    await session.handleMessage({
      type: "session.events.set_subscription.request",
      requestId: "events-1",
      events: ["checkout_status_update"],
    });
    expect(watchedCwds(workspaceGitService)).toEqual([]);

    setAutoArchiveAfterMerge(true);

    await vi.waitFor(() => {
      expect(watchedCwds(workspaceGitService)).toEqual(["/tmp/quiet-worktree"]);
    });

    await session.cleanup();
  });

  test("a reconcile that resolves late cannot remove a workspace a later reconcile added", async () => {
    const terminalCwd = "/tmp/reconcile-race-workspace";
    const slowTerminals = createSlowTerminalManager(terminalCwd);
    const { session, projects, workspaces, workspaceGitService } =
      createSessionForWorkspaceGitWatchTests({ terminalManager: slowTerminals.terminalManager });
    seedGitWorkspace({
      projects,
      workspaces,
      projectId: "proj-1",
      workspaceId: "ws-race",
      cwd: terminalCwd,
      name: "race",
      updatedAt: OLD,
    });

    await session.handleMessage({
      type: "session.events.set_subscription.request",
      requestId: "events-1",
      events: ["checkout_status_update"],
    });
    expect(watchedCwds(workspaceGitService)).toEqual([]);

    // The first reconcile reads the terminal list before the workspace has a terminal and holds
    // that snapshot until after the second reconcile has made the workspace live.
    const lookupsBeforeRace = slowTerminals.lookupCount();
    slowTerminals.delayNextLookup(50);
    const staleReconcile = reconcileObservers(session);
    await vi.waitFor(() => expect(slowTerminals.lookupCount()).toBe(lookupsBeforeRace + 1));
    slowTerminals.addTerminal("ws-race");
    const freshReconcile = reconcileObservers(session);
    await Promise.all([staleReconcile, freshReconcile]);

    expect(watchedCwds(workspaceGitService)).toEqual([terminalCwd]);
    expect(session.getRuntimeMetrics().workspaceGitSubscriptionCount).toBe(1);

    await session.cleanup();
  });

  test("a tab left open by a collected runtime keeps its workspace watched", async () => {
    const tabLabels = { [getOpenAgentTabLabel("client-1")]: "true" };
    const tabCwd = "/tmp/tab-workspace";
    const agents: Array<{
      workspaceId?: string;
      lifecycle: "initializing" | "idle" | "running" | "error" | "closed";
      labels: Record<string, string>;
    }> = [{ workspaceId: "ws-tab", lifecycle: "running", labels: tabLabels }];
    const { session, projects, workspaces, workspaceGitService, agentEventListeners } =
      createSessionForWorkspaceGitWatchTests({
        agents,
        storedAgents: [{ id: "agent-tab", workspaceId: "ws-tab", labels: tabLabels }],
      });
    seedGitWorkspace({
      projects,
      workspaces,
      projectId: "proj-1",
      workspaceId: "ws-tab",
      cwd: tabCwd,
      name: "tab",
      updatedAt: OLD,
    });

    await session.handleMessage({
      type: "session.events.set_subscription.request",
      requestId: "events-1",
      events: ["checkout_status_update"],
    });
    expect(watchedCwds(workspaceGitService)).toEqual([tabCwd]);

    // The idle clock collects the runtime. The tab stays open, and its label survives on the
    // stored record, so the workspace is still live without a loaded agent.
    agents.length = 0;
    for (const listener of agentEventListeners) {
      listener({
        type: "agent_state",
        agent: { id: "agent-tab", workspaceId: "ws-tab", lifecycle: "closed", labels: tabLabels },
      });
    }
    await reconcileObservers(session);

    expect(session.getRuntimeMetrics().workspaceGitSubscriptionCount).toBe(1);
    expect(watchedCwds(workspaceGitService)).toEqual([tabCwd]);

    await session.cleanup();
  });

  test("a reconcile still running when the session cleans up registers nothing", async () => {
    const terminalCwd = "/tmp/cleanup-race-workspace";
    const slowTerminals = createSlowTerminalManager(terminalCwd);
    const { session, projects, workspaces, workspaceGitService } =
      createSessionForWorkspaceGitWatchTests({ terminalManager: slowTerminals.terminalManager });
    seedGitWorkspace({
      projects,
      workspaces,
      projectId: "proj-1",
      workspaceId: "ws-cleanup",
      cwd: terminalCwd,
      name: "cleanup",
      updatedAt: OLD,
    });

    await session.handleMessage({
      type: "session.events.set_subscription.request",
      requestId: "events-1",
      events: ["checkout_status_update"],
    });
    expect(watchedCwds(workspaceGitService)).toEqual([]);

    // The reconcile reads a live terminal and holds the answer, so it applies after cleanup.
    slowTerminals.addTerminal("ws-cleanup");
    const lookupsBefore = slowTerminals.lookupCount();
    slowTerminals.delayNextLookup(50);
    const pendingReconcile = reconcileObservers(session);
    await vi.waitFor(() => expect(slowTerminals.lookupCount()).toBe(lookupsBefore + 1));
    await session.cleanup();
    await pendingReconcile;

    expect(watchedCwds(workspaceGitService)).toEqual([]);
    expect(session.getRuntimeMetrics().workspaceGitSubscriptionCount).toBe(0);
  });

  test("a touched workspace survives the next reconcile and drops after the liveness window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const touchedCwd = "/tmp/touched-workspace";
      const { session, projects, workspaces } = createSessionForWorkspaceGitWatchTests();
      seedGitWorkspace({
        projects,
        workspaces,
        projectId: "proj-1",
        workspaceId: "ws-touched",
        cwd: touchedCwd,
        name: "touched",
        updatedAt: OLD,
      });

      await session.handleMessage({
        type: "session.events.set_subscription.request",
        requestId: "events-1",
        events: ["checkout_status_update"],
      });
      expect(session.getRuntimeMetrics().workspaceGitSubscriptionCount).toBe(0);

      const record = workspaces.get("ws-touched");
      if (!record) throw new Error("missing ws-touched record");
      await session.syncWorkspaceGitObserverForWorkspace(record);
      expect(session.getRuntimeMetrics().workspaceGitSubscriptionCount).toBe(1);

      // An unrelated reconcile inside the window counts the touch as activity.
      await reconcileObservers(session);
      expect(session.getRuntimeMetrics().workspaceGitSubscriptionCount).toBe(1);

      vi.setSystemTime(Date.now() + WORKSPACE_LIVENESS_WINDOW_MS + 60_000);
      await reconcileObservers(session);
      expect(session.getRuntimeMetrics().workspaceGitSubscriptionCount).toBe(0);

      await session.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  test("fills the git data of a quiet workspace once without registering a watch", async () => {
    const quietCwd = "/tmp/quiet-workspace";
    const { session, emitted, projects, workspaces, workspaceGitService } =
      createSessionForWorkspaceGitWatchTests();
    seedGitWorkspace({
      projects,
      workspaces,
      projectId: "proj-1",
      workspaceId: "ws-quiet",
      cwd: quietCwd,
      name: "quiet",
      updatedAt: OLD,
    });

    await session.handleMessage({
      type: "fetch_workspaces_request",
      requestId: "workspace-list",
      subscribe: { subscriptionId: "workspace-list" },
    });

    const quietUpdates = () =>
      getWorkspaceUpdates(emitted).filter(
        (message) =>
          message.payload.kind === "upsert" && message.payload.workspace.id === "ws-quiet",
      );
    await vi.waitFor(() => expect(quietUpdates()).toHaveLength(1));
    expect(quietUpdates()[0]?.payload.workspace.gitRuntime?.currentBranch).toBe("main");

    expect(workspaceGitService.getSnapshot).toHaveBeenCalledExactlyOnceWith(quietCwd);
    expect(workspaceGitService.registerWorkspace).not.toHaveBeenCalled();
    expect(session.getRuntimeMetrics().workspaceGitSubscriptionCount).toBe(0);

    await session.cleanup();
  });

  test("fills the git data of every workspace record that shares a quiet directory", async () => {
    const quietCwd = "/tmp/shared-quiet-workspace";
    const { session, emitted, projects, workspaces, workspaceGitService } =
      createSessionForWorkspaceGitWatchTests();
    for (const workspaceId of ["ws-shared-a", "ws-shared-b"]) {
      seedGitWorkspace({
        projects,
        workspaces,
        projectId: "proj-1",
        workspaceId,
        cwd: quietCwd,
        name: workspaceId,
        updatedAt: OLD,
      });
    }

    const updatedWorkspaceIds = () =>
      getWorkspaceUpdates(emitted).flatMap((message) =>
        message.payload.kind === "upsert" ? [message.payload.workspace.id] : [],
      );
    await session.handleMessage({
      type: "fetch_workspaces_request",
      requestId: "workspace-list",
      subscribe: { subscriptionId: "workspace-list" },
    });

    await vi.waitFor(() =>
      expect(updatedWorkspaceIds().sort()).toEqual(["ws-shared-a", "ws-shared-b"]),
    );
    expect(workspaceGitService.getSnapshot).toHaveBeenCalledExactlyOnceWith(quietCwd);

    await session.cleanup();
  });

  test("does not read a quiet workspace that already has a cached snapshot", async () => {
    const quietCwd = "/tmp/cached-workspace";
    const workspaceRuntimeStore = createWorkspaceRuntimeStore();
    workspaceRuntimeStore.set(createWorkspaceRuntimeSnapshot(quietCwd));
    const { session, projects, workspaces, workspaceGitService } =
      createSessionForWorkspaceGitWatchTests({ workspaceRuntimeStore });
    seedGitWorkspace({
      projects,
      workspaces,
      projectId: "proj-1",
      workspaceId: "ws-cached",
      cwd: quietCwd,
      name: "cached",
      updatedAt: OLD,
    });

    await session.handleMessage({
      type: "fetch_workspaces_request",
      requestId: "workspace-list",
      subscribe: { subscriptionId: "workspace-list" },
    });
    await reconcileObservers(session);

    expect(workspaceGitService.getSnapshot).not.toHaveBeenCalled();
    await session.cleanup();
  });

  test("does not serve the warm-up snapshot as current to a checkout status request", async () => {
    const quietCwd = "/tmp/warmed-workspace";
    const { session, emitted, projects, workspaces, workspaceGitService, workspaceRuntimeStore } =
      createSessionForWorkspaceGitWatchTests();
    // Mirrors the service: a target with no listener keeps the snapshot of its last read and
    // returns it again unless the caller forces a read.
    let branch = "at-startup";
    workspaceGitService.hasWorkspaceListener = vi.fn(() => false);
    workspaceGitService.getSnapshot.mockImplementation(
      async (cwd: string, options?: { force?: boolean }) => {
        if (options?.force) branch = "current";
        const snapshot = createWorkspaceRuntimeSnapshot(cwd, { git: { currentBranch: branch } });
        workspaceRuntimeStore.set(snapshot);
        return snapshot;
      },
    );
    seedGitWorkspace({
      projects,
      workspaces,
      projectId: "proj-1",
      workspaceId: "ws-warmed",
      cwd: quietCwd,
      name: "warmed",
      updatedAt: OLD,
    });

    await session.handleMessage({
      type: "fetch_workspaces_request",
      requestId: "workspace-list",
      subscribe: { subscriptionId: "workspace-list" },
    });
    await vi.waitFor(() => expect(workspaceGitService.getSnapshot).toHaveBeenCalledTimes(1));

    await session.handleMessage({
      type: "checkout_status_request",
      cwd: quietCwd,
      requestId: "status-1",
    });

    expect(workspaceGitService.getSnapshot).toHaveBeenLastCalledWith(quietCwd, {
      force: true,
      reason: "checkout-status-request",
    });
    const statusResponse = emitted.find((message) => message.type === "checkout_status_response");
    expect(statusResponse?.payload).toMatchObject({
      currentBranch: "current",
      requestId: "status-1",
    });

    await session.cleanup();
  });

  test("adds and drops a workspace's watch as its last terminal comes and goes", async () => {
    const terminalCwd = "/tmp/terminal-event-workspace";
    const terminals = createTerminalEvents({ cwd: terminalCwd });
    const { session, projects, workspaces, workspaceGitService } =
      createSessionForWorkspaceGitWatchTests({ terminalManager: terminals.terminalManager });
    seedGitWorkspace({
      projects,
      workspaces,
      projectId: "proj-1",
      workspaceId: "ws-terminal",
      cwd: terminalCwd,
      name: "terminal",
      updatedAt: OLD,
    });

    await session.handleMessage({
      type: "session.events.set_subscription.request",
      requestId: "events-1",
      events: ["checkout_status_update"],
    });
    expect(watchedCwds(workspaceGitService)).toEqual([]);

    terminals.emit(terminals.terminalList("ws-terminal"));
    await vi.waitFor(() => expect(watchedCwds(workspaceGitService)).toEqual([terminalCwd]));

    terminals.emit([]);
    await vi.waitFor(() =>
      expect(session.getRuntimeMetrics().workspaceGitSubscriptionCount).toBe(0),
    );

    await session.cleanup();
  });

  test("a terminal event that only changes titles and activity re-reconciles nothing", async () => {
    const terminalCwd = "/tmp/terminal-title-workspace";
    const terminals = createTerminalEvents({ cwd: terminalCwd });
    const { session, projects, workspaces, workspaceGitService } =
      createSessionForWorkspaceGitWatchTests({ terminalManager: terminals.terminalManager });
    seedGitWorkspace({
      projects,
      workspaces,
      projectId: "proj-1",
      workspaceId: "ws-terminal",
      cwd: terminalCwd,
      name: "terminal",
      updatedAt: OLD,
    });

    await session.handleMessage({
      type: "session.events.set_subscription.request",
      requestId: "events-1",
      events: ["checkout_status_update"],
    });
    terminals.emit(terminals.terminalList("ws-terminal"));
    await vi.waitFor(() => expect(watchedCwds(workspaceGitService)).toEqual([terminalCwd]));

    const lookupsAfterReconcile = terminals.lookups();
    const titledTerminals = terminals.terminalList("ws-terminal");
    for (const terminal of titledTerminals) terminal.title = "npm test";
    terminals.emit(titledTerminals);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(terminals.lookups()).toBe(lookupsAfterReconcile);
    expect(watchedCwds(workspaceGitService)).toEqual([terminalCwd]);

    await session.cleanup();
  });

  test("reads the git data of quiet workspaces two at a time", async () => {
    const { session, projects, workspaces, workspaceGitService } =
      createSessionForWorkspaceGitWatchTests();
    const readings: Array<() => void> = [];
    let inFlight = 0;
    let peakInFlight = 0;
    workspaceGitService.getSnapshot.mockImplementation(async (cwd: string) => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise<void>((resolve) => readings.push(resolve));
      inFlight -= 1;
      return createWorkspaceRuntimeSnapshot(cwd);
    });
    for (const name of ["one", "two", "three"]) {
      seedGitWorkspace({
        projects,
        workspaces,
        projectId: "proj-1",
        workspaceId: `ws-${name}`,
        cwd: `/tmp/quiet-${name}`,
        name,
        updatedAt: OLD,
      });
    }

    await session.handleMessage({
      type: "fetch_workspaces_request",
      requestId: "workspace-list",
      subscribe: { subscriptionId: "workspace-list" },
    });
    await vi.waitFor(() => expect(inFlight).toBe(2));
    expect(workspaceGitService.getSnapshot).toHaveBeenCalledTimes(2);

    readings.shift()?.();
    await vi.waitFor(() => expect(workspaceGitService.getSnapshot).toHaveBeenCalledTimes(3));
    readings.shift()?.();
    readings.shift()?.();
    await vi.waitFor(() => expect(inFlight).toBe(0));

    expect(peakInFlight).toBe(2);
    expect(workspaceGitService.getSnapshot).toHaveBeenCalledTimes(3);
    await session.cleanup();
  });

  test("drops the warm-up reads still queued when the session is cleaned up", async () => {
    const { session, projects, workspaces, workspaceGitService } =
      createSessionForWorkspaceGitWatchTests();
    const readings: Array<() => void> = [];
    workspaceGitService.getSnapshot.mockImplementation(async (cwd: string) => {
      await new Promise<void>((resolve) => readings.push(resolve));
      return createWorkspaceRuntimeSnapshot(cwd);
    });
    for (const name of ["one", "two", "three"]) {
      seedGitWorkspace({
        projects,
        workspaces,
        projectId: "proj-1",
        workspaceId: `ws-${name}`,
        cwd: `/tmp/queued-${name}`,
        name,
        updatedAt: OLD,
      });
    }

    await session.handleMessage({
      type: "fetch_workspaces_request",
      requestId: "workspace-list",
      subscribe: { subscriptionId: "workspace-list" },
    });
    await vi.waitFor(() => expect(workspaceGitService.getSnapshot).toHaveBeenCalledTimes(2));

    await session.cleanup();
    // Let the two admitted reads finish; the queued third must not start after cleanup.
    readings.splice(0).forEach((resolve) => resolve());
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(workspaceGitService.getSnapshot).toHaveBeenCalledTimes(2);
  });

  test("a session that does not project checkout status runs no liveness scans on agent events", async () => {
    const agents = [{ workspaceId: "ws-idle", lifecycle: "idle" as const, labels: {} }];
    const { session, projects, workspaces, agentEventListeners, livenessReads } =
      createSessionForWorkspaceGitWatchTests({ agents });
    seedGitWorkspace({
      projects,
      workspaces,
      projectId: "proj-1",
      workspaceId: "ws-idle",
      cwd: "/tmp/idle-workspace",
      name: "idle",
      updatedAt: OLD,
    });

    // A modern client owns its subscriptions, so nothing is implicitly delivered: this session
    // watches agents only and never projects checkout status.
    const source = {};
    asInternals<{ delivery: { attach: (socket: object, modern: boolean) => void } }>(
      session,
    ).delivery.attach(source, true);
    await session.handleMessage(
      {
        type: "fetch_agents_request",
        requestId: "agents",
        subscribe: {},
      },
      source,
    );
    expect(agentEventListeners.length).toBeGreaterThan(0);
    const listAgentsCalls = livenessReads.listAgents.mock.calls.length;
    const listActiveCalls = livenessReads.listActiveAgentRecords.mock.calls.length;

    for (const listener of agentEventListeners) {
      listener({ type: "agent_removed", agentId: "agent-1" });
    }

    expect(livenessReads.listAgents).toHaveBeenCalledTimes(listAgentsCalls);
    expect(livenessReads.listActiveAgentRecords).toHaveBeenCalledTimes(listActiveCalls);
    await session.cleanup();
  });
});
