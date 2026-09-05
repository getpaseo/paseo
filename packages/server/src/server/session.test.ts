import { execSync } from "child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, resolve as resolvePath } from "path";
import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { PluginCallerAuthority } from "@getpaseo/plugin";
import {
  assertPullRequestAutoMergeDisableReady,
  assertPullRequestAutoMergeEnableReady,
} from "../services/github-service.js";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { CLIENT_CAPS } from "@getpaseo/protocol/client-capabilities";
import {
  WSSessionOutboundSchema,
  wrapSessionMessage,
  type WorkspaceDescriptorPayload,
} from "@getpaseo/protocol/messages";
import { MAX_DELIVERY_RESPONSE_BYTES } from "@getpaseo/protocol/transport-limits";
import { MAX_PLUGIN_HOST_DELIVERY_GET_RESPONSE_BYTES } from "@getpaseo/protocol/plugin-host";
import {
  decodeFileTransferFrame,
  encodeFileTransferFrame,
  FileTransferOpcode,
  type FileTransferFrame,
} from "@getpaseo/protocol/binary-frames/index";
import { Session } from "./session.js";
import { DeliveryLedger } from "./deliveries/delivery-ledger.js";
import { OWNER_PERMISSIONS, type DaemonPermission } from "./authorization/index.js";
import { DownloadTokenStore } from "./file-download/token-store.js";
import { StructuredAgentFallbackError } from "./agent/agent-response-loop.js";
import type { StoredAgentRecord } from "./agent/agent-storage.js";
import type { AgentManagerEvent } from "./agent/agent-manager.js";
import type { ProviderSnapshotManager } from "./agent/provider-snapshot-manager.js";
import { WorkspaceLabelError, type WorkspaceLabelService } from "./workspace-labels/index.js";
import { createPersistedProjectRecord } from "./workspace-registry.js";
import { deriveProjectKey } from "./project-key.js";
import type { SessionOptions } from "./session.js";
import type { SessionInboundMessage, SessionOutboundMessage } from "./messages.js";
import {
  asSessionInternals as asSessionInternalsHelper,
  asAgentManager,
  asAgentStorage,
  asDownloadTokenStore,
  asPushNotifications,
  asScheduleService,
  asCheckoutDiffManager,
  asGitHubService,
  asWorkspaceGitService,
  asDaemonConfigStore,
  createProviderSnapshotManagerStub,
} from "./test-utils/session-stubs.js";
import { isPlatform } from "../test-utils/platform.js";
import {
  GitHubAuthenticationError,
  GitHubCliMissingError,
  GitHubCommandError,
  type GitHubService,
} from "../services/github-service.js";
import type { CheckDetails, ForgeService } from "../services/forge-service.js";
import type { GitHubPullRequestStatusFacts } from "../services/github-facts.js";

interface SessionHandlerInternals {
  interruptAgentIfRunning(agentId: string): Promise<void>;
  handleSendAgentMessage(
    agentId: string,
    text: string,
    messageId?: string,
    images?: Array<{ data: string; mimeType: string }>,
    attachments?: unknown[],
    runOptions?: unknown,
    options?: { spokenInput?: boolean },
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  handleCheckoutMergeRequest(params: unknown): Promise<unknown>;
  handleCheckoutMergeFromBaseRequest(params: unknown): Promise<unknown>;
  handleCheckoutCommitRequest(params: unknown): Promise<unknown>;
  handleCheckoutPrCreateRequest(params: unknown): Promise<unknown>;
  handleCheckoutPrMergeRequest(params: unknown): Promise<unknown>;
  handleCheckoutForgeSetAutoMergeRequest(params: unknown): Promise<unknown>;
  handleCheckoutPullRequest(params: unknown): Promise<unknown>;
  handleCheckoutPushRequest(params: unknown): Promise<unknown>;
  handleCheckoutRefreshRequest(params: unknown): Promise<unknown>;
  handleCheckoutStatusRequest(params: unknown): Promise<unknown>;
  describeWorkspaceRecord(...args: unknown[]): Promise<WorkspaceDescriptorPayload>;
  describeWorkspaceRecordWithGitData(...args: unknown[]): Promise<WorkspaceDescriptorPayload>;
  handleValidateBranchRequest(params: unknown): Promise<unknown>;
  handleCheckoutSwitchBranchRequest(params: unknown): Promise<unknown>;
  handleBranchSuggestionsRequest(params: unknown): Promise<unknown>;
  handleStashListRequest(params: unknown): Promise<unknown>;
  handleStashSaveRequest(params: unknown): Promise<unknown>;
  handleStashPopRequest(params: unknown): Promise<unknown>;
  createPaseoWorktree(params: unknown): Promise<unknown>;
  createPaseoWorktreeWorkflow(params: unknown): Promise<unknown>;
  buildPluginWorkspaceSnapshot(workspace: unknown, agent: unknown): Promise<unknown>;
  archivePluginManagedWorktree(worktree: unknown): Promise<unknown>;
  persistPluginManagedWorktrees(signal?: AbortSignal): Promise<void>;
  agentUpdates: { forwardLiveAgent(agent: unknown): Promise<void> };
  handleStartWorkspaceScriptRequest(params: unknown): Promise<unknown>;
}

function asSessionInternals(session: Session): SessionHandlerInternals {
  return asSessionInternalsHelper<SessionHandlerInternals>(session);
}

function createBinaryMessageHandler(
  binaryMessages: Uint8Array[] | undefined,
): ((frame: Uint8Array) => void) | undefined {
  if (!binaryMessages) {
    return undefined;
  }
  return (frame) => {
    binaryMessages.push(frame);
  };
}

test("interruptAgentIfRunning rejects when graceful cancellation is refused", async () => {
  const agentId = "11111111-1111-4111-8111-111111111111";
  const session = createSessionForTest({
    agentManager: {
      getAgent: vi.fn(() => ({ id: agentId, provider: "codex", lifecycle: "running" })),
      hasInFlightRun: vi.fn(() => true),
      cancelAgentRun: vi.fn(async () => ({ status: "refused" as const })),
    },
  });

  await expect(asSessionInternals(session).interruptAgentIfRunning(agentId)).rejects.toThrow(
    "active run cancellation was not acknowledged",
  );
});

test("cancel_agent_request reports refusal only through its response", async () => {
  const agentId = "11111111-1111-4111-8111-111111111111";
  const messages: SessionOutboundMessage[] = [];
  const getAgent = vi
    .fn()
    .mockReturnValueOnce({ id: agentId, provider: "codex", lifecycle: "running" })
    .mockReturnValue(null);
  const session = createSessionForTest({
    messages,
    agentManager: {
      getAgent,
      hasInFlightRun: vi.fn(() => true),
      cancelAgentRun: vi.fn(async () => ({ status: "refused" as const })),
    },
  });

  await session.handleMessage({
    type: "cancel_agent_request",
    agentId,
    requestId: "cancel-refused",
  });

  expect(messages).toEqual([
    {
      type: "cancel_agent_response",
      payload: {
        requestId: "cancel-refused",
        agentId,
        agent: null,
        error:
          "Cannot stop agent 11111111-1111-4111-8111-111111111111 because its active run cancellation was not acknowledged",
      },
    },
  ]);
});

test("cancel_agent_request returns stale_turn and the authoritative snapshot", async () => {
  const agentId = "11111111-1111-4111-8111-111111111111";
  const messages: SessionOutboundMessage[] = [];
  const snapshot = { id: agentId, provider: "codex", lifecycle: "running" as const };
  const getAgent = vi.fn().mockReturnValueOnce(snapshot).mockReturnValueOnce(null);
  const cancelAgentRun = vi.fn(async (_agentId: string, expectedTurnId?: string) => {
    expect(expectedTurnId).toBe("old-turn");
    return { status: "stale_turn" as const };
  });
  const session = createSessionForTest({
    messages,
    agentManager: {
      getAgent,
      hasInFlightRun: vi.fn(() => true),
      cancelAgentRun,
    },
  });

  await session.handleMessage({
    type: "cancel_agent_request",
    agentId,
    requestId: "cancel-stale",
    expectedTurnId: "old-turn",
  });

  expect(cancelAgentRun).toHaveBeenCalledWith(agentId, "old-turn");
  expect(messages).toEqual([
    {
      type: "cancel_agent_response",
      payload: {
        requestId: "cancel-stale",
        agentId,
        agent: null,
        status: "stale_turn",
        error: null,
      },
    },
  ]);
});

test("legacy cancel_agent_request reports refusal through the activity log", async () => {
  const agentId = "11111111-1111-4111-8111-111111111111";
  const messages: SessionOutboundMessage[] = [];
  const session = createSessionForTest({
    messages,
    agentManager: {
      getAgent: vi.fn(() => ({ id: agentId, provider: "codex", lifecycle: "running" })),
      hasInFlightRun: vi.fn(() => true),
      cancelAgentRun: vi.fn(async () => ({ status: "refused" as const })),
    },
  });

  await session.handleMessage({ type: "cancel_agent_request", agentId });

  expect(messages).toEqual([
    {
      type: "activity_log",
      payload: {
        id: expect.any(String),
        timestamp: expect.any(Date),
        type: "error",
        content:
          "Failed to cancel running agent on request: Cannot stop agent 11111111-1111-4111-8111-111111111111 because its active run cancellation was not acknowledged",
      },
    },
  ]);
});

const checkoutGitMocks = vi.hoisted(() => ({
  checkoutResolvedBranch: vi.fn(),
  commitChanges: vi.fn(),
  createPullRequest: vi.fn(),
  getCachedCheckoutShortstat: vi.fn(),
  getCheckoutStatus: vi.fn(),
  listBranchSuggestions: vi.fn(),
  mergeFromBase: vi.fn(),
  mergeToBase: vi.fn(),
  pullCurrentBranch: vi.fn(),
  pushCurrentBranch: vi.fn(),
  renameCurrentBranch: vi.fn(),
  resolveBranchCheckout: vi.fn(),
  warmCheckoutShortstatInBackground: vi.fn(),
}));

const agentResponseMocks = vi.hoisted(() => ({
  generateStructuredAgentResponseWithFallback: vi.fn(),
}));

const spawnMocks = vi.hoisted(() => ({
  spawnWorkspaceScript: vi.fn(),
}));

const gitCommandMocks = vi.hoisted(() => ({
  runGitCommand: vi.fn(),
}));

const paseoWorktreeServiceMocks = vi.hoisted(() => ({
  createPaseoWorktree: vi.fn(),
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

vi.mock("../utils/checkout-git.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/checkout-git.js")>();
  return {
    ...actual,
    checkoutResolvedBranch: checkoutGitMocks.checkoutResolvedBranch,
    commitChanges: checkoutGitMocks.commitChanges,
    createPullRequest: checkoutGitMocks.createPullRequest,
    getCachedCheckoutShortstat: checkoutGitMocks.getCachedCheckoutShortstat,
    getCheckoutStatus: checkoutGitMocks.getCheckoutStatus,
    listBranchSuggestions: checkoutGitMocks.listBranchSuggestions,
    mergeFromBase: checkoutGitMocks.mergeFromBase,
    mergeToBase: checkoutGitMocks.mergeToBase,
    pullCurrentBranch: checkoutGitMocks.pullCurrentBranch,
    pushCurrentBranch: checkoutGitMocks.pushCurrentBranch,
    renameCurrentBranch: checkoutGitMocks.renameCurrentBranch,
    resolveBranchCheckout: checkoutGitMocks.resolveBranchCheckout,
    warmCheckoutShortstatInBackground: checkoutGitMocks.warmCheckoutShortstatInBackground,
  };
});

vi.mock("./paseo-worktree-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./paseo-worktree-service.js")>();
  return {
    ...actual,
    createPaseoWorktree: paseoWorktreeServiceMocks.createPaseoWorktree,
  };
});

vi.mock("../utils/run-git-command.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/run-git-command.js")>();
  return {
    ...actual,
    runGitCommand: gitCommandMocks.runGitCommand,
  };
});

vi.mock("./agent/agent-response-loop.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent/agent-response-loop.js")>();
  return {
    ...actual,
    generateStructuredAgentResponseWithFallback:
      agentResponseMocks.generateStructuredAgentResponseWithFallback,
  };
});

vi.mock("./worktree-bootstrap.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./worktree-bootstrap.js")>();
  return {
    ...actual,
    spawnWorkspaceScript: spawnMocks.spawnWorkspaceScript,
  };
});

interface SessionForTestOptions {
  permissions?: readonly DaemonPermission[];
  agentManager?: { [K in keyof SessionOptions["agentManager"]]?: unknown };
  agentStorage?: { [K in keyof SessionOptions["agentStorage"]]?: unknown };
  github?: Partial<ForgeService & GitHubService>;
  checkoutDiffManager?: { scheduleRefreshForCwd: ReturnType<typeof vi.fn> };
  workspaceGitService?: {
    getCheckout?: ReturnType<typeof vi.fn>;
    getCheckoutDiff?: ReturnType<typeof vi.fn>;
    getSnapshot?: ReturnType<typeof vi.fn>;
    suggestBranchesForCwd?: ReturnType<typeof vi.fn>;
    listStashes?: ReturnType<typeof vi.fn>;
    peekSnapshot?: ReturnType<typeof vi.fn>;
    validateBranchRef?: ReturnType<typeof vi.fn>;
    hasLocalBranch?: ReturnType<typeof vi.fn>;
    resolveRepoRemoteUrl?: ReturnType<typeof vi.fn>;
    resolveRepoRoot?: ReturnType<typeof vi.fn>;
    resolveForge?: ReturnType<typeof vi.fn>;
    getWorkspaceGitMetadata?: ReturnType<typeof vi.fn>;
    getProjectSlug?: ReturnType<typeof vi.fn>;
  };
  workspaceRegistry?: { get: ReturnType<typeof vi.fn> };
  projectRegistry?: Partial<SessionOptions["projectRegistry"]>;
  terminalManager?: SessionOptions["terminalManager"];
  serviceProxy?: SessionOptions["serviceProxy"];
  scriptRuntimeStore?: SessionOptions["scriptRuntimeStore"];
  getDaemonTcpPort?: () => number | null;
  getDaemonTcpHost?: () => string | null;
  providerSnapshotManager?: ProviderSnapshotManager;
  hubExecutionAgents?: SessionOptions["hubExecutionAgents"];
  stt?: SessionOptions["stt"];
  voice?: SessionOptions["voice"];
  paseoHome?: string;
  serverId?: SessionOptions["serverId"];
  daemonVersion?: SessionOptions["daemonVersion"];
  daemonRuntimeConfig?: SessionOptions["daemonRuntimeConfig"];
  downloadTokenStore?: SessionOptions["downloadTokenStore"];
  pushNotifications?: SessionOptions["pushNotifications"];
  messages?: unknown[];
  targetedMessages?: Array<{ source: object; message: SessionOutboundMessage }>;
  binaryMessages?: Uint8Array[];
  pluginRuntime?: SessionOptions["pluginRuntime"];
  orchestrationSkills?: SessionOptions["orchestrationSkills"];
  workspaceLabelService?: WorkspaceLabelService;
  principalId?: string;
  pluginIdentity?: SessionOptions["pluginIdentity"];
  resourcePermissions?: SessionOptions["resourcePermissions"];
  clientCapabilities?: Record<string, unknown>;
  deliveryLedger?: DeliveryLedger;
  deliveryDispatchCoordinator?: SessionOptions["deliveryDispatchCoordinator"];
  deliveryAgentDispatcher?: SessionOptions["deliveryAgentDispatcher"];
}

function createSessionForTest(options: SessionForTestOptions = {}): Session {
  const logger = pino({ level: "silent" });
  const github = options.github ?? {
    invalidate: vi.fn(),
    searchIssuesAndPrs: vi.fn(),
    createPullRequest: vi.fn(),
    mergePullRequest: vi.fn(),
  };
  const checkoutDiffManager = options.checkoutDiffManager ?? {
    scheduleRefreshForCwd: vi.fn(),
  };
  const workspaceGitService = {
    getCheckout: vi.fn(),
    getCheckoutDiff: vi.fn(),
    getSnapshot: vi.fn(),
    suggestBranchesForCwd: vi.fn(),
    listStashes: vi.fn(),
    peekSnapshot: vi.fn(),
    validateBranchRef: vi.fn(),
    hasLocalBranch: vi.fn(),
    resolveRepoRemoteUrl: vi.fn(),
    resolveRepoRoot: vi.fn(),
    getWorkspaceGitMetadata: vi.fn(),
    resolveForge: vi.fn().mockResolvedValue({ forge: "github", service: github }),
    // Mirror production: invalidateForge resolves the forge and busts the
    // adapter's cache. The resolved forge here is github, so delegate to it.
    invalidateForge: vi.fn((cwd: string) => github.invalidate({ cwd })),
    getProjectSlug: vi.fn(),
    ...options.workspaceGitService,
  };
  const messages = options.messages ?? [];

  const sessionOptions: SessionOptions = {
    clientId: "test-client",
    principalId: options.principalId,
    pluginIdentity: options.pluginIdentity,
    resourcePermissions: options.resourcePermissions,
    clientCapabilities: options.clientCapabilities,
    onMessage: (message) => messages.push(message),
    ...(options.targetedMessages
      ? {
          onMessageToSource: (source: object, message: SessionOutboundMessage) =>
            options.targetedMessages?.push({ source, message }),
        }
      : {}),
    onBinaryMessage: createBinaryMessageHandler(options.binaryMessages),
    logger,
    downloadTokenStore: options.downloadTokenStore ?? asDownloadTokenStore(),
    pushNotifications: options.pushNotifications ?? asPushNotifications(),
    paseoHome: options.paseoHome ?? "/tmp/paseo-home",
    agentManager: asAgentManager({
      listAgents: vi.fn(() => []),
      listProviderSubagentActivity: vi.fn(() => []),
      subscribe: vi.fn(() => () => {}),
      ...options.agentManager,
    }),
    agentStorage: asAgentStorage({
      get: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      ...options.agentStorage,
    }),
    deliveryLedger: options.deliveryLedger,
    deliveryDispatchCoordinator: options.deliveryDispatchCoordinator,
    deliveryAgentDispatcher: options.deliveryAgentDispatcher,
    projectRegistry: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
      getOrCreateActiveByRoot: vi.fn(),
      upsert: vi.fn(),
      archive: vi.fn(),
      remove: vi.fn(),
      initialize: vi.fn(),
      existsOnDisk: vi.fn(),
      ...options.projectRegistry,
    },
    workspaceRegistry: options.workspaceRegistry ?? {
      get: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
    },
    workspaceLabelService: options.workspaceLabelService,
    scheduleService: asScheduleService(),
    checkoutDiffManager: asCheckoutDiffManager(checkoutDiffManager),
    github: asGitHubService(github),
    workspaceGitService: asWorkspaceGitService(workspaceGitService),
    daemonConfigStore: asDaemonConfigStore({
      get: vi.fn(() => ({
        mcp: { injectIntoAgents: false },
        providers: {},
      })),
      onChange: vi.fn(() => () => {}),
    }),
    pluginRuntime: options.pluginRuntime,
    orchestrationSkills: options.orchestrationSkills,
    stt: options.stt ?? null,
    tts: null,
    terminalManager: options.terminalManager ?? null,
    providerSnapshotManager:
      options.providerSnapshotManager ?? createProviderSnapshotManagerStub().manager,
    hubExecutionAgents: options.hubExecutionAgents,
    serviceProxy: options.serviceProxy,
    scriptRuntimeStore: options.scriptRuntimeStore,
    getDaemonTcpPort: options.getDaemonTcpPort,
    getDaemonTcpHost: options.getDaemonTcpHost,
    voice: options.voice,
    serverId: options.serverId,
    daemonVersion: options.daemonVersion,
    daemonRuntimeConfig: options.daemonRuntimeConfig,
    permissions: options.permissions ?? OWNER_PERMISSIONS,
  };
  return new Session(sessionOptions);
}

function createPluginCallerAuthority(): PluginCallerAuthority {
  return {
    callerAgentId: "caller-agent",
    agent: {
      id: "caller-agent",
      workspaceId: "source-workspace",
      provider: "codex",
      status: "idle",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      lastActivityAt: "2026-01-01T00:00:00.000Z",
      title: "Caller",
      cwd: "/repo",
      model: "caller-model",
      currentModeId: "default",
      thinkingOptionId: "caller-thinking",
      requiresAttention: false,
      attentionReason: null,
      parentAgentId: null,
      labels: {},
    },
    workspace: {
      id: "source-workspace",
      projectId: "source-project",
      projectDisplayName: "source-project",
      projectRootPath: "/repo",
      directory: "/repo",
      projectKind: "git",
      kind: "local_checkout",
      name: "Source",
      title: null,
      status: "done",
      statusEnteredAt: "2026-01-01T00:00:00.000Z",
      archivingAt: null,
      diffStat: null,
    },
    effective: {
      provider: { known: true, value: "codex" },
      model: { known: true, value: "caller-model" },
      thinking: { known: true, value: "caller-thinking" },
      providerSessionId: { known: false },
    },
    securityCeiling: {
      filesystem: "unknown",
      network: "unknown",
      approvals: "unknown",
      unattended: "unknown",
    },
  };
}

function createLivePluginCaller(): Record<string, unknown> {
  return {
    id: "caller-agent",
    provider: "codex",
    cwd: "/repo",
    workspaceId: "source-workspace",
    lifecycle: "idle",
    config: {
      provider: "codex",
      cwd: "/repo",
      model: "caller-model",
      thinkingOptionId: "caller-thinking",
      modeId: "default",
      providerOptions: {
        sandbox_mode: "read-only",
        network_access: false,
        approval_policy: "never",
      },
      toolPolicy: {
        preapproved: [{ kind: "mcp", server: "review", tool: "read" }],
      },
    },
    runtimeInfo: undefined,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    availableModes: [],
    features: [],
    currentModeId: "default",
    pendingPermissions: new Map(),
    bufferedPermissionResolutions: new Map(),
    inFlightPermissionResponses: new Set(),
    pendingReplacement: false,
    persistence: null,
    historyPrimed: true,
    lastUserMessageAt: null,
    activeTurnId: null,
    activeTurnStartedAt: null,
    attention: { requiresAttention: false },
    foregroundTurnWaiters: new Set(),
    finalizedForegroundTurnIds: new Set(),
    unsubscribeSession: null,
    labels: {},
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: false,
    },
  };
}

test("plugin host inherits child authority from the freshly resolved live caller", async () => {
  const caller = createPluginCallerAuthority();
  const liveCaller = createLivePluginCaller();
  const child = {
    id: "child-agent",
    provider: "codex",
    cwd: "/repo",
    workspaceId: "source-workspace",
    lifecycle: "idle",
    config: {
      provider: "codex",
      cwd: "/repo",
      model: "caller-model",
      thinkingOptionId: "caller-thinking",
    },
    runtimeInfo: undefined,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    availableModes: [],
    features: [],
    currentModeId: null,
    pendingPermissions: new Map(),
    bufferedPermissionResolutions: new Map(),
    inFlightPermissionResponses: new Set(),
    pendingReplacement: false,
    persistence: null,
    historyPrimed: true,
    lastUserMessageAt: null,
    activeTurnId: null,
    activeTurnStartedAt: null,
    attention: { requiresAttention: false },
    foregroundTurnWaiters: new Set(),
    finalizedForegroundTurnIds: new Set(),
    unsubscribeSession: null,
    labels: { "paseo.parentAgentId": "caller-agent" },
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: false,
    },
  };
  const createAgent = vi.fn(async () => child);
  const session = createSessionForTest({
    pluginIdentity: { pluginId: "portable-provider", installationId: "installation-one" },
    agentManager: {
      getAgent: vi.fn(() => liveCaller),
      createAgent,
    },
    workspaceRegistry: {
      get: vi.fn(async () => ({
        workspaceId: "source-workspace",
        projectId: "source-project",
        cwd: "/repo",
        archivedAt: null,
      })),
      list: vi.fn().mockResolvedValue([]),
    },
    projectRegistry: {
      get: vi.fn(async () => ({ projectId: "source-project", archivedAt: null })),
    },
  });
  const internals = asSessionInternals(session);
  internals.agentUpdates.forwardLiveAgent = vi.fn(async () => undefined);

  try {
    const result = await session.invokePluginHost({
      pluginId: "portable-provider",
      caller,
      invocationId: "invocation-one",
      generation: 1,
      installationId: "installation-one",
      capabilityNonce: "nonce-one",
      operation: "child.create",
      input: { options: { title: "Child" } },
      signal: new AbortController().signal,
    });

    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "codex",
        cwd: "/repo",
        model: "caller-model",
        thinkingOptionId: "caller-thinking",
        modeId: "default",
        providerOptions: {
          sandbox_mode: "read-only",
          network_access: false,
          approval_policy: "never",
        },
        toolPolicy: {
          preapproved: [{ kind: "mcp", server: "review", tool: "read" }],
        },
      }),
      undefined,
      expect.objectContaining({
        workspaceId: "source-workspace",
        labels: { "paseo.parentAgentId": "caller-agent" },
      }),
    );
    expect(result).toMatchObject({
      agentId: "child-agent",
      parentAgentId: "caller-agent",
      workspaceId: "source-workspace",
      cwd: "/repo",
    });

    await session.invokePluginHost({
      pluginId: "portable-provider",
      caller,
      invocationId: "invocation-forged-overrides",
      generation: 1,
      installationId: "installation-one",
      capabilityNonce: "nonce-forged-overrides",
      operation: "child.create",
      input: {
        options: {
          model: "attacker-model",
          thinking: "attacker-thinking",
          toolPolicy: "none",
          security: { filesystem: "unrestricted" },
        },
      },
      signal: new AbortController().signal,
    });
    expect(createAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        provider: "codex",
        model: "caller-model",
        thinkingOptionId: "caller-thinking",
        modeId: "default",
        providerOptions: {
          sandbox_mode: "read-only",
          network_access: false,
          approval_policy: "never",
        },
        toolPolicy: {
          preapproved: [{ kind: "mcp", server: "review", tool: "read" }],
        },
      }),
      undefined,
      expect.objectContaining({ workspaceId: "source-workspace" }),
    );
    expect(createAgent).toHaveBeenCalledTimes(2);
  } finally {
    await session.cleanup();
  }
});

test("plugin-managed worktrees are caller-scoped, opaque, and cleaned up on partial failure", async () => {
  const home = mkdtempSync(join(tmpdir(), "paseo-plugin-worktree-partial-"));
  const caller = createPluginCallerAuthority();
  const liveCaller = createLivePluginCaller();
  const workflowResult = {
    workspace: { workspaceId: "managed-workspace", cwd: "/managed-worktree" },
    worktree: { worktreePath: "/managed-worktree" },
    repoRoot: "/repo",
  };
  const createWorkflow = vi.fn(async () => workflowResult);
  const archiveWorktree = vi
    .fn()
    .mockResolvedValueOnce({ ok: true as const, message: "", removedDirectory: true })
    .mockResolvedValueOnce({ ok: true as const, message: "", removedDirectory: false });
  const workspaceSnapshot = {
    ...caller.workspace,
    id: "managed-workspace",
    directory: "/managed-worktree",
  };
  const session = createSessionForTest({
    paseoHome: home,
    pluginIdentity: { pluginId: "portable-provider", installationId: "installation-one" },
    agentManager: { getAgent: vi.fn(() => liveCaller) },
    workspaceRegistry: {
      get: vi.fn(async () => ({
        workspaceId: "source-workspace",
        projectId: "source-project",
        cwd: "/repo",
        archivedAt: null,
      })),
      list: vi.fn().mockResolvedValue([]),
    },
    projectRegistry: {
      get: vi.fn(async () => ({ projectId: "source-project", archivedAt: null })),
    },
  });
  const internals = asSessionInternals(session);
  internals.createPaseoWorktreeWorkflow = createWorkflow;
  internals.buildPluginWorkspaceSnapshot = vi.fn(async () => workspaceSnapshot);
  internals.archivePluginManagedWorktree = archiveWorktree;

  try {
    const created = (await session.invokePluginHost({
      pluginId: "portable-provider",
      caller,
      invocationId: "invocation-one",
      generation: 1,
      installationId: "installation-one",
      capabilityNonce: "nonce-one",
      operation: "worktree.create",
      input: { options: { name: "portable-child", branch: "portable-child" } },
      signal: new AbortController().signal,
    })) as { id: string; cwd: string; workspace: unknown };

    expect(createWorkflow).toHaveBeenCalledWith({
      cwd: "/repo",
      projectId: "source-project",
      worktreeSlug: "portable-child",
      branchName: "portable-child",
      runSetup: false,
    });
    expect(created).toMatchObject({
      id: expect.stringMatching(/^managed:/),
      cwd: "/managed-worktree",
    });
    expect(created.id).not.toContain("source-workspace");

    await session.invokePluginHost({
      pluginId: "portable-provider",
      caller,
      invocationId: "invocation-two",
      generation: 1,
      installationId: "installation-one",
      capabilityNonce: "nonce-two",
      operation: "worktree.remove",
      input: { id: created.id },
      signal: new AbortController().signal,
    });
    expect(archiveWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "portable-provider",
        installationId: "installation-one",
        callerAgentId: "caller-agent",
        workspaceId: "managed-workspace",
        cwd: "/managed-worktree",
        worktreePath: "/managed-worktree",
        repoRoot: "/repo",
      }),
    );

    const partialBuild = vi.fn(async (workspace: { workspaceId?: string }) => {
      if (workspace.workspaceId === "managed-workspace") {
        throw new Error("snapshot failed");
      }
      return workspaceSnapshot;
    });
    internals.buildPluginWorkspaceSnapshot = partialBuild;
    await expect(
      session.invokePluginHost({
        pluginId: "portable-provider",
        caller,
        invocationId: "invocation-three",
        generation: 1,
        installationId: "installation-one",
        capabilityNonce: "nonce-three",
        operation: "worktree.create",
        input: { options: { name: "partial" } },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("physical worktree removal was not confirmed");
    expect(archiveWorktree).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse(readFileSync(join(home, "plugin-managed-worktrees.json"), "utf8")).records,
    ).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^managed:/),
        worktreePath: "/managed-worktree",
      }),
    ]);
  } finally {
    await session.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test("reconciles stale plugin worktree ownership at installation startup", async () => {
  const home = mkdtempSync(join(tmpdir(), "paseo-plugin-worktree-reconcile-"));
  const stale = {
    pluginId: "portable-provider",
    installationId: "old-installation",
    callerAgentId: "caller-agent",
    workspaceId: "old-workspace",
    cwd: "/old-worktree",
    worktreePath: "/old-worktree",
    repoRoot: "/repo",
  };
  writeFileSync(
    join(home, "plugin-managed-worktrees.json"),
    JSON.stringify({ version: 1, records: [stale] }),
  );
  const session = createSessionForTest({
    paseoHome: home,
    principalId: "plugin:portable-provider:new-installation",
    pluginIdentity: { pluginId: "portable-provider", installationId: "new-installation" },
    agentManager: { getAgent: vi.fn(() => createLivePluginCaller()) },
    workspaceRegistry: {
      get: vi.fn(async () => ({
        workspaceId: "source-workspace",
        projectId: "source-project",
        cwd: "/repo",
        archivedAt: null,
      })),
      list: vi.fn().mockResolvedValue([]),
    },
    projectRegistry: {
      get: vi.fn(async () => ({ projectId: "source-project", archivedAt: null })),
    },
  });
  const internals = asSessionInternals(session);
  const archiveWorktree = vi.fn(async () => ({
    ok: true as const,
    message: "",
    removedDirectory: true,
  }));
  internals.archivePluginManagedWorktree = archiveWorktree;

  try {
    await session.invokePluginHost({
      pluginId: "portable-provider",
      caller: createPluginCallerAuthority(),
      invocationId: "reconcile-invocation",
      generation: 1,
      installationId: "new-installation",
      capabilityNonce: "reconcile-nonce",
      operation: "delivery.get",
      input: {},
      signal: new AbortController().signal,
    });
    expect(archiveWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        ...stale,
        id: expect.stringMatching(/^managed:legacy:/),
      }),
    );
    expect(JSON.parse(readFileSync(join(home, "plugin-managed-worktrees.json"), "utf8"))).toEqual({
      version: 1,
      records: [],
    });
  } finally {
    await session.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test("fails closed when plugin worktree ownership is malformed", async () => {
  const home = mkdtempSync(join(tmpdir(), "paseo-plugin-worktree-malformed-"));
  const ownershipPath = join(home, "plugin-managed-worktrees.json");
  writeFileSync(ownershipPath, "{malformed");
  const session = createSessionForTest({
    paseoHome: home,
    principalId: "plugin:portable-provider:installation-one",
    pluginIdentity: { pluginId: "portable-provider", installationId: "installation-one" },
    agentManager: { getAgent: vi.fn(() => createLivePluginCaller()) },
  });

  try {
    await expect(
      session.invokePluginHost({
        pluginId: "portable-provider",
        caller: createPluginCallerAuthority(),
        invocationId: "malformed-state",
        generation: 1,
        installationId: "installation-one",
        capabilityNonce: "malformed-nonce",
        operation: "delivery.get",
        input: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("state is unavailable");
    expect(readFileSync(ownershipPath, "utf8")).toBe("{malformed");
  } finally {
    await session.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test("preserves managed worktree ids across a plugin session reconnect", async () => {
  const home = mkdtempSync(join(tmpdir(), "paseo-plugin-worktree-reconnect-"));
  const caller = createPluginCallerAuthority();
  const liveCaller = createLivePluginCaller();
  const workflowResult = {
    workspace: { workspaceId: "managed-workspace", cwd: "/managed-worktree" },
    worktree: { worktreePath: "/managed-worktree" },
    repoRoot: "/repo",
  };
  const workspaceSnapshot = { ...caller.workspace, id: "managed-workspace" };
  const common = {
    paseoHome: home,
    pluginIdentity: { pluginId: "portable-provider", installationId: "installation-one" },
    agentManager: { getAgent: vi.fn(() => liveCaller) },
    workspaceRegistry: {
      get: vi.fn(async () => ({
        workspaceId: "source-workspace",
        projectId: "source-project",
        cwd: "/repo",
        archivedAt: null,
      })),
      list: vi.fn().mockResolvedValue([]),
    },
    projectRegistry: {
      get: vi.fn(async () => ({ projectId: "source-project", archivedAt: null })),
    },
  };
  const first = createSessionForTest(common);
  const firstInternals = asSessionInternals(first);
  firstInternals.createPaseoWorktreeWorkflow = vi.fn(async () => workflowResult);
  firstInternals.buildPluginWorkspaceSnapshot = vi.fn(async () => workspaceSnapshot);
  const archiveWorktree = vi.fn(async () => ({
    ok: true as const,
    message: "",
    removedDirectory: true,
  }));

  try {
    firstInternals.archivePluginManagedWorktree = archiveWorktree;
    const created = (await first.invokePluginHost({
      pluginId: "portable-provider",
      caller,
      invocationId: "reconnect-create",
      generation: 1,
      installationId: "installation-one",
      capabilityNonce: "reconnect-nonce",
      operation: "worktree.create",
      input: {},
      signal: new AbortController().signal,
    })) as { id: string };
    await first.cleanup();

    const second = createSessionForTest(common);
    const secondInternals = asSessionInternals(second);
    secondInternals.archivePluginManagedWorktree = archiveWorktree;
    try {
      await second.invokePluginHost({
        pluginId: "portable-provider",
        caller,
        invocationId: "reconnect-remove",
        generation: 1,
        installationId: "installation-one",
        capabilityNonce: "reconnect-remove-nonce",
        operation: "worktree.remove",
        input: { id: created.id },
        signal: new AbortController().signal,
      });
    } finally {
      await second.cleanup();
    }

    expect(archiveWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ id: created.id, worktreePath: "/managed-worktree" }),
    );
  } finally {
    await first.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test("commits plugin worktree removal after physical deletion despite cancellation", async () => {
  const home = mkdtempSync(join(tmpdir(), "paseo-plugin-worktree-remove-cancel-"));
  const caller = createPluginCallerAuthority();
  const liveCaller = createLivePluginCaller();
  const workflowResult = {
    workspace: { workspaceId: "managed-workspace", cwd: "/managed-worktree" },
    worktree: { worktreePath: "/managed-worktree" },
    repoRoot: "/repo",
  };
  const session = createSessionForTest({
    paseoHome: home,
    pluginIdentity: { pluginId: "portable-provider", installationId: "installation-one" },
    agentManager: { getAgent: vi.fn(() => liveCaller) },
    workspaceRegistry: {
      get: vi.fn(async () => ({
        workspaceId: "source-workspace",
        projectId: "source-project",
        cwd: "/repo",
        archivedAt: null,
      })),
      list: vi.fn().mockResolvedValue([]),
    },
    projectRegistry: {
      get: vi.fn(async () => ({ projectId: "source-project", archivedAt: null })),
    },
  });
  const internals = asSessionInternals(session);
  internals.createPaseoWorktreeWorkflow = vi.fn(async () => workflowResult);
  internals.buildPluginWorkspaceSnapshot = vi.fn(async () => ({
    ...caller.workspace,
    id: "managed-workspace",
    directory: "/managed-worktree",
  }));
  const removeController = new AbortController();
  const archiveWorktree = vi.fn(async () => {
    return { ok: true as const, message: "", removedDirectory: true };
  });
  internals.archivePluginManagedWorktree = archiveWorktree;

  try {
    const created = (await session.invokePluginHost({
      pluginId: "portable-provider",
      caller,
      invocationId: "remove-cancel-create",
      generation: 1,
      installationId: "installation-one",
      capabilityNonce: "remove-cancel-create-nonce",
      operation: "worktree.create",
      input: {},
      signal: new AbortController().signal,
    })) as { id: string };
    const persistPluginManagedWorktrees = internals.persistPluginManagedWorktrees.bind(session);
    internals.persistPluginManagedWorktrees = async () => {
      await persistPluginManagedWorktrees();
      removeController.abort(new Error("cancelled after ownership commit"));
    };

    await expect(
      session.invokePluginHost({
        pluginId: "portable-provider",
        caller,
        invocationId: "remove-cancel",
        generation: 1,
        installationId: "installation-one",
        capabilityNonce: "remove-cancel-nonce",
        operation: "worktree.remove",
        input: { id: created.id },
        signal: removeController.signal,
      }),
    ).resolves.toBeUndefined();

    expect(JSON.parse(readFileSync(join(home, "plugin-managed-worktrees.json"), "utf8"))).toEqual({
      version: 1,
      records: [],
    });
    expect(archiveWorktree).toHaveBeenCalledOnce();
  } finally {
    await session.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test("retains cancelled plugin worktree removal for a restart before physical deletion", async () => {
  const home = mkdtempSync(join(tmpdir(), "paseo-plugin-worktree-remove-restart-"));
  const caller = createPluginCallerAuthority();
  const liveCaller = createLivePluginCaller();
  const workflowResult = {
    workspace: { workspaceId: "managed-workspace", cwd: "/managed-worktree" },
    worktree: { worktreePath: "/managed-worktree" },
    repoRoot: "/repo",
  };
  const common = {
    paseoHome: home,
    pluginIdentity: { pluginId: "portable-provider", installationId: "installation-one" },
    agentManager: { getAgent: vi.fn(() => liveCaller) },
    workspaceRegistry: {
      get: vi.fn(async () => ({
        workspaceId: "source-workspace",
        projectId: "source-project",
        cwd: "/repo",
        archivedAt: null,
      })),
      list: vi.fn().mockResolvedValue([]),
    },
    projectRegistry: {
      get: vi.fn(async () => ({ projectId: "source-project", archivedAt: null })),
    },
  };
  const first = createSessionForTest(common);
  const firstInternals = asSessionInternals(first);
  firstInternals.createPaseoWorktreeWorkflow = vi.fn(async () => workflowResult);
  firstInternals.buildPluginWorkspaceSnapshot = vi.fn(async () => ({
    ...caller.workspace,
    id: "managed-workspace",
    directory: "/managed-worktree",
  }));
  const cancelled = new AbortController();
  cancelled.abort(new Error("cancelled before physical deletion"));
  const firstArchive = vi.fn(async () => ({
    ok: true as const,
    message: "",
    removedDirectory: true,
  }));
  firstInternals.archivePluginManagedWorktree = firstArchive;

  try {
    const created = (await first.invokePluginHost({
      pluginId: "portable-provider",
      caller,
      invocationId: "remove-restart-create",
      generation: 1,
      installationId: "installation-one",
      capabilityNonce: "remove-restart-create-nonce",
      operation: "worktree.create",
      input: {},
      signal: new AbortController().signal,
    })) as { id: string };

    await expect(
      first.invokePluginHost({
        pluginId: "portable-provider",
        caller,
        invocationId: "remove-restart-cancel",
        generation: 1,
        installationId: "installation-one",
        capabilityNonce: "remove-restart-cancel-nonce",
        operation: "worktree.remove",
        input: { id: created.id },
        signal: cancelled.signal,
      }),
    ).rejects.toThrow("cancelled before physical deletion");
    expect(firstArchive).not.toHaveBeenCalled();
    await first.cleanup();

    const second = createSessionForTest(common);
    const secondInternals = asSessionInternals(second);
    const secondArchive = vi.fn(async () => ({
      ok: true as const,
      message: "",
      removedDirectory: true,
    }));
    secondInternals.archivePluginManagedWorktree = secondArchive;
    try {
      await second.invokePluginHost({
        pluginId: "portable-provider",
        caller,
        invocationId: "remove-restart-success",
        generation: 1,
        installationId: "installation-one",
        capabilityNonce: "remove-restart-success-nonce",
        operation: "worktree.remove",
        input: { id: created.id },
        signal: new AbortController().signal,
      });
      expect(secondArchive).toHaveBeenCalledOnce();
      expect(JSON.parse(readFileSync(join(home, "plugin-managed-worktrees.json"), "utf8"))).toEqual(
        {
          version: 1,
          records: [],
        },
      );
    } finally {
      await second.cleanup();
    }
  } finally {
    await first.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test("does not restore only memory when plugin worktree ownership persistence fails", async () => {
  const home = mkdtempSync(join(tmpdir(), "paseo-plugin-worktree-remove-persist-"));
  const caller = createPluginCallerAuthority();
  const liveCaller = createLivePluginCaller();
  const workflowResult = {
    workspace: { workspaceId: "managed-workspace", cwd: "/managed-worktree" },
    worktree: { worktreePath: "/managed-worktree" },
    repoRoot: "/repo",
  };
  const common = {
    paseoHome: home,
    pluginIdentity: { pluginId: "portable-provider", installationId: "installation-one" },
    agentManager: { getAgent: vi.fn(() => liveCaller) },
    workspaceRegistry: {
      get: vi.fn(async () => ({
        workspaceId: "source-workspace",
        projectId: "source-project",
        cwd: "/repo",
        archivedAt: null,
      })),
      list: vi.fn().mockResolvedValue([]),
    },
    projectRegistry: {
      get: vi.fn(async () => ({ projectId: "source-project", archivedAt: null })),
    },
  };
  const first = createSessionForTest(common);
  const firstInternals = asSessionInternals(first);
  firstInternals.createPaseoWorktreeWorkflow = vi.fn(async () => workflowResult);
  firstInternals.buildPluginWorkspaceSnapshot = vi.fn(async () => ({
    ...caller.workspace,
    id: "managed-workspace",
    directory: "/managed-worktree",
  }));
  firstInternals.archivePluginManagedWorktree = vi.fn(async () => ({
    ok: true as const,
    message: "",
    removedDirectory: true,
  }));

  try {
    const created = (await first.invokePluginHost({
      pluginId: "portable-provider",
      caller,
      invocationId: "remove-persist-create",
      generation: 1,
      installationId: "installation-one",
      capabilityNonce: "remove-persist-create-nonce",
      operation: "worktree.create",
      input: {},
      signal: new AbortController().signal,
    })) as { id: string };
    firstInternals.persistPluginManagedWorktrees = vi.fn(async () => {
      throw new Error("ownership persistence failed");
    });

    await expect(
      first.invokePluginHost({
        pluginId: "portable-provider",
        caller,
        invocationId: "remove-persist-failure",
        generation: 1,
        installationId: "installation-one",
        capabilityNonce: "remove-persist-failure-nonce",
        operation: "worktree.remove",
        input: { id: created.id },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("ownership persistence failed");
    await first.cleanup();

    const second = createSessionForTest(common);
    const secondInternals = asSessionInternals(second);
    const secondArchive = vi.fn(async () => ({
      ok: true as const,
      message: "",
      removedDirectory: true,
    }));
    secondInternals.archivePluginManagedWorktree = secondArchive;
    try {
      await second.invokePluginHost({
        pluginId: "portable-provider",
        caller,
        invocationId: "remove-persist-restart",
        generation: 1,
        installationId: "installation-one",
        capabilityNonce: "remove-persist-restart-nonce",
        operation: "worktree.remove",
        input: { id: created.id },
        signal: new AbortController().signal,
      });
      expect(secondArchive).toHaveBeenCalledOnce();
      expect(JSON.parse(readFileSync(join(home, "plugin-managed-worktrees.json"), "utf8"))).toEqual(
        {
          version: 1,
          records: [],
        },
      );
    } finally {
      await second.cleanup();
    }
  } finally {
    await first.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test("durable deliveries are scoped to the authenticated principal and source", async () => {
  const home = mkdtempSync(join(tmpdir(), "paseo-session-deliveries-"));
  const messages: SessionOutboundMessage[] = [];
  const targetedMessages: Array<{ source: object; message: SessionOutboundMessage }> = [];
  const source = {};
  const ledger = new DeliveryLedger(home);
  const session = createSessionForTest({
    paseoHome: home,
    principalId: "plugin:calendar",
    deliveryLedger: ledger,
    deliveryAgentDispatcher: async () => ({ outcome: "accepted" as const }),
    clientCapabilities: { [CLIENT_CAPS.durableDeliveries]: true },
    messages,
    targetedMessages,
  });

  try {
    await session.handleMessage(
      {
        type: "deliveries.send.request",
        requestId: "delivery-send",
        deliveryId: "calendar-one",
        targetAgentId: "agent-calendar",
        payload: { event: "refresh" },
      },
      source,
    );
    expect(messages).toEqual([]);
    expect(targetedMessages).toMatchObject([
      {
        source,
        message: {
          type: "deliveries.send.response",
          payload: { requestId: "delivery-send", deliveryId: "calendar-one", created: true },
        },
      },
    ]);

    await session.handleMessage(
      { type: "deliveries.get.request", requestId: "delivery-get" },
      source,
    );
    expect(targetedMessages.at(-1)).toMatchObject({
      source,
      message: {
        type: "deliveries.get.response",
        payload: { requestId: "delivery-get", deliveries: [{ deliveryId: "calendar-one" }] },
      },
    });

    await session.handleMessage(
      {
        type: "deliveries.acknowledge.request",
        requestId: "delivery-ack",
        deliveryId: "calendar-one",
      },
      source,
    );
    expect(targetedMessages.at(-1)).toMatchObject({
      source,
      message: {
        type: "deliveries.acknowledge.response",
        payload: { requestId: "delivery-ack", deliveryId: "calendar-one" },
      },
    });

    const otherLedger = new DeliveryLedger(home);
    await expect(otherLedger.get("owner")).resolves.toMatchObject({ deliveries: [] });
    await expect(
      otherLedger.get("plugin:calendar", { includeAcknowledged: true }),
    ).resolves.toMatchObject({
      deliveries: [{ deliveryId: "calendar-one", acknowledgedAt: expect.any(String) }],
    });
  } finally {
    await session.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test("near-limit deliveries.get response stays correlated through WS serialization", async () => {
  const home = mkdtempSync(join(tmpdir(), "paseo-session-deliveries-near-limit-"));
  const ledger = new DeliveryLedger(home, { maxBytesPerOwner: 4 * 1024 * 1024 });
  const source = {};
  const targetedMessages: Array<{ source: object; message: SessionOutboundMessage }> = [];
  const payload = {
    first: "x".repeat(15_900),
    second: "x".repeat(15_900),
    third: "x".repeat(15_900),
    fourth: "x".repeat(15_900),
  };
  for (let index = 0; index < 16; index += 1) {
    await ledger.send("owner", {
      deliveryId: `near-limit-${index}`,
      targetAgentId: "agent-near-limit",
      payload,
    });
  }
  const session = createSessionForTest({
    paseoHome: home,
    principalId: "owner",
    deliveryLedger: ledger,
    clientCapabilities: { [CLIENT_CAPS.durableDeliveries]: true },
    targetedMessages,
  });

  try {
    await session.handleMessage(
      {
        type: "deliveries.get.request",
        requestId: "r".repeat(256),
        limit: 100,
      },
      source,
    );

    const response = targetedMessages.at(-1);
    if (!response) throw new Error("Expected a targeted deliveries response");
    const wire = wrapSessionMessage(response.message);
    const encoded = JSON.stringify(wire);
    const encodedBytes = Buffer.byteLength(encoded, "utf8");
    WSSessionOutboundSchema.parse(wire);
    expect(encodedBytes).toBeLessThanOrEqual(MAX_DELIVERY_RESPONSE_BYTES);
    expect(encodedBytes).toBe(1_025_134);
    expect(response.source).toBe(source);
    expect(response.message).toMatchObject({
      type: "deliveries.get.response",
      payload: { requestId: "r".repeat(256) },
    });
  } finally {
    await session.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test("bounds plugin host delivery pages while preserving exact lookup and cursors", async () => {
  const home = mkdtempSync(join(tmpdir(), "paseo-plugin-delivery-get-bound-"));
  const ledger = new DeliveryLedger(home, { maxBytesPerOwner: 4 * 1024 * 1024 });
  const caller = createPluginCallerAuthority();
  const liveCaller = createLivePluginCaller();
  const pluginIdentity = { pluginId: "delivery-get", installationId: "installation-one" };
  const principalId = "plugin:delivery-get:installation-one";
  const largePayload = {
    first: "x".repeat(15_000),
    second: "x".repeat(15_000),
    third: "x".repeat(15_000),
    fourth: "x".repeat(15_000),
  };
  for (let index = 1; index <= 4; index += 1) {
    await ledger.send(principalId, {
      deliveryId: `delivery-${index}`,
      targetAgentId: caller.callerAgentId,
      payload: largePayload,
    });
  }
  const session = createSessionForTest({
    paseoHome: home,
    principalId,
    pluginIdentity,
    deliveryLedger: ledger,
    agentManager: { getAgent: vi.fn(() => liveCaller) },
    workspaceRegistry: {
      get: vi.fn(async () => ({
        workspaceId: "source-workspace",
        projectId: "source-project",
        cwd: "/repo",
        archivedAt: null,
      })),
      list: vi.fn().mockResolvedValue([]),
    },
    projectRegistry: {
      get: vi.fn(async () => ({ projectId: "source-project", archivedAt: null })),
    },
  });

  let invocationNumber = 0;
  const invokeGet = (options: Record<string, unknown>) =>
    session.invokePluginHost({
      pluginId: pluginIdentity.pluginId,
      caller,
      invocationId: `invocation-${++invocationNumber}`,
      generation: 1,
      installationId: pluginIdentity.installationId,
      capabilityNonce: `nonce-${invocationNumber}`,
      operation: "delivery.get",
      input: { options },
      signal: new AbortController().signal,
    }) as Promise<{
      delivery: DeliveryRecord | null;
      deliveries: DeliveryRecord[];
      nextCursor: string | null;
    }>;

  try {
    const firstPage = await invokeGet({ limit: 100 });
    expect(firstPage.deliveries.map(({ deliveryId }) => deliveryId)).toEqual([
      "delivery-1",
      "delivery-2",
      "delivery-3",
    ]);
    expect(firstPage.nextCursor).toBe("seq:3");
    expect(
      Buffer.byteLength(
        JSON.stringify({
          type: "session",
          message: { type: "deliveries.get.response", payload: firstPage },
        }),
        "utf8",
      ),
    ).toBeLessThanOrEqual(MAX_PLUGIN_HOST_DELIVERY_GET_RESPONSE_BYTES);

    await expect(invokeGet({ cursor: firstPage.nextCursor, limit: 100 })).resolves.toMatchObject({
      deliveries: [{ deliveryId: "delivery-4" }],
      nextCursor: null,
    });
    await expect(invokeGet({ deliveryId: "delivery-4" })).resolves.toMatchObject({
      delivery: { deliveryId: "delivery-4" },
      deliveries: [{ deliveryId: "delivery-4" }],
      nextCursor: null,
    });
  } finally {
    await session.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test("keeps compacted deliveries compatible for old clients and exposes tombstones to new ones", async () => {
  const home = mkdtempSync(join(tmpdir(), "paseo-delivery-tombstone-"));
  const messages: SessionOutboundMessage[] = [];
  const ledger = new DeliveryLedger(home, {
    maxAcknowledgedPayloads: 0,
    maxAcknowledgedPayloadBytes: 0,
    acknowledgedPayloadMaxAgeMs: 100_000,
    tombstoneRetentionMs: 100_000,
  });
  const sessions: Session[] = [];

  try {
    await ledger.send("owner", {
      deliveryId: "compacted-delivery",
      targetAgentId: "agent-exact",
      payload: { event: "finished" },
      payloadTombstoneEligible: true,
    });
    await ledger.markDispatching("owner", "compacted-delivery");
    await ledger.markAccepted("owner", "compacted-delivery");
    await ledger.acknowledge("owner", "compacted-delivery", {
      allowPayloadTombstones: true,
    });

    const legacySession = createSessionForTest({
      paseoHome: home,
      principalId: "owner",
      deliveryLedger: ledger,
      clientCapabilities: { [CLIENT_CAPS.durableDeliveries]: true },
      messages,
    });
    sessions.push(legacySession);

    await legacySession.handleMessage({
      type: "deliveries.send.request",
      requestId: "legacy-resend",
      deliveryId: "compacted-delivery",
      targetAgentId: "agent-exact",
      payload: { event: "finished" },
    });
    expect(messages.at(-1)).toEqual({
      type: "deliveries.send.response",
      payload: expect.objectContaining({
        requestId: "legacy-resend",
        delivery: expect.objectContaining({
          deliveryId: "compacted-delivery",
          payload: { event: "finished" },
        }),
        created: false,
      }),
    });

    await legacySession.handleMessage({
      type: "deliveries.get.request",
      requestId: "legacy-get",
      includeAcknowledged: true,
    });
    expect(messages.at(-1)).toEqual({
      type: "deliveries.get.response",
      payload: {
        requestId: "legacy-get",
        delivery: null,
        deliveries: [],
        nextCursor: null,
      },
    });

    await legacySession.handleMessage({
      type: "deliveries.acknowledge.request",
      requestId: "legacy-ack",
      deliveryId: "compacted-delivery",
    });
    expect(messages.findLast((message) => message.type === "rpc_error")).toEqual({
      type: "rpc_error",
      payload: expect.objectContaining({
        requestId: "legacy-ack",
        code: "delivery_payload_unavailable",
      }),
    });

    const capableMessages: SessionOutboundMessage[] = [];
    const capableSession = createSessionForTest({
      paseoHome: home,
      principalId: "owner",
      deliveryLedger: ledger,
      clientCapabilities: {
        [CLIENT_CAPS.durableDeliveries]: true,
        [CLIENT_CAPS.deliveryPayloadTombstones]: true,
      },
      messages: capableMessages,
    });
    sessions.push(capableSession);

    await capableSession.handleMessage({
      type: "deliveries.get.request",
      requestId: "capable-get",
      includeAcknowledged: true,
    });
    expect(capableMessages.at(-1)).toEqual({
      type: "deliveries.get.response",
      payload: expect.objectContaining({
        requestId: "capable-get",
        deliveries: [
          expect.objectContaining({
            deliveryId: "compacted-delivery",
            payloadFingerprint: expect.any(String),
          }),
        ],
      }),
    });
    expect(capableMessages.at(-1)).not.toHaveProperty("payload.deliveries.0.payload");

    await capableSession.handleMessage({
      type: "deliveries.acknowledge.request",
      requestId: "capable-ack-1",
      deliveryId: "compacted-delivery",
    });
    const firstAcknowledgement = capableMessages.at(-1);
    expect(firstAcknowledgement).toEqual({
      type: "deliveries.acknowledge.response",
      payload: expect.objectContaining({
        requestId: "capable-ack-1",
        deliveryId: "compacted-delivery",
        delivery: expect.objectContaining({
          status: "acknowledged",
          payloadFingerprint: expect.any(String),
        }),
      }),
    });
    expect(firstAcknowledgement).not.toHaveProperty("payload.delivery.payload");

    await capableSession.handleMessage({
      type: "deliveries.acknowledge.request",
      requestId: "capable-ack-2",
      deliveryId: "compacted-delivery",
    });
    expect(capableMessages.at(-1)).toEqual({
      type: "deliveries.acknowledge.response",
      payload: expect.objectContaining({
        requestId: "capable-ack-2",
        deliveryId: "compacted-delivery",
        delivery: expect.objectContaining({ status: "acknowledged" }),
      }),
    });
    expect(capableMessages.at(-1)).not.toHaveProperty("payload.delivery.payload");
  } finally {
    await Promise.all(sessions.map((session) => session.cleanup()));
    rmSync(home, { recursive: true, force: true });
  }
});

test("dispatches a targeted delivery through the injected native agent seam", async () => {
  const messages: SessionOutboundMessage[] = [];
  const dispatched = vi.fn(async () => ({ outcome: "accepted" as const }));
  const home = mkdtempSync(join(tmpdir(), "paseo-targeted-delivery-"));
  const ledger = new DeliveryLedger(home);
  const session = createSessionForTest({
    principalId: "plugin:calendar:installation",
    paseoHome: home,
    deliveryLedger: ledger,
    deliveryAgentDispatcher: dispatched,
    clientCapabilities: { [CLIENT_CAPS.durableDeliveries]: true },
    messages,
  });

  try {
    await session.handleMessage({
      type: "deliveries.send.request",
      requestId: "targeted-send",
      deliveryId: "targeted-delivery",
      targetAgentId: "agent-exact",
      messageId: "message-stable",
      payload: { event: "refresh" },
    });

    expect(dispatched).toHaveBeenCalledWith({
      targetAgentId: "agent-exact",
      messageId: "message-stable",
      payload: { event: "refresh" },
    });
    expect(messages).toContainEqual({
      type: "deliveries.send.response",
      payload: {
        requestId: "targeted-send",
        deliveryId: "targeted-delivery",
        delivery: expect.objectContaining({
          targetAgentId: "agent-exact",
          messageId: "message-stable",
          status: "accepted",
        }),
        created: true,
      },
    });
  } finally {
    await session.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test("compensates a plugin delivery cancelled before native dispatch and fences its retry", async () => {
  const home = mkdtempSync(join(tmpdir(), "paseo-cancelled-plugin-delivery-"));
  const caller = createPluginCallerAuthority();
  const controller = new AbortController();
  const dispatched = vi.fn(async () => ({ outcome: "accepted" as const }));
  const deliveryDispatchCoordinator = {
    run: vi.fn(async (_key: string, operation: () => Promise<unknown>) => {
      controller.abort(new Error("plugin delivery cancelled"));
      return operation();
    }),
  } as unknown as SessionOptions["deliveryDispatchCoordinator"];
  const ledger = new DeliveryLedger(home);
  const session = createSessionForTest({
    paseoHome: home,
    principalId: "plugin:calendar:installation",
    pluginIdentity: { pluginId: "calendar", installationId: "installation" },
    deliveryLedger: ledger,
    deliveryDispatchCoordinator,
    deliveryAgentDispatcher: dispatched,
    agentManager: { getAgent: vi.fn(() => createLivePluginCaller()) },
    workspaceRegistry: {
      get: vi.fn(async () => ({
        workspaceId: "source-workspace",
        projectId: "source-project",
        cwd: "/repo",
        archivedAt: null,
      })),
      list: vi.fn().mockResolvedValue([]),
    },
    projectRegistry: {
      get: vi.fn(async () => ({ projectId: "source-project", archivedAt: null })),
    },
  });

  try {
    await expect(
      session.invokePluginHost({
        pluginId: "calendar",
        caller,
        invocationId: "cancelled-delivery",
        generation: 1,
        installationId: "installation",
        capabilityNonce: "cancelled-nonce",
        operation: "delivery.send",
        input: {
          payload: { event: "cancelled" },
          options: { deliveryId: "cancelled-delivery" },
        },
        signal: controller.signal,
      }),
    ).rejects.toThrow("plugin delivery cancelled");

    await expect(
      ledger.get("plugin:calendar:installation", {
        deliveryId: "cancelled-delivery",
        includeAcknowledged: true,
      }),
    ).resolves.toMatchObject({
      delivery: {
        status: "failed",
        error: "Plugin host request cancelled",
      },
    });

    await expect(
      session.invokePluginHost({
        pluginId: "calendar",
        caller,
        invocationId: "cancelled-delivery-retry",
        generation: 1,
        installationId: "installation",
        capabilityNonce: "cancelled-retry-nonce",
        operation: "delivery.send",
        input: {
          payload: { event: "cancelled" },
          options: { deliveryId: "cancelled-delivery" },
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ status: "failed" });
    expect(dispatched).not.toHaveBeenCalled();
  } finally {
    await session.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test("accepts an old targetless wire send without native dispatch", async () => {
  const messages: SessionOutboundMessage[] = [];
  const dispatched = vi.fn(async () => ({ outcome: "accepted" as const }));
  const home = mkdtempSync(join(tmpdir(), "paseo-legacy-pull-delivery-"));
  const session = createSessionForTest({
    paseoHome: home,
    principalId: "owner",
    deliveryAgentDispatcher: dispatched,
    messages,
    clientCapabilities: { [CLIENT_CAPS.durableDeliveries]: true },
  });

  try {
    await session.handleMessage({
      type: "deliveries.send.request",
      requestId: "legacy-pull-send",
      deliveryId: "legacy-pull-delivery",
      payload: { event: "refresh" },
    });
    expect(dispatched).not.toHaveBeenCalled();
    expect(messages).toContainEqual({
      type: "deliveries.send.response",
      payload: expect.objectContaining({
        requestId: "legacy-pull-send",
        deliveryId: "legacy-pull-delivery",
        created: true,
        delivery: expect.objectContaining({
          deliveryMode: "legacy_pull",
          status: "accepted",
        }),
      }),
    });
  } finally {
    await session.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test("coalesces concurrent targeted sends into one native dispatch", async () => {
  const messages: SessionOutboundMessage[] = [];
  const home = mkdtempSync(join(tmpdir(), "paseo-concurrent-delivery-"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const dispatched = vi.fn(async () => {
    await gate;
    return { outcome: "accepted" as const };
  });
  const session = createSessionForTest({
    principalId: "owner",
    paseoHome: home,
    deliveryAgentDispatcher: dispatched,
    clientCapabilities: { [CLIENT_CAPS.durableDeliveries]: true },
    messages,
  });

  try {
    const first = session.handleMessage({
      type: "deliveries.send.request",
      requestId: "concurrent-one",
      deliveryId: "concurrent-delivery",
      targetAgentId: "agent-exact",
      payload: { event: "refresh" },
    });
    const second = session.handleMessage({
      type: "deliveries.send.request",
      requestId: "concurrent-two",
      deliveryId: "concurrent-delivery",
      targetAgentId: "agent-exact",
      payload: { event: "refresh" },
    });
    await vi.waitFor(() => expect(dispatched).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, second]);
    expect(dispatched).toHaveBeenCalledTimes(1);
  } finally {
    release();
    await session.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test("durable delivery authorization uses semantic workspace permissions", async () => {
  const messages: SessionOutboundMessage[] = [];
  const session = createSessionForTest({
    messages,
    permissions: ["workspace.read"],
    clientCapabilities: { [CLIENT_CAPS.durableDeliveries]: true },
  });

  await session.handleMessage({
    type: "deliveries.send.request",
    requestId: "delivery-unauthorized",
    payload: "not allowed",
  });

  expect(messages).toEqual([
    {
      type: "rpc_error",
      payload: {
        requestId: "delivery-unauthorized",
        requestType: "deliveries.send.request",
        error: "Session is not authorized for deliveries.send.request",
        code: "access_denied",
      },
    },
  ]);
  await session.cleanup();
});

test("routes host-scoped agent skills requests through the daemon owner", async () => {
  const messages: SessionOutboundMessage[] = [];
  const status = {
    state: "up-to-date" as const,
    ops: [],
    available: ["paseo"],
    installed: ["paseo"],
    selection: { mode: "all" as const },
  };
  const orchestrationSkills: NonNullable<SessionOptions["orchestrationSkills"]> = {
    getStatus: vi.fn(async () => status),
    reconcile: vi.fn(async () => status),
    uninstall: vi.fn(async () => status),
    saveSelection: vi.fn(async () => ({ ...status, confirmationRequired: null })),
    importLegacySelectionIfUnset: vi.fn(async (selection) => ({
      imported: true,
      selection,
    })),
    autoUpdate: vi.fn(async () => status),
  };
  const session = createSessionForTest({ messages, orchestrationSkills });

  await session.handleMessage({
    type: "agent.skills.save_selection.request",
    requestId: "save-skills",
    selection: { mode: "custom", skills: ["paseo"] },
    confirmedRemovals: ["paseo-loop"],
  });

  expect(orchestrationSkills.saveSelection).toHaveBeenCalledWith(
    { mode: "custom", skills: ["paseo"] },
    ["paseo-loop"],
  );
  expect(messages).toContainEqual({
    type: "agent.skills.save_selection.response",
    payload: { requestId: "save-skills", ...status, confirmationRequired: null },
  });
});

test("routes plugin requests and releases its owned catalog subscription on cleanup", async () => {
  const messages: SessionOutboundMessage[] = [];
  const listeners = new Set<(pluginId: string) => void>();
  const releasePluginSubscription = vi.fn((listener: (pluginId: string) => void) => {
    listeners.delete(listener);
  });
  const plugin = {
    id: "example",
    path: "/plugins/example",
    enabled: true,
    status: "running" as const,
  };
  const pluginRuntime: NonNullable<SessionOptions["pluginRuntime"]> = {
    listPlugins: () => [plugin],
    getLogs: () => [
      {
        sequence: 1,
        timestamp: "2026-08-16T12:00:00.000Z",
        stream: "stdout",
        message: "ready",
      },
    ],
    installDirectory: async () => plugin,
    inspectDirectory: async () => ({ id: "example" }),
    reloadPlugin: async () => plugin,
    enablePlugin: async () => plugin,
    disablePlugin: async () => ({ ...plugin, enabled: false, status: "disabled" }),
    removePlugin: async () => undefined,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => releasePluginSubscription(listener);
    },
    catalog: () => [{ id: "example", clientBundle: "bundle" }],
    invokePluginRpc: async () => ({ ok: true }),
  };
  const session = createSessionForTest({ messages, pluginRuntime });

  await session.handleMessage({ type: "plugin.list.request", requestId: "list" });
  await session.handleMessage({
    type: "plugin.logs.get.request",
    requestId: "logs",
    pluginId: "example",
  });
  await session.handleMessage({
    type: "plugin.directory.install.request",
    requestId: "install",
    path: "/plugins/example",
  });
  await session.handleMessage({
    type: "plugin.reload.request",
    requestId: "reload",
    pluginId: "example",
  });
  await session.handleMessage({
    type: "plugin.disable.request",
    requestId: "disable",
    pluginId: "example",
  });
  await session.handleMessage({
    type: "plugin.remove.request",
    requestId: "remove",
    pluginId: "example",
  });
  for (const listener of listeners) listener("example");

  expect(messages.map((message) => message.type)).toEqual([
    "plugin.list.response",
    "plugin.logs.get.response",
    "plugin.directory.install.response",
    "plugin.reload.response",
    "plugin.disable.response",
    "plugin.remove.response",
    "status",
  ]);
  expect(messages.at(-1)).toEqual({
    type: "status",
    payload: { status: "plugin_catalog_changed", pluginId: "example" },
  });
  await session.cleanup();
  expect(listeners.size).toBe(0);
  expect(releasePluginSubscription).toHaveBeenCalledOnce();
});

test("caller-scoped plugin RPC requires an authenticated source and resource grant", async () => {
  const messages: SessionOutboundMessage[] = [];
  const targetedMessages: Array<{ source: object; message: SessionOutboundMessage }> = [];
  const source = {};
  const invokePluginRpc = vi.fn(async () => ({ ok: true }));
  const pluginRuntime: NonNullable<SessionOptions["pluginRuntime"]> = {
    listPlugins: () => [],
    getLogs: () => [],
    installDirectory: async () => ({
      id: "example",
      path: "/plugins/example",
      enabled: true,
      status: "running" as const,
    }),
    inspectDirectory: async () => ({ id: "example" }),
    reloadPlugin: async () => undefined,
    enablePlugin: async () => undefined,
    disablePlugin: async () => undefined,
    removePlugin: async () => undefined,
    subscribe: () => () => undefined,
    catalog: () => [],
    invokePluginRpc,
  };
  const session = createSessionForTest({
    messages,
    targetedMessages,
    principalId: "authenticated",
    permissions: ["workspace.read", "workspace.write"],
    resourcePermissions: {
      agentIds: ["caller-agent"],
      workspaceIds: ["source-workspace"],
    },
    agentManager: { getAgent: vi.fn(() => createLivePluginCaller()) },
    pluginRuntime,
  });

  try {
    await session.handleMessage({
      type: "plugin.rpc.invoke.request",
      requestId: "missing-source",
      pluginId: "example",
      method: "inspect",
      input: {},
      callerAgentId: "caller-agent",
    });
    expect(invokePluginRpc).not.toHaveBeenCalled();

    await session.handleMessage(
      {
        type: "plugin.rpc.invoke.request",
        requestId: "scoped-call",
        pluginId: "example",
        method: "inspect",
        input: {},
        callerAgentId: "caller-agent",
      },
      source,
    );
    expect(invokePluginRpc).toHaveBeenCalledWith(
      "example",
      "inspect",
      {},
      expect.objectContaining({ callerAgentId: "caller-agent" }),
    );
    expect(targetedMessages).toContainEqual({
      source,
      message: {
        type: "plugin.rpc.invoke.response",
        payload: { requestId: "scoped-call", output: { ok: true } },
      },
    });

    await session.handleMessage(
      {
        type: "plugin.rpc.invoke.request",
        requestId: "outside-grant",
        pluginId: "example",
        method: "inspect",
        input: {},
        callerAgentId: "other-agent",
      },
      source,
    );
    expect(invokePluginRpc).toHaveBeenCalledOnce();
  } finally {
    await session.cleanup();
  }
});

describe("workspace label subscriptions", () => {
  type LabelSubscription = Awaited<ReturnType<WorkspaceLabelService["subscribe"]>>;
  type LabelChange = Parameters<Parameters<WorkspaceLabelService["subscribe"]>[0]["onChange"]>[0];

  function labelSubscription(requestId: string): LabelSubscription {
    return {
      snapshot: {
        labels: [],
        sync: {
          mode: "snapshot",
          generation: `generation-${requestId}`,
          headSeq: 0,
          removals: [],
        },
      },
      unsubscribe: vi.fn(),
    };
  }

  function labelListRequest(requestId: string) {
    return {
      type: "workspace.label.list.request" as const,
      requestId,
      subscribe: { subscriptionId: `subscription-${requestId}` },
    };
  }

  test("an overlapping request cannot reactivate its superseded subscription", async () => {
    const first = deferred<LabelSubscription>();
    const callbacks: Array<(change: LabelChange) => void> = [];
    const service = {
      subscribe: async (input: Parameters<WorkspaceLabelService["subscribe"]>[0]) => {
        callbacks.push(input.onChange);
        return callbacks.length === 1 ? first.promise : labelSubscription("b");
      },
    } as unknown as WorkspaceLabelService;
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForTest({ messages, workspaceLabelService: service });

    const requestA = session.handleMessage(labelListRequest("a"));
    await Promise.resolve();
    await session.handleMessage(labelListRequest("b"));
    const firstSubscription = labelSubscription("a");
    first.resolve(firstSubscription);
    await requestA;

    expect(firstSubscription.unsubscribe).toHaveBeenCalledOnce();
    callbacks[0]?.({
      kind: "remove",
      name: "Old",
      generation: "generation-a",
      seq: 1,
    });
    callbacks[1]?.({
      kind: "remove",
      name: "Current",
      generation: "generation-b",
      seq: 1,
    });
    expect(messages.filter((message) => message.type === "workspace.label.update")).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ name: "Current" }) }),
    ]);
  });

  test("a superseded failure cannot clear the current subscription or survive cleanup", async () => {
    const first = deferred<LabelSubscription>();
    const callbacks: Array<(change: LabelChange) => void> = [];
    const current = labelSubscription("b");
    const service = {
      subscribe: async (input: Parameters<WorkspaceLabelService["subscribe"]>[0]) => {
        callbacks.push(input.onChange);
        return callbacks.length === 1 ? first.promise : current;
      },
    } as unknown as WorkspaceLabelService;
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForTest({ messages, workspaceLabelService: service });

    const requestA = session.handleMessage(labelListRequest("a"));
    await Promise.resolve();
    await session.handleMessage(labelListRequest("b"));
    first.reject(new Error("old request failed"));
    await requestA;

    callbacks[1]?.({
      kind: "remove",
      name: "Current",
      generation: "generation-b",
      seq: 1,
    });
    expect(messages.filter((message) => message.type === "workspace.label.update")).toHaveLength(1);
    await session.cleanup();
    expect(current.unsubscribe).toHaveBeenCalledOnce();
    callbacks[1]?.({
      kind: "remove",
      name: "After cleanup",
      generation: "generation-b",
      seq: 2,
    });
    expect(messages.filter((message) => message.type === "workspace.label.update")).toHaveLength(1);
  });
});

describe("workspace label editing", () => {
  test("answers one edit with the label it produced and the assignments it rewrote", async () => {
    const calls: unknown[] = [];
    const service = {
      update: async (input: unknown) => {
        calls.push(input);
        return { label: { name: "Priority", color: "sky" }, affectedWorkspaceCount: 3 };
      },
    } as unknown as WorkspaceLabelService;
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForTest({ messages, workspaceLabelService: service });

    await session.handleMessage({
      type: "workspace.label.update.request",
      requestId: "request-edit",
      name: "Urgent",
      newName: "Priority",
      color: "sky",
    });

    expect(calls).toEqual([
      expect.objectContaining({ name: "Urgent", newName: "Priority", color: "sky" }),
    ]);
    expect(messages).toEqual([
      {
        type: "workspace.label.update.response",
        payload: {
          requestId: "request-edit",
          label: { name: "Priority", color: "sky" },
          affectedWorkspaceCount: 3,
        },
      },
    ]);
  });

  test("reports a name collision as a coded error and emits no response", async () => {
    const service = {
      update: async () => {
        throw new WorkspaceLabelError("label_name_taken", "A label with that name already exists");
      },
    } as unknown as WorkspaceLabelService;
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForTest({ messages, workspaceLabelService: service });

    await session.handleMessage({
      type: "workspace.label.update.request",
      requestId: "request-collision",
      name: "Urgent",
      newName: "Waiting",
      color: "teal",
    });

    expect(messages).toEqual([
      {
        type: "rpc_error",
        payload: {
          requestId: "request-collision",
          requestType: "workspace.label.update.request",
          code: "label_name_taken",
          error: "A label with that name already exists",
        },
      },
    ]);
  });
});

describe("session authorization permissions", () => {
  test("routes named-agent validation through the session source", async () => {
    const messages: SessionOutboundMessage[] = [];
    const providers = createProviderSnapshotManagerStub();
    providers.validateAgentConfiguration.mockResolvedValue([
      { path: ["model"], message: "Model is unavailable" },
    ]);
    const session = createSessionForTest({
      messages,
      providerSnapshotManager: providers.manager,
      hubExecutionAgents: {
        create: vi.fn(),
        control: vi.fn(),
        subscribe: vi.fn(() => () => undefined),
        invalidateAuthority: vi.fn(),
      },
    });

    await session.handleMessage({
      type: "hub.execution.agent.validate.request",
      requestId: "validate-agent",
      provider: "codex",
      model: "missing",
    });

    expect(providers.validateAgentConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "codex", model: "missing" }),
    );
    expect(messages).toContainEqual({
      type: "hub.execution.agent.validate.response",
      payload: {
        requestId: "validate-agent",
        valid: false,
        issues: [{ path: ["model"], message: "Model is unavailable" }],
        error: null,
      },
    });
  });

  test("rejects an operation without its semantic permission", async () => {
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForTest({
      permissions: ["hub.execute"],
      messages,
    });

    await session.handleMessage({ type: "ping", requestId: "restricted-ping", clientSentAt: 42 });

    expect(messages).toEqual([
      {
        type: "rpc_error",
        payload: {
          requestId: "restricted-ping",
          requestType: "ping",
          error: "Session is not authorized for ping",
          code: "access_denied",
        },
      },
    ]);
  });

  test("replaces a session's permissions without reconstructing the session", async () => {
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForTest({ permissions: ["hub.execute"], messages });

    await session.handleMessage({
      type: "ping",
      requestId: "before-scope-change",
      clientSentAt: 1,
    });
    session.setPermissions(["daemon.read"]);
    await session.handleMessage({ type: "ping", requestId: "after-scope-change", clientSentAt: 2 });

    expect(messages).toEqual([
      {
        type: "rpc_error",
        payload: {
          requestId: "before-scope-change",
          requestType: "ping",
          error: "Session is not authorized for ping",
          code: "access_denied",
        },
      },
      {
        type: "pong",
        payload: {
          requestId: "after-scope-change",
          clientSentAt: 2,
          serverReceivedAt: expect.any(Number),
          serverSentAt: expect.any(Number),
        },
      },
    ]);
  });
});

describe("project command-center RPCs", () => {
  test("returns normalized repositories from the host GitHub service", async () => {
    const messages: SessionOutboundMessage[] = [];
    const searchRepositories = vi.fn().mockResolvedValue([
      {
        id: "R_paseo",
        name: "paseo",
        nameWithOwner: "getpaseo/paseo",
        description: "Development environment in your pocket",
        visibility: "public",
        updatedAt: "2026-07-15T10:00:00Z",
        cloneUrl: "git@github.com:getpaseo/paseo.git",
      },
    ]);
    const session = createSessionForTest({ messages, github: { searchRepositories } });

    await session.handleMessage({
      type: "workspace.github.search_repositories.request",
      query: "paseo",
      limit: 10,
      requestId: "req-repositories",
    });

    expect(searchRepositories).toHaveBeenCalledWith({
      cwd: expect.any(String),
      query: "paseo",
      limit: 10,
    });
    expect(messages).toEqual([
      {
        type: "workspace.github.search_repositories.response",
        payload: {
          status: "success",
          requestId: "req-repositories",
          repositories: [
            {
              id: "R_paseo",
              name: "paseo",
              nameWithOwner: "getpaseo/paseo",
              description: "Development environment in your pocket",
              visibility: "public",
              updatedAt: "2026-07-15T10:00:00Z",
              cloneUrl: "git@github.com:getpaseo/paseo.git",
            },
          ],
          available: true,
          error: null,
        },
      },
    ]);
  });

  test.each([
    {
      error: new GitHubCliMissingError(),
      expected: {
        status: "unavailable",
        requestId: "req-repositories-error",
        reason: "gh_missing",
        repositories: [],
        available: false,
        error: "GitHub CLI (gh) is not installed or not in PATH",
      },
    },
    {
      error: new GitHubAuthenticationError({ stderr: "gh auth login" }),
      expected: {
        status: "unauthenticated",
        requestId: "req-repositories-error",
        repositories: [],
        available: false,
        error: "GitHub CLI is not authenticated. Run gh auth login on the host.",
      },
    },
    {
      error: new GitHubCommandError({
        args: ["search", "repos", "paseo"],
        cwd: "/tmp",
        exitCode: 1,
        stderr: "GitHub API unavailable",
      }),
      expected: {
        status: "error",
        requestId: "req-repositories-error",
        repositories: [],
        available: true,
        error: "GitHub API unavailable",
      },
    },
  ])("maps GitHub runtime failures to $expected.status", async ({ error, expected }) => {
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForTest({
      messages,
      github: { searchRepositories: vi.fn().mockRejectedValue(error) },
    });

    await session.handleMessage({
      type: "workspace.github.search_repositories.request",
      query: "paseo",
      requestId: "req-repositories-error",
    });

    expect(messages).toEqual([
      {
        type: "workspace.github.search_repositories.response",
        payload: expected,
      },
    ]);
  });

  test("creates a directory and returns its normalized Project descriptor", async () => {
    const parentDirectory = realpathSync(mkdtempSync(join(tmpdir(), "paseo-project-session-")));
    const directoryPath = join(parentDirectory, "new-project");
    const messages: SessionOutboundMessage[] = [];
    const projectAllocation = vi.fn(async (input) =>
      createPersistedProjectRecord({
        projectId: "prj_created_directory",
        rootPath: input.rootPath,
        kind: input.kind,
        displayName: input.displayName,
        createdAt: input.timestamp,
        updatedAt: input.timestamp,
      }),
    );
    const session = createSessionForTest({
      messages,
      projectRegistry: {
        getOrCreateActiveByRoot: projectAllocation,
      },
      workspaceGitService: {
        getCheckout: vi.fn(async (cwd: string) => ({
          cwd,
          isGit: false as const,
          currentBranch: null,
          remoteUrl: null,
          worktreeRoot: null,
          isPaseoOwnedWorktree: false as const,
          mainRepoRoot: null,
        })),
      },
    });

    try {
      await session.handleMessage({
        type: "project.create_directory.request",
        parentPath: parentDirectory,
        name: "new-project",
        requestId: "req-create-directory",
      });

      expect(existsSync(directoryPath)).toBe(true);
      expect(projectAllocation).toHaveBeenCalledWith({
        rootPath: directoryPath,
        kind: "non_git",
        displayName: "new-project",
        projectKey: deriveProjectKey({
          rootPath: directoryPath,
          remoteUrl: null,
          worktreeRoot: null,
          mainRepoRoot: null,
        }),
        timestamp: expect.any(String),
      });
      expect(messages).toEqual([
        {
          type: "project.create_directory.response",
          payload: {
            requestId: "req-create-directory",
            directoryPath,
            project: {
              projectId: "prj_created_directory",
              projectDisplayName: "new-project",
              projectCustomName: null,
              projectCustomIconRevision: null,
              projectIconRevision: "automatic:none:v1",
              projectRootPath: directoryPath,
              projectKind: "non_git",
            },
            error: null,
            errorCode: null,
          },
        },
      ]);
    } finally {
      rmSync(parentDirectory, { recursive: true, force: true });
    }
  });

  test("rolls back the directory when Project registration fails", async () => {
    const parentDirectory = realpathSync(mkdtempSync(join(tmpdir(), "paseo-project-session-")));
    const directoryPath = join(parentDirectory, "unregistered");
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForTest({
      messages,
      projectRegistry: {
        getOrCreateActiveByRoot: vi.fn().mockRejectedValue(new Error("registry unavailable")),
      },
      workspaceGitService: {
        getCheckout: vi.fn(async (cwd: string) => ({
          cwd,
          isGit: false as const,
          currentBranch: null,
          remoteUrl: null,
          worktreeRoot: null,
          isPaseoOwnedWorktree: false as const,
          mainRepoRoot: null,
        })),
      },
    });

    try {
      await session.handleMessage({
        type: "project.create_directory.request",
        parentPath: parentDirectory,
        name: "unregistered",
        requestId: "req-registration-failure",
      });

      expect(existsSync(directoryPath)).toBe(false);
      expect(messages).toEqual([
        {
          type: "project.create_directory.response",
          payload: {
            requestId: "req-registration-failure",
            directoryPath,
            project: null,
            error: "Failed to register project: registry unavailable",
            errorCode: "registration_failed",
          },
        },
      ]);
    } finally {
      rmSync(parentDirectory, { recursive: true, force: true });
    }
  });
});

describe("file explorer binary responses", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeRoot(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "file-explorer-session-test-")));
    tempDirs.push(root);
    return root;
  }

  test("old clients get legacy JSON file content from a new daemon", async () => {
    const cwd = makeRoot();
    writeFileSync(join(cwd, "logo.png"), "hello");
    const messages: unknown[] = [];
    const binaryMessages: Uint8Array[] = [];
    const session = createSessionForTest({ messages, binaryMessages });

    await session.handleMessage({
      type: "file_explorer_request",
      cwd,
      path: "logo.png",
      mode: "file",
      requestId: "req-old-client",
    });

    expect(binaryMessages).toEqual([]);
    expect(messages).toEqual([
      {
        type: "file_explorer_response",
        payload: expect.objectContaining({
          cwd,
          path: "logo.png",
          mode: "file",
          directory: null,
          error: null,
          requestId: "req-old-client",
          file: expect.objectContaining({
            kind: "image",
            encoding: "base64",
            content: "aGVsbG8=",
            mimeType: "image/png",
            size: 5,
          }),
        }),
      },
    ]);
  });

  test("new clients get binary file frames without legacy JSON content", async () => {
    const cwd = makeRoot();
    writeFileSync(join(cwd, "logo.png"), "hello");
    const messages: unknown[] = [];
    const binaryMessages: Uint8Array[] = [];
    const session = createSessionForTest({ messages, binaryMessages });

    await session.handleMessage({
      type: "file_explorer_request",
      cwd,
      path: "logo.png",
      mode: "file",
      requestId: "req-new-client",
      acceptBinary: true,
    });

    expect(messages).toEqual([]);
    expect(binaryMessages).toHaveLength(3);

    const frames = binaryMessages.map((frame) => decodeFileTransferFrame(frame));
    expect(frames[0]).toEqual({
      opcode: FileTransferOpcode.FileBegin,
      requestId: "req-new-client",
      metadata: {
        mime: "image/png",
        size: 5,
        encoding: "binary",
        modifiedAt: expect.any(String),
        revision: expect.any(String),
      },
      payload: new Uint8Array(),
    });
    expect(frames[1]).toEqual({
      opcode: FileTransferOpcode.FileChunk,
      requestId: "req-new-client",
      payload: new TextEncoder().encode("hello"),
    });
    expect(frames[2]).toEqual({
      opcode: FileTransferOpcode.FileEnd,
      requestId: "req-new-client",
      payload: new Uint8Array(),
    });
  });
});

describe("workspace file access (behavior preservation)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeDir(prefix: string): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    tempDirs.push(dir);
    return dir;
  }

  function uploadFrame(args: Parameters<typeof encodeFileTransferFrame>[0]): FileTransferFrame {
    const frame = decodeFileTransferFrame(encodeFileTransferFrame(args));
    if (!frame) {
      throw new Error("Expected a file transfer frame");
    }
    return frame;
  }

  test("file_explorer list returns directory entries", async () => {
    const cwd = makeDir("file-access-list-");
    writeFileSync(join(cwd, "a.txt"), "alpha");
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForTest({ messages });

    await session.handleMessage({
      type: "file_explorer_request",
      cwd,
      path: ".",
      mode: "list",
      requestId: "req-list",
    });

    expect(messages).toHaveLength(1);
    const message = messages[0];
    if (message.type !== "file_explorer_response") {
      throw new Error(`expected file_explorer_response, got ${message.type}`);
    }
    expect(message.payload.error).toBeNull();
    expect(message.payload.directory).not.toBeNull();
  });

  test("file_explorer rejects an empty cwd with an error envelope", async () => {
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForTest({ messages });

    await session.handleMessage({
      type: "file_explorer_request",
      cwd: "   ",
      path: ".",
      mode: "list",
      requestId: "req-empty",
    });

    expect(messages).toEqual([
      {
        type: "file_explorer_response",
        payload: expect.objectContaining({
          error: "cwd is required",
          directory: null,
          file: null,
          requestId: "req-empty",
        }),
      },
    ]);
  });

  test("file_download_token issues a token for a real file", async () => {
    const cwd = makeDir("file-access-token-");
    writeFileSync(join(cwd, "report.txt"), "hello world");
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForTest({
      messages,
      downloadTokenStore: new DownloadTokenStore({ ttlMs: 60_000 }),
    });

    await session.handleMessage({
      type: "file_download_token_request",
      cwd,
      path: "report.txt",
      requestId: "req-token",
    });

    expect(messages).toHaveLength(1);
    const message = messages[0];
    if (message.type !== "file_download_token_response") {
      throw new Error(`expected file_download_token_response, got ${message.type}`);
    }
    expect(message.payload.error).toBeNull();
    expect(typeof message.payload.token).toBe("string");
    expect(message.payload.fileName).toBe("report.txt");
    expect(message.payload.size).toBe(11);
  });

  test("file_download_token rejects an empty cwd with an error envelope", async () => {
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForTest({ messages });

    await session.handleMessage({
      type: "file_download_token_request",
      cwd: "",
      path: "report.txt",
      requestId: "req-token-empty",
    });

    expect(messages).toEqual([
      {
        type: "file_download_token_response",
        payload: expect.objectContaining({
          token: null,
          error: "cwd is required",
          requestId: "req-token-empty",
        }),
      },
    ]);
  });

  test("project_icon responds for a workspace cwd", async () => {
    const cwd = makeDir("file-access-icon-");
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForTest({ messages });

    await session.handleMessage({
      type: "project_icon_request",
      cwd,
      requestId: "req-icon",
    });

    expect(messages).toHaveLength(1);
    const message = messages[0];
    if (message.type !== "project_icon_response") {
      throw new Error(`expected project_icon_response, got ${message.type}`);
    }
    expect(message.payload.cwd).toBe(cwd);
    expect(message.payload.error).toBeNull();
  });

  test("file upload round-trips bytes through binary frames", async () => {
    const paseoHome = makeDir("file-access-upload-");
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForTest({ messages, paseoHome });

    await session.handleMessage({
      type: "file.upload.request",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 11,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-upload",
    });
    await session.handleBinaryFrame({
      kind: "file_transfer",
      frame: uploadFrame({
        opcode: FileTransferOpcode.FileBegin,
        requestId: "req-upload",
        metadata: {
          mime: "text/plain",
          size: 11,
          encoding: "binary",
          modifiedAt: "2026-05-02T00:00:00.000Z",
          fileName: "notes.txt",
        },
      }),
    });
    await session.handleBinaryFrame({
      kind: "file_transfer",
      frame: uploadFrame({
        opcode: FileTransferOpcode.FileChunk,
        requestId: "req-upload",
        payload: new TextEncoder().encode("hello world"),
      }),
    });
    await session.handleBinaryFrame({
      kind: "file_transfer",
      frame: uploadFrame({
        opcode: FileTransferOpcode.FileEnd,
        requestId: "req-upload",
      }),
    });

    const response = messages.find((message) => message.type === "file.upload.response");
    if (response?.type !== "file.upload.response") {
      throw new Error("expected a file.upload.response message");
    }
    expect(response.payload.error).toBeNull();
    expect(response.payload.file?.fileName).toBe("notes.txt");
    expect(response.payload.file?.size).toBe(11);
  });
});

function createStoredAgentRecord(
  overrides: Pick<StoredAgentRecord, "id" | "cwd"> & Partial<StoredAgentRecord>,
): StoredAgentRecord {
  return {
    id: overrides.id,
    provider: overrides.provider ?? "codex",
    cwd: overrides.cwd,
    workspaceId: overrides.workspaceId,
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    lastUserMessageAt: overrides.lastUserMessageAt ?? null,
    title: overrides.title ?? null,
    labels: overrides.labels ?? {},
    lastStatus: overrides.lastStatus ?? "idle",
    lastModeId: overrides.lastModeId ?? null,
    config: overrides.config ?? null,
    runtimeInfo: overrides.runtimeInfo,
    features: overrides.features,
    persistence: overrides.persistence ?? null,
    lastError: overrides.lastError,
    requiresAttention: overrides.requiresAttention,
    attentionReason: overrides.attentionReason,
    attentionTimestamp: overrides.attentionTimestamp,
    internal: overrides.internal,
    archivedAt: overrides.archivedAt ?? null,
  };
}

describe("agent detach RPC", () => {
  test("detaches a stored subagent and emits the updated standalone agent", async () => {
    const messages: unknown[] = [];
    const childBefore = createStoredAgentRecord({
      id: "child-agent",
      cwd: "/tmp/child",
      workspaceId: "workspace-child",
      title: "Child",
      labels: {
        [PARENT_AGENT_ID_LABEL]: "parent-agent",
        topic: "handoff",
      },
    });
    const childAfter = createStoredAgentRecord({
      ...childBefore,
      updatedAt: "2026-01-01T00:00:01.000Z",
      labels: { topic: "handoff" },
    });
    const workspace = {
      workspaceId: "workspace-child",
      projectId: "project-child",
      cwd: "/tmp/child",
      kind: "worktree" as const,
      displayName: "Child workspace",
      title: null,
      branch: "child",
      baseBranch: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
    };
    const project = {
      projectId: "project-child",
      rootPath: "/tmp/child",
      kind: "git" as const,
      displayName: "Project",
      customName: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
    };
    const detachAgent = vi.fn().mockResolvedValue({
      record: childAfter,
      live: false,
      previousParentAgentId: "parent-agent",
    });
    const getAgent = vi.fn(() => null);

    const session = createSessionForTest({
      messages,
      agentManager: {
        getAgent,
        detachAgent,
      },
      agentStorage: {
        list: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockResolvedValue(null),
      },
      workspaceRegistry: {
        get: vi.fn().mockResolvedValue(workspace),
        list: vi.fn().mockResolvedValue([workspace]),
      },
      projectRegistry: {
        get: vi.fn().mockResolvedValue(project),
        list: vi.fn().mockResolvedValue([project]),
      },
    });

    await session.handleMessage({
      type: "fetch_agents_request",
      requestId: "subscribe-agents",
      subscribe: { subscriptionId: "agents-sub" },
    });
    messages.splice(0);

    await session.handleMessage({
      type: "agent.detach.request",
      agentId: childBefore.id,
      requestId: "detach-1",
    });

    expect(detachAgent).toHaveBeenCalledWith("child-agent");
    expect(messages).toContainEqual({
      type: "agent_update",
      payload: {
        kind: "upsert",
        agent: expect.objectContaining({
          id: "child-agent",
          labels: { topic: "handoff" },
          workspaceId: "workspace-child",
        }),
        project: expect.objectContaining({
          projectKey: "project-child",
          workspaceName: "Child workspace",
        }),
      },
    });
    expect(messages).toContainEqual({
      type: "agent.detach.response",
      payload: {
        requestId: "detach-1",
        agentId: "child-agent",
        accepted: true,
        error: null,
      },
    });
  });
});

function createProjectRecord(rootPath: string, archivedAt: string | null = null) {
  return {
    projectId: `project:${rootPath}`,
    rootPath,
    kind: "git" as const,
    displayName: "Project",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt,
  };
}

describe("project config RPC authorization", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeRoot(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "project-config-session-test-")));
    tempDirs.push(root);
    return root;
  }

  test("read_project_config_request accepts the same root with a trailing slash", async () => {
    const repoRoot = makeRoot();
    writeFileSync(join(repoRoot, "paseo.json"), JSON.stringify({ worktree: { setup: "npm ci" } }));
    const messages: unknown[] = [];
    const session = createSessionForTest({
      messages,
      projectRegistry: { list: vi.fn().mockResolvedValue([createProjectRecord(repoRoot)]) },
    });

    await session.handleMessage({
      type: "read_project_config_request",
      requestId: "read-trailing-slash-1",
      repoRoot: `${repoRoot}/`,
    });

    expect(messages).toEqual([
      {
        type: "read_project_config_response",
        payload: {
          requestId: "read-trailing-slash-1",
          repoRoot,
          ok: true,
          config: { worktree: { setup: "npm ci" } },
          revision: expect.objectContaining({
            mtimeMs: expect.any(Number),
            size: expect.any(Number),
          }),
        },
      },
    ]);
  });

  // POSIX-only: creates a directory symlink without Windows privileges.
  test.skipIf(isPlatform("win32"))(
    "read_project_config_request accepts a symlink to an active project root",
    async () => {
      const repoRoot = makeRoot();
      writeFileSync(
        join(repoRoot, "paseo.json"),
        JSON.stringify({ worktree: { setup: "npm ci" } }),
      );
      const linkRoot = join(makeRoot(), "link");
      symlinkSync(repoRoot, linkRoot, "dir");
      const messages: unknown[] = [];
      const session = createSessionForTest({
        messages,
        projectRegistry: { list: vi.fn().mockResolvedValue([createProjectRecord(repoRoot)]) },
      });

      await session.handleMessage({
        type: "read_project_config_request",
        requestId: "read-symlink-1",
        repoRoot: linkRoot,
      });

      expect(messages).toEqual([
        {
          type: "read_project_config_response",
          payload: {
            requestId: "read-symlink-1",
            repoRoot,
            ok: true,
            config: { worktree: { setup: "npm ci" } },
            revision: expect.objectContaining({
              mtimeMs: expect.any(Number),
              size: expect.any(Number),
            }),
          },
        },
      ]);
    },
  );

  test("read_project_config_request rejects archived and unknown roots with project_not_found", async () => {
    const archivedRoot = makeRoot();
    const unknownRoot = makeRoot();
    const messages: unknown[] = [];
    const session = createSessionForTest({
      messages,
      projectRegistry: {
        list: vi
          .fn()
          .mockResolvedValue([createProjectRecord(archivedRoot, "2026-01-02T00:00:00.000Z")]),
      },
    });

    await session.handleMessage({
      type: "read_project_config_request",
      requestId: "archived-1",
      repoRoot: archivedRoot,
    });
    await session.handleMessage({
      type: "read_project_config_request",
      requestId: "unknown-1",
      repoRoot: unknownRoot,
    });

    expect(messages).toEqual([
      {
        type: "read_project_config_response",
        payload: {
          requestId: "archived-1",
          repoRoot: archivedRoot,
          ok: false,
          error: { code: "project_not_found" },
        },
      },
      {
        type: "read_project_config_response",
        payload: {
          requestId: "unknown-1",
          repoRoot: unknownRoot,
          ok: false,
          error: { code: "project_not_found" },
        },
      },
    ]);
  });

  test("read_project_config_request emits raw lifecycle forms for a known project root", async () => {
    const repoRoot = makeRoot();
    writeFileSync(
      join(repoRoot, "paseo.json"),
      JSON.stringify({ worktree: { setup: "npm install", teardown: ["npm run clean"] } }),
    );
    const messages: unknown[] = [];
    const session = createSessionForTest({
      messages,
      projectRegistry: { list: vi.fn().mockResolvedValue([createProjectRecord(repoRoot)]) },
    });

    await session.handleMessage({
      type: "read_project_config_request",
      requestId: "read-1",
      repoRoot,
    });

    expect(messages).toEqual([
      {
        type: "read_project_config_response",
        payload: {
          requestId: "read-1",
          repoRoot,
          ok: true,
          config: { worktree: { setup: "npm install", teardown: ["npm run clean"] } },
          revision: expect.objectContaining({
            mtimeMs: expect.any(Number),
            size: expect.any(Number),
          }),
        },
      },
    ]);
  });

  test("write_project_config_request emits stale and write-failed inline domain failures", async () => {
    const staleRoot = makeRoot();
    writeFileSync(join(staleRoot, "paseo.json"), JSON.stringify({ worktree: { setup: "old" } }));
    const writeFailedRoot = join(makeRoot(), "not-a-directory");
    writeFileSync(writeFailedRoot, "file");
    const messages: unknown[] = [];
    const session = createSessionForTest({
      messages,
      projectRegistry: {
        list: vi
          .fn()
          .mockResolvedValue([
            createProjectRecord(staleRoot),
            createProjectRecord(writeFailedRoot),
          ]),
      },
    });

    await session.handleMessage({
      type: "write_project_config_request",
      requestId: "stale-1",
      repoRoot: staleRoot,
      config: { worktree: { setup: "new" } },
      expectedRevision: { mtimeMs: 1, size: 1 },
    });
    await session.handleMessage({
      type: "write_project_config_request",
      requestId: "write-failed-1",
      repoRoot: writeFailedRoot,
      config: { worktree: { setup: "new" } },
      expectedRevision: null,
    });

    expect(messages).toEqual([
      {
        type: "write_project_config_response",
        payload: {
          requestId: "stale-1",
          repoRoot: staleRoot,
          ok: false,
          error: {
            code: "stale_project_config",
            currentRevision: expect.objectContaining({
              mtimeMs: expect.any(Number),
              size: expect.any(Number),
            }),
          },
        },
      },
      {
        type: "write_project_config_response",
        payload: {
          requestId: "write-failed-1",
          repoRoot: writeFailedRoot,
          ok: false,
          error: { code: "write_failed" },
        },
      },
    ]);
  });
});

test("push token registration can be revoked by the connected client", async () => {
  const renewed: string[] = [];
  const revoked: string[] = [];
  const messages: unknown[] = [];
  const session = createSessionForTest({
    messages,
    pushNotifications: asPushNotifications({
      renew: (token: string) => renewed.push(token),
      revoke: (token: string) => revoked.push(token),
    }),
  });

  await session.handleMessage({
    type: "register_push_token",
    token: "ExponentPushToken[test-device]",
  });
  await session.handleMessage({
    type: "push.unregister.request",
    token: "ExponentPushToken[test-device]",
    requestId: "revoke-1",
  });
  await session.handleMessage({
    type: "client_heartbeat",
    deviceType: "mobile",
    focusedAgentId: null,
    lastActivityAt: "2026-08-10T00:00:00.000Z",
    appVisible: false,
  });

  expect(renewed).toEqual(["ExponentPushToken[test-device]"]);
  expect(revoked).toEqual(["ExponentPushToken[test-device]"]);
  expect(messages).toEqual([
    {
      type: "push.unregister.response",
      payload: { requestId: "revoke-1" },
    },
  ]);
});

test("push token revocation only acknowledges durable removal", async () => {
  const renewed: string[] = [];
  const messages: SessionOutboundMessage[] = [];
  const session = createSessionForTest({
    messages,
    pushNotifications: asPushNotifications({
      renew: (token: string) => renewed.push(token),
      revoke: () => {
        throw new Error("disk full");
      },
    }),
  });

  await session.handleMessage({
    type: "register_push_token",
    token: "ExponentPushToken[test-device]",
  });
  await session.handleMessage({
    type: "push.unregister.request",
    token: "ExponentPushToken[test-device]",
    requestId: "revoke-failed",
  });
  await session.handleMessage({
    type: "client_heartbeat",
    deviceType: "mobile",
    focusedAgentId: null,
    lastActivityAt: "2026-08-10T00:00:00.000Z",
    appVisible: false,
  });

  expect(renewed).toEqual(["ExponentPushToken[test-device]", "ExponentPushToken[test-device]"]);
  expect(messages.some((message) => message.type === "push.unregister.response")).toBe(false);
  expect(messages).toContainEqual({
    type: "rpc_error",
    payload: {
      requestId: "revoke-failed",
      requestType: "push.unregister.request",
      error: "Request failed: disk full",
      code: "handler_error",
    },
  });
});

describe("daemon status + pairing RPC", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeHome(): string {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "daemon-session-test-")));
    tempDirs.push(home);
    return home;
  }

  test("daemon.get_status.request reports identity, runtime config, and mapped providers", async () => {
    const messages: unknown[] = [];
    const session = createSessionForTest({
      messages,
      paseoHome: makeHome(),
      serverId: "srv-test",
      daemonVersion: "9.9.9",
      daemonRuntimeConfig: { listen: "127.0.0.1:6767", getRelayConfig: () => null },
      agentManager: {
        listProviderAvailability: vi.fn().mockResolvedValue([
          { provider: "claude", available: true },
          { provider: "codex", available: false, error: "boom" },
        ]),
      },
    });

    await session.handleMessage({ type: "daemon.get_status.request", requestId: "status-1" });

    expect(messages).toEqual([
      {
        type: "daemon.get_status.response",
        payload: {
          requestId: "status-1",
          serverId: "srv-test",
          version: "9.9.9",
          pid: process.pid,
          nodePath: process.execPath,
          startedAt: null,
          listen: "127.0.0.1:6767",
          relay: null,
          providers: [
            { provider: "claude", available: true, error: null },
            { provider: "codex", available: false, error: "boom" },
          ],
        },
      },
    ]);
  });

  test("daemon.get_status.request falls back to a null/empty status when provider listing fails", async () => {
    const messages: unknown[] = [];
    const session = createSessionForTest({
      messages,
      paseoHome: makeHome(),
      serverId: "srv-test",
      daemonVersion: "9.9.9",
      daemonRuntimeConfig: { listen: "127.0.0.1:6767", getRelayConfig: () => null },
      agentManager: {
        listProviderAvailability: vi.fn().mockRejectedValue(new Error("provider listing failed")),
      },
    });

    await session.handleMessage({
      type: "daemon.get_status.request",
      requestId: "status-fallback-1",
    });

    expect(messages).toEqual([
      {
        type: "daemon.get_status.response",
        payload: {
          requestId: "status-fallback-1",
          serverId: "srv-test",
          version: "9.9.9",
          pid: process.pid,
          nodePath: process.execPath,
          startedAt: null,
          listen: null,
          relay: null,
          providers: [],
        },
      },
    ]);
  });

  test("daemon.get_pairing_offer.request returns an empty offer when relay is disabled", async () => {
    const messages: unknown[] = [];
    const session = createSessionForTest({
      messages,
      paseoHome: makeHome(),
      daemonRuntimeConfig: {
        listen: "127.0.0.1:6767",
        getRelayConfig: () => ({
          enabled: false,
          endpoint: "relay.paseo.sh:443",
          publicEndpoint: "relay.paseo.sh:443",
          useTls: true,
          publicUseTls: true,
        }),
      },
    });

    await session.handleMessage({
      type: "daemon.get_pairing_offer.request",
      requestId: "pairing-1",
    });

    expect(messages).toEqual([
      {
        type: "daemon.get_pairing_offer.response",
        payload: {
          requestId: "pairing-1",
          url: "",
          qr: null,
          relayEnabled: false,
        },
      },
    ]);
  });
});

function createWorkspaceGitSnapshot(
  cwd: string,
  overrides?: {
    git?: Record<string, unknown>;
    forge?: Record<string, unknown>;
  },
) {
  return {
    cwd,
    git: {
      isGit: true,
      repoRoot: cwd,
      mainRepoRoot: null,
      currentBranch: "feature/service",
      remoteUrl: "https://github.com/getpaseo/paseo.git",
      isPaseoOwnedWorktree: false,
      isDirty: true,
      baseRef: "main",
      aheadBehind: { ahead: 2, behind: 1 },
      aheadOfOrigin: 2,
      behindOfOrigin: 1,
      hasRemote: true,
      diffStat: { additions: 3, deletions: 1 },
      ...overrides?.git,
    },
    forge: {
      featuresEnabled: false,
      pullRequest: null,
      error: null,
      ...overrides?.forge,
    },
  };
}

function createTerminalManagerStub(options?: { setTerminalTitle?: ReturnType<typeof vi.fn> }): {
  setTerminalTitle: ReturnType<typeof vi.fn>;
  subscribeTerminalsChanged: ReturnType<typeof vi.fn>;
  subscribeTerminalWorkspaceContributionChanged: ReturnType<typeof vi.fn>;
} {
  return {
    setTerminalTitle: options?.setTerminalTitle ?? vi.fn(),
    subscribeTerminalsChanged: vi.fn(() => () => {}),
    subscribeTerminalWorkspaceContributionChanged: vi.fn(() => () => {}),
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("session provider refresh cwd routing", () => {
  test("routes no-cwd provider snapshot refreshes through settings refresh", async () => {
    const {
      manager: providerSnapshotManager,
      refreshSettingsSnapshot,
      refreshSnapshotForCwd,
    } = createProviderSnapshotManagerStub();
    const session = createSessionForTest({ providerSnapshotManager });

    await session.handleMessage({
      type: "refresh_providers_snapshot_request",
      providers: ["codex"],
      requestId: "refresh-settings",
    });

    expect(refreshSettingsSnapshot).toHaveBeenCalledWith({
      providers: ["codex"],
    });
    expect(refreshSnapshotForCwd).not.toHaveBeenCalled();
  });

  test("routes cwd provider snapshot refreshes through workspace refresh", async () => {
    const {
      manager: providerSnapshotManager,
      refreshSnapshotForCwd,
      refreshSettingsSnapshot,
    } = createProviderSnapshotManagerStub();
    const session = createSessionForTest({ providerSnapshotManager });

    await session.handleMessage({
      type: "refresh_providers_snapshot_request",
      cwd: "/tmp/workspace-refresh",
      providers: ["codex"],
      requestId: "refresh-workspace",
    });

    expect(refreshSnapshotForCwd).toHaveBeenCalledWith({
      cwd: "/tmp/workspace-refresh",
      providers: ["codex"],
    });
    expect(refreshSettingsSnapshot).not.toHaveBeenCalled();
  });

  test("get_providers_snapshot_request forwards cwd to the provider authority", async () => {
    const messages: unknown[] = [];
    const workspaceCwd = resolvePath("/tmp/session-provider-snapshot");
    const { manager: providerSnapshotManager, getSnapshot } = createProviderSnapshotManagerStub();
    const session = createSessionForTest({ messages, providerSnapshotManager });

    await session.handleMessage({
      type: "get_providers_snapshot_request",
      cwd: workspaceCwd,
      requestId: "snapshot-workspace",
    });

    expect(getSnapshot).toHaveBeenCalledWith(workspaceCwd);
  });

  test("preserves legacy model and mode list requests without cwd as global", async () => {
    const messages: unknown[] = [];
    const {
      manager: providerSnapshotManager,
      getSnapshot,
      warmUpSnapshotForCwd,
    } = createProviderSnapshotManagerStub();
    getSnapshot.mockReturnValue([
      {
        provider: "codex",
        status: "loading",
        enabled: true,
      },
    ]);
    const session = createSessionForTest({ messages, providerSnapshotManager });

    await session.handleMessage({
      type: "list_provider_models_request",
      provider: "codex",
      requestId: "models-home",
    });
    await session.handleMessage({
      type: "list_provider_modes_request",
      provider: "codex",
      requestId: "modes-home",
    });

    expect(getSnapshot).toHaveBeenCalledWith(undefined);
    expect(warmUpSnapshotForCwd).toHaveBeenCalledWith({
      cwd: undefined,
      providers: ["codex"],
    });
  });

  test("legacy model list request treats disabled snapshot entries as unavailable without warming", async () => {
    const messages: unknown[] = [];
    const { manager: providerSnapshotManager, warmUpSnapshotForCwd } =
      createProviderSnapshotManagerStub();
    providerSnapshotManager.getSnapshot = vi.fn(() => [
      {
        provider: "codex",
        status: "loading",
        enabled: false,
      },
    ]);
    const session = createSessionForTest({ messages, providerSnapshotManager });

    await session.handleMessage({
      type: "list_provider_models_request",
      provider: "codex",
      requestId: "models-disabled",
    });

    expect(warmUpSnapshotForCwd).not.toHaveBeenCalled();
    expect(messages).toContainEqual({
      type: "list_provider_models_response",
      payload: {
        provider: "codex",
        error: "Provider codex is disabled",
        fetchedAt: expect.any(String),
        requestId: "models-disabled",
      },
    });
  });

  test("legacy mode list request treats disabled snapshot entries as unavailable without warming", async () => {
    const messages: unknown[] = [];
    const { manager: providerSnapshotManager, warmUpSnapshotForCwd } =
      createProviderSnapshotManagerStub();
    providerSnapshotManager.getSnapshot = vi.fn(() => [
      {
        provider: "codex",
        status: "loading",
        enabled: false,
      },
    ]);
    const session = createSessionForTest({ messages, providerSnapshotManager });

    await session.handleMessage({
      type: "list_provider_modes_request",
      provider: "codex",
      requestId: "modes-disabled",
    });

    expect(warmUpSnapshotForCwd).not.toHaveBeenCalled();
    expect(messages).toContainEqual({
      type: "list_provider_modes_response",
      payload: {
        provider: "codex",
        error: "Provider codex is disabled",
        fetchedAt: expect.any(String),
        requestId: "modes-disabled",
      },
    });
  });

  test("list_provider_models_request awaits warmup and emits ready models", async () => {
    const messages: unknown[] = [];
    const warmupDeferred = deferred<void>();
    const {
      manager: providerSnapshotManager,
      getSnapshot,
      warmUpSnapshotForCwd,
    } = createProviderSnapshotManagerStub();
    getSnapshot.mockReturnValueOnce([
      {
        provider: "codex",
        status: "loading",
        enabled: true,
      },
    ]);
    getSnapshot.mockReturnValue([
      {
        provider: "codex",
        status: "ready",
        enabled: true,
        models: [{ provider: "codex", id: "gpt-5.4", label: "GPT-5.4" }],
        modes: [],
        fetchedAt: "2026-05-28T00:00:00.000Z",
      },
    ]);
    warmUpSnapshotForCwd.mockReturnValue(warmupDeferred.promise);
    const session = createSessionForTest({ messages, providerSnapshotManager });

    const responsePromise = session.handleMessage({
      type: "list_provider_models_request",
      provider: "codex",
      requestId: "models-loading-home",
    });

    expect(warmUpSnapshotForCwd).toHaveBeenCalledWith({
      cwd: undefined,
      providers: ["codex"],
    });
    warmupDeferred.resolve();
    await responsePromise;

    expect(messages).toContainEqual({
      type: "list_provider_models_response",
      payload: {
        provider: "codex",
        models: [
          {
            provider: "codex",
            id: "gpt-5.4",
            label: "GPT-5.4",
          },
        ],
        error: null,
        fetchedAt: "2026-05-28T00:00:00.000Z",
        requestId: "models-loading-home",
      },
    });
  });
});

describe("session checkout merge handling", () => {
  test("uses workspace git service snapshot for merge-to-base preflight", async () => {
    const messages: unknown[] = [];
    const github = { invalidate: vi.fn() };
    const checkoutDiffManager = { scheduleRefreshForCwd: vi.fn() };
    const workspaceGitService = {
      getSnapshot: vi.fn().mockResolvedValue(
        createWorkspaceGitSnapshot("/tmp/request-worktree", {
          git: {
            isGit: true,
            baseRef: "main",
            isDirty: false,
          },
        }),
      ),
    };
    const session = createSessionForTest({
      github,
      checkoutDiffManager,
      workspaceGitService,
      messages,
    });

    checkoutGitMocks.mergeToBase.mockResolvedValue("/tmp/base-worktree");

    await session.handleMessage({
      type: "checkout_merge_request",
      cwd: "/tmp/request-worktree",
      baseRef: "main",
      requestId: "request-1",
    });

    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith("/tmp/request-worktree");
    expect(checkoutGitMocks.getCheckoutStatus).not.toHaveBeenCalled();
    expect(checkoutGitMocks.mergeToBase).toHaveBeenCalledWith(
      "/tmp/request-worktree",
      {
        baseRef: "main",
        mode: "merge",
      },
      { paseoHome: "/tmp/paseo-home" },
    );
    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith("/tmp/base-worktree", {
      force: true,
      reason: "merge-to-base",
    });
    expect(github.invalidate).toHaveBeenCalledTimes(1);
    expect(github.invalidate).toHaveBeenCalledWith({ cwd: "/tmp/base-worktree" });
    expect(checkoutDiffManager.scheduleRefreshForCwd).toHaveBeenCalledWith("/tmp/request-worktree");
    expect(messages).toContainEqual({
      type: "checkout_merge_response",
      payload: {
        cwd: "/tmp/request-worktree",
        success: true,
        error: null,
        requestId: "request-1",
      },
    });
  });

  test("uses snapshot dirty state for merge-from-base clean target preflight", async () => {
    const messages: unknown[] = [];
    const workspaceGitService = {
      getSnapshot: vi.fn().mockResolvedValue(
        createWorkspaceGitSnapshot("/tmp/request-worktree", {
          git: {
            isDirty: true,
          },
        }),
      ),
    };
    const session = createSessionForTest({ workspaceGitService, messages });

    await session.handleMessage({
      type: "checkout_merge_from_base_request",
      cwd: "/tmp/request-worktree",
      baseRef: "main",
      requireCleanTarget: true,
      requestId: "request-merge-from-base",
    });

    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith("/tmp/request-worktree");
    expect(messages).toContainEqual({
      type: "checkout_merge_from_base_response",
      payload: {
        cwd: "/tmp/request-worktree",
        success: false,
        error: {
          code: "UNKNOWN",
          message: "Working directory has uncommitted changes.",
        },
        requestId: "request-merge-from-base",
      },
    });
  });

  test("forces a workspace git snapshot refresh after merge-from-base succeeds", async () => {
    const messages: unknown[] = [];
    const github = { invalidate: vi.fn() };
    const workspaceGitService = {
      getSnapshot: vi.fn().mockResolvedValue(
        createWorkspaceGitSnapshot("/tmp/request-worktree", {
          git: {
            isDirty: false,
          },
        }),
      ),
    };
    const session = createSessionForTest({ github, workspaceGitService, messages });
    checkoutGitMocks.mergeFromBase.mockResolvedValue(undefined);

    await session.handleMessage({
      type: "checkout_merge_from_base_request",
      cwd: "/tmp/request-worktree",
      baseRef: "main",
      requireCleanTarget: true,
      requestId: "request-merge-from-base-success",
    });

    expect(checkoutGitMocks.mergeFromBase).toHaveBeenCalledWith("/tmp/request-worktree", {
      baseRef: "main",
      requireCleanTarget: true,
    });
    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith("/tmp/request-worktree", {
      force: true,
      reason: "merge-from-base",
    });
    expect(github.invalidate).toHaveBeenCalledWith({ cwd: "/tmp/request-worktree" });
    expect(messages).toContainEqual({
      type: "checkout_merge_from_base_response",
      payload: {
        cwd: "/tmp/request-worktree",
        success: true,
        error: null,
        requestId: "request-merge-from-base-success",
      },
    });
  });
});

describe("session checkout commit handling", () => {
  const tempDirs: string[] = [];
  const PRE_CHANGE_COMMIT_PROMPT = `Write a concise git commit message for the changes below.

Concise, imperative mood, no trailing period.

Return JSON only with a single field 'message'.

Files changed:
M\tfile.txt\t(+1 -0)

diff --git a/file.txt b/file.txt
+hello
`;

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeRoot(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "commit-metadata-session-test-")));
    tempDirs.push(root);
    return root;
  }

  function writeConfig(repoRoot: string, config: unknown): void {
    writeFileSync(join(repoRoot, "paseo.json"), `${JSON.stringify(config)}\n`);
  }

  async function generateCommitPromptWithConfig(config: unknown): Promise<string> {
    const repoRoot = makeRoot();
    if (typeof config === "string") {
      writeFileSync(join(repoRoot, "paseo.json"), config);
    } else if (config !== undefined) {
      writeConfig(repoRoot, config);
    }

    const workspaceGitService = {
      getCheckoutDiff: vi.fn().mockResolvedValue({
        diff: "diff --git a/file.txt b/file.txt\n+hello\n",
        structured: [
          {
            path: "file.txt",
            additions: 1,
            deletions: 0,
            isNew: false,
            isDeleted: false,
            hunks: [],
            status: "ok",
          },
        ],
      }),
      getSnapshot: vi.fn().mockResolvedValue({}),
      resolveRepoRoot: vi.fn().mockResolvedValue(repoRoot),
    };
    agentResponseMocks.generateStructuredAgentResponseWithFallback.mockResolvedValue({
      message: "Update file",
    });
    checkoutGitMocks.commitChanges.mockResolvedValue(undefined);
    const session = createSessionForTest({ workspaceGitService });

    await session.handleMessage({
      type: "checkout_commit_request",
      cwd: join(repoRoot, "nested"),
      message: "",
      addAll: true,
      requestId: "request-generated-commit",
    });

    return String(
      agentResponseMocks.generateStructuredAgentResponseWithFallback.mock.calls[0]?.[0].prompt,
    );
  }

  test("forces a workspace git snapshot refresh after committing", async () => {
    const messages: unknown[] = [];
    const checkoutDiffManager = { scheduleRefreshForCwd: vi.fn() };
    const workspaceGitService = { getSnapshot: vi.fn().mockResolvedValue({}) };
    const session = createSessionForTest({ checkoutDiffManager, workspaceGitService, messages });

    checkoutGitMocks.commitChanges.mockResolvedValue(undefined);

    await session.handleMessage({
      type: "checkout_commit_request",
      cwd: "/tmp/request-worktree",
      message: "Ship it",
      addAll: true,
      requestId: "request-commit",
    });

    expect(checkoutGitMocks.commitChanges).toHaveBeenCalledWith("/tmp/request-worktree", {
      message: "Ship it",
      addAll: true,
    });
    expect(workspaceGitService.getSnapshot).toHaveBeenCalledTimes(1);
    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith("/tmp/request-worktree", {
      force: true,
      reason: "commit-changes",
    });
    expect(checkoutDiffManager.scheduleRefreshForCwd).toHaveBeenCalledWith("/tmp/request-worktree");
    expect(messages).toContainEqual({
      type: "checkout_commit_response",
      payload: {
        cwd: "/tmp/request-worktree",
        success: true,
        error: null,
        requestId: "request-commit",
      },
    });
  });

  test("generates commit messages from checkout diffs read through the workspace git service", async () => {
    const messages: unknown[] = [];
    const workspaceGitService = {
      getCheckoutDiff: vi.fn().mockResolvedValue({
        diff: "diff --git a/file.txt b/file.txt\n+hello\n",
        structured: [
          {
            path: "file.txt",
            additions: 1,
            deletions: 0,
            isNew: false,
            isDeleted: false,
            hunks: [],
            status: "ok",
          },
        ],
      }),
      getSnapshot: vi.fn().mockResolvedValue({}),
    };
    agentResponseMocks.generateStructuredAgentResponseWithFallback.mockResolvedValue({
      message: "Update file",
    });
    checkoutGitMocks.commitChanges.mockResolvedValue(undefined);
    const session = createSessionForTest({ workspaceGitService, messages });

    await session.handleMessage({
      type: "checkout_commit_request",
      cwd: "/tmp/request-worktree",
      message: "",
      addAll: true,
      requestId: "request-generated-commit",
    });

    expect(workspaceGitService.getCheckoutDiff).toHaveBeenCalledTimes(1);
    expect(workspaceGitService.getCheckoutDiff).toHaveBeenCalledWith("/tmp/request-worktree", {
      mode: "uncommitted",
      includeStructured: true,
    });
    expect(agentResponseMocks.generateStructuredAgentResponseWithFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        persistSession: false,
        agentConfigOverrides: expect.objectContaining({
          title: "Commit generator",
          internal: true,
        }),
      }),
    );
    expect(checkoutGitMocks.commitChanges).toHaveBeenCalledWith("/tmp/request-worktree", {
      message: "Update file",
      addAll: true,
    });
    expect(messages).toContainEqual({
      type: "checkout_commit_response",
      payload: {
        cwd: "/tmp/request-worktree",
        success: true,
        error: null,
        requestId: "request-generated-commit",
      },
    });
  });

  test.each([
    ["paseo.json missing", undefined],
    ["paseo.json exists but invalid JSON", "{ nope"],
    ["paseo.json valid but missing metadataGeneration", {}],
    ["metadataGeneration is schema-invalid", { metadataGeneration: "not an object" }],
    [
      "metadataGeneration exists but missing commitMessage",
      { metadataGeneration: { pullRequest: { instructions: "Write a punchy PR." } } },
    ],
    [
      "commitMessage exists but instructions is undefined",
      { metadataGeneration: { commitMessage: {} } },
    ],
    [
      "commitMessage exists but instructions is empty",
      { metadataGeneration: { commitMessage: { instructions: "" } } },
    ],
    [
      "commitMessage exists but instructions is whitespace-only",
      { metadataGeneration: { commitMessage: { instructions: "   \n\t " } } },
    ],
  ])("renders the default commit style when no override applies (%s)", async (_name, config) => {
    const prompt = await generateCommitPromptWithConfig(config);

    expect(prompt).toBe(PRE_CHANGE_COMMIT_PROMPT);
  });

  test("commit instructions replace the default commit style", async () => {
    const prompt = await generateCommitPromptWithConfig({
      metadataGeneration: {
        commitMessage: {
          instructions: "Use conventional commits.\nAccept XML-ish <scope> text.",
        },
      },
    });

    expect(prompt).toContain("Use conventional commits.\nAccept XML-ish <scope> text.");
    expect(prompt).not.toContain("Concise, imperative mood, no trailing period.");

    const contractIndex = prompt.indexOf("Write a concise git commit message");
    const styleIndex = prompt.indexOf("Use conventional commits.");
    const jsonContractIndex = prompt.indexOf("Return JSON only");
    const fileListIndex = prompt.indexOf("Files changed:");
    const patchIndex = prompt.indexOf("diff --git");

    expect(contractIndex).toBeGreaterThanOrEqual(0);
    expect(contractIndex).toBeLessThan(styleIndex);
    expect(styleIndex).toBeLessThan(jsonContractIndex);
    expect(jsonContractIndex).toBeLessThan(fileListIndex);
    expect(fileListIndex).toBeLessThan(patchIndex);
  });

  test("keeps the commit fallback when structured generation fails", async () => {
    const messages: unknown[] = [];
    const workspaceGitService = {
      getCheckoutDiff: vi.fn().mockResolvedValue({
        diff: "diff --git a/file.txt b/file.txt\n+hello\n",
        structured: [],
      }),
      getSnapshot: vi.fn().mockResolvedValue({}),
      resolveRepoRoot: vi.fn().mockResolvedValue(makeRoot()),
    };
    agentResponseMocks.generateStructuredAgentResponseWithFallback.mockRejectedValue(
      new StructuredAgentFallbackError([]),
    );
    checkoutGitMocks.commitChanges.mockResolvedValue(undefined);
    const session = createSessionForTest({ workspaceGitService, messages });

    await session.handleMessage({
      type: "checkout_commit_request",
      cwd: "/tmp/request-worktree",
      message: "",
      addAll: true,
      requestId: "request-generated-commit-fallback",
    });

    expect(checkoutGitMocks.commitChanges).toHaveBeenCalledWith("/tmp/request-worktree", {
      message: "Update files",
      addAll: true,
    });
    expect(messages).toContainEqual({
      type: "checkout_commit_response",
      payload: {
        cwd: "/tmp/request-worktree",
        success: true,
        error: null,
        requestId: "request-generated-commit-fallback",
      },
    });
  });

  test("does not force a workspace git snapshot refresh when commit fails", async () => {
    const messages: unknown[] = [];
    const workspaceGitService = { getSnapshot: vi.fn().mockResolvedValue({}) };
    const session = createSessionForTest({ workspaceGitService, messages });
    checkoutGitMocks.commitChanges.mockRejectedValue(new Error("nothing to commit"));

    await session.handleMessage({
      type: "checkout_commit_request",
      cwd: "/tmp/request-worktree",
      message: "Ship it",
      addAll: true,
      requestId: "request-commit-failure",
    });

    expect(workspaceGitService.getSnapshot).not.toHaveBeenCalled();
    expect(messages).toContainEqual({
      type: "checkout_commit_response",
      payload: {
        cwd: "/tmp/request-worktree",
        success: false,
        error: {
          code: "UNKNOWN",
          message: "nothing to commit",
        },
        requestId: "request-commit-failure",
      },
    });
  });
});

describe("session checkout pull request creation", () => {
  const tempDirs: string[] = [];
  const PRE_CHANGE_PULL_REQUEST_PROMPT = `Write a pull request title and body for the changes below.

Clear, descriptive title; body explaining what changed and why.

Return JSON only with fields 'title' and 'body'.

Files changed:
M\tfile.txt\t(+1 -0)

diff --git a/file.txt b/file.txt
+hello
`;

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeRoot(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pr-metadata-session-test-")));
    tempDirs.push(root);
    return root;
  }

  function writeConfig(repoRoot: string, config: unknown): void {
    writeFileSync(join(repoRoot, "paseo.json"), `${JSON.stringify(config)}\n`);
  }

  async function generatePullRequestCallWithConfig(config: unknown): Promise<unknown> {
    const repoRoot = makeRoot();
    if (typeof config === "string") {
      writeFileSync(join(repoRoot, "paseo.json"), config);
    } else if (config !== undefined) {
      writeConfig(repoRoot, config);
    }

    const workspaceGitService = {
      getCheckoutDiff: vi.fn().mockResolvedValue({
        diff: "diff --git a/file.txt b/file.txt\n+hello\n",
        structured: [
          {
            path: "file.txt",
            additions: 1,
            deletions: 0,
            isNew: false,
            isDeleted: false,
            hunks: [],
            status: "ok",
          },
        ],
      }),
      resolveRepoRoot: vi.fn().mockResolvedValue(repoRoot),
    };
    agentResponseMocks.generateStructuredAgentResponseWithFallback.mockResolvedValue({
      title: "Update file",
      body: "Updates file.",
    });
    checkoutGitMocks.createPullRequest.mockResolvedValue({
      url: "https://github.com/getpaseo/paseo/pull/1",
      number: 1,
    });
    const session = createSessionForTest({ workspaceGitService });

    await session.handleMessage({
      type: "checkout_pr_create_request",
      cwd: join(repoRoot, "nested"),
      baseRef: "main",
      title: "",
      body: "",
      requestId: "request-generated-pr",
    });

    return agentResponseMocks.generateStructuredAgentResponseWithFallback.mock.calls[0]?.[0];
  }

  async function generatePullRequestPromptWithConfig(config: unknown): Promise<string> {
    const call = await generatePullRequestCallWithConfig(config);
    return String((call as { prompt?: unknown } | undefined)?.prompt);
  }

  test("generates PR text from checkout diffs read through the workspace git service", async () => {
    const messages: unknown[] = [];
    const workspaceGitService = {
      getCheckoutDiff: vi.fn().mockResolvedValue({
        diff: "diff --git a/file.txt b/file.txt\n+hello\n",
        structured: [
          {
            path: "file.txt",
            additions: 1,
            deletions: 0,
            isNew: false,
            isDeleted: false,
            hunks: [],
            status: "ok",
          },
        ],
      }),
    };
    agentResponseMocks.generateStructuredAgentResponseWithFallback.mockResolvedValue({
      title: "Update file",
      body: "Updates file.",
    });
    checkoutGitMocks.createPullRequest.mockResolvedValue({
      url: "https://github.com/getpaseo/paseo/pull/1",
      number: 1,
    });
    const session = createSessionForTest({ workspaceGitService, messages });

    await session.handleMessage({
      type: "checkout_pr_create_request",
      cwd: "/tmp/request-worktree",
      baseRef: "main",
      title: "",
      body: "",
      requestId: "request-generated-pr",
    });

    expect(workspaceGitService.getCheckoutDiff).toHaveBeenCalledTimes(1);
    expect(workspaceGitService.getCheckoutDiff).toHaveBeenCalledWith("/tmp/request-worktree", {
      mode: "base",
      baseRef: "main",
      includeStructured: true,
    });
    expect(agentResponseMocks.generateStructuredAgentResponseWithFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        persistSession: false,
        agentConfigOverrides: expect.objectContaining({
          title: "PR generator",
          internal: true,
        }),
      }),
    );
    expect(checkoutGitMocks.createPullRequest).toHaveBeenCalledWith(
      "/tmp/request-worktree",
      {
        title: "Update file",
        body: "Updates file.",
        base: "main",
      },
      expect.anything(),
    );
    expect(messages).toContainEqual({
      type: "checkout_pr_create_response",
      payload: {
        cwd: "/tmp/request-worktree",
        url: "https://github.com/getpaseo/paseo/pull/1",
        number: 1,
        error: null,
        requestId: "request-generated-pr",
      },
    });
  });

  test.each([
    ["paseo.json missing", undefined],
    ["paseo.json exists but invalid JSON", "{ nope"],
    ["paseo.json valid but missing metadataGeneration", {}],
    ["metadataGeneration is schema-invalid", { metadataGeneration: "not an object" }],
    [
      "metadataGeneration exists but missing pullRequest",
      { metadataGeneration: { commitMessage: { instructions: "Use conventional commits." } } },
    ],
    [
      "pullRequest exists but instructions is undefined",
      { metadataGeneration: { pullRequest: {} } },
    ],
    [
      "pullRequest exists but instructions is empty",
      { metadataGeneration: { pullRequest: { instructions: "" } } },
    ],
    [
      "pullRequest exists but instructions is whitespace-only",
      { metadataGeneration: { pullRequest: { instructions: "   \n\t " } } },
    ],
  ])("renders the default PR style when no override applies (%s)", async (_name, config) => {
    const prompt = await generatePullRequestPromptWithConfig(config);

    expect(prompt).toBe(PRE_CHANGE_PULL_REQUEST_PROMPT);
  });

  test("PR instructions replace the default PR style", async () => {
    const prompt = await generatePullRequestPromptWithConfig({
      metadataGeneration: {
        pullRequest: {
          instructions: "Use a terse title.\nKeep literal <ticket> text.",
        },
      },
    });

    expect(prompt).toContain("Use a terse title.\nKeep literal <ticket> text.");
    expect(prompt).not.toContain("Clear, descriptive title; body explaining what changed and why.");

    const contractIndex = prompt.indexOf("Write a pull request title and body");
    const styleIndex = prompt.indexOf("Use a terse title.");
    const jsonContractIndex = prompt.indexOf("Return JSON only");
    const fileListIndex = prompt.indexOf("Files changed:");
    const patchIndex = prompt.indexOf("diff --git");

    expect(contractIndex).toBeGreaterThanOrEqual(0);
    expect(contractIndex).toBeLessThan(styleIndex);
    expect(styleIndex).toBeLessThan(jsonContractIndex);
    expect(jsonContractIndex).toBeLessThan(fileListIndex);
    expect(fileListIndex).toBeLessThan(patchIndex);
  });

  test("keeps PR generation as one structured call with title and body schema", async () => {
    const call = await generatePullRequestCallWithConfig({
      metadataGeneration: {
        pullRequest: {
          instructions: "Use release-note style.",
        },
      },
    });
    const schema = (call as { schema?: { safeParse?: (value: unknown) => { success: boolean } } })
      .schema;

    expect(agentResponseMocks.generateStructuredAgentResponseWithFallback).toHaveBeenCalledTimes(1);
    expect(call).toMatchObject({
      schemaName: "PullRequest",
      persistSession: false,
      agentConfigOverrides: {
        title: "PR generator",
        internal: true,
      },
    });
    expect(schema?.safeParse?.({ title: "Update file", body: "Updates file." }).success).toBe(true);
    expect(schema?.safeParse?.({ title: "Update file" }).success).toBe(false);
  });

  test("keeps the PR fallback when structured generation fails", async () => {
    const messages: unknown[] = [];
    const workspaceGitService = {
      getCheckoutDiff: vi.fn().mockResolvedValue({
        diff: "diff --git a/file.txt b/file.txt\n+hello\n",
        structured: [],
      }),
      resolveRepoRoot: vi.fn().mockResolvedValue(makeRoot()),
    };
    agentResponseMocks.generateStructuredAgentResponseWithFallback.mockRejectedValue(
      new StructuredAgentFallbackError([]),
    );
    checkoutGitMocks.createPullRequest.mockResolvedValue({
      url: "https://github.com/getpaseo/paseo/pull/9",
      number: 9,
    });
    const session = createSessionForTest({ workspaceGitService, messages });

    await session.handleMessage({
      type: "checkout_pr_create_request",
      cwd: "/tmp/request-worktree",
      baseRef: "main",
      title: "",
      body: "",
      requestId: "request-generated-pr-fallback",
    });

    expect(checkoutGitMocks.createPullRequest).toHaveBeenCalledWith(
      "/tmp/request-worktree",
      {
        title: "Update changes",
        body: "Automated PR generated by Paseo.",
        base: "main",
      },
      expect.anything(),
    );
    expect(messages).toContainEqual({
      type: "checkout_pr_create_response",
      payload: {
        cwd: "/tmp/request-worktree",
        url: "https://github.com/getpaseo/paseo/pull/9",
        number: 9,
        error: null,
        requestId: "request-generated-pr-fallback",
      },
    });
  });

  test("forces workspace git and GitHub refresh after creating a pull request", async () => {
    const messages: unknown[] = [];
    const github = { invalidate: vi.fn() };
    const workspaceGitService = {
      getSnapshot: vi.fn().mockResolvedValue({}),
    };
    checkoutGitMocks.createPullRequest.mockResolvedValue({
      url: "https://github.com/getpaseo/paseo/pull/2",
      number: 2,
    });
    const session = createSessionForTest({ github, workspaceGitService, messages });

    await session.handleMessage({
      type: "checkout_pr_create_request",
      cwd: "/tmp/request-worktree",
      baseRef: "main",
      title: "Update file",
      body: "Updates file.",
      requestId: "request-pr-create",
    });

    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith("/tmp/request-worktree", {
      force: true,
      reason: "create-pr",
    });
    expect(github.invalidate).toHaveBeenCalledWith({ cwd: "/tmp/request-worktree" });
    expect(messages).toContainEqual({
      type: "checkout_pr_create_response",
      payload: {
        cwd: "/tmp/request-worktree",
        url: "https://github.com/getpaseo/paseo/pull/2",
        number: 2,
        error: null,
        requestId: "request-pr-create",
      },
    });
  });
});

describe("session checkout pull request merge", () => {
  test("merges the current pull request and refreshes GitHub state", async () => {
    const messages: unknown[] = [];
    const github = {
      invalidate: vi.fn(),
      mergePullRequest: vi.fn().mockResolvedValue({ success: true }),
    };
    const workspaceGitService = {
      getSnapshot: vi.fn().mockResolvedValue({
        forge: {
          pullRequest: {
            number: 42,
            forgeSpecific: {
              forge: "github",
              mergeStateStatus: "CLEAN",
              autoMergeRequest: null,
              viewerCanEnableAutoMerge: false,
              viewerCanDisableAutoMerge: false,
              viewerCanMergeAsAdmin: false,
              viewerCanUpdateBranch: false,
              repository: {
                autoMergeAllowed: true,
                mergeCommitAllowed: true,
                squashMergeAllowed: true,
                rebaseMergeAllowed: true,
                viewerDefaultMergeMethod: "SQUASH",
              },
              isMergeQueueEnabled: false,
              isInMergeQueue: false,
            },
          },
        },
      }),
    };
    const session = createSessionForTest({ github, workspaceGitService, messages });

    await session.handleMessage({
      type: "checkout_pr_merge_request",
      cwd: "/tmp/request-worktree",
      mergeMethod: "squash",
      requestId: "request-pr-merge",
    });

    expect(github.mergePullRequest).toHaveBeenCalledWith({
      cwd: "/tmp/request-worktree",
      prNumber: 42,
      mergeMethod: "squash",
      status: {
        number: 42,
        forgeSpecific: {
          forge: "github",
          mergeStateStatus: "CLEAN",
          autoMergeRequest: null,
          viewerCanEnableAutoMerge: false,
          viewerCanDisableAutoMerge: false,
          viewerCanMergeAsAdmin: false,
          viewerCanUpdateBranch: false,
          repository: {
            autoMergeAllowed: true,
            mergeCommitAllowed: true,
            squashMergeAllowed: true,
            rebaseMergeAllowed: true,
            viewerDefaultMergeMethod: "SQUASH",
          },
          isMergeQueueEnabled: false,
          isInMergeQueue: false,
        },
      },
    });
    expect(workspaceGitService.getSnapshot).toHaveBeenNthCalledWith(1, "/tmp/request-worktree", {
      force: true,
      includeForge: true,
      reason: "merge-pr-validation",
    });
    expect(workspaceGitService.getSnapshot).toHaveBeenNthCalledWith(2, "/tmp/request-worktree", {
      force: true,
      reason: "merge-pr",
    });
    expect(github.invalidate).toHaveBeenCalledWith({ cwd: "/tmp/request-worktree" });
    expect(messages).toContainEqual({
      type: "checkout_pr_merge_response",
      payload: {
        cwd: "/tmp/request-worktree",
        success: true,
        error: null,
        requestId: "request-pr-merge",
      },
    });
  });

  test("rejects direct merge when fresh GitHub facts block a warm clean snapshot", async () => {
    const messages: unknown[] = [];
    const github = {
      invalidate: vi.fn(),
      mergePullRequest: vi.fn(
        async (input: { status?: { forgeSpecific?: { mergeStateStatus?: string | null } } }) => {
          if (input.status?.forgeSpecific?.mergeStateStatus === "BLOCKED") {
            throw new Error("GitHub does not report this pull request as ready for direct merge");
          }
          return { success: true };
        },
      ),
    };
    const createSnapshot = (mergeStateStatus: "CLEAN" | "BLOCKED") => ({
      forge: {
        pullRequest: {
          number: 42,
          forgeSpecific: {
            forge: "github",
            mergeStateStatus,
            autoMergeRequest: null,
            viewerCanEnableAutoMerge: false,
            viewerCanDisableAutoMerge: false,
            viewerCanMergeAsAdmin: false,
            viewerCanUpdateBranch: false,
            repository: {
              autoMergeAllowed: true,
              mergeCommitAllowed: true,
              squashMergeAllowed: true,
              rebaseMergeAllowed: true,
              viewerDefaultMergeMethod: "SQUASH",
            },
            isMergeQueueEnabled: false,
            isInMergeQueue: false,
          },
        },
      },
    });
    const workspaceGitService = {
      getSnapshot: vi.fn(async (_cwd: string, options?: { force?: boolean }) =>
        createSnapshot(options?.force ? "BLOCKED" : "CLEAN"),
      ),
    };
    const session = createSessionForTest({ github, workspaceGitService, messages });

    await session.handleMessage({
      type: "checkout_pr_merge_request",
      cwd: "/tmp/request-worktree",
      mergeMethod: "squash",
      requestId: "request-pr-merge-fresh-blocked",
    });

    expect(workspaceGitService.getSnapshot).toHaveBeenCalledTimes(1);
    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith("/tmp/request-worktree", {
      force: true,
      includeForge: true,
      reason: "merge-pr-validation",
    });
    expect(github.mergePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        status: expect.objectContaining({
          forgeSpecific: expect.objectContaining({ mergeStateStatus: "BLOCKED" }),
        }),
      }),
    );
    expect(github.invalidate).not.toHaveBeenCalled();
    expect(messages).toContainEqual({
      type: "checkout_pr_merge_response",
      payload: {
        cwd: "/tmp/request-worktree",
        success: false,
        error: {
          code: "UNKNOWN",
          message: "GitHub does not report this pull request as ready for direct merge",
        },
        requestId: "request-pr-merge-fresh-blocked",
      },
    });
  });

  test("delegates direct merge when the current change request lacks GitHub-only merge facts", async () => {
    const messages: unknown[] = [];
    const github = {
      invalidate: vi.fn(),
      mergePullRequest: vi.fn().mockResolvedValue({ success: true }),
    };
    const workspaceGitService = {
      getSnapshot: vi.fn().mockResolvedValue({
        forge: {
          pullRequest: {
            number: 42,
            mergeable: "MERGEABLE",
          },
        },
      }),
    };
    const session = createSessionForTest({ github, workspaceGitService, messages });

    await session.handleMessage({
      type: "checkout_pr_merge_request",
      cwd: "/tmp/request-worktree",
      mergeMethod: "squash",
      requestId: "request-pr-merge-missing-github-facts",
    });

    expect(github.mergePullRequest).toHaveBeenCalledWith({
      cwd: "/tmp/request-worktree",
      prNumber: 42,
      mergeMethod: "squash",
      status: {
        number: 42,
        mergeable: "MERGEABLE",
      },
    });
    expect(github.invalidate).toHaveBeenCalledWith({ cwd: "/tmp/request-worktree" });
    expect(workspaceGitService.getSnapshot).toHaveBeenNthCalledWith(1, "/tmp/request-worktree", {
      force: true,
      includeForge: true,
      reason: "merge-pr-validation",
    });
    expect(workspaceGitService.getSnapshot).toHaveBeenNthCalledWith(2, "/tmp/request-worktree", {
      force: true,
      reason: "merge-pr",
    });
    expect(messages).toContainEqual({
      type: "checkout_pr_merge_response",
      payload: {
        cwd: "/tmp/request-worktree",
        success: true,
        error: null,
        requestId: "request-pr-merge-missing-github-facts",
      },
    });
  });

  test("surfaces merge errors verbatim", async () => {
    const messages: unknown[] = [];
    const github = {
      invalidate: vi.fn(),
      mergePullRequest: vi.fn().mockRejectedValue(new Error("base branch has conflicts")),
    };
    const workspaceGitService = {
      getSnapshot: vi.fn().mockResolvedValue({
        forge: {
          pullRequest: {
            number: 42,
            forgeSpecific: {
              forge: "github",
              mergeStateStatus: "CLEAN",
              autoMergeRequest: null,
              viewerCanEnableAutoMerge: false,
              viewerCanDisableAutoMerge: false,
              viewerCanMergeAsAdmin: false,
              viewerCanUpdateBranch: false,
              repository: {
                autoMergeAllowed: true,
                mergeCommitAllowed: true,
                squashMergeAllowed: true,
                rebaseMergeAllowed: true,
                viewerDefaultMergeMethod: "SQUASH",
              },
              isMergeQueueEnabled: false,
              isInMergeQueue: false,
            },
          },
        },
      }),
    };
    const session = createSessionForTest({ github, workspaceGitService, messages });

    await session.handleMessage({
      type: "checkout_pr_merge_request",
      cwd: "/tmp/request-worktree",
      mergeMethod: "merge",
      requestId: "request-pr-merge-failure",
    });

    expect(messages).toContainEqual({
      type: "checkout_pr_merge_response",
      payload: {
        cwd: "/tmp/request-worktree",
        success: false,
        error: {
          code: "UNKNOWN",
          message: "base branch has conflicts",
        },
        requestId: "request-pr-merge-failure",
      },
    });
  });
});

describe("session checkout pull request auto-merge", () => {
  const autoMergeGithubFacts = (
    overrides: Partial<GitHubPullRequestStatusFacts> = {},
  ): GitHubPullRequestStatusFacts & { forge: "github" } => ({
    forge: "github",
    mergeStateStatus: "BLOCKED",
    autoMergeRequest: null,
    viewerCanEnableAutoMerge: true,
    viewerCanDisableAutoMerge: false,
    viewerCanMergeAsAdmin: false,
    viewerCanUpdateBranch: false,
    repository: {
      autoMergeAllowed: true,
      mergeCommitAllowed: true,
      squashMergeAllowed: true,
      rebaseMergeAllowed: true,
      viewerDefaultMergeMethod: "SQUASH",
    },
    isMergeQueueEnabled: false,
    isInMergeQueue: false,
    ...overrides,
  });

  test("enables auto-merge for the current pull request and refreshes GitHub state", async () => {
    const messages: unknown[] = [];
    const github = {
      invalidate: vi.fn(),
      enablePullRequestAutoMerge: vi.fn(async (input) => {
        assertPullRequestAutoMergeEnableReady(input);
        return { success: true };
      }),
    };
    const workspaceGitService = {
      getSnapshot: vi.fn().mockResolvedValue({
        forge: {
          pullRequest: {
            number: 42,
            mergeable: "MERGEABLE",
            forgeSpecific: autoMergeGithubFacts(),
          },
        },
      }),
    };
    const session = createSessionForTest({ github, workspaceGitService, messages });

    await session.handleMessage({
      type: "checkout.forge.set_auto_merge.request",
      cwd: "/tmp/request-worktree",
      enabled: true,
      mergeMethod: "squash",
      requestId: "request-pr-auto-merge-enable",
    });

    expect(github.enablePullRequestAutoMerge).toHaveBeenCalledWith({
      cwd: "/tmp/request-worktree",
      prNumber: 42,
      mergeMethod: "squash",
      status: {
        number: 42,
        mergeable: "MERGEABLE",
        forgeSpecific: autoMergeGithubFacts(),
      },
    });
    expect(workspaceGitService.getSnapshot).toHaveBeenNthCalledWith(1, "/tmp/request-worktree", {
      force: true,
      includeForge: true,
      reason: "auto-merge-validation",
    });
    expect(workspaceGitService.getSnapshot).toHaveBeenNthCalledWith(2, "/tmp/request-worktree", {
      force: true,
      reason: "enable-pr-auto-merge",
    });
    expect(github.invalidate).toHaveBeenCalledWith({ cwd: "/tmp/request-worktree" });
    expect(messages).toContainEqual({
      type: "checkout.forge.set_auto_merge.response",
      payload: {
        cwd: "/tmp/request-worktree",
        enabled: true,
        success: true,
        error: null,
        requestId: "request-pr-auto-merge-enable",
      },
    });
  });

  test("disables auto-merge for the current pull request and refreshes GitHub state", async () => {
    const messages: unknown[] = [];
    const github = {
      invalidate: vi.fn(),
      disablePullRequestAutoMerge: vi.fn(async (input) => {
        assertPullRequestAutoMergeDisableReady(input);
        return { success: true };
      }),
    };
    const workspaceGitService = {
      getSnapshot: vi.fn().mockResolvedValue({
        forge: {
          pullRequest: {
            number: 42,
            forgeSpecific: autoMergeGithubFacts({
              autoMergeRequest: {
                enabledAt: "2026-05-13T17:00:00Z",
                mergeMethod: "SQUASH",
                enabledBy: "moboudra",
              },
              viewerCanEnableAutoMerge: false,
              viewerCanDisableAutoMerge: true,
            }),
          },
        },
      }),
    };
    const session = createSessionForTest({ github, workspaceGitService, messages });

    await session.handleMessage({
      type: "checkout.forge.set_auto_merge.request",
      cwd: "/tmp/request-worktree",
      enabled: false,
      requestId: "request-pr-auto-merge-disable",
    });

    expect(github.disablePullRequestAutoMerge).toHaveBeenCalledWith({
      cwd: "/tmp/request-worktree",
      prNumber: 42,
      status: {
        number: 42,
        forgeSpecific: autoMergeGithubFacts({
          autoMergeRequest: {
            enabledAt: "2026-05-13T17:00:00Z",
            mergeMethod: "SQUASH",
            enabledBy: "moboudra",
          },
          viewerCanEnableAutoMerge: false,
          viewerCanDisableAutoMerge: true,
        }),
      },
    });
    expect(workspaceGitService.getSnapshot).toHaveBeenNthCalledWith(1, "/tmp/request-worktree", {
      force: true,
      includeForge: true,
      reason: "auto-merge-validation",
    });
    expect(workspaceGitService.getSnapshot).toHaveBeenNthCalledWith(2, "/tmp/request-worktree", {
      force: true,
      reason: "disable-pr-auto-merge",
    });
    expect(github.invalidate).toHaveBeenCalledWith({ cwd: "/tmp/request-worktree" });
    expect(messages).toContainEqual({
      type: "checkout.forge.set_auto_merge.response",
      payload: {
        cwd: "/tmp/request-worktree",
        enabled: false,
        success: true,
        error: null,
        requestId: "request-pr-auto-merge-disable",
      },
    });
  });

  test("surfaces auto-merge errors verbatim", async () => {
    const messages: unknown[] = [];
    const github = {
      invalidate: vi.fn(),
      enablePullRequestAutoMerge: vi.fn().mockRejectedValue(new Error("auto-merge is disabled")),
    };
    const workspaceGitService = {
      getSnapshot: vi.fn().mockResolvedValue({
        forge: {
          pullRequest: {
            number: 42,
            forgeSpecific: autoMergeGithubFacts(),
          },
        },
      }),
    };
    const session = createSessionForTest({ github, workspaceGitService, messages });

    await session.handleMessage({
      type: "checkout.forge.set_auto_merge.request",
      cwd: "/tmp/request-worktree",
      enabled: true,
      mergeMethod: "merge",
      requestId: "request-pr-auto-merge-failure",
    });

    expect(messages).toContainEqual({
      type: "checkout.forge.set_auto_merge.response",
      payload: {
        cwd: "/tmp/request-worktree",
        enabled: true,
        success: false,
        error: {
          code: "UNKNOWN",
          message: "auto-merge is disabled",
        },
        requestId: "request-pr-auto-merge-failure",
      },
    });
  });

  test("rejects auto-merge enable when the requested method is disabled", async () => {
    const messages: unknown[] = [];
    const github = {
      invalidate: vi.fn(),
      enablePullRequestAutoMerge: vi.fn(async (input) => {
        assertPullRequestAutoMergeEnableReady(input);
        return { success: true };
      }),
    };
    const workspaceGitService = {
      getSnapshot: vi.fn().mockResolvedValue({
        forge: {
          pullRequest: {
            number: 42,
            forgeSpecific: autoMergeGithubFacts({
              repository: {
                autoMergeAllowed: true,
                mergeCommitAllowed: true,
                squashMergeAllowed: false,
                rebaseMergeAllowed: true,
                viewerDefaultMergeMethod: "MERGE",
              },
            }),
          },
        },
      }),
    };
    const session = createSessionForTest({ github, workspaceGitService, messages });

    await session.handleMessage({
      type: "checkout.forge.set_auto_merge.request",
      cwd: "/tmp/request-worktree",
      enabled: true,
      mergeMethod: "squash",
      requestId: "request-pr-auto-merge-method-disabled",
    });

    // The adapter owns the readiness precondition and rejects before any side
    // effect, so it is invoked but the mutation never completes (no invalidate).
    expect(github.enablePullRequestAutoMerge).toHaveBeenCalled();
    expect(github.invalidate).not.toHaveBeenCalled();
    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith("/tmp/request-worktree", {
      force: true,
      includeForge: true,
      reason: "auto-merge-validation",
    });
    expect(messages).toContainEqual({
      type: "checkout.forge.set_auto_merge.response",
      payload: {
        cwd: "/tmp/request-worktree",
        enabled: true,
        success: false,
        error: {
          code: "UNKNOWN",
          message: "Auto-merge is not available because squash is disabled",
        },
        requestId: "request-pr-auto-merge-method-disabled",
      },
    });
  });

  test("rejects auto-merge disable when the viewer cannot disable it", async () => {
    const messages: unknown[] = [];
    const github = {
      invalidate: vi.fn(),
      disablePullRequestAutoMerge: vi.fn(async (input) => {
        assertPullRequestAutoMergeDisableReady(input);
        return { success: true };
      }),
    };
    const workspaceGitService = {
      getSnapshot: vi.fn().mockResolvedValue({
        forge: {
          pullRequest: {
            number: 42,
            forgeSpecific: autoMergeGithubFacts({
              autoMergeRequest: {
                enabledAt: "2026-05-13T17:00:00Z",
                mergeMethod: "SQUASH",
                enabledBy: "someone-else",
              },
              viewerCanEnableAutoMerge: false,
              viewerCanDisableAutoMerge: false,
            }),
          },
        },
      }),
    };
    const session = createSessionForTest({ github, workspaceGitService, messages });

    await session.handleMessage({
      type: "checkout.forge.set_auto_merge.request",
      cwd: "/tmp/request-worktree",
      enabled: false,
      requestId: "request-pr-auto-merge-disable-forbidden",
    });

    // The adapter owns the readiness precondition and rejects before any side
    // effect, so it is invoked but the mutation never completes (no invalidate).
    expect(github.disablePullRequestAutoMerge).toHaveBeenCalled();
    expect(github.invalidate).not.toHaveBeenCalled();
    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith("/tmp/request-worktree", {
      force: true,
      includeForge: true,
      reason: "auto-merge-validation",
    });
    expect(messages).toContainEqual({
      type: "checkout.forge.set_auto_merge.response",
      payload: {
        cwd: "/tmp/request-worktree",
        enabled: false,
        success: false,
        error: {
          code: "UNKNOWN",
          message: "GitHub does not allow this viewer to disable auto-merge",
        },
        requestId: "request-pr-auto-merge-disable-forbidden",
      },
    });
  });

  test("rejects auto-merge disable requests that include a merge method", async () => {
    const messages: unknown[] = [];
    const github = {
      invalidate: vi.fn(),
      disablePullRequestAutoMerge: vi.fn(async (input) => {
        assertPullRequestAutoMergeDisableReady(input);
        return { success: true };
      }),
    };
    const workspaceGitService = {
      getSnapshot: vi.fn().mockResolvedValue({
        forge: {
          pullRequest: {
            number: 42,
            forgeSpecific: autoMergeGithubFacts({
              autoMergeRequest: {
                enabledAt: "2026-05-13T17:00:00Z",
                mergeMethod: "SQUASH",
                enabledBy: "moboudra",
              },
              viewerCanEnableAutoMerge: false,
              viewerCanDisableAutoMerge: true,
            }),
          },
        },
      }),
    };
    const session = createSessionForTest({ github, workspaceGitService, messages });

    await session.handleMessage({
      type: "checkout.forge.set_auto_merge.request",
      cwd: "/tmp/request-worktree",
      enabled: false,
      mergeMethod: "squash",
      requestId: "request-pr-auto-merge-disable-with-method",
    });

    expect(github.disablePullRequestAutoMerge).not.toHaveBeenCalled();
    expect(github.invalidate).not.toHaveBeenCalled();
    expect(messages).toContainEqual({
      type: "checkout.forge.set_auto_merge.response",
      payload: {
        cwd: "/tmp/request-worktree",
        enabled: false,
        success: false,
        error: {
          code: "UNKNOWN",
          message: "mergeMethod is not allowed when disabling auto-merge",
        },
        requestId: "request-pr-auto-merge-disable-with-method",
      },
    });
  });
});

describe("session checkout pull and push handling", () => {
  test("forces workspace git and GitHub refresh after pulling", async () => {
    const messages: unknown[] = [];
    const github = { invalidate: vi.fn() };
    const workspaceGitService = { getSnapshot: vi.fn().mockResolvedValue({}) };
    const session = createSessionForTest({ github, workspaceGitService, messages });
    checkoutGitMocks.pullCurrentBranch.mockResolvedValue(undefined);

    await session.handleMessage({
      type: "checkout_pull_request",
      cwd: "/tmp/request-worktree",
      requestId: "request-pull",
    });

    expect(checkoutGitMocks.pullCurrentBranch).toHaveBeenCalledWith("/tmp/request-worktree");
    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith("/tmp/request-worktree", {
      force: true,
      reason: "pull",
    });
    expect(github.invalidate).toHaveBeenCalledWith({ cwd: "/tmp/request-worktree" });
    expect(messages).toContainEqual({
      type: "checkout_pull_response",
      payload: {
        cwd: "/tmp/request-worktree",
        success: true,
        error: null,
        requestId: "request-pull",
      },
    });
  });

  test("forces workspace git and GitHub refresh after pushing", async () => {
    const messages: unknown[] = [];
    const github = { invalidate: vi.fn() };
    const workspaceGitService = { getSnapshot: vi.fn().mockResolvedValue({}) };
    const session = createSessionForTest({ github, workspaceGitService, messages });
    checkoutGitMocks.pushCurrentBranch.mockResolvedValue(undefined);

    await session.handleMessage({
      type: "checkout_push_request",
      cwd: "/tmp/request-worktree",
      requestId: "request-push",
    });

    expect(checkoutGitMocks.pushCurrentBranch).toHaveBeenCalledWith("/tmp/request-worktree");
    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith("/tmp/request-worktree", {
      force: true,
      reason: "push",
    });
    expect(github.invalidate).toHaveBeenCalledWith({ cwd: "/tmp/request-worktree" });
    expect(messages).toContainEqual({
      type: "checkout_push_response",
      payload: {
        cwd: "/tmp/request-worktree",
        success: true,
        error: null,
        requestId: "request-push",
      },
    });
  });
});

describe("session checkout refresh handling", () => {
  test("forces a git, GitHub, and diff refresh on demand", async () => {
    const messages: unknown[] = [];
    const github = { invalidate: vi.fn() };
    const workspaceGitService = { getSnapshot: vi.fn().mockResolvedValue({}) };
    const checkoutDiffManager = { scheduleRefreshForCwd: vi.fn() };
    const session = createSessionForTest({
      github,
      workspaceGitService,
      checkoutDiffManager,
      messages,
    });

    await session.handleMessage({
      type: "checkout.refresh.request",
      cwd: "/tmp/request-worktree",
      requestId: "request-refresh",
    });

    expect(github.invalidate).toHaveBeenCalledWith({ cwd: "/tmp/request-worktree" });
    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith("/tmp/request-worktree", {
      force: true,
      includeForge: true,
      reason: "manual-refresh",
    });
    expect(checkoutDiffManager.scheduleRefreshForCwd).toHaveBeenCalledWith("/tmp/request-worktree");
    expect(messages).toContainEqual({
      type: "checkout.refresh.response",
      payload: {
        cwd: "/tmp/request-worktree",
        success: true,
        error: null,
        requestId: "request-refresh",
      },
    });
  });

  test("reports an error when the snapshot refresh fails", async () => {
    const messages: unknown[] = [];
    const github = { invalidate: vi.fn() };
    const workspaceGitService = {
      getSnapshot: vi.fn().mockRejectedValue(new Error("not a git repository")),
    };
    const checkoutDiffManager = { scheduleRefreshForCwd: vi.fn() };
    const session = createSessionForTest({
      github,
      workspaceGitService,
      checkoutDiffManager,
      messages,
    });

    await session.handleMessage({
      type: "checkout.refresh.request",
      cwd: "/tmp/request-worktree",
      requestId: "request-refresh-error",
    });

    expect(checkoutDiffManager.scheduleRefreshForCwd).not.toHaveBeenCalled();
    expect(messages).toContainEqual({
      type: "checkout.refresh.response",
      payload: {
        cwd: "/tmp/request-worktree",
        success: false,
        error: { code: "UNKNOWN", message: "not a git repository" },
        requestId: "request-refresh-error",
      },
    });
  });
});

describe("session checkout status handling", () => {
  test("returns checkout status from the workspace git service snapshot", async () => {
    const messages: unknown[] = [];
    const workspaceGitService = {
      getSnapshot: vi.fn().mockResolvedValue(createWorkspaceGitSnapshot("/tmp/service-worktree")),
      peekSnapshot: vi.fn(),
    };
    const session = createSessionForTest({ workspaceGitService, messages });

    await session.handleMessage({
      type: "checkout_status_request",
      cwd: "/tmp/service-worktree",
      requestId: "request-status",
    });

    expect(workspaceGitService.getSnapshot).toHaveBeenCalledTimes(1);
    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith("/tmp/service-worktree");
    expect(checkoutGitMocks.getCheckoutStatus).not.toHaveBeenCalled();
    expect(messages).toContainEqual({
      type: "checkout_status_response",
      payload: {
        cwd: "/tmp/service-worktree",
        isGit: true,
        repoRoot: "/tmp/service-worktree",
        mainRepoRoot: null,
        currentBranch: "feature/service",
        isDirty: true,
        baseRef: "main",
        aheadBehind: { ahead: 2, behind: 1 },
        aheadOfOrigin: 2,
        behindOfOrigin: 1,
        upstreamRef: null,
        hasRemote: true,
        remoteUrl: "https://github.com/getpaseo/paseo.git",
        isPaseoOwnedWorktree: false,
        error: null,
        requestId: "request-status",
      },
    });
  });

  test("returns fresh service data on the first checkout status read for a cwd", async () => {
    const messages: unknown[] = [];
    const workspaceGitService = {
      getSnapshot: vi.fn().mockResolvedValue(
        createWorkspaceGitSnapshot("/tmp/cold-worktree", {
          git: {
            currentBranch: "fresh-branch",
            isDirty: false,
            aheadBehind: { ahead: 4, behind: 0 },
            aheadOfOrigin: 4,
            behindOfOrigin: 0,
          },
        }),
      ),
      peekSnapshot: vi.fn(() => null),
    };
    const session = createSessionForTest({ workspaceGitService, messages });

    await session.handleMessage({
      type: "checkout_status_request",
      cwd: "/tmp/cold-worktree",
      requestId: "request-cold-status",
    });

    expect(workspaceGitService.peekSnapshot).not.toHaveBeenCalled();
    expect(workspaceGitService.getSnapshot).toHaveBeenCalledTimes(1);
    expect(messages).toContainEqual({
      type: "checkout_status_response",
      payload: expect.objectContaining({
        cwd: "/tmp/cold-worktree",
        isGit: true,
        currentBranch: "fresh-branch",
        isDirty: false,
        aheadBehind: { ahead: 4, behind: 0 },
        error: null,
        requestId: "request-cold-status",
      }),
    });
  });
});

describe("session workspace descriptors", () => {
  test("fetch_workspaces_request includes project placement for a GitHub-backed workspace", async () => {
    const messages: unknown[] = [];
    const workspace = {
      workspaceId: "ws-gh",
      projectId: "prj_app",
      cwd: "/repo/app",
      kind: "local_checkout" as const,
      displayName: "app",
      branch: "app",
      archivedAt: null,
    };
    const project = {
      projectId: "prj_app",
      projectKey: "remote:github.com/acme/app",
      rootPath: "/repo/app",
      kind: "git" as const,
      displayName: "acme/app",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
    };
    const session = createSessionForTest({
      messages,
      workspaceRegistry: { get: vi.fn(), list: vi.fn().mockResolvedValue([workspace]) },
      projectRegistry: {
        list: vi.fn().mockResolvedValue([project]),
        get: vi.fn().mockResolvedValue(project),
      },
      workspaceGitService: {
        getSnapshot: vi.fn(),
        peekSnapshot: vi.fn(() =>
          createWorkspaceGitSnapshot("/repo/app", {
            git: {
              remoteUrl: "https://github.com/acme/app.git",
              currentBranch: "main",
              isPaseoOwnedWorktree: false,
              mainRepoRoot: null,
            },
          }),
        ),
        registerWorkspace: vi.fn(() => () => {}),
      },
    });

    await session.handleMessage({
      type: "fetch_workspaces_request",
      requestId: "fetch-workspaces-gh",
    });

    expect(messages).toContainEqual({
      type: "fetch_workspaces_response",
      payload: expect.objectContaining({
        requestId: "fetch-workspaces-gh",
        entries: [
          expect.objectContaining({
            id: "ws-gh",
            projectId: "prj_app",
            project: expect.objectContaining({
              projectKey: "prj_app",
              projectName: "acme/app",
              workspaceName: "app",
              checkout: expect.objectContaining({
                cwd: "/repo/app",
                isGit: true,
                currentBranch: "app",
                remoteUrl: null,
                worktreeRoot: "/repo/app",
                isPaseoOwnedWorktree: false,
                mainRepoRoot: null,
              }),
            }),
          }),
        ],
      }),
    });
  });

  test("fetch_workspaces_request includes repo-root fallback placement for a workspace without remote", async () => {
    const messages: unknown[] = [];
    const workspace = {
      workspaceId: "ws-local",
      projectId: "/repo/local",
      cwd: "/repo/local",
      kind: "local_checkout" as const,
      displayName: "local",
      branch: "local",
      archivedAt: null,
    };
    const project = {
      projectId: "/repo/local",
      rootPath: "/repo/local",
      kind: "git" as const,
      displayName: "local",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
    };
    const session = createSessionForTest({
      messages,
      workspaceRegistry: { get: vi.fn(), list: vi.fn().mockResolvedValue([workspace]) },
      projectRegistry: { list: vi.fn().mockResolvedValue([project]), get: vi.fn() },
      workspaceGitService: {
        getSnapshot: vi.fn(),
        peekSnapshot: vi.fn(() =>
          createWorkspaceGitSnapshot("/repo/local", {
            git: {
              remoteUrl: null,
              currentBranch: "main",
              isPaseoOwnedWorktree: false,
              mainRepoRoot: null,
            },
          }),
        ),
        registerWorkspace: vi.fn(() => () => {}),
      },
    });

    await session.handleMessage({
      type: "fetch_workspaces_request",
      requestId: "fetch-workspaces-local",
    });

    expect(messages).toContainEqual({
      type: "fetch_workspaces_response",
      payload: expect.objectContaining({
        requestId: "fetch-workspaces-local",
        entries: [
          expect.objectContaining({
            id: "ws-local",
            project: expect.objectContaining({
              projectKey: "/repo/local",
              projectName: "local",
              workspaceName: "local",
              checkout: expect.objectContaining({
                cwd: "/repo/local",
                isGit: true,
                currentBranch: "local",
                remoteUrl: null,
                worktreeRoot: "/repo/local",
                isPaseoOwnedWorktree: false,
                mainRepoRoot: null,
              }),
            }),
          }),
        ],
      }),
    });
  });

  test("reads descriptor diff stat from the workspace git service snapshot", async () => {
    const workspaceGitService = {
      getSnapshot: vi.fn(),
      peekSnapshot: vi.fn(() =>
        createWorkspaceGitSnapshot("/tmp/workspace", {
          git: { diffStat: { additions: 7, deletions: 2 } },
        }),
      ),
    };
    const session = createSessionForTest({ workspaceGitService });
    checkoutGitMocks.getCachedCheckoutShortstat.mockReturnValue({
      additions: 99,
      deletions: 88,
    });

    const descriptor = await asSessionInternals(session).describeWorkspaceRecord(
      {
        workspaceId: "workspace-1",
        projectId: "project-1",
        cwd: "/tmp/workspace",
        kind: "checkout",
        displayName: "Workspace",
      },
      {
        projectId: "project-1",
        rootPath: "/tmp/workspace",
        displayName: "Project",
        kind: "git",
      },
    );

    expect(workspaceGitService.peekSnapshot).toHaveBeenCalledWith("/tmp/workspace");
    expect(workspaceGitService.getSnapshot).not.toHaveBeenCalled();
    expect(checkoutGitMocks.getCachedCheckoutShortstat).not.toHaveBeenCalled();
    expect(checkoutGitMocks.warmCheckoutShortstatInBackground).not.toHaveBeenCalled();
    expect(descriptor.diffStat).toEqual({ additions: 7, deletions: 2 });
  });

  test("does not cold-load git data while describing a workspace", async () => {
    const workspaceGitService = {
      getSnapshot: vi.fn().mockResolvedValue(createWorkspaceGitSnapshot("/tmp/workspace")),
      peekSnapshot: vi.fn(() => null),
    };
    const session = createSessionForTest({ workspaceGitService });

    const descriptor = await asSessionInternals(session).describeWorkspaceRecordWithGitData(
      {
        workspaceId: "workspace-1",
        projectId: "project-1",
        cwd: "/tmp/workspace",
        kind: "checkout",
        displayName: "Workspace",
      },
      {
        projectId: "project-1",
        rootPath: "/tmp/workspace",
        displayName: "Project",
        kind: "git",
      },
    );

    expect(workspaceGitService.peekSnapshot).toHaveBeenCalledWith("/tmp/workspace");
    expect(workspaceGitService.getSnapshot).not.toHaveBeenCalled();
    expect(descriptor.diffStat).toBeNull();
    expect(descriptor.gitRuntime).toBeUndefined();
  });
});

describe("session branch validation", () => {
  test("validates branches through the workspace git service", async () => {
    const messages: unknown[] = [];
    const workspaceGitService = {
      getSnapshot: vi.fn(),
      peekSnapshot: vi.fn(),
      validateBranchRef: vi
        .fn()
        .mockResolvedValue({ kind: "remote-only", name: "feature", remoteRef: "origin/feature" }),
    };
    const session = createSessionForTest({ workspaceGitService, messages });

    await session.handleMessage({
      type: "validate_branch_request",
      cwd: "/tmp/repo",
      branchName: "feature",
      requestId: "request-validate-service",
    });

    expect(workspaceGitService.validateBranchRef).toHaveBeenCalledTimes(1);
    expect(workspaceGitService.validateBranchRef).toHaveBeenCalledWith("/tmp/repo", "feature");
    expect(checkoutGitMocks.resolveBranchCheckout).not.toHaveBeenCalled();
    expect(messages).toContainEqual({
      type: "validate_branch_response",
      payload: {
        exists: true,
        resolvedRef: "origin/feature",
        isRemote: true,
        error: null,
        requestId: "request-validate-service",
      },
    });
  });

  test("does not validate tags as branches", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "paseo-session-branch-validation-"));
    const repoDir = join(tempDir, "repo");

    try {
      execSync(`git init -b main ${repoDir}`);
      execSync("git config user.email 'test@test.com'", { cwd: repoDir });
      execSync("git config user.name 'Test'", { cwd: repoDir });
      writeFileSync(join(repoDir, "README.md"), "hello\n");
      execSync("git add README.md", { cwd: repoDir });
      execSync("git -c commit.gpgsign=false commit -m init", { cwd: repoDir });
      execSync("git tag v1", { cwd: repoDir });

      const messages: unknown[] = [];
      const workspaceGitService = {
        getSnapshot: vi.fn(),
        peekSnapshot: vi.fn(),
        validateBranchRef: vi.fn().mockResolvedValue({ kind: "not-found" }),
      };
      const session = createSessionForTest({ workspaceGitService, messages });

      await session.handleMessage({
        type: "validate_branch_request",
        cwd: repoDir,
        branchName: "v1",
        requestId: "request-validate-tag",
      });

      expect(messages).toContainEqual({
        type: "validate_branch_response",
        payload: {
          exists: false,
          resolvedRef: null,
          isRemote: false,
          error: null,
          requestId: "request-validate-tag",
        },
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("session checkout switch branch handling", () => {
  test("forces a workspace git snapshot refresh after switching branches", async () => {
    const messages: unknown[] = [];
    const github = { invalidate: vi.fn() };
    const workspaceGitService = {
      getSnapshot: vi.fn().mockResolvedValue(
        createWorkspaceGitSnapshot("/tmp/repo", {
          git: {
            isDirty: false,
          },
        }),
      ),
      validateBranchRef: vi.fn().mockResolvedValue({ kind: "local", name: "release" }),
    };
    const session = createSessionForTest({ github, workspaceGitService, messages });
    checkoutGitMocks.checkoutResolvedBranch.mockResolvedValue({ source: "local" });

    await session.handleMessage({
      type: "checkout_switch_branch_request",
      cwd: "/tmp/repo",
      branch: "release",
      requestId: "request-switch",
    });

    expect(checkoutGitMocks.checkoutResolvedBranch).toHaveBeenCalledWith({
      cwd: "/tmp/repo",
      resolution: { kind: "local", name: "release" },
    });
    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith("/tmp/repo", {
      force: true,
      reason: "switch-branch",
    });
    expect(github.invalidate).toHaveBeenCalledWith({ cwd: "/tmp/repo" });
    expect(messages).toContainEqual({
      type: "checkout_switch_branch_response",
      payload: {
        cwd: "/tmp/repo",
        success: true,
        branch: "release",
        source: "local",
        error: null,
        requestId: "request-switch",
      },
    });
  });
});

describe("session checkout rename branch handling", () => {
  test("rejects invalid branch slugs without renaming", async () => {
    const messages: unknown[] = [];
    const workspaceGitService = {
      getSnapshot: vi.fn(),
      peekSnapshot: vi.fn(),
    };
    const session = createSessionForTest({ workspaceGitService, messages });

    await session.handleMessage({
      type: "checkout.rename_branch.request",
      cwd: "/tmp/repo",
      branch: "Feature Name",
      requestId: "request-rename-invalid",
    });

    expect(checkoutGitMocks.renameCurrentBranch).not.toHaveBeenCalled();
    expect(workspaceGitService.getSnapshot).not.toHaveBeenCalled();
    expect(messages).toContainEqual({
      type: "checkout.rename_branch.response",
      payload: {
        cwd: "/tmp/repo",
        success: false,
        currentBranch: null,
        error: {
          code: "UNKNOWN",
          message:
            "Branch name must contain only lowercase letters, numbers, hyphens, and forward slashes",
        },
        requestId: "request-rename-invalid",
      },
    });
  });

  test("reports null current branch when branch rename fails", async () => {
    const messages: unknown[] = [];
    const workspaceGitService = {
      getSnapshot: vi.fn(),
      peekSnapshot: vi.fn(),
    };
    const session = createSessionForTest({ workspaceGitService, messages });
    checkoutGitMocks.renameCurrentBranch.mockRejectedValue(new Error("branch already exists"));

    await session.handleMessage({
      type: "checkout.rename_branch.request",
      cwd: "/tmp/repo",
      branch: "feature/new-name",
      requestId: "request-rename-failure",
    });

    expect(checkoutGitMocks.renameCurrentBranch).toHaveBeenCalledWith(
      "/tmp/repo",
      "feature/new-name",
    );
    expect(workspaceGitService.peekSnapshot).not.toHaveBeenCalled();
    expect(workspaceGitService.getSnapshot).not.toHaveBeenCalled();
    expect(messages).toContainEqual({
      type: "checkout.rename_branch.response",
      payload: {
        cwd: "/tmp/repo",
        success: false,
        currentBranch: null,
        error: {
          code: "UNKNOWN",
          message: "branch already exists",
        },
        requestId: "request-rename-failure",
      },
    });
  });

  test("forces workspace git refresh after renaming the current branch", async () => {
    const messages: unknown[] = [];
    const github = { invalidate: vi.fn() };
    const workspaceGitService = {
      getSnapshot: vi.fn().mockResolvedValue(
        createWorkspaceGitSnapshot("/tmp/repo", {
          git: {
            currentBranch: "feature/new-name",
            isDirty: false,
          },
        }),
      ),
      peekSnapshot: vi.fn(() =>
        createWorkspaceGitSnapshot("/tmp/repo", {
          git: { currentBranch: "feature/old-name" },
        }),
      ),
    };
    const session = createSessionForTest({ github, workspaceGitService, messages });
    checkoutGitMocks.renameCurrentBranch.mockResolvedValue({
      previousBranch: "feature/old-name",
      currentBranch: "feature/new-name",
    });

    await session.handleMessage({
      type: "checkout.rename_branch.request",
      cwd: "/tmp/repo",
      branch: "feature/new-name",
      requestId: "request-rename-success",
    });

    expect(checkoutGitMocks.renameCurrentBranch).toHaveBeenCalledWith(
      "/tmp/repo",
      "feature/new-name",
    );
    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith("/tmp/repo", {
      force: true,
      reason: "rename-branch",
    });
    expect(github.invalidate).toHaveBeenCalledWith({ cwd: "/tmp/repo" });
    expect(messages).toContainEqual({
      type: "checkout.rename_branch.response",
      payload: {
        cwd: "/tmp/repo",
        success: true,
        currentBranch: "feature/new-name",
        error: null,
        requestId: "request-rename-success",
      },
    });
  });
});

describe("session terminal rename handling", () => {
  test("rejects an empty terminal title without calling the terminal manager", async () => {
    const messages: unknown[] = [];
    const terminalManager = createTerminalManagerStub();
    const session = createSessionForTest({ terminalManager, messages });

    await session.handleMessage({
      type: "terminal.rename.request",
      terminalId: "terminal-1",
      title: "   ",
      requestId: "request-empty-title",
    });

    expect(terminalManager.setTerminalTitle).not.toHaveBeenCalled();
    expect(messages).toContainEqual({
      type: "terminal.rename.response",
      payload: {
        requestId: "request-empty-title",
        success: false,
        error: "Title is required",
      },
    });
  });

  test("reports when the terminal manager cannot find the terminal", async () => {
    const messages: unknown[] = [];
    const terminalManager = createTerminalManagerStub({
      setTerminalTitle: vi.fn(() => false),
    });
    const session = createSessionForTest({ terminalManager, messages });

    await session.handleMessage({
      type: "terminal.rename.request",
      terminalId: "missing-terminal",
      title: "Renamed terminal",
      requestId: "request-missing-terminal",
    });

    expect(terminalManager.setTerminalTitle).toHaveBeenCalledWith(
      "missing-terminal",
      "Renamed terminal",
    );
    expect(messages).toContainEqual({
      type: "terminal.rename.response",
      payload: {
        requestId: "request-missing-terminal",
        success: false,
        error: "Terminal not found",
      },
    });
  });

  test("trims and sets a valid terminal title", async () => {
    const messages: unknown[] = [];
    const terminalManager = createTerminalManagerStub({
      setTerminalTitle: vi.fn(() => true),
    });
    const session = createSessionForTest({ terminalManager, messages });

    await session.handleMessage({
      type: "terminal.rename.request",
      terminalId: "terminal-1",
      title: "  Renamed terminal  ",
      requestId: "request-title-success",
    });

    expect(terminalManager.setTerminalTitle).toHaveBeenCalledWith("terminal-1", "Renamed terminal");
    expect(messages).toContainEqual({
      type: "terminal.rename.response",
      payload: {
        requestId: "request-title-success",
        success: true,
        error: null,
      },
    });
  });
});

describe("session branch suggestions handling", () => {
  test("lists branch suggestions through the workspace git service", async () => {
    const messages: unknown[] = [];
    const branchDetails = [
      { name: "feature/service", committerDate: 10, hasLocal: true, hasRemote: false },
    ];
    const workspaceGitService = {
      getSnapshot: vi.fn(),
      suggestBranchesForCwd: vi.fn().mockResolvedValue(branchDetails),
      peekSnapshot: vi.fn(),
    };
    const session = createSessionForTest({ workspaceGitService, messages });

    await session.handleMessage({
      type: "branch_suggestions_request",
      cwd: "/tmp/repo",
      query: "service",
      limit: 5,
      requestId: "request-branches",
    });

    expect(workspaceGitService.suggestBranchesForCwd).toHaveBeenCalledTimes(1);
    expect(workspaceGitService.suggestBranchesForCwd).toHaveBeenCalledWith("/tmp/repo", {
      query: "service",
      limit: 5,
    });
    expect(checkoutGitMocks.listBranchSuggestions).not.toHaveBeenCalled();
    expect(messages).toContainEqual({
      type: "branch_suggestions_response",
      payload: {
        branches: ["feature/service"],
        branchDetails,
        error: null,
        requestId: "request-branches",
      },
    });
  });
});

describe("session stash list handling", () => {
  test("lists stashes through the workspace git service", async () => {
    const messages: unknown[] = [];
    const entries = [
      {
        index: 0,
        message: "paseo-auto-stash: feature",
        branch: "feature",
        isPaseo: true,
      },
    ];
    const workspaceGitService = {
      getSnapshot: vi.fn(),
      listStashes: vi.fn().mockResolvedValue(entries),
      peekSnapshot: vi.fn(),
    };
    const session = createSessionForTest({ workspaceGitService, messages });

    await session.handleMessage({
      type: "stash_list_request",
      cwd: "/tmp/repo",
      paseoOnly: true,
      requestId: "request-stashes",
    });

    expect(workspaceGitService.listStashes).toHaveBeenCalledTimes(1);
    expect(workspaceGitService.listStashes).toHaveBeenCalledWith("/tmp/repo", {
      paseoOnly: true,
    });
    expect(messages).toContainEqual({
      type: "stash_list_response",
      payload: { cwd: "/tmp/repo", entries, error: null, requestId: "request-stashes" },
    });
  });
});

describe("session stash mutation handling", () => {
  test("forces a workspace git snapshot refresh after pushing a stash", async () => {
    const messages: unknown[] = [];
    const workspaceGitService = { getSnapshot: vi.fn().mockResolvedValue({}) };
    const session = createSessionForTest({ workspaceGitService, messages });
    gitCommandMocks.runGitCommand.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
      signal: null,
      truncated: false,
    });

    await session.handleMessage({
      type: "stash_save_request",
      cwd: "/tmp/repo",
      branch: "feature",
      requestId: "request-stash-push",
    });

    expect(gitCommandMocks.runGitCommand).toHaveBeenCalledWith(
      ["stash", "push", "--include-untracked", "-m", "paseo-auto-stash: feature"],
      { cwd: "/tmp/repo", timeout: 120_000 },
    );
    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith("/tmp/repo", {
      force: true,
      reason: "stash-push",
    });
    expect(messages).toContainEqual({
      type: "stash_save_response",
      payload: {
        cwd: "/tmp/repo",
        success: true,
        error: null,
        requestId: "request-stash-push",
      },
    });
  });

  test("forces a workspace git snapshot refresh after popping a stash", async () => {
    const messages: unknown[] = [];
    const workspaceGitService = { getSnapshot: vi.fn().mockResolvedValue({}) };
    const session = createSessionForTest({ workspaceGitService, messages });
    gitCommandMocks.runGitCommand.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
      signal: null,
      truncated: false,
    });

    await session.handleMessage({
      type: "stash_pop_request",
      cwd: "/tmp/repo",
      stashIndex: 0,
      requestId: "request-stash-pop",
    });

    expect(gitCommandMocks.runGitCommand).toHaveBeenCalledWith(["stash", "pop", "stash@{0}"], {
      cwd: "/tmp/repo",
      timeout: 120_000,
    });
    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith("/tmp/repo", {
      force: true,
      reason: "stash-pop",
    });
    expect(messages).toContainEqual({
      type: "stash_pop_response",
      payload: {
        cwd: "/tmp/repo",
        success: true,
        error: null,
        requestId: "request-stash-pop",
      },
    });
  });
});

describe("session paseo worktree creation handling", () => {
  test("forces workspace git refreshes for the source repo and created worktree", async () => {
    const workspaceGitService = { getSnapshot: vi.fn().mockResolvedValue({}) };
    const session = createSessionForTest({ workspaceGitService });
    paseoWorktreeServiceMocks.createPaseoWorktree.mockResolvedValue({
      repoRoot: "/tmp/repo",
      worktree: {
        branchName: "feature/new-worktree",
        worktreePath: "/tmp/paseo/worktrees/new-worktree",
      },
      workspace: {
        workspaceId: "workspace-new-worktree",
        projectId: "project-repo",
        cwd: "/tmp/paseo/worktrees/new-worktree",
        kind: "worktree",
        displayName: "feature/new-worktree",
      },
      created: true,
    });

    await asSessionInternals(session).createPaseoWorktree({
      cwd: "/tmp/repo",
      worktreeSlug: "new-worktree",
      runSetup: false,
    });

    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith("/tmp/repo", {
      force: true,
      reason: "create-worktree",
    });
    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith(
      "/tmp/paseo/worktrees/new-worktree",
      {
        force: true,
        reason: "create-worktree",
      },
    );
  });
});

describe("session workspace script handling", () => {
  test("passes the project slug and cached branch into workspace script spawning", async () => {
    const messages: unknown[] = [];
    const snapshot = createWorkspaceGitSnapshot("/tmp/repo", {
      git: {
        currentBranch: "feature/service-scripts",
        remoteUrl: "https://github.com/getpaseo/paseo.git",
      },
    });
    const workspaceGitService = {
      peekSnapshot: vi.fn(() => snapshot),
      getProjectSlug: vi.fn().mockResolvedValue("paseo"),
    };
    const workspaceRegistry = {
      get: vi.fn().mockResolvedValue({
        workspaceId: "workspace-1",
        cwd: "/tmp/repo",
      }),
    };
    spawnMocks.spawnWorkspaceScript.mockResolvedValue({
      scriptName: "api",
      terminalId: "terminal-1",
    });
    const session = createSessionForTest({
      workspaceGitService,
      workspaceRegistry,
      terminalManager: {
        subscribeTerminalsChanged: vi.fn(() => () => {}),
        subscribeTerminalWorkspaceContributionChanged: vi.fn(() => () => {}),
      },
      serviceProxy: { listRoutesForWorkspace: vi.fn(() => []) },
      scriptRuntimeStore: { listForWorkspace: vi.fn(() => []) },
      getDaemonTcpPort: () => 6767,
      getDaemonTcpHost: () => "127.0.0.1",
      messages,
    });

    await asSessionInternals(session).handleStartWorkspaceScriptRequest({
      type: "start_workspace_script_request",
      workspaceId: "workspace-1",
      scriptName: "api",
      requestId: "request-script",
    });

    expect(spawnMocks.spawnWorkspaceScript).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: "/tmp/repo",
        workspaceId: "workspace-1",
        projectSlug: "paseo",
        branchName: "feature/service-scripts",
        scriptName: "api",
        daemonPort: 6767,
        daemonListenHost: "127.0.0.1",
      }),
    );
    expect(messages).toContainEqual({
      type: "start_workspace_script_response",
      payload: {
        requestId: "request-script",
        workspaceId: "workspace-1",
        scriptName: "api",
        terminalId: "terminal-1",
        error: null,
      },
    });
  });
});

describe("session pull request timeline handling", () => {
  test("routes GitHub search requests through ForgeService", async () => {
    const messages: unknown[] = [];
    const github = {
      invalidate: vi.fn(),
      searchIssuesAndPrs: vi.fn().mockResolvedValue({
        githubFeaturesEnabled: true,
        items: [
          {
            kind: "change_request",
            forge: "github",
            number: 42,
            title: "Ship search",
            url: "https://github.com/getpaseo/paseo/pull/42",
            state: "OPEN",
            body: null,
            labels: [],
            baseRefName: "main",
            headRefName: "feature",
            updatedAt: "2026-04-18T13:00:00Z",
          },
        ],
      }),
    };
    const gitlab = {
      searchIssuesAndPrs: vi.fn().mockResolvedValue({
        featuresEnabled: true,
        authState: "authenticated",
        items: [],
      }),
    };
    const workspaceGitService = {
      resolveForge: vi.fn().mockResolvedValue({ forge: "gitlab", service: gitlab }),
    };
    const session = createSessionForTest({ github, workspaceGitService, messages });

    await session.handleMessage({
      type: "github_search_request",
      cwd: "/tmp/repo",
      query: "search",
      limit: 5,
      kinds: ["github-pr"],
      requestId: "request-search",
    });

    expect(github.searchIssuesAndPrs).toHaveBeenCalledWith({
      cwd: "/tmp/repo",
      query: "search",
      limit: 5,
      kinds: ["github-pr"],
    });
    expect(gitlab.searchIssuesAndPrs).not.toHaveBeenCalled();
    expect(messages).toContainEqual({
      type: "github_search_response",
      payload: {
        items: [
          {
            kind: "pr",
            forge: "github",
            number: 42,
            title: "Ship search",
            url: "https://github.com/getpaseo/paseo/pull/42",
            state: "OPEN",
            body: null,
            labels: [],
            baseRefName: "main",
            headRefName: "feature",
            updatedAt: "2026-04-18T13:00:00Z",
          },
        ],
        featuresEnabled: true,
        authState: "authenticated",
        githubFeaturesEnabled: true,
        error: null,
        requestId: "request-search",
      },
    });
  });

  test("reports no remote when forge search has no resolved forge", async () => {
    const messages: unknown[] = [];
    const github = {
      invalidate: vi.fn(),
      searchIssuesAndPrs: vi.fn(),
    };
    const workspaceGitService = {
      resolveForge: vi.fn().mockResolvedValue(null),
    };
    const session = createSessionForTest({ github, workspaceGitService, messages });

    await session.handleMessage({
      type: "forge.search.request",
      cwd: "/tmp/repo",
      query: "search",
      limit: 5,
      kinds: ["change_request"],
      requestId: "request-search",
    });

    expect(github.searchIssuesAndPrs).not.toHaveBeenCalled();
    expect(messages).toContainEqual({
      type: "forge.search.response",
      payload: {
        items: [],
        authState: "no_remote",
        error: null,
        requestId: "request-search",
      },
    });
  });

  test("passes request identity to ForgeService and emits timeline items", async () => {
    const messages: unknown[] = [];
    const github = {
      invalidate: vi.fn(),
      isAuthenticated: vi.fn().mockResolvedValue(true),
      getPullRequestTimeline: vi.fn().mockResolvedValue({
        prNumber: 42,
        repoOwner: "getpaseo",
        repoName: "paseo",
        items: [
          {
            id: "review-1",
            kind: "review",
            author: "octocat",
            authorUrl: "https://github.com/octocat",
            avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
            body: "Looks good",
            createdAt: 1710000000000,
            url: "https://github.com/getpaseo/paseo/pull/42#pullrequestreview-1",
            reviewState: "approved",
          },
        ],
        truncated: false,
        error: null,
      }),
    };
    const session = createSessionForTest({ github, messages });

    await session.handleMessage({
      type: "pull_request_timeline_request",
      cwd: "/tmp/repo",
      prNumber: 42,
      repoOwner: "getpaseo",
      repoName: "paseo",
      requestId: "request-1",
    });

    expect(github.getPullRequestTimeline).toHaveBeenCalledWith({
      cwd: "/tmp/repo",
      prNumber: 42,
      repoOwner: "getpaseo",
      repoName: "paseo",
    });
    expect(messages).toContainEqual({
      type: "pull_request_timeline_response",
      payload: {
        cwd: "/tmp/repo",
        prNumber: 42,
        items: [
          {
            id: "review-1",
            kind: "review",
            author: "octocat",
            authorUrl: "https://github.com/octocat",
            avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
            body: "Looks good",
            createdAt: 1710000000000,
            url: "https://github.com/getpaseo/paseo/pull/42#pullrequestreview-1",
            reviewState: "approved",
          },
        ],
        truncated: false,
        error: null,
        requestId: "request-1",
        githubFeaturesEnabled: true,
      },
    });
  });

  test.each([
    { prNumber: 0, repoOwner: "getpaseo", repoName: "paseo" },
    { prNumber: -1, repoOwner: "getpaseo", repoName: "paseo" },
    { prNumber: 42, repoOwner: "get paseo", repoName: "paseo" },
    { prNumber: 42, repoOwner: "getpaseo/cli", repoName: "paseo" },
    { prNumber: 42, repoOwner: "get$paseo", repoName: "paseo" },
    { prNumber: 42, repoOwner: "getpaseo", repoName: "pa seo" },
    { prNumber: 42, repoOwner: "getpaseo", repoName: "paseo/app" },
    { prNumber: 42, repoOwner: "getpaseo", repoName: "paseo!" },
  ])("returns an unknown error when request identity is invalid: %j", async (identity) => {
    const messages: unknown[] = [];
    const github = {
      invalidate: vi.fn(),
      isAuthenticated: vi.fn().mockResolvedValue(true),
      getPullRequestTimeline: vi.fn(),
    };
    const session = createSessionForTest({ github, messages });

    await session.handleMessage({
      type: "pull_request_timeline_request",
      cwd: "/tmp/repo",
      ...identity,
      requestId: "request-invalid",
    });

    expect(github.isAuthenticated).not.toHaveBeenCalled();
    expect(github.getPullRequestTimeline).not.toHaveBeenCalled();
    expect(messages).toContainEqual({
      type: "pull_request_timeline_response",
      payload: {
        cwd: "/tmp/repo",
        prNumber: identity.prNumber,
        items: [],
        truncated: false,
        error: {
          kind: "unknown",
          message: "Pull request timeline request has invalid PR identity",
        },
        requestId: "request-invalid",
        githubFeaturesEnabled: true,
      },
    });
  });

  test("disables GitHub features when gh auth is unavailable", async () => {
    const messages: unknown[] = [];
    const github = {
      invalidate: vi.fn(),
      isAuthenticated: vi.fn().mockResolvedValue(false),
      getPullRequestTimeline: vi.fn(),
    };
    const session = createSessionForTest({ github, messages });

    await session.handleMessage({
      type: "pull_request_timeline_request",
      cwd: "/tmp/repo",
      prNumber: 42,
      repoOwner: "getpaseo",
      repoName: "paseo",
      requestId: "request-3",
    });

    expect(github.getPullRequestTimeline).not.toHaveBeenCalled();
    expect(messages).toContainEqual({
      type: "pull_request_timeline_response",
      payload: {
        cwd: "/tmp/repo",
        prNumber: 42,
        items: [],
        truncated: false,
        error: {
          kind: "unknown",
          message: "GitHub CLI is unavailable or not authenticated",
        },
        requestId: "request-3",
        githubFeaturesEnabled: false,
      },
    });
  });

  test("emits GitHub check details responses", async () => {
    const messages: unknown[] = [];
    const checkDetailRequests: Array<{
      cwd: string;
      repoOwner: string;
      repoName: string;
      checkRunId: number;
      workflowRunId?: number;
    }> = [];
    const checkDetails: CheckDetails = {
      checkRunId: 12345,
      workflowRunId: 456,
      name: "server-tests",
      status: "completed",
      conclusion: "failure",
      url: "https://github.com/getpaseo/paseo/actions/runs/456/job/789",
      detailsUrl: "https://github.com/getpaseo/paseo/actions/runs/456/job/789",
      output: { title: "Tests failed", summary: "1 failure", text: "Assertion failed" },
      annotations: [],
      failedJobs: [],
      truncated: false,
    };
    const github: Partial<ForgeService> = {
      invalidate() {},
      async isAuthenticated() {
        return true;
      },
      async getCheckDetails(request) {
        checkDetailRequests.push({
          cwd: request.cwd,
          repoOwner: request.repoOwner,
          repoName: request.repoName,
          checkRunId: request.checkRunId,
          workflowRunId: request.workflowRunId,
        });
        return checkDetails;
      },
    };
    const session = createSessionForTest({ github, messages });

    await session.handleMessage({
      type: "checkout.forge.get_check_details.request",
      cwd: "/tmp/repo",
      repoOwner: "getpaseo",
      repoName: "paseo",
      checkRunId: 12345,
      workflowRunId: 456,
      requestId: "request-check-details",
    });

    expect(checkDetailRequests).toEqual([
      {
        cwd: "/tmp/repo",
        repoOwner: "getpaseo",
        repoName: "paseo",
        checkRunId: 12345,
        workflowRunId: 456,
      },
    ]);

    expect(messages).toContainEqual({
      type: "checkout.forge.get_check_details.response",
      payload: {
        cwd: "/tmp/repo",
        success: true,
        details: {
          checkRunId: 12345,
          workflowRunId: 456,
          name: "server-tests",
          status: "completed",
          conclusion: "failure",
          url: "https://github.com/getpaseo/paseo/actions/runs/456/job/789",
          detailsUrl: "https://github.com/getpaseo/paseo/actions/runs/456/job/789",
          output: { title: "Tests failed", summary: "1 failure", text: "Assertion failed" },
          annotations: [],
          failedJobs: [],
          truncated: false,
        },
        error: null,
        requestId: "request-check-details",
      },
    });
  });
});

describe("schedule dispatch routing", () => {
  // Each schedule/* type must reach its domain handler. The injected service stub
  // is unstubbed, so every handler's own try/catch emits its domain rpc_error code.
  // handleMessage receives already-parsed messages, so these fixtures only need to
  // satisfy the TS union here — zod parsing happens upstream at the transport.
  const routingCases: Array<{ msg: SessionInboundMessage; code: string }> = [
    {
      msg: {
        type: "schedule/create",
        requestId: "rt-sched-create",
        prompt: "p",
        cadence: { type: "every", everyMs: 1000 },
        target: { type: "agent", agentId: "00000000-0000-0000-0000-000000000000" },
      },
      code: "schedule_request_failed",
    },
    { msg: { type: "schedule/list", requestId: "rt-sched-list" }, code: "schedule_request_failed" },
    {
      msg: { type: "schedule/inspect", requestId: "rt-sched-inspect", scheduleId: "s1" },
      code: "schedule_request_failed",
    },
    {
      msg: { type: "schedule/logs", requestId: "rt-sched-logs", scheduleId: "s1" },
      code: "schedule_request_failed",
    },
    {
      msg: { type: "schedule/pause", requestId: "rt-sched-pause", scheduleId: "s1" },
      code: "schedule_request_failed",
    },
    {
      msg: { type: "schedule/resume", requestId: "rt-sched-resume", scheduleId: "s1" },
      code: "schedule_request_failed",
    },
    {
      msg: { type: "schedule/delete", requestId: "rt-sched-delete", scheduleId: "s1" },
      code: "schedule_request_failed",
    },
    {
      msg: { type: "schedule/run-once", requestId: "rt-sched-run-once", scheduleId: "s1" },
      code: "schedule_request_failed",
    },
    {
      msg: { type: "schedule/update", requestId: "rt-sched-update", scheduleId: "s1", name: "new" },
      code: "schedule_request_failed",
    },
  ];

  test.each(routingCases)("routes $msg.type to its domain handler", async ({ msg, code }) => {
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForTest({ messages });

    await session.handleMessage(msg);

    const routed = messages
      .filter(
        (m): m is Extract<SessionOutboundMessage, { type: "rpc_error" }> => m.type === "rpc_error",
      )
      .find((m) => m.payload.requestId === msg.requestId);
    expect(routed, `${msg.type} did not route to a handler (silent no-op)`).toBeDefined();
    expect(routed?.payload.code).toBe(code);
  });
});

test("replaces a capable session's complete viewed timeline set", async () => {
  const messages: SessionOutboundMessage[] = [];
  const session = createSessionForTest({ messages });
  session.updateClientCapabilities({ selective_agent_timeline: true });

  await session.handleMessage({
    type: "agent.timeline.set_subscription.request",
    agentIds: ["agent-b", "agent-a", "agent-a"],
    requestId: "timeline-subscription-1",
  });

  expect(messages).toEqual([
    {
      type: "agent.timeline.set_subscription.response",
      payload: {
        agentIds: ["agent-a", "agent-b"],
        requestId: "timeline-subscription-1",
      },
    },
  ]);
});

test("acknowledges a timeline subscription only to its socket source", async () => {
  const messages: SessionOutboundMessage[] = [];
  const targetedMessages: Array<{ source: object; message: SessionOutboundMessage }> = [];
  const session = createSessionForTest({ messages, targetedMessages });
  const capableSocket = {};
  session.updateClientCapabilities({ selective_agent_timeline: true }, capableSocket);

  await session.handleMessage(
    {
      type: "agent.timeline.set_subscription.request",
      agentIds: ["agent-a"],
      requestId: "timeline-subscription-targeted",
    },
    capableSocket,
  );

  expect(messages).toEqual([]);
  expect(targetedMessages).toEqual([
    {
      source: capableSocket,
      message: {
        type: "agent.timeline.set_subscription.response",
        payload: {
          agentIds: ["agent-a"],
          requestId: "timeline-subscription-targeted",
        },
      },
    },
  ]);
});

test("unions viewed timelines across socket sources and removes detached sources", async () => {
  const messages: SessionOutboundMessage[] = [];
  const agentEventListeners: Array<(event: AgentManagerEvent) => void> = [];
  const session = createSessionForTest({
    messages,
    agentManager: {
      subscribe: vi.fn((listener: (event: AgentManagerEvent) => void) => {
        agentEventListeners.push(listener);
        return () => {};
      }),
    },
  });
  session.updateClientCapabilities({ selective_agent_timeline: true });
  const firstSocket = {};
  const secondSocket = {};
  session.updateClientCapabilities({ selective_agent_timeline: true }, firstSocket);
  session.updateClientCapabilities({ selective_agent_timeline: true }, secondSocket);

  await session.handleMessage(
    {
      type: "agent.timeline.set_subscription.request",
      agentIds: ["agent-a"],
      requestId: "timeline-subscription-a",
    },
    firstSocket,
  );
  await session.handleMessage(
    {
      type: "agent.timeline.set_subscription.request",
      agentIds: ["agent-b"],
      requestId: "timeline-subscription-b",
    },
    secondSocket,
  );
  messages.length = 0;

  if (agentEventListeners.length === 0) throw new Error("Agent event listener was not installed");
  const forward = (event: AgentManagerEvent) => {
    for (const listener of agentEventListeners) listener(event);
  };
  forward({
    type: "agent_stream",
    agentId: "agent-a",
    event: {
      type: "timeline",
      provider: "mock",
      item: { type: "assistant_message", messageId: "message-a", text: "A" },
    },
  });
  forward({
    type: "agent_stream",
    agentId: "agent-b",
    event: {
      type: "timeline",
      provider: "mock",
      item: { type: "assistant_message", messageId: "message-b", text: "B" },
    },
  });
  expect(messages.filter((message) => message.type === "agent_stream")).toHaveLength(2);

  const legacySocket = {};
  session.updateClientCapabilities(null, legacySocket);
  expect(session.supportsForSource(CLIENT_CAPS.selectiveAgentTimeline, legacySocket)).toBe(false);
  expect(session.supportsForSource(CLIENT_CAPS.selectiveAgentTimeline, firstSocket)).toBe(true);
  messages.length = 0;
  forward({
    type: "agent_stream",
    agentId: "agent-not-viewed",
    event: {
      type: "timeline",
      provider: "mock",
      item: { type: "assistant_message", messageId: "message-legacy", text: "legacy" },
    },
  });
  expect(messages.some((message) => message.type === "agent_stream")).toBe(true);

  session.clearAgentTimelineSubscription(legacySocket);

  session.clearAgentTimelineSubscription(firstSocket);
  messages.length = 0;
  forward({
    type: "agent_stream",
    agentId: "agent-a",
    event: {
      type: "timeline",
      provider: "mock",
      item: { type: "assistant_message", messageId: "message-a-2", text: "detached A" },
    },
  });
  forward({
    type: "agent_stream",
    agentId: "agent-b",
    event: {
      type: "timeline",
      provider: "mock",
      item: { type: "assistant_message", messageId: "message-b-2", text: "retained B" },
    },
  });
  expect(
    messages.flatMap((message) =>
      message.type === "agent_stream" ? [message.payload.agentId] : [],
    ),
  ).toEqual(["agent-b"]);
});

test("keeps selective delivery scoped per socket when a retained session also has a legacy socket", async () => {
  const messages: SessionOutboundMessage[] = [];
  const targetedMessages: Array<{ source: object; message: SessionOutboundMessage }> = [];
  const agentEventListeners: Array<(event: AgentManagerEvent) => void> = [];
  const session = createSessionForTest({
    messages,
    targetedMessages,
    agentManager: {
      subscribe: vi.fn((listener: (event: AgentManagerEvent) => void) => {
        agentEventListeners.push(listener);
        return () => {};
      }),
    },
  });
  const legacySocket = {};
  const selectiveSocket = {};
  session.updateClientCapabilities(null, legacySocket);
  session.updateClientCapabilities({ selective_agent_timeline: true }, selectiveSocket);
  await session.handleMessage(
    {
      type: "agent.timeline.set_subscription.request",
      agentIds: ["viewed-agent"],
      requestId: "timeline-subscription-selective",
    },
    selectiveSocket,
  );
  targetedMessages.length = 0;

  const listener = agentEventListeners[0];
  if (!listener) throw new Error("Agent event listener was not installed");
  listener({
    type: "agent_stream",
    agentId: "not-viewed-agent",
    event: {
      type: "timeline",
      provider: "mock",
      item: { type: "assistant_message", messageId: "message-global", text: "global" },
    },
  });

  expect(messages).toEqual([]);
  expect(targetedMessages).toEqual([
    {
      source: legacySocket,
      message: expect.objectContaining({
        type: "agent_stream",
        payload: expect.objectContaining({ agentId: "not-viewed-agent" }),
      }),
    },
  ]);
});

test("sends project updates only to capable sockets in a retained session", async () => {
  const messages: SessionOutboundMessage[] = [];
  const targetedMessages: Array<{ source: object; message: SessionOutboundMessage }> = [];
  const session = createSessionForTest({ messages, targetedMessages });
  const legacySocket = {};
  const capableSocket = {};
  session.updateClientCapabilities(null, legacySocket);
  session.updateClientCapabilities({ [CLIENT_CAPS.projectUpdates]: true }, capableSocket);

  await session.emitProjectUpdate({
    kind: "upsert",
    project: createPersistedProjectRecord({
      projectId: "project-capable-socket",
      rootPath: "/tmp/project-capable-socket",
      kind: "git",
      displayName: "project-capable-socket",
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
    }),
  });

  expect(messages).toEqual([]);
  expect(targetedMessages).toEqual([
    {
      source: capableSocket,
      message: expect.objectContaining({
        type: "project.update",
        payload: expect.objectContaining({ kind: "upsert" }),
      }),
    },
  ]);
});

test("project.list returns every active project descriptor", async () => {
  const messages: SessionOutboundMessage[] = [];
  const active = createPersistedProjectRecord({
    projectId: "project-active",
    projectKey: "remote:github.com/acme/app",
    rootPath: "/tmp/project-active",
    kind: "git",
    displayName: "acme/app",
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
  });
  const archived = createPersistedProjectRecord({
    projectId: "project-archived",
    rootPath: "/tmp/project-archived",
    kind: "non_git",
    displayName: "archived",
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
    archivedAt: "2026-07-18T00:00:00.000Z",
  });
  const session = createSessionForTest({
    messages,
    projectRegistry: { list: vi.fn().mockResolvedValue([active, archived]) },
  });

  await session.handleMessage({ type: "project.list.request", requestId: "projects-1" });

  expect(messages).toEqual([
    {
      type: "project.list.response",
      payload: {
        requestId: "projects-1",
        projects: [
          {
            projectId: "project-active",
            projectKey: "remote:github.com/acme/app",
            projectDisplayName: "acme/app",
            projectCustomName: null,
            projectCustomIconRevision: null,
            projectIconRevision: "automatic:none:v1",
            projectRootPath: "/tmp/project-active",
            projectKind: "git",
          },
        ],
      },
    },
  ]);
});

describe("agent config setters", () => {
  function liveAgentManager(overrides: { [K in keyof SessionOptions["agentManager"]]?: unknown }): {
    [K in keyof SessionOptions["agentManager"]]?: unknown;
  } {
    return {
      waitForAgentClose: vi.fn().mockResolvedValue(undefined),
      getAgent: vi.fn(() => ({ id: "agent-1" })),
      ...overrides,
    };
  }

  test("set_agent_mode_request: success emits accepted response carrying the notice", async () => {
    const messages: SessionOutboundMessage[] = [];
    const notice = { type: "info", message: "Switched to plan mode" } as const;
    const session = createSessionForTest({
      messages,
      agentManager: liveAgentManager({ setAgentMode: vi.fn().mockResolvedValue(notice) }),
    });

    await session.handleMessage({
      type: "set_agent_mode_request",
      agentId: "agent-1",
      modeId: "plan",
      requestId: "req-mode-ok",
    });

    expect(messages).toEqual([
      {
        type: "set_agent_mode_response",
        payload: {
          requestId: "req-mode-ok",
          agentId: "agent-1",
          accepted: true,
          error: null,
          notice,
        },
      },
    ]);
  });

  test("set_agent_mode_request: failure emits the activity_log error frame before the rejected response", async () => {
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForTest({
      messages,
      agentManager: liveAgentManager({
        setAgentMode: vi.fn().mockRejectedValue(new Error("mode boom")),
      }),
    });

    await session.handleMessage({
      type: "set_agent_mode_request",
      agentId: "agent-1",
      modeId: "plan",
      requestId: "req-mode-err",
    });

    expect(messages.map((m) => m.type)).toEqual(["activity_log", "set_agent_mode_response"]);
    expect(messages[0]).toEqual({
      type: "activity_log",
      payload: {
        id: expect.any(String),
        timestamp: expect.any(Date),
        type: "error",
        content: "Failed to set agent mode: mode boom",
      },
    });
    expect(messages[1]).toEqual({
      type: "set_agent_mode_response",
      payload: {
        requestId: "req-mode-err",
        agentId: "agent-1",
        accepted: false,
        error: "mode boom",
      },
    });
  });

  test("set_agent_model_request: success emits accepted response with no notice", async () => {
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForTest({
      messages,
      agentManager: liveAgentManager({ setAgentModel: vi.fn().mockResolvedValue(undefined) }),
    });

    await session.handleMessage({
      type: "set_agent_model_request",
      agentId: "agent-1",
      modelId: "claude-opus-4-8",
      requestId: "req-model-ok",
    });

    expect(messages).toEqual([
      {
        type: "set_agent_model_response",
        payload: { requestId: "req-model-ok", agentId: "agent-1", accepted: true, error: null },
      },
    ]);
  });

  test("set_agent_model_request: failure emits the activity_log error frame before the rejected response", async () => {
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForTest({
      messages,
      agentManager: liveAgentManager({
        setAgentModel: vi.fn().mockRejectedValue(new Error("model boom")),
      }),
    });

    await session.handleMessage({
      type: "set_agent_model_request",
      agentId: "agent-1",
      modelId: "claude-opus-4-8",
      requestId: "req-model-err",
    });

    expect(messages.map((m) => m.type)).toEqual(["activity_log", "set_agent_model_response"]);
    expect(messages[0]).toEqual({
      type: "activity_log",
      payload: {
        id: expect.any(String),
        timestamp: expect.any(Date),
        type: "error",
        content: "Failed to set agent model: model boom",
      },
    });
    expect(messages[1]).toEqual({
      type: "set_agent_model_response",
      payload: {
        requestId: "req-model-err",
        agentId: "agent-1",
        accepted: false,
        error: "model boom",
      },
    });
  });

  test("set_agent_feature_request: success emits accepted response with no notice", async () => {
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForTest({
      messages,
      agentManager: liveAgentManager({ setAgentFeature: vi.fn().mockResolvedValue(undefined) }),
    });

    await session.handleMessage({
      type: "set_agent_feature_request",
      agentId: "agent-1",
      featureId: "web_search",
      value: true,
      requestId: "req-feature-ok",
    });

    expect(messages).toEqual([
      {
        type: "set_agent_feature_response",
        payload: { requestId: "req-feature-ok", agentId: "agent-1", accepted: true, error: null },
      },
    ]);
  });

  test("set_agent_feature_request: failure emits the activity_log error frame before the rejected response", async () => {
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForTest({
      messages,
      agentManager: liveAgentManager({
        setAgentFeature: vi.fn().mockRejectedValue(new Error("feature boom")),
      }),
    });

    await session.handleMessage({
      type: "set_agent_feature_request",
      agentId: "agent-1",
      featureId: "web_search",
      value: true,
      requestId: "req-feature-err",
    });

    expect(messages.map((m) => m.type)).toEqual(["activity_log", "set_agent_feature_response"]);
    expect(messages[0]).toEqual({
      type: "activity_log",
      payload: {
        id: expect.any(String),
        timestamp: expect.any(Date),
        type: "error",
        content: "Failed to set agent feature: feature boom",
      },
    });
    expect(messages[1]).toEqual({
      type: "set_agent_feature_response",
      payload: {
        requestId: "req-feature-err",
        agentId: "agent-1",
        accepted: false,
        error: "feature boom",
      },
    });
  });

  test("set_agent_thinking_request: success emits accepted response carrying the notice", async () => {
    const messages: SessionOutboundMessage[] = [];
    const notice = { type: "warning", message: "Thinking budget reduced" } as const;
    const session = createSessionForTest({
      messages,
      agentManager: liveAgentManager({
        setAgentThinkingOption: vi.fn().mockResolvedValue(notice),
      }),
    });

    await session.handleMessage({
      type: "set_agent_thinking_request",
      agentId: "agent-1",
      thinkingOptionId: "high",
      requestId: "req-thinking-ok",
    });

    expect(messages).toEqual([
      {
        type: "set_agent_thinking_response",
        payload: {
          requestId: "req-thinking-ok",
          agentId: "agent-1",
          accepted: true,
          error: null,
          notice,
        },
      },
    ]);
  });

  test("set_agent_thinking_request: failure emits the activity_log error frame before the rejected response", async () => {
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForTest({
      messages,
      agentManager: liveAgentManager({
        setAgentThinkingOption: vi.fn().mockRejectedValue(new Error("thinking boom")),
      }),
    });

    await session.handleMessage({
      type: "set_agent_thinking_request",
      agentId: "agent-1",
      thinkingOptionId: "high",
      requestId: "req-thinking-err",
    });

    expect(messages.map((m) => m.type)).toEqual(["activity_log", "set_agent_thinking_response"]);
    expect(messages[0]).toEqual({
      type: "activity_log",
      payload: {
        id: expect.any(String),
        timestamp: expect.any(Date),
        type: "error",
        content: "Failed to set agent thinking option: thinking boom",
      },
    });
    expect(messages[1]).toEqual({
      type: "set_agent_thinking_response",
      payload: {
        requestId: "req-thinking-err",
        agentId: "agent-1",
        accepted: false,
        error: "thinking boom",
      },
    });
  });
});
