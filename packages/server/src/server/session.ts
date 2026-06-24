import equal from "fast-deep-equal";
import { v4 as uuidv4 } from "uuid";
import type { FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, normalize, resolve, sep } from "path";
import { homedir } from "node:os";
import type { ToolSet } from "ai";
import { CLIENT_CAPS, type ClientCapability } from "@getpaseo/protocol/client-capabilities";
import {
  serializeAgentStreamEvent,
  type AgentSnapshotPayload,
  type AgentAttachment,
  type FirstAgentContext,
  type SessionInboundMessage,
  type SessionOutboundMessage,
  type GitSetupOptions,
  type StartWorkspaceScriptRequest,
  type CloseItemsRequest,
  type DirectorySuggestionsRequest,
  type ProjectPlacementPayload,
  type WorkspaceSetupSnapshot,
  type WorkspaceDescriptorPayload,
} from "./messages.js";
import type {
  TerminalManager,
  TerminalWorkspaceContributionChangedEvent,
} from "../terminal/terminal-manager.js";
import { TerminalSessionController } from "../terminal/terminal-session-controller.js";
import type { TerminalActivity } from "@getpaseo/protocol/terminal-activity";
import type { BinaryFrame } from "@getpaseo/protocol/binary-frames/index";
import { CursorError } from "./pagination/cursor.js";
import { SortablePager, type SortSpec } from "./pagination/sortable-pager.js";
import type { SpeechToTextProvider, TextToSpeechProvider } from "./speech/speech-provider.js";
import type { TurnDetectionProvider } from "./speech/turn-detection-provider.js";
import {
  buildConfigOverrides,
  extractTimestamps,
  isStoredAgentProviderAvailable,
  toAgentPersistenceHandle,
} from "./persistence-hooks.js";
import { ensureAgentLoaded } from "./agent/agent-loading.js";
import {
  formatSystemNotificationPrompt,
  sendPromptToAgent,
  waitForAgentRunStartWithTimeout,
  unarchiveAgentState,
} from "./agent/agent-prompt.js";
import {
  resolveCreateAgentTitles,
  resolveFirstAgentPromptTitle,
} from "./agent/create-agent-title.js";
import { respondToAgentPermission } from "./agent/permission-response.js";
import { experimental_createMCPClient } from "ai";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { VoiceCallerContext, VoiceSpeakHandler } from "./voice-types.js";
import {
  buildWorkspaceScriptPayloads,
  readPaseoConfigForProjection,
} from "./script-status-projection.js";
import { deriveProjectSlug } from "./workspace-git-metadata.js";
import type { ScriptHealthState } from "./script-health-monitor.js";
import { spawnWorkspaceScript } from "./worktree-bootstrap.js";
import type { WorkspaceScriptRuntimeStore } from "./workspace-script-runtime-store.js";
import type { DaemonConfigStore } from "./daemon-config-store.js";
import { getErrorMessage, getErrorMessageOr } from "@getpaseo/protocol/error-utils";
import { getAgentStatusPriority } from "@getpaseo/protocol/agent-state-bucket";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type { WorkspaceGitRuntimeSnapshot, WorkspaceGitService } from "./workspace-git-service.js";

import { AgentManager } from "./agent/agent-manager.js";
import { ProviderSnapshotManager } from "./agent/provider-snapshot-manager.js";
import type {
  AgentManagerEvent,
  AgentTimelineCursor,
  AgentTimelineFetchDirection,
  AgentTimelineFetchResult,
  ManagedAgent,
} from "./agent/agent-manager.js";
import { createAgentCommand } from "./agent/create-agent/create.js";
import {
  archiveAgentCommand,
  cancelAgentRunCommand,
  closeAgentCommand,
  detachAgentCommand,
  setAgentModeCommand,
  updateAgentCommand,
} from "./agent/lifecycle-command.js";
import {
  buildStoredAgentPayload,
  resolveEffectiveThinkingOptionId,
  resolveStoredAgentPayloadUpdatedAt,
  toAgentPayload,
} from "./agent/agent-projections.js";
import {
  appendTimelineItemIfAgentKnown,
  emitLiveTimelineItemIfAgentKnown,
} from "./agent/timeline-append.js";
import {
  projectTimelineRows,
  selectProjectedTimelinePage,
  type TimelineProjectionEntry,
  type TimelineProjectionMode,
} from "./agent/timeline-projection.js";
import type { StructuredGenerationDaemonConfig } from "./agent/structured-generation-providers.js";
import {
  getAgentStreamEventTurnId,
  type AgentPersistenceHandle,
  type AgentPermissionResponse,
  type AgentPromptContentBlock,
  type AgentPromptInput,
  type AgentRunOptions,
  type AgentSessionConfig,
} from "./agent/agent-sdk-types.js";
import type { StoredAgentRecord } from "./agent/agent-storage.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import {
  ImportSessionsRequestError,
  importProviderSession,
  listImportableProviderSessions,
  normalizeImportAgentRequest,
} from "./agent/import-sessions.js";
import {
  checkoutLiteFromGitSnapshot,
  classifyDirectoryForProjectMembership,
  deriveWorkspaceDisplayName,
  generateWorkspaceId,
} from "./workspace-registry-model.js";
import { resolveWorkspaceIdForPath } from "./resolve-workspace-id-for-path.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
  resolveProjectDisplayName,
  resolveWorkspaceDisplayName,
  resolveWorkspaceName,
  type PersistedProjectRecord,
  type PersistedWorkspaceRecord,
  type ProjectRegistry,
  type WorkspaceRegistry,
} from "./workspace-registry.js";
import { wrapSpokenInput } from "./voice-config.js";
import { isVoicePermissionAllowed } from "./voice-permission-policy.js";
import { VoiceSession } from "./session/voice/voice-session.js";
import { CheckoutSession } from "./session/checkout/checkout-session.js";
import {
  createAgentStructuredTextGeneration,
  createGitMetadataGenerator,
} from "./session/checkout/git-metadata-generator.js";
import { ChatScheduleLoopSession } from "./session/chat/chat-schedule-loop-session.js";
import { ProviderCatalogSession } from "./session/provider/provider-catalog-session.js";
import { WorkspaceFilesSession } from "./session/files/workspace-files-session.js";
import { AgentConfigSession } from "./session/agent-config/agent-config-session.js";
import { ProjectConfigSession } from "./session/project-config/project-config-session.js";
import { DaemonSession, type DaemonRuntimeConfig } from "./session/daemon/daemon-session.js";
import { DownloadTokenStore } from "./file-download/token-store.js";
import { PushTokenStore } from "./push/token-store.js";
import {
  archivePersistedWorkspaceRecord,
  archiveWorkspaceContents,
} from "./workspace-archive-service.js";
import { WorkspaceReconciliationService } from "./workspace-reconciliation-service.js";
import type { ServiceProxySubsystem } from "./service-proxy.js";
import { renameCurrentBranch as renameCurrentBranchDefault } from "../utils/checkout-git.js";
import {
  createGitMutationService,
  type GitMutationService,
} from "./session/git-mutation/git-mutation-service.js";
import { expandTilde } from "../utils/path.js";
import { searchHomeDirectories, searchWorkspaceEntries } from "../utils/directory-suggestions.js";
import type { CheckoutDiffManager } from "./checkout-diff-manager.js";
import type { Resolvable } from "./speech/provider-resolver.js";
import type { SpeechReadinessSnapshot } from "./speech/speech-runtime.js";
import type pino from "pino";
import { FileBackedChatService } from "./chat/chat-service.js";
import { LoopService } from "./loop-service.js";
import { ScheduleService } from "./schedule/service.js";
import { createGitHubService, type GitHubService } from "../services/github-service.js";
import type { ProviderUsageService } from "../services/quota-fetcher/service.js";
import {
  summarizeFetchWorkspacesEntries,
  workspaceIdsOnCheckout,
  WorkspaceDirectory,
  type WorkspaceUpdatesFilter,
} from "./workspace-directory.js";
import { shouldEmitPendingBootstrapUpdate } from "./workspace-bootstrap-dedupe.js";
import {
  attemptFirstAgentBranchAutoName,
  createLocalCheckoutWorkspace,
  createPaseoWorktree,
  type CreatePaseoWorktreeInput,
  type CreatePaseoWorktreeResult,
} from "./paseo-worktree-service.js";
import {
  generateBranchNameFromFirstAgentContext,
  type GeneratedWorkspaceName,
} from "./worktree-branch-name-generator.js";
import {
  buildAgentSessionConfig as buildWorktreeAgentSessionConfig,
  createPaseoWorktreeWorkflow as createWorktreeWorkflow,
  type CreatePaseoWorktreeSetupContinuationInput,
  type CreatePaseoWorktreeWorkflowResult,
  handleCreatePaseoWorktreeRequest as handleCreateWorktreeRequest,
  handlePaseoWorktreeArchiveRequest as handleWorktreeArchiveRequest,
  handlePaseoWorktreeListRequest as handleWorktreeListRequest,
  handleWorkspaceSetupStatusRequest as handleWorkspaceSetupStatusRequestMessage,
} from "./worktree-session.js";
import { archiveByScope, type ActiveWorkspaceRef } from "./workspace-archive-service.js";
import {
  WorktreeRequestError,
  toWorktreeRequestError,
  toWorktreeWireError,
} from "./worktree-errors.js";
import { type WorktreeConfig, createWorktree } from "../utils/worktree.js";
import { runGitCommand } from "../utils/run-git-command.js";
import { CreateAgentLifecycleDispatch } from "./agent/create-agent-lifecycle-dispatch.js";

const WORKSPACE_GIT_WATCH_REMOVED_STATE_KEY = "__removed__";

// TODO: Remove once all app store clients are on >=0.1.45 and understand arbitrary provider strings.
// Clients before 0.1.45 validate providers with z.enum(["claude", "codex", "opencode"]) and reject
// the entire session message if they encounter an unknown provider.
const LEGACY_PROVIDER_IDS = new Set(["claude", "codex", "opencode"]);
const MIN_VERSION_ALL_PROVIDERS = "0.1.45";

function errorToFriendlyMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown error";
}

function resolveSubscriptionId(
  subscribe: unknown,
  requestedSubscriptionId: string | undefined,
): string | null {
  if (!subscribe) return null;
  if (requestedSubscriptionId && requestedSubscriptionId.length > 0) {
    return requestedSubscriptionId;
  }
  return uuidv4();
}

function buildWorkspaceCheckout(
  workspace: PersistedWorkspaceRecord,
  project: PersistedProjectRecord,
  // The persisted `branch` field is the source of truth, but it is null for
  // records created before branch was lifted to its own field (no migrations,
  // per data-model.md) and for any path that didn't backfill it. Fall back to
  // the live git branch so checkout.currentBranch never regresses to null.
  fallbackBranch?: string | null,
): ProjectPlacementPayload["checkout"] {
  if (project.kind !== "git") {
    return {
      cwd: workspace.cwd,
      isGit: false,
      currentBranch: null,
      remoteUrl: null,
      worktreeRoot: null,
      isPaseoOwnedWorktree: false,
      mainRepoRoot: null,
    };
  }
  const currentBranch = workspace.branch ?? fallbackBranch ?? null;
  if (workspace.kind === "worktree") {
    return {
      cwd: workspace.cwd,
      isGit: true,
      currentBranch,
      remoteUrl: null,
      worktreeRoot: workspace.cwd,
      isPaseoOwnedWorktree: true,
      mainRepoRoot: project.rootPath,
    };
  }
  return {
    cwd: workspace.cwd,
    isGit: true,
    currentBranch,
    remoteUrl: null,
    worktreeRoot: workspace.cwd,
    isPaseoOwnedWorktree: false,
    mainRepoRoot: null,
  };
}

function isAppVersionAtLeast(appVersion: string | null, minVersion: string): boolean {
  if (!appVersion) return false;
  // Strip prerelease suffix: "0.1.45-beta.4" -> "0.1.45"
  const base = appVersion.replace(/-.*$/, "");
  const parts = base.split(".").map(Number);
  const minParts = minVersion.split(".").map(Number);
  for (let i = 0; i < minParts.length; i++) {
    const a = parts[i] ?? 0;
    const b = minParts[i] ?? 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

function clientSupportsAllProviders(appVersion: string | null): boolean {
  return isAppVersionAtLeast(appVersion, MIN_VERSION_ALL_PROVIDERS);
}

type DeleteFencedAgentStorage = AgentStorage & {
  beginDelete(agentId: string): void;
};

function beginAgentDeleteIfSupported(agentStorage: AgentStorage, agentId: string): void {
  if ("beginDelete" in agentStorage && typeof agentStorage.beginDelete === "function") {
    (agentStorage as DeleteFencedAgentStorage).beginDelete(agentId);
  }
}

const FETCH_AGENTS_SORT_KEYS = ["status_priority", "created_at", "updated_at", "title"] as const;

export function resolveWaitForFinishError(options: {
  status: "permission" | "error" | "idle";
  final: AgentSnapshotPayload | null;
}): string | null {
  if (options.status !== "error") {
    return null;
  }
  const message = options.final?.lastError;
  return typeof message === "string" && message.trim().length > 0 ? message : "Agent failed";
}

interface WorkspaceGitWatchTarget {
  cwd: string;
  workspaceId: string;
  watchers: FSWatcher[];
  debounceTimer: ReturnType<typeof setTimeout> | null;
  refreshPromise: Promise<void> | null;
  refreshQueued: boolean;
  latestDescriptorStateKey: string | null;
  lastBranchName: string | null;
}

export interface SessionRuntimeMetrics {
  terminalDirectorySubscriptionCount: number;
  terminalSubscriptionCount: number;
  inflightRequests: number;
  peakInflightRequests: number;
}

type FetchAgentsRequestMessage = Extract<SessionInboundMessage, { type: "fetch_agents_request" }>;
type FetchAgentHistoryRequestMessage = Extract<
  SessionInboundMessage,
  { type: "fetch_agent_history_request" }
>;
type AgentDirectoryRequestMessage = FetchAgentsRequestMessage | FetchAgentHistoryRequestMessage;
type FetchAgentsRequestFilter = NonNullable<FetchAgentsRequestMessage["filter"]>;
type FetchAgentsRequestSort = NonNullable<FetchAgentsRequestMessage["sort"]>[number];
type FetchAgentsResponsePayload = Extract<
  SessionOutboundMessage,
  { type: "fetch_agents_response" }
>["payload"];
type FetchAgentsResponseEntry = FetchAgentsResponsePayload["entries"][number];
type FetchAgentsResponsePageInfo = FetchAgentsResponsePayload["pageInfo"];
type AgentUpdatePayload = Extract<SessionOutboundMessage, { type: "agent_update" }>["payload"];
type AgentUpdatesFilter = FetchAgentsRequestFilter;
interface AgentUpdatesSubscriptionState {
  subscriptionId: string;
  filter?: AgentUpdatesFilter;
  isBootstrapping: boolean;
  pendingUpdatesByAgentId: Map<string, AgentUpdatePayload>;
}
type FetchWorkspacesRequestMessage = Extract<
  SessionInboundMessage,
  { type: "fetch_workspaces_request" }
>;
type FetchWorkspacesRequestFilter = NonNullable<FetchWorkspacesRequestMessage["filter"]>;
type FetchWorkspacesResponsePayload = Extract<
  SessionOutboundMessage,
  { type: "fetch_workspaces_response" }
>["payload"];
type FetchWorkspacesResponseEntry = FetchWorkspacesResponsePayload["entries"][number];
type FetchWorkspacesResponsePageInfo = FetchWorkspacesResponsePayload["pageInfo"];
type WorkspaceProjectDescriptorPayload = FetchWorkspacesResponsePayload["emptyProjects"][number];
type WorkspaceUpdatePayload = Extract<
  SessionOutboundMessage,
  { type: "workspace_update" }
>["payload"];
interface WorkspaceUpdatesSubscriptionState {
  subscriptionId: string;
  filter?: WorkspaceUpdatesFilter;
  isBootstrapping: boolean;
  pendingUpdatesByWorkspaceId: Map<string, WorkspaceUpdatePayload>;
  lastEmittedByWorkspaceId: Map<string, WorkspaceUpdatePayload>;
}

class SessionRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SessionRequestError";
  }
}

export interface SessionFileSystem {
  isDirectory(path: string): Promise<boolean>;
}

const nodeSessionFileSystem: SessionFileSystem = {
  async isDirectory(path) {
    const stats = await stat(path).catch(() => null);
    return stats?.isDirectory() ?? false;
  },
};

// Stub types for features under development (modules not yet available)
type AgentMcpTransportFactory = () => Promise<unknown>;

export interface SessionOptions {
  clientId: string;
  appVersion?: string | null;
  clientCapabilities?: Record<string, unknown> | null;
  onMessage: (msg: SessionOutboundMessage) => void;
  onBinaryMessage?: (frame: Uint8Array) => void;
  getTransportBufferedAmount?: () => number | null;
  onLifecycleIntent?: (intent: SessionLifecycleIntent) => void;
  logger: pino.Logger;
  downloadTokenStore: DownloadTokenStore;
  pushTokenStore: PushTokenStore;
  paseoHome: string;
  worktreesRoot?: string;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  projectRegistry: ProjectRegistry;
  workspaceRegistry: WorkspaceRegistry;
  filesystem?: SessionFileSystem;
  chatService: FileBackedChatService;
  scheduleService: ScheduleService;
  loopService: LoopService;
  checkoutDiffManager: CheckoutDiffManager;
  github?: GitHubService;
  createAgentMcpTransport?: AgentMcpTransportFactory;
  // Injected so tests can substitute the git branch rename without module mocks;
  // defaults to the real checkout-git implementation.
  renameCurrentBranch?: typeof renameCurrentBranchDefault;
  // Injected so tests can substitute workspace title/branch generation without
  // calling the LLM; defaults to the real first-agent-context generator.
  generateWorkspaceName?: typeof generateBranchNameFromFirstAgentContext;
  workspaceGitService: WorkspaceGitService;
  daemonConfigStore: DaemonConfigStore;
  mcpBaseUrl?: string | null;
  stt: Resolvable<SpeechToTextProvider | null>;
  sttLanguage?: string;
  tts: Resolvable<TextToSpeechProvider | null>;
  terminalManager: TerminalManager | null;
  providerSnapshotManager: ProviderSnapshotManager;
  providerUsageService: ProviderUsageService;
  serviceProxy?: ServiceProxySubsystem;
  scriptRuntimeStore?: WorkspaceScriptRuntimeStore;
  workspaceSetupSnapshots?: Map<string, WorkspaceSetupSnapshot>;
  onBranchChanged?: (
    workspaceId: string,
    oldBranch: string | null,
    newBranch: string | null,
  ) => void;
  getDaemonTcpPort?: () => number | null;
  getDaemonTcpHost?: () => string | null;
  serviceProxyPublicBaseUrl?: string | null;
  resolveScriptHealth?: (hostname: string) => ScriptHealthState | null;
  voice?: {
    turnDetection?: Resolvable<TurnDetectionProvider | null>;
  };
  voiceBridge?: {
    registerVoiceSpeakHandler?: (agentId: string, handler: VoiceSpeakHandler) => void;
    unregisterVoiceSpeakHandler?: (agentId: string) => void;
    registerVoiceCallerContext?: (agentId: string, context: VoiceCallerContext) => void;
    unregisterVoiceCallerContext?: (agentId: string) => void;
  };
  dictation?: {
    finalTimeoutMs?: number;
    stt?: Resolvable<SpeechToTextProvider | null>;
    sttLanguage?: string;
    getSpeechReadiness?: () => SpeechReadinessSnapshot;
  };
  serverId?: string;
  daemonVersion?: string;
  daemonRuntimeConfig?: DaemonRuntimeConfig;
}

export type SessionLifecycleIntent =
  | {
      type: "shutdown";
      clientId: string;
      requestId: string;
    }
  | {
      type: "restart";
      clientId: string;
      requestId: string;
      reason?: string;
    };

function parseClientCapabilities(
  capabilities: Record<string, unknown> | null | undefined,
): ReadonlySet<ClientCapability> {
  if (!capabilities) {
    return new Set();
  }
  const known = new Set<ClientCapability>(Object.values(CLIENT_CAPS));
  const result: ClientCapability[] = [];
  for (const [key, value] of Object.entries(capabilities)) {
    if (value === true && known.has(key as ClientCapability)) {
      result.push(key as ClientCapability);
    }
  }
  return new Set(result);
}

interface AgentTimelineProjectionSelection {
  timeline: AgentTimelineFetchResult;
  entries: TimelineProjectionEntry[];
  startSeq: number | null;
  endSeq: number | null;
  hasOlder: boolean;
  hasNewer: boolean;
}

type RegistryTransition = "created" | "unarchived" | "existing";

interface ArchivedRecordSnapshot {
  archivedAt?: string | null;
}

function describeRegistryTransition(record: ArchivedRecordSnapshot | null): RegistryTransition {
  if (!record) {
    return "created";
  }
  return record.archivedAt ? "unarchived" : "existing";
}

/**
 * Session represents a single connected client session.
 * It owns all state management, orchestration logic, and message processing.
 * Session has no knowledge of WebSockets - it only emits and receives messages.
 */
export class Session {
  private readonly clientId: string;
  private appVersion: string | null;
  private clientCapabilities: ReadonlySet<ClientCapability>;
  private readonly sessionId: string;
  private readonly onMessage: (msg: SessionOutboundMessage) => void;
  private readonly onBinaryMessage: ((frame: Uint8Array) => void) | null;
  private readonly getTransportBufferedAmount: () => number | null;
  private readonly onLifecycleIntent: ((intent: SessionLifecycleIntent) => void) | null;
  private readonly sessionLogger: pino.Logger;
  private readonly paseoHome: string;
  private readonly worktreesRoot: string | undefined;

  // Per-session MCP client and tools
  private agentMcpClient: Awaited<ReturnType<typeof experimental_createMCPClient>> | null = null;
  private agentTools: ToolSet | null = null;
  private agentManager: AgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly projectRegistry: ProjectRegistry;
  private readonly workspaceRegistry: WorkspaceRegistry;
  private readonly filesystem: SessionFileSystem;
  private readonly github: GitHubService;
  private readonly renameCurrentBranch: typeof renameCurrentBranchDefault;
  private readonly generateWorkspaceName: typeof generateBranchNameFromFirstAgentContext;
  private readonly workspaceGitService: WorkspaceGitService;
  private readonly gitMutation: GitMutationService;
  private readonly daemonConfigStore: DaemonConfigStore;
  private readonly mcpBaseUrl: string | null;
  private readonly pushTokenStore: PushTokenStore;
  private unsubscribeAgentEvents: (() => void) | null = null;
  private unsubscribeTerminalWorkspaceContributionEvents: (() => void) | null = null;
  private agentUpdatesSubscription: AgentUpdatesSubscriptionState | null = null;
  private workspaceUpdatesSubscription: WorkspaceUpdatesSubscriptionState | null = null;
  private clientActivity: {
    deviceType: "web" | "mobile";
    focusedAgentId: string | null;
    focusedTerminalId: string | null;
    lastActivityAt: Date;
    appVisible: boolean;
    appVisibilityChangedAt: Date;
  } | null = null;
  private readonly terminalManager: TerminalManager | null;
  private readonly providerSnapshotManager: ProviderSnapshotManager;
  private readonly serviceProxy: ServiceProxySubsystem | null;
  private readonly scriptRuntimeStore: WorkspaceScriptRuntimeStore | null;
  private readonly onBranchChanged?: (
    workspaceId: string,
    oldBranch: string | null,
    newBranch: string | null,
  ) => void;
  private readonly getDaemonTcpPort: (() => number | null) | null;
  private readonly getDaemonTcpHost: (() => string | null) | null;
  private readonly serviceProxyPublicBaseUrl: string | null;
  private readonly resolveScriptHealth: ((hostname: string) => ScriptHealthState | null) | null;
  private readonly terminalController: TerminalSessionController;
  private inflightRequests = 0;
  private peakInflightRequests = 0;
  private readonly workspaceGitWatchTargets = new Map<string, WorkspaceGitWatchTarget>();
  private readonly workspaceSetupSnapshots: Map<string, WorkspaceSetupSnapshot>;
  private readonly workspaceGitFetchSubscriptions = new Map<string, () => void>();
  private readonly workspaceGitSubscriptions = new Map<string, () => void>();
  private readonly workspaceDirectory: WorkspaceDirectory;
  private readonly voiceSession: VoiceSession;
  private readonly checkoutSession: CheckoutSession;
  private readonly chatScheduleLoopSession: ChatScheduleLoopSession;
  private readonly providerCatalogSession: ProviderCatalogSession;
  private readonly workspaceFilesSession: WorkspaceFilesSession;
  private readonly agentConfigSession: AgentConfigSession;
  private readonly projectConfigSession: ProjectConfigSession;
  private readonly daemonSession: DaemonSession;
  private readonly createAgentLifecycleDispatch: CreateAgentLifecycleDispatch;

  constructor(options: SessionOptions) {
    const {
      clientId,
      appVersion,
      clientCapabilities,
      onMessage,
      onBinaryMessage,
      getTransportBufferedAmount,
      onLifecycleIntent,
      logger,
      downloadTokenStore,
      pushTokenStore,
      paseoHome,
      worktreesRoot,
      agentManager,
      agentStorage,
      projectRegistry,
      workspaceRegistry,
      filesystem,
      chatService,
      scheduleService,
      loopService,
      checkoutDiffManager,
      github,
      renameCurrentBranch,
      generateWorkspaceName,
      workspaceGitService,
      daemonConfigStore,
      mcpBaseUrl,
      stt,
      sttLanguage,
      tts,
      terminalManager,
      providerSnapshotManager,
      providerUsageService,
      serviceProxy,
      scriptRuntimeStore,
      workspaceSetupSnapshots,
      onBranchChanged,
      getDaemonTcpPort,
      getDaemonTcpHost,
      serviceProxyPublicBaseUrl,
      resolveScriptHealth,
      voice,
      voiceBridge,
      dictation,
      serverId,
      daemonVersion,
      daemonRuntimeConfig,
    } = options;
    this.clientId = clientId;
    this.appVersion = appVersion ?? null;
    this.clientCapabilities = parseClientCapabilities(clientCapabilities);
    this.sessionId = uuidv4();
    this.onMessage = onMessage;
    this.onBinaryMessage = onBinaryMessage ?? null;
    this.getTransportBufferedAmount = getTransportBufferedAmount ?? (() => 0);
    this.onLifecycleIntent = onLifecycleIntent ?? null;
    this.pushTokenStore = pushTokenStore;
    this.paseoHome = paseoHome;
    this.worktreesRoot = worktreesRoot;
    this.sessionLogger = logger.child({
      module: "session",
      clientId: this.clientId,
      sessionId: this.sessionId,
    });
    this.workspaceFilesSession = new WorkspaceFilesSession({
      host: {
        emit: (msg) => this.emit(msg),
        emitBinary: (frame) => this.emitBinary(frame),
        hasBinaryChannel: () => this.onBinaryMessage !== null,
      },
      downloadTokenStore,
      paseoHome,
      logger: this.sessionLogger,
    });
    this.agentManager = agentManager;
    this.agentStorage = agentStorage;
    this.projectRegistry = projectRegistry;
    this.workspaceRegistry = workspaceRegistry;
    this.filesystem = filesystem ?? nodeSessionFileSystem;
    this.github = github ?? createGitHubService();
    this.renameCurrentBranch = renameCurrentBranch ?? renameCurrentBranchDefault;
    this.generateWorkspaceName = generateWorkspaceName ?? generateBranchNameFromFirstAgentContext;
    this.workspaceGitService = workspaceGitService;
    this.gitMutation = createGitMutationService({
      workspaceGitService: this.workspaceGitService,
      github: this.github,
      logger: this.sessionLogger,
    });
    this.checkoutSession = new CheckoutSession({
      host: {
        emit: (msg) => this.emit(msg),
        emitWorkspaceUpdateForCwd: (cwd) => this.emitWorkspaceUpdateForCwd(cwd),
        handleWorkspaceGitBranchSnapshot: (cwd, branchName) =>
          this.handleWorkspaceGitBranchSnapshot(cwd, branchName),
        renameCurrentBranch: (cwd, branch) => this.renameCurrentBranch(cwd, branch),
      },
      gitMutation: this.gitMutation,
      workspaceGitService: this.workspaceGitService,
      github: this.github,
      checkoutDiffManager,
      gitMetadataGenerator: createGitMetadataGenerator({
        workspaceGitService: this.workspaceGitService,
        generation: createAgentStructuredTextGeneration({
          agentManager: this.agentManager,
          providerSnapshotManager,
          readDaemonConfig: () => this.readStructuredGenerationDaemonConfig(),
          getFocusedSelection: (cwd) => this.getFocusedAgentSelectionForCwd(cwd),
        }),
      }),
      paseoHome: this.paseoHome,
      worktreesRoot: this.worktreesRoot,
      logger: this.sessionLogger,
    });
    this.chatScheduleLoopSession = new ChatScheduleLoopSession({
      host: {
        emit: (msg) => this.emit(msg),
        listStoredAgents: () => this.agentStorage.list(),
        listLiveAgents: () => this.agentManager.listAgents(),
        resolveAgentIdentifier: (identifier) => this.resolveAgentIdentifier(identifier),
        sendAgentMessage: async (agentId, text) => {
          await sendPromptToAgent({
            agentManager: this.agentManager,
            agentStorage: this.agentStorage,
            agentId,
            prompt: formatSystemNotificationPrompt(text),
            unarchive: false,
            logger: this.sessionLogger,
          });
        },
      },
      chatService,
      scheduleService,
      loopService,
      clientId: this.clientId,
      logger: this.sessionLogger,
    });
    this.providerCatalogSession = new ProviderCatalogSession({
      host: {
        emit: (msg) => this.emit(msg),
        isProviderVisibleToClient: (provider) => this.isProviderVisibleToClient(provider),
        supportsCustomModeIcons: () => this.supports(CLIENT_CAPS.customModeIcons),
        listProviderAvailability: () => this.agentManager.listProviderAvailability(),
        listDraftFeatures: (config) => this.agentManager.listDraftFeatures(config),
      },
      providerSnapshotManager,
      providerUsageService,
      logger: this.sessionLogger,
    });
    this.agentConfigSession = new AgentConfigSession({
      host: {
        emit: (msg) => this.emit(msg),
      },
      operations: {
        setMode: async (agentId, modeId) =>
          (await setAgentModeCommand({ agentManager }, { agentId, modeId })).notice,
        setModel: (agentId, modelId) => agentManager.setAgentModel(agentId, modelId),
        setFeature: (agentId, featureId, value) =>
          agentManager.setAgentFeature(agentId, featureId, value),
        setThinking: (agentId, thinkingOptionId) =>
          agentManager.setAgentThinkingOption(agentId, thinkingOptionId),
      },
      logger: this.sessionLogger,
    });
    this.projectConfigSession = new ProjectConfigSession({
      host: {
        emit: (msg) => this.emit(msg),
      },
      projectRegistry: this.projectRegistry,
      logger: this.sessionLogger,
    });
    this.daemonSession = new DaemonSession({
      host: {
        emit: (msg) => this.emit(msg),
      },
      paseoHome: this.paseoHome,
      serverId,
      daemonVersion,
      daemonRuntimeConfig,
      listProviderAvailability: () => this.agentManager.listProviderAvailability(),
      logger: this.sessionLogger,
    });
    this.daemonConfigStore = daemonConfigStore;
    this.mcpBaseUrl = mcpBaseUrl ?? null;
    this.terminalManager = terminalManager;
    this.terminalController = new TerminalSessionController({
      terminalManager,
      emit: (msg) => this.emit(msg),
      emitBinary: (frame) => this.emitBinary(frame),
      hasBinaryChannel: () => this.onBinaryMessage !== null,
      isPathWithinRoot: (rootPath, candidatePath) => this.isPathWithinRoot(rootPath, candidatePath),
      sessionLogger: this.sessionLogger,
      listTerminalWorkspaceRefs: () => this.listActiveWorkspaceRefs(),
      clientSupportsWrapReflow: () =>
        this.clientCapabilities.has(CLIENT_CAPS.terminalReflowableSnapshot),
      getClientBufferedAmount: () => this.getTransportBufferedAmount(),
    });
    this.createAgentLifecycleDispatch = new CreateAgentLifecycleDispatch({
      paseoHome: this.paseoHome,
      worktreesRoot: this.worktreesRoot,
      agentManager: this.agentManager,
      agentStorage: this.agentStorage,
      github: this.github,
      workspaceGitService: this.workspaceGitService,
      createPaseoWorktreeWorkflow: (input, workflowOptions) =>
        this.createPaseoWorktreeWorkflow(input, workflowOptions),
      archiveAgentForClose: (agentId) => this.archiveAgentForClose(agentId),
      findWorkspaceIdForCwd: (cwd) => this.findWorkspaceIdForCwd(cwd),
      listActiveWorkspaces: () => this.listActiveWorkspaceRefs(),
      archiveWorkspaceRecord: (workspaceId) => this.archiveWorkspaceRecord(workspaceId),
      emit: (message) => this.emit(message),
      emitAgentRemove: (agentId) => {
        if (this.agentUpdatesSubscription) {
          this.bufferOrEmitAgentUpdate(this.agentUpdatesSubscription, {
            kind: "remove",
            agentId,
          });
        }
      },
      emitWorkspaceUpdatesForWorkspaceIds: (workspaceIds) =>
        this.emitWorkspaceUpdatesForWorkspaceIds(workspaceIds),
      markWorkspaceArchiving: (workspaceIds, archivingAt) =>
        this.markWorkspaceArchiving(workspaceIds, archivingAt),
      clearWorkspaceArchiving: (workspaceIds) => this.clearWorkspaceArchiving(workspaceIds),
      killTerminalsForWorkspace: (workspaceId) =>
        this.terminalController.killTerminalsForWorkspace(workspaceId),
      logger: this.sessionLogger,
    });
    this.providerSnapshotManager = providerSnapshotManager;
    this.serviceProxy = serviceProxy ?? null;
    this.scriptRuntimeStore = scriptRuntimeStore ?? null;
    this.workspaceSetupSnapshots = workspaceSetupSnapshots ?? new Map();
    this.onBranchChanged = onBranchChanged;
    this.getDaemonTcpPort = getDaemonTcpPort ?? null;
    this.getDaemonTcpHost = getDaemonTcpHost ?? null;
    this.serviceProxyPublicBaseUrl = serviceProxyPublicBaseUrl ?? null;
    this.resolveScriptHealth = resolveScriptHealth ?? null;
    this.subscribeToOptionalManagers();
    this.workspaceDirectory = new WorkspaceDirectory({
      logger: this.sessionLogger,
      projectRegistry: this.projectRegistry,
      workspaceRegistry: this.workspaceRegistry,
      listAgentPayloads: () => this.listAgentPayloads(),
      listTerminalActivityContributions: () => this.listTerminalActivityContributions(),
      isProviderVisibleToClient: (provider) => this.isProviderVisibleToClient(provider),
      buildWorkspaceDescriptor: (input) => this.buildWorkspaceDescriptor(input),
    });

    this.voiceSession = new VoiceSession({
      host: {
        emit: (msg) => this.emit(msg),
        loadAgent: (agentId) =>
          ensureAgentLoaded(agentId, {
            agentManager: this.agentManager,
            agentStorage: this.agentStorage,
            logger: this.sessionLogger,
          }),
        reloadAgentSession: (agentId, overrides) =>
          this.agentManager.reloadAgentSession(agentId, overrides),
        sendSpokenInput: async (agentId, text) => {
          await this.handleSendAgentMessage(
            agentId,
            text,
            undefined,
            undefined,
            undefined,
            undefined,
            { spokenInput: true },
          );
        },
        interruptAgentIfRunning: (agentId) => this.interruptAgentIfRunning(agentId),
        hasActiveAgentRun: (agentId) => this.hasActiveAgentRun(agentId),
      },
      logger: this.sessionLogger,
      sessionId: this.sessionId,
      sttLanguage,
      tts,
      stt,
      voice,
      voiceBridge,
      dictation,
    });

    // Initialize agent MCP client asynchronously
    void this.initializeAgentMcp();
    this.subscribeToAgentEvents();

    this.sessionLogger.trace({}, "agent.session.lifecycle.created");
  }

  updateAppVersion(appVersion: string | null): void {
    if (appVersion && appVersion !== this.appVersion) {
      this.appVersion = appVersion;
    }
  }

  updateClientCapabilities(capabilities: Record<string, unknown> | null): void {
    this.clientCapabilities = parseClientCapabilities(capabilities);
  }

  supports(capability: ClientCapability): boolean {
    return this.clientCapabilities.has(capability);
  }

  async syncWorkspaceGitObserverForWorkspace(workspace: PersistedWorkspaceRecord): Promise<void> {
    const descriptor = await this.describeWorkspaceRecordWithGitData(workspace);
    this.syncWorkspaceGitObservers([descriptor]);
  }

  async emitWorkspaceUpdateForWorkspaceId(workspaceId: string): Promise<void> {
    await this.emitWorkspaceUpdatesForWorkspaceIds([workspaceId], { skipReconcile: true });
  }

  async archiveWorkspaceRecordForExternalMutation(workspaceId: string): Promise<void> {
    await this.archiveWorkspaceRecord(workspaceId);
  }

  markWorkspaceArchivingForExternalMutation(
    workspaceIds: Iterable<string>,
    archivingAt: string,
  ): void {
    this.markWorkspaceArchiving(workspaceIds, archivingAt);
  }

  clearWorkspaceArchivingForExternalMutation(workspaceIds: Iterable<string>): void {
    this.clearWorkspaceArchiving(workspaceIds);
  }

  async emitWorkspaceUpdatesForExternalWorkspaceIds(workspaceIds: Iterable<string>): Promise<void> {
    await this.emitWorkspaceUpdatesForWorkspaceIds(workspaceIds);
  }

  async warmWorkspaceGitDataForWorkspace(workspace: PersistedWorkspaceRecord): Promise<void> {
    await this.syncWorkspaceGitObserverForWorkspace(workspace);
    await this.emitWorkspaceUpdateForWorkspaceId(workspace.workspaceId);
  }

  /**
   * Get the client's current activity state
   */
  public getClientActivity(): {
    deviceType: "web" | "mobile";
    focusedAgentId: string | null;
    focusedTerminalId: string | null;
    lastActivityAt: Date;
    appVisible: boolean;
    appVisibilityChangedAt: Date;
  } | null {
    return this.clientActivity;
  }

  private getFocusedAgentSelectionForCwd(cwd: string):
    | {
        provider?: string | null;
        model?: string | null;
        thinkingOptionId?: string | null;
      }
    | undefined {
    const focusedAgentId = this.clientActivity?.focusedAgentId;
    if (!focusedAgentId) {
      return undefined;
    }

    const agent = this.agentManager.getAgent(focusedAgentId);
    if (!agent || agent.cwd !== cwd) {
      return undefined;
    }

    return {
      provider: agent.provider,
      model: agent.runtimeInfo?.model ?? agent.config.model ?? null,
      thinkingOptionId:
        agent.runtimeInfo?.thinkingOptionId ?? agent.config.thinkingOptionId ?? null,
    };
  }

  private readStructuredGenerationDaemonConfig(): StructuredGenerationDaemonConfig {
    return {
      metadataGeneration: this.daemonConfigStore.get().metadataGeneration,
    };
  }

  public getRuntimeMetrics(): SessionRuntimeMetrics {
    const terminalMetrics = this.terminalController.getMetrics();
    return {
      terminalDirectorySubscriptionCount: terminalMetrics.directorySubscriptionCount,
      terminalSubscriptionCount: terminalMetrics.streamSubscriptionCount,
      inflightRequests: this.inflightRequests,
      peakInflightRequests: this.peakInflightRequests,
    };
  }

  public emitServerMessage(message: SessionOutboundMessage): void {
    this.emit(message);
  }

  /**
   * Send initial state to client after connection
   */
  public async sendInitialState(): Promise<void> {
    // No unsolicited agent list hydration. Callers must use fetch_agents_request.
  }

  /**
   * Normalize a user prompt (with optional image metadata) for AgentManager
   */
  private buildAgentPrompt(
    text: string,
    images?: Array<{ data: string; mimeType: string }>,
    attachments?: AgentAttachment[],
  ): AgentPromptInput {
    const normalized = text?.trim() ?? "";
    const hasImages = Boolean(images && images.length > 0);
    const hasAttachments = Boolean(attachments && attachments.length > 0);
    if (!hasImages && !hasAttachments) {
      return normalized;
    }
    const blocks: AgentPromptContentBlock[] = [];
    if (normalized.length > 0) {
      blocks.push({ type: "text", text: normalized });
    }
    for (const image of images ?? []) {
      blocks.push({ type: "image", data: image.data, mimeType: image.mimeType });
    }
    for (const attachment of attachments ?? []) {
      blocks.push(attachment);
    }
    return blocks;
  }

  /**
   * Interrupt the agent's active run so the next prompt starts a fresh turn.
   * Returns once the manager confirms the stream has been cancelled.
   */
  private async interruptAgentIfRunning(agentId: string): Promise<void> {
    const snapshot = this.agentManager.getAgent(agentId);
    if (!snapshot) {
      this.sessionLogger.trace({ agentId }, "agent.session.interrupt.not_found");
      throw new Error(`Agent ${agentId} not found`);
    }

    const hasInFlightRun = this.agentManager.hasInFlightRun(agentId);
    if (!hasInFlightRun) {
      this.sessionLogger.trace(
        {
          agentId,
          provider: snapshot.provider,
          lifecycle: snapshot.lifecycle,
          hasInFlightRun,
        },
        "agent.session.interrupt.skip_not_running",
      );
      return;
    }

    this.sessionLogger.debug(
      { agentId, lifecycle: snapshot.lifecycle, hasInFlightRun },
      "interruptAgentIfRunning: interrupting",
    );

    const t0 = Date.now();
    const cancelled = await this.agentManager.cancelAgentRun(agentId);
    this.sessionLogger.debug(
      { agentId, cancelled, durationMs: Date.now() - t0 },
      "interruptAgentIfRunning: cancelAgentRun completed",
    );
    if (!cancelled) {
      this.sessionLogger.warn(
        { agentId },
        "interruptAgentIfRunning: reported running but no active run was cancelled",
      );
    }
  }

  private hasActiveAgentRun(agentId: string | null): boolean {
    if (!agentId) {
      return false;
    }
    return this.agentManager.hasInFlightRun(agentId);
  }

  private handleAgentRunError(agentId: string, error: unknown, context: string): void {
    const message = errorToFriendlyMessage(error);
    this.sessionLogger.error({ err: error, agentId, context }, `${context} for agent ${agentId}`);
    this.emit({
      type: "activity_log",
      payload: {
        id: uuidv4(),
        timestamp: new Date(),
        type: "error",
        content: `${context}: ${message}`,
      },
    });
  }

  /**
   * Initialize Agent MCP client for this session using the daemon's HTTP MCP endpoint.
   */
  private async initializeAgentMcp(): Promise<void> {
    try {
      if (!this.mcpBaseUrl) {
        this.sessionLogger.info(
          "Skipping Agent MCP initialization because no MCP base URL is configured",
        );
        return;
      }
      const authToken = this.agentManager.getMcpAuthToken();
      const transport = new StreamableHTTPClientTransport(
        new URL(this.mcpBaseUrl),
        authToken
          ? { requestInit: { headers: { Authorization: `Bearer ${authToken}` } } }
          : undefined,
      );

      this.agentMcpClient = await experimental_createMCPClient({
        transport,
      });

      this.agentTools = (await this.agentMcpClient.tools()) as ToolSet;
      const agentToolCount = Object.keys(this.agentTools ?? {}).length;
      this.sessionLogger.trace({ agentToolCount }, "agent.session.mcp_init");
    } catch (error) {
      this.sessionLogger.error({ err: error }, "Failed to initialize Agent MCP");
    }
  }

  /**
   * Subscribe to AgentManager events and forward them to the client
   */
  private subscribeToOptionalManagers(): void {
    this.terminalController.start();
    if (this.terminalManager) {
      this.unsubscribeTerminalWorkspaceContributionEvents =
        this.terminalManager.subscribeTerminalWorkspaceContributionChanged((event) => {
          void this.emitWorkspaceUpdateForTerminalContribution(event).catch((error) => {
            this.sessionLogger.warn(
              { err: error, terminalId: event.terminalId },
              "Failed to emit workspace update after terminal contribution changed",
            );
          });
        });
    }
    this.providerCatalogSession.start();
  }

  private subscribeToAgentEvents(): void {
    if (this.unsubscribeAgentEvents) {
      this.unsubscribeAgentEvents();
    }

    this.unsubscribeAgentEvents = this.agentManager.subscribe(
      (event) => {
        if (event.type === "agent_state") {
          this.sessionLogger.trace(
            {
              agentId: event.agent.id,
              provider: event.agent.provider,
              providerSessionId: event.agent.persistence?.sessionId ?? undefined,
              turnId: event.agent.activeForegroundTurnId ?? undefined,
              lifecycle: event.agent.lifecycle,
            },
            "agent.session.forward_update",
          );
          void this.forwardAgentUpdate(event.agent);
          return;
        }

        if (
          this.voiceSession.isActiveForAgent(event.agentId) &&
          event.event.type === "permission_requested" &&
          isVoicePermissionAllowed(event.event.request)
        ) {
          const requestId = event.event.request.id;
          void this.agentManager
            .respondToPermission(event.agentId, requestId, {
              behavior: "allow",
            })
            .catch((error) => {
              this.sessionLogger.warn(
                {
                  err: error,
                  agentId: event.agentId,
                  requestId,
                },
                "Failed to auto-allow speak tool permission in voice mode",
              );
            });
        }

        const serializedEvent = serializeAgentStreamEvent(event.event);
        if (!serializedEvent) {
          return;
        }
        this.sessionLogger.trace(
          {
            agentId: event.agentId,
            provider: event.event.provider,
            turnId: getAgentStreamEventTurnId(event.event),
            seq: event.seq,
            epoch: event.epoch,
            event: event.event,
          },
          "agent.session.forward_stream",
        );

        this.emit({
          type: "agent_stream",
          payload: this.buildAgentStreamPayload(event, serializedEvent),
        });

        if (event.event.type === "permission_requested") {
          this.emit({
            type: "agent_permission_request",
            payload: {
              agentId: event.agentId,
              request: event.event.request,
            },
          });
        } else if (event.event.type === "permission_resolved") {
          this.emit({
            type: "agent_permission_resolved",
            payload: {
              agentId: event.agentId,
              requestId: event.event.requestId,
              resolution: event.event.resolution,
            },
          });
        }

        // Title updates may be applied asynchronously after agent creation.
      },
      { replayState: false },
    );
  }

  private buildAgentStreamPayload(
    event: Extract<AgentManagerEvent, { type: "agent_stream" }>,
    serializedEvent: Extract<SessionOutboundMessage, { type: "agent_stream" }>["payload"]["event"],
  ): Extract<SessionOutboundMessage, { type: "agent_stream" }>["payload"] {
    return {
      agentId: event.agentId,
      event: serializedEvent,
      timestamp: event.timestamp ?? new Date().toISOString(),
      ...(typeof event.seq === "number" ? { seq: event.seq } : {}),
      ...(typeof event.epoch === "string" ? { epoch: event.epoch } : {}),
    };
  }

  private async buildAgentPayload(agent: ManagedAgent): Promise<AgentSnapshotPayload> {
    const storedRecord = await this.agentStorage.get(agent.id);
    const title = storedRecord?.title ?? null;
    const payload = toAgentPayload(agent, { title });
    const storedUpdatedAt = storedRecord ? resolveStoredAgentPayloadUpdatedAt(storedRecord) : null;
    if (storedUpdatedAt) {
      const liveUpdatedAt = Date.parse(payload.updatedAt);
      const persistedUpdatedAt = Date.parse(storedUpdatedAt);
      if (Number.isNaN(liveUpdatedAt) || persistedUpdatedAt > liveUpdatedAt) {
        payload.updatedAt = storedUpdatedAt;
      }
    }
    payload.archivedAt = storedRecord?.archivedAt ?? null;
    return payload;
  }

  private buildStoredAgentPayload(
    record: StoredAgentRecord,
    registeredProviderIds = new Set(this.providerSnapshotManager.listRegisteredProviderIds()),
  ): AgentSnapshotPayload {
    return buildStoredAgentPayload(record, registeredProviderIds);
  }

  private isProviderVisibleToClient(provider: string): boolean {
    if (clientSupportsAllProviders(this.appVersion)) {
      return true;
    }
    return LEGACY_PROVIDER_IDS.has(provider);
  }

  private agentThinkingOptionMatchesFilter(
    agent: AgentSnapshotPayload,
    filter: AgentUpdatesFilter,
  ): boolean {
    if (filter.thinkingOptionId === undefined) {
      return true;
    }
    const expectedThinkingOptionId = resolveEffectiveThinkingOptionId({
      configuredThinkingOptionId: filter.thinkingOptionId ?? null,
    });
    const resolvedThinkingOptionId =
      agent.effectiveThinkingOptionId ??
      resolveEffectiveThinkingOptionId({
        runtimeInfo: agent.runtimeInfo,
        configuredThinkingOptionId: agent.thinkingOptionId ?? null,
      });
    return resolvedThinkingOptionId === expectedThinkingOptionId;
  }

  private matchesAgentStructuralFilter(
    agent: AgentSnapshotPayload,
    project: ProjectPlacementPayload,
    filter: AgentUpdatesFilter,
  ): boolean {
    if (filter.statuses && filter.statuses.length > 0) {
      const statuses = new Set(filter.statuses);
      if (!statuses.has(agent.status)) {
        return false;
      }
    }

    if (typeof filter.requiresAttention === "boolean") {
      const requiresAttention = agent.requiresAttention ?? false;
      if (requiresAttention !== filter.requiresAttention) {
        return false;
      }
    }

    if (filter.projectKeys && filter.projectKeys.length > 0) {
      const projectKeys = new Set(filter.projectKeys.filter((item) => item.trim().length > 0));
      if (projectKeys.size > 0 && !projectKeys.has(project.projectKey)) {
        return false;
      }
    }
    return true;
  }

  private matchesAgentFilter(options: {
    agent: AgentSnapshotPayload;
    project: ProjectPlacementPayload;
    filter?: AgentUpdatesFilter;
  }): boolean {
    const { agent, project, filter } = options;

    if (filter?.labels) {
      const matchesLabels = Object.entries(filter.labels).every(
        ([key, value]) => agent.labels[key] === value,
      );
      if (!matchesLabels) {
        return false;
      }
    }

    const includeArchived = filter?.includeArchived ?? false;
    if (!includeArchived && agent.archivedAt) {
      return false;
    }

    if (filter && !this.agentThinkingOptionMatchesFilter(agent, filter)) {
      return false;
    }

    if (filter && !this.matchesAgentStructuralFilter(agent, project, filter)) {
      return false;
    }

    return true;
  }

  private getAgentUpdateTargetId(update: AgentUpdatePayload): string {
    return update.kind === "remove" ? update.agentId : update.agent.id;
  }

  private bufferOrEmitAgentUpdate(
    subscription: AgentUpdatesSubscriptionState,
    payload: AgentUpdatePayload,
  ): void {
    if (payload.kind === "upsert" && !this.isProviderVisibleToClient(payload.agent.provider)) {
      return;
    }
    if (subscription.isBootstrapping) {
      subscription.pendingUpdatesByAgentId.set(this.getAgentUpdateTargetId(payload), payload);
      return;
    }

    this.emit({
      type: "agent_update",
      payload,
    });
  }

  private async emitStoredAgentUpdate(record: StoredAgentRecord): Promise<AgentSnapshotPayload> {
    const payload = this.buildStoredAgentPayload(record);
    const subscription = this.agentUpdatesSubscription;
    if (!subscription) {
      return payload;
    }

    const project = payload.workspaceId
      ? await this.buildProjectPlacementForWorkspaceId(payload.workspaceId)
      : null;
    if (!project) {
      this.bufferOrEmitAgentUpdate(subscription, {
        kind: "remove",
        agentId: payload.id,
      });
      return payload;
    }

    const matches = this.matchesAgentFilter({
      agent: payload,
      project,
      filter: subscription.filter,
    });
    this.bufferOrEmitAgentUpdate(
      subscription,
      matches
        ? {
            kind: "upsert",
            agent: payload,
            project,
          }
        : {
            kind: "remove",
            agentId: payload.id,
          },
    );
    return payload;
  }

  private flushBootstrappedAgentUpdates(options?: {
    snapshotUpdatedAtByAgentId?: Map<string, number>;
  }): void {
    const subscription = this.agentUpdatesSubscription;
    if (!subscription || !subscription.isBootstrapping) {
      return;
    }

    subscription.isBootstrapping = false;
    const pending = Array.from(subscription.pendingUpdatesByAgentId.values());
    subscription.pendingUpdatesByAgentId.clear();

    for (const payload of pending) {
      if (payload.kind === "upsert") {
        const snapshotUpdatedAt = options?.snapshotUpdatedAtByAgentId?.get(payload.agent.id);
        if (typeof snapshotUpdatedAt === "number") {
          const updateUpdatedAt = Date.parse(payload.agent.updatedAt);
          if (!Number.isNaN(updateUpdatedAt) && updateUpdatedAt <= snapshotUpdatedAt) {
            continue;
          }
        }
      }

      this.emit({
        type: "agent_update",
        payload,
      });
    }
  }

  private async findExactWorkspaceByDirectory(
    cwd: string,
    options?: { refreshGit?: boolean },
  ): Promise<PersistedWorkspaceRecord | null> {
    const normalizedCwd = await this.resolveWorkspaceDirectory(cwd, options);
    const workspaces = await this.workspaceRegistry.list();
    return workspaces.find((workspace) => workspace.cwd === normalizedCwd) ?? null;
  }

  private async resolveWorkspaceDirectory(
    cwd: string,
    options?: { refreshGit?: boolean },
  ): Promise<string> {
    const normalizedCwd = resolve(cwd);
    if (options?.refreshGit === false) {
      const snapshot = this.workspaceGitService.peekSnapshot(normalizedCwd);
      return resolve(snapshot?.git.repoRoot ?? normalizedCwd);
    }

    const checkout = await this.workspaceGitService.getCheckout(normalizedCwd);
    return resolve(checkout.worktreeRoot ?? normalizedCwd);
  }

  private async buildProjectPlacementForWorkspace(
    workspace: PersistedWorkspaceRecord,
    projectRecord?: PersistedProjectRecord | null,
  ): Promise<ProjectPlacementPayload> {
    const project = projectRecord ?? (await this.projectRegistry.get(workspace.projectId));
    if (!project) {
      throw new Error(`Project not found for workspace ${workspace.workspaceId}`);
    }
    const liveBranch =
      this.workspaceGitService.peekSnapshot(workspace.cwd)?.git.currentBranch ?? null;
    const checkout = buildWorkspaceCheckout(workspace, project, liveBranch);
    return {
      projectKey: project.projectId,
      projectName: resolveProjectDisplayName(project),
      workspaceName: resolveWorkspaceDisplayName(workspace),
      checkout,
    };
  }

  private async buildProjectPlacementForWorkspaceId(
    workspaceId: string,
  ): Promise<ProjectPlacementPayload | null> {
    const workspace = await this.workspaceRegistry.get(workspaceId);
    if (!workspace) return null;
    return this.buildProjectPlacementForWorkspace(workspace);
  }

  private async buildProjectPlacementForExistingWorkspaceProject(
    workspaceId: string,
  ): Promise<ProjectPlacementPayload | null> {
    const workspace = await this.workspaceRegistry.get(workspaceId);
    if (!workspace) return null;

    const project = await this.projectRegistry.get(workspace.projectId);
    if (!project) return null;
    return this.buildProjectPlacementForWorkspace(workspace, project);
  }

  private async forwardAgentUpdate(agent: ManagedAgent): Promise<void> {
    try {
      const subscription = this.agentUpdatesSubscription;
      const payload = await this.buildAgentPayload(agent);
      if (subscription) {
        const project = payload.workspaceId
          ? await this.buildProjectPlacementForWorkspaceId(payload.workspaceId)
          : null;
        if (!project) {
          this.bufferOrEmitAgentUpdate(subscription, {
            kind: "remove",
            agentId: payload.id,
          });
        } else {
          const matches = this.matchesAgentFilter({
            agent: payload,
            project,
            filter: subscription.filter,
          });

          if (matches) {
            this.bufferOrEmitAgentUpdate(subscription, {
              kind: "upsert",
              agent: payload,
              project,
            });
          } else {
            this.bufferOrEmitAgentUpdate(subscription, {
              kind: "remove",
              agentId: payload.id,
            });
          }
        }
      }

      // A lifecycle change updates exactly the agent's owning workspace, never
      // every workspace sharing its cwd. Ownership is the agent's workspaceId.
      if (payload.workspaceId) {
        await this.emitWorkspaceUpdateForWorkspaceId(payload.workspaceId);
      }
    } catch (error) {
      this.sessionLogger.error({ err: error }, "Failed to emit agent update");
    }
  }

  /**
   * Main entry point for processing session messages
   */
  public async handleMessage(msg: SessionInboundMessage): Promise<void> {
    this.inflightRequests++;
    if (this.inflightRequests > this.peakInflightRequests) {
      this.peakInflightRequests = this.inflightRequests;
    }
    try {
      this.sessionLogger.trace(
        {
          messageType: msg.type,
          payloadBytes: JSON.stringify(msg).length,
        },
        "agent.session.inbound",
      );
      try {
        await this.dispatchInboundMessage(msg);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.sessionLogger.error({ err }, "Error handling message");

        const requestId =
          "requestId" in msg && typeof msg.requestId === "string" ? msg.requestId : undefined;
        if (typeof requestId === "string") {
          try {
            this.emit({
              type: "rpc_error",
              payload: {
                requestId,
                requestType: msg.type,
                error: `Request failed: ${err.message}`,
                code: "handler_error",
              },
            });
          } catch (emitError) {
            this.sessionLogger.error({ err: emitError }, "Failed to emit rpc_error");
          }
        }

        this.emit({
          type: "activity_log",
          payload: {
            id: uuidv4(),
            timestamp: new Date(),
            type: "error",
            content: `Error: ${err.message}`,
          },
        });
      }
    } finally {
      this.inflightRequests--;
    }
  }

  private async dispatchInboundMessage(msg: SessionInboundMessage): Promise<void> {
    const promise =
      this.dispatchVoiceAndControlMessage(msg) ??
      this.dispatchAgentRewindMessage(msg) ??
      this.dispatchAgentRelationshipMessage(msg) ??
      this.dispatchAgentLifecycleMessage(msg) ??
      this.dispatchAgentConfigMessage(msg) ??
      this.dispatchCheckoutMessage(msg) ??
      this.dispatchWorkspaceAndProjectMessage(msg) ??
      this.dispatchProviderMessage(msg) ??
      this.dispatchTerminalMessage(msg) ??
      this.dispatchChatScheduleLoopMessage(msg) ??
      this.dispatchMiscMessage(msg);
    if (promise) await promise;
  }

  private dispatchVoiceAndControlMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "voice_audio_chunk":
        return this.voiceSession.handleAudioChunk(msg);
      case "abort_request":
        return this.voiceSession.handleAbort();
      case "audio_played":
        this.voiceSession.handleAudioPlayed(msg.id);
        return undefined;
      case "set_voice_mode":
        return this.voiceSession.handleSetVoiceMode(msg.enabled, msg.agentId, msg.requestId);
      case "dictation_stream_start":
        return this.voiceSession.handleDictationStreamStart(msg);
      case "dictation_stream_chunk":
        return this.voiceSession.handleDictationChunk({
          dictationId: msg.dictationId,
          seq: msg.seq,
          audioBase64: msg.audio,
          format: msg.format,
        });
      case "dictation_stream_finish":
        return this.voiceSession.handleDictationFinish(msg.dictationId, msg.finalSeq);
      case "dictation_stream_cancel":
        this.voiceSession.handleDictationCancel(msg.dictationId);
        return undefined;
      case "restart_server_request":
        return this.handleRestartServerRequest(msg.requestId, msg.reason);
      case "shutdown_server_request":
        return this.handleShutdownServerRequest(msg.requestId);
      case "client_heartbeat":
        this.handleClientHeartbeat(msg);
        return undefined;
      case "ping": {
        const now = Date.now();
        this.emit({
          type: "pong",
          payload: {
            requestId: msg.requestId,
            clientSentAt: msg.clientSentAt,
            serverReceivedAt: now,
            serverSentAt: now,
          },
        });
        return undefined;
      }
      default:
        return undefined;
    }
  }

  private dispatchAgentRewindMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "agent.rewind.request":
        return this.handleAgentRewindRequest(msg);
      default:
        return undefined;
    }
  }

  private dispatchAgentRelationshipMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "agent.detach.request":
        return this.handleDetachAgentRequest(msg.agentId, msg.requestId);
      default:
        return undefined;
    }
  }

  private dispatchAgentLifecycleMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "fetch_agents_request":
        return this.handleFetchAgents(msg);
      case "fetch_agent_history_request":
        return this.handleFetchAgentHistory(msg);
      case "fetch_recent_provider_sessions_request":
        return this.handleFetchRecentProviderSessions(msg);
      case "fetch_agent_request":
        return this.handleFetchAgent(msg.agentId, msg.requestId);
      case "delete_agent_request":
        return this.handleDeleteAgentRequest(msg.agentId, msg.requestId);
      case "archive_agent_request":
        return this.handleArchiveAgentRequest(msg.agentId, msg.requestId);
      case "close_items_request":
        return this.handleCloseItemsRequest(msg);
      case "update_agent_request":
        return this.handleUpdateAgentRequest(msg.agentId, msg.name, msg.labels, msg.requestId);
      case "project.rename.request":
        return this.handleProjectRenameRequest(msg.projectId, msg.customName, msg.requestId);
      case "send_agent_message_request":
        return this.handleSendAgentMessageRequest(msg);
      case "wait_for_finish_request":
        return this.handleWaitForFinish(msg.agentId, msg.requestId, msg.timeoutMs);
      case "create_agent_request":
        return this.handleCreateAgentRequest(msg);
      case "resume_agent_request":
        return this.handleResumeAgentRequest(msg);
      case "import_agent_request":
        return this.handleImportAgentRequest(msg);
      case "refresh_agent_request":
        return this.handleRefreshAgentRequest(msg);
      case "cancel_agent_request":
        return this.handleCancelAgentRequest(msg.agentId, msg.requestId);
      case "fetch_agent_timeline_request":
        return this.handleFetchAgentTimelineRequest(msg);
      case "agent_permission_response":
        return this.handleAgentPermissionResponse(msg.agentId, msg.requestId, msg.response);
      case "clear_agent_attention":
        return this.handleClearAgentAttention(msg.agentId, msg.requestId);
      default:
        return undefined;
    }
  }

  private dispatchAgentConfigMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "set_agent_mode_request":
        return this.agentConfigSession.handleSetAgentModeRequest(msg);
      case "set_agent_model_request":
        return this.agentConfigSession.handleSetAgentModelRequest(msg);
      case "set_agent_feature_request":
        return this.agentConfigSession.handleSetAgentFeatureRequest(msg);
      case "set_agent_thinking_request":
        return this.agentConfigSession.handleSetAgentThinkingRequest(msg);
      case "get_daemon_config_request":
        this.emit({
          type: "get_daemon_config_response",
          payload: { requestId: msg.requestId, config: this.daemonConfigStore.get() },
        });
        return undefined;
      case "daemon.get_status.request":
        return this.daemonSession.handleGetStatusRequest(msg);
      case "daemon.get_pairing_offer.request":
        return this.daemonSession.handleGetPairingOfferRequest(msg);
      case "set_daemon_config_request":
        this.emit({
          type: "set_daemon_config_response",
          payload: {
            requestId: msg.requestId,
            config: this.daemonConfigStore.patch(msg.config),
          },
        });
        return undefined;
      case "read_project_config_request":
        return this.projectConfigSession.handleReadProjectConfigRequest(msg);
      case "write_project_config_request":
        return this.projectConfigSession.handleWriteProjectConfigRequest(msg);
      default:
        return undefined;
    }
  }

  // eslint-disable-next-line complexity
  private dispatchCheckoutMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "checkout_status_request":
        return this.checkoutSession.handleStatusRequest(msg);
      case "validate_branch_request":
        return this.checkoutSession.handleValidateBranchRequest(msg);
      case "branch_suggestions_request":
        return this.checkoutSession.handleBranchSuggestionsRequest(msg);
      case "directory_suggestions_request":
        return this.handleDirectorySuggestionsRequest(msg);
      case "subscribe_checkout_diff_request":
        return this.checkoutSession.handleSubscribeDiffRequest(msg);
      case "unsubscribe_checkout_diff_request":
        this.checkoutSession.handleUnsubscribeDiffRequest(msg);
        return undefined;
      case "checkout_switch_branch_request":
        return this.checkoutSession.handleCheckoutSwitchBranchRequest(msg);
      case "checkout.rename_branch.request":
        return this.checkoutSession.handleCheckoutRenameBranchRequest(msg);
      case "checkout_commit_request":
        return this.checkoutSession.handleCheckoutCommitRequest(msg);
      case "checkout_merge_request":
        return this.checkoutSession.handleCheckoutMergeRequest(msg);
      case "checkout_merge_from_base_request":
        return this.checkoutSession.handleCheckoutMergeFromBaseRequest(msg);
      case "checkout_pull_request":
        return this.checkoutSession.handleCheckoutPullRequest(msg);
      case "checkout_push_request":
        return this.checkoutSession.handleCheckoutPushRequest(msg);
      case "checkout.refresh.request":
        return this.checkoutSession.handleRefreshRequest(msg);
      case "checkout_pr_create_request":
        return this.checkoutSession.handleCheckoutPrCreateRequest(msg);
      case "checkout_pr_merge_request":
        return this.checkoutSession.handleCheckoutPrMergeRequest(msg);
      case "checkout.github.set_auto_merge.request":
        return this.checkoutSession.handleCheckoutGithubSetAutoMergeRequest(msg);
      case "checkout.github.get_check_details.request":
        return this.checkoutSession.handleCheckoutGithubGetCheckDetailsRequest(msg);
      case "checkout_pr_status_request":
        return this.checkoutSession.handleCheckoutPrStatusRequest(msg);
      case "pull_request_timeline_request":
        return this.checkoutSession.handlePullRequestTimelineRequest(msg);
      case "github_search_request":
        return this.checkoutSession.handleGitHubSearchRequest(msg);
      case "stash_save_request":
        return this.checkoutSession.handleStashSaveRequest(msg);
      case "stash_pop_request":
        return this.checkoutSession.handleStashPopRequest(msg);
      case "stash_list_request":
        return this.checkoutSession.handleStashListRequest(msg);
      default:
        return undefined;
    }
  }

  private dispatchWorkspaceAndProjectMessage(
    msg: SessionInboundMessage,
  ): Promise<void> | undefined {
    switch (msg.type) {
      case "fetch_workspaces_request":
        return this.handleFetchWorkspacesRequest(msg);
      case "paseo_worktree_list_request":
        return this.handlePaseoWorktreeListRequest(msg);
      case "paseo_worktree_archive_request":
        return this.handlePaseoWorktreeArchiveRequest(msg);
      case "create_paseo_worktree_request":
        return this.handleCreatePaseoWorktreeRequest(msg);
      case "workspace_setup_status_request":
        return this.handleWorkspaceSetupStatusRequest(msg);
      // COMPAT(desktopEditorBridge): added in v0.1.88, remove after 2026-12-03 once old clients no longer call daemon editor RPCs.
      case "list_available_editors_request":
        return this.handleLegacyListAvailableEditorsRequest(msg);
      case "open_in_editor_request":
        return this.handleLegacyOpenInEditorRequest(msg);
      case "open_project_request":
        return this.handleOpenProjectRequest(msg);
      case "project.add.request":
        return this.handleProjectAddRequest(msg);
      case "archive_workspace_request":
        return this.handleArchiveWorkspaceRequest(msg);
      case "project.remove.request":
        return this.handleProjectRemoveRequest(msg);
      case "workspace.create.request":
        return this.handleWorkspaceCreateRequest(msg);
      case "workspace.clear_attention.request":
        return this.handleWorkspaceClearAttentionRequest(msg);
      case "workspace.title.set.request":
        return this.handleWorkspaceTitleSetRequest(msg.workspaceId, msg.title, msg.requestId);
      case "file_explorer_request":
        return this.workspaceFilesSession.handleFileExplorerRequest(msg);
      case "project_icon_request":
        return this.workspaceFilesSession.handleProjectIconRequest(msg);
      case "file_download_token_request":
        return this.workspaceFilesSession.handleFileDownloadTokenRequest(msg);
      case "file.upload.request":
        this.workspaceFilesSession.handleFileUploadRequest(msg);
        return undefined;
      default:
        return undefined;
    }
  }

  private dispatchProviderMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "list_provider_models_request":
        return this.providerCatalogSession.handleListProviderModelsRequest(msg);
      case "list_provider_modes_request":
        return this.providerCatalogSession.handleListProviderModesRequest(msg);
      case "list_provider_features_request":
        return this.providerCatalogSession.handleListProviderFeaturesRequest(msg);
      case "list_available_providers_request":
        return this.providerCatalogSession.handleListAvailableProvidersRequest(msg);
      case "get_providers_snapshot_request":
        return this.providerCatalogSession.handleGetProvidersSnapshotRequest(msg);
      case "refresh_providers_snapshot_request":
        return this.providerCatalogSession.handleRefreshProvidersSnapshotRequest(msg);
      case "provider_diagnostic_request":
        return this.providerCatalogSession.handleProviderDiagnosticRequest(msg);
      case "provider.usage.list.request":
        return this.providerCatalogSession.handleProviderUsageListRequest(msg);
      default:
        return undefined;
    }
  }

  private dispatchTerminalMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    if (msg.type === "start_workspace_script_request") {
      return this.handleStartWorkspaceScriptRequest(msg);
    }
    return this.terminalController.dispatch(msg);
  }

  // eslint-disable-next-line complexity
  private dispatchChatScheduleLoopMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "chat/create":
        return this.chatScheduleLoopSession.handleChatCreateRequest(msg);
      case "chat/list":
        return this.chatScheduleLoopSession.handleChatListRequest(msg);
      case "chat/inspect":
        return this.chatScheduleLoopSession.handleChatInspectRequest(msg);
      case "chat/delete":
        return this.chatScheduleLoopSession.handleChatDeleteRequest(msg);
      case "chat/post":
        return this.chatScheduleLoopSession.handleChatPostRequest(msg);
      case "chat/read":
        return this.chatScheduleLoopSession.handleChatReadRequest(msg);
      case "chat/wait":
        return this.chatScheduleLoopSession.handleChatWaitRequest(msg);
      case "loop/run":
        return this.chatScheduleLoopSession.handleLoopRunRequest(msg);
      case "loop/list":
        return this.chatScheduleLoopSession.handleLoopListRequest(msg);
      case "loop/inspect":
        return this.chatScheduleLoopSession.handleLoopInspectRequest(msg);
      case "loop/logs":
        return this.chatScheduleLoopSession.handleLoopLogsRequest(msg);
      case "loop/stop":
        return this.chatScheduleLoopSession.handleLoopStopRequest(msg);
      case "schedule/create":
        return this.chatScheduleLoopSession.handleScheduleCreateRequest(msg);
      case "schedule/list":
        return this.chatScheduleLoopSession.handleScheduleListRequest(msg);
      case "schedule/inspect":
        return this.chatScheduleLoopSession.handleScheduleInspectRequest(msg);
      case "schedule/logs":
        return this.chatScheduleLoopSession.handleScheduleLogsRequest(msg);
      case "schedule/pause":
        return this.chatScheduleLoopSession.handleSchedulePauseRequest(msg);
      case "schedule/resume":
        return this.chatScheduleLoopSession.handleScheduleResumeRequest(msg);
      case "schedule/delete":
        return this.chatScheduleLoopSession.handleScheduleDeleteRequest(msg);
      case "schedule/run-once":
        return this.chatScheduleLoopSession.handleScheduleRunOnceRequest(msg);
      case "schedule/update":
        return this.chatScheduleLoopSession.handleScheduleUpdateRequest(msg);
      default:
        return undefined;
    }
  }

  private async dispatchMiscMessage(msg: SessionInboundMessage): Promise<void> {
    switch (msg.type) {
      case "list_commands_request":
        await this.handleListCommandsRequest(msg);
        return;
      case "register_push_token":
        this.handleRegisterPushToken(msg.token);
        return;
    }
  }

  public resetPeakInflight(): void {
    this.peakInflightRequests = this.inflightRequests;
  }

  public async handleBinaryFrame(binaryFrame: BinaryFrame): Promise<void> {
    if (binaryFrame.kind === "file_transfer") {
      await this.workspaceFilesSession.handleFileTransferFrame(binaryFrame.frame);
      return;
    }
    this.terminalController.handleBinaryFrame(binaryFrame.frame);
  }

  private async handleRestartServerRequest(requestId: string, reason?: string): Promise<void> {
    const payload: { status: string } & Record<string, unknown> = {
      status: "restart_requested",
      clientId: this.clientId,
    };
    if (reason && reason.trim().length > 0) {
      payload.reason = reason;
    }
    payload.requestId = requestId;

    this.sessionLogger.warn({ reason }, "Restart requested via websocket");
    this.emit({
      type: "status",
      payload,
    });

    this.emitLifecycleIntent({
      type: "restart",
      clientId: this.clientId,
      requestId,
      ...(reason ? { reason } : {}),
    });
  }

  private async handleShutdownServerRequest(requestId: string): Promise<void> {
    this.sessionLogger.warn("Shutdown requested via websocket");
    this.emit({
      type: "status",
      payload: {
        status: "shutdown_requested",
        clientId: this.clientId,
        requestId,
      },
    });

    this.emitLifecycleIntent({
      type: "shutdown",
      clientId: this.clientId,
      requestId,
    });
  }

  private emitLifecycleIntent(intent: SessionLifecycleIntent): void {
    if (!this.onLifecycleIntent) {
      return;
    }
    try {
      this.onLifecycleIntent(intent);
    } catch (error) {
      this.sessionLogger.error({ err: error, intent }, "Lifecycle intent handler failed");
    }
  }

  private async handleDeleteAgentRequest(agentId: string, requestId: string): Promise<void> {
    this.sessionLogger.info({ agentId }, `Deleting agent ${agentId} from registry`);

    const knownWorkspaceId =
      this.agentManager.getAgent(agentId)?.workspaceId ??
      (await this.agentStorage.get(agentId))?.workspaceId ??
      null;

    // File-backed storage still needs an early delete fence before closeAgent().
    beginAgentDeleteIfSupported(this.agentStorage, agentId);

    try {
      await closeAgentCommand({ agentManager: this.agentManager }, agentId);
    } catch (error) {
      this.sessionLogger.warn(
        { err: error, agentId },
        `Failed to close agent ${agentId} during delete`,
      );
    }

    // Drain queued persistence from the just-closed agent before removing its
    // durable snapshot, otherwise an in-flight background write can recreate it.
    await this.agentManager.flush();

    try {
      await this.agentStorage.remove(agentId);
      await this.agentManager.deleteCommittedTimeline(agentId);
    } catch (error) {
      this.sessionLogger.error({ err: error, agentId }, `Failed to fully delete agent ${agentId}`);
    }

    this.emit({
      type: "agent_deleted",
      payload: {
        agentId,
        requestId,
      },
    });

    if (this.agentUpdatesSubscription) {
      this.bufferOrEmitAgentUpdate(this.agentUpdatesSubscription, {
        kind: "remove",
        agentId,
      });
    }

    if (knownWorkspaceId) {
      await this.emitWorkspaceUpdateForWorkspaceId(knownWorkspaceId);
    }
  }

  private async handleArchiveAgentRequest(agentId: string, requestId: string): Promise<void> {
    this.sessionLogger.info({ agentId }, `Archiving agent ${agentId}`);

    const { archivedAt } = await this.archiveAgentForClose(agentId);

    this.emit({
      type: "agent_archived",
      payload: {
        agentId,
        archivedAt,
        requestId,
      },
    });
  }

  private async archiveAgentForClose(
    agentId: string,
  ): Promise<{ agentId: string; archivedAt: string }> {
    const { archivedAt, record: archivedRecord } = await archiveAgentCommand(
      {
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        logger: this.sessionLogger,
      },
      agentId,
    );

    if (this.agentUpdatesSubscription) {
      const payload = await this.emitStoredAgentUpdate(archivedRecord);
      if (payload.workspaceId) {
        await this.emitWorkspaceUpdateForWorkspaceId(payload.workspaceId);
      }
    }

    return { agentId, archivedAt };
  }

  private async handleDetachAgentRequest(agentId: string, requestId: string): Promise<void> {
    this.sessionLogger.info({ agentId, requestId }, "Detaching agent from parent");

    try {
      const result = await detachAgentCommand({ agentManager: this.agentManager }, agentId);
      const affectedWorkspaceIds = new Set<string>();

      if (!result.live) {
        const payload = await this.emitStoredAgentUpdate(result.record);
        if (payload.workspaceId) {
          affectedWorkspaceIds.add(payload.workspaceId);
        }
      } else if (result.record.workspaceId) {
        affectedWorkspaceIds.add(result.record.workspaceId);
      }

      if (result.previousParentAgentId) {
        const rootWorkspaceId = await this.resolveDelegationRootWorkspaceId(
          result.previousParentAgentId,
        );
        if (rootWorkspaceId) {
          affectedWorkspaceIds.add(rootWorkspaceId);
        }
      }

      await this.emitWorkspaceUpdatesForWorkspaceIds(affectedWorkspaceIds, {
        skipReconcile: true,
      });

      this.emit({
        type: "agent.detach.response",
        payload: {
          requestId,
          agentId,
          accepted: true,
          error: null,
        },
      });
    } catch (error) {
      const message = getErrorMessageOr(error, "Failed to detach agent");
      this.sessionLogger.error({ err: error, agentId, requestId }, "Failed to detach agent");
      this.emit({
        type: "agent.detach.response",
        payload: {
          requestId,
          agentId,
          accepted: false,
          error: message,
        },
      });
    }
  }

  private async handleCloseItemsRequest(msg: CloseItemsRequest): Promise<void> {
    const archiveResults = await Promise.allSettled(
      msg.agentIds.map((agentId) => this.archiveAgentForClose(agentId)),
    );
    const agents = [];
    for (let i = 0; i < archiveResults.length; i += 1) {
      const result = archiveResults[i];
      if (result.status === "fulfilled") {
        agents.push(result.value);
      } else {
        this.sessionLogger.warn(
          { err: result.reason, agentId: msg.agentIds[i], requestId: msg.requestId },
          "Failed to archive agent during close_items batch",
        );
      }
    }

    const terminals = [];
    for (const terminalId of msg.terminalIds) {
      try {
        terminals.push(this.terminalController.killTerminalForClose(terminalId));
      } catch (error) {
        this.sessionLogger.warn(
          { err: error, terminalId, requestId: msg.requestId },
          "Failed to kill terminal during close_items batch",
        );
        terminals.push({
          terminalId,
          success: false,
        });
      }
    }

    this.emit({
      type: "close_items_response",
      payload: {
        agents,
        terminals,
        requestId: msg.requestId,
      },
    });
  }

  private async unarchiveAgentByHandle(handle: AgentPersistenceHandle): Promise<void> {
    const records = await this.agentStorage.list();
    const matched = records.find(
      (record) =>
        record.persistence?.provider === handle.provider &&
        record.persistence?.sessionId === handle.sessionId,
    );
    if (!matched) {
      return;
    }
    await unarchiveAgentState(this.agentStorage, this.agentManager, matched.id);
  }

  private async handleUpdateAgentRequest(
    agentId: string,
    name: string | undefined,
    labels: Record<string, string> | undefined,
    requestId: string,
  ): Promise<void> {
    this.sessionLogger.info(
      {
        agentId,
        requestId,
        hasName: typeof name === "string",
        labelCount: labels ? Object.keys(labels).length : 0,
      },
      "session: update_agent_request",
    );

    try {
      const result = await updateAgentCommand(
        { agentManager: this.agentManager },
        { agentId, name, labels },
      );

      if (!result.accepted) {
        this.emit({
          type: "update_agent_response",
          payload: {
            requestId,
            agentId,
            accepted: false,
            error: result.error,
          },
        });
        return;
      }

      this.emit({
        type: "update_agent_response",
        payload: { requestId, agentId, accepted: true, error: null },
      });
    } catch (error) {
      this.sessionLogger.error(
        { err: error, agentId, requestId },
        "session: update_agent_request error",
      );
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to update agent: ${getErrorMessage(error)}`,
        },
      });
      this.emit({
        type: "update_agent_response",
        payload: {
          requestId,
          agentId,
          accepted: false,
          error: getErrorMessageOr(error, "Failed to update agent"),
        },
      });
    }
  }

  private async handleProjectRenameRequest(
    projectId: string,
    customName: string | null,
    requestId: string,
  ): Promise<void> {
    this.sessionLogger.info(
      { projectId, requestId, hasCustomName: typeof customName === "string" },
      "session: project.rename.request",
    );

    try {
      const existing = await this.projectRegistry.get(projectId);
      if (!existing) {
        this.emit({
          type: "project.rename.response",
          payload: {
            requestId,
            projectId,
            accepted: false,
            customName: null,
            error: "Project not found",
          },
        });
        return;
      }

      const trimmed = customName?.trim() ?? "";
      const nextCustomName = trimmed.length === 0 ? null : trimmed;

      await this.projectRegistry.upsert({
        ...existing,
        customName: nextCustomName,
        updatedAt: new Date().toISOString(),
      });

      this.emit({
        type: "project.rename.response",
        payload: {
          requestId,
          projectId,
          accepted: true,
          customName: nextCustomName,
          error: null,
        },
      });

      // Re-emit descriptors for every workspace under this project so the new
      // resolved name lands in the UI immediately.
      const workspaces = await this.workspaceRegistry.list();
      const affectedWorkspaceIds = workspaces
        .filter((workspace) => workspace.projectId === projectId)
        .map((workspace) => workspace.workspaceId);
      if (affectedWorkspaceIds.length > 0) {
        await this.emitWorkspaceUpdatesForWorkspaceIds(affectedWorkspaceIds, {
          skipReconcile: true,
        });
      }
    } catch (error) {
      this.sessionLogger.error(
        { err: error, projectId, requestId },
        "session: project.rename.request error",
      );
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to rename project: ${getErrorMessage(error)}`,
        },
      });
      this.emit({
        type: "project.rename.response",
        payload: {
          requestId,
          projectId,
          accepted: false,
          customName: null,
          error: getErrorMessageOr(error, "Failed to rename project"),
        },
      });
    }
  }

  private async handleProjectRemoveRequest(
    request: Extract<SessionInboundMessage, { type: "project.remove.request" }>,
  ): Promise<void> {
    const { projectId, requestId } = request;
    this.sessionLogger.info({ projectId, requestId }, "session: project.remove.request");

    try {
      const projectWorkspaces = (await this.workspaceRegistry.list()).filter(
        (workspace) => workspace.projectId === projectId,
      );
      const activeWorkspaceIds = projectWorkspaces
        .filter((workspace) => !workspace.archivedAt)
        .map((workspace) => workspace.workspaceId);

      if (activeWorkspaceIds.length > 0) {
        this.markWorkspaceArchiving(activeWorkspaceIds, new Date().toISOString());
        await this.emitWorkspaceUpdatesForWorkspaceIds(activeWorkspaceIds, {
          skipReconcile: true,
        });
      }

      const removedWorkspaceIds: string[] = [];
      try {
        for (const workspaceId of activeWorkspaceIds) {
          await archiveWorkspaceContents(
            {
              agentManager: this.agentManager,
              agentStorage: this.agentStorage,
              killTerminalsForWorkspace: (id) =>
                this.terminalController.killTerminalsForWorkspace(id),
              sessionLogger: this.sessionLogger,
            },
            workspaceId,
          );
          await this.archiveWorkspaceRecord(workspaceId);
          removedWorkspaceIds.push(workspaceId);
        }

        await this.projectRegistry.remove(projectId);
      } finally {
        if (activeWorkspaceIds.length > 0) {
          this.clearWorkspaceArchiving(activeWorkspaceIds);
        }
      }

      const updateIds =
        removedWorkspaceIds.length > 0
          ? removedWorkspaceIds
          : [projectWorkspaces[0]?.workspaceId ?? projectId];
      await this.emitWorkspaceUpdatesForWorkspaceIds(updateIds, {
        skipReconcile: true,
        removedProjectId: projectId,
      });

      this.emit({
        type: "project.remove.response",
        payload: {
          requestId,
          projectId,
          accepted: true,
          removedWorkspaceIds,
          error: null,
        },
      });
    } catch (error) {
      this.sessionLogger.error(
        { err: error, projectId, requestId },
        "session: project.remove.request error",
      );
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to remove project: ${getErrorMessage(error)}`,
        },
      });
      this.emit({
        type: "project.remove.response",
        payload: {
          requestId,
          projectId,
          accepted: false,
          removedWorkspaceIds: [],
          error: getErrorMessageOr(error, "Failed to remove project"),
        },
      });
    }
  }

  private async handleWorkspaceTitleSetRequest(
    workspaceId: string,
    title: string | null,
    requestId: string,
  ): Promise<void> {
    this.sessionLogger.info(
      { workspaceId, requestId, hasTitle: typeof title === "string" },
      "session: workspace.title.set.request",
    );

    try {
      const existing = await this.workspaceRegistry.get(workspaceId);
      if (!existing) {
        this.emit({
          type: "workspace.title.set.response",
          payload: {
            requestId,
            workspaceId,
            accepted: false,
            title: null,
            error: "Workspace not found",
          },
        });
        return;
      }

      const trimmed = title?.trim() ?? "";
      const nextTitle = trimmed.length === 0 ? null : trimmed;

      await this.workspaceRegistry.upsert({
        ...existing,
        title: nextTitle,
        updatedAt: new Date().toISOString(),
      });

      this.emit({
        type: "workspace.title.set.response",
        payload: {
          requestId,
          workspaceId,
          accepted: true,
          title: nextTitle,
          error: null,
        },
      });

      await this.emitWorkspaceUpdatesForWorkspaceIds([workspaceId], {
        skipReconcile: true,
      });
    } catch (error) {
      this.sessionLogger.error(
        { err: error, workspaceId, requestId },
        "session: workspace.title.set.request error",
      );
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to set workspace title: ${getErrorMessage(error)}`,
        },
      });
      this.emit({
        type: "workspace.title.set.response",
        payload: {
          requestId,
          workspaceId,
          accepted: false,
          title: null,
          error: getErrorMessageOr(error, "Failed to set workspace title"),
        },
      });
    }
  }

  /**
   * Handle text message to agent (with optional image attachments)
   */
  private async handleSendAgentMessage(
    agentId: string,
    text: string,
    messageId?: string,
    images?: Array<{ data: string; mimeType: string }>,
    attachments?: AgentAttachment[],
    runOptions?: AgentRunOptions,
    options?: { spokenInput?: boolean },
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    this.sessionLogger.info(
      {
        agentId,
        textPreview: text.substring(0, 50),
        imageCount: images?.length ?? 0,
        attachmentCount: attachments?.length ?? 0,
      },
      `Sending text to agent ${agentId}${
        images && images.length > 0 ? ` with ${images.length} image attachment(s)` : ""
      }${
        attachments && attachments.length > 0
          ? ` and ${attachments.length} structured attachment(s)`
          : ""
      }`,
    );

    const promptText = options?.spokenInput ? wrapSpokenInput(text) : text;
    const prompt = this.buildAgentPrompt(promptText, images, attachments);

    try {
      await sendPromptToAgent({
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        agentId,
        prompt,
        messageId,
        runOptions,
        logger: this.sessionLogger,
      });
      return { ok: true };
    } catch (error) {
      this.handleAgentRunError(agentId, error, "Failed to send agent message");
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Handle create agent request
   */
  private async handleCreateAgentRequest(
    msg: Extract<SessionInboundMessage, { type: "create_agent_request" }>,
  ): Promise<void> {
    const {
      config,
      worktreeName,
      requestId,
      initialPrompt,
      clientMessageId,
      outputSchema,
      git,
      worktree,
      autoArchive,
      images,
      attachments,
      labels,
      env,
    } = msg;
    this.sessionLogger.info(
      { cwd: config.cwd, provider: config.provider, worktreeName },
      `Creating agent in ${config.cwd} (${config.provider})${
        worktreeName ? ` with worktree ${worktreeName}` : ""
      }`,
    );

    let createdWorktreeForCleanup: CreatePaseoWorktreeWorkflowResult | null = null;
    let createdAgentId: string | null = null;
    try {
      const trimmedPrompt = initialPrompt?.trim();
      const { provisionalTitle } = resolveCreateAgentTitles({
        configTitle: config.title,
        initialPrompt: trimmedPrompt,
      });

      const firstAgentContext: FirstAgentContext = {
        ...(trimmedPrompt ? { prompt: trimmedPrompt } : {}),
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      };
      const workspacePromptTitle = resolveFirstAgentPromptTitle(firstAgentContext);
      const createdWorktree = await this.createAgentLifecycleDispatch.createWorktreeForRequest({
        cwd: config.cwd,
        target: worktree,
        firstAgentContext,
        hasLegacyGitOptions: Boolean(git),
      });
      createdWorktreeForCleanup = createdWorktree;
      const createAgentConfig: AgentSessionConfig = createdWorktree
        ? { ...config, cwd: createdWorktree.worktree.worktreePath }
        : config;
      const workspaceId = await this.resolveOrCreateWorkspaceIdForCreateAgent({
        createdWorktree,
        requestedWorkspaceId: msg.workspaceId,
        cwd: createAgentConfig.cwd,
        initialTitle: workspacePromptTitle,
      });

      const { snapshot, liveSnapshot } = await createAgentCommand(
        {
          agentManager: this.agentManager,
          agentStorage: this.agentStorage,
          logger: this.sessionLogger,
          paseoHome: this.paseoHome,
          worktreesRoot: this.worktreesRoot,
          providerSnapshotManager: this.providerSnapshotManager,
        },
        {
          kind: "session",
          config: createAgentConfig,
          workspaceId,
          worktreeName,
          initialPrompt,
          clientMessageId,
          outputSchema,
          images,
          attachments,
          git,
          labels,
          env,
          provisionalTitle,
          firstAgentContext,
          buildSessionConfig: (sessionConfig, gitOptions, legacyWorktreeName, ctx) =>
            this.buildAgentSessionConfig(sessionConfig, gitOptions, legacyWorktreeName, ctx),
        },
      );
      createdAgentId = snapshot.id;
      if (!createdWorktree && msg.workspaceId) {
        await this.writeInitialWorkspaceTitleIfUntitled(workspaceId, workspacePromptTitle);
      }
      await this.forwardAgentUpdate(snapshot);
      if (!createdWorktree && trimmedPrompt) {
        await this.scheduleAutoNameLocalWorkspaceTitleForFirstAgent({
          workspaceId,
          cwd: createAgentConfig.cwd,
          firstAgentContext,
        });
      }
      this.createAgentLifecycleDispatch.registerAutoArchiveIfRequested({
        autoArchive,
        agentId: snapshot.id,
        createdWorktree,
      });
      if (requestId) {
        const agentPayload = await this.buildAgentPayload(liveSnapshot);
        this.emit({
          type: "status",
          payload: {
            status: "agent_created",
            agentId: liveSnapshot.id,
            requestId,
            agent: agentPayload,
          },
        });
      }

      this.sessionLogger.info(
        { agentId: snapshot.id, provider: snapshot.provider },
        `Created agent ${snapshot.id} (${snapshot.provider})`,
      );
    } catch (error) {
      await this.createAgentLifecycleDispatch.cleanupCreatedWorktreeAfterFailedAgentCreate({
        createdWorktree: createdWorktreeForCleanup,
        createdAgentId,
      });
      const wireError = toWorktreeWireError(error);
      this.sessionLogger.error({ err: error }, "Failed to create agent");
      if (requestId) {
        this.emit({
          type: "status",
          payload: {
            status: "agent_create_failed",
            requestId,
            error: wireError.message,
            errorCode: wireError.code,
          },
        });
      }
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to create agent: ${wireError.message}`,
        },
      });
    }
  }

  private async handleResumeAgentRequest(
    msg: Extract<SessionInboundMessage, { type: "resume_agent_request" }>,
  ): Promise<void> {
    const { handle, overrides, requestId } = msg;
    if (!handle) {
      this.sessionLogger.warn("Resume request missing persistence handle");
      if (requestId) {
        this.emit({
          type: "rpc_error",
          payload: {
            requestId,
            requestType: msg.type,
            error: "Unable to resume agent: missing persistence handle",
            code: "agent_resume_failed",
          },
        });
      }
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: "Unable to resume agent: missing persistence handle",
        },
      });
      return;
    }
    this.sessionLogger.info(
      { sessionId: handle.sessionId, provider: handle.provider },
      `Resuming agent ${handle.sessionId} (${handle.provider})`,
    );
    try {
      await this.unarchiveAgentByHandle(handle);
      const snapshot = await this.agentManager.resumeAgentFromPersistence(handle, overrides);
      await unarchiveAgentState(this.agentStorage, this.agentManager, snapshot.id);
      await this.agentManager.hydrateTimelineFromProvider(snapshot.id);
      await this.forwardAgentUpdate(snapshot);
      const timelineSize = this.agentManager.getTimeline(snapshot.id).length;
      if (requestId) {
        const agentPayload = await this.buildAgentPayload(snapshot);
        this.emit({
          type: "status",
          payload: {
            status: "agent_resumed",
            agentId: snapshot.id,
            requestId,
            timelineSize,
            agent: agentPayload,
          },
        });
      }
    } catch (error) {
      const message = getErrorMessage(error);
      this.sessionLogger.error({ err: error }, "Failed to resume agent");
      if (requestId) {
        this.emit({
          type: "rpc_error",
          payload: {
            requestId,
            requestType: msg.type,
            error: message,
            code: "agent_resume_failed",
          },
        });
      }
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to resume agent: ${message}`,
        },
      });
    }
  }

  private async handleImportAgentRequest(
    msg: Extract<SessionInboundMessage, { type: "import_agent_request" }>,
  ): Promise<void> {
    const normalized = normalizeImportAgentRequest(msg);
    if ("error" in normalized) {
      this.emit({
        type: "status",
        payload: {
          status: "agent_create_failed",
          requestId: msg.requestId,
          error: normalized.error,
        },
      });
      return;
    }
    const { provider, providerHandleId, requestId } = normalized;
    this.sessionLogger.info(
      { providerHandleId, provider },
      `Importing agent ${providerHandleId} (${provider})`,
    );

    try {
      if (!normalized.cwd) {
        throw new Error("Import requires cwd from the selected provider session");
      }
      // An imported agent mints its own workspace; ownership is its workspaceId,
      // never an existing same-cwd workspace resolved by path.
      const workspace = await this.createWorkspaceForDirectory(normalized.cwd);
      const { snapshot, timelineSize } = await importProviderSession({
        request: normalized,
        workspaceId: workspace.workspaceId,
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        logger: this.sessionLogger,
      });
      await this.registerWorkspaceForImportedAgent(workspace);
      const agentPayload = await this.buildAgentPayload(snapshot);
      this.emit({
        type: "status",
        payload: {
          status: "agent_resumed",
          agentId: snapshot.id,
          requestId,
          timelineSize,
          agent: agentPayload,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.sessionLogger.error({ err: error }, "Failed to import agent");
      this.emit({
        type: "status",
        payload: {
          status: "agent_create_failed",
          requestId,
          error: message,
        },
      });
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to import agent: ${message}`,
        },
      });
    }
  }

  private async handleRefreshAgentRequest(
    msg: Extract<SessionInboundMessage, { type: "refresh_agent_request" }>,
  ): Promise<void> {
    const { agentId, requestId } = msg;
    this.sessionLogger.info({ agentId }, `Refreshing agent ${agentId} from persistence`);

    try {
      await unarchiveAgentState(this.agentStorage, this.agentManager, agentId);
      await this.unarchiveOwningWorkspaceForAgent(agentId);
      let snapshot: ManagedAgent;
      const existing = this.agentManager.getAgent(agentId);
      if (existing) {
        await this.interruptAgentIfRunning(agentId);
        snapshot = await this.agentManager.reloadAgentSession(agentId, undefined, {
          rehydrateFromDisk: true,
        });
      } else {
        const record = await this.agentStorage.get(agentId);
        if (!record) {
          throw new Error(`Agent not found: ${agentId}`);
        }
        const registeredProviderIds = this.providerSnapshotManager.listRegisteredProviderIds();
        if (!isStoredAgentProviderAvailable(record, registeredProviderIds)) {
          throw new Error(`Agent ${agentId} references unavailable provider '${record.provider}'`);
        }
        const handle = toAgentPersistenceHandle(registeredProviderIds, record.persistence);
        if (!handle) {
          throw new Error(`Agent ${agentId} cannot be refreshed because it lacks persistence`);
        }
        snapshot = await this.agentManager.resumeAgentFromPersistence(
          handle,
          buildConfigOverrides(record),
          agentId,
          extractTimestamps(record),
        );
      }
      await this.agentManager.hydrateTimelineFromProvider(agentId);
      await this.forwardAgentUpdate(snapshot);
      const timelineSize = this.agentManager.getTimeline(agentId).length;
      if (requestId) {
        this.emit({
          type: "status",
          payload: {
            status: "agent_refreshed",
            agentId,
            requestId,
            timelineSize,
          },
        });
      }
    } catch (error) {
      const message = getErrorMessage(error);
      this.sessionLogger.error({ err: error, agentId }, `Failed to refresh agent ${agentId}`);
      if (requestId) {
        this.emit({
          type: "rpc_error",
          payload: {
            requestId,
            requestType: msg.type,
            error: message,
            code: error instanceof WorktreeRequestError ? error.code : "agent_refresh_failed",
          },
        });
      }
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to refresh agent: ${message}`,
        },
      });
    }
  }

  private async handleCancelAgentRequest(agentId: string, requestId?: string): Promise<void> {
    this.sessionLogger.info({ agentId }, `Cancel request received for agent ${agentId}`);

    try {
      await cancelAgentRunCommand(
        { agentManager: this.agentManager, logger: this.sessionLogger },
        agentId,
      );
      if (requestId) {
        const agent = this.agentManager.getAgent(agentId);
        const payload = agent ? await this.buildAgentPayload(agent) : null;
        this.emit({
          type: "cancel_agent_response",
          payload: {
            requestId,
            agentId,
            agent: payload,
          },
        });
      }
    } catch (error) {
      this.handleAgentRunError(agentId, error, "Failed to cancel running agent on request");
    }
  }

  private async handleAgentRewindRequest(
    msg: Extract<SessionInboundMessage, { type: "agent.rewind.request" }>,
  ): Promise<void> {
    try {
      await this.agentManager.rewind(msg.agentId, msg.messageId, msg.mode);
      this.emit({
        type: "agent.rewind.response",
        payload: {
          requestId: msg.requestId,
          agentId: msg.agentId,
          ok: true,
          error: null,
        },
      });
    } catch (error) {
      this.emit({
        type: "agent.rewind.response",
        payload: {
          requestId: msg.requestId,
          agentId: msg.agentId,
          ok: false,
          error: error instanceof Error ? error.message : "Failed to rewind agent",
        },
      });
    }
  }

  private async buildAgentSessionConfig(
    config: AgentSessionConfig,
    gitOptions?: GitSetupOptions,
    legacyWorktreeName?: string,
    firstAgentContext?: FirstAgentContext,
  ): Promise<{
    sessionConfig: AgentSessionConfig;
    setupContinuation?: CreatePaseoWorktreeWorkflowResult["setupContinuation"];
    createdWorkspaceId?: string;
  }> {
    return buildWorktreeAgentSessionConfig(
      {
        paseoHome: this.paseoHome,
        worktreesRoot: this.worktreesRoot,
        sessionLogger: this.sessionLogger,
        workspaceGitService: this.workspaceGitService,
        createPaseoWorktree: (input, serviceOptions) =>
          this.createPaseoWorktreeWorkflow(input, {
            ...serviceOptions,
            setupContinuation: {
              kind: "agent",
              terminalManager: this.terminalManager,
              appendTimelineItem: ({ agentId, item }) =>
                appendTimelineItemIfAgentKnown({
                  agentManager: this.agentManager,
                  agentId,
                  item,
                }),
              emitLiveTimelineItem: ({ agentId, item }) =>
                emitLiveTimelineItemIfAgentKnown({
                  agentManager: this.agentManager,
                  agentId,
                  item,
                }),
              logger: this.sessionLogger,
            },
          }),
        checkoutExistingBranch: (cwd, branch) =>
          this.gitMutation.checkoutExistingBranch(cwd, branch),
        createBranchFromBase: (params) => this.gitMutation.createBranchFromBase(params),
        github: this.github,
      },
      config,
      gitOptions,
      legacyWorktreeName,
      firstAgentContext,
    );
  }

  private scheduleAutoNameWorkspaceBranchForFirstAgent(input: {
    workspace: PersistedWorkspaceRecord;
    firstAgentContext: FirstAgentContext;
  }): void {
    this.scheduleWorkspaceNaming(() => this.maybeAutoNameWorkspaceBranchForFirstAgent(input), {
      cwd: input.workspace.cwd,
      message: "Failed to auto-name worktree branch",
    });
  }

  private async maybeAutoNameWorkspaceBranchForFirstAgent(input: {
    workspace: PersistedWorkspaceRecord;
    firstAgentContext: FirstAgentContext;
  }): Promise<void> {
    // Capture the generated title from the generator callback so we can write
    // title := generated title after the branch rename completes.
    let generatedTitle: string | null = null;
    const result = await attemptFirstAgentBranchAutoName({
      cwd: input.workspace.cwd,
      firstAgentContext: input.firstAgentContext,
      generateBranchNameFromContext: ({ cwd, firstAgentContext }) => {
        return this.generateWorkspaceName({
          agentManager: this.agentManager,
          cwd,
          workspaceGitService: this.workspaceGitService,
          providerSnapshotManager: this.providerSnapshotManager,
          daemonConfig: this.readStructuredGenerationDaemonConfig(),
          currentSelection: this.getFocusedAgentSelectionForCwd(cwd),
          firstAgentContext,
          logger: this.sessionLogger,
        }).then((r) => {
          generatedTitle = r?.title ?? null;
          return r?.branch ?? null;
        });
      },
    });
    if (!result.renamed || !generatedTitle) {
      return;
    }

    // K4: re-read from the registry before writing so any concurrent upsert
    // that happened between workspace creation and this async path is not clobbered.
    // The first-agent rename renamed the git branch too, so persist the new branch
    // alongside the title — both are this path's own fields.
    await this.applyGeneratedWorkspaceTitle(input.workspace.workspaceId, {
      title: generatedTitle,
      branch: result.branchName,
      promptTitle: resolveFirstAgentPromptTitle(input.firstAgentContext),
    });
    await this.gitMutation.notifyGitMutation(input.workspace.cwd, "rename-branch");
    await this.emitWorkspaceUpdateForCwd(input.workspace.cwd);
  }

  // Generated names may replace the prompt title set at creation, but not a user
  // rename that landed while the async generator was running.
  private async applyGeneratedWorkspaceTitle(
    workspaceId: string,
    input: { title: string; branch?: string | null; promptTitle?: string | null },
  ): Promise<void> {
    const current = await this.workspaceRegistry.get(workspaceId);
    if (!current) {
      return;
    }
    let title = current.title;
    if (!title || (input.promptTitle && title === input.promptTitle)) {
      title = input.title;
    }
    await this.workspaceRegistry.upsert({
      ...current,
      title,
      ...(input.branch ? { branch: input.branch } : {}),
      updatedAt: new Date().toISOString(),
    });
  }

  private async writeInitialWorkspaceTitleIfUntitled(
    workspaceId: string,
    title: string | null,
  ): Promise<void> {
    if (!title) {
      return;
    }
    const current = await this.workspaceRegistry.get(workspaceId);
    if (!current || current.title) {
      return;
    }
    await this.workspaceRegistry.upsert({
      ...current,
      title,
      updatedAt: new Date().toISOString(),
    });
  }

  // Wraps the injected workspace-name generator for a directory workspace.
  private async generateWorkspaceTitleFromContext(input: {
    cwd: string;
    firstAgentContext: FirstAgentContext;
  }): Promise<GeneratedWorkspaceName | null> {
    return this.generateWorkspaceName({
      agentManager: this.agentManager,
      cwd: input.cwd,
      workspaceGitService: this.workspaceGitService,
      providerSnapshotManager: this.providerSnapshotManager,
      daemonConfig: this.readStructuredGenerationDaemonConfig(),
      currentSelection: this.getFocusedAgentSelectionForCwd(input.cwd),
      firstAgentContext: input.firstAgentContext,
      logger: this.sessionLogger,
    });
  }

  // Generates a human title for a directory workspace from the firstAgentContext
  // prompt. No branch rename — directory workspaces have no worktree git state.
  // TODO(K7): same-dir directory-workspace display disambiguation not yet implemented.
  private async maybeAutoNameDirectoryWorkspaceTitle(input: {
    workspaceId: string;
    cwd: string;
    firstAgentContext: FirstAgentContext;
  }): Promise<void> {
    const generated = await this.generateWorkspaceTitleFromContext({
      cwd: input.cwd,
      firstAgentContext: input.firstAgentContext,
    });
    const title = generated?.title ?? null;
    if (!title) {
      return;
    }
    // K4: applyGeneratedWorkspaceTitle re-reads from the registry before writing.
    // Directory workspaces have no branch — write only the title.
    await this.applyGeneratedWorkspaceTitle(input.workspaceId, {
      title,
      promptTitle: resolveFirstAgentPromptTitle(input.firstAgentContext),
    });
    await this.emitWorkspaceUpdateForWorkspaceId(input.workspaceId);
  }

  private async scheduleAutoNameLocalWorkspaceTitleForFirstAgent(input: {
    workspaceId: string;
    cwd: string;
    firstAgentContext: FirstAgentContext;
  }): Promise<void> {
    const workspaceId = input.workspaceId;
    this.scheduleWorkspaceNaming(
      () =>
        this.maybeAutoNameDirectoryWorkspaceTitle({
          workspaceId,
          cwd: input.cwd,
          firstAgentContext: input.firstAgentContext,
        }),
      { cwd: input.cwd, message: "Failed to auto-name local workspace title" },
    );
  }

  private isPathWithinRoot(rootPath: string, candidatePath: string): boolean {
    const resolvedRoot = resolve(rootPath);
    const resolvedCandidate = resolve(candidatePath);
    if (resolvedCandidate === resolvedRoot) {
      return true;
    }
    return resolvedCandidate.startsWith(resolvedRoot + sep);
  }

  /**
   * Handle clearing agent attention flag
   */
  private async handleClearAgentAttention(
    agentId: string | string[],
    requestId?: string,
  ): Promise<void> {
    const agentIds = Array.isArray(agentId) ? agentId : [agentId];

    try {
      await Promise.all(agentIds.map((id) => this.agentManager.clearAgentAttention(id)));
      if (requestId) {
        const agents = (
          await Promise.all(
            agentIds.map(async (id) => {
              const agent = this.agentManager.getAgent(id);
              return agent ? this.buildAgentPayload(agent) : null;
            }),
          )
        ).filter((payload): payload is NonNullable<typeof payload> => payload !== null);
        this.emit({
          type: "clear_agent_attention_response",
          payload: {
            requestId,
            agentId,
            agents,
          },
        });
      }
    } catch (error) {
      this.sessionLogger.error({ err: error, agentIds }, "Failed to clear agent attention");
      // Don't throw - this is not critical
    }
  }

  /**
   * Handle client heartbeat for activity tracking
   */
  private handleClientHeartbeat(msg: {
    deviceType: "web" | "mobile";
    focusedAgentId: string | null;
    focusedTerminalId?: string | null;
    lastActivityAt: string;
    appVisible: boolean;
    appVisibilityChangedAt?: string;
  }): void {
    const focusedTerminalId = msg.focusedTerminalId?.trim() || null;
    const appVisibilityChangedAt = msg.appVisibilityChangedAt
      ? new Date(msg.appVisibilityChangedAt)
      : new Date(msg.lastActivityAt);
    this.clientActivity = {
      deviceType: msg.deviceType,
      focusedAgentId: msg.focusedAgentId,
      focusedTerminalId,
      lastActivityAt: new Date(msg.lastActivityAt),
      appVisible: msg.appVisible,
      appVisibilityChangedAt,
    };
    if (msg.appVisible && focusedTerminalId) {
      void this.clearFocusedTerminalAttention(focusedTerminalId);
    }
  }

  private async clearFocusedTerminalAttention(terminalId: string): Promise<void> {
    const terminalManager = this.terminalManager;
    if (!terminalManager) {
      return;
    }
    try {
      await terminalManager.clearTerminalAttention(terminalId);
    } catch (error) {
      this.sessionLogger.warn({ err: error, terminalId }, "Failed to clear terminal attention");
    }
  }

  /**
   * Handle push token registration
   */
  private handleRegisterPushToken(token: string): void {
    this.pushTokenStore.addToken(token);
    this.sessionLogger.info("Registered push token");
  }

  /**
   * Handle list commands request for an agent
   */
  private async handleListCommandsRequest(
    msg: Extract<SessionInboundMessage, { type: "list_commands_request" }>,
  ): Promise<void> {
    const { agentId, requestId, draftConfig } = msg;
    this.sessionLogger.debug(
      { agentId, draftConfig },
      `Handling list commands request for agent ${agentId}`,
    );

    try {
      const agents = this.agentManager.listAgents();
      const agent = agents.find((a) => a.id === agentId);

      if (agent?.session?.listCommands) {
        const commands = await agent.session.listCommands();
        this.emit({
          type: "list_commands_response",
          payload: {
            agentId,
            commands,
            error: null,
            requestId,
          },
        });
        return;
      }

      if (!agent && draftConfig) {
        const sessionConfig: AgentSessionConfig = {
          provider: draftConfig.provider,
          cwd: expandTilde(draftConfig.cwd),
          ...(draftConfig.modeId ? { modeId: draftConfig.modeId } : {}),
          ...(draftConfig.model ? { model: draftConfig.model } : {}),
          ...(draftConfig.thinkingOptionId
            ? { thinkingOptionId: draftConfig.thinkingOptionId }
            : {}),
        };

        const commands = await this.agentManager.listDraftCommands(sessionConfig);
        this.emit({
          type: "list_commands_response",
          payload: {
            agentId,
            commands,
            error: null,
            requestId,
          },
        });
        return;
      }

      this.emit({
        type: "list_commands_response",
        payload: {
          agentId,
          commands: [],
          error: agent ? `Agent does not support listing commands` : `Agent not found: ${agentId}`,
          requestId,
        },
      });
    } catch (error) {
      this.sessionLogger.error({ err: error, agentId, draftConfig }, "Failed to list commands");
      this.emit({
        type: "list_commands_response",
        payload: {
          agentId,
          commands: [],
          error: getErrorMessage(error),
          requestId,
        },
      });
    }
  }

  /**
   * Handle agent permission response from user
   */
  private async handleAgentPermissionResponse(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<void> {
    try {
      await respondToAgentPermission({
        agentManager: this.agentManager,
        agentId,
        requestId,
        response,
        logger: this.sessionLogger,
      });
    } catch (error) {
      this.sessionLogger.error(
        { err: error, agentId, requestId },
        "Failed to respond to permission",
      );
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to respond to permission: ${getErrorMessage(error)}`,
        },
      });
      throw error;
    }
  }

  private async handleDirectorySuggestionsRequest(msg: DirectorySuggestionsRequest): Promise<void> {
    const { query, limit, requestId, cwd, includeFiles, includeDirectories, matchMode } = msg;

    try {
      const workspaceCwd = cwd?.trim();
      const entries = workspaceCwd
        ? await searchWorkspaceEntries({
            cwd: expandTilde(workspaceCwd),
            query,
            limit,
            includeFiles,
            includeDirectories,
            matchMode,
          })
        : (
            await searchHomeDirectories({
              homeDir: process.env.HOME ?? homedir(),
              query,
              limit,
            })
          ).map((path) => ({ path, kind: "directory" as const }));
      const directories = entries
        .filter((entry) => entry.kind === "directory")
        .map((entry) => entry.path);
      this.emit({
        type: "directory_suggestions_response",
        payload: {
          directories,
          entries,
          error: null,
          requestId,
        },
      });
    } catch (error) {
      this.emit({
        type: "directory_suggestions_response",
        payload: {
          directories: [],
          entries: [],
          error: error instanceof Error ? error.message : String(error),
          requestId,
        },
      });
    }
  }

  private closeWorkspaceGitWatchTarget(target: WorkspaceGitWatchTarget): void {
    if (target.debounceTimer) {
      clearTimeout(target.debounceTimer);
      target.debounceTimer = null;
    }
    for (const watcher of target.watchers) {
      try {
        watcher.close();
      } catch {
        // Ignore watcher close errors
      }
    }
    target.watchers.length = 0;
  }

  private async removeWorkspaceGitWatchTarget(cwd: string): Promise<void> {
    const normalizedCwd = resolve(cwd);
    const target = this.workspaceGitWatchTargets.get(normalizedCwd);
    if (target) {
      this.closeWorkspaceGitWatchTarget(target);
      this.workspaceGitWatchTargets.delete(normalizedCwd);
    }
  }

  private removeWorkspaceGitSubscription(cwd: string): void {
    const normalizedCwd = resolve(cwd);
    const target = this.workspaceGitWatchTargets.get(normalizedCwd);
    if (target) {
      const unsubscribeFetch = this.workspaceGitFetchSubscriptions.get(normalizedCwd);
      unsubscribeFetch?.();
      this.workspaceGitFetchSubscriptions.delete(normalizedCwd);
      this.closeWorkspaceGitWatchTarget(target);
      this.workspaceGitWatchTargets.delete(normalizedCwd);
    }
    this.workspaceGitSubscriptions.get(normalizedCwd)?.();
    this.workspaceGitSubscriptions.delete(normalizedCwd);
  }

  private workspaceGitDescriptorStateKey(workspace: WorkspaceDescriptorPayload | null): string {
    if (!workspace) {
      return WORKSPACE_GIT_WATCH_REMOVED_STATE_KEY;
    }
    return JSON.stringify([
      workspace.name,
      workspace.diffStat ? [workspace.diffStat.additions, workspace.diffStat.deletions] : null,
    ]);
  }

  private resolveWorkspaceGitWatchTarget(workspaceId: string): WorkspaceGitWatchTarget | null {
    for (const target of this.workspaceGitWatchTargets.values()) {
      if (target.workspaceId === workspaceId) {
        return target;
      }
    }
    return null;
  }

  private shouldSkipWorkspaceGitWatchUpdate(
    workspaceId: string,
    workspace: WorkspaceDescriptorPayload | null,
  ): boolean {
    const target = this.resolveWorkspaceGitWatchTarget(workspaceId);
    if (!target) {
      return false;
    }
    const nextStateKey = this.workspaceGitDescriptorStateKey(workspace);
    if (target.latestDescriptorStateKey === nextStateKey) {
      return true;
    }
    target.latestDescriptorStateKey = nextStateKey;
    return false;
  }

  private rememberWorkspaceGitDescriptorState(
    workspaceId: string,
    workspace: WorkspaceDescriptorPayload | null,
  ): void {
    const target = this.resolveWorkspaceGitWatchTarget(workspaceId);
    if (!target) {
      return;
    }
    target.latestDescriptorStateKey = this.workspaceGitDescriptorStateKey(workspace);
    target.lastBranchName = workspace?.name ?? null;
  }

  private handleWorkspaceGitBranchSnapshot(cwd: string, branchName: string | null): void {
    const target = this.workspaceGitWatchTargets.get(resolve(cwd));
    if (!target) {
      return;
    }

    const previousBranchName = target.lastBranchName;
    if (branchName === previousBranchName) {
      return;
    }

    target.lastBranchName = branchName;
    this.onBranchChanged?.(target.workspaceId, previousBranchName, branchName);
  }

  private syncWorkspaceGitObservers(workspaces: Iterable<WorkspaceDescriptorPayload>): void {
    for (const workspace of workspaces) {
      this.syncWorkspaceGitObserver(workspace.workspaceDirectory, {
        isGit: workspace.projectKind === "git",
        workspaceId: workspace.id,
      });
      this.rememberWorkspaceGitDescriptorState(workspace.workspaceDirectory, workspace);
    }
  }

  private syncWorkspaceGitObserver(
    cwd: string,
    options: { isGit: boolean; workspaceId: string },
  ): void {
    const normalizedCwd = resolve(cwd);
    if (!options.isGit) {
      this.removeWorkspaceGitSubscription(normalizedCwd);
      return;
    }

    if (this.workspaceGitSubscriptions.has(normalizedCwd)) {
      return;
    }

    const target: WorkspaceGitWatchTarget = {
      cwd: normalizedCwd,
      workspaceId: options.workspaceId,
      watchers: [],
      debounceTimer: null,
      refreshPromise: null,
      refreshQueued: false,
      latestDescriptorStateKey: null,
      lastBranchName: null,
    };
    this.workspaceGitWatchTargets.set(normalizedCwd, target);

    const subscription = this.workspaceGitService.registerWorkspace(
      { cwd: normalizedCwd },
      (snapshot) => {
        this.handleWorkspaceGitBranchSnapshot(normalizedCwd, snapshot.git.currentBranch ?? null);
        void this.emitWorkspaceUpdateForCwd(normalizedCwd).catch((error) => {
          this.sessionLogger.warn(
            { err: error, cwd: normalizedCwd },
            "Failed to emit workspace update after git branch snapshot",
          );
        });
        this.checkoutSession.emitStatusUpdate(normalizedCwd, snapshot);
      },
    );
    this.workspaceGitSubscriptions.set(normalizedCwd, subscription.unsubscribe);
  }

  private async handlePaseoWorktreeListRequest(
    msg: Extract<SessionInboundMessage, { type: "paseo_worktree_list_request" }>,
  ): Promise<void> {
    return handleWorktreeListRequest(
      {
        emit: (message) => this.emit(message),
        paseoHome: this.paseoHome,
        workspaceGitService: this.workspaceGitService,
      },
      msg,
    );
  }

  private async handlePaseoWorktreeArchiveRequest(
    msg: Extract<SessionInboundMessage, { type: "paseo_worktree_archive_request" }>,
  ): Promise<void> {
    return handleWorktreeArchiveRequest(
      {
        paseoHome: this.paseoHome,
        paseoWorktreesBaseRoot: this.worktreesRoot,
        github: this.github,
        workspaceGitService: this.workspaceGitService,
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        findWorkspaceIdForCwd: (cwd) => this.findWorkspaceIdForCwd(cwd),
        listActiveWorkspaces: () => this.listActiveWorkspaceRefs(),
        archiveWorkspaceRecord: (workspaceId) => this.archiveWorkspaceRecord(workspaceId),
        emit: (message) => this.emit(message),
        emitWorkspaceUpdatesForWorkspaceIds: (workspaceIds) =>
          this.emitWorkspaceUpdatesForWorkspaceIds(workspaceIds),
        markWorkspaceArchiving: (workspaceIds, archivingAt) =>
          this.markWorkspaceArchiving(workspaceIds, archivingAt),
        clearWorkspaceArchiving: (workspaceIds) => this.clearWorkspaceArchiving(workspaceIds),
        killTerminalsForWorkspace: (workspaceId) =>
          this.terminalController.killTerminalsForWorkspace(workspaceId),
        sessionLogger: this.sessionLogger,
      },
      msg,
    );
  }

  private async listTerminalActivityContributions(): Promise<
    Array<{ cwd: string; workspaceId?: string; activity: TerminalActivity | null }>
  > {
    const terminalManager = this.terminalManager;
    if (!terminalManager) {
      return [];
    }
    const directories = terminalManager.listDirectories();
    const terminalsByDirectory = await Promise.all(
      directories.map((cwd) => terminalManager.getTerminals(cwd)),
    );
    return terminalsByDirectory.flat().map((session) => {
      const contribution: { cwd: string; workspaceId?: string; activity: TerminalActivity | null } =
        {
          cwd: session.cwd,
          activity: session.getActivity(),
        };
      if (session.workspaceId) {
        contribution.workspaceId = session.workspaceId;
      }
      return contribution;
    });
  }

  /**
   * Build the current agent list payload (live + persisted), optionally filtered by labels.
   */
  private async listAgentPayloads(filter?: {
    labels?: Record<string, string>;
    includeArchived?: boolean;
    includeUnavailablePersisted?: boolean;
  }): Promise<AgentSnapshotPayload[]> {
    const includeArchived = filter?.includeArchived === true;
    const labelEntries = filter?.labels ? Object.entries(filter.labels) : [];

    // Get live agents with session modes
    const agentSnapshots = this.agentManager.listAgents();
    const liveAgents = await Promise.all(
      agentSnapshots.map((agent) => this.buildAgentPayload(agent)),
    );

    // Add persisted agents that have not been lazily initialized yet
    // (excluding internal agents which are for ephemeral system tasks)
    const registryRecords = await this.agentStorage.list();
    const liveIds = new Set(agentSnapshots.map((a) => a.id));
    const registeredProviderIds = new Set(this.providerSnapshotManager.listRegisteredProviderIds());
    const persistedAgents = registryRecords
      .filter((record) => !liveIds.has(record.id) && !record.internal)
      // Keep raw-record filters ahead of projection; seeded homes can carry thousands of archived agents.
      .filter((record) => includeArchived || !record.archivedAt)
      .filter((record) => labelEntries.every(([key, value]) => record.labels?.[key] === value))
      .filter(
        (record) =>
          filter?.includeUnavailablePersisted === true ||
          isStoredAgentProviderAvailable(record, registeredProviderIds),
      )
      .map((record) => this.buildStoredAgentPayload(record, registeredProviderIds));

    let agents = [...liveAgents, ...persistedAgents];

    agents = agents.filter((agent) => this.isProviderVisibleToClient(agent.provider));
    if (!includeArchived) {
      agents = agents.filter((agent) => !agent.archivedAt);
    }

    // Filter by labels if filter provided
    if (labelEntries.length > 0) {
      agents = agents.filter((agent) =>
        labelEntries.every(([key, value]) => agent.labels[key] === value),
      );
    }

    return agents;
  }

  private async resolveAgentIdentifier(
    identifier: string,
  ): Promise<{ ok: true; agentId: string } | { ok: false; error: string }> {
    const trimmed = identifier.trim();
    if (!trimmed) {
      return { ok: false, error: "Agent identifier cannot be empty" };
    }

    const stored = await this.agentStorage.list();
    const storedRecords = stored.filter((record) => !record.internal);
    const knownIds = new Set<string>();
    for (const record of storedRecords) {
      knownIds.add(record.id);
    }
    for (const agent of this.agentManager.listAgents()) {
      knownIds.add(agent.id);
    }

    if (knownIds.has(trimmed)) {
      return { ok: true, agentId: trimmed };
    }

    const prefixMatches = Array.from(knownIds).filter((id) => id.startsWith(trimmed));
    if (prefixMatches.length === 1) {
      return { ok: true, agentId: prefixMatches[0] };
    }
    if (prefixMatches.length > 1) {
      return {
        ok: false,
        error: `Agent identifier "${trimmed}" is ambiguous (${prefixMatches
          .slice(0, 5)
          .map((id) => id.slice(0, 8))
          .join(", ")}${prefixMatches.length > 5 ? ", …" : ""})`,
      };
    }

    const titleMatches = storedRecords.filter((record) => record.title === trimmed);
    if (titleMatches.length === 1) {
      return { ok: true, agentId: titleMatches[0].id };
    }
    if (titleMatches.length > 1) {
      return {
        ok: false,
        error: `Agent title "${trimmed}" is ambiguous (${titleMatches
          .slice(0, 5)
          .map((r) => r.id.slice(0, 8))
          .join(", ")}${titleMatches.length > 5 ? ", …" : ""})`,
      };
    }

    return { ok: false, error: `Agent not found: ${trimmed}` };
  }

  private async getAgentPayloadById(agentId: string): Promise<AgentSnapshotPayload | null> {
    const live = this.agentManager.getAgent(agentId);
    if (live) {
      const payload = await this.buildAgentPayload(live);
      return this.isProviderVisibleToClient(payload.provider) ? payload : null;
    }

    const record = await this.agentStorage.get(agentId);
    if (!record || record.internal) {
      return null;
    }
    const payload = this.buildStoredAgentPayload(record);
    return this.isProviderVisibleToClient(payload.provider) ? payload : null;
  }

  private async resolveDelegationRootWorkspaceId(agentId: string): Promise<string | null> {
    const seen = new Set<string>();
    let currentAgentId = agentId;

    while (true) {
      if (seen.has(currentAgentId)) {
        return null;
      }
      seen.add(currentAgentId);

      const live = this.agentManager.getAgent(currentAgentId);
      const source = live ?? (await this.agentStorage.get(currentAgentId));
      if (!source) {
        return null;
      }
      if ("archivedAt" in source && source.archivedAt) {
        return null;
      }

      const parentAgentId = getParentAgentIdFromLabels(source.labels);
      if (!parentAgentId) {
        return source.workspaceId ?? null;
      }
      currentAgentId = parentAgentId;
    }
  }

  private async buildActiveProjectPlacementsByWorkspaceId(): Promise<
    Map<string, ProjectPlacementPayload>
  > {
    const [persistedWorkspaces, persistedProjects] = await Promise.all([
      this.workspaceRegistry.list(),
      this.projectRegistry.list(),
    ]);
    const activeProjects = new Map(
      persistedProjects
        .filter((project) => !project.archivedAt)
        .map((project) => [project.projectId, project] as const),
    );
    const placementsByWorkspaceId = new Map<string, ProjectPlacementPayload>();

    const pairs = persistedWorkspaces.flatMap((workspace) => {
      if (workspace.archivedAt) return [];
      const project = activeProjects.get(workspace.projectId);
      if (!project) return [];
      return [{ workspace, project }];
    });
    const placements = await Promise.all(
      pairs.map(({ workspace, project }) =>
        this.buildProjectPlacementForWorkspace(workspace, project),
      ),
    );
    for (let i = 0; i < pairs.length; i += 1) {
      placementsByWorkspaceId.set(pairs[i].workspace.workspaceId, placements[i]);
    }

    return placementsByWorkspaceId;
  }

  private async collectFetchAgentsEntries(params: {
    candidates: AgentSnapshotPayload[];
    limit: number;
    getPlacement: (workspaceId: string | undefined) => Promise<ProjectPlacementPayload | null>;
    filter: AgentUpdatesFilter | undefined;
  }): Promise<FetchAgentsResponseEntry[]> {
    const { candidates, limit, getPlacement, filter } = params;
    const matchedEntries: FetchAgentsResponseEntry[] = [];
    const batchSize = 25;
    for (
      let start = 0;
      start < candidates.length && matchedEntries.length <= limit;
      start += batchSize
    ) {
      const batch = candidates.slice(start, start + batchSize);
      const batchEntries = await Promise.all(
        batch.map(async (agent) => {
          const project = await getPlacement(agent.workspaceId);
          return project ? { agent, project } : null;
        }),
      );
      for (const entry of batchEntries) {
        if (!entry) {
          continue;
        }
        if (
          !this.matchesAgentFilter({
            agent: entry.agent,
            project: entry.project,
            filter,
          })
        ) {
          continue;
        }
        matchedEntries.push(entry);
        if (matchedEntries.length > limit) {
          break;
        }
      }
    }
    return matchedEntries;
  }

  private async listFetchAgentsEntries(request: AgentDirectoryRequestMessage): Promise<{
    entries: FetchAgentsResponseEntry[];
    pageInfo: FetchAgentsResponsePageInfo;
  }> {
    const filter =
      request.type === "fetch_agent_history_request" &&
      request.filter?.includeArchived === undefined
        ? { ...request.filter, includeArchived: true }
        : request.filter;
    const scope = request.type === "fetch_agents_request" ? request.scope : undefined;
    const sort = this.agentsPager.normalizeSort(request.sort);

    let agents = await this.listAgentPayloads({
      labels: filter?.labels,
      includeArchived: filter?.includeArchived,
      includeUnavailablePersisted: request.type === "fetch_agent_history_request",
    });
    const activePlacementsByWorkspaceId =
      scope === "active" ? await this.buildActiveProjectPlacementsByWorkspaceId() : null;
    if (activePlacementsByWorkspaceId) {
      agents = agents.filter(
        (agent) =>
          !agent.archivedAt &&
          agent.workspaceId != null &&
          activePlacementsByWorkspaceId.has(agent.workspaceId),
      );
    }

    const placementByWorkspaceId = new Map<string, Promise<ProjectPlacementPayload | null>>();
    const getPlacement = (
      workspaceId: string | undefined,
    ): Promise<ProjectPlacementPayload | null> => {
      if (!workspaceId) {
        return Promise.resolve(null);
      }
      if (activePlacementsByWorkspaceId) {
        return Promise.resolve(activePlacementsByWorkspaceId.get(workspaceId) ?? null);
      }
      const existing = placementByWorkspaceId.get(workspaceId);
      if (existing) {
        return existing;
      }
      const placementPromise =
        request.type === "fetch_agent_history_request"
          ? this.buildProjectPlacementForExistingWorkspaceProject(workspaceId)
          : this.buildProjectPlacementForWorkspaceId(workspaceId);
      placementByWorkspaceId.set(workspaceId, placementPromise);
      return placementPromise;
    };

    let candidates = [...agents];
    candidates.sort((left, right) => this.agentsPager.compare(left, right, sort));
    const cursorToken = request.page?.cursor;
    if (cursorToken) {
      const cursor = this.decodeAgentCursor(cursorToken, sort);
      candidates = candidates.filter(
        (agent) => this.agentsPager.compareWithCursor(agent, cursor, sort) > 0,
      );
    }

    const limit = request.page?.limit ?? 200;

    const matchedEntries = await this.collectFetchAgentsEntries({
      candidates,
      limit,
      getPlacement,
      filter,
    });

    const pagedEntries = matchedEntries.slice(0, limit);
    const hasMore = matchedEntries.length > limit;
    const nextCursor =
      hasMore && pagedEntries.length > 0
        ? this.agentsPager.encode(pagedEntries[pagedEntries.length - 1].agent, sort)
        : null;

    return {
      entries: pagedEntries,
      pageInfo: {
        nextCursor,
        prevCursor: request.page?.cursor ?? null,
        hasMore,
      },
    };
  }

  private readonly agentsPager = new SortablePager<
    AgentSnapshotPayload,
    FetchAgentsRequestSort["key"]
  >({
    validKeys: FETCH_AGENTS_SORT_KEYS,
    defaultSort: [{ key: "updated_at", direction: "desc" }],
    label: "fetch_agents",
    getId: (agent) => agent.id,
    getSortValue: (agent, key): number | string => {
      switch (key) {
        case "status_priority":
          return getAgentStatusPriority({
            status: agent.status,
            pendingPermissionCount: agent.pendingPermissions?.length ?? 0,
            requiresAttention: agent.requiresAttention,
            attentionReason: agent.attentionReason ?? null,
          });
        case "created_at":
          return Date.parse(agent.createdAt);
        case "updated_at":
          return Date.parse(agent.updatedAt);
        case "title":
          return agent.title?.toLocaleLowerCase() ?? "";
      }
    },
  });

  private decodeAgentCursor(token: string, sort: SortSpec<FetchAgentsRequestSort["key"]>[]) {
    try {
      return this.agentsPager.decode(token, sort);
    } catch (error) {
      if (error instanceof CursorError) {
        throw new SessionRequestError("invalid_cursor", error.message);
      }
      throw error;
    }
  }

  private async describeWorkspaceRecord(
    workspace: PersistedWorkspaceRecord,
    projectRecord?: PersistedProjectRecord | null,
  ): Promise<WorkspaceDescriptorPayload> {
    const resolvedProjectRecord =
      projectRecord ?? (await this.projectRegistry.get(workspace.projectId));

    let diffStat: { additions: number; deletions: number } | null = null;
    const snapshot = this.workspaceGitService.peekSnapshot(workspace.cwd);
    if (snapshot?.git.diffStat) {
      diffStat = snapshot.git.diffStat;
    }

    return {
      id: workspace.workspaceId,
      projectId: workspace.projectId,
      projectDisplayName: resolvedProjectRecord
        ? resolveProjectDisplayName(resolvedProjectRecord)
        : workspace.projectId,
      projectCustomName: resolvedProjectRecord?.customName ?? null,
      projectRootPath: resolvedProjectRecord?.rootPath ?? workspace.cwd,
      workspaceDirectory: workspace.cwd,
      projectKind: (resolvedProjectRecord?.kind ?? "directory") === "git" ? "git" : "non_git",
      workspaceKind: workspace.kind,
      name: resolveWorkspaceDisplayName(workspace),
      title: workspace.title,
      archivingAt: null,
      status: "done",
      statusEnteredAt: null,
      activityAt: null,
      diffStat,
      scripts:
        this.serviceProxy && this.scriptRuntimeStore
          ? buildWorkspaceScriptPayloads({
              workspaceId: workspace.workspaceId,
              workspaceDirectory: workspace.cwd,
              paseoConfig: readPaseoConfigForProjection(workspace.cwd, this.sessionLogger),
              serviceProxy: this.serviceProxy,
              runtimeStore: this.scriptRuntimeStore,
              daemonPort: this.getDaemonTcpPort?.() ?? null,
              serviceProxyPublicBaseUrl: this.serviceProxyPublicBaseUrl,
              gitMetadata: this.resolveWorkspaceScriptGitMetadata(workspace.cwd),
              resolveHealth: this.resolveScriptHealth ?? undefined,
            })
          : [],
      ...(resolvedProjectRecord
        ? {
            project: await this.buildProjectPlacementForWorkspace(workspace, resolvedProjectRecord),
          }
        : {}),
    };
  }

  private buildWorkspaceGitRuntimePayload(
    snapshot: WorkspaceGitRuntimeSnapshot,
  ): NonNullable<WorkspaceDescriptorPayload["gitRuntime"]> | null {
    if (!snapshot.git.isGit) {
      return null;
    }

    return {
      currentBranch: snapshot.git.currentBranch,
      remoteUrl: snapshot.git.remoteUrl,
      isPaseoOwnedWorktree: snapshot.git.isPaseoOwnedWorktree,
      isDirty: snapshot.git.isDirty,
      aheadBehind: snapshot.git.aheadBehind,
      aheadOfOrigin: snapshot.git.aheadOfOrigin,
      behindOfOrigin: snapshot.git.behindOfOrigin,
    };
  }

  private buildWorkspaceGitHubRuntimePayload(
    snapshot: WorkspaceGitRuntimeSnapshot,
  ): NonNullable<WorkspaceDescriptorPayload["githubRuntime"]> {
    return {
      featuresEnabled: snapshot.github.featuresEnabled,
      pullRequest: snapshot.github.pullRequest,
      error: snapshot.github.error,
    };
  }

  private async describeWorkspaceRecordWithGitData(
    workspace: PersistedWorkspaceRecord,
    projectRecord?: PersistedProjectRecord | null,
  ): Promise<WorkspaceDescriptorPayload> {
    const base = await this.describeWorkspaceRecord(workspace, projectRecord);
    const snapshot = this.workspaceGitService.peekSnapshot(workspace.cwd);
    if (!snapshot) {
      return base;
    }

    const checkout = checkoutLiteFromGitSnapshot(workspace.cwd, snapshot.git);
    const displayName = deriveWorkspaceDisplayName({ cwd: workspace.cwd, checkout });

    return {
      ...base,
      name: resolveWorkspaceName({ title: workspace.title, derivedDisplayName: displayName }),
      diffStat: snapshot.git.diffStat ?? null,
      gitRuntime: this.buildWorkspaceGitRuntimePayload(snapshot) ?? undefined,
      githubRuntime: this.buildWorkspaceGitHubRuntimePayload(snapshot),
    };
  }

  private async describeCreatedWorktreeWorkspace(
    result: CreatePaseoWorktreeResult,
  ): Promise<WorkspaceDescriptorPayload> {
    const projectRecord = await this.projectRegistry.get(result.workspace.projectId);
    return {
      id: result.workspace.workspaceId,
      projectId: result.workspace.projectId,
      projectDisplayName: projectRecord
        ? resolveProjectDisplayName(projectRecord)
        : result.workspace.projectId,
      projectCustomName: projectRecord?.customName ?? null,
      projectRootPath: projectRecord?.rootPath ?? result.repoRoot,
      workspaceDirectory: result.workspace.cwd,
      projectKind: "git",
      workspaceKind: result.workspace.kind,
      name: resolveWorkspaceName({
        title: result.workspace.title,
        derivedDisplayName: result.worktree.branchName || result.workspace.displayName,
      }),
      title: result.workspace.title,
      archivingAt: null,
      status: "done",
      statusEnteredAt: result.workspace.createdAt,
      activityAt: null,
      diffStat: { additions: 0, deletions: 0 },
      scripts: [],
      gitRuntime: {
        currentBranch: result.worktree.branchName || null,
        remoteUrl: null,
        isPaseoOwnedWorktree: true,
        isDirty: false,
        aheadBehind: null,
        aheadOfOrigin: null,
        behindOfOrigin: null,
      },
      githubRuntime: null,
    };
  }

  private async buildWorkspaceDescriptor(input: {
    workspace: PersistedWorkspaceRecord;
    projectRecord?: PersistedProjectRecord | null;
    includeGitData: boolean;
  }): Promise<WorkspaceDescriptorPayload> {
    if (input.includeGitData && input.projectRecord?.kind === "git") {
      return this.describeWorkspaceRecordWithGitData(input.workspace, input.projectRecord);
    }
    return this.describeWorkspaceRecord(input.workspace, input.projectRecord);
  }

  markWorkspaceArchiving(workspaceIds: Iterable<string>, archivingAt: string): void {
    this.workspaceDirectory.markArchiving(workspaceIds, archivingAt);
  }

  clearWorkspaceArchiving(workspaceIds: Iterable<string>): void {
    this.workspaceDirectory.clearArchiving(workspaceIds);
  }

  private async buildWorkspaceDescriptorMap(options: {
    includeGitData: boolean;
    workspaceIds?: Iterable<string>;
  }): Promise<Map<string, WorkspaceDescriptorPayload>> {
    return this.workspaceDirectory.buildDescriptorMap(options);
  }

  // external path→workspace adapter, not ownership. Used by archive-by-path flows
  // where the request carries a worktree path (unique to one workspace) rather
  // than a workspaceId. This is a directory lookup for an archive target, not a
  // status/ownership attribution.
  private async findWorkspaceIdForCwd(cwd: string): Promise<string | null> {
    const workspaces = await this.workspaceRegistry.list();
    return resolveWorkspaceIdForPath(cwd, workspaces);
  }

  private matchesWorkspaceFilter(input: {
    workspace: WorkspaceDescriptorPayload;
    filter: FetchWorkspacesRequestFilter | undefined;
  }): boolean {
    return this.workspaceDirectory.matchesFilter(input);
  }

  private async listFetchWorkspacesEntries(
    request: Extract<SessionInboundMessage, { type: "fetch_workspaces_request" }>,
  ): Promise<{
    entries: FetchWorkspacesResponseEntry[];
    emptyProjects: WorkspaceProjectDescriptorPayload[];
    pageInfo: FetchWorkspacesResponsePageInfo;
  }> {
    try {
      return await this.workspaceDirectory.listFetchEntries(request);
    } catch (error) {
      if (error instanceof CursorError) {
        throw new SessionRequestError("invalid_cursor", error.message);
      }
      throw error;
    }
  }

  private bufferOrEmitWorkspaceUpdate(
    subscription: WorkspaceUpdatesSubscriptionState,
    payload: WorkspaceUpdatePayload,
  ): void {
    if (subscription.isBootstrapping) {
      const workspaceId = payload.kind === "upsert" ? payload.workspace.id : payload.id;
      subscription.pendingUpdatesByWorkspaceId.set(workspaceId, payload);
      return;
    }
    const workspaceId = payload.kind === "upsert" ? payload.workspace.id : payload.id;
    subscription.lastEmittedByWorkspaceId.set(workspaceId, payload);
    this.emit({
      type: "workspace_update",
      payload,
    });
  }

  private flushBootstrappedWorkspaceUpdates(options?: {
    snapshotByWorkspaceId?: Map<
      string,
      { status: string; statusEnteredAt: string | null; activityAtMs: number | null }
    >;
  }): void {
    const subscription = this.workspaceUpdatesSubscription;
    if (!subscription || !subscription.isBootstrapping) {
      return;
    }

    subscription.isBootstrapping = false;
    const pending = Array.from(subscription.pendingUpdatesByWorkspaceId.values());
    subscription.pendingUpdatesByWorkspaceId.clear();

    for (const payload of pending) {
      if (payload.kind === "upsert") {
        const snapshot = options?.snapshotByWorkspaceId?.get(payload.workspace.id);
        const updateActivityAtMs = payload.workspace.activityAt
          ? Date.parse(payload.workspace.activityAt)
          : null;
        const shouldEmit = shouldEmitPendingBootstrapUpdate({
          snapshot: snapshot
            ? {
                status: snapshot.status,
                statusEnteredAt: snapshot.statusEnteredAt,
                activityAtMs: snapshot.activityAtMs,
              }
            : null,
          update: {
            status: payload.workspace.status,
            statusEnteredAt: payload.workspace.statusEnteredAt ?? null,
            activityAtMs: Number.isNaN(updateActivityAtMs) ? null : updateActivityAtMs,
          },
        });
        if (!shouldEmit) {
          continue;
        }
      }
      this.emit({
        type: "workspace_update",
        payload,
      });
    }
  }

  private async findOrCreateWorkspaceForDirectory(cwd: string): Promise<PersistedWorkspaceRecord> {
    const inputCwd = resolve(cwd);
    const normalizedCwd = await this.resolveWorkspaceDirectory(cwd);
    const existingWorkspace = await this.findExactWorkspaceByDirectory(normalizedCwd, {
      refreshGit: false,
    });
    if (existingWorkspace) {
      if (existingWorkspace.archivedAt && inputCwd !== normalizedCwd) {
        const timestamp = new Date().toISOString();
        const checkout = checkoutLiteFromGitSnapshot(inputCwd, {
          isGit: false,
          currentBranch: null,
          remoteUrl: null,
          repoRoot: null,
          isPaseoOwnedWorktree: false,
          mainRepoRoot: null,
        });
        const membership = classifyDirectoryForProjectMembership({ cwd: inputCwd, checkout });
        const projectRecord = await this.resolveProjectRecordForPlacement({
          membership,
          timestamp,
        });
        await this.projectRegistry.upsert(projectRecord);
        const workspaceRecord = createPersistedWorkspaceRecord({
          workspaceId: generateWorkspaceId(),
          projectId: projectRecord.projectId,
          cwd: inputCwd,
          kind: membership.workspaceKind,
          displayName: membership.workspaceDisplayName,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        await this.workspaceRegistry.upsert(workspaceRecord);
        return workspaceRecord;
      }
      return this.reclassifyOrUnarchiveWorkspaceForDirectory({
        workspace: existingWorkspace,
        project: await this.projectRegistry.get(existingWorkspace.projectId),
        cwd: normalizedCwd,
      });
    }

    return this.createWorkspaceForDirectory(normalizedCwd);
  }

  private async resolveOrCreateWorkspaceIdForCreateAgent(input: {
    createdWorktree: CreatePaseoWorktreeWorkflowResult | null;
    requestedWorkspaceId?: string;
    cwd: string;
    initialTitle: string | null;
  }): Promise<string> {
    if (input.createdWorktree) {
      return input.createdWorktree.workspace.workspaceId;
    }

    if (input.requestedWorkspaceId) {
      return input.requestedWorkspaceId;
    }

    return (await this.createWorkspaceForDirectory(input.cwd, input.initialTitle)).workspaceId;
  }

  private async createWorkspaceForDirectory(
    cwd: string,
    title?: string | null,
  ): Promise<PersistedWorkspaceRecord> {
    const checkout = await this.workspaceGitService.getCheckout(cwd);
    const membership = classifyDirectoryForProjectMembership({ cwd, checkout });
    const timestamp = new Date().toISOString();

    const projectRecord = await this.resolveProjectRecordForPlacement({
      membership,
      timestamp,
    });
    await this.projectRegistry.upsert(projectRecord);

    const workspaceRecord = createPersistedWorkspaceRecord({
      workspaceId: generateWorkspaceId(),
      projectId: projectRecord.projectId,
      cwd,
      kind: membership.workspaceKind,
      displayName: membership.workspaceDisplayName,
      title: title ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await this.workspaceRegistry.upsert(workspaceRecord);
    return workspaceRecord;
  }

  private async findOrCreateProjectForDirectory(cwd: string): Promise<PersistedProjectRecord> {
    const normalizedCwd = resolve(cwd);
    const checkout = await this.workspaceGitService.getCheckout(normalizedCwd);
    const membership = classifyDirectoryForProjectMembership({ cwd: normalizedCwd, checkout });
    const projectRecord = await this.resolveProjectRecordForPlacement({
      membership,
      timestamp: new Date().toISOString(),
    });
    await this.projectRegistry.upsert(projectRecord);
    return projectRecord;
  }

  private buildProjectDescriptor(
    project: PersistedProjectRecord,
  ): WorkspaceProjectDescriptorPayload {
    return {
      projectId: project.projectId,
      projectDisplayName: resolveProjectDisplayName(project),
      projectCustomName: project.customName ?? null,
      projectRootPath: project.rootPath,
      projectKind: project.kind,
    };
  }

  private async reclassifyOrUnarchiveWorkspaceForDirectory(input: {
    workspace: PersistedWorkspaceRecord;
    project: PersistedProjectRecord | null;
    cwd: string;
  }): Promise<PersistedWorkspaceRecord> {
    const checkout = await this.workspaceGitService.getCheckout(input.cwd);
    const membership = classifyDirectoryForProjectMembership({ cwd: input.cwd, checkout });
    const timestamp = new Date().toISOString();
    const projectRecord = await this.resolveProjectRecordForPlacement({
      membership,
      timestamp,
    });
    const projectId = projectRecord.projectId;
    const kind = membership.workspaceKind;
    const displayName = membership.workspaceDisplayName;

    if (
      input.workspace.projectId === projectId &&
      input.workspace.kind === kind &&
      input.workspace.displayName === displayName
    ) {
      if (!input.project) {
        await this.projectRegistry.upsert(projectRecord);
      }
      return this.ensureWorkspaceRecordUnarchived(input.workspace);
    }

    await this.projectRegistry.upsert(projectRecord);

    const nextWorkspace = {
      ...input.workspace,
      workspaceId: input.workspace.workspaceId,
      projectId,
      cwd: input.cwd,
      kind,
      displayName,
      archivedAt: null,
      updatedAt: timestamp,
    };
    await this.workspaceRegistry.upsert(nextWorkspace);
    return nextWorkspace;
  }

  private async resolveProjectRecordForPlacement(input: {
    membership: ReturnType<typeof classifyDirectoryForProjectMembership>;
    timestamp: string;
  }): Promise<PersistedProjectRecord> {
    const rootPath = input.membership.projectRootPath;
    const kind = input.membership.projectKind;
    const projects = await this.projectRegistry.list();
    const existingProject =
      projects.find((project) => !project.archivedAt && project.rootPath === rootPath) ??
      projects.find((project) => project.rootPath === rootPath) ??
      null;

    if (!existingProject) {
      return createPersistedProjectRecord({
        projectId: input.membership.projectKey,
        rootPath,
        kind,
        displayName: input.membership.projectName,
        createdAt: input.timestamp,
        updatedAt: input.timestamp,
      });
    }

    return {
      ...existingProject,
      rootPath,
      kind,
      archivedAt: null,
      updatedAt: input.timestamp,
    };
  }

  private async unarchiveOwningWorkspaceForAgent(agentId: string): Promise<void> {
    const record = await this.agentStorage.get(agentId);
    if (!record?.workspaceId) {
      return;
    }
    const workspace = await this.workspaceRegistry.get(record.workspaceId);
    if (!workspace?.archivedAt) {
      return;
    }

    const directoryExists = await this.filesystem.isDirectory(record.cwd).catch(() => false);
    if (!directoryExists) {
      if (workspace.kind !== "worktree" || !workspace.branch) {
        return;
      }
      // Recreate the worktree directory from its kept branch BEFORE clearing
      // archivedAt — the reconciler re-archives workspaces whose directory is
      // missing, so the record must point at a real directory first.
      await this.recreateOwningWorktreeForRestore(workspace, workspace.branch);
    }

    await this.ensureWorkspaceRecordUnarchived(workspace);
    await this.emitWorkspaceUpdatesForWorkspaceIds([workspace.workspaceId]);
  }

  private async recreateOwningWorktreeForRestore(
    workspace: PersistedWorkspaceRecord,
    branch: string,
  ): Promise<void> {
    const project = await this.projectRegistry.get(workspace.projectId);
    if (!project) {
      throw new WorktreeRequestError({
        code: "unknown",
        message: `Project ${workspace.projectId} not found for workspace ${workspace.workspaceId}`,
      });
    }
    const projectRootExists = await this.filesystem
      .isDirectory(project.rootPath)
      .catch(() => false);
    if (!projectRootExists) {
      throw new WorktreeRequestError({
        code: "unknown",
        message: `Project root is missing for ${workspace.projectId}: ${project.rootPath}`,
      });
    }

    // Archiving through the default path (scope "workspace", worktreePath only)
    // resolves repoRoot=null, so deletePaseoWorktree's `git worktree remove`/
    // `prune` is skipped and the admin registration survives — pinning the
    // branch as "already checked out". Prune here frees any stale registration
    // whose working dir is missing (a no-op for live worktrees) so the recreate
    // below succeeds regardless of how the worktree was archived.
    try {
      await runGitCommand(["worktree", "prune"], { cwd: project.rootPath, timeout: 30_000 });
    } catch {
      // not critical; git will prune lazily
    }

    let result: WorktreeConfig;
    try {
      result = await createWorktree({
        cwd: project.rootPath,
        worktreeSlug: basename(workspace.cwd),
        source: { kind: "checkout-branch", branchName: branch },
        runSetup: false,
        paseoHome: this.paseoHome,
        worktreesRoot: this.worktreesRoot,
      });
    } catch (error) {
      throw toWorktreeRequestError(error);
    }

    if (normalize(result.worktreePath) !== normalize(workspace.cwd)) {
      throw new WorktreeRequestError({
        code: "unknown",
        message: `Recreated worktree diverged from ${workspace.cwd}: ${result.worktreePath}`,
      });
    }
  }

  private async ensureWorkspaceRecordUnarchived(
    workspace: PersistedWorkspaceRecord,
  ): Promise<PersistedWorkspaceRecord> {
    const project = await this.projectRegistry.get(workspace.projectId);
    if (!workspace.archivedAt && (!project || !project.archivedAt)) {
      return workspace;
    }

    const timestamp = new Date().toISOString();
    let unarchivedWorkspace = workspace;
    if (workspace.archivedAt) {
      unarchivedWorkspace = { ...workspace, archivedAt: null, updatedAt: timestamp };
      await this.workspaceRegistry.upsert(unarchivedWorkspace);
    }
    if (project?.archivedAt) {
      await this.projectRegistry.upsert({
        ...project,
        archivedAt: null,
        updatedAt: timestamp,
      });
    }
    return unarchivedWorkspace;
  }

  private async createPaseoWorktree(
    input: CreatePaseoWorktreeInput,
    options?: {
      resolveDefaultBranch?: (repoRoot: string) => Promise<string>;
    },
  ): Promise<CreatePaseoWorktreeResult> {
    const result = await createPaseoWorktree(input, {
      github: this.github,
      ...(options?.resolveDefaultBranch
        ? { resolveDefaultBranch: options.resolveDefaultBranch }
        : {}),
      projectRegistry: this.projectRegistry,
      workspaceRegistry: this.workspaceRegistry,
      workspaceGitService: this.workspaceGitService,
    });
    void Promise.all([
      this.gitMutation.notifyGitMutation(input.cwd, "create-worktree"),
      this.gitMutation.notifyGitMutation(result.worktree.worktreePath, "create-worktree"),
    ]).catch((error) => {
      this.sessionLogger.warn(
        { err: error, cwd: input.cwd, worktreePath: result.worktree.worktreePath },
        "Failed to warm git snapshots after creating worktree",
      );
    });
    return result;
  }

  private async listActiveWorkspaceRefs(): Promise<ActiveWorkspaceRef[]> {
    const workspaces = await this.workspaceRegistry.list();
    return workspaces
      .filter((workspace) => !workspace.archivedAt)
      .map((workspace) => ({
        workspaceId: workspace.workspaceId,
        cwd: workspace.cwd,
        kind: workspace.kind,
      }));
  }

  private async archiveWorkspaceRecord(workspaceId: string, archivedAt?: string): Promise<void> {
    const archiveTimestamp = archivedAt ?? new Date().toISOString();
    const existingWorkspace = await archivePersistedWorkspaceRecord({
      workspaceId,
      archivedAt: archiveTimestamp,
      workspaceRegistry: this.workspaceRegistry,
    });
    if (!existingWorkspace) {
      const watchTarget = this.resolveWorkspaceGitWatchTarget(workspaceId);
      if (watchTarget) {
        this.removeWorkspaceGitSubscription(watchTarget.cwd);
      }
      return;
    }

    if (!existingWorkspace.archivedAt) {
      const activeSiblings = (await this.workspaceRegistry.list()).filter(
        (workspace) => workspace.projectId === existingWorkspace.projectId && !workspace.archivedAt,
      );
      this.sessionLogger.info(
        {
          workspaceId,
          workspaceCwd: existingWorkspace.cwd,
          projectId: existingWorkspace.projectId,
          projectArchived: activeSiblings.length === 0,
          archivedAt: archiveTimestamp,
        },
        "Workspace archived",
      );
    }

    await this.teardownArchivedWorkspace({
      workspaceId: existingWorkspace.workspaceId,
      cwd: existingWorkspace.cwd,
    });
  }

  // Git watch and subscription state is keyed by directory; the script runtime
  // store is keyed by the opaque workspace id. Each cleanup uses its own key so an
  // opaque id is never resolved as a filesystem path.
  private async teardownArchivedWorkspace(input: {
    workspaceId: string;
    cwd: string;
  }): Promise<void> {
    await this.removeWorkspaceGitWatchTarget(input.cwd);
    this.scriptRuntimeStore?.removeForWorkspace(input.workspaceId);
    this.removeWorkspaceGitSubscription(input.cwd);
  }

  private async reconcileAndEmitWorkspaceUpdates(): Promise<void> {
    if (!this.workspaceUpdatesSubscription) {
      return;
    }
    try {
      const changedWorkspaceIds = await this.reconcileActiveWorkspaceRecords();
      if (changedWorkspaceIds.size === 0) {
        return;
      }
      await this.emitWorkspaceUpdatesForWorkspaceIds(changedWorkspaceIds, {
        skipReconcile: true,
      });
    } catch (error) {
      this.sessionLogger.error({ err: error }, "Background workspace reconciliation failed");
    }
  }

  private async reconcileActiveWorkspaceRecords(): Promise<Set<string>> {
    const service = new WorkspaceReconciliationService({
      projectRegistry: this.projectRegistry,
      workspaceRegistry: this.workspaceRegistry,
      logger: this.sessionLogger,
      workspaceGitService: this.workspaceGitService,
    });
    const result = await service.runOnce();
    const changedWorkspaceIds = new Set<string>();
    const changedProjectIds = new Set<string>();

    await Promise.all(
      result.changesApplied.map(async (change) => {
        switch (change.kind) {
          case "workspace_archived":
            await this.teardownArchivedWorkspace({
              workspaceId: change.workspaceId,
              cwd: change.directory,
            });
            changedWorkspaceIds.add(change.workspaceId);
            break;
          case "workspace_updated":
            changedWorkspaceIds.add(change.workspaceId);
            break;
          case "project_archived":
          case "project_updated":
            changedProjectIds.add(change.projectId);
            break;
        }
      }),
    );

    if (changedProjectIds.size > 0) {
      for (const workspace of await this.workspaceRegistry.list()) {
        if (changedProjectIds.has(workspace.projectId)) {
          changedWorkspaceIds.add(workspace.workspaceId);
        }
      }
    }

    return changedWorkspaceIds;
  }

  private async emitWorkspaceUpdatesForWorkspaceIds(
    workspaceIds: Iterable<string>,
    options?: { skipReconcile?: boolean; dedupeGitState?: boolean; removedProjectId?: string },
  ): Promise<void> {
    const subscription = this.workspaceUpdatesSubscription;
    if (!subscription) {
      return;
    }

    const uniqueWorkspaceIds = new Set(Array.from(workspaceIds));
    if (uniqueWorkspaceIds.size === 0) {
      return;
    }

    const descriptorsByWorkspaceId = await this.buildWorkspaceDescriptorMap({
      workspaceIds: uniqueWorkspaceIds,
      includeGitData: true,
    });

    for (const workspaceId of uniqueWorkspaceIds) {
      const workspace = descriptorsByWorkspaceId.get(workspaceId);
      const nextWorkspace =
        workspace && this.matchesWorkspaceFilter({ workspace, filter: subscription.filter })
          ? workspace
          : null;
      if (
        options?.dedupeGitState &&
        this.shouldSkipWorkspaceGitWatchUpdate(workspaceId, nextWorkspace)
      ) {
        continue;
      }
      this.recordWorkspaceGitDescriptorState(workspaceId, nextWorkspace);

      if (!nextWorkspace) {
        subscription.lastEmittedByWorkspaceId.delete(workspaceId);
        this.bufferOrEmitWorkspaceUpdate(
          subscription,
          await this.buildWorkspaceRemoveUpdatePayload(workspaceId, options?.removedProjectId),
        );
        continue;
      }

      const nextPayload: WorkspaceUpdatePayload = {
        kind: "upsert",
        workspace: nextWorkspace,
      };

      const lastEmitted = subscription.lastEmittedByWorkspaceId.get(workspaceId);
      if (
        lastEmitted &&
        lastEmitted.kind === "upsert" &&
        equal(lastEmitted.workspace, nextWorkspace)
      ) {
        continue;
      }

      this.bufferOrEmitWorkspaceUpdate(subscription, nextPayload);
    }

    if (!options?.skipReconcile) {
      void this.reconcileAndEmitWorkspaceUpdates();
    }
  }

  private recordWorkspaceGitDescriptorState(
    workspaceId: string,
    nextWorkspace: WorkspaceDescriptorPayload | null,
  ): void {
    const watchTarget = this.resolveWorkspaceGitWatchTarget(workspaceId);
    if (watchTarget && this.onBranchChanged) {
      const newBranchName = nextWorkspace?.name ?? null;
      if (newBranchName !== watchTarget.lastBranchName) {
        this.onBranchChanged(workspaceId, watchTarget.lastBranchName, newBranchName);
      }
    }
    this.rememberWorkspaceGitDescriptorState(workspaceId, nextWorkspace);
  }

  private async buildWorkspaceRemoveUpdatePayload(
    workspaceId: string,
    removedProjectId?: string,
  ): Promise<WorkspaceUpdatePayload> {
    if (removedProjectId) {
      return { kind: "remove", id: workspaceId, removedProjectId };
    }
    return {
      kind: "remove",
      id: workspaceId,
      ...(await this.resolveProjectWithoutActiveWorkspacesForArchivedWorkspace(workspaceId)),
    };
  }

  // When a workspace is archived its project may have no active workspaces left.
  // Resolve that project parent so the `remove` update can carry it, keeping the
  // sidebar in sync without a full re-hydration.
  private async resolveProjectWithoutActiveWorkspacesForArchivedWorkspace(
    workspaceId: string,
  ): Promise<{ emptyProject: WorkspaceProjectDescriptorPayload } | null> {
    const archivedWorkspace = await this.workspaceRegistry.get(workspaceId);
    if (!archivedWorkspace) {
      return null;
    }
    const projectWithoutActiveWorkspaces = (await this.workspaceDirectory.listEmptyProjects()).find(
      (project) => project.projectId === archivedWorkspace.projectId,
    );
    return projectWithoutActiveWorkspaces ? { emptyProject: projectWithoutActiveWorkspaces } : null;
  }

  private async emitWorkspaceUpdateForTerminalContribution(
    event: TerminalWorkspaceContributionChangedEvent,
  ): Promise<void> {
    // A terminal's activity contributes only to the workspace it carries. A
    // terminal with no workspaceId attributes to nothing — status is per-id.
    if (!event.workspaceId) {
      return;
    }
    await this.emitWorkspaceUpdatesForWorkspaceIds([event.workspaceId], {
      skipReconcile: true,
    });
  }

  // A git fact (branch, diff, dirty, PR) changed at `cwd`. Every workspace whose
  // OWN cwd is this folder re-derives its git facts from that folder (id → cwd)
  // and emits its own per-id descriptor. This is a deliberate same-folder fan,
  // not a cwd → id ownership lookup: git never resolves which workspace owns a
  // path. See `workspaceIdsOnCheckout`.
  private async emitWorkspaceUpdateForCwd(
    cwd: string,
    options?: {
      skipReconcile?: boolean;
      dedupeGitState?: boolean;
    },
  ): Promise<void> {
    const workspaceIds = workspaceIdsOnCheckout(await this.workspaceRegistry.list(), cwd);
    if (workspaceIds.length === 0) {
      return;
    }
    await this.emitWorkspaceUpdatesForWorkspaceIds(workspaceIds, options);
  }

  private async handleFetchAgents(
    request: Extract<SessionInboundMessage, { type: "fetch_agents_request" }>,
  ): Promise<void> {
    const requestedSubscriptionId = request.subscribe?.subscriptionId?.trim();
    const subscriptionId = resolveSubscriptionId(request.subscribe, requestedSubscriptionId);

    try {
      if (subscriptionId) {
        this.agentUpdatesSubscription = {
          subscriptionId,
          filter: request.filter,
          isBootstrapping: true,
          pendingUpdatesByAgentId: new Map(),
        };
      }

      const payload = await this.listFetchAgentsEntries(request);
      const snapshotUpdatedAtByAgentId = new Map<string, number>();
      for (const entry of payload.entries) {
        const parsedUpdatedAt = Date.parse(entry.agent.updatedAt);
        if (!Number.isNaN(parsedUpdatedAt)) {
          snapshotUpdatedAtByAgentId.set(entry.agent.id, parsedUpdatedAt);
        }
      }

      this.emit({
        type: "fetch_agents_response",
        payload: {
          requestId: request.requestId,
          ...(subscriptionId ? { subscriptionId } : {}),
          ...payload,
        },
      });

      if (subscriptionId && this.agentUpdatesSubscription?.subscriptionId === subscriptionId) {
        this.flushBootstrappedAgentUpdates({ snapshotUpdatedAtByAgentId });
      }
    } catch (error) {
      if (subscriptionId && this.agentUpdatesSubscription?.subscriptionId === subscriptionId) {
        this.agentUpdatesSubscription = null;
      }
      const code = error instanceof SessionRequestError ? error.code : "fetch_agents_failed";
      const message = error instanceof Error ? error.message : "Failed to fetch agents";
      this.sessionLogger.error({ err: error }, "Failed to handle fetch_agents_request");
      this.emit({
        type: "rpc_error",
        payload: {
          requestId: request.requestId,
          requestType: request.type,
          error: message,
          code,
        },
      });
    }
  }

  private async handleFetchAgentHistory(
    request: Extract<SessionInboundMessage, { type: "fetch_agent_history_request" }>,
  ): Promise<void> {
    try {
      const payload = await this.listFetchAgentsEntries(request);
      this.emit({
        type: "fetch_agent_history_response",
        payload: {
          requestId: request.requestId,
          ...payload,
        },
      });
    } catch (error) {
      const code = error instanceof SessionRequestError ? error.code : "fetch_agent_history_failed";
      const message = error instanceof Error ? error.message : "Failed to fetch agent history";
      this.sessionLogger.error({ err: error }, "Failed to handle fetch_agent_history_request");
      this.emit({
        type: "rpc_error",
        payload: {
          requestId: request.requestId,
          requestType: request.type,
          error: message,
          code,
        },
      });
    }
  }

  private async handleFetchRecentProviderSessions(
    request: Extract<SessionInboundMessage, { type: "fetch_recent_provider_sessions_request" }>,
  ): Promise<void> {
    try {
      const result = await listImportableProviderSessions({
        request,
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        providerSnapshotManager: this.providerSnapshotManager,
      });
      this.emit({
        type: "fetch_recent_provider_sessions_response",
        payload: {
          requestId: request.requestId,
          entries: result.entries,
          ...(result.filteredAlreadyImportedCount > 0
            ? { filteredAlreadyImportedCount: result.filteredAlreadyImportedCount }
            : {}),
        },
      });
    } catch (error) {
      const code =
        error instanceof ImportSessionsRequestError
          ? error.code
          : "fetch_recent_provider_sessions_failed";
      const message =
        error instanceof Error ? error.message : "Failed to fetch recent provider sessions";
      this.sessionLogger.error(
        { err: error },
        "Failed to handle fetch_recent_provider_sessions_request",
      );
      this.emit({
        type: "rpc_error",
        payload: {
          requestId: request.requestId,
          requestType: request.type,
          error: message,
          code,
        },
      });
    }
  }

  private async handleFetchWorkspacesRequest(
    request: Extract<SessionInboundMessage, { type: "fetch_workspaces_request" }>,
  ): Promise<void> {
    const requestedSubscriptionId = request.subscribe?.subscriptionId?.trim();
    const subscriptionId = resolveSubscriptionId(request.subscribe, requestedSubscriptionId);

    try {
      this.sessionLogger.debug(
        {
          requestId: request.requestId,
          subscribeRequested: Boolean(request.subscribe),
          filter: request.filter ?? null,
          sort: request.sort ?? null,
          page: request.page ?? null,
        },
        "fetch_workspaces_request_received",
      );
      if (subscriptionId) {
        this.workspaceUpdatesSubscription = {
          subscriptionId,
          filter: request.filter,
          isBootstrapping: true,
          pendingUpdatesByWorkspaceId: new Map(),
          lastEmittedByWorkspaceId: new Map(),
        };
      }

      const payload = await this.listFetchWorkspacesEntries(request);
      this.syncWorkspaceGitObservers(payload.entries);
      this.sessionLogger.debug(
        {
          requestId: request.requestId,
          subscriptionId,
          pageInfo: payload.pageInfo,
          payload: summarizeFetchWorkspacesEntries(payload.entries),
        },
        "fetch_workspaces_response_ready",
      );
      const snapshot = this.buildBootstrapSnapshot(payload.entries);

      this.emit({
        type: "fetch_workspaces_response",
        payload: {
          requestId: request.requestId,
          ...(subscriptionId ? { subscriptionId } : {}),
          ...payload,
        },
      });

      if (subscriptionId && this.workspaceUpdatesSubscription?.subscriptionId === subscriptionId) {
        this.flushBootstrappedWorkspaceUpdates(snapshot);
        void this.reconcileAndEmitWorkspaceUpdates();
      }
    } catch (error) {
      if (subscriptionId && this.workspaceUpdatesSubscription?.subscriptionId === subscriptionId) {
        this.workspaceUpdatesSubscription = null;
      }
      const code = error instanceof SessionRequestError ? error.code : "fetch_workspaces_failed";
      const message = error instanceof Error ? error.message : "Failed to fetch workspaces";
      this.sessionLogger.error({ err: error }, "Failed to handle fetch_workspaces_request");
      this.emit({
        type: "rpc_error",
        payload: {
          requestId: request.requestId,
          requestType: request.type,
          error: message,
          code,
        },
      });
    }
  }

  // Build the bootstrap snapshot used by `flushBootstrappedWorkspaceUpdates`
  // to decide which pending updates to drop. Captures the status,
  // statusEnteredAt, and activityAt (parsed to ms) for each workspace entry
  // so a status-only change (e.g. the unmask case), a statusEnteredAt-only
  // change (e.g. a fresh unmask time), AND a fresher activity all still
  // ship to the client.
  private buildBootstrapSnapshot(entries: FetchWorkspacesResponseEntry[]): {
    snapshotByWorkspaceId: Map<
      string,
      { status: string; statusEnteredAt: string | null; activityAtMs: number | null }
    >;
  } {
    const snapshotByWorkspaceId = new Map<
      string,
      { status: string; statusEnteredAt: string | null; activityAtMs: number | null }
    >();
    for (const entry of entries) {
      const parsedActivity = entry.activityAt ? Date.parse(entry.activityAt) : null;
      snapshotByWorkspaceId.set(entry.id, {
        status: entry.status,
        statusEnteredAt: entry.statusEnteredAt ?? null,
        activityAtMs: Number.isNaN(parsedActivity) ? null : parsedActivity,
      });
    }
    return { snapshotByWorkspaceId };
  }

  private async registerWorkspaceForImportedAgent(
    workspace: PersistedWorkspaceRecord,
  ): Promise<void> {
    try {
      await this.syncWorkspaceGitObserverForWorkspace(workspace);
      await this.describeWorkspaceRecord(workspace);
      await this.emitWorkspaceUpdateForWorkspaceId(workspace.workspaceId);
    } catch (error) {
      this.sessionLogger.warn(
        { err: error, workspaceId: workspace.workspaceId, cwd: workspace.cwd },
        "Failed to register workspace for imported agent",
      );
    }
  }

  private async handleWorkspaceCreateRequest(
    request: Extract<SessionInboundMessage, { type: "workspace.create.request" }>,
  ): Promise<void> {
    try {
      if (request.source.kind === "directory") {
        await this.handleWorkspaceCreateLocal(request);
        return;
      }
      await this.handleWorkspaceCreateWorktree(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create workspace";
      this.sessionLogger.error(
        { err: error, sourceKind: request.source.kind, requestId: request.requestId },
        "Failed to create workspace",
      );
      this.emit({
        type: "workspace.create.response",
        payload: {
          requestId: request.requestId,
          workspace: null,
          setupTerminalId: null,
          error: message,
        },
      });
    }
  }

  private async handleWorkspaceCreateLocal(
    request: Extract<SessionInboundMessage, { type: "workspace.create.request" }>,
  ): Promise<void> {
    if (request.source.kind !== "directory") {
      return;
    }

    const cwd = expandTilde(request.source.path);
    const directoryExists = await this.filesystem.isDirectory(cwd).catch(() => false);
    if (!directoryExists) {
      this.emit({
        type: "workspace.create.response",
        payload: {
          requestId: request.requestId,
          workspace: null,
          setupTerminalId: null,
          error: `Directory not found: ${cwd}`,
          errorCode: "directory_not_found",
        },
      });
      return;
    }

    const explicitTitle = request.title?.trim() || null;
    const promptTitle = resolveFirstAgentPromptTitle(request.firstAgentContext);
    const workspace = await createLocalCheckoutWorkspace(
      { cwd, title: explicitTitle ?? promptTitle },
      {
        projectRegistry: this.projectRegistry,
        workspaceRegistry: this.workspaceRegistry,
        workspaceGitService: this.workspaceGitService,
      },
    );
    await this.syncWorkspaceGitObserverForWorkspace(workspace);
    const descriptor = await this.describeWorkspaceRecord(workspace);
    this.emit({
      type: "workspace.create.response",
      payload: {
        requestId: request.requestId,
        workspace: descriptor,
        setupTerminalId: null,
        error: null,
      },
    });
    await this.emitWorkspaceUpdateForWorkspaceId(workspace.workspaceId);
    void this.workspaceGitService
      .getSnapshot(workspace.cwd, { force: true, includeGitHub: true, reason: "open_project" })
      .catch((error) => {
        this.sessionLogger.warn(
          { err: error, cwd: workspace.cwd },
          "Background snapshot refresh failed after workspace.create",
        );
      });
    if (request.firstAgentContext) {
      const firstAgentContext = request.firstAgentContext;
      this.scheduleWorkspaceNaming(
        () =>
          this.maybeAutoNameDirectoryWorkspaceTitle({
            workspaceId: workspace.workspaceId,
            cwd: workspace.cwd,
            firstAgentContext,
          }),
        { cwd: workspace.cwd, message: "Failed to auto-name directory workspace title" },
      );
    }
  }

  // Schedules a background workspace-naming write off the request path. The
  // setTimeout(0) keeps the LLM call off the hot path.
  private scheduleWorkspaceNaming(
    run: () => Promise<void>,
    context: { cwd: string; message: string },
  ): void {
    setTimeout(() => {
      void run().catch((error) => {
        this.sessionLogger.warn({ err: error, cwd: context.cwd }, context.message);
      });
    }, 0);
  }

  private async handleWorkspaceCreateWorktree(
    request: Extract<SessionInboundMessage, { type: "workspace.create.request" }>,
  ): Promise<void> {
    if (request.source.kind !== "worktree") {
      return;
    }

    const source = request.source;

    if (!source.cwd && !source.projectId) {
      this.emit({
        type: "workspace.create.response",
        payload: {
          requestId: request.requestId,
          workspace: null,
          setupTerminalId: null,
          error: "cwd or projectId is required for a worktree-backed workspace",
          errorCode: "source_required",
        },
      });
      return;
    }

    const sourceCwd = await this.resolveWorktreeSourceCwd({
      cwd: source.cwd,
      projectId: source.projectId,
    });

    const result = await this.createPaseoWorktreeWorkflow(
      {
        cwd: sourceCwd,
        projectId: source.projectId,
        worktreeSlug: source.worktreeSlug,
        action: source.action,
        refName: source.refName,
        githubPrNumber: source.githubPrNumber,
        firstAgentContext: request.firstAgentContext,
      },
      source.baseBranch
        ? { resolveDefaultBranch: async () => source.baseBranch as string }
        : undefined,
    );

    if (request.title?.trim()) {
      await this.workspaceRegistry.upsert({
        ...result.workspace,
        title: request.title.trim(),
        updatedAt: new Date().toISOString(),
      });
      result.workspace.title = request.title.trim();
    }

    const descriptor = await this.describeCreatedWorktreeWorkspace(result);
    this.emit({
      type: "workspace.create.response",
      payload: {
        requestId: request.requestId,
        workspace: descriptor,
        setupTerminalId: null,
        error: null,
      },
    });
    this.emit({
      type: "workspace_update",
      payload: { kind: "upsert", workspace: descriptor },
    });
  }

  private async resolveWorktreeSourceCwd(input: {
    cwd?: string;
    projectId?: string;
  }): Promise<string> {
    if (input.cwd) {
      return expandTilde(input.cwd);
    }
    const project = await this.projectRegistry.get(input.projectId as string);
    if (!project || project.archivedAt) {
      throw new Error(`Project not found: ${input.projectId}`);
    }
    return project.rootPath;
  }

  private async handleOpenProjectRequest(
    request: Extract<SessionInboundMessage, { type: "open_project_request" }>,
  ): Promise<void> {
    const requestedCwd = request.cwd;
    const cwd = expandTilde(requestedCwd);
    const directoryExists = await this.filesystem.isDirectory(cwd).catch(() => false);
    if (!directoryExists) {
      this.sessionLogger.info(
        { requestedCwd, resolvedCwd: cwd, reason: "directory_not_found" },
        "Open project rejected",
      );
      this.emit({
        type: "open_project_response",
        payload: {
          requestId: request.requestId,
          workspace: null,
          error: `Directory not found: ${cwd}`,
          errorCode: "directory_not_found",
        },
      });
      return;
    }

    try {
      const projectsBefore = new Map<string, PersistedProjectRecord>();
      for (const project of await this.projectRegistry.list()) {
        projectsBefore.set(project.projectId, project);
      }
      const workspacesBefore = new Map<string, PersistedWorkspaceRecord>();
      for (const workspaceRecord of await this.workspaceRegistry.list()) {
        workspacesBefore.set(workspaceRecord.workspaceId, workspaceRecord);
      }
      const workspace = await this.findOrCreateWorkspaceForDirectory(cwd);
      const project = await this.projectRegistry.get(workspace.projectId);
      await this.syncWorkspaceGitObserverForWorkspace(workspace);
      const descriptor = await this.describeWorkspaceRecord(workspace);
      await this.emitWorkspaceUpdateForWorkspaceId(workspace.workspaceId);
      this.sessionLogger.info(
        {
          requestedCwd,
          resolvedCwd: cwd,
          workspaceCwd: workspace.cwd,
          workspaceId: workspace.workspaceId,
          workspaceKind: workspace.kind,
          workspaceTransition: describeRegistryTransition(
            workspacesBefore.get(workspace.workspaceId) ?? null,
          ),
          projectId: workspace.projectId,
          projectKind: project?.kind ?? null,
          projectTransition: describeRegistryTransition(
            projectsBefore.get(workspace.projectId) ?? null,
          ),
        },
        "Project opened",
      );
      this.emit({
        type: "open_project_response",
        payload: {
          requestId: request.requestId,
          workspace: descriptor,
          error: null,
        },
      });
      void this.workspaceGitService
        .getSnapshot(workspace.cwd, {
          force: true,
          includeGitHub: true,
          reason: "open_project",
        })
        .catch((error) => {
          this.sessionLogger.warn(
            { err: error, cwd: workspace.cwd },
            "Background snapshot refresh failed after open_project",
          );
        });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to open project";
      this.sessionLogger.error({ err: error, cwd }, "Failed to open project");
      this.emit({
        type: "open_project_response",
        payload: {
          requestId: request.requestId,
          workspace: null,
          error: message,
        },
      });
    }
  }

  private async handleProjectAddRequest(
    request: Extract<SessionInboundMessage, { type: "project.add.request" }>,
  ): Promise<void> {
    const requestedCwd = request.cwd;
    const cwd = expandTilde(requestedCwd);
    const directoryExists = await this.filesystem.isDirectory(cwd).catch(() => false);
    if (!directoryExists) {
      this.sessionLogger.info(
        { requestedCwd, resolvedCwd: cwd, reason: "directory_not_found" },
        "Add project rejected",
      );
      this.emit({
        type: "project.add.response",
        payload: {
          requestId: request.requestId,
          project: null,
          error: `Directory not found: ${cwd}`,
          errorCode: "directory_not_found",
        },
      });
      return;
    }

    try {
      const projectsBefore = new Map<string, PersistedProjectRecord>();
      for (const project of await this.projectRegistry.list()) {
        projectsBefore.set(project.projectId, project);
      }
      const project = await this.findOrCreateProjectForDirectory(cwd);
      this.sessionLogger.info(
        {
          requestedCwd,
          resolvedCwd: cwd,
          projectId: project.projectId,
          projectKind: project.kind,
          projectTransition: describeRegistryTransition(
            projectsBefore.get(project.projectId) ?? null,
          ),
        },
        "Project added",
      );
      this.emit({
        type: "project.add.response",
        payload: {
          requestId: request.requestId,
          project: this.buildProjectDescriptor(project),
          error: null,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to add project";
      this.sessionLogger.error({ err: error, cwd }, "Failed to add project");
      this.emit({
        type: "project.add.response",
        payload: {
          requestId: request.requestId,
          project: null,
          error: message,
        },
      });
    }
  }

  private buildWorkspaceScriptPayloadSnapshot(
    workspaceId: string,
    workspaceDirectory: string,
  ): WorkspaceDescriptorPayload["scripts"] {
    if (!this.serviceProxy || !this.scriptRuntimeStore) {
      return [];
    }
    return buildWorkspaceScriptPayloads({
      workspaceId,
      workspaceDirectory,
      paseoConfig: readPaseoConfigForProjection(workspaceDirectory, this.sessionLogger),
      serviceProxy: this.serviceProxy,
      runtimeStore: this.scriptRuntimeStore,
      daemonPort: this.getDaemonTcpPort?.() ?? null,
      serviceProxyPublicBaseUrl: this.serviceProxyPublicBaseUrl,
      gitMetadata: this.resolveWorkspaceScriptGitMetadata(workspaceDirectory),
      resolveHealth: this.resolveScriptHealth ?? undefined,
    });
  }

  private resolveWorkspaceScriptGitMetadata(
    workspaceDirectory: string,
  ): { projectSlug: string; currentBranch: string | null } | undefined {
    const snapshot = this.workspaceGitService.peekSnapshot(workspaceDirectory);
    if (!snapshot) {
      return undefined;
    }
    return {
      projectSlug: deriveProjectSlug(
        workspaceDirectory,
        snapshot.git.isGit ? snapshot.git.remoteUrl : null,
      ),
      currentBranch: snapshot.git.currentBranch,
    };
  }

  private emitWorkspaceScriptStatusUpdate(workspaceId: string, workspaceDirectory: string): void {
    this.emit({
      type: "script_status_update",
      payload: {
        workspaceId,
        scripts: this.buildWorkspaceScriptPayloadSnapshot(workspaceId, workspaceDirectory),
      },
    });
  }

  private async handleStartWorkspaceScriptRequest(
    request: StartWorkspaceScriptRequest,
  ): Promise<void> {
    try {
      if (!this.terminalManager || !this.serviceProxy || !this.scriptRuntimeStore) {
        throw new Error("Workspace scripts are not available on this daemon");
      }

      const workspace = await this.workspaceRegistry.get(request.workspaceId);
      if (!workspace) {
        throw new Error(`Workspace not found: ${request.workspaceId}`);
      }
      const gitMetadata = await this.workspaceGitService.getWorkspaceGitMetadata(workspace.cwd);

      const serviceResult = await spawnWorkspaceScript({
        repoRoot: workspace.cwd,
        workspaceId: workspace.workspaceId,
        projectSlug: gitMetadata.projectSlug,
        branchName: gitMetadata.currentBranch,
        scriptName: request.scriptName,
        daemonPort: this.getDaemonTcpPort?.() ?? null,
        daemonListenHost: this.getDaemonTcpHost?.() ?? null,
        serviceProxyPublicBaseUrl: this.serviceProxyPublicBaseUrl,
        serviceProxy: this.serviceProxy,
        runtimeStore: this.scriptRuntimeStore,
        terminalManager: this.terminalManager,
        logger: this.sessionLogger,
        onLifecycleChanged: () => {
          this.emitWorkspaceScriptStatusUpdate(workspace.workspaceId, workspace.cwd);
        },
      });

      this.emitWorkspaceScriptStatusUpdate(workspace.workspaceId, workspace.cwd);
      this.emit({
        type: "start_workspace_script_response",
        payload: {
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          scriptName: request.scriptName,
          terminalId: serviceResult.terminalId,
          error: null,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start workspace script";
      this.sessionLogger.error(
        {
          err: error,
          workspaceId: request.workspaceId,
          scriptName: request.scriptName,
        },
        "Failed to start workspace script",
      );
      this.emit({
        type: "start_workspace_script_response",
        payload: {
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          scriptName: request.scriptName,
          terminalId: null,
          error: message,
        },
      });
    }
  }

  // COMPAT(desktopEditorBridge): added in v0.1.88, remove after 2026-12-03 once old clients no longer call daemon editor RPCs.
  private async handleLegacyListAvailableEditorsRequest(
    request: Extract<SessionInboundMessage, { type: "list_available_editors_request" }>,
  ): Promise<void> {
    this.emit({
      type: "list_available_editors_response",
      payload: {
        requestId: request.requestId,
        editors: [],
        error: "Editor opening moved to the desktop app and is no longer supported by the daemon",
      },
    });
  }

  private async handleLegacyOpenInEditorRequest(
    request: Extract<SessionInboundMessage, { type: "open_in_editor_request" }>,
  ): Promise<void> {
    this.emit({
      type: "open_in_editor_response",
      payload: {
        requestId: request.requestId,
        error: "Editor opening moved to the desktop app and is no longer supported by the daemon",
      },
    });
  }

  private async handleCreatePaseoWorktreeRequest(
    request: Extract<SessionInboundMessage, { type: "create_paseo_worktree_request" }>,
  ): Promise<void> {
    return handleCreateWorktreeRequest(
      {
        paseoHome: this.paseoHome,
        worktreesRoot: this.worktreesRoot,
        describeWorkspaceRecord: (result) => this.describeCreatedWorktreeWorkspace(result),
        emit: (message) => this.emit(message),
        sessionLogger: this.sessionLogger,
        createPaseoWorktreeWorkflow: (input) => this.createPaseoWorktreeWorkflow(input),
      },
      request,
    );
  }

  private async createPaseoWorktreeWorkflow(
    input: CreatePaseoWorktreeInput,
    options?: {
      resolveDefaultBranch?: (repoRoot: string) => Promise<string>;
      setupContinuation?: CreatePaseoWorktreeSetupContinuationInput;
    },
  ): Promise<CreatePaseoWorktreeWorkflowResult> {
    return createWorktreeWorkflow(
      {
        paseoHome: this.paseoHome,
        worktreesRoot: this.worktreesRoot,
        createPaseoWorktree: (workflowInput, serviceOptions) =>
          this.createPaseoWorktree(workflowInput, serviceOptions),
        warmWorkspaceGitData: (workspace) => this.warmWorkspaceGitDataForWorkspace(workspace),
        autoNameWorkspaceBranchForFirstAgent: (autoNameInput) =>
          this.scheduleAutoNameWorkspaceBranchForFirstAgent(autoNameInput),
        emitWorkspaceUpdateForWorkspaceId: (workspaceId) =>
          this.emitWorkspaceUpdateForWorkspaceId(workspaceId),
        cacheWorkspaceSetupSnapshot: (workspaceId, snapshot) => {
          this.workspaceSetupSnapshots.set(workspaceId, snapshot);
        },
        emit: (message) => this.emit(message),
        sessionLogger: this.sessionLogger,
        terminalManager: this.terminalManager,
        archiveWorkspaceRecord: (workspaceId) => this.archiveWorkspaceRecord(workspaceId),
        serviceProxy: this.serviceProxy,
        scriptRuntimeStore: this.scriptRuntimeStore,
        getDaemonTcpPort: this.getDaemonTcpPort,
        getDaemonTcpHost: this.getDaemonTcpHost,
        serviceProxyPublicBaseUrl: this.serviceProxyPublicBaseUrl,
        onScriptsChanged: (workspaceId, workspaceDirectory) => {
          this.emitWorkspaceScriptStatusUpdate(workspaceId, workspaceDirectory);
        },
      },
      input,
      options,
    );
  }

  private async handleWorkspaceSetupStatusRequest(
    request: Extract<SessionInboundMessage, { type: "workspace_setup_status_request" }>,
  ): Promise<void> {
    return handleWorkspaceSetupStatusRequestMessage(
      {
        emit: (message) => this.emit(message),
        workspaceSetupSnapshots: this.workspaceSetupSnapshots,
      },
      request,
    );
  }

  private async handleArchiveWorkspaceRequest(
    request: Extract<SessionInboundMessage, { type: "archive_workspace_request" }>,
  ): Promise<void> {
    try {
      const existing = await this.workspaceRegistry.get(request.workspaceId);
      if (!existing) {
        throw new Error(`Workspace not found: ${request.workspaceId}`);
      }

      const gitSnapshot = await this.workspaceGitService
        .getSnapshot(existing.cwd)
        .catch(() => null);
      const repoRoot = gitSnapshot?.git?.repoRoot ?? null;

      await archiveByScope(
        {
          paseoHome: this.paseoHome,
          paseoWorktreesBaseRoot: this.worktreesRoot,
          github: this.github,
          workspaceGitService: this.workspaceGitService,
          agentManager: this.agentManager,
          agentStorage: this.agentStorage,
          findWorkspaceIdForCwd: (cwd) => this.findWorkspaceIdForCwd(cwd),
          listActiveWorkspaces: () => this.listActiveWorkspaceRefs(),
          archiveWorkspaceRecord: (workspaceId) => this.archiveWorkspaceRecord(workspaceId),
          emitWorkspaceUpdatesForWorkspaceIds: (workspaceIds) =>
            this.emitWorkspaceUpdatesForWorkspaceIds(workspaceIds),
          markWorkspaceArchiving: (workspaceIds, archivingAt) =>
            this.markWorkspaceArchiving(workspaceIds, archivingAt),
          clearWorkspaceArchiving: (workspaceIds) => this.clearWorkspaceArchiving(workspaceIds),
          killTerminalsForWorkspace: (workspaceId) =>
            this.terminalController.killTerminalsForWorkspace(workspaceId),
          sessionLogger: this.sessionLogger,
        },
        {
          scope: { kind: "workspace", workspaceId: existing.workspaceId },
          repoRoot,
          paseoWorktreesBaseRoot: this.worktreesRoot,
          requestId: request.requestId,
        },
      );

      const archivedWorkspace = await this.workspaceRegistry.get(request.workspaceId);
      const archivedAt = archivedWorkspace?.archivedAt ?? new Date().toISOString();
      this.emit({
        type: "archive_workspace_response",
        payload: {
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          archivedAt,
          error: null,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to archive workspace";
      this.sessionLogger.error(
        { err: error, workspaceId: request.workspaceId },
        "Failed to archive workspace",
      );
      this.emit({
        type: "archive_workspace_response",
        payload: {
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          archivedAt: null,
          error: message,
        },
      });
    }
  }

  private async handleWorkspaceClearAttentionRequest(
    request: Extract<SessionInboundMessage, { type: "workspace.clear_attention.request" }>,
  ): Promise<void> {
    const { requestId, workspaceId } = request;
    const requestedWorkspaceIds = Array.isArray(workspaceId) ? workspaceId : [workspaceId];
    let agents: AgentSnapshotPayload[];
    try {
      agents = await this.listAgentPayloads();
    } catch (error) {
      const message = getErrorMessage(error);
      const results = requestedWorkspaceIds.map((requestedWorkspaceId) => ({
        workspaceId: requestedWorkspaceId,
        clearedAgentIds: [],
        success: false,
        error: message,
      }));
      this.emit({
        type: "workspace.clear_attention.response",
        payload: {
          requestId,
          workspaceId,
          clearedAgentIds: [],
          results,
          success: false,
          error: message,
        },
      });
      return;
    }
    const results: Array<{
      workspaceId: string;
      clearedAgentIds: string[];
      success: boolean;
      error: string | null;
    }> = [];

    for (const requestedWorkspaceId of requestedWorkspaceIds) {
      const clearedAgentIds: string[] = [];
      try {
        const workspace = await this.workspaceRegistry.get(requestedWorkspaceId);
        if (!workspace || workspace.archivedAt) {
          throw new Error(`Workspace not found: ${requestedWorkspaceId}`);
        }

        // Clearing attention is scoped to the workspace that OWNS the agent, by
        // workspaceId — never by comparing cwd strings. A sibling workspace
        // sharing the same directory keeps its own agents' attention.
        const clearableAgentIds = agents
          .filter((agent) => !agent.archivedAt)
          .filter((agent) => agent.workspaceId === workspace.workspaceId)
          .filter((agent) => agent.requiresAttention === true)
          .filter((agent) => (agent.pendingPermissions?.length ?? 0) === 0)
          .filter((agent) => agent.attentionReason !== "permission")
          .map((agent) => agent.id);

        for (const agentId of clearableAgentIds) {
          const liveAgent = this.agentManager.getAgent(agentId);
          if (liveAgent) {
            await this.agentManager.clearAgentAttention(agentId);
            clearedAgentIds.push(agentId);
            continue;
          }

          const record = await this.agentStorage.get(agentId);
          if (
            !record ||
            record.internal ||
            record.archivedAt ||
            record.requiresAttention !== true
          ) {
            continue;
          }
          const nextRecord: StoredAgentRecord = {
            ...record,
            updatedAt: new Date().toISOString(),
            requiresAttention: false,
            attentionReason: null,
            attentionTimestamp: null,
          };
          await this.agentStorage.upsert(nextRecord);
          const agent = this.buildStoredAgentPayload(nextRecord);
          const project = await this.buildProjectPlacementForWorkspace(workspace);
          this.emit({
            type: "agent_update",
            payload: {
              kind: "upsert",
              agent,
              project,
            },
          });
          clearedAgentIds.push(agentId);
        }

        await this.emitWorkspaceUpdateForWorkspaceId(workspace.workspaceId);
        results.push({
          workspaceId: requestedWorkspaceId,
          clearedAgentIds,
          success: true,
          error: null,
        });
      } catch (error) {
        const message = getErrorMessage(error);
        this.sessionLogger.error(
          { err: error, workspaceId: requestedWorkspaceId },
          "Failed to clear workspace attention",
        );
        results.push({
          workspaceId: requestedWorkspaceId,
          clearedAgentIds,
          success: false,
          error: message,
        });
      }
    }

    const clearedAgentIds = results.flatMap((result) => result.clearedAgentIds);
    const failedResults = results.filter((result) => !result.success);
    this.emit({
      type: "workspace.clear_attention.response",
      payload: {
        requestId,
        workspaceId,
        clearedAgentIds,
        results,
        success: failedResults.length === 0,
        error:
          failedResults.length === 0
            ? null
            : failedResults
                .map((result) => result.error)
                .filter((error) => error !== null)
                .join("; "),
      },
    });
  }

  private async handleFetchAgent(agentIdOrIdentifier: string, requestId: string): Promise<void> {
    const resolved = await this.resolveAgentIdentifier(agentIdOrIdentifier);
    if (!resolved.ok) {
      this.emit({
        type: "fetch_agent_response",
        payload: { requestId, agent: null, project: null, error: resolved.error },
      });
      return;
    }

    const agent = await this.getAgentPayloadById(resolved.agentId);
    if (!agent) {
      this.emit({
        type: "fetch_agent_response",
        payload: {
          requestId,
          agent: null,
          project: null,
          error: `Agent not found: ${resolved.agentId}`,
        },
      });
      return;
    }

    const project = agent.workspaceId
      ? await this.buildProjectPlacementForWorkspaceId(agent.workspaceId)
      : null;
    this.emit({
      type: "fetch_agent_response",
      payload: { requestId, agent, project, error: null },
    });
  }

  private shouldUseFullTimelineForProjectedPage(input: {
    timeline: AgentTimelineFetchResult;
  }): boolean {
    const { timeline } = input;
    if (timeline.reset || timeline.rows.length === 0 || !timeline.hasOlder) {
      return false;
    }

    const firstRow = timeline.rows[0];
    if (
      firstRow?.item.type === "assistant_message" ||
      firstRow?.item.type === "reasoning" ||
      firstRow?.item.type === "tool_call"
    ) {
      return true;
    }

    return timeline.rows.some((row) => row.item.type === "tool_call");
  }

  private selectCanonicalTimelineProjection(input: {
    timeline: AgentTimelineFetchResult;
  }): AgentTimelineProjectionSelection {
    const entries = projectTimelineRows({ rows: input.timeline.rows, mode: "canonical" });
    return {
      timeline: input.timeline,
      entries,
      startSeq: entries[0]?.seqStart ?? null,
      endSeq: entries[entries.length - 1]?.seqEnd ?? null,
      hasOlder: input.timeline.hasOlder,
      hasNewer: input.timeline.hasNewer,
    };
  }

  private selectProjectedTimelineProjection(input: {
    agentId: string;
    controlTimeline: AgentTimelineFetchResult;
    direction: AgentTimelineFetchDirection;
    cursor?: AgentTimelineCursor;
    pageLimit: number;
  }): AgentTimelineProjectionSelection {
    const timeline = this.shouldUseFullTimelineForProjectedPage({
      timeline: input.controlTimeline,
    })
      ? this.agentManager.fetchTimeline(input.agentId, { direction: "tail", limit: 0 })
      : input.controlTimeline;
    const page = selectProjectedTimelinePage({
      rows: timeline.rows,
      bounds: timeline.window,
      direction: input.controlTimeline.reset ? "tail" : input.direction,
      ...(input.cursor ? { cursorSeq: input.cursor.seq } : {}),
      limit: input.pageLimit,
    });

    return {
      timeline,
      entries: page.entries,
      startSeq: page.startSeq,
      endSeq: page.endSeq,
      hasOlder: page.hasOlder || (page.startSeq !== null && page.startSeq > timeline.window.minSeq),
      hasNewer: page.hasNewer,
    };
  }

  private selectTimelineProjection(input: {
    agentId: string;
    projection: TimelineProjectionMode;
    controlTimeline: AgentTimelineFetchResult;
    direction: AgentTimelineFetchDirection;
    cursor?: AgentTimelineCursor;
    pageLimit: number;
  }): AgentTimelineProjectionSelection {
    if (input.projection === "canonical") {
      return this.selectCanonicalTimelineProjection({ timeline: input.controlTimeline });
    }

    return this.selectProjectedTimelineProjection(input);
  }

  private async handleFetchAgentTimelineRequest(
    msg: Extract<SessionInboundMessage, { type: "fetch_agent_timeline_request" }>,
  ): Promise<void> {
    const direction: AgentTimelineFetchDirection = msg.direction ?? (msg.cursor ? "after" : "tail");
    const projection: TimelineProjectionMode = msg.projection ?? "projected";
    const requestedLimit = msg.limit;
    const pageLimit = requestedLimit ?? (direction === "after" ? 0 : 200);
    const cursor: AgentTimelineCursor | undefined = msg.cursor
      ? {
          epoch: msg.cursor.epoch,
          seq: msg.cursor.seq,
        }
      : undefined;

    try {
      const snapshot = await ensureAgentLoaded(msg.agentId, {
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        logger: this.sessionLogger,
      });
      const agentPayload = await this.buildAgentPayload(snapshot);

      const controlTimeline = this.agentManager.fetchTimeline(msg.agentId, {
        direction,
        cursor,
        limit: pageLimit,
      });
      const selectedTimeline = this.selectTimelineProjection({
        agentId: msg.agentId,
        projection,
        controlTimeline,
        direction,
        ...(cursor ? { cursor } : {}),
        pageLimit,
      });
      const startCursor =
        selectedTimeline.startSeq !== null
          ? { epoch: selectedTimeline.timeline.epoch, seq: selectedTimeline.startSeq }
          : null;
      const endCursor =
        selectedTimeline.endSeq !== null
          ? { epoch: selectedTimeline.timeline.epoch, seq: selectedTimeline.endSeq }
          : null;

      this.emit({
        type: "fetch_agent_timeline_response",
        payload: {
          requestId: msg.requestId,
          agentId: msg.agentId,
          agent: agentPayload,
          direction,
          projection,
          epoch: selectedTimeline.timeline.epoch,
          reset: controlTimeline.reset,
          staleCursor: controlTimeline.staleCursor,
          gap: controlTimeline.gap,
          window: selectedTimeline.timeline.window,
          startCursor,
          endCursor,
          hasOlder: selectedTimeline.hasOlder,
          hasNewer: selectedTimeline.hasNewer,
          entries: selectedTimeline.entries.map((entry) => ({
            provider: snapshot.provider,
            item: entry.item,
            timestamp: entry.timestamp,
            seqStart: entry.seqStart,
            seqEnd: entry.seqEnd,
            sourceSeqRanges: entry.sourceSeqRanges,
            collapsed: this.supports(CLIENT_CAPS.reasoningMergeEnum)
              ? entry.collapsed
              : entry.collapsed.filter((value) => value !== "reasoning_merge"),
          })),
          error: null,
        },
      });
    } catch (error) {
      this.sessionLogger.error(
        { err: error, agentId: msg.agentId },
        "Failed to handle fetch_agent_timeline_request",
      );
      this.emit({
        type: "fetch_agent_timeline_response",
        payload: {
          requestId: msg.requestId,
          agentId: msg.agentId,
          agent: null,
          direction,
          projection,
          epoch: "",
          reset: false,
          staleCursor: false,
          gap: false,
          window: { minSeq: 0, maxSeq: 0, nextSeq: 0 },
          startCursor: null,
          endCursor: null,
          hasOlder: false,
          hasNewer: false,
          entries: [],
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async handleSendAgentMessageRequest(
    msg: Extract<SessionInboundMessage, { type: "send_agent_message_request" }>,
  ): Promise<void> {
    const resolved = await this.resolveAgentIdentifier(msg.agentId);
    if (!resolved.ok) {
      this.emit({
        type: "send_agent_message_response",
        payload: {
          requestId: msg.requestId,
          agentId: msg.agentId,
          accepted: false,
          error: resolved.error,
        },
      });
      return;
    }

    try {
      const agentId = resolved.agentId;

      const prompt = this.buildAgentPrompt(msg.text, msg.images, msg.attachments);
      this.sessionLogger.trace(
        {
          agentId,
          messageId: msg.messageId,
          textPrefix: msg.text.slice(0, 80),
        },
        "agent.session.send_agent_message",
      );
      let dispatchResult: { outOfBand: boolean };
      try {
        dispatchResult = await sendPromptToAgent({
          agentManager: this.agentManager,
          agentStorage: this.agentStorage,
          agentId,
          prompt,
          messageId: msg.messageId,
          logger: this.sessionLogger,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.handleAgentRunError(agentId, error, "Failed to send agent message");
        this.emit({
          type: "send_agent_message_response",
          payload: {
            requestId: msg.requestId,
            agentId,
            accepted: false,
            error: message,
          },
        });
        return;
      }

      if (dispatchResult.outOfBand) {
        this.emit({
          type: "send_agent_message_response",
          payload: {
            requestId: msg.requestId,
            agentId,
            accepted: true,
            error: null,
          },
        });
        return;
      }

      try {
        await waitForAgentRunStartWithTimeout(this.agentManager, agentId);
      } catch (error) {
        this.emit({
          type: "send_agent_message_response",
          payload: {
            requestId: msg.requestId,
            agentId,
            accepted: false,
            error: errorToFriendlyMessage(error),
          },
        });
        return;
      }

      this.emit({
        type: "send_agent_message_response",
        payload: {
          requestId: msg.requestId,
          agentId,
          accepted: true,
          error: null,
        },
      });
    } catch (error) {
      this.emit({
        type: "send_agent_message_response",
        payload: {
          requestId: msg.requestId,
          agentId: resolved.agentId,
          accepted: false,
          error: errorToFriendlyMessage(error),
        },
      });
    }
  }

  private async handleWaitForFinish(
    agentIdOrIdentifier: string,
    requestId: string,
    timeoutMs?: number,
  ): Promise<void> {
    const resolved = await this.resolveAgentIdentifier(agentIdOrIdentifier);
    if (!resolved.ok) {
      this.emit({
        type: "wait_for_finish_response",
        payload: {
          requestId,
          status: "error",
          final: null,
          error: resolved.error,
          lastMessage: null,
        },
      });
      return;
    }

    const agentId = resolved.agentId;
    const live = this.agentManager.getAgent(agentId);
    if (!live) {
      const record = await this.agentStorage.get(agentId);
      if (!record || record.internal) {
        this.emit({
          type: "wait_for_finish_response",
          payload: {
            requestId,
            status: "error",
            final: null,
            error: `Agent not found: ${agentId}`,
            lastMessage: null,
          },
        });
        return;
      }
      const final = this.buildStoredAgentPayload(record);
      let status: "permission" | "error" | "idle";
      if (record.attentionReason === "permission") {
        status = "permission";
      } else if (record.lastStatus === "error") {
        status = "error";
      } else {
        status = "idle";
      }
      const error = resolveWaitForFinishError({ status, final });
      this.emit({
        type: "wait_for_finish_response",
        payload: { requestId, status, final, error, lastMessage: null },
      });
      return;
    }

    const abortController = new AbortController();
    const hasTimeout = typeof timeoutMs === "number" && timeoutMs > 0;
    const timeoutHandle = hasTimeout
      ? setTimeout(() => {
          abortController.abort("timeout");
        }, timeoutMs)
      : null;

    try {
      let result = await this.agentManager.waitForAgentEvent(agentId, {
        signal: abortController.signal,
        waitForActive: true,
      });
      let final = await this.getAgentPayloadById(agentId);
      if (!final) {
        throw new Error(`Agent ${agentId} disappeared while waiting`);
      }

      let status: "permission" | "error" | "idle";
      if (result.permission) {
        status = "permission";
      } else if (result.status === "error") {
        status = "error";
      } else {
        status = "idle";
      }
      const error = resolveWaitForFinishError({ status, final });

      this.emit({
        type: "wait_for_finish_response",
        payload: { requestId, status, final, error, lastMessage: result.lastMessage },
      });
    } catch (error) {
      const isAbort =
        error instanceof Error &&
        (error.name === "AbortError" || error.message.toLowerCase().includes("aborted"));
      if (!isAbort) {
        const message = errorToFriendlyMessage(error);
        this.sessionLogger.error({ err: error, agentId }, "wait_for_finish_request failed");
        const final = await this.getAgentPayloadById(agentId);
        this.emit({
          type: "wait_for_finish_response",
          payload: {
            requestId,
            status: "error",
            final,
            error: message,
            lastMessage: null,
          },
        });
        return;
      }

      const final = await this.getAgentPayloadById(agentId);
      if (!final) {
        throw new Error(`Agent ${agentId} disappeared while waiting`, { cause: error });
      }
      this.emit({
        type: "wait_for_finish_response",
        payload: { requestId, status: "timeout", final, error: null, lastMessage: null },
      });
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  /**
   * Emit a message to the client
   */
  private emit(msg: SessionOutboundMessage): void {
    // JSON.stringify(msg) is only computed when trace is enabled — it runs for
    // every outbound message otherwise, and trace is disabled by default.
    // Optional-chained because test logger stubs don't implement isLevelEnabled.
    if (this.sessionLogger.isLevelEnabled?.("trace")) {
      this.sessionLogger.trace(
        {
          messageType: msg.type,
          payloadBytes: JSON.stringify(msg).length,
        },
        "agent.session.outbound",
      );
    }
    this.onMessage(msg);
  }

  private emitBinary(frame: Uint8Array): void {
    if (!this.onBinaryMessage) {
      return;
    }
    try {
      this.onBinaryMessage(frame);
    } catch (error) {
      this.sessionLogger.error({ err: error }, "Failed to emit binary frame");
    }
  }

  /**
   * Clean up session resources
   */
  public async cleanup(): Promise<void> {
    this.sessionLogger.trace({}, "agent.session.lifecycle.cleanup");

    if (this.unsubscribeAgentEvents) {
      this.unsubscribeAgentEvents();
      this.unsubscribeAgentEvents = null;
    }
    if (this.unsubscribeTerminalWorkspaceContributionEvents) {
      this.unsubscribeTerminalWorkspaceContributionEvents();
      this.unsubscribeTerminalWorkspaceContributionEvents = null;
    }
    this.providerCatalogSession.dispose();

    await this.voiceSession.cleanup();

    // Close MCP clients
    if (this.agentMcpClient) {
      try {
        await this.agentMcpClient.close();
      } catch (error) {
        this.sessionLogger.error({ err: error }, "Failed to close Agent MCP client");
      }
      this.agentMcpClient = null;
      this.agentTools = null;
    }

    this.terminalController.dispose();

    this.checkoutSession.cleanup();

    for (const unsubscribe of this.workspaceGitSubscriptions.values()) {
      unsubscribe();
    }
    this.workspaceGitSubscriptions.clear();
  }
}
