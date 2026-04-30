import { execSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { Session } from "./session.js";
import type { SessionOptions } from "./session.js";
import type {
  AgentSnapshotPayload,
  EditorTargetDescriptorPayload,
  SessionOutboundMessage,
} from "../shared/messages.js";
import type { WorkspaceGitRuntimeSnapshot } from "./workspace-git-service.js";
import { createNoopWorkspaceGitService } from "./test-utils/workspace-git-service-stub.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
} from "./workspace-registry.js";

interface SessionTestAccess {
  projectRegistry: {
    list(...args: unknown[]): Promise<unknown[]>;
    archive(projectId: string, archivedAt: string): Promise<void>;
    get(id: string): Promise<unknown>;
    upsert(record: unknown): Promise<unknown>;
  };
  agentStorage: {
    list(...args: unknown[]): Promise<unknown[]>;
    get(agentId: string): Promise<unknown>;
  };
  workspaceRegistry: {
    list(...args: unknown[]): Promise<unknown[]>;
    archive(workspaceId: string, archivedAt: string): Promise<void>;
    get(workspaceId: string): Promise<unknown>;
    upsert(record: unknown): Promise<unknown>;
  };
  agentUpdatesSubscription: unknown;
  workspaceUpdatesSubscription: unknown;
  interruptAgentIfRunning(agentId: string): unknown;
  reconcileActiveWorkspaceRecords(...args: unknown[]): Promise<Set<string>>;
  reconcileWorkspaceRecord(workspaceId: string): Promise<Record<string, unknown>>;
  reconcileAndEmitWorkspaceUpdates(...args: unknown[]): Promise<unknown>;
  forwardAgentUpdate(...args: unknown[]): Promise<unknown>;
  handleArchiveAgentRequest(agentId: string, requestId: string): Promise<unknown>;
  handleMessage(message: unknown): Promise<unknown>;
  handleCreatePaseoWorktreeRequest(params: unknown): Promise<unknown>;
  listAgentPayloads(...args: unknown[]): Promise<unknown[]>;
  listFetchWorkspacesEntries(params: unknown): Promise<ListFetchResult>;
  listFetchAgentsEntries(params: unknown): Promise<ListFetchResult>;
  resolveAgentIdentifier(identifier: string): Promise<unknown>;
  getAgentPayloadById(agentId: string): Promise<unknown>;
  buildProjectPlacementForCwd(cwd: string): Promise<unknown>;
  buildProjectPlacement(cwd: string): Promise<unknown>;
  resolveRegisteredWorkspaceIdForCwd(
    cwd: string,
    workspaces: ReturnType<typeof createPersistedWorkspaceRecord>[],
  ): string;
  buildWorkspaceDescriptorMap(...args: unknown[]): Promise<Map<string, unknown>>;
  describeWorkspaceRecord(...args: unknown[]): Promise<unknown>;
  describeWorkspaceRecordWithGitData(...args: unknown[]): Promise<unknown>;
  markWorkspaceArchiving(workspaceIds: Iterable<string>, archivingAt: string): void;
  clearWorkspaceArchiving(workspaceIds: Iterable<string>): void;
  emitWorkspaceUpdateForCwd(...args: unknown[]): Promise<unknown>;
  emitWorkspaceUpdatesForWorkspaceIds(...args: unknown[]): Promise<unknown>;
  emit(message: unknown): void;
  onMessage(message: unknown): void;
  getAvailableEditorTargets(...args: unknown[]): Promise<unknown>;
  filterEditorsForClient(...args: unknown[]): unknown;
  openEditorTarget(input: { editorId: string; path: string }): Promise<unknown>;
  resolveAvailableEditorTargets(...args: unknown[]): Promise<unknown>;
  paseoHome: string;
  terminalManager: {
    killTerminal(id: string): unknown;
  } | null;
  workspaceGitService: {
    getCheckout: (cwd: string) => Promise<unknown>;
    getSnapshot: (cwd: string, options?: unknown) => Promise<WorkspaceGitRuntimeSnapshot>;
    peekSnapshot: (cwd: string) => WorkspaceGitRuntimeSnapshot | null;
    registerWorkspace: (params: { cwd: string }, listener: unknown) => { unsubscribe: () => void };
  };
}

interface ListFetchResult {
  entries: Array<Record<string, unknown>>;
  pageInfo: Record<string, unknown>;
  nextCursor?: string | null;
  total?: number;
  [key: string]: unknown;
}

type TestSession = SessionTestAccess;

function asTestSession(session: Session | TestSession): TestSession {
  return session as unknown as TestSession;
}

function makeAgent(input: {
  id: string;
  cwd: string;
  status: AgentSnapshotPayload["status"];
  updatedAt: string;
  pendingPermissions?: number;
  requiresAttention?: boolean;
  attentionReason?: AgentSnapshotPayload["attentionReason"];
}): AgentSnapshotPayload {
  const pendingPermissionCount = input.pendingPermissions ?? 0;
  return {
    id: input.id,
    provider: "codex",
    cwd: input.cwd,
    model: null,
    thinkingOptionId: null,
    effectiveThinkingOptionId: null,
    createdAt: input.updatedAt,
    updatedAt: input.updatedAt,
    lastUserMessageAt: null,
    status: input.status,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: Array.from({ length: pendingPermissionCount }, (_, index) => ({
      id: `perm-${input.id}-${index}`,
      provider: "codex",
      name: "tool",
      kind: "tool",
    })),
    persistence: null,
    runtimeInfo: {
      provider: "codex",
      sessionId: null,
    },
    title: null,
    labels: {},
    requiresAttention: input.requiresAttention ?? false,
    attentionReason: input.attentionReason ?? null,
    attentionTimestamp: null,
    archivedAt: null,
  };
}

function makeManagedAgent(input: {
  id: string;
  cwd: string;
  lifecycle: AgentSnapshotPayload["status"];
  updatedAt: string;
}) {
  const now = new Date(input.updatedAt);
  const snapshot = makeAgent({
    id: input.id,
    cwd: input.cwd,
    status: input.lifecycle,
    updatedAt: input.updatedAt,
  });

  return {
    ...snapshot,
    lifecycle: snapshot.status,
    config: {
      provider: snapshot.provider,
      cwd: snapshot.cwd,
    },
    createdAt: now,
    updatedAt: now,
    pendingPermissions: new Map(),
    bufferedPermissionResolutions: new Map(),
    inFlightPermissionResponses: new Set(),
    pendingReplacement: false,
    persistence: null,
    historyPrimed: true,
    lastUserMessageAt: null,
    attention: {
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: now,
    },
    foregroundTurnWaiters: new Set(),
    unsubscribeSession: null,
    session: null,
    activeForegroundTurnId: input.lifecycle === "running" ? "turn-1" : null,
  };
}

function agentIdsFromEntries(entries: Array<Record<string, unknown>>) {
  return entries.map((entry) => (entry.agent as Pick<AgentSnapshotPayload, "id">).id);
}

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
      pullRequest: {
        url: "https://github.com/acme/repo/pull/123",
        title: "Runtime payloads",
        state: "open",
        baseRefName: "main",
        headRefName: "feature/runtime-payloads",
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

function createSessionForWorkspaceTests(
  options: {
    appVersion?: string | null;
    onMessage?: (message: SessionOutboundMessage) => void;
    workspaceGitService?: ReturnType<typeof createNoopWorkspaceGitService>;
  } = {},
): TestSession {
  const logger = {
    child: () => logger,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const session = asTestSession(
    new Session({
      clientId: "test-client",
      appVersion: options.appVersion ?? null,
      onMessage: options.onMessage ?? vi.fn(),
      logger: logger as unknown as SessionOptions["logger"],
      downloadTokenStore: {} as unknown as SessionOptions["downloadTokenStore"],
      pushTokenStore: {} as unknown as SessionOptions["pushTokenStore"],
      paseoHome: "/tmp/paseo-test",
      agentManager: {
        subscribe: () => () => {},
        listAgents: () => [],
        getAgent: () => null,
        archiveAgent: async () => ({ archivedAt: new Date().toISOString() }),
        archiveSnapshot: async () => ({}),
        clearAgentAttention: async () => {},
        notifyAgentState: () => {},
      } as unknown as SessionOptions["agentManager"],
      agentStorage: {
        list: async () => [],
        get: async () => null,
      } as unknown as SessionOptions["agentStorage"],
      projectRegistry: {
        initialize: async () => {},
        existsOnDisk: async () => true,
        list: async () => [],
        get: async () => null,
        upsert: async () => {},
        archive: async () => {},
        remove: async () => {},
      } as unknown as SessionOptions["projectRegistry"],
      workspaceRegistry: {
        initialize: async () => {},
        existsOnDisk: async () => true,
        list: async () => [],
        get: async () => null,
        upsert: async () => {},
        archive: async () => {},
        remove: async () => {},
      } as unknown as SessionOptions["workspaceRegistry"],
      chatService: {} as unknown as SessionOptions["chatService"],
      scheduleService: {} as unknown as SessionOptions["scheduleService"],
      loopService: {} as unknown as SessionOptions["loopService"],
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
      } as unknown as SessionOptions["checkoutDiffManager"],
      workspaceGitService: options.workspaceGitService ?? createNoopWorkspaceGitService(),
      daemonConfigStore: {
        get: () => ({ mcp: { injectIntoAgents: false }, providers: {} }),
        onChange: () => () => {},
      } as unknown as SessionOptions["daemonConfigStore"],
      mcpBaseUrl: null,
      stt: null,
      tts: null,
      terminalManager: null,
    }),
  );
  return session;
}

test("unsupported persisted agents are excluded from active lists but preserved in history payloads", async () => {
  const session = createSessionForWorkspaceTests({ appVersion: "0.1.45" });
  const storedRecord = {
    id: "agent-unsupported",
    provider: "gemini",
    cwd: "/tmp/history",
    createdAt: "2026-04-13T10:13:11.457Z",
    updatedAt: "2026-04-13T10:16:06.556Z",
    lastActivityAt: "2026-04-13T10:16:06.556Z",
    lastUserMessageAt: "2026-04-13T10:13:11.911Z",
    title: "Interactive Session",
    labels: {},
    lastStatus: "closed",
    lastModeId: "default",
    config: {
      title: "hello",
      modeId: "default",
      model: "gemini-2.5-flash",
    },
    runtimeInfo: {
      provider: "gemini",
      sessionId: "61c738df-7ba4-49c2-a8fd-07c1395ad1c7",
      model: "gemini-2.5-flash",
      modeId: "default",
    },
    persistence: {
      provider: "gemini",
      sessionId: "61c738df-7ba4-49c2-a8fd-07c1395ad1c7",
    },
    archivedAt: "2026-04-13T10:16:06.514Z",
  };

  session.agentStorage.list = async () => [storedRecord];
  session.agentStorage.get = async (agentId: string) =>
    agentId === storedRecord.id ? storedRecord : null;

  await expect(session.listAgentPayloads()).resolves.toEqual([]);

  await expect(session.listAgentPayloads({ includeUnavailablePersisted: true })).resolves.toEqual([
    expect.objectContaining({
      id: "agent-unsupported",
      provider: "gemini",
      providerUnavailable: true,
      persistence: null,
    }),
  ]);

  await expect(session.getAgentPayloadById("agent-unsupported")).resolves.toEqual(
    expect.objectContaining({
      id: "agent-unsupported",
      provider: "gemini",
      providerUnavailable: true,
      persistence: null,
    }),
  );
});

test("workspace reconciliation reports archived workspaces to subscribed clients", async () => {
  const missingCwd = path.join(tmpdir(), `paseo-missing-workspace-${Date.now()}`);
  rmSync(missingCwd, { recursive: true, force: true });
  const projects = new Map([
    [
      "proj-missing",
      createPersistedProjectRecord({
        projectId: "proj-missing",
        rootPath: missingCwd,
        kind: "non_git",
        displayName: "missing",
        createdAt: "2026-03-01T12:00:00.000Z",
        updatedAt: "2026-03-01T12:00:00.000Z",
      }),
    ],
  ]);
  const workspaces = new Map([
    [
      "ws-missing",
      createPersistedWorkspaceRecord({
        workspaceId: "ws-missing",
        projectId: "proj-missing",
        cwd: missingCwd,
        kind: "directory",
        displayName: "missing",
        createdAt: "2026-03-01T12:00:00.000Z",
        updatedAt: "2026-03-01T12:00:00.000Z",
      }),
    ],
  ]);
  const session = createSessionForWorkspaceTests();
  session.projectRegistry.list = async () => Array.from(projects.values());
  session.projectRegistry.archive = async (projectId: string, archivedAt: string) => {
    const project = projects.get(projectId);
    if (project) {
      projects.set(projectId, { ...project, archivedAt });
    }
  };
  session.workspaceRegistry.list = async () => Array.from(workspaces.values());
  session.workspaceRegistry.archive = async (workspaceId: string, archivedAt: string) => {
    const workspace = workspaces.get(workspaceId);
    if (workspace) {
      workspaces.set(workspaceId, { ...workspace, archivedAt });
    }
  };

  const changedWorkspaceIds = await session.reconcileActiveWorkspaceRecords();

  expect(changedWorkspaceIds).toEqual(new Set(["ws-missing"]));
  expect(workspaces.get("ws-missing")?.archivedAt).toBeTruthy();
  expect(projects.get("proj-missing")?.archivedAt).toBeTruthy();
});

test("agent_update placement does not refresh git snapshots", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const getSnapshot = vi.fn(async () => {
    throw new Error("getSnapshot should not be called for agent_update placement");
  });
  const workspaceGitService = {
    ...createNoopWorkspaceGitService(),
    getSnapshot,
    peekSnapshot: vi.fn(() => null),
  };
  const session = asTestSession(
    createSessionForWorkspaceTests({
      onMessage: (message) => emitted.push(message),
      workspaceGitService,
    }),
  );
  const project = createPersistedProjectRecord({
    projectId: "proj-1",
    rootPath: "/tmp/repo",
    kind: "git",
    displayName: "repo",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-1",
    projectId: project.projectId,
    cwd: "/tmp/repo",
    kind: "local_checkout",
    displayName: "repo",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });

  session.projectRegistry.get = async (id: string) => (id === project.projectId ? project : null);
  session.workspaceRegistry.list = async () => [workspace];
  session.agentUpdatesSubscription = {
    subscriptionId: "sub-agents",
    filter: {},
    isBootstrapping: false,
    pendingUpdatesByAgentId: new Map(),
  };

  await session.forwardAgentUpdate(
    makeManagedAgent({
      id: "agent-1",
      cwd: "/tmp/repo",
      lifecycle: "running",
      updatedAt: "2026-03-30T15:00:00.000Z",
    }),
  );

  expect(getSnapshot).not.toHaveBeenCalled();
  expect(emitted.find((message) => message.type === "agent_update")?.payload).toMatchObject({
    kind: "upsert",
    agent: {
      id: "agent-1",
      status: "running",
    },
    project: {
      projectKey: "proj-1",
      projectName: "repo",
    },
  });
});

test("agent_update emits fallback placement when no workspace is registered", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const getSnapshot = vi.fn(async () => {
    throw new Error("getSnapshot should not be called for fallback agent_update placement");
  });
  const session = asTestSession(
    createSessionForWorkspaceTests({
      onMessage: (message) => emitted.push(message),
      workspaceGitService: {
        ...createNoopWorkspaceGitService(),
        getSnapshot,
        peekSnapshot: vi.fn(() => null),
      },
    }),
  );

  session.agentUpdatesSubscription = {
    subscriptionId: "sub-agents",
    filter: {},
    isBootstrapping: false,
    pendingUpdatesByAgentId: new Map(),
  };

  await session.forwardAgentUpdate(
    makeManagedAgent({
      id: "agent-1",
      cwd: "/tmp/unregistered",
      lifecycle: "running",
      updatedAt: "2026-03-30T15:00:00.000Z",
    }),
  );

  expect(getSnapshot).not.toHaveBeenCalled();
  expect(emitted.find((message) => message.type === "agent_update")?.payload).toMatchObject({
    kind: "upsert",
    project: {
      projectKey: "/tmp/unregistered",
      projectName: "unregistered",
      checkout: {
        cwd: "/tmp/unregistered",
        isGit: false,
      },
    },
  });
});

test("archive emits an authoritative agent_update upsert for subscribed clients", async () => {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const archivedRecord = {
    id: "agent-1",
    provider: "codex",
    cwd: "/tmp/repo",
    createdAt: "2026-03-30T15:00:00.000Z",
    updatedAt: "2026-03-30T15:00:00.000Z",
    lastActivityAt: "2026-03-30T15:00:00.000Z",
    lastUserMessageAt: null,
    lastStatus: "idle",
    lastModeId: null,
    runtimeInfo: null,
    config: {
      provider: "codex",
      cwd: "/tmp/repo",
    },
    persistence: null,
    title: "Archive me",
    labels: {},
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    archivedAt: null,
  };

  const logger = {
    child: () => logger,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const session = asTestSession(
    new Session({
      clientId: "test-client",
      onMessage: (message) => emitted.push(message),
      logger: logger as unknown as SessionOptions["logger"],
      downloadTokenStore: {} as unknown as SessionOptions["downloadTokenStore"],
      pushTokenStore: {} as unknown as SessionOptions["pushTokenStore"],
      paseoHome: "/tmp/paseo-test",
      agentManager: {
        subscribe: () => () => {},
        listAgents: () => [],
        getAgent: () => null,
        archiveAgent: async () => {
          const archivedAt = new Date().toISOString();
          Object.assign(archivedRecord, {
            archivedAt,
            updatedAt: archivedAt,
          });
          return { archivedAt };
        },
        archiveSnapshot: async (_agentId: string, archivedAt: string) => {
          Object.assign(archivedRecord, { archivedAt, updatedAt: archivedAt });
          return archivedRecord;
        },
        clearAgentAttention: async () => {},
        notifyAgentState: () => {},
      } as unknown as SessionOptions["agentManager"],
      agentStorage: {
        list: async () => [archivedRecord],
        get: async (agentId: string) => (agentId === archivedRecord.id ? archivedRecord : null),
        upsert: async (record: typeof archivedRecord) => {
          Object.assign(archivedRecord, record);
        },
      } as unknown as SessionOptions["agentStorage"],
      projectRegistry: (() => {
        const proj = createPersistedProjectRecord({
          projectId: "proj-1",
          rootPath: "/tmp/repo",
          kind: "non_git",
          displayName: "repo",
          createdAt: "2026-03-01T12:00:00.000Z",
          updatedAt: "2026-03-01T12:00:00.000Z",
        });
        return {
          initialize: async () => {},
          existsOnDisk: async () => true,
          list: async () => [proj],
          get: async (id: string) => (id === "proj-1" ? proj : null),
          upsert: async () => {},
          archive: async () => {},
          remove: async () => {},
        };
      })() as unknown as SessionOptions["projectRegistry"],
      workspaceRegistry: (() => {
        const ws = createPersistedWorkspaceRecord({
          workspaceId: "ws-1",
          projectId: "proj-1",
          cwd: "/tmp/repo",
          kind: "directory",
          displayName: "repo",
          createdAt: "2026-03-01T12:00:00.000Z",
          updatedAt: "2026-03-01T12:00:00.000Z",
        });
        return {
          initialize: async () => {},
          existsOnDisk: async () => true,
          list: async () => [ws],
          get: async (id: string) => (id === "ws-1" ? ws : null),
          upsert: async () => {},
          archive: async () => {},
          remove: async () => {},
        };
      })() as unknown as SessionOptions["workspaceRegistry"],
      checkoutDiffManager: {
        subscribe: async () => ({
          initial: { cwd: "/tmp/repo", files: [], error: null },
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
      } as unknown as SessionOptions["checkoutDiffManager"],
      workspaceGitService: createNoopWorkspaceGitService(),
      daemonConfigStore: {
        get: () => ({ mcp: { injectIntoAgents: false }, providers: {} }),
        onChange: () => () => {},
      } as unknown as SessionOptions["daemonConfigStore"],
      mcpBaseUrl: null,
      stt: null,
      tts: null,
      terminalManager: null,
    }),
  );

  session.agentUpdatesSubscription = {
    subscriptionId: "sub-agents",
    filter: { includeArchived: true },
    isBootstrapping: false,
    pendingUpdatesByAgentId: new Map(),
  };

  await session.handleArchiveAgentRequest("agent-1", "req-archive");

  const update = emitted.find((message) => message.type === "agent_update");
  expect(update?.payload).toMatchObject({
    kind: "upsert",
    agent: {
      id: "agent-1",
      archivedAt: expect.any(String),
    },
  });
  expect(emitted.find((message) => message.type === "agent_archived")?.payload).toMatchObject({
    agentId: "agent-1",
    archivedAt: expect.any(String),
    requestId: "req-archive",
  });
});

test("close_items_request archives agents and kills terminals in one batch", async () => {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const archivedAt = "2026-04-01T00:00:00.000Z";
  const sessionLogger = {
    child: () => sessionLogger,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const archivedRecord = {
    id: "agent-1",
    provider: "codex",
    cwd: "/tmp/repo",
    model: null,
    thinkingOptionId: null,
    effectiveThinkingOptionId: null,
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
    lastUserMessageAt: null,
    status: "idle",
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    runtimeInfo: { provider: "codex", sessionId: null },
    title: null,
    labels: {},
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    archivedAt: null,
  };
  const session = asTestSession(
    new Session({
      clientId: "test-client",
      onMessage: (message) => emitted.push(message),
      logger: sessionLogger as unknown as SessionOptions["logger"],
      downloadTokenStore: {} as unknown as SessionOptions["downloadTokenStore"],
      pushTokenStore: {} as unknown as SessionOptions["pushTokenStore"],
      paseoHome: "/tmp/paseo-test",
      agentManager: {
        subscribe: () => () => {},
        listAgents: () => [],
        getAgent: (agentId: string) => (agentId === "agent-1" ? { id: agentId } : null),
        archiveAgent: async () => ({ archivedAt }),
        clearAgentAttention: async () => {},
        notifyAgentState: () => {},
      } as unknown as SessionOptions["agentManager"],
      agentStorage: {
        list: async () => [],
        get: async (agentId: string) => {
          if (agentId !== "agent-1") {
            return null;
          }
          archivedRecord.archivedAt = archivedAt;
          archivedRecord.updatedAt = archivedAt;
          return archivedRecord;
        },
      } as unknown as SessionOptions["agentStorage"],
      projectRegistry: (() => {
        const proj = createPersistedProjectRecord({
          projectId: "proj-close",
          rootPath: "/tmp/repo",
          kind: "non_git",
          displayName: "repo",
          createdAt: "2026-03-01T12:00:00.000Z",
          updatedAt: "2026-03-01T12:00:00.000Z",
        });
        return {
          initialize: async () => {},
          existsOnDisk: async () => true,
          list: async () => [proj],
          get: async (id: string) => (id === "proj-close" ? proj : null),
          upsert: async () => {},
          archive: async () => {},
          remove: async () => {},
        };
      })() as unknown as SessionOptions["projectRegistry"],
      workspaceRegistry: (() => {
        const ws = createPersistedWorkspaceRecord({
          workspaceId: "ws-close",
          projectId: "proj-close",
          cwd: "/tmp/repo",
          kind: "directory",
          displayName: "repo",
          createdAt: "2026-03-01T12:00:00.000Z",
          updatedAt: "2026-03-01T12:00:00.000Z",
        });
        return {
          initialize: async () => {},
          existsOnDisk: async () => true,
          list: async () => [ws],
          get: async (id: string) => (id === "ws-close" ? ws : null),
          upsert: async () => {},
          archive: async () => {},
          remove: async () => {},
        };
      })() as unknown as SessionOptions["workspaceRegistry"],
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
      } as unknown as SessionOptions["checkoutDiffManager"],
      workspaceGitService: createNoopWorkspaceGitService(),
      daemonConfigStore: {
        get: () => ({ mcp: { injectIntoAgents: false }, providers: {} }),
        onChange: () => () => {},
      } as unknown as SessionOptions["daemonConfigStore"],
      mcpBaseUrl: null,
      stt: null,
      tts: null,
      terminalManager: {
        killTerminal: vi.fn(),
        subscribeTerminalsChanged: () => () => {},
      } as unknown as SessionOptions["terminalManager"],
    }),
  );

  session.agentUpdatesSubscription = {
    subscriptionId: "sub-agents",
    filter: { includeArchived: true },
    isBootstrapping: false,
    pendingUpdatesByAgentId: new Map(),
  };
  session.interruptAgentIfRunning = vi.fn();

  await session.handleMessage({
    type: "close_items_request",
    agentIds: ["agent-1"],
    terminalIds: ["term-1"],
    requestId: "req-close-items",
  });

  expect(session.interruptAgentIfRunning).toHaveBeenCalledWith("agent-1");
  expect(session.terminalManager?.killTerminal).toHaveBeenCalledWith("term-1");
  expect(emitted.find((message) => message.type === "close_items_response")?.payload).toEqual({
    agents: [{ agentId: "agent-1", archivedAt }],
    terminals: [{ terminalId: "term-1", success: true }],
    requestId: "req-close-items",
  });
  expect(emitted.find((message) => message.type === "agent_update")?.payload).toMatchObject({
    kind: "upsert",
    agent: {
      id: "agent-1",
      archivedAt,
    },
  });
});

test("close_items_request archives stored agents that are not currently loaded", async () => {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const sessionLogger = {
    child: () => sessionLogger,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const liveArchivedAt = "2026-04-01T00:00:00.000Z";
  const storedAgentId = "agent-stored";
  const liveRecord = {
    ...makeAgent({
      id: "agent-live",
      cwd: "/tmp/repo",
      status: "idle",
      updatedAt: "2026-03-01T12:00:00.000Z",
    }),
    archivedAt: null as string | null,
  };
  const storedRecord = {
    ...makeAgent({
      id: storedAgentId,
      cwd: "/tmp/repo",
      status: "idle",
      updatedAt: "2026-03-01T12:05:00.000Z",
    }),
    archivedAt: null as string | null,
  };
  const upsertStoredRecord = vi.fn(async (record: typeof storedRecord) => {
    if (record.id === storedAgentId) {
      storedRecord.archivedAt = record.archivedAt;
      storedRecord.updatedAt = record.updatedAt;
      storedRecord.status = record.status;
      storedRecord.requiresAttention = record.requiresAttention;
      storedRecord.attentionReason = record.attentionReason;
      storedRecord.attentionTimestamp = record.attentionTimestamp;
    }
  });

  const session = asTestSession(
    new Session({
      clientId: "test-client",
      onMessage: (message) => emitted.push(message),
      logger: sessionLogger as unknown as SessionOptions["logger"],
      downloadTokenStore: {} as unknown as SessionOptions["downloadTokenStore"],
      pushTokenStore: {} as unknown as SessionOptions["pushTokenStore"],
      paseoHome: "/tmp/paseo-test",
      agentManager: {
        subscribe: () => () => {},
        listAgents: () => [],
        getAgent: (agentId: string) => (agentId === "agent-live" ? { id: agentId } : null),
        archiveAgent: async (agentId: string) => {
          if (agentId !== "agent-live") {
            throw new Error(`Unexpected live archive: ${agentId}`);
          }
          liveRecord.archivedAt = liveArchivedAt;
          liveRecord.updatedAt = liveArchivedAt;
          return { archivedAt: liveArchivedAt };
        },
        archiveSnapshot: async (_agentId: string, archivedAt: string) => {
          storedRecord.archivedAt = archivedAt;
          storedRecord.updatedAt = archivedAt;
          storedRecord.status = "completed";
          storedRecord.requiresAttention = false;
          storedRecord.attentionReason = null;
          storedRecord.attentionTimestamp = null;
          return storedRecord;
        },
        clearAgentAttention: async () => {},
        notifyAgentState: () => {},
      } as unknown as SessionOptions["agentManager"],
      agentStorage: {
        list: async () => [],
        get: async (agentId: string) => {
          if (agentId === "agent-live") {
            return liveRecord;
          }
          if (agentId === storedAgentId) {
            return storedRecord;
          }
          return null;
        },
        upsert: upsertStoredRecord,
      } as unknown as SessionOptions["agentStorage"],
      projectRegistry: (() => {
        const proj = createPersistedProjectRecord({
          projectId: "proj-stored",
          rootPath: "/tmp/repo",
          kind: "non_git",
          displayName: "repo",
          createdAt: "2026-03-01T12:00:00.000Z",
          updatedAt: "2026-03-01T12:00:00.000Z",
        });
        return {
          initialize: async () => {},
          existsOnDisk: async () => true,
          list: async () => [proj],
          get: async (id: string) => (id === "proj-stored" ? proj : null),
          upsert: async () => {},
          archive: async () => {},
          remove: async () => {},
        };
      })() as unknown as SessionOptions["projectRegistry"],
      workspaceRegistry: (() => {
        const ws = createPersistedWorkspaceRecord({
          workspaceId: "ws-stored",
          projectId: "proj-stored",
          cwd: "/tmp/repo",
          kind: "directory",
          displayName: "repo",
          createdAt: "2026-03-01T12:00:00.000Z",
          updatedAt: "2026-03-01T12:00:00.000Z",
        });
        return {
          initialize: async () => {},
          existsOnDisk: async () => true,
          list: async () => [ws],
          get: async (id: string) => (id === "ws-stored" ? ws : null),
          upsert: async () => {},
          archive: async () => {},
          remove: async () => {},
        };
      })() as unknown as SessionOptions["workspaceRegistry"],
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
      } as unknown as SessionOptions["checkoutDiffManager"],
      workspaceGitService: createNoopWorkspaceGitService(),
      daemonConfigStore: {
        get: () => ({ mcp: { injectIntoAgents: false }, providers: {} }),
        onChange: () => () => {},
      } as unknown as SessionOptions["daemonConfigStore"],
      mcpBaseUrl: null,
      stt: null,
      tts: null,
      terminalManager: {
        killTerminal: vi.fn(),
        subscribeTerminalsChanged: () => () => {},
      } as unknown as SessionOptions["terminalManager"],
    }),
  );

  session.agentUpdatesSubscription = {
    subscriptionId: "sub-agents",
    filter: { includeArchived: true },
    isBootstrapping: false,
    pendingUpdatesByAgentId: new Map(),
  };
  session.interruptAgentIfRunning = vi.fn();

  await session.handleMessage({
    type: "close_items_request",
    agentIds: ["agent-live", storedAgentId],
    terminalIds: [],
    requestId: "req-close-stored",
  });

  expect(storedRecord.archivedAt).toEqual(expect.any(String));
  expect(emitted.find((message) => message.type === "close_items_response")?.payload).toEqual({
    agents: [
      { agentId: "agent-live", archivedAt: liveArchivedAt },
      { agentId: storedAgentId, archivedAt: storedRecord.archivedAt },
    ],
    terminals: [],
    requestId: "req-close-stored",
  });
  expect(sessionLogger.warn).not.toHaveBeenCalled();
});

test("close_items_request continues after an archive failure", async () => {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const sessionLogger = {
    child: () => sessionLogger,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const archivedAt = "2026-04-01T00:00:00.000Z";
  const goodRecord = {
    ...makeAgent({
      id: "agent-good",
      cwd: "/tmp/repo",
      status: "idle",
      updatedAt: "2026-03-01T12:00:00.000Z",
    }),
    archivedAt: null as string | null,
  };
  const session = asTestSession(
    new Session({
      clientId: "test-client",
      onMessage: (message) => emitted.push(message),
      logger: sessionLogger as unknown as SessionOptions["logger"],
      downloadTokenStore: {} as unknown as SessionOptions["downloadTokenStore"],
      pushTokenStore: {} as unknown as SessionOptions["pushTokenStore"],
      paseoHome: "/tmp/paseo-test",
      agentManager: {
        subscribe: () => () => {},
        listAgents: () => [],
        getAgent: (agentId: string) =>
          agentId === "agent-bad" || agentId === "agent-good" ? { id: agentId } : null,
        archiveAgent: async (agentId: string) => {
          if (agentId === "agent-bad") {
            throw new Error("archive failed");
          }
          return { archivedAt };
        },
        clearAgentAttention: async () => {},
        notifyAgentState: () => {},
      } as unknown as SessionOptions["agentManager"],
      agentStorage: {
        list: async () => [],
        get: async (agentId: string) => {
          if (agentId !== "agent-good") {
            return null;
          }
          goodRecord.archivedAt = archivedAt;
          goodRecord.updatedAt = archivedAt;
          return goodRecord;
        },
      } as unknown as SessionOptions["agentStorage"],
      projectRegistry: (() => {
        const proj = createPersistedProjectRecord({
          projectId: "proj-err",
          rootPath: "/tmp/repo",
          kind: "non_git",
          displayName: "repo",
          createdAt: "2026-03-01T12:00:00.000Z",
          updatedAt: "2026-03-01T12:00:00.000Z",
        });
        return {
          initialize: async () => {},
          existsOnDisk: async () => true,
          list: async () => [proj],
          get: async (id: string) => (id === "proj-err" ? proj : null),
          upsert: async () => {},
          archive: async () => {},
          remove: async () => {},
        };
      })() as unknown as SessionOptions["projectRegistry"],
      workspaceRegistry: (() => {
        const ws = createPersistedWorkspaceRecord({
          workspaceId: "ws-err",
          projectId: "proj-err",
          cwd: "/tmp/repo",
          kind: "directory",
          displayName: "repo",
          createdAt: "2026-03-01T12:00:00.000Z",
          updatedAt: "2026-03-01T12:00:00.000Z",
        });
        return {
          initialize: async () => {},
          existsOnDisk: async () => true,
          list: async () => [ws],
          get: async (id: string) => (id === "ws-err" ? ws : null),
          upsert: async () => {},
          archive: async () => {},
          remove: async () => {},
        };
      })() as unknown as SessionOptions["workspaceRegistry"],
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
      } as unknown as SessionOptions["checkoutDiffManager"],
      workspaceGitService: createNoopWorkspaceGitService(),
      daemonConfigStore: {
        get: () => ({ mcp: { injectIntoAgents: false }, providers: {} }),
        onChange: () => () => {},
      } as unknown as SessionOptions["daemonConfigStore"],
      mcpBaseUrl: null,
      stt: null,
      tts: null,
      terminalManager: {
        killTerminal: vi.fn(),
        subscribeTerminalsChanged: () => () => {},
      } as unknown as SessionOptions["terminalManager"],
    }),
  );

  session.agentUpdatesSubscription = {
    subscriptionId: "sub-agents",
    filter: { includeArchived: true },
    isBootstrapping: false,
    pendingUpdatesByAgentId: new Map(),
  };
  session.interruptAgentIfRunning = vi.fn();

  await session.handleMessage({
    type: "close_items_request",
    agentIds: ["agent-bad", "agent-good"],
    terminalIds: ["term-1"],
    requestId: "req-close-best-effort",
  });

  expect(session.interruptAgentIfRunning).toHaveBeenCalledWith("agent-bad");
  expect(session.interruptAgentIfRunning).toHaveBeenCalledWith("agent-good");
  expect(session.terminalManager?.killTerminal).toHaveBeenCalledWith("term-1");
  expect(emitted.find((message) => message.type === "close_items_response")?.payload).toEqual({
    agents: [{ agentId: "agent-good", archivedAt }],
    terminals: [{ terminalId: "term-1", success: true }],
    requestId: "req-close-best-effort",
  });
  expect(emitted.find((message) => message.type === "agent_update")?.payload).toMatchObject({
    kind: "upsert",
    agent: {
      id: "agent-good",
      archivedAt,
    },
  });
  expect(sessionLogger.warn).toHaveBeenCalled();
});

test("non-git workspace uses deterministic directory name and no unknown branch fallback", async () => {
  const session = createSessionForWorkspaceTests();
  session.workspaceRegistry.list = async () => [
    createPersistedWorkspaceRecord({
      workspaceId: "ws-non-git",
      projectId: "proj-non-git",
      cwd: "/tmp/non-git",
      kind: "directory",
      displayName: "non-git",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
    }),
  ];
  session.listAgentPayloads = async () => [
    makeAgent({
      id: "a1",
      cwd: "/tmp/non-git",
      status: "idle",
      updatedAt: "2026-03-01T12:00:00.000Z",
    }),
  ];
  const result = await session.listFetchWorkspacesEntries({
    type: "fetch_workspaces_request",
    requestId: "req-1",
  });

  expect(result.entries).toHaveLength(1);
  expect(result.entries[0]?.name).toBe("non-git");
  expect(result.entries[0]?.name).not.toBe("Unknown branch");
});

test("active-scoped fetch_agents includes only unarchived agents in active exact workspaces", async () => {
  const session = createSessionForWorkspaceTests();
  const archivedAt = "2026-03-02T12:00:00.000Z";
  const activeProject = createPersistedProjectRecord({
    projectId: "proj-active",
    rootPath: "/tmp/active",
    kind: "non_git",
    displayName: "active",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const archivedProject = createPersistedProjectRecord({
    projectId: "proj-archived",
    rootPath: "/tmp/archived-project",
    kind: "non_git",
    displayName: "archived project",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
    archivedAt,
  });
  const activeWorkspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-active",
    projectId: activeProject.projectId,
    cwd: "/tmp/active",
    kind: "directory",
    displayName: "active",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const archivedWorkspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-archived",
    projectId: activeProject.projectId,
    cwd: "/tmp/archived-workspace",
    kind: "directory",
    displayName: "archived workspace",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
    archivedAt,
  });
  const workspaceInArchivedProject = createPersistedWorkspaceRecord({
    workspaceId: "ws-archived-project",
    projectId: archivedProject.projectId,
    cwd: "/tmp/archived-project",
    kind: "directory",
    displayName: "archived project",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });

  session.projectRegistry.list = async () => [activeProject, archivedProject];
  session.projectRegistry.get = async (projectId: string) =>
    [activeProject, archivedProject].find((project) => project.projectId === projectId) ?? null;
  session.workspaceRegistry.list = async () => [
    activeWorkspace,
    archivedWorkspace,
    workspaceInArchivedProject,
  ];
  session.listAgentPayloads = async () => [
    makeAgent({
      id: "agent-active",
      cwd: "/tmp/active",
      status: "idle",
      updatedAt: "2026-03-01T12:04:00.000Z",
    }),
    makeAgent({
      id: "agent-subdir",
      cwd: "/tmp/active/packages/app",
      status: "idle",
      updatedAt: "2026-03-01T12:03:00.000Z",
    }),
    makeAgent({
      id: "agent-archived-workspace",
      cwd: "/tmp/archived-workspace",
      status: "idle",
      updatedAt: "2026-03-01T12:02:00.000Z",
    }),
    makeAgent({
      id: "agent-archived-project",
      cwd: "/tmp/archived-project",
      status: "idle",
      updatedAt: "2026-03-01T12:01:00.000Z",
    }),
    {
      ...makeAgent({
        id: "agent-archived",
        cwd: "/tmp/active",
        status: "idle",
        updatedAt: "2026-03-01T12:00:00.000Z",
      }),
      archivedAt,
    },
  ];

  const result = await session.listFetchAgentsEntries({
    type: "fetch_agents_request",
    requestId: "req-active-agents",
    scope: "active",
    filter: { includeArchived: true },
  });

  expect(agentIdsFromEntries(result.entries)).toEqual(["agent-active"]);
  expect(result.pageInfo.hasMore).toBe(false);
});

test("active-scoped fetch_agents pages within active scope instead of global history", async () => {
  const session = createSessionForWorkspaceTests();
  const project = createPersistedProjectRecord({
    projectId: "proj-active-pages",
    rootPath: "/tmp/pages",
    kind: "non_git",
    displayName: "pages",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const activeOne = createPersistedWorkspaceRecord({
    workspaceId: "ws-active-one",
    projectId: project.projectId,
    cwd: "/tmp/pages/one",
    kind: "directory",
    displayName: "one",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const activeTwo = createPersistedWorkspaceRecord({
    workspaceId: "ws-active-two",
    projectId: project.projectId,
    cwd: "/tmp/pages/two",
    kind: "directory",
    displayName: "two",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const archivedWorkspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-stale",
    projectId: project.projectId,
    cwd: "/tmp/pages/stale",
    kind: "directory",
    displayName: "stale",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
    archivedAt: "2026-03-02T12:00:00.000Z",
  });

  session.projectRegistry.list = async () => [project];
  session.projectRegistry.get = async () => project;
  session.workspaceRegistry.list = async () => [activeOne, activeTwo, archivedWorkspace];
  session.listAgentPayloads = async () => [
    makeAgent({
      id: "active-one",
      cwd: "/tmp/pages/one",
      status: "idle",
      updatedAt: "2026-03-01T12:03:00.000Z",
    }),
    makeAgent({
      id: "stale-between",
      cwd: "/tmp/pages/stale",
      status: "idle",
      updatedAt: "2026-03-01T12:02:00.000Z",
    }),
    makeAgent({
      id: "active-two",
      cwd: "/tmp/pages/two",
      status: "idle",
      updatedAt: "2026-03-01T12:01:00.000Z",
    }),
  ];

  const firstPage = await session.listFetchAgentsEntries({
    type: "fetch_agents_request",
    requestId: "req-active-page-1",
    scope: "active",
    page: { limit: 1 },
  });
  const secondPage = await session.listFetchAgentsEntries({
    type: "fetch_agents_request",
    requestId: "req-active-page-2",
    scope: "active",
    page: { limit: 1, cursor: firstPage.pageInfo.nextCursor },
  });

  expect(agentIdsFromEntries(firstPage.entries)).toEqual(["active-one"]);
  expect(firstPage.pageInfo.hasMore).toBe(true);
  expect(agentIdsFromEntries(secondPage.entries)).toEqual(["active-two"]);
  expect(secondPage.pageInfo.hasMore).toBe(false);
});

test("legacy unscoped fetch_agents keeps global workspace behavior", async () => {
  const session = createSessionForWorkspaceTests();
  const project = createPersistedProjectRecord({
    projectId: "proj-legacy-global",
    rootPath: "/tmp/legacy",
    kind: "non_git",
    displayName: "legacy",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const activeWorkspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-legacy-active",
    projectId: project.projectId,
    cwd: "/tmp/legacy/active",
    kind: "directory",
    displayName: "active",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const archivedWorkspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-legacy-archived",
    projectId: project.projectId,
    cwd: "/tmp/legacy/archived",
    kind: "directory",
    displayName: "archived",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
    archivedAt: "2026-03-02T12:00:00.000Z",
  });

  session.projectRegistry.get = async () => project;
  session.workspaceRegistry.list = async () => [activeWorkspace, archivedWorkspace];
  session.listAgentPayloads = async () => [
    makeAgent({
      id: "legacy-active",
      cwd: "/tmp/legacy/active",
      status: "idle",
      updatedAt: "2026-03-01T12:01:00.000Z",
    }),
    makeAgent({
      id: "legacy-archived-workspace",
      cwd: "/tmp/legacy/archived",
      status: "idle",
      updatedAt: "2026-03-01T12:00:00.000Z",
    }),
  ];

  const result = await session.listFetchAgentsEntries({
    type: "fetch_agents_request",
    requestId: "req-legacy-global",
  });

  expect(agentIdsFromEntries(result.entries)).toEqual([
    "legacy-active",
    "legacy-archived-workspace",
  ]);
});

test("fetch_agent_history_request pages archived historical rows separately", async () => {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const session = createSessionForWorkspaceTests();
  const project = createPersistedProjectRecord({
    projectId: "proj-history",
    rootPath: "/tmp/history",
    kind: "non_git",
    displayName: "history",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-history",
    projectId: project.projectId,
    cwd: "/tmp/history",
    kind: "directory",
    displayName: "history",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
    archivedAt: "2026-03-02T12:00:00.000Z",
  });

  session.emit = (message) => emitted.push(message as { type: string; payload: unknown });
  session.projectRegistry.get = async () => project;
  session.workspaceRegistry.list = async () => [workspace];
  session.listAgentPayloads = async () => [
    {
      ...makeAgent({
        id: "history-archived",
        cwd: "/tmp/history",
        status: "idle",
        updatedAt: "2026-03-01T12:00:00.000Z",
      }),
      archivedAt: "2026-03-02T12:00:00.000Z",
    },
  ];

  await session.handleMessage({
    type: "fetch_agent_history_request",
    requestId: "req-history",
    page: { limit: 25 },
  });

  expect(emitted).toEqual([
    {
      type: "fetch_agent_history_response",
      payload: expect.objectContaining({
        requestId: "req-history",
        entries: [
          expect.objectContaining({
            agent: expect.objectContaining({ id: "history-archived" }),
          }),
        ],
        pageInfo: {
          nextCursor: null,
          prevCursor: null,
          hasMore: false,
        },
      }),
    },
  ]);
  expect(session.agentUpdatesSubscription).toBeNull();
});

test("fetch_agent_request still resolves archived historical agents", async () => {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const session = createSessionForWorkspaceTests();
  const agent = {
    ...makeAgent({
      id: "archived-history-agent",
      cwd: "/tmp/history-detail",
      status: "idle",
      updatedAt: "2026-03-01T12:00:00.000Z",
    }),
    archivedAt: "2026-03-02T12:00:00.000Z",
    title: "Archived History Agent",
  };
  session.emit = (message) => emitted.push(message as { type: string; payload: unknown });
  session.resolveAgentIdentifier = async (identifier: string) =>
    identifier === "Archived History Agent"
      ? { ok: true, agentId: agent.id }
      : { ok: false, error: `Agent not found: ${identifier}` };
  session.getAgentPayloadById = async (agentId: string) => (agentId === agent.id ? agent : null);
  session.buildProjectPlacementForCwd = async (cwd: string) => ({
    projectKey: "proj-history-detail",
    projectName: "history detail",
    checkout: {
      cwd,
      isGit: false,
      currentBranch: null,
      remoteUrl: null,
      worktreeRoot: null,
      isPaseoOwnedWorktree: false,
      mainRepoRoot: null,
    },
  });

  await session.handleMessage({
    type: "fetch_agent_request",
    requestId: "req-agent-detail",
    agentId: "Archived History Agent",
  });

  expect(emitted).toEqual([
    {
      type: "fetch_agent_response",
      payload: {
        requestId: "req-agent-detail",
        agent,
        project: expect.objectContaining({
          projectKey: "proj-history-detail",
        }),
        error: null,
      },
    },
  ]);
});

test("git branch workspace uses branch as canonical name", async () => {
  const session = createSessionForWorkspaceTests();
  session.workspaceRegistry.list = async () => [
    createPersistedWorkspaceRecord({
      workspaceId: "ws-repo-branch",
      projectId: "proj-repo-branch",
      cwd: "/tmp/repo-branch",
      kind: "local_checkout",
      displayName: "feature/name-from-server",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
    }),
  ];
  session.listAgentPayloads = async () => [
    makeAgent({
      id: "a1",
      cwd: "/tmp/repo-branch",
      status: "running",
      updatedAt: "2026-03-01T12:00:00.000Z",
    }),
  ];
  session.buildProjectPlacement = async (cwd: string) => ({
    projectKey: cwd,
    projectName: "repo-branch",
    checkout: {
      cwd,
      isGit: true,
      currentBranch: "feature/name-from-server",
      remoteUrl: "https://github.com/acme/repo-branch.git",
      worktreeRoot: cwd,
      isPaseoOwnedWorktree: false,
      mainRepoRoot: null,
    },
  });
  const result = await session.listFetchWorkspacesEntries({
    type: "fetch_workspaces_request",
    requestId: "req-branch",
  });

  expect(result.entries).toHaveLength(1);
  expect(result.entries[0]?.name).toBe("feature/name-from-server");
});

test("branch/detached policies and dominant status bucket are deterministic", async () => {
  const session = createSessionForWorkspaceTests();
  session.workspaceRegistry.list = async () => [
    createPersistedWorkspaceRecord({
      workspaceId: "ws-repo-status",
      projectId: "proj-repo-status",
      cwd: "/tmp/repo",
      kind: "local_checkout",
      displayName: "repo",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
    }),
  ];
  session.listAgentPayloads = async () => [
    makeAgent({
      id: "a1",
      cwd: "/tmp/repo",
      status: "running",
      updatedAt: "2026-03-01T12:00:00.000Z",
    }),
    makeAgent({
      id: "a2",
      cwd: "/tmp/repo",
      status: "error",
      updatedAt: "2026-03-01T12:01:00.000Z",
    }),
    makeAgent({
      id: "a3",
      cwd: "/tmp/repo",
      status: "idle",
      updatedAt: "2026-03-01T12:02:00.000Z",
      pendingPermissions: 1,
    }),
  ];
  const result = await session.listFetchWorkspacesEntries({
    type: "fetch_workspaces_request",
    requestId: "req-2",
  });

  expect(result.entries).toHaveLength(1);
  expect(result.entries[0]?.name).toBe("repo");
  expect(result.entries[0]?.status).toBe("needs_input");
});

test("subdirectory agents map to an existing parent workspace descriptor", async () => {
  const session = createSessionForWorkspaceTests();
  session.workspaceRegistry.list = async () => [
    createPersistedWorkspaceRecord({
      workspaceId: "ws-repo-subdir",
      projectId: "proj-repo-subdir",
      cwd: "/tmp/repo",
      kind: "local_checkout",
      displayName: "main",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
    }),
  ];
  session.listAgentPayloads = async () => [
    makeAgent({
      id: "a1",
      cwd: "/tmp/repo/packages/app",
      status: "running",
      updatedAt: "2026-03-01T12:03:00.000Z",
    }),
  ];

  const result = await session.listFetchWorkspacesEntries({
    type: "fetch_workspaces_request",
    requestId: "req-subdir-agent",
  });

  expect(result.entries).toHaveLength(1);
  expect(result.entries[0]).toMatchObject({
    id: "ws-repo-subdir",
    status: "done",
    activityAt: null,
  });
});

test("workspace update stream keeps persisted workspace visible after agents stop", async () => {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const logger = {
    child: () => logger,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const session = asTestSession(
    new Session({
      clientId: "test-client",
      onMessage: (message) => emitted.push(message),
      logger: logger as unknown as SessionOptions["logger"],
      downloadTokenStore: {} as unknown as SessionOptions["downloadTokenStore"],
      pushTokenStore: {} as unknown as SessionOptions["pushTokenStore"],
      paseoHome: "/tmp/paseo-test",
      agentManager: {
        subscribe: () => () => {},
        listAgents: () => [],
        getAgent: () => null,
      } as unknown as SessionOptions["agentManager"],
      agentStorage: {
        list: async () => [],
        get: async () => null,
      } as unknown as SessionOptions["agentStorage"],
      projectRegistry: {
        initialize: async () => {},
        existsOnDisk: async () => true,
        list: async () => [],
        get: async () => null,
        upsert: async () => {},
        archive: async () => {},
        remove: async () => {},
      } as unknown as SessionOptions["projectRegistry"],
      workspaceRegistry: {
        initialize: async () => {},
        existsOnDisk: async () => true,
        list: async () => [],
        get: async () => null,
        upsert: async () => {},
        archive: async () => {},
        remove: async () => {},
      } as unknown as SessionOptions["workspaceRegistry"],
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
      } as unknown as SessionOptions["checkoutDiffManager"],
      workspaceGitService: createNoopWorkspaceGitService(),
      mcpBaseUrl: null,
      stt: null,
      tts: null,
      terminalManager: null,
    }),
  );

  session.workspaceUpdatesSubscription = {
    subscriptionId: "sub-1",
    filter: undefined,
    isBootstrapping: false,
    pendingUpdatesByWorkspaceId: new Map(),
    lastEmittedByWorkspaceId: new Map(),
  };
  session.reconcileActiveWorkspaceRecords = async () => new Set();

  session.buildWorkspaceDescriptorMap = async () =>
    new Map([
      [
        "/tmp/repo",
        {
          id: "ws-repo-running",
          projectId: "proj-repo-running",
          projectDisplayName: "repo",
          projectRootPath: "/tmp/repo",
          projectKind: "non_git",
          workspaceKind: "directory",
          name: "repo",
          status: "running",
          activityAt: "2026-03-01T12:00:00.000Z",
        },
      ],
    ]);
  await session.emitWorkspaceUpdateForCwd("/tmp/repo");

  session.buildWorkspaceDescriptorMap = async () =>
    new Map([
      [
        "/tmp/repo",
        {
          id: "ws-repo-running",
          projectId: "proj-repo-running",
          projectDisplayName: "repo",
          projectRootPath: "/tmp/repo",
          projectKind: "non_git",
          workspaceKind: "directory",
          name: "repo",
          status: "done",
          activityAt: null,
        },
      ],
    ]);
  await session.emitWorkspaceUpdateForCwd("/tmp/repo");

  const workspaceUpdates = emitted.filter((message) => message.type === "workspace_update");
  expect(workspaceUpdates).toHaveLength(2);
  expect((workspaceUpdates[0] as { payload: { kind: string } }).payload.kind).toBe("upsert");
  expect((workspaceUpdates[1] as { payload: unknown }).payload).toEqual({
    kind: "upsert",
    workspace: {
      id: "ws-repo-running",
      projectId: "proj-repo-running",
      projectDisplayName: "repo",
      projectRootPath: "/tmp/repo",
      projectKind: "non_git",
      workspaceKind: "directory",
      name: "repo",
      status: "done",
      activityAt: null,
    },
  });
});

test("create paseo worktree request returns a registered workspace descriptor", async () => {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const tempDir = realpathSync(mkdtempSync(path.join(tmpdir(), "session-worktree-test-")));
  const repoDir = path.join(tempDir, "repo");
  const paseoHome = path.join(tempDir, "paseo-home");
  execSync(`mkdir -p ${repoDir}`);
  execSync("git init -b main", { cwd: repoDir, stdio: "pipe" });
  execSync("git config user.email 'test@test.com'", { cwd: repoDir, stdio: "pipe" });
  execSync("git config user.name 'Test'", { cwd: repoDir, stdio: "pipe" });
  writeFileSync(path.join(repoDir, "file.txt"), "hello\n");
  execSync("git add .", { cwd: repoDir, stdio: "pipe" });
  execSync("git -c commit.gpgsign=false commit -m 'initial'", { cwd: repoDir, stdio: "pipe" });
  const workspaceGitService = createNoopWorkspaceGitService();
  workspaceGitService.getSnapshot = vi.fn(async (cwd: string) => {
    if (cwd === repoDir) {
      return createWorkspaceRuntimeSnapshot(cwd, {
        git: {
          repoRoot: repoDir,
          currentBranch: "main",
          remoteUrl: null,
          isPaseoOwnedWorktree: false,
          mainRepoRoot: null,
        },
      });
    }

    if (cwd.includes("worktree-123")) {
      return createWorkspaceRuntimeSnapshot(cwd, {
        git: {
          repoRoot: cwd,
          currentBranch: "worktree-123",
          remoteUrl: null,
          isPaseoOwnedWorktree: true,
          mainRepoRoot: repoDir,
        },
      });
    }

    return createWorkspaceRuntimeSnapshot(cwd, {
      git: {
        repoRoot: cwd,
        currentBranch: "main",
        remoteUrl: null,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    });
  });
  const session = asTestSession(
    createSessionForWorkspaceTests({
      workspaceGitService,
    }),
  );

  const workspaces = new Map();
  const projects = new Map();
  session.paseoHome = paseoHome;
  session.workspaceRegistry.get = async (workspaceId: string) =>
    workspaces.get(workspaceId) ?? null;
  session.workspaceRegistry.list = async () => Array.from(workspaces.values());
  session.workspaceRegistry.upsert = async (record: unknown) => {
    const typed = record as ReturnType<typeof createPersistedWorkspaceRecord>;
    workspaces.set(typed.workspaceId, typed);
  };
  session.projectRegistry.get = async (projectId: string) => projects.get(projectId) ?? null;
  session.projectRegistry.list = async () => Array.from(projects.values());
  session.projectRegistry.upsert = async (record: unknown) => {
    const typed = record as ReturnType<typeof createPersistedProjectRecord>;
    projects.set(typed.projectId, typed);
  };
  session.emit = (message: { type: string; payload: unknown }) => {
    emitted.push(message);
  };
  try {
    await session.handleCreatePaseoWorktreeRequest({
      type: "create_paseo_worktree_request",
      cwd: repoDir,
      worktreeSlug: "worktree-123",
      requestId: "req-worktree",
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  const response = emitted.find((message) => message.type === "create_paseo_worktree_response") as
    | {
        type: "create_paseo_worktree_response";
        payload: {
          error: unknown;
          workspace?: { id: string; projectId: string; [key: string]: unknown };
        };
      }
    | undefined;

  expect(response?.payload.error).toBeNull();
  expect(response?.payload.workspace).toMatchObject({
    projectDisplayName: "repo",
    projectKind: "git",
    workspaceKind: "worktree",
    name: "worktree-123",
    status: "done",
  });
  expect(response?.payload.workspace?.id).toContain(path.join("worktree-123"));
  expect(workspaces.has(response?.payload.workspace?.id ?? "")).toBe(true);
  expect(projects.has(response?.payload.workspace?.projectId ?? "")).toBe(true);
});

test("workspace update fanout for multiple cwd values is deduplicated", async () => {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const session = createSessionForWorkspaceTests();
  session.workspaceRegistry.list = async () => [
    createPersistedWorkspaceRecord({
      workspaceId: "ws-repo-main",
      projectId: "proj-repo-main",
      cwd: "/tmp/repo",
      kind: "local_checkout",
      displayName: "main",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
    }),
    createPersistedWorkspaceRecord({
      workspaceId: "ws-repo-feature",
      projectId: "proj-repo-main",
      cwd: "/tmp/repo/worktree",
      kind: "worktree",
      displayName: "feature",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
    }),
  ];
  session.workspaceUpdatesSubscription = {
    subscriptionId: "sub-dedup",
    filter: undefined,
    isBootstrapping: false,
    pendingUpdatesByWorkspaceId: new Map(),
    lastEmittedByWorkspaceId: new Map(),
  };
  session.reconcileActiveWorkspaceRecords = async () =>
    new Set(["ws-repo-main", "ws-repo-feature"]);
  session.buildWorkspaceDescriptorMap = async () =>
    new Map([
      [
        "ws-repo-main",
        {
          id: "ws-repo-main",
          projectId: "proj-repo-main",
          projectDisplayName: "repo",
          projectRootPath: "/tmp/repo",
          projectKind: "git",
          workspaceKind: "local_checkout",
          name: "main",
          status: "done",
          activityAt: null,
        },
      ],
      [
        "ws-repo-feature",
        {
          id: "ws-repo-feature",
          projectId: "proj-repo-main",
          projectDisplayName: "repo",
          projectRootPath: "/tmp/repo",
          projectKind: "git",
          workspaceKind: "worktree",
          name: "feature",
          status: "running",
          activityAt: "2026-03-01T12:00:00.000Z",
        },
      ],
    ]);
  session.onMessage = (message: { type: string; payload: unknown }) => {
    emitted.push(message);
  };

  await session.emitWorkspaceUpdateForCwd("/tmp/repo/worktree");
  await new Promise((resolve) => setTimeout(resolve, 0));

  const workspaceUpdates = emitted.filter(
    (message) => message.type === "workspace_update",
  ) as Array<{ payload: { kind: string; workspace: { id: string } } }>;
  expect(workspaceUpdates).toHaveLength(2);
  expect(workspaceUpdates.map((entry) => entry.payload.kind)).toEqual(["upsert", "upsert"]);
  expect(workspaceUpdates.map((entry) => entry.payload.workspace.id).sort()).toEqual([
    "ws-repo-feature",
    "ws-repo-main",
  ]);
});

test("open_project_request registers a workspace before any agent exists", async () => {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const session = createSessionForWorkspaceTests();
  const projects = new Map<string, ReturnType<typeof createPersistedProjectRecord>>();
  const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>();

  session.emit = (message) => emitted.push(message as { type: string; payload: unknown });
  session.projectRegistry.get = async (projectId: string) => projects.get(projectId) ?? null;
  session.projectRegistry.upsert = async (
    record: ReturnType<typeof createPersistedProjectRecord>,
  ) => {
    projects.set(record.projectId, record);
  };
  session.workspaceRegistry.get = async (workspaceId: string) =>
    workspaces.get(workspaceId) ?? null;
  session.workspaceRegistry.upsert = async (
    record: ReturnType<typeof createPersistedWorkspaceRecord>,
  ) => {
    workspaces.set(record.workspaceId, record);
  };
  session.projectRegistry.list = async () => Array.from(projects.values());
  session.workspaceRegistry.list = async () => Array.from(workspaces.values());
  session.buildProjectPlacement = async (cwd: string) => ({
    projectKey: cwd,
    projectName: "repo",
    checkout: {
      cwd,
      isGit: false,
      currentBranch: null,
      remoteUrl: null,
      worktreeRoot: null,
      isPaseoOwnedWorktree: false,
      mainRepoRoot: null,
    },
  });

  await session.handleMessage({
    type: "open_project_request",
    cwd: "/tmp/repo",
    requestId: "req-open",
  });

  expect(workspaces.get("/tmp/repo")).toBeTruthy();
  const response = emitted.find((message) => message.type === "open_project_response") as
    | { payload: { error: unknown; workspace?: { id: string } } }
    | undefined;
  expect(response?.payload.error).toBeNull();
  expect(response?.payload.workspace?.id).toBe("/tmp/repo");
});

test("open_project_response returns immediately even when the GitHub fetch is slow", async () => {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const session = createSessionForWorkspaceTests();
  const projects = new Map<string, ReturnType<typeof createPersistedProjectRecord>>();
  const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>();
  const cwd = "/tmp/slow-github-repo";

  session.emit = (message) => emitted.push(message as { type: string; payload: unknown });
  session.projectRegistry.get = async (projectId: string) => projects.get(projectId) ?? null;
  session.projectRegistry.upsert = async (
    record: ReturnType<typeof createPersistedProjectRecord>,
  ) => {
    projects.set(record.projectId, record);
  };
  session.workspaceRegistry.get = async (workspaceId: string) =>
    workspaces.get(workspaceId) ?? null;
  session.workspaceRegistry.upsert = async (
    record: ReturnType<typeof createPersistedWorkspaceRecord>,
  ) => {
    workspaces.set(record.workspaceId, record);
  };
  session.projectRegistry.list = async () => Array.from(projects.values());
  session.workspaceRegistry.list = async () => Array.from(workspaces.values());
  session.workspaceGitService.getCheckout = async (requestedCwd: string) => ({
    cwd: requestedCwd,
    isGit: true,
    currentBranch: "main",
    remoteUrl: "https://github.com/acme/slow.git",
    worktreeRoot: requestedCwd,
    isPaseoOwnedWorktree: false,
    mainRepoRoot: null,
  });
  let resolveSnapshot: (snapshot: WorkspaceGitRuntimeSnapshot) => void = () => {};
  const snapshotPromise = new Promise<WorkspaceGitRuntimeSnapshot>((resolve) => {
    resolveSnapshot = resolve;
  });
  session.workspaceGitService.getSnapshot = (requestedCwd: string) => {
    void requestedCwd;
    return snapshotPromise;
  };

  const start = Date.now();
  await session.handleMessage({
    type: "open_project_request",
    cwd,
    requestId: "req-slow-github",
  });
  const elapsedMs = Date.now() - start;

  expect(elapsedMs).toBeLessThan(500);

  const response = emitted.find((message) => message.type === "open_project_response") as
    | {
        payload: {
          error: unknown;
          workspace?: {
            id: string;
            gitRuntime?: unknown;
            githubRuntime?: unknown;
          };
        };
      }
    | undefined;
  expect(response?.payload.error).toBeNull();
  expect(response?.payload.workspace?.id).toBe(cwd);
  expect(response?.payload.workspace?.gitRuntime).toBeUndefined();
  expect(response?.payload.workspace?.githubRuntime).toBeUndefined();

  resolveSnapshot(createWorkspaceRuntimeSnapshot(cwd));
});

test("open_project_request emits a workspace_update with githubRuntime once the snapshot resolves", async () => {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const session = createSessionForWorkspaceTests();
  const projects = new Map<string, ReturnType<typeof createPersistedProjectRecord>>();
  const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>();
  const cwd = "/tmp/github-runtime-repo";
  const snapshot = createWorkspaceRuntimeSnapshot(cwd);

  let listener: ((snapshot: WorkspaceGitRuntimeSnapshot) => void) | null = null;
  const peeked = { value: null as WorkspaceGitRuntimeSnapshot | null };

  session.emit = (message) => emitted.push(message as { type: string; payload: unknown });
  session.projectRegistry.get = async (projectId: string) => projects.get(projectId) ?? null;
  session.projectRegistry.upsert = async (
    record: ReturnType<typeof createPersistedProjectRecord>,
  ) => {
    projects.set(record.projectId, record);
  };
  session.workspaceRegistry.get = async (workspaceId: string) =>
    workspaces.get(workspaceId) ?? null;
  session.workspaceRegistry.upsert = async (
    record: ReturnType<typeof createPersistedWorkspaceRecord>,
  ) => {
    workspaces.set(record.workspaceId, record);
  };
  session.projectRegistry.list = async () => Array.from(projects.values());
  session.workspaceRegistry.list = async () => Array.from(workspaces.values());
  session.workspaceGitService.getCheckout = async (requestedCwd: string) => ({
    cwd: requestedCwd,
    isGit: true,
    currentBranch: "main",
    remoteUrl: "https://github.com/acme/repo.git",
    worktreeRoot: requestedCwd,
    isPaseoOwnedWorktree: false,
    mainRepoRoot: null,
  });
  session.workspaceGitService.peekSnapshot = () => peeked.value;
  session.workspaceGitService.registerWorkspace = (_params, incomingListener) => {
    listener = incomingListener as (snapshot: WorkspaceGitRuntimeSnapshot) => void;
    return { unsubscribe: () => {} };
  };
  session.workspaceGitService.getSnapshot = async () => {
    peeked.value = snapshot;
    listener?.(snapshot);
    return snapshot;
  };
  session.workspaceUpdatesSubscription = {
    subscriptionId: "sub-open-project",
    filter: undefined,
    isBootstrapping: false,
    pendingUpdatesByWorkspaceId: new Map(),
    lastEmittedByWorkspaceId: new Map(),
  };
  session.reconcileActiveWorkspaceRecords = async () => new Set();

  await session.handleMessage({
    type: "open_project_request",
    cwd,
    requestId: "req-runtime-update",
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  const updates = emitted.filter((message) => message.type === "workspace_update") as Array<{
    type: "workspace_update";
    payload: WorkspaceUpdatePayloadShape;
  }>;
  const upsertedWithGitHub = updates
    .map((update) => update.payload)
    .filter(
      (payload): payload is WorkspaceUpsertPayload =>
        payload.kind === "upsert" && payload.workspace.id === cwd,
    )
    .find((payload) => payload.workspace.githubRuntime?.pullRequest);
  expect(upsertedWithGitHub?.workspace.githubRuntime?.pullRequest).toEqual(
    expect.objectContaining({ url: "https://github.com/acme/repo/pull/123" }),
  );
});

interface WorkspaceUpsertPayload {
  kind: "upsert";
  workspace: {
    id: string;
    githubRuntime?: {
      pullRequest?: { url?: string } | null;
    } | null;
  };
}

interface WorkspaceRemovePayload {
  kind: "remove";
  id: string;
}

type WorkspaceUpdatePayloadShape = WorkspaceUpsertPayload | WorkspaceRemovePayload;

test("open_project_request does not match a new child directory to an existing parent workspace", async () => {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const session = createSessionForWorkspaceTests();
  const projects = new Map<string, ReturnType<typeof createPersistedProjectRecord>>();
  const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>();
  const home = "/Users/moboudra";
  const worktree = "/Users/moboudra/.paseo/worktrees/project-config-lifecycle-textarea";

  projects.set(
    home,
    createPersistedProjectRecord({
      projectId: home,
      rootPath: home,
      kind: "non_git",
      displayName: "moboudra",
      createdAt: "2026-04-24T09:00:00.000Z",
      updatedAt: "2026-04-24T09:00:00.000Z",
    }),
  );
  workspaces.set(
    home,
    createPersistedWorkspaceRecord({
      workspaceId: home,
      projectId: home,
      cwd: home,
      kind: "directory",
      displayName: "moboudra",
      createdAt: "2026-04-24T09:00:00.000Z",
      updatedAt: "2026-04-24T09:00:00.000Z",
    }),
  );

  session.emit = (message) => emitted.push(message as { type: string; payload: unknown });
  session.projectRegistry.get = async (projectId: string) => projects.get(projectId) ?? null;
  session.projectRegistry.upsert = async (
    record: ReturnType<typeof createPersistedProjectRecord>,
  ) => {
    projects.set(record.projectId, record);
  };
  session.workspaceRegistry.get = async (workspaceId: string) =>
    workspaces.get(workspaceId) ?? null;
  session.workspaceRegistry.upsert = async (
    record: ReturnType<typeof createPersistedWorkspaceRecord>,
  ) => {
    workspaces.set(record.workspaceId, record);
  };
  session.projectRegistry.list = async () => Array.from(projects.values());
  session.workspaceRegistry.list = async () => Array.from(workspaces.values());

  await session.handleMessage({
    type: "open_project_request",
    cwd: worktree,
    requestId: "req-open-worktree-under-home",
  });

  const response = emitted.find((message) => message.type === "open_project_response") as
    | { payload: { error: unknown; workspace?: { id: string; workspaceDirectory: string } } }
    | undefined;
  expect(response?.payload.error).toBeNull();
  expect(response?.payload.workspace?.id).toBe(worktree);
  expect(response?.payload.workspace?.workspaceDirectory).toBe(worktree);
  expect(workspaces.get(worktree)).toBeTruthy();
});

test("open_project_request does not unarchive an archived parent workspace for a new child directory", async () => {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const session = createSessionForWorkspaceTests();
  const projects = new Map<string, ReturnType<typeof createPersistedProjectRecord>>();
  const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>();
  const home = "/Users/moboudra";
  const worktree = "/Users/moboudra/.paseo/worktrees/project-config-lifecycle-textarea";
  const archivedAt = "2026-04-24T08:00:00.000Z";

  projects.set(
    home,
    createPersistedProjectRecord({
      projectId: home,
      rootPath: home,
      kind: "non_git",
      displayName: "moboudra",
      createdAt: "2026-04-24T07:00:00.000Z",
      updatedAt: archivedAt,
      archivedAt,
    }),
  );
  workspaces.set(
    home,
    createPersistedWorkspaceRecord({
      workspaceId: home,
      projectId: home,
      cwd: home,
      kind: "directory",
      displayName: "moboudra",
      createdAt: "2026-04-24T07:00:00.000Z",
      updatedAt: archivedAt,
      archivedAt,
    }),
  );

  session.emit = (message) => emitted.push(message as { type: string; payload: unknown });
  session.projectRegistry.get = async (projectId: string) => projects.get(projectId) ?? null;
  session.projectRegistry.upsert = async (
    record: ReturnType<typeof createPersistedProjectRecord>,
  ) => {
    projects.set(record.projectId, record);
  };
  session.workspaceRegistry.get = async (workspaceId: string) =>
    workspaces.get(workspaceId) ?? null;
  session.workspaceRegistry.upsert = async (
    record: ReturnType<typeof createPersistedWorkspaceRecord>,
  ) => {
    workspaces.set(record.workspaceId, record);
  };
  session.projectRegistry.list = async () => Array.from(projects.values());
  session.workspaceRegistry.list = async () => Array.from(workspaces.values());

  await session.handleMessage({
    type: "open_project_request",
    cwd: worktree,
    requestId: "req-open-worktree-under-archived-home",
  });

  const response = emitted.find((message) => message.type === "open_project_response") as
    | { payload: { error: unknown; workspace?: { id: string; workspaceDirectory: string } } }
    | undefined;
  expect(response?.payload.error).toBeNull();
  expect(response?.payload.workspace?.id).toBe(worktree);
  expect(response?.payload.workspace?.workspaceDirectory).toBe(worktree);
  expect(workspaces.get(home)?.archivedAt).toBe(archivedAt);
  expect(projects.get(home)?.archivedAt).toBe(archivedAt);
});

test("open_project_request reclassifies an archived directory workspace when git metadata becomes available", async () => {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const session = createSessionForWorkspaceTests();
  const projects = new Map<string, ReturnType<typeof createPersistedProjectRecord>>();
  const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>();
  const cwd = "/Users/moboudra/.paseo/worktrees/orchestrate/desktop-daemon-settings";
  const repoRoot = "/Users/moboudra/dev/paseo";
  const remoteProjectId = "remote:github.com/getpaseo/paseo";
  const archivedAt = "2026-04-24T09:48:36.168Z";

  projects.set(
    cwd,
    createPersistedProjectRecord({
      projectId: cwd,
      rootPath: cwd,
      kind: "non_git",
      displayName: "desktop-daemon-settings",
      createdAt: "2026-04-24T09:46:43.146Z",
      updatedAt: archivedAt,
      archivedAt,
    }),
  );
  workspaces.set(
    cwd,
    createPersistedWorkspaceRecord({
      workspaceId: cwd,
      projectId: cwd,
      cwd,
      kind: "directory",
      displayName: "desktop-daemon-settings",
      createdAt: "2026-04-24T09:46:43.146Z",
      updatedAt: archivedAt,
      archivedAt,
    }),
  );

  session.emit = (message) => emitted.push(message as { type: string; payload: unknown });
  session.projectRegistry.get = async (projectId: string) => projects.get(projectId) ?? null;
  session.projectRegistry.upsert = async (
    record: ReturnType<typeof createPersistedProjectRecord>,
  ) => {
    projects.set(record.projectId, record);
  };
  session.workspaceRegistry.get = async (workspaceId: string) =>
    workspaces.get(workspaceId) ?? null;
  session.workspaceRegistry.upsert = async (
    record: ReturnType<typeof createPersistedWorkspaceRecord>,
  ) => {
    workspaces.set(record.workspaceId, record);
  };
  session.projectRegistry.list = async () => Array.from(projects.values());
  session.workspaceRegistry.list = async () => Array.from(workspaces.values());
  session.workspaceGitService.getCheckout = async () => ({
    cwd,
    isGit: true,
    currentBranch: "feature/desktop-daemon-settings",
    remoteUrl: "git@github.com:getpaseo/paseo.git",
    worktreeRoot: cwd,
    isPaseoOwnedWorktree: false,
    mainRepoRoot: repoRoot,
  });
  session.workspaceGitService.getSnapshot = async () =>
    createWorkspaceRuntimeSnapshot(cwd, {
      git: {
        isGit: true,
        repoRoot: cwd,
        currentBranch: "feature/desktop-daemon-settings",
        remoteUrl: "git@github.com:getpaseo/paseo.git",
        isPaseoOwnedWorktree: false,
        mainRepoRoot: repoRoot,
      },
    });

  await session.handleMessage({
    type: "open_project_request",
    cwd,
    requestId: "req-open-archived-directory-now-git",
  });

  const response = emitted.find((message) => message.type === "open_project_response") as
    | {
        payload: {
          error: unknown;
          workspace?: {
            id: string;
            projectId: string;
            workspaceKind: string;
          };
        };
      }
    | undefined;

  expect(response?.payload.error).toBeNull();
  expect(response?.payload.workspace?.projectId).toBe(remoteProjectId);
  expect(response?.payload.workspace?.workspaceKind).toBe("worktree");
  expect(projects.get(remoteProjectId)?.kind).toBe("git");
  expect(workspaces.get(cwd)?.projectId).toBe(remoteProjectId);
  expect(workspaces.get(cwd)?.kind).toBe("worktree");
  expect(workspaces.get(cwd)?.displayName).toBe("feature/desktop-daemon-settings");
});

test("open_project_request reclassifies an active directory workspace when git metadata becomes available", async () => {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const session = createSessionForWorkspaceTests();
  const projects = new Map<string, ReturnType<typeof createPersistedProjectRecord>>();
  const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>();
  const cwd = "/Users/moboudra/.paseo/worktrees/orchestrate/desktop-daemon-settings";
  const repoRoot = "/Users/moboudra/dev/paseo";

  projects.set(
    cwd,
    createPersistedProjectRecord({
      projectId: cwd,
      rootPath: cwd,
      kind: "non_git",
      displayName: "desktop-daemon-settings",
      createdAt: "2026-04-24T09:46:43.146Z",
      updatedAt: "2026-04-24T09:46:43.146Z",
    }),
  );
  projects.set(
    repoRoot,
    createPersistedProjectRecord({
      projectId: repoRoot,
      rootPath: repoRoot,
      kind: "git",
      displayName: "paseo",
      createdAt: "2026-04-24T09:40:00.000Z",
      updatedAt: "2026-04-24T09:40:00.000Z",
    }),
  );
  workspaces.set(
    cwd,
    createPersistedWorkspaceRecord({
      workspaceId: cwd,
      projectId: cwd,
      cwd,
      kind: "directory",
      displayName: "desktop-daemon-settings",
      createdAt: "2026-04-24T09:46:43.146Z",
      updatedAt: "2026-04-24T09:46:43.146Z",
    }),
  );
  workspaces.set(
    repoRoot,
    createPersistedWorkspaceRecord({
      workspaceId: repoRoot,
      projectId: repoRoot,
      cwd: repoRoot,
      kind: "local_checkout",
      displayName: "main",
      createdAt: "2026-04-24T09:40:00.000Z",
      updatedAt: "2026-04-24T09:40:00.000Z",
    }),
  );

  session.emit = (message) => emitted.push(message as { type: string; payload: unknown });
  session.projectRegistry.get = async (projectId: string) => projects.get(projectId) ?? null;
  session.projectRegistry.upsert = async (
    record: ReturnType<typeof createPersistedProjectRecord>,
  ) => {
    projects.set(record.projectId, record);
  };
  session.workspaceRegistry.get = async (workspaceId: string) =>
    workspaces.get(workspaceId) ?? null;
  session.workspaceRegistry.upsert = async (
    record: ReturnType<typeof createPersistedWorkspaceRecord>,
  ) => {
    workspaces.set(record.workspaceId, record);
  };
  session.projectRegistry.list = async () => Array.from(projects.values());
  session.workspaceRegistry.list = async () => Array.from(workspaces.values());
  session.workspaceGitService.getCheckout = async (requestedCwd: string) => ({
    cwd: requestedCwd,
    isGit: true,
    currentBranch: requestedCwd === repoRoot ? "main" : "feature/desktop-daemon-settings",
    remoteUrl: "git@github.com:getpaseo/paseo.git",
    worktreeRoot: requestedCwd,
    isPaseoOwnedWorktree: false,
    mainRepoRoot: requestedCwd === repoRoot ? null : repoRoot,
  });
  session.workspaceGitService.getSnapshot = async (requestedCwd: string) =>
    createWorkspaceRuntimeSnapshot(requestedCwd, {
      git: {
        isGit: true,
        repoRoot: requestedCwd,
        currentBranch: requestedCwd === repoRoot ? "main" : "feature/desktop-daemon-settings",
        remoteUrl: "git@github.com:getpaseo/paseo.git",
        isPaseoOwnedWorktree: false,
        mainRepoRoot: requestedCwd === repoRoot ? null : repoRoot,
      },
    });

  await session.handleMessage({
    type: "open_project_request",
    cwd,
    requestId: "req-open-active-directory-now-git",
  });

  const response = emitted.find((message) => message.type === "open_project_response") as
    | {
        payload: {
          error: unknown;
          workspace?: {
            id: string;
            projectId: string;
            workspaceKind: string;
          };
        };
      }
    | undefined;

  expect(response?.payload.error).toBeNull();
  expect(response?.payload.workspace?.projectId).toBe(repoRoot);
  expect(response?.payload.workspace?.workspaceKind).toBe("worktree");
  expect(workspaces.get(cwd)?.projectId).toBe(repoRoot);
  expect(workspaces.get(cwd)?.kind).toBe("worktree");
  expect(workspaces.get(cwd)?.displayName).toBe("feature/desktop-daemon-settings");
});

test("open_project_request groups a plain git worktree under an existing repo project", async () => {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const session = createSessionForWorkspaceTests();
  const projects = new Map<string, ReturnType<typeof createPersistedProjectRecord>>();
  const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>();
  const cwd = "/Users/moboudra/.paseo/worktrees/orchestrate/desktop-daemon-settings";
  const repoRoot = "/Users/moboudra/dev/paseo";

  projects.set(
    repoRoot,
    createPersistedProjectRecord({
      projectId: repoRoot,
      rootPath: repoRoot,
      kind: "git",
      displayName: "paseo",
      createdAt: "2026-04-24T09:46:43.146Z",
      updatedAt: "2026-04-24T09:46:43.146Z",
    }),
  );
  workspaces.set(
    repoRoot,
    createPersistedWorkspaceRecord({
      workspaceId: repoRoot,
      projectId: repoRoot,
      cwd: repoRoot,
      kind: "local_checkout",
      displayName: "main",
      createdAt: "2026-04-24T09:46:43.146Z",
      updatedAt: "2026-04-24T09:46:43.146Z",
    }),
  );

  session.emit = (message) => emitted.push(message as { type: string; payload: unknown });
  session.projectRegistry.get = async (projectId: string) => projects.get(projectId) ?? null;
  session.projectRegistry.upsert = async (
    record: ReturnType<typeof createPersistedProjectRecord>,
  ) => {
    projects.set(record.projectId, record);
  };
  session.workspaceRegistry.get = async (workspaceId: string) =>
    workspaces.get(workspaceId) ?? null;
  session.workspaceRegistry.upsert = async (
    record: ReturnType<typeof createPersistedWorkspaceRecord>,
  ) => {
    workspaces.set(record.workspaceId, record);
  };
  session.projectRegistry.list = async () => Array.from(projects.values());
  session.workspaceRegistry.list = async () => Array.from(workspaces.values());
  session.workspaceGitService.getCheckout = async (requestedCwd: string) => ({
    cwd: requestedCwd,
    isGit: true,
    currentBranch: requestedCwd === repoRoot ? "main" : "feature/desktop-daemon-settings",
    remoteUrl: "git@github.com:getpaseo/paseo.git",
    worktreeRoot: requestedCwd,
    isPaseoOwnedWorktree: false,
    mainRepoRoot: requestedCwd === repoRoot ? null : repoRoot,
  });
  session.workspaceGitService.getSnapshot = async (requestedCwd: string) =>
    createWorkspaceRuntimeSnapshot(requestedCwd, {
      git: {
        isGit: true,
        repoRoot: requestedCwd,
        currentBranch: requestedCwd === repoRoot ? "main" : "feature/desktop-daemon-settings",
        remoteUrl: "git@github.com:getpaseo/paseo.git",
        isPaseoOwnedWorktree: false,
        mainRepoRoot: requestedCwd === repoRoot ? null : repoRoot,
      },
    });

  await session.handleMessage({
    type: "open_project_request",
    cwd,
    requestId: "req-open-plain-git-worktree",
  });

  const response = emitted.find((message) => message.type === "open_project_response") as
    | {
        payload: {
          error: unknown;
          workspace?: {
            id: string;
            projectId: string;
            workspaceKind: string;
          };
        };
      }
    | undefined;

  expect(response?.payload.error).toBeNull();
  expect(response?.payload.workspace?.projectId).toBe(repoRoot);
  expect(response?.payload.workspace?.workspaceKind).toBe("worktree");
  expect(workspaces.get(cwd)?.projectId).toBe(repoRoot);
  expect(workspaces.get(cwd)?.kind).toBe("worktree");
});

test("open_project_request unarchives an existing archived workspace and project", async () => {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const session = createSessionForWorkspaceTests();
  const projects = new Map<string, ReturnType<typeof createPersistedProjectRecord>>();
  const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>();

  const cwd = "/tmp/repo";
  projects.set(
    cwd,
    createPersistedProjectRecord({
      projectId: cwd,
      rootPath: cwd,
      kind: "non_git",
      displayName: "repo",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-10T00:00:00.000Z",
      archivedAt: "2026-03-10T00:00:00.000Z",
    }),
  );
  workspaces.set(
    cwd,
    createPersistedWorkspaceRecord({
      workspaceId: cwd,
      projectId: cwd,
      cwd,
      kind: "directory",
      displayName: "repo",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-10T00:00:00.000Z",
      archivedAt: "2026-03-10T00:00:00.000Z",
    }),
  );

  session.emit = (message) => emitted.push(message as { type: string; payload: unknown });
  session.projectRegistry.get = async (projectId: string) => projects.get(projectId) ?? null;
  session.projectRegistry.upsert = async (
    record: ReturnType<typeof createPersistedProjectRecord>,
  ) => {
    projects.set(record.projectId, record);
  };
  session.workspaceRegistry.get = async (workspaceId: string) =>
    workspaces.get(workspaceId) ?? null;
  session.workspaceRegistry.upsert = async (
    record: ReturnType<typeof createPersistedWorkspaceRecord>,
  ) => {
    workspaces.set(record.workspaceId, record);
  };
  session.projectRegistry.list = async () => Array.from(projects.values());
  session.workspaceRegistry.list = async () => Array.from(workspaces.values());

  await session.handleMessage({
    type: "open_project_request",
    cwd,
    requestId: "req-open-unarchive",
  });

  expect(workspaces.get(cwd)?.archivedAt).toBeNull();
  expect(projects.get(cwd)?.archivedAt).toBeNull();
  const response = emitted.find((message) => message.type === "open_project_response") as
    | { payload: { error: unknown; workspace?: { id: string } } }
    | undefined;
  expect(response?.payload.error).toBeNull();
  expect(response?.payload.workspace?.id).toBe(cwd);
});

test.skip("open_project_request collapses a git subdirectory onto the repo root workspace", async () => {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const session = createSessionForWorkspaceTests();
  const projects = new Map<string, ReturnType<typeof createPersistedProjectRecord>>();
  const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>();
  const repoRoot = "/tmp/repo";
  const subdir = "/tmp/repo/packages/app";

  session.emit = (message) => emitted.push(message as { type: string; payload: unknown });
  session.projectRegistry.get = async (projectId: string) => projects.get(projectId) ?? null;
  session.projectRegistry.upsert = async (
    record: ReturnType<typeof createPersistedProjectRecord>,
  ) => {
    projects.set(record.projectId, record);
  };
  session.workspaceRegistry.get = async (workspaceId: string) =>
    workspaces.get(workspaceId) ?? null;
  session.workspaceRegistry.upsert = async (
    record: ReturnType<typeof createPersistedWorkspaceRecord>,
  ) => {
    workspaces.set(record.workspaceId, record);
  };
  session.projectRegistry.list = async () => Array.from(projects.values());
  session.workspaceRegistry.list = async () => Array.from(workspaces.values());
  session.buildProjectPlacement = async (cwd: string) => ({
    projectKey: repoRoot,
    projectName: "repo",
    checkout: {
      cwd,
      isGit: true,
      currentBranch: "main",
      remoteUrl: null,
      worktreeRoot: repoRoot,
      isPaseoOwnedWorktree: false,
      mainRepoRoot: null,
    },
  });

  await session.handleMessage({
    type: "open_project_request",
    cwd: subdir,
    requestId: "req-open-subdir",
  });

  expect(workspaces.get(repoRoot)).toBeTruthy();
  expect(workspaces.has(subdir)).toBe(false);
  const response = emitted.find((message) => message.type === "open_project_response") as
    | { payload: { error: unknown; workspace?: { id: string } } }
    | undefined;
  expect(response?.payload.error).toBeNull();
  expect(response?.payload.workspace?.id).toBe(repoRoot);
});

test("list_available_editors_request returns available targets", async () => {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const session = createSessionForWorkspaceTests({ appVersion: "0.1.50" });

  session.emit = (message) => emitted.push(message as { type: string; payload: unknown });
  session.getAvailableEditorTargets = async () =>
    session.filterEditorsForClient([
      { id: "cursor", label: "Cursor" },
      { id: "webstorm", label: "WebStorm" },
      { id: "finder", label: "Finder" },
      { id: "unknown-editor", label: "Unknown Editor" },
    ]);

  await session.handleMessage({
    type: "list_available_editors_request",
    requestId: "req-editors",
  });

  const response = emitted.find((message) => message.type === "list_available_editors_response") as
    | { payload: Record<string, unknown> }
    | undefined;
  expect(response?.payload.error).toBeNull();
  expect(response?.payload.editors).toEqual([
    { id: "cursor", label: "Cursor" },
    { id: "webstorm", label: "WebStorm" },
    { id: "finder", label: "Finder" },
    { id: "unknown-editor", label: "Unknown Editor" },
  ]);
});

test("list_available_editors_request coalesces concurrent discovery", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const session = asTestSession(
    createSessionForWorkspaceTests({
      appVersion: "0.1.50",
      onMessage: (message) => emitted.push(message),
    }),
  );
  let resolveDiscovery: (editors: EditorTargetDescriptorPayload[]) => void = () => {};
  let discoveryCalls = 0;

  vi.spyOn(session, "resolveAvailableEditorTargets").mockImplementation(async () => {
    discoveryCalls += 1;
    return await new Promise<EditorTargetDescriptorPayload[]>((resolve) => {
      resolveDiscovery = resolve;
    });
  });

  const first = session.handleMessage({
    type: "list_available_editors_request",
    requestId: "req-editors-1",
  });
  const second = session.handleMessage({
    type: "list_available_editors_request",
    requestId: "req-editors-2",
  });

  await Promise.resolve();
  expect(discoveryCalls).toBe(1);

  resolveDiscovery([{ id: "cursor", label: "Cursor" }]);
  await Promise.all([first, second]);

  const responses = emitted.filter(
    (
      message,
    ): message is Extract<SessionOutboundMessage, { type: "list_available_editors_response" }> =>
      message.type === "list_available_editors_response",
  );
  expect(responses).toHaveLength(2);
  expect(responses.map((response) => response.payload.requestId)).toEqual([
    "req-editors-1",
    "req-editors-2",
  ]);
  expect(responses.map((response) => response.payload.editors)).toEqual([
    [{ id: "cursor", label: "Cursor" }],
    [{ id: "cursor", label: "Cursor" }],
  ]);

  await session.handleMessage({
    type: "list_available_editors_request",
    requestId: "req-editors-3",
  });

  expect(discoveryCalls).toBe(1);
});

test("list_available_editors_request filters unsupported ids for legacy clients", async () => {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const session = createSessionForWorkspaceTests({ appVersion: "0.1.49" });

  session.emit = (message) => emitted.push(message as { type: string; payload: unknown });
  session.getAvailableEditorTargets = async () =>
    session.filterEditorsForClient([
      { id: "cursor", label: "Cursor" },
      { id: "webstorm", label: "WebStorm" },
      { id: "unknown-editor", label: "Unknown Editor" },
      { id: "finder", label: "Finder" },
    ]);

  await session.handleMessage({
    type: "list_available_editors_request",
    requestId: "req-editors-legacy",
  });

  const response = emitted.find((message) => message.type === "list_available_editors_response") as
    | { payload: Record<string, unknown> }
    | undefined;
  expect(response?.payload.error).toBeNull();
  expect(response?.payload.editors).toEqual([
    { id: "cursor", label: "Cursor" },
    { id: "finder", label: "Finder" },
  ]);
});

test("open_in_editor_request launches the selected target", async () => {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const session = createSessionForWorkspaceTests();
  const calls: Array<{ editorId: string; path: string }> = [];

  session.emit = (message) => emitted.push(message as { type: string; payload: unknown });
  session.openEditorTarget = async (input: { editorId: string; path: string }) => {
    calls.push(input);
  };

  await session.handleMessage({
    type: "open_in_editor_request",
    requestId: "req-open-editor",
    editorId: "vscode",
    path: "/tmp/repo",
  });

  expect(calls).toEqual([{ editorId: "vscode", path: "/tmp/repo" }]);
  const response = emitted.find((message) => message.type === "open_in_editor_response") as
    | { payload: Record<string, unknown> }
    | undefined;
  expect(response?.payload.error).toBeNull();
});

test("archive_workspace_request hides non-destructive workspace records", async () => {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const session = createSessionForWorkspaceTests();
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-repo-archive",
    projectId: "proj-repo-archive",
    cwd: "/tmp/repo",
    kind: "directory",
    displayName: "repo",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });

  session.emit = (message) => emitted.push(message as { type: string; payload: unknown });
  session.workspaceRegistry.get = async () => workspace;
  session.workspaceRegistry.archive = async (_workspaceId: string, archivedAt: string) => {
    workspace.archivedAt = archivedAt;
  };
  session.workspaceRegistry.list = async () => [workspace];
  session.projectRegistry.archive = async () => {};

  await session.handleMessage({
    type: "archive_workspace_request",
    workspaceId: "ws-repo-archive",
    requestId: "req-archive",
  });

  expect(workspace.archivedAt).toBeTruthy();
  const response = emitted.find((message) => message.type === "archive_workspace_response") as
    | { payload: Record<string, unknown> }
    | undefined;
  expect(response?.payload.error).toBeNull();
});

test.skip("opening a new worktree reconciles older local workspaces into the remote project", async () => {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const session = createSessionForWorkspaceTests();
  const projects = new Map<string, ReturnType<typeof createPersistedProjectRecord>>();
  const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>();

  const tempDir = realpathSync(mkdtempSync(path.join(tmpdir(), "session-workspace-reconcile-")));
  const mainWorkspaceId = path.join(tempDir, "inkwell");
  const worktreeWorkspaceId = path.join(mainWorkspaceId, ".paseo", "worktrees", "feature-a");
  const localProjectId = mainWorkspaceId;
  const remoteProjectId = "remote:github.com/zimakki/inkwell";

  execSync(`mkdir -p ${JSON.stringify(worktreeWorkspaceId)}`);

  projects.set(
    localProjectId,
    createPersistedProjectRecord({
      projectId: localProjectId,
      rootPath: mainWorkspaceId,
      kind: "git",
      displayName: "inkwell",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
    }),
  );
  workspaces.set(
    mainWorkspaceId,
    createPersistedWorkspaceRecord({
      workspaceId: mainWorkspaceId,
      projectId: localProjectId,
      cwd: mainWorkspaceId,
      kind: "local_checkout",
      displayName: "main",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
    }),
  );

  session.emit = (message) => emitted.push(message as { type: string; payload: unknown });
  session.workspaceUpdatesSubscription = {
    subscriptionId: "sub-reconcile",
    filter: undefined,
    isBootstrapping: false,
    pendingUpdatesByWorkspaceId: new Map(),
    lastEmittedByWorkspaceId: new Map(),
  };
  session.listAgentPayloads = async () => [];
  session.projectRegistry.get = async (projectId: string) => projects.get(projectId) ?? null;
  session.projectRegistry.list = async () => Array.from(projects.values());
  session.projectRegistry.upsert = async (
    record: ReturnType<typeof createPersistedProjectRecord>,
  ) => {
    projects.set(record.projectId, record);
  };
  session.projectRegistry.archive = async (projectId: string, archivedAt: string) => {
    const existing = projects.get(projectId);
    if (!existing) return;
    projects.set(projectId, { ...existing, archivedAt, updatedAt: archivedAt });
  };
  session.workspaceRegistry.get = async (workspaceId: string) =>
    workspaces.get(workspaceId) ?? null;
  session.workspaceRegistry.list = async () => Array.from(workspaces.values());
  session.workspaceRegistry.upsert = async (
    record: ReturnType<typeof createPersistedWorkspaceRecord>,
  ) => {
    workspaces.set(record.workspaceId, record);
  };
  session.buildProjectPlacement = async (cwd: string) => ({
    projectKey: remoteProjectId,
    projectName: "zimakki/inkwell",
    checkout: {
      cwd,
      isGit: true,
      currentBranch: cwd === mainWorkspaceId ? "main" : "feature-a",
      remoteUrl: "https://github.com/zimakki/inkwell.git",
      worktreeRoot: cwd,
      isPaseoOwnedWorktree: cwd !== mainWorkspaceId,
      mainRepoRoot: cwd === mainWorkspaceId ? null : mainWorkspaceId,
    },
  });

  try {
    await session.handleMessage({
      type: "open_project_request",
      cwd: worktreeWorkspaceId,
      requestId: "req-open-worktree",
    });

    const mainWorkspaceProjectId = workspaces.get(mainWorkspaceId)?.projectId;
    expect([localProjectId, remoteProjectId]).toContain(mainWorkspaceProjectId);
    expect(workspaces.get(worktreeWorkspaceId)?.projectId).toBe(remoteProjectId);
    expect(Boolean(projects.get(localProjectId)?.archivedAt)).toBe(
      mainWorkspaceProjectId === remoteProjectId,
    );

    const workspaceUpdates = emitted.filter(
      (message) => message.type === "workspace_update",
    ) as Array<{ payload: { workspace: { id: string; projectId: string } } }>;
    expect(workspaceUpdates).toHaveLength(1);
    expect(workspaceUpdates[0]?.payload.workspace.id).toBe(worktreeWorkspaceId);
    expect(workspaceUpdates[0]?.payload.workspace.projectId).toBe(remoteProjectId);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test.skip("fetch_workspaces_request reconciles remote URL changes for existing workspaces", async () => {
  const session = createSessionForWorkspaceTests();
  const projects = new Map<string, ReturnType<typeof createPersistedProjectRecord>>();
  const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>();

  const tempDir = realpathSync(mkdtempSync(path.join(tmpdir(), "session-workspace-fetch-")));
  const mainWorkspaceId = path.join(tempDir, "inkwell");
  const worktreeWorkspaceId = path.join(mainWorkspaceId, ".paseo", "worktrees", "feature-a");
  const oldProjectId = "remote:github.com/old-owner/inkwell";
  const newProjectId = "remote:github.com/new-owner/inkwell";

  execSync(`mkdir -p ${JSON.stringify(worktreeWorkspaceId)}`);

  projects.set(
    oldProjectId,
    createPersistedProjectRecord({
      projectId: oldProjectId,
      rootPath: mainWorkspaceId,
      kind: "git",
      displayName: "old-owner/inkwell",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
    }),
  );

  for (const [workspaceId, displayName] of [
    [mainWorkspaceId, "main"],
    [worktreeWorkspaceId, "feature-a"],
  ] as const) {
    workspaces.set(
      workspaceId,
      createPersistedWorkspaceRecord({
        workspaceId,
        projectId: oldProjectId,
        cwd: workspaceId,
        kind: workspaceId === mainWorkspaceId ? "local_checkout" : "worktree",
        displayName,
        createdAt: "2026-03-01T12:00:00.000Z",
        updatedAt: "2026-03-01T12:00:00.000Z",
      }),
    );
  }

  session.listAgentPayloads = async () => [];
  session.projectRegistry.get = async (projectId: string) => projects.get(projectId) ?? null;
  session.projectRegistry.list = async () => Array.from(projects.values());
  session.projectRegistry.upsert = async (
    record: ReturnType<typeof createPersistedProjectRecord>,
  ) => {
    projects.set(record.projectId, record);
  };
  session.projectRegistry.archive = async (projectId: string, archivedAt: string) => {
    const existing = projects.get(projectId);
    if (!existing) return;
    projects.set(projectId, { ...existing, archivedAt, updatedAt: archivedAt });
  };
  session.workspaceRegistry.get = async (workspaceId: string) =>
    workspaces.get(workspaceId) ?? null;
  session.workspaceRegistry.list = async () => Array.from(workspaces.values());
  session.workspaceRegistry.upsert = async (
    record: ReturnType<typeof createPersistedWorkspaceRecord>,
  ) => {
    workspaces.set(record.workspaceId, record);
  };
  session.buildProjectPlacement = async (cwd: string) => ({
    projectKey: newProjectId,
    projectName: "new-owner/inkwell",
    checkout: {
      cwd,
      isGit: true,
      currentBranch: cwd === mainWorkspaceId ? "main" : "feature-a",
      remoteUrl: "https://github.com/new-owner/inkwell.git",
      worktreeRoot: cwd,
      isPaseoOwnedWorktree: cwd !== mainWorkspaceId,
      mainRepoRoot: cwd === mainWorkspaceId ? null : mainWorkspaceId,
    },
  });

  try {
    await session.reconcileWorkspaceRecord(mainWorkspaceId);
    await session.reconcileWorkspaceRecord(worktreeWorkspaceId);

    const result = await session.listFetchWorkspacesEntries({
      type: "fetch_workspaces_request",
      requestId: "req-fetch-reconcile",
    });

    expect(result.entries.map((entry) => (entry as { projectId: string }).projectId)).toEqual([
      newProjectId,
      newProjectId,
    ]);
    expect(workspaces.get(mainWorkspaceId)?.projectId).toBe(newProjectId);
    expect(workspaces.get(worktreeWorkspaceId)?.projectId).toBe(newProjectId);
    expect(projects.get(oldProjectId)?.archivedAt).toBeTruthy();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test.skip("reconcile archives stale subdirectory workspace records when collapsing to the repo root", async () => {
  const session = createSessionForWorkspaceTests();
  const projects = new Map<string, ReturnType<typeof createPersistedProjectRecord>>();
  const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>();

  const tempDir = realpathSync(mkdtempSync(path.join(tmpdir(), "session-workspace-collapse-")));
  const repoRoot = path.join(tempDir, "repo");
  const subdirWorkspaceId = path.join(repoRoot, "packages", "app");
  const projectId = "remote:github.com/acme/repo";

  execSync(`mkdir -p ${JSON.stringify(subdirWorkspaceId)}`);

  projects.set(
    projectId,
    createPersistedProjectRecord({
      projectId,
      rootPath: repoRoot,
      kind: "git",
      displayName: "acme/repo",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
    }),
  );
  workspaces.set(
    repoRoot,
    createPersistedWorkspaceRecord({
      workspaceId: repoRoot,
      projectId,
      cwd: repoRoot,
      kind: "local_checkout",
      displayName: "main",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
    }),
  );
  workspaces.set(
    subdirWorkspaceId,
    createPersistedWorkspaceRecord({
      workspaceId: subdirWorkspaceId,
      projectId,
      cwd: subdirWorkspaceId,
      kind: "directory",
      displayName: "app",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
    }),
  );

  session.projectRegistry.get = async (nextProjectId: string) =>
    projects.get(nextProjectId) ?? null;
  session.projectRegistry.list = async () => Array.from(projects.values());
  session.projectRegistry.upsert = async (
    record: ReturnType<typeof createPersistedProjectRecord>,
  ) => {
    projects.set(record.projectId, record);
  };
  session.workspaceRegistry.get = async (workspaceId: string) =>
    workspaces.get(workspaceId) ?? null;
  session.workspaceRegistry.list = async () => Array.from(workspaces.values());
  session.workspaceRegistry.upsert = async (
    record: ReturnType<typeof createPersistedWorkspaceRecord>,
  ) => {
    workspaces.set(record.workspaceId, record);
  };
  session.workspaceRegistry.archive = async (workspaceId: string, archivedAt: string) => {
    const existing = workspaces.get(workspaceId);
    if (!existing) return;
    workspaces.set(workspaceId, { ...existing, archivedAt, updatedAt: archivedAt });
  };
  session.buildProjectPlacement = async (cwd: string) => ({
    projectKey: projectId,
    projectName: "acme/repo",
    checkout: {
      cwd,
      isGit: true,
      currentBranch: "main",
      remoteUrl: "https://github.com/acme/repo.git",
      worktreeRoot: repoRoot,
      isPaseoOwnedWorktree: false,
      mainRepoRoot: null,
    },
  });

  try {
    const result = await session.reconcileWorkspaceRecord(subdirWorkspaceId);

    expect(result.changed).toBe(true);
    expect((result.workspace as { workspaceId: string }).workspaceId).toBe(repoRoot);
    expect(result.removedWorkspaceId).toBe(subdirWorkspaceId);
    expect(workspaces.get(repoRoot)?.archivedAt).toBeNull();
    expect(workspaces.get(subdirWorkspaceId)?.archivedAt).toBeTruthy();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("listWorkspaceDescriptorsSnapshot keeps git workspaces on the baseline descriptor path", async () => {
  const session = createSessionForWorkspaceTests();
  const project = createPersistedProjectRecord({
    projectId: "proj-baseline",
    rootPath: "/tmp/repo",
    kind: "git",
    displayName: "repo",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-baseline",
    projectId: project.projectId,
    cwd: "/tmp/repo",
    kind: "local_checkout",
    displayName: "main",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });

  session.listAgentPayloads = async () => [];
  session.projectRegistry.list = async () => [project];
  session.workspaceRegistry.list = async () => [workspace];

  const baselineDescriptor = {
    id: workspace.workspaceId,
    projectId: project.projectId,
    projectDisplayName: project.displayName,
    projectRootPath: project.rootPath,
    projectKind: project.kind,
    workspaceKind: workspace.kind,
    name: "main",
    archivingAt: null,
    status: "done",
    activityAt: null,
    diffStat: null,
  } as const;
  const gitDescriptor = {
    ...baselineDescriptor,
    diffStat: { additions: 3, deletions: 1 },
  } as const;

  session.describeWorkspaceRecord = vi.fn(async () => baselineDescriptor);
  session.describeWorkspaceRecordWithGitData = vi.fn(async () => gitDescriptor);

  const descriptors = Array.from(
    (
      await session.buildWorkspaceDescriptorMap({
        includeGitData: false,
      })
    ).values(),
  );

  expect(session.describeWorkspaceRecord).toHaveBeenCalledWith(workspace, project);
  expect(session.describeWorkspaceRecordWithGitData).not.toHaveBeenCalled();
  expect(descriptors).toEqual([baselineDescriptor]);
});

test("buildWorkspaceDescriptorMap stamps workspace archiving state", async () => {
  const session = createSessionForWorkspaceTests();
  const archivingAt = "2026-04-30T20:45:00.000Z";
  const project = createPersistedProjectRecord({
    projectId: "proj-archiving-map",
    rootPath: "/tmp/repo",
    kind: "git",
    displayName: "repo",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-archiving-map",
    projectId: project.projectId,
    cwd: "/tmp/repo/worktree",
    kind: "worktree",
    displayName: "feature",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });

  session.listAgentPayloads = async () => [];
  session.projectRegistry.list = async () => [project];
  session.workspaceRegistry.list = async () => [workspace];

  const readArchivingAt = async () =>
    (
      await session.buildWorkspaceDescriptorMap({
        includeGitData: false,
      })
    ).get(workspace.workspaceId)?.archivingAt;

  await expect(readArchivingAt()).resolves.toBeNull();

  session.markWorkspaceArchiving([workspace.workspaceId], archivingAt);
  await expect(readArchivingAt()).resolves.toBe(archivingAt);

  session.clearWorkspaceArchiving([workspace.workspaceId]);
  await expect(readArchivingAt()).resolves.toBeNull();
});

test("emitWorkspaceUpdatesForWorkspaceIds includes archiving state and dedupes unchanged emits", async () => {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const session = createSessionForWorkspaceTests();
  const archivingAt = "2026-04-30T20:45:00.000Z";
  const project = createPersistedProjectRecord({
    projectId: "proj-archiving-emit",
    rootPath: "/tmp/repo",
    kind: "git",
    displayName: "repo",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-archiving-emit",
    projectId: project.projectId,
    cwd: "/tmp/repo/worktree",
    kind: "worktree",
    displayName: "feature",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });

  session.emit = (message) => emitted.push(message as { type: string; payload: unknown });
  session.workspaceUpdatesSubscription = {
    subscriptionId: "sub-archiving",
    filter: undefined,
    isBootstrapping: false,
    pendingUpdatesByWorkspaceId: new Map(),
    lastEmittedByWorkspaceId: new Map(),
  };
  session.reconcileActiveWorkspaceRecords = async () => new Set();
  session.listAgentPayloads = async () => [];
  session.projectRegistry.list = async () => [project];
  session.workspaceRegistry.list = async () => [workspace];

  session.markWorkspaceArchiving([workspace.workspaceId], archivingAt);

  await session.emitWorkspaceUpdatesForWorkspaceIds([workspace.workspaceId], {
    skipReconcile: true,
  });
  await session.emitWorkspaceUpdatesForWorkspaceIds([workspace.workspaceId], {
    skipReconcile: true,
  });

  expect(emitted).toEqual([
    {
      type: "workspace_update",
      payload: {
        kind: "upsert",
        workspace: expect.objectContaining({
          id: workspace.workspaceId,
          archivingAt,
        }),
      },
    },
  ]);
});

test("fetch_workspaces_response reads runtime fields from passive workspace git service snapshots", async () => {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const runtimeSnapshot = createWorkspaceRuntimeSnapshot("/tmp/repo", {
    git: {
      currentBranch: "runtime-branch",
      isDirty: true,
      aheadBehind: { ahead: 3, behind: 1 },
      aheadOfOrigin: 3,
      behindOfOrigin: 1,
    },
    github: {
      pullRequest: {
        url: "https://github.com/acme/repo/pull/456",
        title: "Ship runtime payloads",
        state: "open",
        baseRefName: "main",
        headRefName: "runtime-branch",
        isMerged: false,
      },
    },
  });
  const workspaceGitService = createNoopWorkspaceGitService();
  workspaceGitService.peekSnapshot = vi.fn(() => runtimeSnapshot);
  workspaceGitService.registerWorkspace = vi.fn(() => ({
    unsubscribe: () => {},
  }));

  const session = asTestSession(
    createSessionForWorkspaceTests({
      workspaceGitService,
    }),
  );
  const project = createPersistedProjectRecord({
    projectId: "proj-runtime-fetch",
    rootPath: "/tmp/repo",
    kind: "git",
    displayName: "repo",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-runtime-fetch",
    projectId: project.projectId,
    cwd: "/tmp/repo",
    kind: "local_checkout",
    displayName: "main",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });

  session.emit = (message) => emitted.push(message as { type: string; payload: unknown });
  session.listAgentPayloads = async () => [];
  session.projectRegistry.list = async () => [project];
  session.workspaceRegistry.list = async () => [workspace];
  session.buildProjectPlacement = async (cwd: string) => ({
    projectKey: cwd,
    projectName: "repo",
    checkout: {
      cwd,
      isGit: true,
      currentBranch: runtimeSnapshot.git.currentBranch,
      remoteUrl: runtimeSnapshot.git.remoteUrl,
      worktreeRoot: cwd,
      isPaseoOwnedWorktree: false,
      mainRepoRoot: null,
    },
  });

  await session.handleMessage({
    type: "fetch_workspaces_request",
    requestId: "req-fetch-workspaces-runtime",
  });

  const response = emitted.find((message) => message.type === "fetch_workspaces_response") as
    | { type: "fetch_workspaces_response"; payload: Record<string, unknown> }
    | undefined;

  expect(workspaceGitService.peekSnapshot).toHaveBeenCalledWith("/tmp/repo");
  expect(response?.payload.entries).toEqual([
    expect.objectContaining({
      id: "ws-runtime-fetch",
      gitRuntime: {
        currentBranch: "runtime-branch",
        remoteUrl: "https://github.com/acme/repo.git",
        isPaseoOwnedWorktree: false,
        isDirty: true,
        aheadBehind: { ahead: 3, behind: 1 },
        aheadOfOrigin: 3,
        behindOfOrigin: 1,
      },
      githubRuntime: {
        featuresEnabled: true,
        pullRequest: {
          url: "https://github.com/acme/repo/pull/456",
          title: "Ship runtime payloads",
          state: "open",
          baseRefName: "main",
          headRefName: "runtime-branch",
          isMerged: false,
        },
        error: null,
      },
    }),
  ]);
});

test("fetch_workspaces_response emits before cold registration-triggered git work starts", async () => {
  const events: string[] = [];
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const workspaceGitService = createNoopWorkspaceGitService();
  const getSnapshot = vi.fn(async (cwd: string) => {
    events.push(`git:${cwd}`);
    return createWorkspaceRuntimeSnapshot(cwd);
  });
  workspaceGitService.getSnapshot = getSnapshot;
  workspaceGitService.registerWorkspace = vi.fn((params: { cwd: string }) => {
    queueMicrotask(() => {
      void getSnapshot(params.cwd);
    });
    return {
      unsubscribe: () => {},
    };
  });
  const session = asTestSession(
    createSessionForWorkspaceTests({
      workspaceGitService,
    }),
  );
  const project = createPersistedProjectRecord({
    projectId: "proj-fetch-boundary",
    rootPath: "/tmp/repo",
    kind: "git",
    displayName: "repo",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-fetch-boundary",
    projectId: project.projectId,
    cwd: "/tmp/repo",
    kind: "local_checkout",
    displayName: "main",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });

  session.emit = (message: unknown) => {
    const typed = message as { type: string; payload: unknown };
    if (typed.type === "fetch_workspaces_response") {
      events.push("response");
    }
    emitted.push(typed);
  };
  session.listAgentPayloads = async () => [];
  session.projectRegistry.list = async () => [project];
  session.workspaceRegistry.list = async () => [workspace];

  await session.handleMessage({
    type: "fetch_workspaces_request",
    requestId: "req-fetch-workspaces-boundary",
    subscribe: {},
  });

  expect(emitted.find((message) => message.type === "fetch_workspaces_response")).toBeDefined();
  expect(events[0]).toBe("response");
});

test("workspace_update includes updated runtime fields", async () => {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const runtimeSnapshot = createWorkspaceRuntimeSnapshot("/tmp/repo", {
    git: {
      currentBranch: "feature/runtime-payloads",
      isDirty: true,
    },
    github: {
      pullRequest: {
        url: "https://github.com/acme/repo/pull/789",
        title: "Updated runtime payloads",
        state: "merged",
        baseRefName: "main",
        headRefName: "feature/runtime-payloads",
        isMerged: true,
      },
    },
  });
  const workspaceGitService = createNoopWorkspaceGitService();
  workspaceGitService.peekSnapshot = vi.fn(() => runtimeSnapshot);

  const session = asTestSession(
    createSessionForWorkspaceTests({
      workspaceGitService,
    }),
  );
  const project = createPersistedProjectRecord({
    projectId: "proj-runtime-update",
    rootPath: "/tmp/repo",
    kind: "git",
    displayName: "repo",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-runtime-update",
    projectId: project.projectId,
    cwd: "/tmp/repo",
    kind: "local_checkout",
    displayName: "main",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });

  session.emit = (message) => emitted.push(message as { type: string; payload: unknown });
  session.workspaceUpdatesSubscription = {
    subscriptionId: "sub-runtime",
    filter: undefined,
    isBootstrapping: false,
    pendingUpdatesByWorkspaceId: new Map(),
    lastEmittedByWorkspaceId: new Map(),
  };
  session.reconcileActiveWorkspaceRecords = async () => new Set();
  session.listAgentPayloads = async () => [];
  session.projectRegistry.list = async () => [project];
  session.workspaceRegistry.list = async () => [workspace];
  session.buildProjectPlacement = async (cwd: string) => ({
    projectKey: cwd,
    projectName: "repo",
    checkout: {
      cwd,
      isGit: true,
      currentBranch: runtimeSnapshot.git.currentBranch,
      remoteUrl: runtimeSnapshot.git.remoteUrl,
      worktreeRoot: cwd,
      isPaseoOwnedWorktree: false,
      mainRepoRoot: null,
    },
  });

  await session.emitWorkspaceUpdateForCwd("/tmp/repo", {
    skipReconcile: true,
  });

  expect(workspaceGitService.peekSnapshot).toHaveBeenCalledWith("/tmp/repo");
  expect(emitted).toContainEqual({
    type: "workspace_update",
    payload: {
      kind: "upsert",
      workspace: expect.objectContaining({
        id: "ws-runtime-update",
        gitRuntime: expect.objectContaining({
          currentBranch: "feature/runtime-payloads",
          isDirty: true,
        }),
        githubRuntime: expect.objectContaining({
          featuresEnabled: true,
          pullRequest: expect.objectContaining({
            title: "Updated runtime payloads",
            isMerged: true,
          }),
        }),
      }),
    },
  });
});

test("subscribed fetch_workspaces includes git enrichment in the initial snapshot", async () => {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const session = createSessionForWorkspaceTests();
  const gitProject = createPersistedProjectRecord({
    projectId: "proj-git-subscribe",
    rootPath: "/tmp/repo",
    kind: "git",
    displayName: "repo",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const directoryProject = createPersistedProjectRecord({
    projectId: "proj-docs-subscribe",
    rootPath: "/tmp/docs",
    kind: "non_git",
    displayName: "docs",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const gitWorkspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-git-subscribe",
    projectId: gitProject.projectId,
    cwd: "/tmp/repo",
    kind: "local_checkout",
    displayName: "main",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const directoryWorkspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-docs-subscribe",
    projectId: directoryProject.projectId,
    cwd: "/tmp/docs",
    kind: "directory",
    displayName: "docs",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const baselineGitDescriptor = {
    id: gitWorkspace.workspaceId,
    projectId: gitProject.projectId,
    projectDisplayName: gitProject.displayName,
    projectRootPath: gitProject.rootPath,
    workspaceDirectory: gitWorkspace.cwd,
    projectKind: gitProject.kind,
    workspaceKind: gitWorkspace.kind,
    name: "main",
    status: "done",
    activityAt: null,
    diffStat: null,
  } as const;
  const enrichedGitDescriptor = {
    ...baselineGitDescriptor,
    diffStat: { additions: 3, deletions: 1 },
  } as const;
  const directoryDescriptor = {
    id: directoryWorkspace.workspaceId,
    projectId: directoryProject.projectId,
    projectDisplayName: directoryProject.displayName,
    projectRootPath: directoryProject.rootPath,
    workspaceDirectory: directoryWorkspace.cwd,
    projectKind: directoryProject.kind,
    workspaceKind: directoryWorkspace.kind,
    name: "docs",
    status: "done",
    activityAt: null,
    diffStat: null,
  } as const;

  session.emit = (message) => emitted.push(message as { type: string; payload: unknown });
  session.listAgentPayloads = async () => [];
  session.projectRegistry.list = async () => [gitProject, directoryProject];
  session.workspaceRegistry.list = async () => [gitWorkspace, directoryWorkspace];
  session.reconcileAndEmitWorkspaceUpdates = vi.fn(async () => {});
  session.describeWorkspaceRecord = vi.fn(
    async (workspace: typeof gitWorkspace | typeof directoryWorkspace, project: unknown) => {
      if (workspace.workspaceId === gitWorkspace.workspaceId) {
        expect(project).toEqual(gitProject);
        return baselineGitDescriptor;
      }
      expect(project).toEqual(directoryProject);
      return directoryDescriptor;
    },
  );
  session.describeWorkspaceRecordWithGitData = vi.fn(async () => enrichedGitDescriptor);

  await session.handleMessage({
    type: "fetch_workspaces_request",
    requestId: "req-fetch-workspaces",
    subscribe: {},
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const response = emitted.find((message) => message.type === "fetch_workspaces_response") as
    | {
        type: "fetch_workspaces_response";
        payload: {
          entries: Array<typeof baselineGitDescriptor | typeof directoryDescriptor>;
          [key: string]: unknown;
        };
      }
    | undefined;
  expect(
    response?.payload.entries.map(
      (entry: typeof baselineGitDescriptor | typeof directoryDescriptor) => [
        entry.id,
        entry.diffStat,
      ],
    ),
  ).toEqual([
    [directoryDescriptor.id, directoryDescriptor.diffStat],
    [enrichedGitDescriptor.id, enrichedGitDescriptor.diffStat],
  ]);

  const workspaceUpdates = emitted.filter(
    (message) => message.type === "workspace_update",
  ) as Array<{ type: "workspace_update"; payload: Record<string, unknown> }>;
  expect(workspaceUpdates).toEqual([]);
  expect(session.describeWorkspaceRecordWithGitData).toHaveBeenCalledWith(gitWorkspace, gitProject);
});

test("resolveRegisteredWorkspaceIdForCwd does not match home directory as a prefix", () => {
  const session = createSessionForWorkspaceTests();
  const home = homedir();
  const childCwd = path.join(home, "projects/new-app");
  const homeWorkspace = createPersistedWorkspaceRecord({
    workspaceId: home,
    projectId: "proj-home",
    cwd: home,
    kind: "directory",
    displayName: "home",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });

  expect(session.resolveRegisteredWorkspaceIdForCwd(childCwd, [homeWorkspace])).toBe(childCwd);
  expect(session.resolveRegisteredWorkspaceIdForCwd(home, [homeWorkspace])).toBe(home);
});
