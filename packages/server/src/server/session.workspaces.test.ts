import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { z } from "zod";

import { createTestLogger } from "../test-utils/test-logger.js";
import { Session } from "./session.js";
import type { SessionOptions } from "./session.js";
import type { AgentUpdatesService } from "./session/agent-updates/agent-updates-service.js";
import type { AgentSnapshotPayload, SessionOutboundMessage } from "@getpaseo/protocol/messages";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import { createTerminalManager } from "../terminal/terminal-manager.js";
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
import { createWorktree } from "../utils/worktree.js";
import { createRealpathAwarePathMatcher } from "../utils/path.js";
import {
  readPaseoWorktreeMetadata,
  writePaseoWorktreeFirstAgentBranchAutoNameMetadata,
  writePaseoWorktreeMetadata,
} from "../utils/worktree-metadata.js";
import type { WorkspaceGitRuntimeSnapshot } from "./workspace-git-service.js";
import type { GeneratedWorkspaceName } from "./worktree-branch-name-generator.js";
import { WorkspaceAutoName } from "./workspace-auto-name.js";
import type { ForgeService } from "../services/forge-service.js";
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
  type PersistedProjectRecord,
  type PersistedWorkspaceRecord,
} from "./workspace-registry.js";

const REPO_CWD = path.resolve("/tmp/repo");
const UNREGISTERED_CWD = path.resolve("/tmp/unregistered");

const terminalManagers: TerminalManager[] = [];

afterEach(async () => {
  while (terminalManagers.length > 0) {
    const manager = terminalManagers.pop();
    if (manager) {
      manager.killAll();
    }
  }
  await flushTerminalContributionWork();
});

interface SessionTestAccess {
  projectRegistry: {
    list(...args: unknown[]): Promise<unknown[]>;
    archive(projectId: string, archivedAt: string): Promise<void>;
    get(id: string): Promise<unknown>;
    upsert(record: unknown): Promise<unknown>;
    remove(projectId: string): Promise<void>;
  };
  agentStorage: {
    list(...args: unknown[]): Promise<unknown[]>;
    get(agentId: string): Promise<unknown>;
    upsert(record: unknown): Promise<void>;
  };
  agentManager: {
    listAgents(): unknown[];
    getAgent(agentId: string): unknown;
    reloadAgentSession(agentId: string, overrides?: unknown, options?: unknown): Promise<unknown>;
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
    update(
      workspaceId: string,
      updater: (record: PersistedWorkspaceRecord) => PersistedWorkspaceRecord,
    ): Promise<unknown>;
    upsert(record: unknown): Promise<unknown>;
  };
  agentUpdates: AgentUpdatesService;
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
  handleArchiveAgentRequest(agentId: string, requestId: string): Promise<unknown>;
  handleMessage(message: unknown): Promise<unknown>;
  handleCreatePaseoWorktreeRequest(params: unknown): Promise<unknown>;
  listAgentPayloads(...args: unknown[]): Promise<unknown[]>;
  listFetchWorkspacesEntries(params: unknown): Promise<ListFetchResult>;
  listFetchAgentsEntries(params: unknown): Promise<ListFetchResult>;
  resolveAgentIdentifier(identifier: string): Promise<unknown>;
  getAgentPayloadById(agentId: string): Promise<unknown>;
  buildProjectPlacementForWorkspaceId(workspaceId: string): Promise<unknown>;
  buildProjectPlacement(cwd: string): Promise<unknown>;
  buildWorkspaceDescriptorMap(...args: unknown[]): Promise<Map<string, unknown>>;
  describeWorkspaceRecord(...args: unknown[]): Promise<unknown>;
  describeWorkspaceRecordWithGitData(...args: unknown[]): Promise<unknown>;
  markWorkspaceArchiving(workspaceIds: Iterable<string>, archivingAt: string): void;
  clearWorkspaceArchiving(workspaceIds: Iterable<string>): void;
  emitWorkspaceUpdateForCwd(...args: unknown[]): Promise<unknown>;
  emitWorkspaceUpdatesForWorkspaceIds(...args: unknown[]): Promise<unknown>;
  emitWorkspaceUpdatesForExternalWorkspaceIds(
    workspaceIds: Iterable<string>,
    options?: { skipReconcile?: boolean },
  ): Promise<void>;
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
  filesystem: {
    isDirectory(cwd: string): Promise<boolean>;
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

type AgentUpdatesSubscriptionFilter = Parameters<
  AgentUpdatesService["beginSubscription"]
>[0]["filter"];

// Drives the agent-updates module to a live (non-bootstrapping) subscription —
// the post-extraction equivalent of assigning a subscription with
// `isBootstrapping: false`. begin → flush leaves an empty buffer and emits nothing.
function activateAgentUpdatesSubscription(
  session: TestSession,
  subscriptionId: string,
  filter?: AgentUpdatesSubscriptionFilter,
): void {
  session.agentUpdates.beginSubscription({ subscriptionId, filter });
  session.agentUpdates.flushBootstrapped(subscriptionId);
}

const AgentIdEntrySchema = z.object({ agent: z.object({ id: z.string() }) });

function makeAgent(input: {
  id: string;
  cwd: string;
  workspaceId?: string;
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
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
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
  workspaceId?: string;
  lifecycle: AgentSnapshotPayload["status"];
  updatedAt: string;
}) {
  const now = new Date(input.updatedAt);
  const snapshot = makeAgent({
    id: input.id,
    cwd: input.cwd,
    workspaceId: input.workspaceId,
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

  async fetchCatalog() {
    return {
      models: [{ provider: this.provider, id: "gpt-test", label: "GPT Test", isDefault: true }],
      modes: [],
    };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

function createSessionForWorkspaceTests(
  options: {
    appVersion?: string | null;
    onMessage?: (message: SessionOutboundMessage) => void;
    onWorkspaceRecovered?: SessionOptions["onWorkspaceRecovered"];
    workspaceGitService?: ReturnType<typeof createNoopWorkspaceGitService>;
    terminalManager?: TerminalManager | null;
    projectRegistry?: SessionOptions["projectRegistry"];
    workspaceRegistry?: SessionOptions["workspaceRegistry"];
    github?: ForgeService;
    paseoHome?: string;
    worktreesRoot?: string;
    renameCurrentBranch?: (
      cwd: string,
      newName: string,
    ) => Promise<{ previousBranch: string | null; currentBranch: string | null }>;
    generateWorkspaceName?: () => Promise<GeneratedWorkspaceName | null>;
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
  const agentManager = asAgentManager({
    subscribe: () => () => {},
    listAgents: () => [],
    getAgent: () => null,
    archiveAgent: async () => ({ archivedAt: new Date().toISOString() }),
    archiveSnapshot: async () => ({}),
    unarchiveSnapshot: async () => true,
    clearAgentAttention: async () => {},
    notifyAgentState: () => {},
  });
  const workspaceRegistry: SessionOptions["workspaceRegistry"] = options.workspaceRegistry ?? {
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
    update: async (workspaceId, updater) => {
      if (workspaceId !== "ws-repo-running") {
        return null;
      }
      return updater(
        createPersistedWorkspaceRecord({
          workspaceId: "ws-repo-running",
          projectId: "proj-repo-running",
          cwd: REPO_CWD,
          kind: "directory",
          displayName: "repo",
          createdAt: "2026-03-01T12:00:00.000Z",
          updatedAt: "2026-03-01T12:00:00.000Z",
        }),
      );
    },
    upsert: async () => {},
    archive: async () => {},
    remove: async () => {},
  };
  const workspaceGitService = options.workspaceGitService ?? createNoopWorkspaceGitService();
  const providerSnapshotManager = createProviderSnapshotManagerStub().manager;

  const session = asTestSession(
    new Session({
      clientId: "test-client",
      scopes: ["*"],
      appVersion: options.appVersion ?? null,
      onMessage: options.onMessage ?? vi.fn(),
      onWorkspaceRecovered: options.onWorkspaceRecovered,
      logger: asSessionLogger(logger),
      downloadTokenStore: asDownloadTokenStore(),
      pushTokenStore: asPushTokenStore(),
      paseoHome: options.paseoHome ?? "/tmp/paseo-test",
      worktreesRoot: options.worktreesRoot,
      agentManager,
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
      projectRegistry: options.projectRegistry ?? {
        initialize: async () => {},
        existsOnDisk: async () => true,
        list: async () => [],
        get: async () => null,
        getOrCreateActiveByRoot: async (input) =>
          createPersistedProjectRecord({
            projectId: "prj_0000000000000000",
            rootPath: input.rootPath,
            kind: input.kind,
            displayName: input.displayName,
            createdAt: input.timestamp,
            updatedAt: input.timestamp,
          }),
        upsert: async () => {},
        archive: async () => {},
        remove: async () => {},
      },
      workspaceRegistry,
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
        invalidateForge: () => {},
        getMetrics: () => ({
          checkoutDiffTargetCount: 0,
          checkoutDiffSubscriptionCount: 0,
          checkoutDiffWatcherCount: 0,
          checkoutDiffFallbackRefreshTargetCount: 0,
        }),
        dispose: () => {},
      }),
      github: options.github,
      workspaceGitService,
      workspaceAutoName: new WorkspaceAutoName({
        agentManager,
        workspaceRegistry,
        workspaceGitService,
        providerSnapshotManager,
        readDaemonConfig: () => ({ metadataGeneration: { providers: [] } }),
        gitMutation: { notifyGitMutation: async () => {} },
        emitWorkspaceUpdateForCwd: async () => {},
        emitWorkspaceUpdateForWorkspaceId: async () => {},
        logger: asSessionLogger(logger),
        generateWorkspaceName: options.generateWorkspaceName,
      }),
      renameCurrentBranch: options.renameCurrentBranch,
      daemonConfigStore: asDaemonConfigStore({
        get: () => ({ mcp: { injectIntoAgents: false }, providers: {} }),
        onChange: () => () => {},
      }),
      mcpBaseUrl: null,
      stt: null,
      tts: null,
      providerSnapshotManager,
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
        scopes: ["*"],
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
    await expect(
      session.buildProjectPlacementForWorkspaceId(createdAgent!.workspaceId!),
    ).resolves.toMatchObject({
      projectKey: expect.stringMatching(/^prj_[0-9a-f]{16}$/),
      checkout: { cwd: child },
    });
    expect(findByType(emitted, "status")?.payload).toMatchObject({
      status: "agent_created",
      agent: { cwd: child },
    });
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("create_agent_request launches from an exact subdirectory in a created worktree", async () => {
  const workdir = mkdtempSync(path.join(tmpdir(), "paseo-create-agent-worktree-cwd-"));
  try {
    const parent = path.join(workdir, "parent");
    const child = path.join(parent, "packages", "app");
    mkdirSync(child, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: parent, stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "test@getpaseo.local"], {
      cwd: parent,
      stdio: "pipe",
    });
    execFileSync("git", ["config", "user.name", "Paseo Test"], { cwd: parent, stdio: "pipe" });
    writeFileSync(path.join(child, "README.md"), "app\n");
    execFileSync("git", ["add", "."], { cwd: parent, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: parent, stdio: "pipe" });

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
      idFactory: () => "00000000-0000-4000-8000-000000000552",
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
      resolveRepoRoot: async () => parent,
      resolveDefaultBranch: async () => "main",
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
    const session = new Session({
      clientId: "test-client",
      scopes: ["*"],
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
      workspaceAutoName: new WorkspaceAutoName({
        agentManager,
        workspaceRegistry,
        workspaceGitService,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
        readDaemonConfig: () => ({ metadataGeneration: { providers: [] } }),
        gitMutation: { notifyGitMutation: async () => {} },
        emitWorkspaceUpdateForCwd: async () => {},
        emitWorkspaceUpdateForWorkspaceId: async () => {},
        logger: asSessionLogger(logger),
      }),
      daemonConfigStore: asDaemonConfigStore({
        get: () => ({ mcp: { injectIntoAgents: false }, providers: {} }),
        onChange: () => () => {},
      }),
      mcpBaseUrl: null,
      stt: null,
      tts: null,
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      terminalManager: null,
    });

    await session.handleMessage({
      type: "create_agent_request",
      requestId: "req-create-worktree-child",
      config: { provider: "codex", cwd: child },
      attachments: [],
      worktree: { mode: "branch-off", newBranch: "feature/created-worktree" },
    });

    const [createdAgent] = agentManager.listAgents();
    const createdWorktreeRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: createdAgent!.cwd,
      stdio: "pipe",
    })
      .toString()
      .trim();
    expect(
      createRealpathAwarePathMatcher(path.join(createdWorktreeRoot, "packages", "app"))(
        createdAgent?.cwd ?? "",
      ),
    ).toBe(true);
    expect(findByType(emitted, "status")?.payload).toMatchObject({
      status: "agent_created",
      agent: { cwd: createdAgent?.cwd },
    });
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("create_agent_request does not title an existing workspace from the agent prompt", async () => {
  vi.useFakeTimers();
  const workdir = mkdtempSync(path.join(tmpdir(), "paseo-create-agent-existing-title-"));
  try {
    const cwd = path.join(workdir, "repo");
    mkdirSync(cwd, { recursive: true });

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
      idFactory: () => "00000000-0000-4000-8000-000000000552",
    });
    const projectRegistry = new FileBackedProjectRegistry(
      path.join(workdir, "projects.json"),
      asSessionLogger(logger),
    );
    const workspaceRegistry = new FileBackedWorkspaceRegistry(
      path.join(workdir, "workspaces.json"),
      asSessionLogger(logger),
    );

    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "proj-existing",
        rootPath: cwd,
        kind: "git",
        displayName: "repo",
        createdAt: "2026-05-07T00:00:00.000Z",
        updatedAt: "2026-05-07T00:00:00.000Z",
      }),
    );
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "ws-existing",
        projectId: "proj-existing",
        cwd,
        kind: "local_checkout",
        displayName: "repo",
        title: null,
        createdAt: "2026-05-07T00:00:00.000Z",
        updatedAt: "2026-05-07T00:00:00.000Z",
      }),
    );

    let generateCalls = 0;
    const session = asTestSession(
      new Session({
        clientId: "test-client",
        scopes: ["*"],
        appVersion: null,
        onMessage: vi.fn(),
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
            initial: { cwd, files: [], error: null },
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
        workspaceGitService: createNoopWorkspaceGitService(),
        daemonConfigStore: asDaemonConfigStore({
          get: () => ({ mcp: { injectIntoAgents: false }, providers: {} }),
          onChange: () => () => {},
        }),
        mcpBaseUrl: null,
        stt: null,
        tts: null,
        generateWorkspaceName: async () => {
          generateCalls += 1;
          return { title: "Generated title that must not be written", branch: null };
        },
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
        terminalManager: null,
      }),
    );

    await session.handleMessage({
      type: "create_agent_request",
      requestId: "req-create-existing-title",
      workspaceId: "ws-existing",
      config: { provider: "codex", cwd },
      initialPrompt: "Fix login bug\nwith better validation",
      attachments: [],
    });
    await vi.runAllTimersAsync();

    const [createdAgent] = agentManager.listAgents();
    expect(createdAgent?.workspaceId).toBe("ws-existing");
    expect(generateCalls).toBe(0);
    await expect(workspaceRegistry.get("ws-existing")).resolves.toMatchObject({
      title: null,
      updatedAt: "2026-05-07T00:00:00.000Z",
    });
  } finally {
    vi.useRealTimers();
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

  await expect(session.listAgentPayloads({ includeUnavailablePersisted: true })).resolves.toEqual(
    [],
  );

  await expect(
    session.listAgentPayloads({ includeArchived: true, includeUnavailablePersisted: true }),
  ).resolves.toEqual([
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
  session.workspaceRegistry.get = async (id: string) =>
    id === workspace.workspaceId ? workspace : null;
  activateAgentUpdatesSubscription(session, "sub-agents", {});

  await session.agentUpdates.forwardLiveAgent(
    makeManagedAgent({
      id: "agent-1",
      cwd: REPO_CWD,
      workspaceId: workspace.workspaceId,
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

test("agent_update emits remove when the agent has no workspaceId", async () => {
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

  activateAgentUpdatesSubscription(session, "sub-agents", {});

  await session.agentUpdates.forwardLiveAgent(
    makeManagedAgent({
      id: "agent-1",
      cwd: UNREGISTERED_CWD,
      lifecycle: "running",
      updatedAt: "2026-03-30T15:00:00.000Z",
    }),
  );

  expect(getSnapshot).not.toHaveBeenCalled();
  const update = emitted.find((message) => message.type === "agent_update");
  expect(update?.payload).toMatchObject({
    kind: "remove",
    agentId: "agent-1",
  });
});

test("archive emits an authoritative agent_update upsert for subscribed clients", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const archivedRecord = {
    id: "agent-1",
    provider: "codex",
    cwd: REPO_CWD,
    workspaceId: "ws-1",
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
      scopes: ["*"],
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
        invalidateForge: () => {},
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

  activateAgentUpdatesSubscription(session, "sub-agents", { includeArchived: true });

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
      workspaceId: workspace.workspaceId,
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
    Array.from(storedRecords.values()).map((record) => {
      const owner = workspaces.find((workspace) => workspace.cwd === record.cwd);
      return makeAgent({
        id: record.id,
        cwd: record.cwd,
        ...(owner ? { workspaceId: owner.workspaceId } : {}),
        status: "closed",
        updatedAt: record.updatedAt,
        requiresAttention: record.requiresAttention,
        attentionReason: record.attentionReason,
      });
    });

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
    workspaceId: "ws-close",
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
  const cancelAgentRun = vi.fn(async () => ({ status: "settled" as const }));
  const session = asTestSession(
    new Session({
      clientId: "test-client",
      scopes: ["*"],
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
        invalidateForge: () => {},
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

  activateAgentUpdatesSubscription(session, "sub-agents", { includeArchived: true });

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
      scopes: ["*"],
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
        invalidateForge: () => {},
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

  activateAgentUpdatesSubscription(session, "sub-agents", { includeArchived: true });

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
      workspaceId: "ws-err",
      status: "idle",
      updatedAt: "2026-03-01T12:00:00.000Z",
    }),
    archivedAt: null as string | null,
  };
  const killTerminalBestEffort = vi.fn();
  const session = asTestSession(
    new Session({
      clientId: "test-client",
      scopes: ["*"],
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
        invalidateForge: () => {},
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

  activateAgentUpdatesSubscription(session, "sub-agents", { includeArchived: true });

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

test("workspace placements preserve checkout facts independently from the project", async () => {
  const session = createSessionForWorkspaceTests();
  const manualWorktree = createPersistedWorkspaceRecord({
    workspaceId: "ws-manual-worktree",
    projectId: "proj-manual-worktree",
    cwd: "/tmp/manual-worktree",
    kind: "worktree",
    displayName: "manual",
    isPaseoOwnedWorktree: false,
    mainRepoRoot: "/tmp/main-repo",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const explicitDirectory = createPersistedWorkspaceRecord({
    workspaceId: "ws-explicit-directory",
    projectId: "proj-manual-worktree",
    cwd: "/tmp/plain-directory",
    kind: "directory",
    displayName: "plain",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const paseoSubdirectory = createPersistedWorkspaceRecord({
    workspaceId: "ws-paseo-subdirectory",
    projectId: "proj-manual-worktree",
    cwd: "/tmp/paseo-worktree/packages/app",
    kind: "worktree",
    displayName: "app",
    isPaseoOwnedWorktree: true,
    mainRepoRoot: "/tmp/main-repo",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const project = createPersistedProjectRecord({
    projectId: "proj-manual-worktree",
    rootPath: "/tmp/main-repo",
    kind: "git",
    displayName: "main",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  session.workspaceRegistry.get = async (workspaceId: string) =>
    [manualWorktree, explicitDirectory, paseoSubdirectory].find(
      (workspace) => workspace.workspaceId === workspaceId,
    ) ?? null;
  session.projectRegistry.get = async () => project;
  session.workspaceGitService.peekSnapshot = (cwd: string) =>
    cwd === paseoSubdirectory.cwd
      ? createWorkspaceRuntimeSnapshot(cwd, {
          git: { repoRoot: "/tmp/paseo-worktree" },
        })
      : null;

  await expect(
    session.buildProjectPlacementForWorkspaceId(manualWorktree.workspaceId),
  ).resolves.toEqual(
    expect.objectContaining({
      checkout: expect.objectContaining({
        isGit: true,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: "/tmp/main-repo",
      }),
    }),
  );
  await expect(
    session.buildProjectPlacementForWorkspaceId(explicitDirectory.workspaceId),
  ).resolves.toEqual(
    expect.objectContaining({
      checkout: expect.objectContaining({
        isGit: false,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      }),
    }),
  );
  await expect(
    session.buildProjectPlacementForWorkspaceId(paseoSubdirectory.workspaceId),
  ).resolves.toEqual(
    expect.objectContaining({
      checkout: expect.objectContaining({
        cwd: paseoSubdirectory.cwd,
        worktreeRoot: "/tmp/paseo-worktree",
      }),
    }),
  );
});

test("active-scoped fetch_agents includes only unarchived agents in active workspaces", async () => {
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
      workspaceId: "ws-active",
      status: "idle",
      updatedAt: "2026-03-01T12:04:00.000Z",
    }),
    makeAgent({
      id: "agent-subdir",
      cwd: "/tmp/active/packages/app",
      workspaceId: "ws-active",
      status: "idle",
      updatedAt: "2026-03-01T12:03:00.000Z",
    }),
    makeAgent({
      id: "agent-archived-workspace",
      cwd: "/tmp/archived-workspace",
      workspaceId: "ws-archived",
      status: "idle",
      updatedAt: "2026-03-01T12:02:00.000Z",
    }),
    makeAgent({
      id: "agent-archived-project",
      cwd: "/tmp/archived-project",
      workspaceId: "ws-archived-project",
      status: "idle",
      updatedAt: "2026-03-01T12:01:00.000Z",
    }),
    {
      ...makeAgent({
        id: "agent-archived",
        cwd: "/tmp/active",
        workspaceId: "ws-active",
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

  expect(agentIdsFromEntries(result.entries)).toEqual(["agent-active", "agent-subdir"]);
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
      workspaceId: "ws-active-one",
      status: "idle",
      updatedAt: "2026-03-01T12:03:00.000Z",
    }),
    makeAgent({
      id: "stale-between",
      cwd: "/tmp/pages/stale",
      workspaceId: "ws-stale",
      status: "idle",
      updatedAt: "2026-03-01T12:02:00.000Z",
    }),
    makeAgent({
      id: "active-two",
      cwd: "/tmp/pages/two",
      workspaceId: "ws-active-two",
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
  session.workspaceRegistry.get = async (workspaceId: string) =>
    [activeWorkspace, archivedWorkspace].find(
      (workspace) => workspace.workspaceId === workspaceId,
    ) ?? null;
  session.listAgentPayloads = async () => [
    makeAgent({
      id: "legacy-active",
      cwd: activeCwd,
      workspaceId: "ws-legacy-active",
      status: "idle",
      updatedAt: "2026-03-01T12:01:00.000Z",
    }),
    makeAgent({
      id: "legacy-archived-workspace",
      cwd: archivedCwd,
      workspaceId: "ws-legacy-archived",
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
  session.workspaceRegistry.get = async () => workspace;
  session.listAgentPayloads = async () => [
    {
      ...makeAgent({
        id: "history-archived",
        cwd: historyCwd,
        workspaceId: "ws-history",
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
  expect(session.agentUpdates.hasSubscription()).toBe(false);
});

test("fetch_agent_history_request skips rows whose workspace project record is missing", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const session = createSessionForWorkspaceTests();
  const stableCwd = path.resolve("/tmp/stable-history");
  const orphanCwd = path.resolve("/tmp/orphan-history");
  const stableProject = createPersistedProjectRecord({
    projectId: "proj-stable-history",
    rootPath: stableCwd,
    kind: "non_git",
    displayName: "stable history",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const stableWorkspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-stable-history",
    projectId: stableProject.projectId,
    cwd: stableCwd,
    kind: "directory",
    displayName: "stable history",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const orphanWorkspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-orphan-history",
    projectId: orphanCwd,
    cwd: orphanCwd,
    kind: "local_checkout",
    displayName: "main",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });

  session.emit = (message) => {
    if (isSessionOutboundMessage(message)) emitted.push(message);
  };
  session.projectRegistry.get = async (projectId: string) =>
    projectId === stableProject.projectId ? stableProject : null;
  session.workspaceRegistry.get = async (workspaceId: string) =>
    [stableWorkspace, orphanWorkspace].find((workspace) => workspace.workspaceId === workspaceId) ??
    null;
  session.listAgentPayloads = async () => [
    makeAgent({
      id: "history-orphan",
      cwd: orphanCwd,
      workspaceId: orphanWorkspace.workspaceId,
      status: "idle",
      updatedAt: "2026-03-01T12:01:00.000Z",
    }),
    makeAgent({
      id: "history-stable",
      cwd: stableCwd,
      workspaceId: stableWorkspace.workspaceId,
      status: "closed",
      updatedAt: "2026-03-01T12:00:00.000Z",
    }),
  ];

  await session.handleMessage({
    type: "fetch_agent_history_request",
    requestId: "req-history-orphan",
    page: { limit: 25 },
  });

  expect(emitted).toEqual([
    {
      type: "fetch_agent_history_response",
      payload: expect.objectContaining({
        requestId: "req-history-orphan",
        entries: [
          expect.objectContaining({
            agent: expect.objectContaining({ id: "history-stable" }),
            project: expect.objectContaining({
              projectKey: stableProject.projectId,
              projectName: "stable history",
              workspaceName: "stable history",
            }),
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
      workspaceId: "ws-history-detail",
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
  session.buildProjectPlacementForWorkspaceId = async () => ({
    projectKey: "proj-history-detail",
    projectName: "history detail",
    checkout: {
      cwd: agent.cwd,
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
      workspaceId: "ws-repo-status",
      status: "running",
      updatedAt: "2026-03-01T12:00:00.000Z",
    }),
    makeAgent({
      id: "a2",
      cwd: REPO_CWD,
      workspaceId: "ws-repo-status",
      status: "error",
      updatedAt: "2026-03-01T12:01:00.000Z",
    }),
    makeAgent({
      id: "a3",
      cwd: REPO_CWD,
      workspaceId: "ws-repo-status",
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

test("subdirectory agents contribute to their owning workspace descriptor", async () => {
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
  // The agent runs in a subdirectory but carries its owning workspaceId; the
  // subdir cwd is cosmetic and never drives attribution.
  session.listAgentPayloads = async () => [
    makeAgent({
      id: "a1",
      cwd: "/tmp/repo/packages/app",
      workspaceId: "ws-repo-subdir",
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
    status: "running",
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
      scopes: ["*"],
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
        invalidateForge: () => {},
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

test("project.remove.request archives active workspaces and removes the project record", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const session = createSessionForWorkspaceTests({
    onMessage: (message) => emitted.push(message),
  });
  const project = createPersistedProjectRecord({
    projectId: "proj-remove-with-workspace",
    rootPath: REPO_CWD,
    kind: "git",
    displayName: "repo",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-project-remove",
    projectId: project.projectId,
    cwd: REPO_CWD,
    kind: "local_checkout",
    displayName: "main",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const projects = new Map<string, PersistedProjectRecord>([[project.projectId, project]]);
  const workspaces = new Map<string, PersistedWorkspaceRecord>([
    [workspace.workspaceId, workspace],
  ]);

  session.projectRegistry.get = async (projectId: string) => projects.get(projectId) ?? null;
  session.projectRegistry.list = async () => Array.from(projects.values());
  session.projectRegistry.remove = async (projectId: string) => {
    projects.delete(projectId);
  };
  session.workspaceRegistry.get = async (workspaceId: string) =>
    workspaces.get(workspaceId) ?? null;
  session.workspaceRegistry.list = async () => Array.from(workspaces.values());
  session.workspaceRegistry.archive = async (workspaceId: string, archivedAt: string) => {
    const existing = workspaces.get(workspaceId);
    if (!existing) return;
    workspaces.set(workspaceId, { ...existing, updatedAt: archivedAt, archivedAt });
  };
  session.workspaceUpdatesSubscription = {
    subscriptionId: "sub-project-remove",
    filter: undefined,
    isBootstrapping: false,
    pendingUpdatesByWorkspaceId: new Map(),
    lastEmittedByWorkspaceId: new Map(),
  };
  session.reconcileActiveWorkspaceRecords = async () => new Set();
  session.listAgentPayloads = async () => [];
  session.buildWorkspaceDescriptorMap = async (options: { workspaceIds?: Iterable<string> }) => {
    const workspaceIds = Array.from(options.workspaceIds ?? workspaces.keys());
    const descriptors = new Map<string, unknown>();
    for (const workspaceId of workspaceIds) {
      const record = workspaces.get(workspaceId);
      if (!record || record.archivedAt) continue;
      descriptors.set(workspaceId, {
        id: record.workspaceId,
        projectId: record.projectId,
        projectDisplayName: "repo",
        projectRootPath: REPO_CWD,
        projectKind: "git",
        workspaceKind: record.kind,
        name: record.displayName,
        status: "idle",
        activityAt: null,
      });
    }
    return descriptors;
  };

  await session.handleMessage({
    type: "project.remove.request",
    projectId: project.projectId,
    requestId: "req-remove-project",
  });

  expect(projects.has(project.projectId)).toBe(false);
  expect(workspaces.get(workspace.workspaceId)).toEqual({
    ...workspace,
    updatedAt: expect.any(String),
    archivedAt: expect.any(String),
  });
  expect(findByType(emitted, "project.remove.response")?.payload).toEqual({
    requestId: "req-remove-project",
    projectId: project.projectId,
    accepted: true,
    removedWorkspaceIds: [workspace.workspaceId],
    error: null,
  });
  const workspaceUpdates = filterByType(emitted, "workspace_update");
  expect(workspaceUpdates.at(-1)?.payload).toEqual({
    kind: "remove",
    id: workspace.workspaceId,
    removedProjectId: project.projectId,
  });
});

test("project.remove.request removes an already-empty project", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const session = createSessionForWorkspaceTests({
    onMessage: (message) => emitted.push(message),
  });
  const project = createPersistedProjectRecord({
    projectId: "proj-remove-empty",
    rootPath: REPO_CWD,
    kind: "git",
    displayName: "repo",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const archivedWorkspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-project-remove-empty",
    projectId: project.projectId,
    cwd: REPO_CWD,
    kind: "local_checkout",
    displayName: "main",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
    archivedAt: "2026-03-02T12:00:00.000Z",
  });
  const projects = new Map<string, PersistedProjectRecord>([[project.projectId, project]]);
  const workspaces = new Map<string, PersistedWorkspaceRecord>([
    [archivedWorkspace.workspaceId, archivedWorkspace],
  ]);

  session.projectRegistry.get = async (projectId: string) => projects.get(projectId) ?? null;
  session.projectRegistry.list = async () => Array.from(projects.values());
  session.projectRegistry.remove = async (projectId: string) => {
    projects.delete(projectId);
  };
  session.workspaceRegistry.get = async (workspaceId: string) =>
    workspaces.get(workspaceId) ?? null;
  session.workspaceRegistry.list = async () => Array.from(workspaces.values());
  session.workspaceRegistry.archive = async (workspaceId: string, archivedAt: string) => {
    const existing = workspaces.get(workspaceId);
    if (!existing) return;
    workspaces.set(workspaceId, { ...existing, updatedAt: archivedAt, archivedAt });
  };
  session.workspaceUpdatesSubscription = {
    subscriptionId: "sub-empty-project-remove",
    filter: undefined,
    isBootstrapping: false,
    pendingUpdatesByWorkspaceId: new Map(),
    lastEmittedByWorkspaceId: new Map(),
  };
  session.reconcileActiveWorkspaceRecords = async () => new Set();
  session.listAgentPayloads = async () => [];
  session.buildWorkspaceDescriptorMap = async () => new Map();

  await session.handleMessage({
    type: "project.remove.request",
    projectId: project.projectId,
    requestId: "req-remove-empty-project",
  });

  expect(projects.has(project.projectId)).toBe(false);
  expect(workspaces.get(archivedWorkspace.workspaceId)).toEqual(archivedWorkspace);
  expect(findByType(emitted, "project.remove.response")?.payload).toEqual({
    requestId: "req-remove-empty-project",
    projectId: project.projectId,
    accepted: true,
    removedWorkspaceIds: [],
    error: null,
  });
  expect(filterByType(emitted, "workspace_update")).toEqual([
    {
      type: "workspace_update",
      payload: {
        kind: "remove",
        id: archivedWorkspace.workspaceId,
        removedProjectId: project.projectId,
      },
    },
  ]);
});

test("create paseo worktree response preserves an explicit non-Git project", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const createdAt = "2026-05-12T12:00:00.000Z";
  vi.setSystemTime(new Date(createdAt));
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
  const explicitProject = createPersistedProjectRecord({
    projectId: "prj_explicit_non_git",
    rootPath: path.join(tempDir, "selected-project"),
    kind: "non_git",
    displayName: "Selected project",
    createdAt,
    updatedAt: createdAt,
  });
  const projects = new Map([[explicitProject.projectId, explicitProject]]);
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
  session.projectRegistry.getOrCreateActiveByRoot = async (input) => {
    const existing = Array.from(projects.values()).find(
      (project) => !project.archivedAt && project.rootPath === input.rootPath,
    );
    if (existing) return existing;
    const project = createPersistedProjectRecord({
      projectId: `prj_${projects.size.toString().padStart(16, "0")}`,
      rootPath: input.rootPath,
      kind: input.kind,
      displayName: input.displayName,
      createdAt: input.timestamp,
      updatedAt: input.timestamp,
    });
    projects.set(project.projectId, project);
    return project;
  };
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
      projectId: explicitProject.projectId,
      worktreeSlug: "worktree-123",
      requestId: "req-worktree",
    });
  } finally {
    vi.useRealTimers();
    rmSync(tempDir, { recursive: true, force: true });
  }

  const response = findByType(emitted, "create_paseo_worktree_response");

  expect(response?.payload.error).toBeNull();
  expect(response?.payload.workspace).toMatchObject({
    projectId: explicitProject.projectId,
    projectDisplayName: explicitProject.displayName,
    projectRootPath: explicitProject.rootPath,
    projectKind: "non_git",
    workspaceKind: "worktree",
    name: "worktree-123",
    status: "done",
    statusEnteredAt: createdAt,
  });
  expect(response?.payload.workspace?.id).toMatch(/^wks_[0-9a-f]{16}$/);
  expect(response?.payload.workspace?.workspaceDirectory).toContain(path.join("worktree-123"));
  expect(workspaces.has(response?.payload.workspace?.id ?? "")).toBe(true);
  expect(projects.get(explicitProject.projectId)).toEqual(explicitProject);
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
  session.projectRegistry.getOrCreateActiveByRoot = async (allocation) => {
    const project = createPersistedProjectRecord({
      projectId: "prj_githubruntime",
      rootPath: allocation.rootPath,
      kind: allocation.kind,
      displayName: allocation.displayName,
      createdAt: allocation.timestamp,
      updatedAt: allocation.timestamp,
    });
    projects.set(project.projectId, project);
    return project;
  };
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
  session.agentUpdates.forwardLiveAgent = async () => undefined;

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

test("import_agent_request imports into the workspace that opened the import sheet", async () => {
  const session = createSessionForWorkspaceTests();
  const workspaceId = "ws-repo-running";
  let importedWorkspaceId: string | undefined;
  let workspaceCreated = false;

  session.projectRegistry.get = async () =>
    createPersistedProjectRecord({
      projectId: "proj-repo-running",
      rootPath: REPO_CWD,
      kind: "non_git",
      displayName: "repo",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
    });
  session.workspaceRegistry.upsert = async () => {
    workspaceCreated = true;
  };

  session.agentManager.importProviderSession = async (input: unknown) => {
    importedWorkspaceId = (input as { workspaceId: string }).workspaceId;
    return makeManagedAgent({
      id: "imported-agent",
      cwd: REPO_CWD,
      workspaceId: importedWorkspaceId,
      lifecycle: "idle",
      updatedAt: "2026-05-21T00:00:00.000Z",
    });
  };
  session.agentManager.getTimeline = () => [];
  session.agentStorage.list = async () => [];
  session.agentStorage.get = async () => null;
  session.agentUpdates.forwardLiveAgent = async () => undefined;

  await session.handleMessage({
    type: "import_agent_request",
    requestId: "req-import-current-workspace",
    providerId: "codex",
    providerHandleId: "session-xyz",
    cwd: REPO_CWD,
    workspaceId,
  });

  expect(importedWorkspaceId).toBe(workspaceId);
  expect(workspaceCreated).toBe(false);
});

test("import_agent_request maps an import failure to agent_create_failed", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const session = createSessionForWorkspaceTests({
    onMessage: (message) => emitted.push(message),
  });
  session.projectRegistry.get = async () =>
    createPersistedProjectRecord({
      projectId: "proj-repo-running",
      rootPath: REPO_CWD,
      kind: "non_git",
      displayName: "repo",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
    });
  session.agentStorage.list = async () => [];
  session.agentManager.importProviderSession = async () => {
    throw new Error("provider session is unavailable");
  };

  await session.handleMessage({
    type: "import_agent_request",
    requestId: "req-failed-import",
    providerId: "codex",
    providerHandleId: "stale-session",
    cwd: REPO_CWD,
    workspaceId: "ws-repo-running",
  });

  expect(findByType(emitted, "status")?.payload).toMatchObject({
    status: "agent_create_failed",
    requestId: "req-failed-import",
    error: "provider session is unavailable",
  });
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
  session.projectRegistry.getOrCreateActiveByRoot = async (allocation) => {
    const project = createPersistedProjectRecord({
      projectId: "prj_githubruntime",
      rootPath: allocation.rootPath,
      kind: allocation.kind,
      displayName: allocation.displayName,
      createdAt: allocation.timestamp,
      updatedAt: allocation.timestamp,
    });
    projects.set(project.projectId, project);
    return project;
  };
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
  const home = path.resolve("/home/developer");
  const worktree = path.join(home, ".paseo", "worktrees", "project-config-lifecycle-textarea");

  projects.set(
    home,
    createPersistedProjectRecord({
      projectId: home,
      rootPath: home,
      kind: "non_git",
      displayName: "developer",
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
      displayName: "developer",
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
  const home = path.resolve("/home/developer");
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
  const repoRoot = path.resolve("/home/developer/dev/paseo");
  const cwd = path.join(
    path.resolve("/home/developer"),
    ".paseo",
    "worktrees",
    "orchestrate",
    "desktop-daemon-settings",
  );
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
  expect(response?.payload.workspace?.projectId).toMatch(/^prj_[0-9a-f]{16}$/);
  expect(projects.get(cwd)?.archivedAt).toBe(archivedAt);
  expect(workspaces.get(workspaceId)?.archivedAt).toBe(archivedAt);
});

test("open_project_request reclassifies an active directory workspace when git metadata becomes available", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const session = createSessionForWorkspaceTests();
  const projects = new Map<string, ReturnType<typeof createPersistedProjectRecord>>();
  const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>();
  const repoRoot = path.resolve("/home/developer/dev/paseo");
  const cwd = path.join(
    path.resolve("/home/developer"),
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
  expect(response?.payload.workspace?.projectId).toBe(cwd);
  expect(workspaces.get(workspaceId)?.projectId).toBe(cwd);
});

test("open_project_request gives a plain git worktree its own exact-root project", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const session = createSessionForWorkspaceTests();
  const projects = new Map<string, ReturnType<typeof createPersistedProjectRecord>>();
  const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>();
  const repoRoot = path.resolve("/home/developer/dev/paseo");
  const cwd = path.join(
    path.resolve("/home/developer"),
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
  expect(response?.payload.workspace?.projectId).toMatch(/^prj_[0-9a-f]{16}$/);
  const worktreeWorkspace = Array.from(workspaces.values()).find(
    (workspace) => workspace.cwd === cwd,
  );
  expect(worktreeWorkspace?.projectId).toMatch(/^prj_[0-9a-f]{16}$/);
});

test("open_project_request keeps archived records and allocates a fresh workspace", async () => {
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

  expect(workspaces.get(workspaceId)?.archivedAt).not.toBeNull();
  expect(projects.get(cwd)?.archivedAt).not.toBeNull();
  const response = findByType(emitted, "open_project_response");
  expect(response?.payload.error).toBeNull();
  expect(response?.payload.workspace?.id).not.toBe(workspaceId);
  expect(response?.payload.workspace?.projectId).toMatch(/^prj_[0-9a-f]{16}$/);
});

test("open_project_request does not repurpose an orphaned archived workspace", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const session = createSessionForWorkspaceTests();
  const projects = new Map<string, ReturnType<typeof createPersistedProjectRecord>>();
  const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>();

  const cwd = REPO_CWD;
  const workspaceId = "ws-repo-project-removed";
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
    requestId: "req-open-removed-project",
  });

  expect(projects.get(cwd)).toBeUndefined();
  expect(workspaces.get(workspaceId)?.archivedAt).not.toBeNull();
  const response = findByType(emitted, "open_project_response");
  expect(response?.payload.error).toBeNull();
  expect(response?.payload.workspace?.id).not.toBe(workspaceId);
  expect(response?.payload.workspace?.projectId).toMatch(/^prj_[0-9a-f]{16}$/);
});

test("workspace recovery stays accepted when git observer warming fails", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const workspaceGitService = createNoopWorkspaceGitService({
    registerWorkspace: () => {
      throw new Error("git watcher unavailable");
    },
  });
  const session = createSessionForWorkspaceTests({
    appVersion: "0.1.105",
    workspaceGitService,
    onMessage: (message) => {
      if (isSessionOutboundMessage(message)) emitted.push(message);
    },
  });
  const archivedAt = "2026-03-10T00:00:00.000Z";
  let project = createPersistedProjectRecord({
    projectId: REPO_CWD,
    rootPath: REPO_CWD,
    kind: "git",
    displayName: "repo",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: archivedAt,
    archivedAt,
  });
  let workspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-recovery-warm-failure",
    projectId: project.projectId,
    cwd: REPO_CWD,
    kind: "directory",
    displayName: "repo",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: archivedAt,
    archivedAt,
  });

  session.filesystem.isDirectory = async () => true;
  session.projectRegistry.get = async (projectId: string) =>
    projectId === project.projectId ? project : null;
  session.projectRegistry.list = async () => [project];
  session.projectRegistry.upsert = async (record: PersistedProjectRecord) => {
    project = record;
  };
  session.workspaceRegistry.get = async (workspaceId: string) =>
    workspaceId === workspace.workspaceId ? workspace : null;
  session.workspaceRegistry.list = async () => [workspace];
  session.workspaceRegistry.upsert = async (record: PersistedWorkspaceRecord) => {
    workspace = record;
  };
  session.workspaceUpdatesSubscription = {
    subscriptionId: "sub-recovery-warm-failure",
    filter: undefined,
    isBootstrapping: false,
    pendingUpdatesByWorkspaceId: new Map(),
    lastEmittedByWorkspaceId: new Map(),
  };
  session.reconcileActiveWorkspaceRecords = async () => new Set();
  session.listAgentPayloads = async () => [];

  await session.handleMessage({
    type: "workspace.recovery.restore.request",
    requestId: "req-recovery-warm-failure",
    workspaceId: workspace.workspaceId,
  });

  expect(workspace.archivedAt).toBeNull();
  expect(findByType(emitted, "workspace.recovery.restore.response")?.payload).toEqual({
    requestId: "req-recovery-warm-failure",
    workspaceId: workspace.workspaceId,
    accepted: true,
    error: null,
  });
  expect(findByType(emitted, "workspace_update")?.payload).toMatchObject({
    kind: "upsert",
    workspace: { id: workspace.workspaceId },
  });
});

test("refresh_agent_request leaves workspace archival independent when its directory exists", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const session = createSessionForWorkspaceTests({
    onMessage: (message) => {
      if (isSessionOutboundMessage(message)) emitted.push(message);
    },
  });
  const projects = new Map<string, ReturnType<typeof createPersistedProjectRecord>>();
  const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>();

  const cwd = path.resolve("/tmp/paseo-unit2-existing-dir");
  session.filesystem.isDirectory = async () => true;
  const workspaceId = "ws-repo-archived";
  const agentId = "agent-archived";
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

  const storedAgent: StoredAgentRecord = {
    ...makeStoredAgent({ id: agentId, cwd, updatedAt: "2026-03-10T00:00:00.000Z" }),
    workspaceId,
    archivedAt: "2026-03-10T00:00:00.000Z",
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

  session.agentStorage.get = async (id: string) => (id === agentId ? storedAgent : null);
  session.agentStorage.upsert = async () => {};

  const managed = makeManagedAgent({
    id: agentId,
    cwd,
    workspaceId,
    lifecycle: "idle",
    updatedAt: "2026-03-10T00:00:00.000Z",
  });
  session.agentManager.getAgent = () => managed;
  session.interruptAgentIfRunning = async () => undefined;
  session.agentManager.reloadAgentSession = async () => managed;
  session.agentManager.hydrateTimelineFromProvider = async () => undefined;
  session.agentManager.getTimeline = () => [];
  session.agentUpdates.forwardLiveAgent = async () => undefined;

  const unarchivedWorkspaceIds: string[][] = [];
  const realEmit = session.emitWorkspaceUpdatesForWorkspaceIds.bind(session);
  session.emitWorkspaceUpdatesForWorkspaceIds = async (ids: string[], ...rest: unknown[]) => {
    unarchivedWorkspaceIds.push(ids);
    return realEmit(ids, ...rest);
  };

  await session.handleMessage({
    type: "refresh_agent_request",
    agentId,
    requestId: "req-refresh-unarchive",
  });

  expect(workspaces.get(workspaceId)?.archivedAt).toBe("2026-03-10T00:00:00.000Z");
  expect(projects.get(cwd)?.archivedAt).toBe("2026-03-10T00:00:00.000Z");
  expect(unarchivedWorkspaceIds).toEqual([]);
  expect(findByType(emitted, "rpc_error")).toBeUndefined();
});

test("refresh_agent_request leaves workspace archival independent when its directory is missing", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const session = createSessionForWorkspaceTests({
    onMessage: (message) => {
      if (isSessionOutboundMessage(message)) emitted.push(message);
    },
  });
  const projects = new Map<string, ReturnType<typeof createPersistedProjectRecord>>();
  const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>();

  const cwd = path.resolve("/tmp/paseo-missing-workspace-dir");
  session.filesystem.isDirectory = async () => false;
  const workspaceId = "ws-missing-dir";
  const agentId = "agent-missing-dir";
  projects.set(
    cwd,
    createPersistedProjectRecord({
      projectId: cwd,
      rootPath: cwd,
      kind: "non_git",
      displayName: "missing",
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
      displayName: "missing",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-10T00:00:00.000Z",
      archivedAt: "2026-03-10T00:00:00.000Z",
    }),
  );

  const storedAgent: StoredAgentRecord = {
    ...makeStoredAgent({ id: agentId, cwd, updatedAt: "2026-03-10T00:00:00.000Z" }),
    workspaceId,
    archivedAt: "2026-03-10T00:00:00.000Z",
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

  session.agentStorage.get = async (id: string) => (id === agentId ? storedAgent : null);
  session.agentStorage.upsert = async () => {};

  const managed = makeManagedAgent({
    id: agentId,
    cwd,
    workspaceId,
    lifecycle: "idle",
    updatedAt: "2026-03-10T00:00:00.000Z",
  });
  session.agentManager.getAgent = () => managed;
  session.interruptAgentIfRunning = async () => undefined;
  session.agentManager.reloadAgentSession = async () => managed;
  session.agentManager.hydrateTimelineFromProvider = async () => undefined;
  session.agentManager.getTimeline = () => [];
  session.agentUpdates.forwardLiveAgent = async () => undefined;

  await session.handleMessage({
    type: "refresh_agent_request",
    agentId,
    requestId: "req-refresh-missing-dir",
  });

  expect(workspaces.get(workspaceId)?.archivedAt).toBe("2026-03-10T00:00:00.000Z");
  expect(projects.get(cwd)?.archivedAt).toBe("2026-03-10T00:00:00.000Z");
});

test("refresh_agent_request does not recreate or unarchive a deleted worktree", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const session = createSessionForWorkspaceTests({
    appVersion: "0.1.105",
    onMessage: (message) => {
      if (isSessionOutboundMessage(message)) emitted.push(message);
    },
  });
  const projects = new Map<string, ReturnType<typeof createPersistedProjectRecord>>();
  const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>();

  const cwd = path.resolve("/tmp/paseo-deleted-worktree-dir");
  session.filesystem.isDirectory = async () => false;
  const workspaceId = "ws-deleted-worktree";
  const agentId = "agent-deleted-worktree";
  projects.set(
    cwd,
    createPersistedProjectRecord({
      projectId: cwd,
      rootPath: cwd,
      kind: "git",
      displayName: "worktree-project",
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
      kind: "worktree",
      branch: "feature/keep",
      displayName: "feature/keep",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-10T00:00:00.000Z",
      archivedAt: "2026-03-10T00:00:00.000Z",
    }),
  );

  const storedAgent: StoredAgentRecord = {
    ...makeStoredAgent({ id: agentId, cwd, updatedAt: "2026-03-10T00:00:00.000Z" }),
    workspaceId,
    archivedAt: "2026-03-10T00:00:00.000Z",
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

  session.agentStorage.get = async (id: string) => (id === agentId ? storedAgent : null);
  session.agentStorage.upsert = async () => {};

  const managed = makeManagedAgent({
    id: agentId,
    cwd,
    workspaceId,
    lifecycle: "idle",
    updatedAt: "2026-03-10T00:00:00.000Z",
  });
  session.agentManager.getAgent = () => managed;
  session.interruptAgentIfRunning = async () => undefined;
  session.agentManager.reloadAgentSession = async () => managed;
  session.agentManager.hydrateTimelineFromProvider = async () => undefined;
  session.agentManager.getTimeline = () => [];
  session.agentUpdates.forwardLiveAgent = async () => undefined;

  const unarchivedWorkspaceIds: string[][] = [];
  const realEmit = session.emitWorkspaceUpdatesForWorkspaceIds.bind(session);
  session.emitWorkspaceUpdatesForWorkspaceIds = async (ids: string[], ...rest: unknown[]) => {
    unarchivedWorkspaceIds.push(ids);
    return realEmit(ids, ...rest);
  };

  await session.handleMessage({
    type: "refresh_agent_request",
    agentId,
    requestId: "req-refresh-recreate-worktree",
  });

  expect(workspaces.get(workspaceId)?.archivedAt).toBe("2026-03-10T00:00:00.000Z");
  expect(workspaces.get(workspaceId)?.workspaceId).toBe(workspaceId);
  expect(unarchivedWorkspaceIds).toEqual([]);
  expect(findByType(emitted, "rpc_error")).toBeUndefined();
});

test("refresh_agent_request does not inspect an archived worktree branch", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const session = createSessionForWorkspaceTests({
    onMessage: (message) => {
      if (isSessionOutboundMessage(message)) emitted.push(message);
    },
  });
  const projects = new Map<string, ReturnType<typeof createPersistedProjectRecord>>();
  const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>();

  const cwd = path.resolve("/tmp/paseo-deleted-worktree-fail");
  session.filesystem.isDirectory = async () => false;
  const workspaceId = "ws-deleted-worktree-fail";
  const agentId = "agent-deleted-worktree-fail";
  projects.set(
    cwd,
    createPersistedProjectRecord({
      projectId: cwd,
      rootPath: cwd,
      kind: "git",
      displayName: "worktree-project",
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
      kind: "worktree",
      branch: "feature/gone",
      displayName: "feature/gone",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-10T00:00:00.000Z",
      archivedAt: "2026-03-10T00:00:00.000Z",
    }),
  );

  const storedAgent: StoredAgentRecord = {
    ...makeStoredAgent({ id: agentId, cwd, updatedAt: "2026-03-10T00:00:00.000Z" }),
    workspaceId,
    archivedAt: "2026-03-10T00:00:00.000Z",
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

  session.agentStorage.get = async (id: string) => (id === agentId ? storedAgent : null);
  session.agentStorage.upsert = async () => {};

  const managed = makeManagedAgent({
    id: agentId,
    cwd,
    workspaceId,
    lifecycle: "idle",
    updatedAt: "2026-03-10T00:00:00.000Z",
  });
  session.agentManager.getAgent = () => managed;
  session.interruptAgentIfRunning = async () => undefined;
  session.agentManager.reloadAgentSession = async () => managed;
  session.agentManager.hydrateTimelineFromProvider = async () => undefined;
  session.agentManager.getTimeline = () => [];
  session.agentUpdates.forwardLiveAgent = async () => undefined;

  await session.handleMessage({
    type: "refresh_agent_request",
    agentId,
    requestId: "req-refresh-recreate-fail",
  });

  expect(workspaces.get(workspaceId)?.archivedAt).toBe("2026-03-10T00:00:00.000Z");
  expect(findByType(emitted, "rpc_error")).toBeUndefined();
});

function createRecreateWorktreeRepo(): { tempDir: string; repoDir: string } {
  const tempDir = realpathSync(mkdtempSync(path.join(tmpdir(), "paseo-recreate-worktree-")));
  const repoDir = path.join(tempDir, "repo");
  execFileSync("git", ["init", "-b", "main", repoDir], { stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@getpaseo.local"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  execFileSync("git", ["config", "user.name", "Paseo Test"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: repoDir, stdio: "pipe" });
  writeFileSync(path.join(repoDir, "README.md"), "main\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir, stdio: "pipe" });
  return { tempDir, repoDir };
}

test("legacy refresh_agent_request restores a real deleted worktree", async () => {
  const { tempDir, repoDir } = createRecreateWorktreeRepo();
  const branch = "feature/keep";
  execFileSync("git", ["branch", branch], { cwd: repoDir, stdio: "pipe" });

  const worktreesRoot = path.join(tempDir, "worktrees");
  const paseoHome = path.join(tempDir, "paseo-home");
  const created = await createWorktree({
    cwd: repoDir,
    worktreeSlug: "keep",
    source: { kind: "checkout-branch", branchName: branch },
    runSetup: false,
    paseoHome,
    worktreesRoot,
  });
  const worktreePath = realpathSync(created.worktreePath);
  // Simulate archive: drop the worktree dir but keep the branch.
  rmSync(worktreePath, { recursive: true, force: true });
  execFileSync("git", ["worktree", "prune"], { cwd: repoDir, stdio: "pipe" });
  expect(existsSync(worktreePath)).toBe(false);

  const emitted: SessionOutboundMessage[] = [];
  const session = createSessionForWorkspaceTests({
    appVersion: "0.1.104",
    paseoHome,
    worktreesRoot,
    onMessage: (message) => {
      if (isSessionOutboundMessage(message)) emitted.push(message);
    },
  });
  // Real directory probe so the missing worktree reads as gone and the repo root as present.
  session.filesystem.isDirectory = async (target: string) =>
    existsSync(target) && statSync(target).isDirectory();

  const projects = new Map<string, ReturnType<typeof createPersistedProjectRecord>>();
  const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>();
  const workspaceId = "ws-real-recreate";
  const agentId = "agent-real-recreate";
  const projectId = repoDir;
  projects.set(
    projectId,
    createPersistedProjectRecord({
      projectId,
      rootPath: repoDir,
      kind: "git",
      displayName: "worktree-project",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-10T00:00:00.000Z",
      archivedAt: "2026-03-10T00:00:00.000Z",
    }),
  );
  workspaces.set(
    workspaceId,
    createPersistedWorkspaceRecord({
      workspaceId,
      projectId,
      cwd: worktreePath,
      kind: "worktree",
      branch,
      displayName: branch,
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-10T00:00:00.000Z",
      archivedAt: "2026-03-10T00:00:00.000Z",
    }),
  );

  const storedAgent: StoredAgentRecord = {
    ...makeStoredAgent({ id: agentId, cwd: worktreePath, updatedAt: "2026-03-10T00:00:00.000Z" }),
    workspaceId,
    archivedAt: "2026-03-10T00:00:00.000Z",
  };

  session.projectRegistry.get = async (id: string) => projects.get(id) ?? null;
  session.projectRegistry.upsert = async (
    record: ReturnType<typeof createPersistedProjectRecord>,
  ) => {
    projects.set(record.projectId, record);
  };
  session.workspaceRegistry.get = async (id: string) => workspaces.get(id) ?? null;
  session.workspaceRegistry.upsert = async (
    record: ReturnType<typeof createPersistedWorkspaceRecord>,
  ) => {
    workspaces.set(record.workspaceId, record);
  };
  session.projectRegistry.list = async () => Array.from(projects.values());
  session.workspaceRegistry.list = async () => Array.from(workspaces.values());
  session.agentStorage.get = async (id: string) => (id === agentId ? storedAgent : null);
  session.agentStorage.upsert = async () => {};

  const managed = makeManagedAgent({
    id: agentId,
    cwd: worktreePath,
    workspaceId,
    lifecycle: "idle",
    updatedAt: "2026-03-10T00:00:00.000Z",
  });
  session.agentManager.getAgent = () => managed;
  session.interruptAgentIfRunning = async () => undefined;
  session.agentManager.reloadAgentSession = async () => managed;
  session.agentManager.hydrateTimelineFromProvider = async () => undefined;
  session.agentManager.getTimeline = () => [];
  session.agentUpdates.forwardLiveAgent = async () => undefined;

  await session.handleMessage({
    type: "refresh_agent_request",
    agentId,
    requestId: "req-refresh-real-recreate",
  });

  expect(findByType(emitted, "rpc_error")).toBeUndefined();
  expect(existsSync(worktreePath)).toBe(true);
  expect(workspaces.get(workspaceId)?.workspaceId).toBe(workspaceId);
  expect(workspaces.get(workspaceId)?.cwd).toBe(worktreePath);
  expect(workspaces.get(workspaceId)?.archivedAt).toBeNull();

  rmSync(tempDir, { recursive: true, force: true });
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

test("archive_workspace_request archives a worktree-kind workspace and removes the directory on last reference", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "session-worktree-kind-archive-"));
  const repoDir = path.join(tempDir, "repo");
  mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@getpaseo.local"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  execFileSync("git", ["config", "user.name", "Paseo Test"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "initial"], {
    cwd: repoDir,
    stdio: "pipe",
  });

  const paseoHome = path.join(tempDir, ".paseo");
  const worktree = await createWorktree({
    cwd: repoDir,
    worktreeSlug: "worktree-kind-archive",
    source: {
      kind: "branch-off",
      baseBranch: "main",
      branchName: "worktree-kind-archive",
    },
    runSetup: false,
    paseoHome,
  });

  const workspaceId = "ws-worktree-kind-archive";
  const projectId = "proj-worktree-kind-archive";
  const workspace = createPersistedWorkspaceRecord({
    workspaceId,
    projectId,
    cwd: worktree.worktreePath,
    kind: "worktree",
    displayName: "worktree-kind-archive",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const project = createPersistedProjectRecord({
    projectId,
    rootPath: repoDir,
    kind: "git",
    displayName: "repo",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });

  const emitted: SessionOutboundMessage[] = [];
  const session = createSessionForWorkspaceTests({
    workspaceGitService: createNoopWorkspaceGitService({
      getSnapshot: async (): Promise<WorkspaceGitRuntimeSnapshot> => ({
        cwd: worktree.worktreePath,
        git: {
          isGit: true,
          repoRoot: repoDir,
          mainRepoRoot: repoDir,
          currentBranch: "worktree-kind-archive",
          remoteUrl: null,
          isPaseoOwnedWorktree: true,
          isDirty: false,
          baseRef: null,
          aheadBehind: null,
          aheadOfOrigin: null,
          behindOfOrigin: null,
          hasRemote: false,
          diffStat: null,
        },
        forge: {
          featuresEnabled: false,
          pullRequest: null,
          error: null,
        },
      }),
    }),
  });
  session.paseoHome = paseoHome;
  session.emit = (message) => {
    if (isSessionOutboundMessage(message)) emitted.push(message);
  };
  session.workspaceRegistry.get = async () => workspace;
  session.workspaceRegistry.list = async () => [workspace];
  session.workspaceRegistry.archive = async (_id: string, archivedAt: string) => {
    workspace.archivedAt = archivedAt;
  };
  session.projectRegistry.list = async () => [project];

  try {
    await session.handleMessage({
      type: "archive_workspace_request",
      workspaceId,
      requestId: "req-worktree-kind-archive",
    });

    expect(workspace.archivedAt).toBeTruthy();
    expect(existsSync(worktree.worktreePath)).toBe(false);
    const response = emitted.find((message) => message.type === "archive_workspace_response") as
      | { payload: Record<string, unknown> }
      | undefined;
    expect(response?.payload.error).toBeNull();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
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
    statusEnteredAt: workspace.createdAt,
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

test("lists Git runtime for a checkout explicitly owned by a non-Git project", async () => {
  const session = createSessionForWorkspaceTests();
  const project = createPersistedProjectRecord({
    projectId: "proj-explicit-directory",
    rootPath: "/tmp/explicit-directory",
    kind: "non_git",
    displayName: "directory project",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-explicit-checkout",
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
  session.workspaceGitService.peekSnapshot = () => createWorkspaceRuntimeSnapshot(REPO_CWD);

  const descriptors = Array.from(
    (await session.buildWorkspaceDescriptorMap({ includeGitData: true })).values(),
  ) as Array<{ gitRuntime?: { currentBranch: string | null }; githubRuntime?: unknown }>;

  expect(descriptors[0]).toMatchObject({
    gitRuntime: { currentBranch: "main" },
    githubRuntime: expect.any(Object),
  });
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

  // 1. Empty workspace — no agents contribute. The workspace entered its
  // initial "done" bucket when it was created.
  {
    const { session, workspace } = setupSession();
    session.listAgentPayloads = async () => [];
    const descriptor = await buildDescriptor(session, workspace.workspaceId);
    expect(descriptor.status).toBe("done");
    expect(descriptor.statusEnteredAt).toBe(workspace.createdAt);
  }

  // Agents own the workspace by id; cwd is incidental.
  const owned = (input: Parameters<typeof makeAgent>[0]) =>
    makeAgent({ ...input, workspaceId: "ws-status-entered" });

  // 2. Single idle agent (derives to "done") — statusEnteredAt uses the
  // agent's updatedAt as a best-effort timestamp.
  {
    const { session, workspace } = setupSession();
    const updatedAt = "2026-05-12T09:30:00.000Z";
    session.listAgentPayloads = async () => [
      owned({
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
      owned({
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
      owned({
        id: "agent-done",
        cwd: workspace.cwd,
        status: "idle",
        updatedAt: doneUpdatedAt,
      }),
      owned({
        id: "agent-running",
        cwd: workspace.cwd,
        status: "running",
        updatedAt: runningUpdatedAt,
      }),
      owned({
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
      owned({
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
      owned({
        id: "agent-done-early",
        cwd: workspace.cwd,
        status: "idle",
        updatedAt: earlyUpdatedAt,
      }),
      owned({
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
      owned({
        id: "agent-done",
        cwd: workspace.cwd,
        status: "idle",
        updatedAt: doneUpdatedAt,
      }),
      owned({
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
      owned({
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
      owned({
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

test("same-cwd workspace descriptors compute agent status per workspaceId", async () => {
  const session = createSessionForWorkspaceTests();
  const project = createPersistedProjectRecord({
    projectId: "proj-same-cwd-status",
    rootPath: REPO_CWD,
    kind: "git",
    displayName: "repo",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const workspaceA = createPersistedWorkspaceRecord({
    workspaceId: "ws-same-cwd-a",
    projectId: project.projectId,
    cwd: REPO_CWD,
    kind: "local_checkout",
    displayName: "main",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const workspaceB = createPersistedWorkspaceRecord({
    workspaceId: "ws-same-cwd-b",
    projectId: project.projectId,
    cwd: REPO_CWD,
    kind: "local_checkout",
    displayName: "second view",
    createdAt: "2026-03-01T12:00:01.000Z",
    updatedAt: "2026-03-01T12:00:01.000Z",
  });
  session.projectRegistry.list = async () => [project];
  session.workspaceRegistry.list = async () => [workspaceA, workspaceB];

  // A running agent owned by A leaves the sibling B done — status is per id.
  session.listAgentPayloads = async () => [
    makeAgent({
      id: "agent-running-a",
      cwd: REPO_CWD,
      workspaceId: workspaceA.workspaceId,
      status: "running",
      updatedAt: "2026-05-12T10:00:00.000Z",
    }),
  ];
  const runningDescriptors = await session.buildWorkspaceDescriptorMap({ includeGitData: false });
  expect(runningDescriptors.get(workspaceA.workspaceId)?.status).toBe("running");
  expect(runningDescriptors.get(workspaceB.workspaceId)?.status).toBe("done");

  // An attention agent owned by B leaves the sibling A done.
  session.listAgentPayloads = async () => [
    makeAgent({
      id: "agent-attention-b",
      cwd: REPO_CWD,
      workspaceId: workspaceB.workspaceId,
      status: "idle",
      updatedAt: "2026-05-12T11:00:00.000Z",
      requiresAttention: true,
      attentionReason: "finished",
      attentionTimestamp: "2026-05-12T11:00:00.000Z",
    }),
  ];
  const attentionDescriptors = await session.buildWorkspaceDescriptorMap({ includeGitData: false });
  expect(attentionDescriptors.get(workspaceA.workspaceId)?.status).toBe("done");
  expect(attentionDescriptors.get(workspaceB.workspaceId)?.status).toBe("attention");
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
      workspaceId: workspace.workspaceId,
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
        workspaceId: workspace.workspaceId,
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

test("external workspace updates emit one deduplicated batch without reconciling", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const session = createSessionForWorkspaceTests();
  const project = createPersistedProjectRecord({
    projectId: "proj-observer-batch",
    rootPath: "/tmp/observer-batch",
    kind: "non_git",
    displayName: "observer-batch",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  });
  const main = createPersistedWorkspaceRecord({
    workspaceId: "ws-observer-main",
    projectId: project.projectId,
    cwd: "/tmp/observer-batch/main",
    kind: "directory",
    displayName: "main",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  });
  const feature = createPersistedWorkspaceRecord({
    workspaceId: "ws-observer-feature",
    projectId: project.projectId,
    cwd: "/tmp/observer-batch/feature",
    kind: "directory",
    displayName: "feature",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  });
  const snapshotReads = { projects: 0, workspaces: 0 };
  session.projectRegistry.list = async () => {
    snapshotReads.projects += 1;
    return [project];
  };
  session.workspaceRegistry.list = async () => {
    snapshotReads.workspaces += 1;
    return [main, feature];
  };
  session.listAgentPayloads = async () => [];
  session.workspaceUpdatesSubscription = {
    subscriptionId: "sub-observer-batch",
    filter: undefined,
    isBootstrapping: false,
    pendingUpdatesByWorkspaceId: new Map(),
    lastEmittedByWorkspaceId: new Map(),
  };
  session.onMessage = (message) => {
    if (isSessionOutboundMessage(message)) emitted.push(message);
  };

  await session.emitWorkspaceUpdatesForExternalWorkspaceIds(
    [main.workspaceId, feature.workspaceId, main.workspaceId],
    { skipReconcile: true },
  );

  expect(filterByType(emitted, "workspace_update")).toEqual([
    {
      type: "workspace_update",
      payload: {
        kind: "upsert",
        workspace: expect.objectContaining({
          id: main.workspaceId,
          projectId: project.projectId,
          workspaceDirectory: main.cwd,
          name: main.displayName,
        }),
      },
    },
    {
      type: "workspace_update",
      payload: {
        kind: "upsert",
        workspace: expect.objectContaining({
          id: feature.workspaceId,
          projectId: project.projectId,
          workspaceDirectory: feature.cwd,
          name: feature.displayName,
        }),
      },
    },
  ]);
  expect(snapshotReads).toEqual({ projects: 1, workspaces: 1 });
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
    forge: {
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
    forge: {
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

test("a workspace leaving a filtered subscription after bootstrap emits a removal", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const session = asTestSession(
    createSessionForWorkspaceTests({ onMessage: (message) => emitted.push(message) }),
  );
  const descriptor = {
    id: "ws-buffered",
    projectId: "proj-buffered",
    projectDisplayName: "repo",
    projectRootPath: REPO_CWD,
    workspaceDirectory: REPO_CWD,
    projectKind: "git" as const,
    workspaceKind: "local_checkout" as const,
    name: "repo work",
    status: "done" as const,
    activityAt: null,
    diffStat: null,
  };
  let currentDescriptor: typeof descriptor | null = descriptor;
  let finishListing: (result: ListFetchResult) => void = () => {};
  const listing = new Promise<ListFetchResult>((resolve) => {
    finishListing = resolve;
  });
  session.listFetchWorkspacesEntries = async () => listing;
  session.buildWorkspaceDescriptorMap = async () =>
    new Map(currentDescriptor ? [[currentDescriptor.id, currentDescriptor]] : []);
  session.reconcileAndEmitWorkspaceUpdates = async () => undefined;

  const bootstrap = session.handleMessage({
    type: "fetch_workspaces_request",
    requestId: "req-buffered-filter",
    filter: { query: "repo" },
    subscribe: { subscriptionId: "sub-buffered-filter" },
  });
  await session.emitWorkspaceUpdatesForWorkspaceIds([descriptor.id], { skipReconcile: true });
  finishListing({
    entries: [],
    emptyProjects: [],
    pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
  });
  await bootstrap;

  expect(filterByType(emitted, "workspace_update")).toEqual([
    { type: "workspace_update", payload: { kind: "upsert", workspace: descriptor } },
  ]);

  emitted.length = 0;
  currentDescriptor = { ...descriptor, name: "other work" };
  await session.emitWorkspaceUpdatesForWorkspaceIds([descriptor.id], { skipReconcile: true });

  expect(filterByType(emitted, "workspace_update")).toEqual([
    {
      type: "workspace_update",
      payload: { kind: "remove", id: descriptor.id },
    },
  ]);
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
  session.workspaceRegistry.update = async (id, updater) => {
    const existing = workspaces.get(id);
    if (!existing) return null;
    const updated = updater(existing);
    workspaces.set(id, updated);
    return updated;
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

test("workspace.pin.set.request stores the pin timestamp and emits an updated descriptor", async () => {
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
  const workspaces = new Map([[workspace.workspaceId, workspace]]);
  session.projectRegistry.get = async (id: string) => (id === project.projectId ? project : null);
  session.projectRegistry.list = async () => [project];
  session.workspaceRegistry.list = async () => Array.from(workspaces.values());
  session.workspaceRegistry.update = async (id, updater) => {
    const existing = workspaces.get(id);
    if (!existing) return null;
    const updated = updater(existing);
    workspaces.set(id, updated);
    return updated;
  };
  session.workspaceUpdatesSubscription = {
    subscriptionId: "sub-workspaces",
    filter: {},
    isBootstrapping: false,
    lastEmittedByWorkspaceId: new Map(),
    pendingUpdatesByWorkspaceId: new Map(),
  };

  await session.handleMessage({
    type: "workspace.pin.set.request",
    workspaceId: workspace.workspaceId,
    pinned: true,
    requestId: "req-pin-1",
  });

  const response = findByType(emitted, "workspace.pin.set.response");
  expect(response?.payload).toMatchObject({
    requestId: "req-pin-1",
    workspaceId: "ws-1",
    accepted: true,
    error: null,
  });
  expect(response?.payload.pinnedAt).toEqual(expect.any(String));
  expect(workspaces.get("ws-1")?.pinnedAt).toBe(response?.payload.pinnedAt);
  expect(findByType(emitted, "workspace_update")?.payload).toMatchObject({
    kind: "upsert",
    workspace: {
      id: "ws-1",
      pinnedAt: response?.payload.pinnedAt,
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
  session.workspaceRegistry.update = async (id, updater) => {
    const existing = workspaces.get(id);
    if (!existing) return null;
    const updated = updater(existing);
    workspaces.set(id, updated);
    return updated;
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
  session.workspaceRegistry.update = async () => null;

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

function createSessionWithTerminalManager(options: {
  workspaces: PersistedWorkspaceRecord[];
  projects: PersistedProjectRecord[];
  onMessage?: (message: SessionOutboundMessage) => void;
}): { session: TestSession; terminalManager: TerminalManager } {
  const terminalManager = createTerminalManager();
  terminalManagers.push(terminalManager);

  const projectRegistry: SessionOptions["projectRegistry"] = {
    initialize: async () => {},
    existsOnDisk: async () => true,
    list: async () => options.projects,
    get: async (projectId: string) =>
      options.projects.find((project) => project.projectId === projectId) ?? null,
    upsert: async () => {},
    archive: async () => {},
    remove: async () => {},
  };

  const workspaceRegistry: SessionOptions["workspaceRegistry"] = {
    initialize: async () => {},
    existsOnDisk: async () => true,
    list: async () => options.workspaces,
    get: async (workspaceId: string) =>
      options.workspaces.find((workspace) => workspace.workspaceId === workspaceId) ?? null,
    upsert: async () => {},
    archive: async () => {},
    remove: async () => {},
  };

  const session = createSessionForWorkspaceTests({
    onMessage: options.onMessage,
    terminalManager,
    projectRegistry,
    workspaceRegistry,
  });

  session.workspaceUpdatesSubscription = {
    subscriptionId: "sub-workspaces",
    filter: undefined,
    isBootstrapping: false,
    lastEmittedByWorkspaceId: new Map(),
    pendingUpdatesByWorkspaceId: new Map(),
  };

  return { session, terminalManager };
}

async function flushTerminalContributionWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForWorkspaceUpdate(
  emitted: SessionOutboundMessage[],
  predicate: (message: Extract<SessionOutboundMessage, { type: "workspace_update" }>) => boolean,
  description: string,
): Promise<Extract<SessionOutboundMessage, { type: "workspace_update" }>> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1000) {
    const match = filterByType(emitted, "workspace_update").find(predicate);
    if (match) {
      return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for workspace_update: ${description}`);
}

test("title-only terminal change does not build workspace descriptors or emit workspace_update", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-session-title-"));
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-title",
    projectId: "proj-title",
    cwd,
    kind: "directory",
    displayName: "title-workspace",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const project = createPersistedProjectRecord({
    projectId: "proj-title",
    rootPath: cwd,
    kind: "non_git",
    displayName: "title-project",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const { session, terminalManager } = createSessionWithTerminalManager({
    workspaces: [workspace],
    projects: [project],
    onMessage: (message) => emitted.push(message),
  });
  const buildDescriptorMapSpy = vi.fn(
    async () => new Map([[workspace.workspaceId, expect.any(Object)]]),
  );
  session.buildWorkspaceDescriptorMap = buildDescriptorMapSpy;
  const listAgentPayloadsSpy = vi.fn(async () => []);
  session.listAgentPayloads = listAgentPayloadsSpy;

  const terminal = await terminalManager.createTerminal({
    cwd,
    workspaceId: workspace.workspaceId,
  });
  terminalManager.setTerminalTitle(terminal.id, "New title");
  await flushTerminalContributionWork();

  expect(buildDescriptorMapSpy).not.toHaveBeenCalled();
  expect(listAgentPayloadsSpy).not.toHaveBeenCalled();
  expect(filterByType(emitted, "workspace_update")).toHaveLength(0);
});

test("terminal activity contribution change updates the correct workspace", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-session-activity-"));
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-activity",
    projectId: "proj-activity",
    cwd,
    kind: "directory",
    displayName: "activity-workspace",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const project = createPersistedProjectRecord({
    projectId: "proj-activity",
    rootPath: cwd,
    kind: "non_git",
    displayName: "activity-project",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const { terminalManager } = createSessionWithTerminalManager({
    workspaces: [workspace],
    projects: [project],
    onMessage: (message) => emitted.push(message),
  });

  const terminal = await terminalManager.createTerminal({
    cwd,
    workspaceId: workspace.workspaceId,
  });
  await terminalManager.setTerminalActivity(terminal.id, "working");

  const update = await waitForWorkspaceUpdate(
    emitted,
    (message) =>
      message.payload.kind === "upsert" &&
      message.payload.workspace.id === workspace.workspaceId &&
      message.payload.workspace.status === "running",
    "terminal activity marks the owning workspace running",
  );
  expect(update.payload).toMatchObject({
    kind: "upsert",
    workspace: {
      id: workspace.workspaceId,
      status: "running",
    },
  });
});

test("same-cwd terminal activity updates only the workspace that owns the terminal", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-session-same-cwd-"));
  const workspaceA = createPersistedWorkspaceRecord({
    workspaceId: "ws-same-a",
    projectId: "proj-same",
    cwd,
    kind: "directory",
    displayName: "workspace-a",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const workspaceB = createPersistedWorkspaceRecord({
    workspaceId: "ws-same-b",
    projectId: "proj-same",
    cwd,
    kind: "directory",
    displayName: "workspace-b",
    createdAt: "2026-03-01T12:00:01.000Z",
    updatedAt: "2026-03-01T12:00:01.000Z",
  });
  const project = createPersistedProjectRecord({
    projectId: "proj-same",
    rootPath: cwd,
    kind: "non_git",
    displayName: "same-project",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const { terminalManager } = createSessionWithTerminalManager({
    workspaces: [workspaceA, workspaceB],
    projects: [project],
    onMessage: (message) => emitted.push(message),
  });

  const terminal = await terminalManager.createTerminal({
    cwd,
    workspaceId: workspaceB.workspaceId,
  });
  await terminalManager.setTerminalActivity(terminal.id, "working");
  await waitForWorkspaceUpdate(
    emitted,
    (message) =>
      message.payload.kind === "upsert" &&
      message.payload.workspace.id === workspaceB.workspaceId &&
      message.payload.workspace.status === "running",
    "same-cwd terminal activity updates the workspace that owns the terminal",
  );

  // The sibling A does not own the terminal, so its status is never driven to
  // running by it. Status is per workspaceId, not per cwd.
  const updates = filterByType(emitted, "workspace_update");
  const siblingRunning = updates.some(
    (update) =>
      update.payload.kind === "upsert" &&
      update.payload.workspace.id === workspaceA.workspaceId &&
      update.payload.workspace.status === "running",
  );
  expect(siblingRunning).toBe(false);
});

test("a worktree terminal updates only the workspace that owns it", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const rootCwd = mkdtempSync(path.join(tmpdir(), "paseo-session-nested-"));
  const worktreeCwd = path.join(rootCwd, "worktree");
  const terminalCwd = path.join(worktreeCwd, "subdir");
  mkdirSync(terminalCwd, { recursive: true });
  const workspaceRoot = createPersistedWorkspaceRecord({
    workspaceId: "ws-root",
    projectId: "proj-nested",
    cwd: rootCwd,
    kind: "local_checkout",
    displayName: "root",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const workspaceWorktree = createPersistedWorkspaceRecord({
    workspaceId: "ws-worktree",
    projectId: "proj-nested",
    cwd: worktreeCwd,
    kind: "worktree",
    displayName: "worktree",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const project = createPersistedProjectRecord({
    projectId: "proj-nested",
    rootPath: rootCwd,
    kind: "git",
    displayName: "nested-project",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const { terminalManager } = createSessionWithTerminalManager({
    workspaces: [workspaceRoot, workspaceWorktree],
    projects: [project],
    onMessage: (message) => emitted.push(message),
  });

  // The terminal is stamped with the worktree workspace at creation. Its cwd is
  // a subdirectory, but ownership is the workspaceId, so only the worktree
  // workspace (never the enclosing root) reflects the activity.
  const terminal = await terminalManager.createTerminal({
    cwd: terminalCwd,
    workspaceId: workspaceWorktree.workspaceId,
  });
  await terminalManager.setTerminalActivity(terminal.id, "working");
  await waitForWorkspaceUpdate(
    emitted,
    (message) =>
      message.payload.kind === "upsert" &&
      message.payload.workspace.id === workspaceWorktree.workspaceId &&
      message.payload.workspace.status === "running",
    "worktree terminal activity targets its owning workspace",
  );

  const updates = filterByType(emitted, "workspace_update");
  const rootRunning = updates.some(
    (update) =>
      update.payload.kind === "upsert" &&
      update.payload.workspace.id === workspaceRoot.workspaceId &&
      update.payload.workspace.status === "running",
  );
  expect(rootRunning).toBe(false);
});

test("removing an idle terminal does not update workspace status", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-session-remove-idle-"));
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-remove-idle",
    projectId: "proj-remove-idle",
    cwd,
    kind: "directory",
    displayName: "remove-idle-workspace",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const project = createPersistedProjectRecord({
    projectId: "proj-remove-idle",
    rootPath: cwd,
    kind: "non_git",
    displayName: "remove-idle-project",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const { session, terminalManager } = createSessionWithTerminalManager({
    workspaces: [workspace],
    projects: [project],
    onMessage: (message) => emitted.push(message),
  });
  const buildDescriptorMapSpy = vi.fn(async () => new Map());
  session.buildWorkspaceDescriptorMap = buildDescriptorMapSpy;

  const terminal = await terminalManager.createTerminal({
    cwd,
    workspaceId: workspace.workspaceId,
  });
  terminalManager.killTerminal(terminal.id);
  await flushTerminalContributionWork();

  expect(buildDescriptorMapSpy).not.toHaveBeenCalled();
  expect(filterByType(emitted, "workspace_update")).toHaveLength(0);
});

test("removing a contributing terminal clears workspace status", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-session-remove-contrib-"));
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-remove-contrib",
    projectId: "proj-remove-contrib",
    cwd,
    kind: "directory",
    displayName: "remove-contrib-workspace",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const project = createPersistedProjectRecord({
    projectId: "proj-remove-contrib",
    rootPath: cwd,
    kind: "non_git",
    displayName: "remove-contrib-project",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const { terminalManager } = createSessionWithTerminalManager({
    workspaces: [workspace],
    projects: [project],
    onMessage: (message) => emitted.push(message),
  });

  const terminal = await terminalManager.createTerminal({
    cwd,
    workspaceId: workspace.workspaceId,
  });
  await terminalManager.setTerminalActivity(terminal.id, "working");
  await waitForWorkspaceUpdate(
    emitted,
    (message) =>
      message.payload.kind === "upsert" &&
      message.payload.workspace.id === workspace.workspaceId &&
      message.payload.workspace.status === "running",
    "contributing terminal enters running state",
  );
  emitted.length = 0;

  terminalManager.killTerminal(terminal.id);

  const update = await waitForWorkspaceUpdate(
    emitted,
    (message) =>
      message.payload.kind === "upsert" &&
      message.payload.workspace.id === workspace.workspaceId &&
      message.payload.workspace.status === "done",
    "removing a contributing terminal clears workspace status",
  );
  expect(update.payload).toMatchObject({
    kind: "upsert",
    workspace: {
      id: workspace.workspaceId,
      status: "done",
    },
  });
});

interface WorkspaceCreatePrRepoFixture {
  tempDir: string;
  repoDir: string;
  paseoHome: string;
  headRef: string;
  prFileName: string;
  prNumber: number;
}

function createWorkspaceCreatePrRepo(): WorkspaceCreatePrRepoFixture {
  const tempDir = realpathSync(mkdtempSync(path.join(tmpdir(), "workspace-create-pr-")));
  const repoDir = path.join(tempDir, "repo");
  const remoteDir = path.join(tempDir, "origin.git");
  const paseoHome = path.join(tempDir, ".paseo");
  const prNumber = 123;
  const headRef = "feature/review-pr";
  const prFileName = "pr-123.txt";

  execFileSync("git", ["init", "-b", "main", repoDir], { stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@getpaseo.local"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  execFileSync("git", ["config", "user.name", "Paseo Test"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: repoDir, stdio: "pipe" });
  writeFileSync(path.join(repoDir, "README.md"), "main\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir, stdio: "pipe" });

  execFileSync("git", ["checkout", "-b", headRef], { cwd: repoDir, stdio: "pipe" });
  writeFileSync(path.join(repoDir, prFileName), "review branch\n");
  execFileSync("git", ["add", prFileName], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "review branch"], { cwd: repoDir, stdio: "pipe" });
  const prHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, stdio: "pipe" })
    .toString()
    .trim();

  execFileSync("git", ["clone", "--bare", repoDir, remoteDir], { stdio: "pipe" });
  execFileSync(
    "git",
    [`--git-dir=${remoteDir}`, "update-ref", `refs/pull/${prNumber}/head`, prHead],
    {
      stdio: "pipe",
    },
  );
  execFileSync("git", [`--git-dir=${remoteDir}`, "update-ref", "-d", `refs/heads/${headRef}`], {
    stdio: "pipe",
  });
  execFileSync("git", ["checkout", "main"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["branch", "-D", headRef], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir, stdio: "pipe" });

  return { tempDir, repoDir, paseoHome, headRef, prFileName, prNumber };
}

function createPrCheckoutGitHubService(params: { headRef: string }): ForgeService {
  return {
    listPullRequests: async () => [],
    listIssues: async () => [],
    getPullRequest: async ({ number }) => ({
      number,
      title: `PR ${number}`,
      url: `https://github.com/acme/repo/pull/${number}`,
      state: "OPEN",
      body: null,
      baseRefName: "main",
      headRefName: params.headRef,
      labels: [],
      updatedAt: "2026-03-01T12:00:00Z",
    }),
    getPullRequestHeadRef: async () => params.headRef,
    getPullRequestCheckoutTarget: async ({ number }) => ({
      number,
      baseRefName: "main",
      headRefName: params.headRef,
      headOwnerLogin: null,
      headRepositorySshUrl: null,
      headRepositoryUrl: null,
      isCrossRepository: false,
    }),
    defaultCheckoutRefs: ({ changeRequestNumber }) => [
      { remoteName: "origin", remoteRef: `refs/pull/${changeRequestNumber}/head` },
    ],
    buildPrLocalBranchName: ({ headRef }) => headRef,
    getCurrentPullRequestStatus: async () => null,
    getPullRequestTimeline: async ({ prNumber }) => ({
      prNumber,
      repoOwner: "acme",
      repoName: "repo",
      items: [],
      truncated: false,
      error: null,
    }),
    getCheckDetails: async ({ checkRunId, workflowRunId }) => ({
      checkRunId,
      workflowRunId: workflowRunId ?? null,
      name: "test",
      status: null,
      conclusion: null,
      url: null,
      detailsUrl: null,
      output: null,
      annotations: [],
      failedJobs: [],
      truncated: false,
    }),
    searchIssuesAndPrs: async () => ({
      items: [],
      featuresEnabled: true,
      githubFeaturesEnabled: true,
    }),
    createPullRequest: async () => ({ number: 1, url: "https://github.com/acme/repo/pull/1" }),
    mergePullRequest: async () => ({ success: true }),
    enablePullRequestAutoMerge: async () => ({ success: true }),
    disablePullRequestAutoMerge: async () => ({ success: true }),
    isAuthenticated: async () => true,
    invalidate: () => {},
  };
}

function readCurrentBranch(cwd: string): string {
  return execFileSync("git", ["branch", "--show-current"], { cwd, stdio: "pipe" })
    .toString()
    .trim();
}

test("workspace.create worktree source checks out a GitHub PR from githubPrNumber", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const fixture = createWorkspaceCreatePrRepo();
  const projects = new Map<string, PersistedProjectRecord>();
  const workspaces = new Map<string, PersistedWorkspaceRecord>();
  const projectRegistry: SessionOptions["projectRegistry"] = {
    initialize: async () => {},
    existsOnDisk: async () => true,
    list: async () => Array.from(projects.values()),
    get: async (projectId: string) => projects.get(projectId) ?? null,
    getOrCreateActiveByRoot: async (allocation) => {
      const project = createPersistedProjectRecord({
        projectId: "prj_worktreefixture",
        rootPath: allocation.rootPath,
        kind: allocation.kind,
        displayName: allocation.displayName,
        createdAt: allocation.timestamp,
        updatedAt: allocation.timestamp,
      });
      projects.set(project.projectId, project);
      return project;
    },
    upsert: async (record) => {
      projects.set(record.projectId, record);
    },
    archive: async () => {},
    remove: async () => {},
  };
  const workspaceRegistry: SessionOptions["workspaceRegistry"] = {
    initialize: async () => {},
    existsOnDisk: async () => true,
    list: async () => Array.from(workspaces.values()),
    get: async (workspaceId: string) => workspaces.get(workspaceId) ?? null,
    upsert: async (record) => {
      workspaces.set(record.workspaceId, record);
    },
    archive: async () => {},
    remove: async () => {},
  };
  const session = createSessionForWorkspaceTests({
    onMessage: (message) => emitted.push(message),
    github: createPrCheckoutGitHubService({
      headRef: fixture.headRef,
    }),
    paseoHome: fixture.paseoHome,
    projectRegistry,
    workspaceRegistry,
    workspaceGitService: createNoopWorkspaceGitService({
      resolveRepoRoot: async () => fixture.repoDir,
      resolveDefaultBranch: async () => "main",
    }),
  });

  try {
    await session.handleMessage({
      type: "workspace.create.request",
      requestId: "req-workspace-create-pr",
      source: {
        kind: "worktree",
        cwd: fixture.repoDir,
        action: "checkout",
        githubPrNumber: fixture.prNumber,
        worktreeSlug: "review-pr-workspace",
      },
    });

    const response = findByType(emitted, "workspace.create.response");
    expect(response?.payload.error).toBeNull();
    expect(response?.payload.workspace).toMatchObject({
      workspaceDirectory: expect.any(String),
      gitRuntime: { currentBranch: fixture.headRef },
    });
    const workspaceDirectory = response?.payload.workspace?.workspaceDirectory as string;
    expect(readCurrentBranch(workspaceDirectory)).toBe(fixture.headRef);
    expect(existsSync(path.join(workspaceDirectory, fixture.prFileName))).toBe(true);
  } finally {
    await flushTerminalContributionWork();
    rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});

// Worktree-source forwarding for action/refName/worktreeSlug is also covered
// end-to-end against a daemon in workspace-create-worktree-source.e2e.test.ts.

test("failed local create_agent_request does not schedule workspace title generation", async () => {
  vi.useFakeTimers();
  const emitted: SessionOutboundMessage[] = [];
  let generateCalls = 0;
  const session = createSessionForWorkspaceTests({
    onMessage: (message) => emitted.push(message),
    generateWorkspaceName: async () => {
      generateCalls += 1;
      return { title: "Should Not Be Written", branch: null };
    },
  });

  try {
    await session.handleMessage({
      type: "create_agent_request",
      requestId: "req-failed-local-title",
      workspaceId: "ws-repo-running",
      config: { provider: "codex", cwd: REPO_CWD },
      initialPrompt: "This create will fail before an agent exists",
      attachments: [],
    });
    await vi.runAllTimersAsync();

    expect(findByType(emitted, "status")?.payload).toMatchObject({
      status: "agent_create_failed",
      requestId: "req-failed-local-title",
    });
    expect(generateCalls).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("workspace auto-name keeps a manual title written before the scheduled title lands", async () => {
  vi.useFakeTimers();
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-manual-title",
    projectId: "proj-manual-title",
    cwd: REPO_CWD,
    kind: "directory",
    displayName: "repo",
    title: "Fix login bug",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const stored = new Map([[workspace.workspaceId, workspace]]);
  const emittedWorkspaceIds: string[] = [];
  const workspaceAutoName = new WorkspaceAutoName({
    agentManager: asAgentManager({}),
    workspaceRegistry: {
      get: async (workspaceId) => stored.get(workspaceId) ?? null,
      upsert: async (record) => {
        stored.set(record.workspaceId, record);
      },
    },
    workspaceGitService: createNoopWorkspaceGitService(),
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
    readDaemonConfig: () => ({ metadataGeneration: { providers: [] } }),
    gitMutation: { notifyGitMutation: async () => {} },
    emitWorkspaceUpdateForCwd: async () => {},
    emitWorkspaceUpdateForWorkspaceId: async (workspaceId) => {
      emittedWorkspaceIds.push(workspaceId);
    },
    logger: asSessionLogger(createTestLogger()),
    generateWorkspaceName: async () => ({ title: "Generated login fix", branch: null }),
  });

  try {
    workspaceAutoName.scheduleForDirectory({
      workspaceId: workspace.workspaceId,
      cwd: workspace.cwd,
      firstAgentContext: { prompt: "Fix login bug" },
    });
    stored.set(workspace.workspaceId, {
      ...workspace,
      title: "User rename",
      updatedAt: "2026-03-01T12:01:00.000Z",
    });
    await vi.runAllTimersAsync();

    expect(stored.get(workspace.workspaceId)?.title).toBe("User rename");
    expect(emittedWorkspaceIds).toEqual([workspace.workspaceId]);
  } finally {
    vi.useRealTimers();
  }
});

test("workspace auto-name replaces the unchanged prompt title", async () => {
  vi.useFakeTimers();
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-prompt-title",
    projectId: "proj-prompt-title",
    cwd: REPO_CWD,
    kind: "directory",
    displayName: "repo",
    title: "Fix login bug",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const stored = new Map([[workspace.workspaceId, workspace]]);
  const workspaceAutoName = new WorkspaceAutoName({
    agentManager: asAgentManager({}),
    workspaceRegistry: {
      get: async (workspaceId) => stored.get(workspaceId) ?? null,
      upsert: async (record) => {
        stored.set(record.workspaceId, record);
      },
    },
    workspaceGitService: createNoopWorkspaceGitService(),
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
    readDaemonConfig: () => ({ metadataGeneration: { providers: [] } }),
    gitMutation: { notifyGitMutation: async () => {} },
    emitWorkspaceUpdateForCwd: async () => {},
    emitWorkspaceUpdateForWorkspaceId: async () => {},
    logger: asSessionLogger(createTestLogger()),
    generateWorkspaceName: async () => ({ title: "Generated login fix", branch: null }),
  });

  try {
    workspaceAutoName.scheduleForDirectory({
      workspaceId: workspace.workspaceId,
      cwd: workspace.cwd,
      firstAgentContext: { prompt: "Fix login bug" },
    });
    await vi.runAllTimersAsync();

    expect(stored.get(workspace.workspaceId)?.title).toBe("Generated login fix");
  } finally {
    vi.useRealTimers();
  }
});

test("workspace auto-name uses the backing root for a nested worktree", async () => {
  vi.useFakeTimers();
  const tempDir = realpathSync(mkdtempSync(path.join(tmpdir(), "workspace-auto-name-rejected-")));
  const repoDir = path.join(tempDir, "repo");
  mkdirSync(repoDir);
  execFileSync("git", ["init", repoDir], { stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@getpaseo.local"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  execFileSync("git", ["config", "user.name", "Paseo Test"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: repoDir, stdio: "pipe" });
  writeFileSync(path.join(repoDir, "README.md"), "hello\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["branch", "-M", "placeholder-branch"], { cwd: repoDir, stdio: "pipe" });
  writePaseoWorktreeMetadata(repoDir, { baseRefName: "main" });
  writePaseoWorktreeFirstAgentBranchAutoNameMetadata(repoDir, {
    placeholderBranchName: "placeholder-branch",
  });
  const workspaceCwd = path.join(repoDir, "packages", "app");
  mkdirSync(workspaceCwd, { recursive: true });

  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-rejected-branch-title",
    projectId: "proj-rejected-branch-title",
    cwd: workspaceCwd,
    kind: "worktree",
    displayName: "Fix checkout title",
    title: "Fix checkout title",
    branch: "placeholder-branch",
    worktreeRoot: repoDir,
    isPaseoOwnedWorktree: true,
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  const stored = new Map([[workspace.workspaceId, workspace]]);
  let generateCalls = 0;
  const gitMutations: string[] = [];
  const emittedCwds: string[] = [];
  const workspaceAutoName = new WorkspaceAutoName({
    agentManager: asAgentManager({}),
    workspaceRegistry: {
      get: async (workspaceId) => stored.get(workspaceId) ?? null,
      upsert: async (record) => {
        stored.set(record.workspaceId, record);
      },
    },
    workspaceGitService: createNoopWorkspaceGitService(),
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
    readDaemonConfig: () => ({ metadataGeneration: { providers: [] } }),
    gitMutation: {
      notifyGitMutation: async (_cwd, reason) => {
        gitMutations.push(reason);
      },
    },
    emitWorkspaceUpdateForCwd: async (cwd) => {
      emittedCwds.push(cwd);
    },
    emitWorkspaceUpdateForWorkspaceId: async () => {},
    logger: asSessionLogger(createTestLogger()),
    generateWorkspaceName: async () => {
      generateCalls += 1;
      return { title: "Generated Invalid Branch Title", branch: "Invalid Branch Name" };
    },
  });

  try {
    workspaceAutoName.scheduleForWorktree({
      workspace,
      firstAgentContext: { prompt: "Fix checkout title" },
    });
    await vi.runAllTimersAsync();

    expect(generateCalls).toBe(1);
    expect(stored.get(workspace.workspaceId)).toMatchObject({
      title: "Generated Invalid Branch Title",
      branch: "placeholder-branch",
    });
    expect(
      execFileSync("git", ["branch", "--show-current"], { cwd: repoDir, stdio: "pipe" })
        .toString()
        .trim(),
    ).toBe("placeholder-branch");
    expect(readPaseoWorktreeMetadata(repoDir)).toMatchObject({
      version: 2,
      firstAgentBranchAutoName: {
        status: "attempted",
        placeholderBranchName: "placeholder-branch",
      },
    });
    expect(gitMutations).toEqual([]);
    expect(emittedCwds).toEqual([workspaceCwd]);
  } finally {
    vi.useRealTimers();
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// Phase 7: branch is a git fact derived per-descriptor from each workspace's own
// live git snapshot, and reconciliation re-persists `branch` per workspace from
// its own cwd. handleCheckoutRenameBranchRequest renames the git branch and
// re-emits, but performs NO denormalized cwd → ids branch write of its own — it
// never resolves which workspaces share the cwd to rewrite a cached branch.
test("checkout.rename_branch.request renames the branch without a denormalized branch write", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const renameCalls: Array<{ cwd: string; newName: string }> = [];
  const session = createSessionForWorkspaceTests({
    onMessage: (message) => emitted.push(message),
    renameCurrentBranch: async (cwd: string, newName: string) => {
      renameCalls.push({ cwd, newName });
      return { previousBranch: "feature/old-name", currentBranch: newName };
    },
  });

  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-worktree-rename",
    projectId: "proj-rename",
    cwd: REPO_CWD,
    kind: "worktree",
    displayName: "Refactor auth flow",
    branch: "feature/old-name",
    title: "Refactor auth flow",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });

  const workspaces = new Map([[workspace.workspaceId, workspace]]);
  const upsertedRecords: Array<typeof workspace> = [];
  session.workspaceRegistry.list = async () => Array.from(workspaces.values());
  session.workspaceRegistry.get = async (id: string) => workspaces.get(id) ?? null;
  session.workspaceRegistry.upsert = async (record: unknown) => {
    const parsed = record as typeof workspace;
    upsertedRecords.push(parsed);
    workspaces.set(parsed.workspaceId, parsed);
  };

  await session.handleMessage({
    type: "checkout.rename_branch.request",
    cwd: REPO_CWD,
    branch: "feature/new-name",
    requestId: "req-rename-k3",
  });

  expect(renameCalls).toEqual([{ cwd: REPO_CWD, newName: "feature/new-name" }]);

  const response = findByType(emitted, "checkout.rename_branch.response");
  expect(response?.payload).toMatchObject({
    success: true,
    currentBranch: "feature/new-name",
    requestId: "req-rename-k3",
  });

  // Phase 7: the handler performs no denormalized branch write of its own; the
  // record is left for per-descriptor derivation and reconciliation to update.
  expect(upsertedRecords).toEqual([]);
  const persisted = workspaces.get(workspace.workspaceId);
  expect(persisted?.displayName).toBe("Refactor auth flow");
  expect(persisted?.title).toBe("Refactor auth flow");
});

test("workspace.create.response persists the first prompt as the initial title", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>();
  const session = createSessionForWorkspaceTests({
    onMessage: (message) => emitted.push(message),
    workspaceRegistry: {
      initialize: async () => {},
      existsOnDisk: async () => true,
      list: async () => Array.from(workspaces.values()),
      get: async (workspaceId: string) => workspaces.get(workspaceId) ?? null,
      upsert: async (workspace) => {
        workspaces.set(workspace.workspaceId, workspace);
      },
      archive: async () => {},
      remove: async () => {},
    },
  });
  session.listAgentPayloads = async () => [];

  await session.handleMessage({
    type: "workspace.create.request",
    requestId: "req-create-first-prompt",
    source: { kind: "directory", path: REPO_CWD },
    firstAgentContext: {
      prompt: "Add retries to the payments flow\nwith exponential backoff",
    },
  });

  const response = findByType(emitted, "workspace.create.response");
  expect(response?.payload.error).toBeNull();
  expect(response?.payload.workspace?.title).toBe("Add retries to the payments flow");
  expect(response?.payload.workspace?.name).toBe("Add retries to the payments flow");

  const workspaceId = response?.payload.workspace?.id;
  expect(workspaceId).toBeDefined();
  const persisted = await session.workspaceRegistry.get(workspaceId as string);
  expect(persisted?.title).toBe("Add retries to the payments flow");
  expect(filterByType(emitted, "workspace_update")).toHaveLength(1);
});

test("workspace create emits through a matching workspace subscription", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>();
  const session = createSessionForWorkspaceTests({
    onMessage: (message) => emitted.push(message),
    workspaceRegistry: {
      initialize: async () => {},
      existsOnDisk: async () => true,
      list: async () => Array.from(workspaces.values()),
      get: async (workspaceId) => workspaces.get(workspaceId) ?? null,
      upsert: async (workspace) => {
        workspaces.set(workspace.workspaceId, workspace);
      },
      archive: async () => {},
      remove: async () => {},
    },
  });
  session.listAgentPayloads = async () => [];

  await session.handleMessage({
    type: "fetch_workspaces_request",
    requestId: "req-subscribe-create-match",
    filter: { query: "repo" },
    subscribe: { subscriptionId: "sub-create-match" },
  });
  emitted.length = 0;
  await session.handleMessage({
    type: "workspace.create.request",
    requestId: "req-create-match",
    source: { kind: "directory", path: REPO_CWD },
  });

  expect(filterByType(emitted, "workspace_update")).toHaveLength(1);
});

test("workspace create stays out of a non-matching workspace subscription", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>();
  const session = createSessionForWorkspaceTests({
    onMessage: (message) => emitted.push(message),
    workspaceRegistry: {
      initialize: async () => {},
      existsOnDisk: async () => true,
      list: async () => Array.from(workspaces.values()),
      get: async (workspaceId) => workspaces.get(workspaceId) ?? null,
      upsert: async (workspace) => {
        workspaces.set(workspace.workspaceId, workspace);
      },
      archive: async () => {},
      remove: async () => {},
    },
  });
  session.listAgentPayloads = async () => [];

  await session.handleMessage({
    type: "fetch_workspaces_request",
    requestId: "req-subscribe-create-filtered",
    filter: { query: "definitely-not-this-workspace" },
    subscribe: { subscriptionId: "sub-create-filtered" },
  });
  emitted.length = 0;
  await session.handleMessage({
    type: "workspace.create.request",
    requestId: "req-create-filtered",
    source: { kind: "directory", path: REPO_CWD },
  });

  expect(filterByType(emitted, "workspace_update")).toEqual([]);
});

test("workspace.create.request attaches a directory workspace to its explicit active project", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const projects = new Map([
    [
      "prj_explicit",
      createPersistedProjectRecord({
        projectId: "prj_explicit",
        rootPath: path.join(REPO_CWD, "unrelated"),
        kind: "non_git",
        displayName: "unrelated",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    ],
  ]);
  const workspaces = new Map<string, PersistedWorkspaceRecord>();
  const session = createSessionForWorkspaceTests({ onMessage: (message) => emitted.push(message) });
  session.projectRegistry.get = async (projectId: string) => projects.get(projectId) ?? null;
  session.workspaceRegistry.upsert = async (record: unknown) => {
    const workspace = record as PersistedWorkspaceRecord;
    workspaces.set(workspace.workspaceId, workspace);
  };
  session.workspaceRegistry.get = async (workspaceId: string) =>
    workspaces.get(workspaceId) ?? null;

  await session.handleMessage({
    type: "workspace.create.request",
    requestId: "req-explicit-project",
    source: { kind: "directory", path: REPO_CWD, projectId: "prj_explicit" },
  });

  const response = findByType(emitted, "workspace.create.response");
  expect(response?.payload).toMatchObject({
    requestId: "req-explicit-project",
    error: null,
    workspace: { projectId: "prj_explicit" },
  });
  const workspaceId = response?.payload.workspace?.id;
  expect(workspaceId).toEqual(expect.any(String));
  expect(workspaces.get(workspaceId as string)).toMatchObject({
    cwd: REPO_CWD,
    projectId: "prj_explicit",
  });
});

test("workspace.create.request reports an unknown explicit project", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const session = createSessionForWorkspaceTests({ onMessage: (message) => emitted.push(message) });

  await session.handleMessage({
    type: "workspace.create.request",
    requestId: "req-unknown-project",
    source: { kind: "directory", path: REPO_CWD, projectId: "prj_missing" },
  });

  expect(findByType(emitted, "workspace.create.response")?.payload).toMatchObject({
    requestId: "req-unknown-project",
    workspace: null,
    errorCode: "unknown_project",
  });
});

test("workspace.create.request reports an archived explicit project", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const archivedProject = createPersistedProjectRecord({
    projectId: "prj_archived",
    rootPath: path.join(REPO_CWD, "unrelated"),
    kind: "non_git",
    displayName: "unrelated",
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    archivedAt: "2026-03-02T00:00:00.000Z",
  });
  const session = createSessionForWorkspaceTests({ onMessage: (message) => emitted.push(message) });
  session.projectRegistry.get = async (projectId: string) =>
    projectId === archivedProject.projectId ? archivedProject : null;

  await session.handleMessage({
    type: "workspace.create.request",
    requestId: "req-archived-project",
    source: { kind: "directory", path: REPO_CWD, projectId: "prj_archived" },
  });

  expect(findByType(emitted, "workspace.create.response")?.payload).toMatchObject({
    requestId: "req-archived-project",
    workspace: null,
    errorCode: "archived_project",
  });
});
