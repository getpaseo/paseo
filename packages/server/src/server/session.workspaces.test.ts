import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { z } from "zod";
import { Session } from "./session.js";
import type { AgentSnapshotPayload, SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { AgentManager } from "./agent/agent-manager.js";
import { AgentStorage, type StoredAgentRecord } from "./agent/agent-storage.js";
import type {
  AgentClient,
  AgentCreateSessionOptions,
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "./agent/agent-sdk-types.js";
import type { WorkspaceGitRuntimeSnapshot } from "./workspace-git-service.js";
import { createNoopWorkspaceGitService } from "./test-utils/workspace-git-service-stub.js";
import {
  asSessionLogger,
  asAgentManager,
  asAgentStorage,
  asDownloadTokenStore,
  asPushTokenStore,
  asChatService,
  asScheduleService,
  asLoopService,
  asCheckoutDiffManager,
  asDaemonConfigStore,
  asTerminalManager,
  asSessionInternals,
  createProviderSnapshotManagerStub,
  isSessionOutboundMessage,
  filterByType,
  findByType,
} from "./test-utils/session-stubs.js";
import {
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
} from "./workspace-registry.js";

const REPO_CWD = path.resolve("/tmp/repo");
const UNREGISTERED_CWD = path.resolve("/tmp/unregistered");

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
    upsert(record: unknown): Promise<void>;
  };
  agentManager: {
    listAgents(): unknown[];
    listImportableSessions(options?: unknown): Promise<unknown[]>;
    importProviderSession(input: unknown): Promise<unknown>;
    resumeAgentFromPersistence(
      handle: unknown,
      overrides?: unknown,
      preferredId?: string,
      extras?: unknown,
    ): Promise<unknown>;
    hydrateTimelineFromProvider(agentId: string): Promise<unknown>;
    getTimeline(agentId: string): readonly unknown[];
    setTitle(agentId: string, title: string): Promise<unknown>;
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
  reconcileWorkspaceRecord(workspaceId: string): Promise<{
    changed: boolean;
    workspace?: Record<string, unknown> | null;
    removedWorkspaceId?: string | null;
    [key: string]: unknown;
  }>;
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
  paseoHome: string;
  terminalManager: {
    killTerminal(id: string): unknown;
    clearTerminalAttention?(id: string): Promise<boolean>;
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
  return asSessionInternals<TestSession>(session);
}

const AgentIdEntrySchema = z.object({ agent: z.object({ id: z.string() }) });

function makeAgent(input: {
  id: string;
  cwd: string;
  status: AgentSnapshotPayload["status"];
  updatedAt: string;
  pendingPermissions?: number;
  requiresAttention?: boolean;
  attentionReason?: AgentSnapshotPayload["attentionReason"];
  attentionTimestamp?: string | null;
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
    attentionTimestamp: input.attentionTimestamp ?? null,
    archivedAt: null,
  };
}

function makeStoredAgent(input: {
  id: string;
  cwd: string;
  updatedAt: string;
  requiresAttention?: boolean;
  attentionReason?: StoredAgentRecord["attentionReason"];
}): StoredAgentRecord {
  return {
    id: input.id,
    provider: "codex",
    cwd: input.cwd,
    createdAt: input.updatedAt,
    updatedAt: input.updatedAt,
    lastActivityAt: input.updatedAt,
    lastUserMessageAt: null,
    title: null,
    labels: {},
    lastStatus: "closed",
    lastModeId: null,
    config: { provider: "codex", cwd: input.cwd },
    runtimeInfo: { provider: "codex", sessionId: null },
    features: [],
    persistence: null,
    lastError: null,
    requiresAttention: input.requiresAttention ?? false,
    attentionReason: input.attentionReason ?? null,
    attentionTimestamp: input.requiresAttention ? input.updatedAt : null,
    internal: false,
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

function makeImportableProviderSession(input: {
  provider: string;
  sessionId: string;
  nativeHandle?: string;
  cwd: string;
  title?: string | null;
  lastActivityAt: string;
  firstPrompt?: string;
}): {
  provider: string;
  providerHandleId: string;
  cwd: string;
  title: string | null;
  firstPromptPreview: string | null;
  lastPromptPreview: string | null;
  lastActivityAt: Date;
} {
  return {
    provider: input.provider,
    providerHandleId: input.nativeHandle ?? input.sessionId,
    cwd: input.cwd,
    title: input.title ?? null,
    firstPromptPreview: input.firstPrompt ?? null,
    lastPromptPreview: input.firstPrompt ?? null,
    lastActivityAt: new Date(input.lastActivityAt),
  };
}

function agentIdsFromEntries(entries: Array<Record<string, unknown>>) {
  return entries.map((entry) => AgentIdEntrySchema.parse(entry).agent.id);
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

const CREATE_AGENT_TEST_CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

class CreateAgentTestSession implements AgentSession {
  readonly provider = "codex";
  readonly id = "create-agent-test-session";
  readonly capabilities = CREATE_AGENT_TEST_CAPABILITIES;

  constructor(private readonly config: AgentSessionConfig) {}

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(): Promise<{ turnId: string }> {
    return { turnId: "turn-1" };
  }

  subscribe(): () => void {
    return () => {};
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return {
      provider: this.provider,
      sessionId: this.id,
      model: this.config.model ?? null,
      modeId: this.config.modeId ?? null,
    };
  }

  async getAvailableModes() {
    return [];
  }

  async getCurrentMode() {
    return null;
  }

  async setMode(): Promise<void> {}

  getPendingPermissions() {
    return [];
  }

  async respondToPermission(): Promise<void> {}

  describePersistence(): AgentPersistenceHandle {
    return { provider: this.provider, sessionId: this.id };
  }

  async interrupt(): Promise<void> {}

  async close(): Promise<void> {}
}

class CreateAgentTestClient implements AgentClient {
  readonly provider = "codex";
  readonly capabilities = CREATE_AGENT_TEST_CAPABILITIES;

  async createSession(
    config: AgentSessionConfig,
    _launchContext?: AgentLaunchContext,
    _options?: AgentCreateSessionOptions,
  ): Promise<AgentSession> {
    return new CreateAgentTestSession(config);
  }

  async resumeSession(
    _handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
  ): Promise<AgentSession> {
    return new CreateAgentTestSession({
      provider: this.provider,
      cwd: overrides?.cwd ?? process.cwd(),
    });
  }

  async listModels() {
    return [{ provider: this.provider, id: "gpt-test", label: "GPT Test", isDefault: true }];
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

function createSessionForWorkspaceTests(
  options: {
    appVersion?: string | null;
    onMessage?: (message: SessionOutboundMessage) => void;
    workspaceGitService?: ReturnType<typeof createNoopWorkspaceGitService>;
    terminalManager?: ReturnType<typeof asTerminalManager> | null;
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
      logger: asSessionLogger(logger),
      downloadTokenStore: asDownloadTokenStore(),
      pushTokenStore: asPushTokenStore(),
      paseoHome: "/tmp/paseo-test",
      agentManager: asAgentManager({
        subscribe: () => () => {},
        listAgents: () => [],
        getAgent: () => null,
        archiveAgent: async () => ({ archivedAt: new Date().toISOString() }),
        archiveSnapshot: async () => ({}),
        clearAgentAttention: async () => {},
        notifyAgentState: () => {},
      }),
      agentStorage: asAgentStorage({
        list: async () => [
          createPersistedWorkspaceRecord({
            workspaceId: "ws-repo-running",
            projectId: "proj-repo-running",
            cwd: REPO_CWD,
            kind: "directory",
            displayName: "repo",
            createdAt: "2026-03-01T12:00:00.000Z",
            updatedAt: "2026-03-01T12:00:00.000Z",
          }),
        ],
        get: async (workspaceId: string) =>
          workspaceId === "ws-repo-running"
            ? createPersistedWorkspaceRecord({
                workspaceId: "ws-repo-running",
                projectId: "proj-repo-running",
                cwd: REPO_CWD,
                kind: "directory",
                displayName: "repo",
                createdAt: "2026-03-01T12:00:00.000Z",
                updatedAt: "2026-03-01T12:00:00.000Z",
              })
            : null,
        upsert: async () => {},
      }),
      projectRegistry: {
        initialize: async () => {},
        existsOnDisk: async () => true,
        list: async () => [],
        get: async () => null,
        upsert: async () => {},
        archive: async () => {},
        remove: async () => {},
      },
      workspaceRegistry: {
        initialize: async () => {},
        existsOnDisk: async () => true,
        list: async () => [
          createPersistedWorkspaceRecord({
            workspaceId: "ws-repo-running",
            projectId: "proj-repo-running",
            cwd: REPO_CWD,
            kind: "directory",
            displayName: "repo",
            createdAt: "2026-03-01T12:00:00.000Z",
            updatedAt: "2026-03-01T12:00:00.000Z",
          }),
        ],
        get: async (workspaceId: string) =>
          workspaceId === "ws-repo-running"
            ? createPersistedWorkspaceRecord({
                workspaceId: "ws-repo-running",
                projectId: "proj-repo-running",
                cwd: REPO_CWD,
                kind: "directory",
                displayName: "repo",
                createdAt: "2026-03-01T12:00:00.000Z",
                updatedAt: "2026-03-01T12:00:00.000Z",
              })
            : null,
        upsert: async () => {},
        archive: async () => {},
        remove: async () => {},
      },
      filesystem: { isDirectory: async () => true },
      chatService: asChatService(),
      scheduleService: asScheduleService(),
      loopService: asLoopService(),
      checkoutDiffManager: asCheckoutDiffManager({
        subscribe: async () => ({
          initial: { cwd: "/tmp", files: [], error: null },
          unsubscribe: () => {},
        }),
        scheduleRefreshForCwd: () => {},
        onWorkspaceStateMayHaveChanged: () => {},
        getMetrics: () => ({
          checkoutDiffTargetCount: 0,
          checkoutDiffSubscriptionCount: 0,
          checkoutDiffWatcherCount: 0,
          checkoutDiffFallbackRefreshTargetCount: 0,
        }),
        dispose: () => {},
      }),
      workspaceGitService: options.workspaceGitService ?? createNoopWorkspaceGitService(),
      daemonConfigStore: asDaemonConfigStore({
        get: () => ({ mcp: { injectIntoAgents: false }, providers: {} }),
        onChange: () => () => {},
      }),
      mcpBaseUrl: null,
      stt: null,
      tts: null,
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      terminalManager: options.terminalManager ?? null,
    }),
  );
  return session;
}

test("client heartbeat clears attention for the focused terminal", async () => {
  const clearedTerminalIds: string[] = [];
  const session = createSessionForWorkspaceTests({
    terminalManager: asTerminalManager({
      subscribeTerminalsChanged: () => () => {},
      clearTerminalAttention: async (terminalId: string) => {
        clearedTerminalIds.push(terminalId);
        return true;
      },
    }),
  });

  await session.handleMessage({
    type: "client_heartbeat",
    deviceType: "web",
    focusedAgentId: null,
    focusedTerminalId: "terminal-1",
    lastActivityAt: "2026-06-13T12:00:00.000Z",
    appVisible: true,
  });

  expect(clearedTerminalIds).toEqual(["terminal-1"]);
  expect(session.getClientActivity()).toMatchObject({
    focusedAgentId: null,
    focusedTerminalId: "terminal-1",
    appVisible: true,
  });
});

test("create_agent_request keeps requested child cwd when grouped under an existing parent workspace", async () => {
  const workdir = mkdtempSync(path.join(tmpdir(), "paseo-create-agent-cwd-"));
  try {
    const parent = path.join(workdir, "parent");
    const child = path.join(parent, "child");
    mkdirSync(child, { recursive: true });

    const logger = {
      child: () => logger,
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const agentStorage = new AgentStorage(path.join(workdir, "agents"), asSessionLogger(logger));
    const agentManager = new AgentManager({
      clients: { codex: new CreateAgentTestClient() },
      registry: agentStorage,
      logger: asSessionLogger(logger),
      idFactory: () => "00000000-0000-4000-8000-000000000551",
    });
    const projectRegistry = new FileBackedProjectRegistry(
      path.join(workdir, "projects.json"),
      asSessionLogger(logger),
    );
    const workspaceRegistry = new FileBackedWorkspaceRegistry(
      path.join(workdir, "workspaces.json"),
      asSessionLogger(logger),
    );
    const workspaceGitService = createNoopWorkspaceGitService({
      getCheckout: async (cwd: string) => ({
        cwd,
        isGit: true,
        currentBranch: "main",
        remoteUrl: null,
        worktreeRoot: parent,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      }),
    });

    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "proj-parent",
        rootPath: parent,
        kind: "git",
        displayName: "parent",
        createdAt: "2026-05-07T00:00:00.000Z",
        updatedAt: "2026-05-07T00:00:00.000Z",
      }),
    );
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "ws-parent",
        projectId: "proj-parent",
        cwd: parent,
        kind: "local_checkout",
        displayName: "parent",
        createdAt: "2026-05-07T00:00:00.000Z",
        updatedAt: "2026-05-07T00:00:00.000Z",
      }),
    );

    const emitted: SessionOutboundMessage[] = [];
    const session = asTestSession(
      new Session({
        clientId: "test-client",
        appVersion: null,
        onMessage: (message) => emitted.push(message),
        logger: asSessionLogger(logger),
        downloadTokenStore: asDownloadTokenStore(),
        pushTokenStore: asPushTokenStore(),
        paseoHome: path.join(workdir, "paseo-home"),
        agentManager,
        agentStorage,
        projectRegistry,
        workspaceRegistry,
        chatService: asChatService(),
        scheduleService: asScheduleService(),
        loopService: asLoopService(),
        checkoutDiffManager: asCheckoutDiffManager({
          subscribe: async () => ({
            initial: { cwd: child, files: [], error: null },
            unsubscribe: () => {},
          }),
          scheduleRefreshForCwd: () => {},
          onWorkspaceStateMayHaveChanged: () => {},
          getMetrics: () => ({
            checkoutDiffTargetCount: 0,
            checkoutDiffSubscriptionCount: 0,
            checkoutDiffWatcherCount: 0,
            checkoutDiffFallbackRefreshTargetCount: 0,
          }),
          dispose: () => {},
        }),
        workspaceGitService,
        daemonConfigStore: asDaemonConfigStore({
          get: () => ({ mcp: { injectIntoAgents: false }, providers: {} }),
          onChange: () => () => {},
        }),
        mcpBaseUrl: null,
        stt: null,
        tts: null,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
        terminalManager: null,
      }),
    );

    await session.handleMessage({
      type: "create_agent_request",
      requestId: "req-create-child",
      config: { provider: "codex", cwd: child },
      attachments: [],
    });

    const [createdAgent] = agentManager.listAgents();
    expect(createdAgent?.cwd).toBe(child);
    await expect(session.buildProjectPlacementForCwd(createdAgent.cwd)).resolves.toMatchObject({
      projectKey: "proj-parent",
      checkout: { cwd: parent },
    });
    expect(findByType(emitted, "status")?.payload).toMatchObject({
      status: "agent_created",
      agent: { cwd: child },
    });
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("unsupported persisted agents are excluded from active lists but preserved in history payloads", async () => {
  const session = createSessionForWorkspaceTests({ appVersion: "0.1.45" });
  const storedRecord = {
    id: "agent-unsupported",
    provider: "gemini",
    cwd: path.resolve("/tmp/history"),
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
  expect(projects.get("proj-missing")?.archivedAt).toBeFalsy();
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
    rootPath: REPO_CWD,
    kind: "git",
    displayName: "repo",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-1",
    projectId: project.projectId,
    cwd: REPO_CWD,
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
      cwd: REPO_CWD,
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

test("agent_update emits a directory-scoped placement when no workspace is registered", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const getSnapshot = vi.fn(async () => {
    throw new Error("getSnapshot should not be called for unregistered agent_update placement");
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
      cwd: UNREGISTERED_CWD,
      lifecycle: "running",
      updatedAt: "2026-03-30T15:00:00.000Z",
    }),
  );

  expect(getSnapshot).not.toHaveBeenCalled();
  // An agent in a directory with no registered workspace must still emit an
  // upsert (live model/thinking switches depend on this). It gets a directory-
  // scoped placement keyed by the path — a project key, not a workspace id.
  const update = emitted.find((message) => message.type === "agent_update");
  if (update?.type !== "agent_update" || update.payload.kind !== "upsert") {
    throw new Error("expected an agent_update upsert");
  }
  expect(update.payload.agent.id).toBe("agent-1");
  expect(update.payload.project?.checkout.isGit).toBe(false);
});

test("archive emits an authoritative agent_update upsert for subscribed clients", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const archivedRecord = {
    id: "agent-1",
    provider: "codex",
    cwd: REPO_CWD,
    createdAt: "2026-03-30T15:00:00.000Z",
    updatedAt: "2026-03-30T15:00:00.000Z",
    lastActivityAt: "2026-03-30T15:00:00.000Z",
    lastUserMessageAt: null,
    lastStatus: "idle",
    lastModeId: null,
    runtimeInfo: null,
    config: {
      provider: "codex",
      cwd: REPO_CWD,
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
      logger: asSessionLogger(logger),
      downloadTokenStore: asDownloadTokenStore(),
      pushTokenStore: asPushTokenStore(),
      paseoHome: "/tmp/paseo-test",
      agentManager: asAgentManager({
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
      }),
      agentStorage: asAgentStorage({
        list: async () => [archivedRecord],
        get: async (agentId: string) => (agentId === archivedRecord.id ? archivedRecord : null),
        upsert: async (record: typeof archivedRecord) => {
          Object.assign(archivedRecord, record);
        },
      }),
      projectRegistry: (() => {
        const proj = createPersistedProjectRecord({
          projectId: "proj-1",
          rootPath: REPO_CWD,
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
      })(),
      workspaceRegistry: (() => {
        const ws = createPersistedWorkspaceRecord({
          workspaceId: "ws-1",
          projectId: "proj-1",
          cwd: REPO_CWD,
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
      })(),
      chatService: asChatService(),
      scheduleService: asScheduleService(),
      loopService: asLoopService(),
      checkoutDiffManager: asCheckoutDiffManager({
        subscribe: async () => ({
          initial: { cwd: REPO_CWD, files: [], error: null },
          unsubscribe: () => {},
        }),
        scheduleRefreshForCwd: () => {},
        onWorkspaceStateMayHaveChanged: () => {},
        getMetrics: () => ({
          checkoutDiffTargetCount: 0,
          checkoutDiffSubscriptionCount: 0,
          checkoutDiffWatcherCount: 0,
          checkoutDiffFallbackRefreshTargetCount: 0,
        }),
        dispose: () => {},
      }),
      workspaceGitService: createNoopWorkspaceGitService(),
      daemonConfigStore: asDaemonConfigStore({
        get: () => ({ mcp: { injectIntoAgents: false }, providers: {} }),
        onChange: () => () => {},
      }),
      mcpBaseUrl: null,
      stt: null,
      tts: null,
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
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

test("workspace clear attention clears stored-only agents and responds", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: REPO_CWD,
    projectId: REPO_CWD,
    cwd: REPO_CWD,
    kind: "directory",
    displayName: "repo",
    createdAt: "2026-03-30T15:00:00.000Z",
    updatedAt: "2026-03-30T15:00:00.000Z",
  });
  const project = createPersistedProjectRecord({
    projectId: REPO_CWD,
    rootPath: REPO_CWD,
    kind: "non_git",
    displayName: "repo",
    createdAt: "2026-03-30T15:00:00.000Z",
    updatedAt: "2026-03-30T15:00:00.000Z",
  });
  let storedRecord = makeStoredAgent({
    id: "stored-agent-1",
    cwd: REPO_CWD,
    updatedAt: "2026-03-30T15:00:00.000Z",
    requiresAttention: true,
    attentionReason: "finished",
  });
  const session = createSessionForWorkspaceTests({ onMessage: (message) => emitted.push(message) });

  session.workspaceRegistry.list = async () => [workspace];
  session.workspaceRegistry.get = async (id: string) =>
    id === workspace.workspaceId ? workspace : null;
  session.projectRegistry.list = async () => [project];
  session.projectRegistry.get = async (id: string) => (id === project.projectId ? project : null);
  session.agentStorage.get = async (agentId: string) =>
    agentId === storedRecord.id ? storedRecord : null;
  session.agentStorage.upsert = async (record: unknown) => {
    storedRecord = record as StoredAgentRecord;
  };
  session.listAgentPayloads = async () => [
    makeAgent({
      id: storedRecord.id,
      cwd: storedRecord.cwd,
      status: "closed",
      updatedAt: storedRecord.updatedAt,
      requiresAttention: true,
      attentionReason: "finished",
    }),
  ];

  await session.handleMessage({
    type: "workspace.clear_attention.request",
    workspaceId: workspace.workspaceId,
    requestId: "req-1",
  });

  expect(storedRecord.requiresAttention).toBe(false);
  expect(storedRecord.attentionReason).toBeNull();
  expect(storedRecord.attentionTimestamp).toBeNull();
  expect(findByType(emitted, "workspace.clear_attention.response").payload).toMatchObject({
    requestId: "req-1",
    workspaceId: workspace.workspaceId,
    clearedAgentIds: [storedRecord.id],
    success: true,
    error: null,
  });
  const agentUpdate = findByType(emitted, "agent_update");
  expect(agentUpdate.payload.kind).toBe("upsert");
  if (agentUpdate.payload.kind === "upsert") {
    expect(agentUpdate.payload.agent.requiresAttention).toBe(false);
  }
});

test("workspace clear attention responds with an error instead of timing out", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const session = createSessionForWorkspaceTests({ onMessage: (message) => emitted.push(message) });
  session.workspaceRegistry.get = async () => null;

  await session.handleMessage({
    type: "workspace.clear_attention.request",
    workspaceId: "missing-workspace",
    requestId: "req-1",
  });

  expect(findByType(emitted, "workspace.clear_attention.response").payload).toMatchObject({
    requestId: "req-1",
    workspaceId: "missing-workspace",
    clearedAgentIds: [],
    success: false,
    error: "Workspace not found: missing-workspace",
  });
});

test("workspace clear attention can clear multiple workspaces in one request", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const workspaces = [
    createPersistedWorkspaceRecord({
      workspaceId: "ws-repo-a",
      projectId: "/tmp/repo-a",
      cwd: "/tmp/repo-a",
      kind: "directory",
      displayName: "repo-a",
      createdAt: "2026-03-30T15:00:00.000Z",
      updatedAt: "2026-03-30T15:00:00.000Z",
    }),
    createPersistedWorkspaceRecord({
      workspaceId: "ws-repo-b",
      projectId: "/tmp/repo-b",
      cwd: "/tmp/repo-b",
      kind: "directory",
      displayName: "repo-b",
      createdAt: "2026-03-30T15:00:00.000Z",
      updatedAt: "2026-03-30T15:00:00.000Z",
    }),
  ];
  const projects = workspaces.map((workspace) =>
    createPersistedProjectRecord({
      projectId: workspace.projectId,
      rootPath: workspace.cwd,
      kind: "non_git",
      displayName: workspace.displayName,
      createdAt: "2026-03-30T15:00:00.000Z",
      updatedAt: "2026-03-30T15:00:00.000Z",
    }),
  );
  const storedRecords = new Map(
    workspaces.map((workspace, index) => [
      `stored-agent-${index + 1}`,
      makeStoredAgent({
        id: `stored-agent-${index + 1}`,
        cwd: workspace.cwd,
        updatedAt: "2026-03-30T15:00:00.000Z",
        requiresAttention: true,
        attentionReason: "finished",
      }),
    ]),
  );
  const session = createSessionForWorkspaceTests({ onMessage: (message) => emitted.push(message) });

  session.workspaceRegistry.list = async () => workspaces;
  session.workspaceRegistry.get = async (id: string) =>
    workspaces.find((workspace) => workspace.workspaceId === id) ?? null;
  session.projectRegistry.list = async () => projects;
  session.projectRegistry.get = async (id: string) =>
    projects.find((project) => project.projectId === id) ?? null;
  session.agentStorage.get = async (agentId: string) => storedRecords.get(agentId) ?? null;
  session.agentStorage.upsert = async (record: unknown) => {
    const storedRecord = record as StoredAgentRecord;
    storedRecords.set(storedRecord.id, storedRecord);
  };
  session.listAgentPayloads = async () =>
    Array.from(storedRecords.values()).map((record) =>
      makeAgent({
        id: record.id,
        cwd: record.cwd,
        status: "closed",
        updatedAt: record.updatedAt,
        requiresAttention: record.requiresAttention,
        attentionReason: record.attentionReason,
      }),
    );

  await session.handleMessage({
    type: "workspace.clear_attention.request",
    workspaceId: workspaces.map((workspace) => workspace.workspaceId),
    requestId: "req-1",
  });

  expect(Array.from(storedRecords.values()).map((record) => record.requiresAttention)).toEqual([
    false,
    false,
  ]);
  expect(findByType(emitted, "workspace.clear_attention.response").payload).toMatchObject({
    requestId: "req-1",
    workspaceId: workspaces.map((workspace) => workspace.workspaceId),
    clearedAgentIds: ["stored-agent-1", "stored-agent-2"],
    results: [
      {
        workspaceId: workspaces[0].workspaceId,
        clearedAgentIds: ["stored-agent-1"],
        success: true,
        error: null,
      },
      {
        workspaceId: workspaces[1].workspaceId,
        clearedAgentIds: ["stored-agent-2"],
        success: true,
        error: null,
      },
    ],
    success: true,
    error: null,
  });
});

test("close_items_request archives agents and kills terminals in one batch", async () => {
  const emitted: SessionOutboundMessage[] = [];
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
    cwd: REPO_CWD,
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
  const killTerminal = vi.fn();
  const cancelAgentRun = vi.fn(async () => true);
  const session = asTestSession(
    new Session({
      clientId: "test-client",
      onMessage: (message) => emitted.push(message),
      logger: asSessionLogger(sessionLogger),
      downloadTokenStore: asDownloadTokenStore(),
      pushTokenStore: asPushTokenStore(),
      paseoHome: "/tmp/paseo-test",
      agentManager: asAgentManager({
        subscribe: () => () => {},
        listAgents: () => [],
        getAgent: (agentId: string) => (agentId === "agent-1" ? { id: agentId } : null),
        hasInFlightRun: (agentId: string) => agentId === "agent-1",
        cancelAgentRun,
        archiveAgent: async () => ({ archivedAt }),
        clearAgentAttention: async () => {},
        notifyAgentState: () => {},
      }),
      agentStorage: asAgentStorage({
        list: async () => [],
        get: async (agentId: string) => {
          if (agentId !== "agent-1") {
            return null;
          }
          archivedRecord.archivedAt = archivedAt;
          archivedRecord.updatedAt = archivedAt;
          return archivedRecord;
        },
      }),
      projectRegistry: (() => {
        const proj = createPersistedProjectRecord({
          projectId: "proj-close",
          rootPath: REPO_CWD,
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
      })(),
      workspaceRegistry: (() => {
        const ws = createPersistedWorkspaceRecord({
          workspaceId: "ws-close",
          projectId: "proj-close",
          cwd: REPO_CWD,
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
      })(),
      chatService: asChatService(),
      scheduleService: asScheduleService(),
      loopService: asLoopService(),
      checkoutDiffManager: asCheckoutDiffManager({
        subscribe: async () => ({
          initial: { cwd: "/tmp", files: [], error: null },
          unsubscribe: () => {},
        }),
        scheduleRefreshForCwd: () => {},
        onWorkspaceStateMayHaveChanged: () => {},
        getMetrics: () => ({
          checkoutDiffTargetCount: 0,
          checkoutDiffSubscriptionCount: 0,
          checkoutDiffWatcherCount: 0,
          checkoutDiffFallbackRefreshTargetCount: 0,
        }),
        dispose: () => {},
      }),
      workspaceGitService: createNoopWorkspaceGitService(),
      daemonConfigStore: asDaemonConfigStore({
        get: () => ({ mcp: { injectIntoAgents: false }, providers: {} }),
        onChange: () => () => {},
      }),
      mcpBaseUrl: null,
      stt: null,
      tts: null,
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      terminalManager: asTerminalManager({
        killTerminal,
        subscribeTerminalsChanged: () => () => {},
      }),
    }),
  );

  session.agentUpdatesSubscription = {
    subscriptionId: "sub-agents",
    filter: { includeArchived: true },
    isBootstrapping: false,
    pendingUpdatesByAgentId: new Map(),
  };

  await session.handleMessage({
    type: "close_items_request",
    agentIds: ["agent-1"],
    terminalIds: ["term-1"],
    requestId: "req-close-items",
  });

  expect(cancelAgentRun).toHaveBeenCalledWith("agent-1");
  expect(killTerminal).toHaveBeenCalledWith("term-1");
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
  const emitted: SessionOutboundMessage[] = [];
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
      cwd: REPO_CWD,
      status: "idle",
      updatedAt: "2026-03-01T12:00:00.000Z",
    }),
    archivedAt: null as string | null,
  };
  const storedRecord = {
    ...makeAgent({
      id: storedAgentId,
      cwd: REPO_CWD,
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
      logger: asSessionLogger(sessionLogger),
      downloadTokenStore: asDownloadTokenStore(),
      pushTokenStore: asPushTokenStore(),
      paseoHome: "/tmp/paseo-test",
      agentManager: asAgentManager({
        subscribe: () => () => {},
        listAgents: () => [],
        getAgent: (agentId: string) => (agentId === "agent-live" ? { id: agentId } : null),
        hasInFlightRun: () => false,
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
      }),
      agentStorage: asAgentStorage({
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
      }),
      projectRegistry: (() => {
        const proj = createPersistedProjectRecord({
          projectId: "proj-stored",
          rootPath: REPO_CWD,
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
      })(),
      workspaceRegistry: (() => {
        const ws = createPersistedWorkspaceRecord({
          workspaceId: "ws-stored",
          projectId: "proj-stored",
          cwd: REPO_CWD,
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
      })(),
      chatService: asChatService(),
      scheduleService: asScheduleService(),
      loopService: asLoopService(),
      checkoutDiffManager: asCheckoutDiffManager({
        subscribe: async () => ({
          initial: { cwd: "/tmp", files: [], error: null },
          unsubscribe: () => {},
        }),
        scheduleRefreshForCwd: () => {},
        onWorkspaceStateMayHaveChanged: () => {},
        getMetrics: () => ({
          checkoutDiffTargetCount: 0,
          checkoutDiffSubscriptionCount: 0,
          checkoutDiffWatcherCount: 0,
          checkoutDiffFallbackRefreshTargetCount: 0,
        }),
        dispose: () => {},
      }),
      workspaceGitService: createNoopWorkspaceGitService(),
      daemonConfigStore: asDaemonConfigStore({
        get: () => ({ mcp: { injectIntoAgents: false }, providers: {} }),
        onChange: () => () => {},
      }),
      mcpBaseUrl: null,
      stt: null,
      tts: null,
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      terminalManager: null,
    }),
  );

  session.agentUpdatesSubscription = {
    subscriptionId: "sub-agents",
    filter: { includeArchived: true },
    isBootstrapping: false,
    pendingUpdatesByAgentId: new Map(),
  };

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
  const emitted: SessionOutboundMessage[] = [];
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
      cwd: REPO_CWD,
      status: "idle",
      updatedAt: "2026-03-01T12:00:00.000Z",
    }),
    archivedAt: null as string | null,
  };
  const killTerminalBestEffort = vi.fn();
  const session = asTestSession(
    new Session({
      clientId: "test-client",
      onMessage: (message) => emitted.push(message),
      logger: asSessionLogger(sessionLogger),
      downloadTokenStore: asDownloadTokenStore(),
      pushTokenStore: asPushTokenStore(),
      paseoHome: "/tmp/paseo-test",
      agentManager: asAgentManager({
        subscribe: () => () => {},
        listAgents: () => [],
        getAgent: (agentId: string) =>
          agentId === "agent-bad" || agentId === "agent-good" ? { id: agentId } : null,
        hasInFlightRun: () => false,
        archiveAgent: async (agentId: string) => {
          if (agentId === "agent-bad") {
            throw new Error("archive failed");
          }
          return { archivedAt };
        },
        clearAgentAttention: async () => {},
        notifyAgentState: () => {},
      }),
      agentStorage: asAgentStorage({
        list: async () => [],
        get: async (agentId: string) => {
          if (agentId !== "agent-good") {
            return null;
          }
          goodRecord.archivedAt = archivedAt;
          goodRecord.updatedAt = archivedAt;
          return goodRecord;
        },
      }),
      projectRegistry: (() => {
        const proj = createPersistedProjectRecord({
          projectId: "proj-err",
          rootPath: REPO_CWD,
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
      })(),
      workspaceRegistry: (() => {
        const ws = createPersistedWorkspaceRecord({
          workspaceId: "ws-err",
          projectId: "proj-err",
          cwd: REPO_CWD,
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
      })(),
      chatService: asChatService(),
      scheduleService: asScheduleService(),
      loopService: asLoopService(),
      checkoutDiffManager: asCheckoutDiffManager({
        subscribe: async () => ({
          initial: { cwd: "/tmp", files: [], error: null },
          unsubscribe: () => {},
        }),
        scheduleRefreshForCwd: () => {},
        onWorkspaceStateMayHaveChanged: () => {},
        getMetrics: () => ({
          checkoutDiffTargetCount: 0,
          checkoutDiffSubscriptionCount: 0,
          checkoutDiffWatcherCount: 0,
          checkoutDiffFallbackRefreshTargetCount: 0,
        }),
        dispose: () => {},
      }),
      workspaceGitService: createNoopWorkspaceGitService(),
      daemonConfigStore: asDaemonConfigStore({
        get: () => ({ mcp: { injectIntoAgents: false }, providers: {} }),
        onChange: () => () => {},
      }),
      mcpBaseUrl: null,
      stt: null,
      tts: null,
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      terminalManager: asTerminalManager({
        killTerminal: killTerminalBestEffort,
        subscribeTerminalsChanged: () => () => {},
      }),
    }),
  );

  session.agentUpdatesSubscription = {
    subscriptionId: "sub-agents",
    filter: { includeArchived: true },
    isBootstrapping: false,
    pendingUpdatesByAgentId: new Map(),
  };

  await session.handleMessage({
    type: "close_items_request",
    agentIds: ["agent-bad", "agent-good"],
    terminalIds: ["term-1"],
    requestId: "req-close-best-effort",
  });

  expect(killTerminalBestEffort).toHaveBeenCalledWith("term-1");
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
  const legacyRoot = path.resolve("/tmp/legacy");
  const activeCwd = path.join(legacyRoot, "active");
  const archivedCwd = path.join(legacyRoot, "archived");
  const project = createPersistedProjectRecord({
    projectId: "proj-legacy-global",
    rootPath: legacyRoot,
    kind: "non_git",
    displayName: "legacy",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const activeWorkspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-legacy-active",
    projectId: project.projectId,
    cwd: activeCwd,
    kind: "directory",
    displayName: "active",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const archivedWorkspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-legacy-archived",
    projectId: project.projectId,
    cwd: archivedCwd,
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
      cwd: activeCwd,
      status: "idle",
      updatedAt: "2026-03-01T12:01:00.000Z",
    }),
    makeAgent({
      id: "legacy-archived-workspace",
      cwd: archivedCwd,
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
  const emitted: SessionOutboundMessage[] = [];
  const session = createSessionForWorkspaceTests();
  const historyCwd = path.resolve("/tmp/history");
  const project = createPersistedProjectRecord({
    projectId: "proj-history",
    rootPath: historyCwd,
    kind: "non_git",
    displayName: "history",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-history",
    projectId: project.projectId,
    cwd: historyCwd,
    kind: "directory",
    displayName: "history",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
    archivedAt: "2026-03-02T12:00:00.000Z",
  });

  session.emit = (message) => {
    if (isSessionOutboundMessage(message)) emitted.push(message);
  };
  session.projectRegistry.get = async () => project;
  session.workspaceRegistry.list = async () => [workspace];
  session.listAgentPayloads = async () => [
    {
      ...makeAgent({
        id: "history-archived",
        cwd: historyCwd,
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

test("fetch_recent_provider_sessions_request lists importable provider sessions by handle", async () => {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const session = createSessionForWorkspaceTests();

  session.emit = (message) => emitted.push(message as { type: string; payload: unknown });
  session.agentManager.listAgents = () => [
    {
      provider: "codex",
      persistence: {
        provider: "codex",
        sessionId: "live-session",
        nativeHandle: "live-handle",
      },
    },
  ];
  const importableSessions = [
    makeImportableProviderSession({
      provider: "codex",
      sessionId: "outside-filter",
      nativeHandle: "outside-filter-handle",
      cwd: "/tmp/elsewhere",
      title: "Outside filter",
      lastActivityAt: "2026-04-30T12:05:00.000Z",
    }),
    makeImportableProviderSession({
      provider: "codex",
      sessionId: "stored-session",
      nativeHandle: "stored-handle",
      cwd: "/tmp/recent",
      title: "Already stored",
      lastActivityAt: "2026-04-30T12:04:00.000Z",
      firstPrompt: "stored prompt",
    }),
    makeImportableProviderSession({
      provider: "claude",
      sessionId: "wrong-provider",
      cwd: "/tmp/recent",
      title: "Wrong provider",
      lastActivityAt: "2026-04-30T12:03:00.000Z",
    }),
    makeImportableProviderSession({
      provider: "codex",
      sessionId: "older-session",
      nativeHandle: "older-handle",
      cwd: "/tmp/recent",
      title: "Older than since",
      lastActivityAt: "2026-04-29T23:59:59.000Z",
    }),
    makeImportableProviderSession({
      provider: "codex",
      sessionId: "newer-session",
      nativeHandle: "newer-handle",
      cwd: "/tmp/recent",
      title: "Newer import",
      lastActivityAt: "2026-04-30T12:02:00.000Z",
      firstPrompt: "newer prompt",
    }),
    makeImportableProviderSession({
      provider: "codex",
      sessionId: "second-session",
      nativeHandle: "second-handle",
      cwd: "/tmp/recent",
      title: "Second import",
      lastActivityAt: "2026-04-30T12:00:00.000Z",
      firstPrompt: "second prompt",
    }),
    makeImportableProviderSession({
      provider: "codex",
      sessionId: "third-session",
      nativeHandle: "third-handle",
      cwd: "/tmp/recent",
      title: "Third import",
      lastActivityAt: "2026-04-30T11:59:00.000Z",
      firstPrompt: "third prompt",
    }),
    makeImportableProviderSession({
      provider: "codex",
      sessionId: "live-session",
      nativeHandle: "live-handle",
      cwd: "/tmp/recent",
      title: "Already live",
      lastActivityAt: "2026-04-30T12:01:00.000Z",
      firstPrompt: "live prompt",
    }),
  ];
  // The real AgentManager filters by providerFilter at the fan-out level
  // (Phase 1). Mirror that here so the mock matches the contract.
  session.agentManager.listImportableSessions = async (options?: unknown) => {
    const providerFilter = (options as { providerFilter?: Set<string> } | undefined)
      ?.providerFilter;
    return providerFilter
      ? importableSessions.filter((entry) => providerFilter.has(entry.provider))
      : importableSessions;
  };
  session.agentStorage.list = async () => [
    {
      id: "stored-agent",
      provider: "codex",
      cwd: "/tmp/recent",
      createdAt: "2026-04-30T00:00:00.000Z",
      updatedAt: "2026-04-30T00:00:00.000Z",
      title: "Stored",
      labels: {},
      lastStatus: "closed",
      persistence: {
        provider: "codex",
        sessionId: "stored-session",
        nativeHandle: "stored-handle",
      },
    },
  ];

  await session.handleMessage({
    type: "fetch_recent_provider_sessions_request",
    requestId: "req-recent-provider-sessions",
    cwd: "/tmp/recent",
    providers: ["codex"],
    since: "2026-04-30T00:00:00.000Z",
    limit: 2,
  });

  expect(emitted).toEqual([
    {
      type: "fetch_recent_provider_sessions_response",
      payload: {
        requestId: "req-recent-provider-sessions",
        entries: [
          {
            providerId: "codex",
            providerLabel: "Codex",
            providerHandleId: "newer-handle",
            cwd: "/tmp/recent",
            title: "Newer import",
            firstPromptPreview: "newer prompt",
            lastPromptPreview: "newer prompt",
            lastActivityAt: "2026-04-30T12:02:00.000Z",
          },
          {
            providerId: "codex",
            providerLabel: "Codex",
            providerHandleId: "second-handle",
            cwd: "/tmp/recent",
            title: "Second import",
            firstPromptPreview: "second prompt",
            lastPromptPreview: "second prompt",
            lastActivityAt: "2026-04-30T12:00:00.000Z",
          },
        ],
        filteredAlreadyImportedCount: 2,
      },
    },
  ]);
});

test("fetch_recent_provider_sessions_request forwards providerFilter to agent manager", async () => {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const session = createSessionForWorkspaceTests();
  let capturedOptions: { providerFilter?: Set<string>; limit?: number } | undefined;

  session.emit = (message) => emitted.push(message as { type: string; payload: unknown });
  session.agentManager.listAgents = () => [];
  session.agentStorage.list = async () => [];
  session.agentManager.listImportableSessions = async (options?: unknown) => {
    capturedOptions = options as { providerFilter?: Set<string>; limit?: number };
    return [];
  };

  await session.handleMessage({
    type: "fetch_recent_provider_sessions_request",
    requestId: "req-provider-filter",
    cwd: "/tmp/recent",
    providers: ["claude"],
  });

  expect(capturedOptions?.providerFilter).toBeInstanceOf(Set);
  expect(Array.from(capturedOptions?.providerFilter ?? [])).toEqual(["claude"]);
  expect(emitted).toEqual([
    {
      type: "fetch_recent_provider_sessions_response",
      payload: {
        requestId: "req-provider-filter",
        entries: [],
      },
    },
  ]);
});

test("fetch_recent_provider_sessions_request reports filteredAlreadyImportedCount when all candidates are already imported", async () => {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const session = createSessionForWorkspaceTests();

  session.emit = (message) => emitted.push(message as { type: string; payload: unknown });
  session.agentManager.listAgents = () => [
    {
      provider: "codex",
      persistence: {
        provider: "codex",
        sessionId: "live-session",
        nativeHandle: "live-handle",
      },
    },
  ];
  session.agentStorage.list = async () => [];
  session.agentManager.listImportableSessions = async () => [
    {
      provider: "codex",
      providerHandleId: "live-handle",
      cwd: "/tmp/recent",
      title: "Already live",
      firstPromptPreview: "live prompt",
      lastPromptPreview: "live prompt",
      lastActivityAt: new Date("2026-04-30T12:01:00.000Z"),
    },
  ];

  await session.handleMessage({
    type: "fetch_recent_provider_sessions_request",
    requestId: "req-all-imported",
    cwd: "/tmp/recent",
    providers: ["codex"],
  });

  expect(emitted).toEqual([
    {
      type: "fetch_recent_provider_sessions_response",
      payload: {
        requestId: "req-all-imported",
        entries: [],
        filteredAlreadyImportedCount: 1,
      },
    },
  ]);
});

test("fetch_agent_request still resolves archived historical agents", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const session = createSessionForWorkspaceTests();
  const agent = {
    ...makeAgent({
      id: "archived-history-agent",
      cwd: path.resolve("/tmp/history-detail"),
      status: "idle",
      updatedAt: "2026-03-01T12:00:00.000Z",
    }),
    archivedAt: "2026-03-02T12:00:00.000Z",
    title: "Archived History Agent",
  };
  session.emit = (message) => {
    if (isSessionOutboundMessage(message)) emitted.push(message);
  };
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
      cwd: REPO_CWD,
      kind: "local_checkout",
      displayName: "repo",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
    }),
  ];
  session.listAgentPayloads = async () => [
    makeAgent({
      id: "a1",
      cwd: REPO_CWD,
      status: "running",
      updatedAt: "2026-03-01T12:00:00.000Z",
    }),
    makeAgent({
      id: "a2",
      cwd: REPO_CWD,
      status: "error",
      updatedAt: "2026-03-01T12:01:00.000Z",
    }),
    makeAgent({
      id: "a3",
      cwd: REPO_CWD,
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
      cwd: REPO_CWD,
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
  const emitted: SessionOutboundMessage[] = [];
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
      logger: asSessionLogger(logger),
      downloadTokenStore: asDownloadTokenStore(),
      pushTokenStore: asPushTokenStore(),
      paseoHome: "/tmp/paseo-test",
      agentManager: asAgentManager({
        subscribe: () => () => {},
        listAgents: () => [],
        getAgent: () => null,
      }),
      agentStorage: asAgentStorage({
        list: async () => [],
        get: async () => null,
      }),
      projectRegistry: {
        initialize: async () => {},
        existsOnDisk: async () => true,
        list: async () => [],
        get: async () => null,
        upsert: async () => {},
        archive: async () => {},
        remove: async () => {},
      },
      workspaceRegistry: {
        initialize: async () => {},
        existsOnDisk: async () => true,
        list: async () => [
          createPersistedWorkspaceRecord({
            workspaceId: "ws-repo-running",
            projectId: "proj-repo-running",
            cwd: REPO_CWD,
            kind: "directory",
            displayName: "repo",
            createdAt: "2026-03-01T12:00:00.000Z",
            updatedAt: "2026-03-01T12:00:00.000Z",
          }),
        ],
        get: async (workspaceId: string) =>
          workspaceId === "ws-repo-running"
            ? createPersistedWorkspaceRecord({
                workspaceId: "ws-repo-running",
                projectId: "proj-repo-running",
                cwd: REPO_CWD,
                kind: "directory",
                displayName: "repo",
                createdAt: "2026-03-01T12:00:00.000Z",
                updatedAt: "2026-03-01T12:00:00.000Z",
              })
            : null,
        upsert: async () => {},
        archive: async () => {},
        remove: async () => {},
      },
      chatService: asChatService(),
      scheduleService: asScheduleService(),
      loopService: asLoopService(),
      checkoutDiffManager: asCheckoutDiffManager({
        subscribe: async () => ({
          initial: { cwd: "/tmp", files: [], error: null },
          unsubscribe: () => {},
        }),
        scheduleRefreshForCwd: () => {},
        onWorkspaceStateMayHaveChanged: () => {},
        getMetrics: () => ({
          checkoutDiffTargetCount: 0,
          checkoutDiffSubscriptionCount: 0,
          checkoutDiffWatcherCount: 0,
          checkoutDiffFallbackRefreshTargetCount: 0,
        }),
        dispose: () => {},
      }),
      workspaceGitService: createNoopWorkspaceGitService(),
      daemonConfigStore: asDaemonConfigStore({
        get: () => ({ mcp: { injectIntoAgents: false }, providers: {} }),
        onChange: () => () => {},
      }),
      mcpBaseUrl: null,
      stt: null,
      tts: null,
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
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
        "ws-repo-running",
        {
          id: "ws-repo-running",
          projectId: "proj-repo-running",
          projectDisplayName: "repo",
          projectRootPath: REPO_CWD,
          projectKind: "non_git",
          workspaceKind: "directory",
          name: "repo",
          status: "running",
          activityAt: "2026-03-01T12:00:00.000Z",
        },
      ],
    ]);
  await session.emitWorkspaceUpdateForCwd(REPO_CWD);

  session.buildWorkspaceDescriptorMap = async () =>
    new Map([
      [
        "ws-repo-running",
        {
          id: "ws-repo-running",
          projectId: "proj-repo-running",
          projectDisplayName: "repo",
          projectRootPath: REPO_CWD,
          projectKind: "non_git",
          workspaceKind: "directory",
          name: "repo",
          status: "done",
          activityAt: null,
        },
      ],
    ]);
  await session.emitWorkspaceUpdateForCwd(REPO_CWD);

  const workspaceUpdates = filterByType(emitted, "workspace_update");
  expect(workspaceUpdates).toHaveLength(2);
  expect(workspaceUpdates[0]?.payload.kind).toBe("upsert");
  expect(workspaceUpdates[1]?.payload).toEqual({
    kind: "upsert",
    workspace: {
      id: "ws-repo-running",
      projectId: "proj-repo-running",
      projectDisplayName: "repo",
      projectRootPath: REPO_CWD,
      projectKind: "non_git",
      workspaceKind: "directory",
      name: "repo",
      status: "done",
      activityAt: null,
    },
  });
});

test("archiving the last workspace emits a remove carrying the now-empty project", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const session = createSessionForWorkspaceTests({
    onMessage: (message) => emitted.push(message),
  });

  const project = createPersistedProjectRecord({
    projectId: "proj-empty-after-archive",
    rootPath: REPO_CWD,
    kind: "git",
    displayName: "repo",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const archivedWorkspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-last",
    projectId: project.projectId,
    cwd: REPO_CWD,
    kind: "local_checkout",
    displayName: "repo",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
    archivedAt: "2026-03-02T12:00:00.000Z",
  });

  session.projectRegistry.list = async () => [project];
  session.workspaceRegistry.list = async () => [archivedWorkspace];
  session.workspaceRegistry.get = async (workspaceId: string) =>
    workspaceId === archivedWorkspace.workspaceId ? archivedWorkspace : null;

  session.workspaceUpdatesSubscription = {
    subscriptionId: "sub-1",
    filter: undefined,
    isBootstrapping: false,
    pendingUpdatesByWorkspaceId: new Map(),
    lastEmittedByWorkspaceId: new Map(),
  };
  session.reconcileActiveWorkspaceRecords = async () => new Set();
  // The archived workspace no longer resolves to an active descriptor.
  session.buildWorkspaceDescriptorMap = async () => new Map();

  await session.emitWorkspaceUpdatesForWorkspaceIds([archivedWorkspace.workspaceId], {
    skipReconcile: true,
  });

  const removeUpdate = filterByType(emitted, "workspace_update").find(
    (message) => message.payload.kind === "remove",
  );
  expect(removeUpdate?.payload).toEqual({
    kind: "remove",
    id: archivedWorkspace.workspaceId,
    emptyProject: {
      projectId: project.projectId,
      projectDisplayName: "repo",
      projectCustomName: null,
      projectRootPath: REPO_CWD,
      projectKind: "git",
    },
  });
});

test("create paseo worktree request returns a registered workspace descriptor", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const tempDir = realpathSync(mkdtempSync(path.join(tmpdir(), "session-worktree-test-")));
  const repoDir = path.join(tempDir, "repo");
  const paseoHome = path.join(tempDir, "paseo-home");
  mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir, stdio: "pipe" });
  writeFileSync(path.join(repoDir, "file.txt"), "hello\n");
  execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "initial"], {
    cwd: repoDir,
    stdio: "pipe",
  });
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
  session.workspaceRegistry.get = async (lookupWorkspaceId: string) =>
    workspaces.get(lookupWorkspaceId) ?? null;
  session.workspaceRegistry.list = async () => Array.from(workspaces.values());
  session.workspaceRegistry.upsert = async (
    record: ReturnType<typeof createPersistedWorkspaceRecord>,
  ) => {
    workspaces.set(record.workspaceId, record);
  };
  session.projectRegistry.get = async (projectId: string) => projects.get(projectId) ?? null;
  session.projectRegistry.list = async () => Array.from(projects.values());
  session.projectRegistry.upsert = async (
    record: ReturnType<typeof createPersistedProjectRecord>,
  ) => {
    projects.set(record.projectId, record);
  };
  session.emit = (message: unknown) => {
    if (isSessionOutboundMessage(message)) emitted.push(message);
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

  const response = findByType(emitted, "create_paseo_worktree_response");

  expect(response?.payload.error).toBeNull();
  expect(response?.payload.workspace).toMatchObject({
    projectDisplayName: "repo",
    projectKind: "git",
    workspaceKind: "worktree",
    name: "worktree-123",
    status: "done",
  });
  expect(response?.payload.workspace?.id).toMatch(/^wks_[0-9a-f]{16}$/);
  expect(response?.payload.workspace?.workspaceDirectory).toContain(path.join("worktree-123"));
  expect(workspaces.has(response?.payload.workspace?.id ?? "")).toBe(true);
  expect(projects.has(response?.payload.workspace?.projectId ?? "")).toBe(true);
});

test("workspace update fanout for multiple cwd values is deduplicated", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const session = createSessionForWorkspaceTests();
  session.workspaceRegistry.list = async () => [
    createPersistedWorkspaceRecord({
      workspaceId: "ws-repo-main",
      projectId: "proj-repo-main",
      cwd: REPO_CWD,
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
          projectRootPath: REPO_CWD,
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
          projectRootPath: REPO_CWD,
          projectKind: "git",
          workspaceKind: "worktree",
          name: "feature",
          status: "running",
          activityAt: "2026-03-01T12:00:00.000Z",
        },
      ],
    ]);
  session.onMessage = (message: unknown) => {
    if (isSessionOutboundMessage(message)) emitted.push(message);
  };

  await session.emitWorkspaceUpdateForCwd("/tmp/repo/worktree");
  await new Promise((resolve) => setTimeout(resolve, 0));

  const workspaceUpdates = filterByType(emitted, "workspace_update");
  expect(workspaceUpdates).toHaveLength(2);
  expect(workspaceUpdates.map((entry) => entry.payload.kind)).toEqual(["upsert", "upsert"]);
  expect(
    workspaceUpdates
      .map((entry) => (entry.payload.kind === "upsert" ? entry.payload.workspace.id : null))
      .sort((a, b) => String(a).localeCompare(String(b))),
  ).toEqual(["ws-repo-feature", "ws-repo-main"]);
});

test("open_project_request registers a workspace before any agent exists", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const session = createSessionForWorkspaceTests();
  const projects = new Map<string, ReturnType<typeof createPersistedProjectRecord>>();
  const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>();

  session.emit = (message) => {
    if (isSessionOutboundMessage(message)) emitted.push(message);
  };
  session.projectRegistry.get = async (projectId: string) => projects.get(projectId) ?? null;
  session.projectRegistry.upsert = async (
    record: ReturnType<typeof createPersistedProjectRecord>,
  ) => {
    projects.set(record.projectId, record);
  };
  session.workspaceRegistry.get = async (lookupWorkspaceId: string) =>
    workspaces.get(lookupWorkspaceId) ?? null;
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
    cwd: REPO_CWD,
    requestId: "req-open",
  });

  const registeredWorkspace = Array.from(workspaces.values()).find(
    (workspace) => workspace.cwd === REPO_CWD,
  );
  expect(registeredWorkspace).toBeTruthy();
  const response = findByType(emitted, "open_project_response");
  expect(response?.payload.error).toBeNull();
  expect(response?.payload.workspace?.id).toBe(registeredWorkspace?.workspaceId);
});

test("import_agent_request registers a workspace for a never-seen cwd", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const session = createSessionForWorkspaceTests({
    onMessage: (message) => {
      if (isSessionOutboundMessage(message)) emitted.push(message);
    },
  });
  const projects = new Map<string, ReturnType<typeof createPersistedProjectRecord>>();
  const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>();
  const importedCwd = path.resolve("/tmp/imported-project");

  session.projectRegistry.get = async (projectId: string) => projects.get(projectId) ?? null;
  session.projectRegistry.upsert = async (
    record: ReturnType<typeof createPersistedProjectRecord>,
  ) => {
    projects.set(record.projectId, record);
  };
  session.workspaceRegistry.get = async (lookupWorkspaceId: string) =>
    workspaces.get(lookupWorkspaceId) ?? null;
  session.workspaceRegistry.upsert = async (
    record: ReturnType<typeof createPersistedWorkspaceRecord>,
  ) => {
    workspaces.set(record.workspaceId, record);
  };
  session.projectRegistry.list = async () => Array.from(projects.values());
  session.workspaceRegistry.list = async () => Array.from(workspaces.values());
  session.buildProjectPlacement = async (cwd: string) => ({
    projectKey: cwd,
    projectName: "imported",
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

  const managed = makeManagedAgent({
    id: "imported-agent",
    cwd: importedCwd,
    lifecycle: "idle",
    updatedAt: "2026-05-21T00:00:00.000Z",
  });
  session.agentManager.listAgents = () => [managed];
  session.agentManager.importProviderSession = async () => managed;
  session.agentManager.getTimeline = () => [];
  session.agentManager.setTitle = async () => undefined;
  session.agentStorage.list = async () => [];
  session.agentStorage.get = async () => null;
  session.forwardAgentUpdate = async () => undefined;

  session.workspaceUpdatesSubscription = {
    subscriptionId: "sub-import",
    filter: undefined,
    isBootstrapping: false,
    pendingUpdatesByWorkspaceId: new Map(),
    lastEmittedByWorkspaceId: new Map(),
  };
  session.buildWorkspaceDescriptorMap = async () => {
    const workspace = Array.from(workspaces.values()).find(
      (candidate) => candidate.cwd === importedCwd,
    );
    if (!workspace) {
      return new Map();
    }
    return new Map([
      [
        workspace.workspaceId,
        {
          id: workspace.workspaceId,
          projectId: workspace.projectId,
          projectDisplayName: "imported-project",
          projectRootPath: importedCwd,
          workspaceDirectory: importedCwd,
          projectKind: "non_git",
          workspaceKind: "directory",
          name: "imported-project",
          status: "done",
          activityAt: null,
        },
      ],
    ]);
  };

  await session.handleMessage({
    type: "import_agent_request",
    requestId: "req-import",
    providerId: "codex",
    providerHandleId: "session-xyz",
    cwd: importedCwd,
  });

  const importedWorkspace = Array.from(workspaces.values()).find(
    (workspace) => workspace.cwd === importedCwd,
  );
  expect(importedWorkspace).toBeTruthy();
  const workspaceUpdates = filterByType(emitted, "workspace_update");
  expect(workspaceUpdates.length).toBeGreaterThan(0);
  expect(
    workspaceUpdates.some(
      (update) =>
        update.payload.kind === "upsert" &&
        update.payload.workspace.workspaceDirectory === importedCwd,
    ),
  ).toBe(true);
});

test("open_project_response returns immediately even when the GitHub fetch is slow", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const session = createSessionForWorkspaceTests();
  const projects = new Map<string, ReturnType<typeof createPersistedProjectRecord>>();
  const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>();
  const cwd = path.resolve("/tmp/slow-github-repo");

  session.emit = (message) => {
    if (isSessionOutboundMessage(message)) emitted.push(message);
  };
  session.projectRegistry.get = async (projectId: string) => projects.get(projectId) ?? null;
  session.projectRegistry.upsert = async (
    record: ReturnType<typeof createPersistedProjectRecord>,
  ) => {
    projects.set(record.projectId, record);
  };
  session.workspaceRegistry.get = async (lookupWorkspaceId: string) =>
    workspaces.get(lookupWorkspaceId) ?? null;
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

  const response = findByType(emitted, "open_project_response");
  expect(response?.payload.error).toBeNull();
  expect(response?.payload.workspace?.id).toMatch(/^wks_[0-9a-f]{16}$/);
  expect(response?.payload.workspace?.workspaceDirectory).toBe(cwd);
  expect(response?.payload.workspace?.gitRuntime).toBeUndefined();
  expect(response?.payload.workspace?.githubRuntime).toBeUndefined();

  resolveSnapshot(createWorkspaceRuntimeSnapshot(cwd));
});

test("open_project_request emits a workspace_update with githubRuntime once the snapshot resolves", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const session = createSessionForWorkspaceTests();
  const projects = new Map<string, ReturnType<typeof createPersistedProjectRecord>>();
  const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>();
  const cwd = path.resolve("/tmp/github-runtime-repo");
  const snapshot = createWorkspaceRuntimeSnapshot(cwd);

  let listener: ((snapshot: WorkspaceGitRuntimeSnapshot) => void) | null = null;
  const peeked = { value: null as WorkspaceGitRuntimeSnapshot | null };

  session.emit = (message) => {
    if (isSessionOutboundMessage(message)) emitted.push(message);
  };
  session.projectRegistry.get = async (projectId: string) => projects.get(projectId) ?? null;
  session.projectRegistry.upsert = async (
    record: ReturnType<typeof createPersistedProjectRecord>,
  ) => {
    projects.set(record.projectId, record);
  };
  session.workspaceRegistry.get = async (lookupWorkspaceId: string) =>
    workspaces.get(lookupWorkspaceId) ?? null;
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
  session.workspaceGitService.registerWorkspace = (
    _params,
    incomingListener: (snapshot: WorkspaceGitRuntimeSnapshot) => void,
  ) => {
    listener = incomingListener;
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

  const updates = filterByType(emitted, "workspace_update");
  const upsertedWithGitHub = updates
    .map((update) => update.payload)
    .filter(
      (payload): payload is WorkspaceUpsertPayload =>
        payload.kind === "upsert" && payload.workspace.workspaceDirectory === cwd,
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
    workspaceDirectory?: string;
    githubRuntime?: {
      pullRequest?: { url?: string } | null;
    } | null;
  };
}

test("open_project_request does not match a new child directory to an existing parent workspace", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const session = createSessionForWorkspaceTests();
  const projects = new Map<string, ReturnType<typeof createPersistedProjectRecord>>();
  const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>();
  const home = path.resolve("/Users/moboudra");
  const worktree = path.join(home, ".paseo", "worktrees", "project-config-lifecycle-textarea");

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

  session.emit = (message) => {
    if (isSessionOutboundMessage(message)) emitted.push(message);
  };
  session.projectRegistry.get = async (projectId: string) => projects.get(projectId) ?? null;
  session.projectRegistry.upsert = async (
    record: ReturnType<typeof createPersistedProjectRecord>,
  ) => {
    projects.set(record.projectId, record);
  };
  session.workspaceRegistry.get = async (lookupWorkspaceId: string) =>
    workspaces.get(lookupWorkspaceId) ?? null;
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

  const response = findByType(emitted, "open_project_response");
  expect(response?.payload.error).toBeNull();
  expect(response?.payload.workspace?.id).toMatch(/^wks_[0-9a-f]{16}$/);
  expect(response?.payload.workspace?.workspaceDirectory).toBe(worktree);
  expect(Array.from(workspaces.values()).some((workspace) => workspace.cwd === worktree)).toBe(
    true,
  );
});

test("open_project_request does not unarchive an archived parent workspace for a new child directory", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const session = createSessionForWorkspaceTests();
  const projects = new Map<string, ReturnType<typeof createPersistedProjectRecord>>();
  const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>();
  const home = path.resolve("/Users/moboudra");
  const worktree = path.join(home, ".paseo", "worktrees", "project-config-lifecycle-textarea");
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

  session.emit = (message) => {
    if (isSessionOutboundMessage(message)) emitted.push(message);
  };
  session.projectRegistry.get = async (projectId: string) => projects.get(projectId) ?? null;
  session.projectRegistry.upsert = async (
    record: ReturnType<typeof createPersistedProjectRecord>,
  ) => {
    projects.set(record.projectId, record);
  };
  session.workspaceRegistry.get = async (lookupWorkspaceId: string) =>
    workspaces.get(lookupWorkspaceId) ?? null;
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

  const response = findByType(emitted, "open_project_response");
  expect(response?.payload.error).toBeNull();
  expect(response?.payload.workspace?.id).toMatch(/^wks_[0-9a-f]{16}$/);
  expect(response?.payload.workspace?.workspaceDirectory).toBe(worktree);
  expect(workspaces.get(home)?.archivedAt).toBe(archivedAt);
  expect(projects.get(home)?.archivedAt).toBe(archivedAt);
});

test("open_project_request reclassifies an archived directory workspace when git metadata becomes available", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const session = createSessionForWorkspaceTests();
  const projects = new Map<string, ReturnType<typeof createPersistedProjectRecord>>();
  const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>();
  const repoRoot = path.resolve("/Users/moboudra/dev/paseo");
  const cwd = path.join(
    path.resolve("/Users/moboudra"),
    ".paseo",
    "worktrees",
    "orchestrate",
    "desktop-daemon-settings",
  );
  const remoteProjectId = "remote:github.com/getpaseo/paseo";
  const archivedAt = "2026-04-24T09:48:36.168Z";
  const workspaceId = "ws-desktop-daemon-settings";

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
    workspaceId,
    createPersistedWorkspaceRecord({
      workspaceId,
      projectId: cwd,
      cwd,
      kind: "directory",
      displayName: "desktop-daemon-settings",
      createdAt: "2026-04-24T09:46:43.146Z",
      updatedAt: archivedAt,
      archivedAt,
    }),
  );

  session.emit = (message) => {
    if (isSessionOutboundMessage(message)) emitted.push(message);
  };
  session.projectRegistry.get = async (projectId: string) => projects.get(projectId) ?? null;
  session.projectRegistry.upsert = async (
    record: ReturnType<typeof createPersistedProjectRecord>,
  ) => {
    projects.set(record.projectId, record);
  };
  session.workspaceRegistry.get = async (lookupWorkspaceId: string) =>
    workspaces.get(lookupWorkspaceId) ?? null;
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

  const response = findByType(emitted, "open_project_response");

  expect(response?.payload.error).toBeNull();
  expect(response?.payload.workspace?.projectId).toBe(remoteProjectId);
  expect(response?.payload.workspace?.workspaceKind).toBe("worktree");
  expect(projects.get(remoteProjectId)?.kind).toBe("git");
  expect(workspaces.get(workspaceId)?.projectId).toBe(remoteProjectId);
  expect(workspaces.get(workspaceId)?.kind).toBe("worktree");
  expect(workspaces.get(workspaceId)?.displayName).toBe("feature/desktop-daemon-settings");
});

test("open_project_request reclassifies an active directory workspace when git metadata becomes available", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const session = createSessionForWorkspaceTests();
  const projects = new Map<string, ReturnType<typeof createPersistedProjectRecord>>();
  const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>();
  const repoRoot = path.resolve("/Users/moboudra/dev/paseo");
  const cwd = path.join(
    path.resolve("/Users/moboudra"),
    ".paseo",
    "worktrees",
    "orchestrate",
    "desktop-daemon-settings",
  );

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
  const workspaceId = "ws-desktop-daemon-settings-active";
  const repoWorkspaceId = "ws-paseo-main";
  workspaces.set(
    workspaceId,
    createPersistedWorkspaceRecord({
      workspaceId,
      projectId: cwd,
      cwd,
      kind: "directory",
      displayName: "desktop-daemon-settings",
      createdAt: "2026-04-24T09:46:43.146Z",
      updatedAt: "2026-04-24T09:46:43.146Z",
    }),
  );
  workspaces.set(
    repoWorkspaceId,
    createPersistedWorkspaceRecord({
      workspaceId: repoWorkspaceId,
      projectId: repoRoot,
      cwd: repoRoot,
      kind: "local_checkout",
      displayName: "main",
      createdAt: "2026-04-24T09:40:00.000Z",
      updatedAt: "2026-04-24T09:40:00.000Z",
    }),
  );

  session.emit = (message) => {
    if (isSessionOutboundMessage(message)) emitted.push(message);
  };
  session.projectRegistry.get = async (projectId: string) => projects.get(projectId) ?? null;
  session.projectRegistry.upsert = async (
    record: ReturnType<typeof createPersistedProjectRecord>,
  ) => {
    projects.set(record.projectId, record);
  };
  session.workspaceRegistry.get = async (lookupWorkspaceId: string) =>
    workspaces.get(lookupWorkspaceId) ?? null;
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

  const response = findByType(emitted, "open_project_response");

  expect(response?.payload.error).toBeNull();
  expect(response?.payload.workspace?.projectId).toBe(repoRoot);
  expect(response?.payload.workspace?.workspaceKind).toBe("worktree");
  expect(workspaces.get(workspaceId)?.projectId).toBe(repoRoot);
  expect(workspaces.get(workspaceId)?.kind).toBe("worktree");
  expect(workspaces.get(workspaceId)?.displayName).toBe("feature/desktop-daemon-settings");
});

test("open_project_request groups a plain git worktree under an existing repo project", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const session = createSessionForWorkspaceTests();
  const projects = new Map<string, ReturnType<typeof createPersistedProjectRecord>>();
  const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>();
  const repoRoot = path.resolve("/Users/moboudra/dev/paseo");
  const cwd = path.join(
    path.resolve("/Users/moboudra"),
    ".paseo",
    "worktrees",
    "orchestrate",
    "desktop-daemon-settings",
  );

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

  session.emit = (message) => {
    if (isSessionOutboundMessage(message)) emitted.push(message);
  };
  session.projectRegistry.get = async (projectId: string) => projects.get(projectId) ?? null;
  session.projectRegistry.upsert = async (
    record: ReturnType<typeof createPersistedProjectRecord>,
  ) => {
    projects.set(record.projectId, record);
  };
  session.workspaceRegistry.get = async (lookupWorkspaceId: string) =>
    workspaces.get(lookupWorkspaceId) ?? null;
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

  const response = findByType(emitted, "open_project_response");

  expect(response?.payload.error).toBeNull();
  expect(response?.payload.workspace?.projectId).toBe(repoRoot);
  expect(response?.payload.workspace?.workspaceKind).toBe("worktree");
  const worktreeWorkspace = Array.from(workspaces.values()).find(
    (workspace) => workspace.cwd === cwd,
  );
  expect(worktreeWorkspace?.projectId).toBe(repoRoot);
  expect(worktreeWorkspace?.kind).toBe("worktree");
});

test("open_project_request unarchives an existing archived workspace and project", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const session = createSessionForWorkspaceTests();
  const projects = new Map<string, ReturnType<typeof createPersistedProjectRecord>>();
  const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>();

  const cwd = REPO_CWD;
  const workspaceId = "ws-repo-archived";
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
    workspaceId,
    createPersistedWorkspaceRecord({
      workspaceId,
      projectId: cwd,
      cwd,
      kind: "directory",
      displayName: "repo",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-10T00:00:00.000Z",
      archivedAt: "2026-03-10T00:00:00.000Z",
    }),
  );

  session.emit = (message) => {
    if (isSessionOutboundMessage(message)) emitted.push(message);
  };
  session.projectRegistry.get = async (projectId: string) => projects.get(projectId) ?? null;
  session.projectRegistry.upsert = async (
    record: ReturnType<typeof createPersistedProjectRecord>,
  ) => {
    projects.set(record.projectId, record);
  };
  session.workspaceRegistry.get = async (lookupWorkspaceId: string) =>
    workspaces.get(lookupWorkspaceId) ?? null;
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

  expect(workspaces.get(workspaceId)?.archivedAt).toBeNull();
  expect(projects.get(cwd)?.archivedAt).toBeNull();
  const response = findByType(emitted, "open_project_response");
  expect(response?.payload.error).toBeNull();
  expect(response?.payload.workspace?.id).toBe(workspaceId);
});

test.skip("open_project_request collapses a git subdirectory onto the repo root workspace", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const session = createSessionForWorkspaceTests();
  const projects = new Map<string, ReturnType<typeof createPersistedProjectRecord>>();
  const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>();
  const repoRoot = REPO_CWD;
  const subdir = "/tmp/repo/packages/app";

  session.emit = (message) => {
    if (isSessionOutboundMessage(message)) emitted.push(message);
  };
  session.projectRegistry.get = async (projectId: string) => projects.get(projectId) ?? null;
  session.projectRegistry.upsert = async (
    record: ReturnType<typeof createPersistedProjectRecord>,
  ) => {
    projects.set(record.projectId, record);
  };
  session.workspaceRegistry.get = async (lookupWorkspaceId: string) =>
    workspaces.get(lookupWorkspaceId) ?? null;
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
  const response = findByType(emitted, "open_project_response");
  expect(response?.payload.error).toBeNull();
  expect(response?.payload.workspace?.id).toBe(repoRoot);
});

test("legacy editor RPC requests return daemon unsupported errors", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const session = createSessionForWorkspaceTests({
    onMessage: (message) => emitted.push(message),
  });

  await session.handleMessage({
    type: "list_available_editors_request",
    requestId: "req-editors",
  });
  await session.handleMessage({
    type: "open_in_editor_request",
    requestId: "req-open-editor",
    editorId: "vscode",
    path: REPO_CWD,
  });

  const listResponse = findByType(emitted, "list_available_editors_response");
  const openResponse = findByType(emitted, "open_in_editor_response");
  expect(listResponse?.payload.editors).toEqual([]);
  expect(listResponse?.payload.error).toBe(
    "Editor opening moved to the desktop app and is no longer supported by the daemon",
  );
  expect(openResponse?.payload.error).toBe(
    "Editor opening moved to the desktop app and is no longer supported by the daemon",
  );
});

test("archive_workspace_request hides non-destructive workspace records", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const session = createSessionForWorkspaceTests();
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-repo-archive",
    projectId: "proj-repo-archive",
    cwd: REPO_CWD,
    kind: "directory",
    displayName: "repo",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });

  session.emit = (message) => {
    if (isSessionOutboundMessage(message)) emitted.push(message);
  };
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
  const emitted: SessionOutboundMessage[] = [];
  const session = createSessionForWorkspaceTests();
  const projects = new Map<string, ReturnType<typeof createPersistedProjectRecord>>();
  const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>();

  const tempDir = realpathSync(mkdtempSync(path.join(tmpdir(), "session-workspace-reconcile-")));
  const mainWorkspaceId = path.join(tempDir, "inkwell");
  const worktreeWorkspaceId = path.join(mainWorkspaceId, ".paseo", "worktrees", "feature-a");
  const localProjectId = mainWorkspaceId;
  const remoteProjectId = "remote:github.com/zimakki/inkwell";

  mkdirSync(worktreeWorkspaceId, { recursive: true });

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

  session.emit = (message) => {
    if (isSessionOutboundMessage(message)) emitted.push(message);
  };
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
  session.workspaceRegistry.get = async (lookupWorkspaceId: string) =>
    workspaces.get(lookupWorkspaceId) ?? null;
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

    const workspaceUpdates = filterByType(emitted, "workspace_update");
    expect(workspaceUpdates).toHaveLength(1);
    const firstUpdate = workspaceUpdates[0];
    expect(firstUpdate?.payload.kind === "upsert" ? firstUpdate.payload.workspace.id : null).toBe(
      worktreeWorkspaceId,
    );
    expect(
      firstUpdate?.payload.kind === "upsert" ? firstUpdate.payload.workspace.projectId : null,
    ).toBe(remoteProjectId);
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

  mkdirSync(worktreeWorkspaceId, { recursive: true });

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
  session.workspaceRegistry.get = async (lookupWorkspaceId: string) =>
    workspaces.get(lookupWorkspaceId) ?? null;
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

    expect(result.entries.map((entry) => entry["projectId"])).toEqual([newProjectId, newProjectId]);
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

  mkdirSync(subdirWorkspaceId, { recursive: true });

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
  session.workspaceRegistry.get = async (lookupWorkspaceId: string) =>
    workspaces.get(lookupWorkspaceId) ?? null;
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
    expect(result.workspace?.["workspaceId"]).toBe(repoRoot);
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
    rootPath: REPO_CWD,
    kind: "git",
    displayName: "repo",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-baseline",
    projectId: project.projectId,
    cwd: REPO_CWD,
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
    statusEnteredAt: null,
    activityAt: null,
    diffStat: null,
  } as const;
  const gitDescriptor = {
    ...baselineDescriptor,
    diffStat: { additions: 3, deletions: 1 },
  } as const;

  const describeWorkspaceRecord = vi.fn(async () => baselineDescriptor);
  const describeWorkspaceRecordWithGitData = vi.fn(async () => gitDescriptor);
  session.describeWorkspaceRecord = describeWorkspaceRecord;
  session.describeWorkspaceRecordWithGitData = describeWorkspaceRecordWithGitData;

  const descriptors = Array.from(
    (
      await session.buildWorkspaceDescriptorMap({
        includeGitData: false,
      })
    ).values(),
  );

  expect(describeWorkspaceRecord).toHaveBeenCalledWith(workspace, project);
  expect(describeWorkspaceRecordWithGitData).not.toHaveBeenCalled();
  expect(descriptors).toEqual([baselineDescriptor]);
});

test("buildWorkspaceDescriptorMap computes statusEnteredAt from runtime agent fields", async () => {
  const setupSession = () => {
    const session = createSessionForWorkspaceTests();
    const project = createPersistedProjectRecord({
      projectId: "proj-status-entered",
      rootPath: REPO_CWD,
      kind: "git",
      displayName: "repo",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
    });
    const workspace = createPersistedWorkspaceRecord({
      workspaceId: "ws-status-entered",
      projectId: project.projectId,
      cwd: "/tmp/repo",
      kind: "worktree",
      displayName: "feature",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
    });
    session.projectRegistry.list = async () => [project];
    session.workspaceRegistry.list = async () => [workspace];
    return { session, workspace };
  };

  const buildDescriptor = (session: TestSession, workspaceId: string) =>
    session.buildWorkspaceDescriptorMap({ includeGitData: false }).then((map) => {
      const descriptor = map.get(workspaceId);
      expect(descriptor).toBeDefined();
      return descriptor!;
    });

  // 1. Empty workspace — no agents contribute. statusEnteredAt must be null
  // and the workspace status is "done".
  {
    const { session, workspace } = setupSession();
    session.listAgentPayloads = async () => [];
    const descriptor = await buildDescriptor(session, workspace.workspaceId);
    expect(descriptor.status).toBe("done");
    expect(descriptor.statusEnteredAt).toBeNull();
  }

  // 2. Single idle agent (derives to "done") — statusEnteredAt uses the
  // agent's updatedAt as a best-effort timestamp.
  {
    const { session, workspace } = setupSession();
    const updatedAt = "2026-05-12T09:30:00.000Z";
    session.listAgentPayloads = async () => [
      makeAgent({
        id: "agent-done",
        cwd: workspace.cwd,
        status: "idle",
        updatedAt,
      }),
    ];
    const descriptor = await buildDescriptor(session, workspace.workspaceId);
    expect(descriptor.status).toBe("done");
    expect(descriptor.statusEnteredAt).toBe(updatedAt);
  }

  // 3. A root agent that is still initializing does not make the workspace
  // look like it is actively working.
  {
    const { session, workspace } = setupSession();
    const updatedAt = "2026-05-12T09:45:00.000Z";
    session.listAgentPayloads = async () => [
      makeAgent({
        id: "agent-initializing",
        cwd: workspace.cwd,
        status: "initializing",
        updatedAt,
      }),
    ];
    const descriptor = await buildDescriptor(session, workspace.workspaceId);
    expect(descriptor.status).toBe("done");
    expect(descriptor.statusEnteredAt).toBe(updatedAt);
  }

  // 4. Highest-priority across all buckets: a "needs_input" agent beats
  // a "running" agent beats a "done" agent. statusEnteredAt is the winning
  // bucket's newest agent timestamp.
  {
    const { session, workspace } = setupSession();
    const doneUpdatedAt = "2026-05-12T09:30:00.000Z";
    const runningUpdatedAt = "2026-05-12T10:00:00.000Z";
    const needsInputUpdatedAt = "2026-05-12T10:15:00.000Z";
    session.listAgentPayloads = async () => [
      makeAgent({
        id: "agent-done",
        cwd: workspace.cwd,
        status: "idle",
        updatedAt: doneUpdatedAt,
      }),
      makeAgent({
        id: "agent-running",
        cwd: workspace.cwd,
        status: "running",
        updatedAt: runningUpdatedAt,
      }),
      makeAgent({
        id: "agent-needs-input",
        cwd: workspace.cwd,
        status: "idle",
        updatedAt: needsInputUpdatedAt,
        pendingPermissions: 1,
      }),
    ];
    const descriptor = await buildDescriptor(session, workspace.workspaceId);
    expect(descriptor.status).toBe("needs_input");
    expect(descriptor.statusEnteredAt).toBe(needsInputUpdatedAt);
  }

  // 5. Same-bucket: keep the previous bucket entry time even when newer
  // agents contribute to the same winning bucket.
  {
    const { session, workspace } = setupSession();
    const earlyUpdatedAt = "2026-05-12T08:00:00.000Z";
    const lateUpdatedAt = "2026-05-12T08:30:00.000Z";
    session.listAgentPayloads = async () => [
      makeAgent({
        id: "agent-done-early",
        cwd: workspace.cwd,
        status: "idle",
        updatedAt: earlyUpdatedAt,
      }),
    ];
    const first = await buildDescriptor(session, workspace.workspaceId);
    expect(first.status).toBe("done");
    expect(first.statusEnteredAt).toBe(earlyUpdatedAt);

    // Second call: same winning bucket, newer agent updatedAt must not move
    // the workspace bucket entry time forward.
    session.listAgentPayloads = async () => [
      makeAgent({
        id: "agent-done-early",
        cwd: workspace.cwd,
        status: "idle",
        updatedAt: earlyUpdatedAt,
      }),
      makeAgent({
        id: "agent-done-late",
        cwd: workspace.cwd,
        status: "idle",
        updatedAt: lateUpdatedAt,
      }),
    ];
    const second = await buildDescriptor(session, workspace.workspaceId);
    expect(second.status).toBe("done");
    expect(second.statusEnteredAt).toBe(earlyUpdatedAt);
  }

  // 5. Priority unmasking: a higher-priority bucket clears, revealing a
  // lower-priority one. The unmask time must be "now".
  {
    const { session, workspace } = setupSession();
    const unmaskTime = "2026-05-12T12:00:00.000Z";
    vi.setSystemTime(new Date(unmaskTime));
    const doneUpdatedAt = "2026-05-12T08:00:00.000Z";
    const needsInputUpdatedAt = "2026-05-12T07:00:00.000Z";
    session.listAgentPayloads = async () => [
      makeAgent({
        id: "agent-done",
        cwd: workspace.cwd,
        status: "idle",
        updatedAt: doneUpdatedAt,
      }),
      makeAgent({
        id: "agent-needs-input",
        cwd: workspace.cwd,
        status: "idle",
        updatedAt: needsInputUpdatedAt,
        pendingPermissions: 1,
      }),
    ];
    const first = await buildDescriptor(session, workspace.workspaceId);
    expect(first.status).toBe("needs_input");

    // Drop the needs_input agent. The unmask time is "now", not doneUpdatedAt.
    session.listAgentPayloads = async () => [
      makeAgent({
        id: "agent-done",
        cwd: workspace.cwd,
        status: "idle",
        updatedAt: doneUpdatedAt,
      }),
    ];
    const second = await buildDescriptor(session, workspace.workspaceId);
    expect(second.status).toBe("done");
    expect(second.statusEnteredAt).toBe(unmaskTime);
    vi.useRealTimers();
  }

  // 6. Attention agent uses attentionTimestamp as the entered-at signal.
  {
    const { session, workspace } = setupSession();
    const attentionTs = "2026-05-12T11:00:00.000Z";
    const updatedAt = "2026-05-12T10:00:00.000Z";
    session.listAgentPayloads = async () => [
      makeAgent({
        id: "agent-attention",
        cwd: workspace.cwd,
        status: "idle",
        updatedAt,
        requiresAttention: true,
        attentionReason: "finished",
        attentionTimestamp: attentionTs,
      }),
    ];
    const descriptor = await buildDescriptor(session, workspace.workspaceId);
    expect(descriptor.status).toBe("attention");
    // attentionTimestamp takes priority over updatedAt
    expect(descriptor.statusEnteredAt).toBe(attentionTs);
  }
});

test("buildWorkspaceDescriptorMap keeps a done workspace recent after its agents are archived", async () => {
  const session = createSessionForWorkspaceTests();
  const project = createPersistedProjectRecord({
    projectId: "proj-archive-status-entered",
    rootPath: REPO_CWD,
    kind: "git",
    displayName: "repo",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-archive-status-entered",
    projectId: project.projectId,
    cwd: "/tmp/repo/archive-status-entered",
    kind: "worktree",
    displayName: "feature",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const doneEnteredAt = "2026-05-12T09:30:00.000Z";
  const archivedAt = "2026-05-12T09:45:00.000Z";

  session.projectRegistry.list = async () => [project];
  session.workspaceRegistry.list = async () => [workspace];
  session.listAgentPayloads = async () => [
    makeAgent({
      id: "agent-done",
      cwd: workspace.cwd,
      status: "idle",
      updatedAt: doneEnteredAt,
    }),
  ];

  const first = await session.buildWorkspaceDescriptorMap({ includeGitData: false });
  expect(first.get(workspace.workspaceId)?.status).toBe("done");
  expect(first.get(workspace.workspaceId)?.statusEnteredAt).toBe(doneEnteredAt);

  session.listAgentPayloads = async () => [
    {
      ...makeAgent({
        id: "agent-done",
        cwd: workspace.cwd,
        status: "idle",
        updatedAt: doneEnteredAt,
      }),
      archivedAt,
    },
  ];

  const second = await session.buildWorkspaceDescriptorMap({ includeGitData: false });
  expect(second.get(workspace.workspaceId)).toMatchObject({
    status: "done",
    statusEnteredAt: doneEnteredAt,
  });
});

test("buildWorkspaceDescriptorMap stamps workspace archiving state", async () => {
  const session = createSessionForWorkspaceTests();
  const archivingAt = "2026-04-30T20:45:00.000Z";
  const project = createPersistedProjectRecord({
    projectId: "proj-archiving-map",
    rootPath: REPO_CWD,
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
  const emitted: SessionOutboundMessage[] = [];
  const session = createSessionForWorkspaceTests();
  const archivingAt = "2026-04-30T20:45:00.000Z";
  const project = createPersistedProjectRecord({
    projectId: "proj-archiving-emit",
    rootPath: REPO_CWD,
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

  session.emit = (message) => {
    if (isSessionOutboundMessage(message)) emitted.push(message);
  };
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
  const emitted: SessionOutboundMessage[] = [];
  const runtimeSnapshot = createWorkspaceRuntimeSnapshot(REPO_CWD, {
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
  const peekSnapshotRuntimeFetch = vi.fn(() => runtimeSnapshot);
  const workspaceGitService = createNoopWorkspaceGitService();
  workspaceGitService.peekSnapshot = peekSnapshotRuntimeFetch;
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
    rootPath: REPO_CWD,
    kind: "git",
    displayName: "repo",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-runtime-fetch",
    projectId: project.projectId,
    cwd: REPO_CWD,
    kind: "local_checkout",
    displayName: "main",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });

  session.emit = (message) => {
    if (isSessionOutboundMessage(message)) emitted.push(message);
  };
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

  expect(peekSnapshotRuntimeFetch).toHaveBeenCalledWith(REPO_CWD);
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
  const emitted: SessionOutboundMessage[] = [];
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
    rootPath: REPO_CWD,
    kind: "git",
    displayName: "repo",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-fetch-boundary",
    projectId: project.projectId,
    cwd: REPO_CWD,
    kind: "local_checkout",
    displayName: "main",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });

  session.emit = (message: unknown) => {
    if (!isSessionOutboundMessage(message)) return;
    if (message.type === "fetch_workspaces_response") {
      events.push("response");
    }
    emitted.push(message);
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
  const emitted: SessionOutboundMessage[] = [];
  const runtimeSnapshot = createWorkspaceRuntimeSnapshot(REPO_CWD, {
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
  const peekSnapshotRuntimeUpdate = vi.fn(() => runtimeSnapshot);
  const workspaceGitService = createNoopWorkspaceGitService();
  workspaceGitService.peekSnapshot = peekSnapshotRuntimeUpdate;

  const session = asTestSession(
    createSessionForWorkspaceTests({
      workspaceGitService,
    }),
  );
  const project = createPersistedProjectRecord({
    projectId: "proj-runtime-update",
    rootPath: REPO_CWD,
    kind: "git",
    displayName: "repo",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-runtime-update",
    projectId: project.projectId,
    cwd: REPO_CWD,
    kind: "local_checkout",
    displayName: "main",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });

  session.emit = (message) => {
    if (isSessionOutboundMessage(message)) emitted.push(message);
  };
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

  await session.emitWorkspaceUpdateForCwd(REPO_CWD, {
    skipReconcile: true,
  });

  expect(peekSnapshotRuntimeUpdate).toHaveBeenCalledWith(REPO_CWD);
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
  const emitted: SessionOutboundMessage[] = [];
  const session = createSessionForWorkspaceTests();
  const gitProject = createPersistedProjectRecord({
    projectId: "proj-git-subscribe",
    rootPath: REPO_CWD,
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
    cwd: REPO_CWD,
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

  session.emit = (message) => {
    if (isSessionOutboundMessage(message)) emitted.push(message);
  };
  session.listAgentPayloads = async () => [];
  session.projectRegistry.list = async () => [gitProject, directoryProject];
  session.workspaceRegistry.list = async () => [gitWorkspace, directoryWorkspace];
  session.reconcileAndEmitWorkspaceUpdates = vi.fn(async () => {});
  const describeWorkspaceRecordSubscribed = vi.fn(
    async (workspace: typeof gitWorkspace, project: unknown) => {
      if (workspace.workspaceId === gitWorkspace.workspaceId) {
        expect(project).toEqual(gitProject);
        return baselineGitDescriptor;
      }
      expect(project).toEqual(directoryProject);
      return directoryDescriptor;
    },
  );
  const describeWorkspaceRecordWithGitDataSubscribed = vi.fn(async () => enrichedGitDescriptor);
  session.describeWorkspaceRecord = describeWorkspaceRecordSubscribed;
  session.describeWorkspaceRecordWithGitData = describeWorkspaceRecordWithGitDataSubscribed;

  await session.handleMessage({
    type: "fetch_workspaces_request",
    requestId: "req-fetch-workspaces",
    subscribe: {},
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const response = findByType(emitted, "fetch_workspaces_response");
  expect(response?.payload.entries.map((entry) => [entry.id, entry.diffStat])).toEqual([
    [directoryDescriptor.id, directoryDescriptor.diffStat],
    [enrichedGitDescriptor.id, enrichedGitDescriptor.diffStat],
  ]);

  const workspaceUpdates = filterByType(emitted, "workspace_update");
  expect(workspaceUpdates).toEqual([]);
  expect(describeWorkspaceRecordWithGitDataSubscribed).toHaveBeenCalledWith(
    gitWorkspace,
    gitProject,
  );
});

test("project.rename.request stores customName and emits an updated workspace descriptor", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const session = asTestSession(
    createSessionForWorkspaceTests({ onMessage: (message) => emitted.push(message) }),
  );

  const project = createPersistedProjectRecord({
    projectId: "remote:github.com/acme/repo",
    rootPath: REPO_CWD,
    kind: "git",
    displayName: "acme/repo",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-1",
    projectId: project.projectId,
    cwd: REPO_CWD,
    kind: "local_checkout",
    displayName: "main",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });

  const projects = new Map([[project.projectId, project]]);
  session.projectRegistry.get = async (id: string) => projects.get(id) ?? null;
  session.projectRegistry.list = async () => Array.from(projects.values());
  session.projectRegistry.upsert = async (record: unknown) => {
    const parsed = record as typeof project;
    projects.set(parsed.projectId, parsed);
  };
  session.workspaceRegistry.list = async () => [workspace];
  session.workspaceRegistry.get = async (id: string) =>
    id === workspace.workspaceId ? workspace : null;

  session.workspaceUpdatesSubscription = {
    subscriptionId: "sub-workspaces",
    filter: {},
    isBootstrapping: false,
    lastEmittedByWorkspaceId: new Map(),
    pendingUpdatesByWorkspaceId: new Map(),
  };

  await session.handleMessage({
    type: "project.rename.request",
    projectId: project.projectId,
    customName: "  My Fork  ",
    requestId: "req-rename-1",
  });

  const response = findByType(emitted, "project.rename.response");
  expect(response?.payload).toEqual({
    requestId: "req-rename-1",
    projectId: project.projectId,
    accepted: true,
    customName: "My Fork",
    error: null,
  });

  expect(projects.get(project.projectId)?.customName).toBe("My Fork");

  const update = findByType(emitted, "workspace_update");
  expect(update?.payload).toMatchObject({
    kind: "upsert",
    workspace: {
      id: "ws-1",
      projectDisplayName: "My Fork",
      projectCustomName: "My Fork",
    },
  });
});

test("project.rename.request with whitespace-only customName clears the override", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const session = asTestSession(
    createSessionForWorkspaceTests({ onMessage: (message) => emitted.push(message) }),
  );

  const project = createPersistedProjectRecord({
    projectId: "remote:github.com/acme/repo",
    rootPath: REPO_CWD,
    kind: "git",
    displayName: "acme/repo",
    customName: "My Fork",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });

  const projects = new Map([[project.projectId, project]]);
  session.projectRegistry.get = async (id: string) => projects.get(id) ?? null;
  session.projectRegistry.list = async () => Array.from(projects.values());
  session.projectRegistry.upsert = async (record: unknown) => {
    const parsed = record as typeof project;
    projects.set(parsed.projectId, parsed);
  };
  session.workspaceRegistry.list = async () => [];

  await session.handleMessage({
    type: "project.rename.request",
    projectId: project.projectId,
    customName: "   ",
    requestId: "req-rename-clear",
  });

  const response = findByType(emitted, "project.rename.response");
  expect(response?.payload).toEqual({
    requestId: "req-rename-clear",
    projectId: project.projectId,
    accepted: true,
    customName: null,
    error: null,
  });
  expect(projects.get(project.projectId)?.customName).toBeNull();
});

test("project.rename.request returns accepted=false when project is not found", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const session = asTestSession(
    createSessionForWorkspaceTests({ onMessage: (message) => emitted.push(message) }),
  );
  session.projectRegistry.get = async () => null;
  await session.handleMessage({
    type: "project.rename.request",
    projectId: "does-not-exist",
    customName: "X",
    requestId: "req-rename-missing",
  });

  const response = findByType(emitted, "project.rename.response");
  expect(response?.payload).toMatchObject({
    requestId: "req-rename-missing",
    projectId: "does-not-exist",
    accepted: false,
    customName: null,
  });
  expect(response?.payload.error).toBeTruthy();
});

test("workspace.title.set.request stores the title and emits an updated descriptor", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const session = asTestSession(
    createSessionForWorkspaceTests({ onMessage: (message) => emitted.push(message) }),
  );

  const project = createPersistedProjectRecord({
    projectId: "proj-1",
    rootPath: REPO_CWD,
    kind: "git",
    displayName: "acme/repo",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-1",
    projectId: project.projectId,
    cwd: REPO_CWD,
    kind: "local_checkout",
    displayName: "main",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });

  const projects = new Map([[project.projectId, project]]);
  const workspaces = new Map([[workspace.workspaceId, workspace]]);
  session.projectRegistry.get = async (id: string) => projects.get(id) ?? null;
  session.projectRegistry.list = async () => Array.from(projects.values());
  session.workspaceRegistry.list = async () => Array.from(workspaces.values());
  session.workspaceRegistry.get = async (id: string) => workspaces.get(id) ?? null;
  session.workspaceRegistry.upsert = async (record: unknown) => {
    const parsed = record as typeof workspace;
    workspaces.set(parsed.workspaceId, parsed);
  };

  session.workspaceUpdatesSubscription = {
    subscriptionId: "sub-workspaces",
    filter: {},
    isBootstrapping: false,
    lastEmittedByWorkspaceId: new Map(),
    pendingUpdatesByWorkspaceId: new Map(),
  };

  await session.handleMessage({
    type: "workspace.title.set.request",
    workspaceId: workspace.workspaceId,
    title: "  Payments work  ",
    requestId: "req-title-1",
  });

  const response = findByType(emitted, "workspace.title.set.response");
  expect(response?.payload).toEqual({
    requestId: "req-title-1",
    workspaceId: workspace.workspaceId,
    accepted: true,
    title: "Payments work",
    error: null,
  });

  expect(workspaces.get(workspace.workspaceId)?.title).toBe("Payments work");

  const update = findByType(emitted, "workspace_update");
  expect(update?.payload).toMatchObject({
    kind: "upsert",
    workspace: {
      id: "ws-1",
      name: "Payments work",
      title: "Payments work",
    },
  });
});

test("workspace.title.set.request with whitespace-only title clears the title", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const session = asTestSession(
    createSessionForWorkspaceTests({ onMessage: (message) => emitted.push(message) }),
  );

  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-1",
    projectId: "proj-1",
    cwd: REPO_CWD,
    kind: "local_checkout",
    displayName: "main",
    title: "Old title",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });

  const workspaces = new Map([[workspace.workspaceId, workspace]]);
  session.workspaceRegistry.list = async () => Array.from(workspaces.values());
  session.workspaceRegistry.get = async (id: string) => workspaces.get(id) ?? null;
  session.workspaceRegistry.upsert = async (record: unknown) => {
    const parsed = record as typeof workspace;
    workspaces.set(parsed.workspaceId, parsed);
  };

  await session.handleMessage({
    type: "workspace.title.set.request",
    workspaceId: workspace.workspaceId,
    title: "   ",
    requestId: "req-title-clear",
  });

  const response = findByType(emitted, "workspace.title.set.response");
  expect(response?.payload).toEqual({
    requestId: "req-title-clear",
    workspaceId: workspace.workspaceId,
    accepted: true,
    title: null,
    error: null,
  });
  expect(workspaces.get(workspace.workspaceId)?.title).toBeNull();
});

test("workspace.title.set.request returns accepted=false when workspace is not found", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const session = asTestSession(
    createSessionForWorkspaceTests({ onMessage: (message) => emitted.push(message) }),
  );
  session.workspaceRegistry.get = async () => null;

  await session.handleMessage({
    type: "workspace.title.set.request",
    workspaceId: "does-not-exist",
    title: "X",
    requestId: "req-title-missing",
  });

  const response = findByType(emitted, "workspace.title.set.response");
  expect(response?.payload).toMatchObject({
    requestId: "req-title-missing",
    workspaceId: "does-not-exist",
    accepted: false,
    title: null,
  });
  expect(response?.payload.error).toBeTruthy();
});

test("resolveRegisteredWorkspaceIdForCwd does not match home directory as a prefix", () => {
  const session = createSessionForWorkspaceTests();
  const home = homedir();
  const childCwd = path.join(home, "projects/new-app");
  const homeWorkspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-home",
    projectId: "proj-home",
    cwd: home,
    kind: "directory",
    displayName: "home",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });

  expect(session.resolveRegisteredWorkspaceIdForCwd(childCwd, [homeWorkspace])).toBeNull();
  expect(session.resolveRegisteredWorkspaceIdForCwd(home, [homeWorkspace])).toBe("ws-home");
});
