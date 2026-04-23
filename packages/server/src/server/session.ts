// @ts-nocheck
import equal from "fast-deep-equal";
import { v4 as uuidv4 } from "uuid";
import { stat, mkdir } from "fs/promises";
import { exec, spawn } from "node:child_process";
import { promisify } from "util";
import { basename, join, resolve, sep } from "path";
import { homedir } from "node:os";
import { z } from "zod";
import type { ToolSet } from "ai";
import {
  isLegacyEditorTargetId,
  serializeAgentStreamEvent,
  type AgentSnapshotPayload,
  type SessionInboundMessage,
  type SessionOutboundMessage,
  type FileExplorerRequest,
  type FileWriteRequest,
  type FileRenameRequest,
  type FileDeleteRequest,
  type FileDownloadTokenRequest,
  type GitSetupOptions,
  type ListTerminalsRequest,
  type SubscribeTerminalsRequest,
  type UnsubscribeTerminalsRequest,
  type CreateTerminalRequest,
  type SubscribeTerminalRequest,
  type UnsubscribeTerminalRequest,
  type TerminalInput,
  type CloseItemsRequest,
  type KillTerminalRequest,
  type CaptureTerminalRequest,
  type SubscribeCheckoutDiffRequest,
  type UnsubscribeCheckoutDiffRequest,
  type DirectorySuggestionsRequest,
  type EditorTargetDescriptorPayload,
  type EditorTargetId,
  type ProjectPlacementPayload,
  type WorkspaceDescriptorPayload,
  type WorkspaceStateBucket,
  type BrowserLaunchRequest,
  type BrowserStateRequest,
  type BrowserScreenshotRequest,
  type BrowserNavigateRequest,
  type BrowserGoBackRequest,
  type BrowserGoForwardRequest,
  type BrowserCloseRequest,
  type BrowserResizeRequest,
} from "./messages.js";
import type { TerminalManager, TerminalsChangedEvent } from "../terminal/terminal-manager.js";
import { BrowserManager } from "./browser/browser-manager.js";
import { PlaywrightBrowserManager } from "./browser/playwright-browser-manager.js";
import { captureTerminalLines, type TerminalSession } from "../terminal/terminal.js";
import {
  TerminalStreamOpcode,
  encodeTerminalSnapshotPayload,
  encodeTerminalStreamFrame,
  decodeTerminalResizePayload,
  type TerminalStreamFrame,
} from "../shared/terminal-stream-protocol.js";
import { TTSManager } from "./agent/tts-manager.js";
import { STTManager } from "./agent/stt-manager.js";
import type { SpeechToTextProvider, TextToSpeechProvider } from "./speech/speech-provider.js";
import type { TurnDetectionProvider } from "./speech/turn-detection-provider.js";
import { maybePersistTtsDebugAudio } from "./agent/tts-debug.js";
import { isHubcodeDictationDebugEnabled } from "./agent/recordings-debug.js";
import { listAvailableEditorTargets, openInEditorTarget } from "./editor-targets.js";
import {
  DictationStreamManager,
  type DictationStreamOutboundMessage,
} from "./dictation/dictation-stream-manager.js";
import {
  createVoiceTurnController,
  type VoiceTurnController,
} from "./voice/voice-turn-controller.js";
import {
  buildConfigOverrides,
  buildSessionConfig,
  extractTimestamps,
} from "./persistence-hooks.js";
import { experimental_createMCPClient } from "ai";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { VoiceCallerContext, VoiceSpeakHandler } from "./voice-types.js";
import type { DaemonConfigStore } from "./daemon-config-store.js";
import type { WorkspaceGitRuntimeSnapshot, WorkspaceGitService } from "./workspace-git-service.js";

import { buildProviderRegistry } from "./agent/provider-registry.js";
import type {
  AgentProviderRuntimeSettingsMap,
  ProviderOverride,
} from "./agent/provider-launch-config.js";
import { AgentManager } from "./agent/agent-manager.js";
import { LibraryStore } from "./library/library-store.js";
import { ProviderSnapshotManager } from "./agent/provider-snapshot-manager.js";
import type {
  AgentTimelineCursor,
  AgentTimelineFetchDirection,
  ManagedAgent,
} from "./agent/agent-manager.js";
import { scheduleAgentMetadataGeneration } from "./agent/agent-metadata-generator.js";
import { resolveEffectiveThinkingOptionId, toAgentPayload } from "./agent/agent-projections.js";
import { MAX_EXPLICIT_AGENT_TITLE_CHARS } from "./agent/agent-title-limits.js";
import {
  appendTimelineItemIfAgentKnown,
  emitLiveTimelineItemIfAgentKnown,
} from "./agent/timeline-append.js";
import {
  projectTimelineRows,
  selectTimelineWindowByProjectedLimit,
  type TimelineProjectionMode,
} from "./agent/timeline-projection.js";
import {
  DEFAULT_STRUCTURED_GENERATION_PROVIDERS,
  StructuredAgentFallbackError,
  StructuredAgentResponseError,
  generateStructuredAgentResponseWithFallback,
} from "./agent/agent-response-loop.js";
import type {
  AgentPermissionResponse,
  AgentPromptContentBlock,
  AgentPromptInput,
  AgentRunOptions,
  AgentSessionConfig,
  AgentStreamEvent,
  AgentProvider,
  AgentPersistenceHandle,
  ProviderSnapshotEntry,
} from "./agent/agent-sdk-types.js";
import { AgentStorage, type StoredAgentRecord } from "./agent/agent-storage.js";
import {
  buildProjectPlacementForCwd,
  detectStaleWorkspaces,
  deriveProjectKind,
  deriveProjectRootPath,
  deriveWorkspaceId,
  deriveWorkspaceDisplayName,
  deriveWorkspaceKind,
  normalizeWorkspaceId as normalizePersistedWorkspaceId,
} from "./workspace-registry-model.js";
import type {
  PersistedProjectRecord,
  PersistedWorkspaceRecord,
  ProjectRegistry,
  WorkspaceRegistry,
} from "./workspace-registry.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
} from "./workspace-registry.js";
import {
  buildVoiceModeSystemPrompt,
  stripVoiceModeSystemPrompt,
  wrapSpokenInput,
} from "./voice-config.js";
import { isVoicePermissionAllowed } from "./voice-permission-policy.js";
import {
  listDirectoryEntries,
  readExplorerFile,
  writeExplorerFile,
  renameExplorerEntry,
  deleteExplorerEntry,
  getDownloadableFileInfo,
} from "./file-explorer/service.js";
import { DownloadTokenStore } from "./file-download/token-store.js";
import { PushTokenStore } from "./push/token-store.js";
import { type WorktreeConfig } from "../utils/worktree.js";
import { runAsyncWorktreeBootstrap } from "./worktree-bootstrap.js";
import {
  getCheckoutDiff,
  getCheckoutStatus,
  listBranchSuggestions,
  commitChanges,
  mergeToBase,
  mergeFromBase,
  pullCurrentBranch,
  pushCurrentBranch,
  createPullRequest,
} from "../utils/checkout-git.js";
import { getProjectIcon } from "../utils/project-icon.js";
import { expandTilde } from "../utils/path.js";
import { searchHomeDirectories, searchWorkspaceEntries } from "../utils/directory-suggestions.js";
import { READ_ONLY_GIT_ENV, toCheckoutError } from "./checkout-git-utils.js";
import { CheckoutDiffManager } from "./checkout-diff-manager.js";
import type { LocalSpeechModelId } from "./speech/providers/local/models.js";
import { toResolver, type Resolvable } from "./speech/provider-resolver.js";
import type { SpeechReadinessSnapshot, SpeechReadinessState } from "./speech/speech-runtime.js";
import type pino from "pino";
import { resolveClientMessageId } from "./client-message-id.js";
import { ChatServiceError, FileBackedChatService } from "./chat/chat-service.js";
import { notifyChatMentions } from "./chat/chat-mentions.js";
import { LoopService } from "./loop-service.js";
import { ScheduleService } from "./schedule/service.js";
import type { IndexingService } from "./indexing/service.js";
import { execCommand } from "../utils/spawn.js";
import {
  assertSafeGitRef as assertWorktreeSafeGitRef,
  buildAgentSessionConfig as buildWorktreeAgentSessionConfig,
  runWorktreeSetupInBackground as runWorktreeSetupInBackgroundSession,
  handleCreateHubcodeWorktreeRequest as handleCreateWorktreeRequest,
  handleHubcodeWorktreeArchiveRequest as handleWorktreeArchiveRequest,
  handleHubcodeWorktreeListRequest as handleWorktreeListRequest,
  killTerminalsUnderPath as killWorktreeTerminalsUnderPath,
  registerPendingWorktreeWorkspace as registerPendingWorktreeWorkspaceSession,
} from "./worktree-session.js";

const execAsync = promisify(exec);
const MAX_INITIAL_AGENT_TITLE_CHARS = Math.min(60, MAX_EXPLICIT_AGENT_TITLE_CHARS);
const pendingAgentInitializations = new Map<string, Promise<ManagedAgent>>();
const DEFAULT_AGENT_PROVIDER = "claude";

// TODO: Remove once all app store clients are on >=0.1.45 and understand arbitrary provider strings.
// Clients before 0.1.45 validate providers with z.enum(["claude", "codex", "opencode"]) and reject
// the entire session message if they encounter an unknown provider.
const LEGACY_PROVIDER_IDS = new Set(["claude", "codex", "opencode"]);
const MIN_VERSION_ALL_PROVIDERS = "0.1.45";
const MIN_VERSION_FLEXIBLE_EDITOR_IDS = "0.1.50";

function isAppVersionAtLeast(appVersion: string | null, minVersion: string): boolean {
  if (!appVersion) return false;
  // Strip RC/prerelease suffix: "0.1.45-rc.4" → "0.1.45"
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

function clientSupportsFlexibleEditorIds(appVersion: string | null): boolean {
  return isAppVersionAtLeast(appVersion, MIN_VERSION_FLEXIBLE_EDITOR_IDS);
}

const MAX_TERMINAL_STREAM_SLOTS = 256;

function deriveInitialAgentTitle(prompt: string): string | null {
  const firstContentLine = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstContentLine) {
    return null;
  }
  const normalized = firstContentLine.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  const clamped = normalized.slice(0, MAX_INITIAL_AGENT_TITLE_CHARS).trim();
  return clamped.length > 0 ? clamped : null;
}

export function resolveCreateAgentTitles(options: {
  configTitle?: string | null;
  initialPrompt?: string | null;
}): { explicitTitle: string | null; provisionalTitle: string | null } {
  const explicitTitle =
    typeof options.configTitle === "string" && options.configTitle.trim().length > 0
      ? options.configTitle.trim()
      : null;
  const trimmedPrompt = options.initialPrompt?.trim();
  const provisionalTitle =
    explicitTitle ?? (trimmedPrompt ? deriveInitialAgentTitle(trimmedPrompt) : null);

  return {
    explicitTitle,
    provisionalTitle,
  };
}

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

type ProcessingPhase = "idle" | "transcribing";

type ActiveTerminalStream = {
  terminalId: string;
  slot: number;
  unsubscribe: () => void;
  needsSnapshot: boolean;
};

export type SessionRuntimeMetrics = {
  terminalDirectorySubscriptionCount: number;
  terminalSubscriptionCount: number;
  inflightRequests: number;
  peakInflightRequests: number;
};

type FetchAgentsRequestMessage = Extract<SessionInboundMessage, { type: "fetch_agents_request" }>;
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
type AgentUpdatesSubscriptionState = {
  subscriptionId: string;
  filter?: AgentUpdatesFilter;
  isBootstrapping: boolean;
  pendingUpdatesByAgentId: Map<string, AgentUpdatePayload>;
};
type FetchAgentsCursor = {
  sort: FetchAgentsRequestSort[];
  values: Record<string, string | number | null>;
  id: string;
};
type FetchWorkspacesRequestMessage = Extract<
  SessionInboundMessage,
  { type: "fetch_workspaces_request" }
>;
type FetchWorkspacesRequestFilter = NonNullable<FetchWorkspacesRequestMessage["filter"]>;
type FetchWorkspacesRequestSort = NonNullable<FetchWorkspacesRequestMessage["sort"]>[number];
type FetchWorkspacesResponsePayload = Extract<
  SessionOutboundMessage,
  { type: "fetch_workspaces_response" }
>["payload"];
type FetchWorkspacesResponseEntry = FetchWorkspacesResponsePayload["entries"][number];
type FetchWorkspacesResponsePageInfo = FetchWorkspacesResponsePayload["pageInfo"];
type WorkspaceUpdatePayload = Extract<
  SessionOutboundMessage,
  { type: "workspace_update" }
>["payload"];
type WorkspaceUpdatesFilter = FetchWorkspacesRequestFilter;
type WorkspaceUpdatesSubscriptionState = {
  subscriptionId: string;
  filter?: WorkspaceUpdatesFilter;
  isBootstrapping: boolean;
  pendingUpdatesByWorkspaceId: Map<string, WorkspaceUpdatePayload>;
  lastEmittedByWorkspaceId: Map<string, WorkspaceUpdatePayload>;
};
type FetchWorkspacesCursor = {
  sort: FetchWorkspacesRequestSort[];
  values: Record<string, string | number | null>;
  id: string;
};

class SessionRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SessionRequestError";
  }
}

const PCM_SAMPLE_RATE = 16000;
const PCM_CHANNELS = 1;
const PCM_BITS_PER_SAMPLE = 16;
const PCM_BYTES_PER_MS = (PCM_SAMPLE_RATE * PCM_CHANNELS * (PCM_BITS_PER_SAMPLE / 8)) / 1000;
const MIN_STREAMING_SEGMENT_DURATION_MS = 1000;
const MIN_STREAMING_SEGMENT_BYTES = Math.round(
  PCM_BYTES_PER_MS * MIN_STREAMING_SEGMENT_DURATION_MS,
);
const AgentIdSchema = z.string().uuid();
const VOICE_INTERRUPT_CONFIRMATION_MS = 500;

type VoiceModeBaseConfig = {
  systemPrompt?: string;
};

interface AudioBufferState {
  chunks: Buffer[];
  format: string;
  isPCM: boolean;
  totalPCMBytes: number;
}

type VoiceTranscriptionResultPayload = {
  text: string;
  requestId: string;
  language?: string;
  duration?: number;
  avgLogprob?: number;
  isLowConfidence?: boolean;
  byteLength?: number;
  format?: string;
  debugRecordingPath?: string;
};

export type SessionOptions = {
  clientId: string;
  appVersion: string | null;
  onMessage: (msg: SessionOutboundMessage) => void;
  onBinaryMessage?: (frame: Uint8Array) => void;
  onLifecycleIntent?: (intent: SessionLifecycleIntent) => void;
  logger: pino.Logger;
  downloadTokenStore: DownloadTokenStore;
  pushTokenStore: PushTokenStore;
  hubcodeHome: string;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  projectRegistry: ProjectRegistry;
  workspaceRegistry: WorkspaceRegistry;
  chatService: FileBackedChatService;
  scheduleService: ScheduleService;
  indexingService?: IndexingService | null;
  loopService: LoopService;
  checkoutDiffManager: CheckoutDiffManager;
  workspaceGitService: WorkspaceGitService;
  daemonConfigStore: DaemonConfigStore;
  mcpBaseUrl?: string | null;
  stt: Resolvable<SpeechToTextProvider | null>;
  tts: Resolvable<TextToSpeechProvider | null>;
  terminalManager: TerminalManager | null;
  browserManager?: BrowserManager | null;
  clientBrowserManager?: PlaywrightBrowserManager | null;
  providerSnapshotManager?: ProviderSnapshotManager;
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
    getSpeechReadiness?: () => SpeechReadinessSnapshot;
  };
  agentProviderRuntimeSettings?: AgentProviderRuntimeSettingsMap;
  providerOverrides?: Record<string, ProviderOverride>;
  /**
   * When set, this session was established via a workspace share token and is
   * restricted to a single workspace with a specific access level. Every handler
   * that operates on a workspace path must verify the cwd matches.
   */
  shareScope?: {
    workspaceId: string;
    accessLevel: "read_only" | "full_access";
    shareToken: string;
    ownerUserId: string;
  } | null;
};

export type SessionShareScope = NonNullable<SessionOptions["shareScope"]>;

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

type VoiceFeatureUnavailableContext = {
  reasonCode: SpeechReadinessSnapshot["voiceFeature"]["reasonCode"];
  message: string;
  retryable: boolean;
  missingModelIds: LocalSpeechModelId[];
};

type VoiceFeatureUnavailableResponseMetadata = {
  reasonCode?: SpeechReadinessSnapshot["voiceFeature"]["reasonCode"];
  retryable?: boolean;
  missingModelIds?: LocalSpeechModelId[];
};

class VoiceFeatureUnavailableError extends Error {
  readonly reasonCode: SpeechReadinessSnapshot["voiceFeature"]["reasonCode"];
  readonly retryable: boolean;
  readonly missingModelIds: LocalSpeechModelId[];

  constructor(context: VoiceFeatureUnavailableContext) {
    super(context.message);
    this.name = "VoiceFeatureUnavailableError";
    this.reasonCode = context.reasonCode;
    this.retryable = context.retryable;
    this.missingModelIds = [...context.missingModelIds];
  }
}

function convertPCMToWavBuffer(
  pcmBuffer: Buffer,
  sampleRate: number,
  channels: number,
  bitsPerSample: number,
): Buffer {
  const headerSize = 44;
  const wavBuffer = Buffer.alloc(headerSize + pcmBuffer.length);
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;

  wavBuffer.write("RIFF", 0);
  wavBuffer.writeUInt32LE(36 + pcmBuffer.length, 4);
  wavBuffer.write("WAVE", 8);
  wavBuffer.write("fmt ", 12);
  wavBuffer.writeUInt32LE(16, 16);
  wavBuffer.writeUInt16LE(1, 20);
  wavBuffer.writeUInt16LE(channels, 22);
  wavBuffer.writeUInt32LE(sampleRate, 24);
  wavBuffer.writeUInt32LE(byteRate, 28);
  wavBuffer.writeUInt16LE(blockAlign, 32);
  wavBuffer.writeUInt16LE(bitsPerSample, 34);
  wavBuffer.write("data", 36);
  wavBuffer.writeUInt32LE(pcmBuffer.length, 40);
  pcmBuffer.copy(wavBuffer, 44);

  return wavBuffer;
}

function isRegisteredProvider(
  providerRegistry: ReturnType<typeof buildProviderRegistry>,
  value: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(providerRegistry, value);
}

function coerceAgentProvider(
  logger: pino.Logger,
  providerRegistry: ReturnType<typeof buildProviderRegistry>,
  value: string,
  agentId?: string,
): AgentProvider {
  if (isRegisteredProvider(providerRegistry, value)) {
    return value;
  }
  logger.warn(
    { value, agentId, defaultProvider: DEFAULT_AGENT_PROVIDER },
    `Unknown provider '${value}' for agent ${agentId ?? "unknown"}; defaulting to '${DEFAULT_AGENT_PROVIDER}'`,
  );
  return DEFAULT_AGENT_PROVIDER;
}

function toAgentPersistenceHandle(
  logger: pino.Logger,
  providerRegistry: ReturnType<typeof buildProviderRegistry>,
  handle: StoredAgentRecord["persistence"],
): AgentPersistenceHandle | null {
  if (!handle) {
    return null;
  }
  const provider = handle.provider;
  if (!isRegisteredProvider(providerRegistry, provider)) {
    logger.warn({ provider }, `Ignoring persistence handle with unknown provider '${provider}'`);
    return null;
  }
  if (!handle.sessionId) {
    logger.warn("Ignoring persistence handle missing sessionId");
    return null;
  }
  return {
    provider,
    sessionId: handle.sessionId,
    nativeHandle: handle.nativeHandle,
    metadata: handle.metadata,
  } satisfies AgentPersistenceHandle;
}

/**
 * Session represents a single connected client session.
 * It owns all state management, orchestration logic, and message processing.
 * Session has no knowledge of WebSockets - it only emits and receives messages.
 */
export class Session {
  private readonly clientId: string;
  private appVersion: string | null;
  private readonly sessionId: string;
  private readonly onMessage: (msg: SessionOutboundMessage) => void;
  private readonly onBinaryMessage: ((frame: Uint8Array) => void) | null;
  private readonly onLifecycleIntent: ((intent: SessionLifecycleIntent) => void) | null;
  private readonly sessionLogger: pino.Logger;
  private readonly hubcodeHome: string;
  private readonly libraryStore = new LibraryStore();

  // State machine
  private abortController: AbortController;
  private processingPhase: ProcessingPhase = "idle";

  // Voice mode state
  private isVoiceMode = false;
  private speechInProgress = false;
  private pendingVoiceSpeechStartAt: number | null = null;
  private pendingVoiceSpeechTimer: NodeJS.Timeout | null = null;

  private readonly dictationStreamManager: DictationStreamManager;
  private readonly resolveVoiceTurnDetection: () => TurnDetectionProvider | null;
  private voiceTurnController: VoiceTurnController | null = null;
  private voiceInputChunkCount = 0;
  private voiceInputBytes = 0;
  private voiceInputWindowStartedAt = Date.now();

  // Audio buffering for interruption handling
  private pendingAudioSegments: Array<{ audio: Buffer; format: string }> = [];
  private bufferTimeout: NodeJS.Timeout | null = null;
  private audioBuffer: AudioBufferState | null = null;

  // Optional TTS debug capture (persisted per utterance)
  private readonly ttsDebugStreams = new Map<string, { format: string; chunks: Buffer[] }>();

  // Per-session managers
  private readonly ttsManager: TTSManager;
  private readonly sttManager: STTManager;

  // Per-session MCP client and tools
  private agentMcpClient: Awaited<ReturnType<typeof experimental_createMCPClient>> | null = null;
  private agentTools: ToolSet | null = null;
  private agentManager: AgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly projectRegistry: ProjectRegistry;
  private readonly workspaceRegistry: WorkspaceRegistry;
  private readonly chatService: FileBackedChatService;
  private readonly scheduleService: ScheduleService;
  private readonly indexingService: IndexingService | null;
  private unsubscribeIndexingStatus: (() => void) | null = null;
  private unsubscribeIndexingProcessState: (() => void) | null = null;
  private unsubscribeIndexingToolsChanged: (() => void) | null = null;
  private unsubscribeIndexingFsTrigger: (() => void) | null = null;
  private readonly loopService: LoopService;
  private readonly checkoutDiffManager: CheckoutDiffManager;
  private readonly workspaceGitService: WorkspaceGitService;
  private readonly daemonConfigStore: DaemonConfigStore;
  private readonly mcpBaseUrl: string | null;
  private readonly downloadTokenStore: DownloadTokenStore;
  private readonly pushTokenStore: PushTokenStore;
  private readonly providerRegistry: ReturnType<typeof buildProviderRegistry>;
  private unsubscribeAgentEvents: (() => void) | null = null;
  private agentUpdatesSubscription: AgentUpdatesSubscriptionState | null = null;
  private workspaceUpdatesSubscription: WorkspaceUpdatesSubscriptionState | null = null;
  private clientActivity: {
    deviceType: "web" | "mobile";
    focusedAgentId: string | null;
    lastActivityAt: Date;
    appVisible: boolean;
    appVisibilityChangedAt: Date;
  } | null = null;
  private readonly MOBILE_BACKGROUND_STREAM_GRACE_MS = 60_000;
  private readonly terminalManager: TerminalManager | null;
  private readonly browserManager: BrowserManager;
  private readonly clientBrowserManager: PlaywrightBrowserManager;
  private unsubscribeBrowserLaunched: (() => void) | null = null;
  private unsubscribeClientBrowserLaunched: (() => void) | null = null;
  private releaseClientBrowserEmit: (() => void) | null = null;
  private readonly providerSnapshotManager: ProviderSnapshotManager | null;
  private unsubscribeProviderSnapshotEvents: (() => void) | null = null;
  private readonly subscribedTerminalDirectories = new Set<string>();
  private unsubscribeTerminalsChanged: (() => void) | null = null;
  private terminalExitSubscriptions: Map<string, () => void> = new Map();
  private readonly activeTerminalStreams = new Map<number, ActiveTerminalStream>();
  private readonly terminalIdToSlot = new Map<string, number>();
  private nextTerminalSlot = 0;
  private inflightRequests = 0;
  private peakInflightRequests = 0;
  private readonly checkoutDiffSubscriptions = new Map<string, () => void>();
  private readonly workspaceGitSubscriptions = new Map<string, () => void>();
  private readonly registerVoiceSpeakHandler?: (
    agentId: string,
    handler: VoiceSpeakHandler,
  ) => void;
  private readonly unregisterVoiceSpeakHandler?: (agentId: string) => void;
  private readonly registerVoiceCallerContext?: (
    agentId: string,
    context: VoiceCallerContext,
  ) => void;
  private readonly unregisterVoiceCallerContext?: (agentId: string) => void;
  private readonly getSpeechReadiness?: () => SpeechReadinessSnapshot;
  private readonly agentProviderRuntimeSettings: AgentProviderRuntimeSettingsMap | undefined;
  private readonly providerOverrides: Record<string, ProviderOverride> | undefined;
  private voiceModeAgentId: string | null = null;
  private voiceModeBaseConfig: VoiceModeBaseConfig | null = null;
  private readonly shareScope: SessionShareScope | null;

  constructor(options: SessionOptions) {
    const {
      clientId,
      appVersion,
      onMessage,
      onBinaryMessage,
      onLifecycleIntent,
      logger,
      downloadTokenStore,
      pushTokenStore,
      hubcodeHome,
      agentManager,
      agentStorage,
      projectRegistry,
      workspaceRegistry,
      chatService,
      scheduleService,
      indexingService,
      loopService,
      checkoutDiffManager,
      workspaceGitService,
      daemonConfigStore,
      mcpBaseUrl,
      stt,
      tts,
      terminalManager,
      providerSnapshotManager,
      voice,
      voiceBridge,
      dictation,
      agentProviderRuntimeSettings,
      providerOverrides,
      shareScope,
    } = options;
    this.clientId = clientId;
    this.appVersion = appVersion;
    this.sessionId = uuidv4();
    this.onMessage = onMessage;
    this.onBinaryMessage = onBinaryMessage ?? null;
    this.onLifecycleIntent = onLifecycleIntent ?? null;
    this.downloadTokenStore = downloadTokenStore;
    this.pushTokenStore = pushTokenStore;
    this.hubcodeHome = hubcodeHome;
    this.agentManager = agentManager;
    this.agentStorage = agentStorage;
    this.projectRegistry = projectRegistry;
    this.workspaceRegistry = workspaceRegistry;
    this.chatService = chatService;
    this.scheduleService = scheduleService;
    this.indexingService = indexingService ?? null;
    this.loopService = loopService;
    this.checkoutDiffManager = checkoutDiffManager;
    this.workspaceGitService = workspaceGitService;
    this.daemonConfigStore = daemonConfigStore;
    this.mcpBaseUrl = mcpBaseUrl ?? null;
    this.terminalManager = terminalManager;
    this.browserManager =
      options.browserManager ??
      new BrowserManager({
        logger,
        onStateChange: (event) => {
          this.emit({
            type: "browser_state_update",
            payload: {
              browserId: event.browserId,
              url: event.url,
              title: event.title,
            },
          });
        },
      });
    this.clientBrowserManager =
      (options.clientBrowserManager as PlaywrightBrowserManager | null) ??
      new PlaywrightBrowserManager({ logger });
    this.releaseClientBrowserEmit = this.clientBrowserManager.setEmit((message) =>
      this.emit(message as any),
    );
    this.unsubscribeBrowserLaunched = this.browserManager.onBrowserLaunched((event) => {
      this.emit({
        type: "browser_launched",
        payload: {
          browserId: event.browserId,
          url: event.url,
          title: event.title,
        },
      });
    });
    this.unsubscribeClientBrowserLaunched = this.clientBrowserManager.onBrowserLaunched((event) => {
      this.emit({
        type: "browser_launched",
        payload: {
          browserId: event.browserId,
          url: event.url,
          title: event.title,
        },
      });
    });
    this.providerSnapshotManager = providerSnapshotManager ?? null;
    if (this.terminalManager) {
      this.unsubscribeTerminalsChanged = this.terminalManager.subscribeTerminalsChanged((event) =>
        this.handleTerminalsChanged(event),
      );
    }
    if (this.providerSnapshotManager) {
      const handleProviderSnapshotChange = (entries: ProviderSnapshotEntry[], cwd?: string) => {
        // COMPAT(providersSnapshot): keep provider visibility gating for older clients.
        const visibleEntries = entries.filter((entry) =>
          this.isProviderVisibleToClient(entry.provider),
        );
        this.emit({
          type: "providers_snapshot_update",
          payload: {
            cwd,
            entries: visibleEntries,
            generatedAt: new Date().toISOString(),
          },
        });
      };
      this.providerSnapshotManager.on("change", handleProviderSnapshotChange);
      this.unsubscribeProviderSnapshotEvents = () => {
        this.providerSnapshotManager?.off("change", handleProviderSnapshotChange);
      };
    }
    this.resolveVoiceTurnDetection = toResolver(voice?.turnDetection ?? null);
    this.registerVoiceSpeakHandler = voiceBridge?.registerVoiceSpeakHandler;
    this.unregisterVoiceSpeakHandler = voiceBridge?.unregisterVoiceSpeakHandler;
    this.registerVoiceCallerContext = voiceBridge?.registerVoiceCallerContext;
    this.unregisterVoiceCallerContext = voiceBridge?.unregisterVoiceCallerContext;
    this.getSpeechReadiness = dictation?.getSpeechReadiness;
    this.agentProviderRuntimeSettings = agentProviderRuntimeSettings;
    this.providerOverrides = providerOverrides;
    this.shareScope = shareScope ?? null;
    if (this.shareScope) {
      this.sessionLogger.info(
        {
          workspaceId: this.shareScope.workspaceId,
          accessLevel: this.shareScope.accessLevel,
          ownerUserId: this.shareScope.ownerUserId,
        },
        "Session is share-scoped; workspace access will be enforced per-request",
      );
    }
    this.abortController = new AbortController();
    this.sessionLogger = logger.child({
      module: "session",
      clientId: this.clientId,
      sessionId: this.sessionId,
    });
    this.providerRegistry = buildProviderRegistry(this.sessionLogger, {
      runtimeSettings: this.agentProviderRuntimeSettings,
      providerOverrides: this.providerOverrides,
    });
    if (this.indexingService) {
      this.unsubscribeIndexingStatus = this.indexingService.onStatus((event) => {
        try {
          this.emit({
            type: "indexing/status",
            payload: { workspaceId: event.workspaceId, status: event.status },
          });
        } catch (err) {
          this.sessionLogger.warn({ err }, "Failed to emit indexing/status");
        }
      });
      this.unsubscribeIndexingProcessState = this.indexingService.onProcessState((state) => {
        try {
          this.emit({
            type: "indexing/process-state",
            payload: {
              phase: state.phase,
              ...(state.pid != null ? { pid: state.pid } : {}),
              ...(state.startedAt != null ? { startedAt: state.startedAt } : {}),
              restartCount: state.restartCount,
              ...(state.lastError ? { lastError: state.lastError } : {}),
            },
          });
        } catch (err) {
          this.sessionLogger.warn({ err }, "Failed to emit indexing/process-state");
        }
      });
      this.unsubscribeIndexingToolsChanged = this.indexingService.onToolsChanged((event) => {
        try {
          this.emit({
            type: "indexing/tools-changed",
            payload: {
              ...(event.workspaceId ? { workspaceId: event.workspaceId } : {}),
              agentId: event.agentId,
            },
          });
        } catch (err) {
          this.sessionLogger.warn({ err }, "Failed to emit indexing/tools-changed");
        }
      });
      this.unsubscribeIndexingFsTrigger = this.indexingService.onFsTrigger((event) => {
        try {
          this.emit({ type: "indexing/fs-trigger", payload: event });
        } catch (err) {
          this.sessionLogger.warn({ err }, "Failed to emit indexing/fs-trigger");
        }
      });
    }

    // Initialize per-session managers
    this.ttsManager = new TTSManager(this.sessionId, this.sessionLogger, tts);
    this.sttManager = new STTManager(this.sessionId, this.sessionLogger, stt);
    this.dictationStreamManager = new DictationStreamManager({
      logger: this.sessionLogger,
      sessionId: this.sessionId,
      emit: (msg) => this.handleDictationManagerMessage(msg),
      stt: dictation?.stt ?? null,
      finalTimeoutMs: dictation?.finalTimeoutMs,
    });

    // Initialize agent MCP client asynchronously
    void this.initializeAgentMcp();
    this.subscribeToAgentEvents();

    this.sessionLogger.trace("Session created");
  }

  updateAppVersion(appVersion: string | null): void {
    if (appVersion && appVersion !== this.appVersion) {
      this.appVersion = appVersion;
    }
  }

  // ---------------------------------------------------------------------------
  // Workspace-share access control
  //
  // When this session was established via a share token (see handleHello in
  // websocket-server.ts), every handler that touches a workspace path MUST
  // validate the request against the scope before doing any work — otherwise a
  // malicious recipient could craft WS messages to read/write other workspaces.
  // ---------------------------------------------------------------------------

  private isShareRestricted(): boolean {
    return this.shareScope !== null;
  }

  /**
   * Returns null when access is allowed (or the session is not share-scoped).
   * Returns an error string when the requested workspace is outside the scope.
   */
  private checkWorkspaceAccess(cwd: string | undefined | null): string | null {
    if (!this.shareScope) return null;
    const allowed = this.shareScope.workspaceId.trim();
    const requested = (cwd ?? "").trim();
    if (!requested) {
      return "cwd is required for share-scoped sessions";
    }
    // Allow the authorized workspace and paths nested within it.
    if (requested === allowed) return null;
    const prefix = allowed.endsWith("/") ? allowed : `${allowed}/`;
    if (requested.startsWith(prefix)) return null;
    return "Access denied: this workspace is not shared with you";
  }

  /**
   * Returns null when writes are allowed. Returns an error string when the
   * session is share-scoped with read-only access.
   */
  private checkWriteAccess(): string | null {
    if (!this.shareScope) return null;
    if (this.shareScope.accessLevel === "read_only") {
      return "Access denied: shared workspace is read-only";
    }
    return null;
  }

  /**
   * Centralized pre-dispatch guard for share-scoped sessions. Returns true when
   * the message was rejected (and an rpc_error was emitted) — the caller should
   * skip handler dispatch. Returns false to continue normal processing.
   *
   * Scope decisions:
   * - Server-control + settings writes are globally blocked for share sessions.
   * - Write-class requests are blocked when accessLevel === "read_only".
   * - Any request carrying a cwd/workspaceId that doesn't match the authorized
   *   workspace is rejected.
   * - Read-class list endpoints (fetch_workspaces, fetch_agents) are allowed;
   *   their handlers filter the response to the authorized workspace.
   */
  // biome-ignore lint/suspicious/noExplicitAny: raw inbound message union is too large to narrow here
  private enforceShareScopeOnMessage(msg: any): boolean {
    if (!this.shareScope) return false;

    const type: string = msg?.type ?? "";
    const requestId: string | undefined = msg?.requestId;

    // Globally blocked — shared recipients cannot use these even on their own workspace.
    const GLOBAL_BLOCK = new Set([
      "restart_server_request",
      "shutdown_server_request",
      "set_daemon_config_request",
      "open_project_request",
      "clone_repository_request",
      "hubcode_worktree_list_request",
      "hubcode_worktree_archive_request",
      "create_hubcode_worktree_request",
      "archive_workspace_request",
      "set_agent_feature_request",
      "set_agent_model_request",
      "set_agent_mode_request",
      "refresh_providers_snapshot_request",
      "schedule_create_request",
      "schedule_delete_request",
      "loop_run_request",
      "loop_stop_request",
      "push_register_request",
      "push_unregister_request",
    ]);
    if (GLOBAL_BLOCK.has(type)) {
      this.emitShareScopeRejection(requestId, type, "Not permitted in shared session");
      return true;
    }

    // Write-class operations blocked when the share is read-only.
    const WRITE_TYPES = new Set([
      "file_write_request",
      "file_rename_request",
      "file_delete_request",
      "create_agent_request",
      "delete_agent_request",
      "archive_agent_request",
      "update_agent_request",
      "create_terminal_request",
      "subscribe_terminal_request",
      "kill_terminal_request",
      "terminal_input",
      "checkout_commit_request",
      "checkout_push_request",
      "checkout_merge_request",
      "checkout_pr_create_request",
      "checkout_switch_branch_request",
      "checkout_pull_request",
      "stash_save_request",
      "stash_pop_request",
      "browser_launch_request",
      "browser_navigate_request",
      "browser_fill_request",
      "browser_click_request",
      "browser_go_back_request",
      "browser_go_forward_request",
      "browser_close_request",
      "browser_resize_request",
    ]);
    if (this.shareScope.accessLevel === "read_only" && WRITE_TYPES.has(type)) {
      this.emitShareScopeRejection(requestId, type, "Shared workspace is read-only");
      return true;
    }

    // Workspace path enforcement for any message carrying cwd / workspaceId / config.cwd.
    const candidateCwd: unknown =
      msg?.cwd ?? msg?.workspaceId ?? msg?.config?.cwd ?? msg?.worktreePath ?? null;
    if (typeof candidateCwd === "string" && candidateCwd.length > 0) {
      const err = this.checkWorkspaceAccess(candidateCwd);
      if (err) {
        this.emitShareScopeRejection(requestId, type, err);
        return true;
      }
    }

    return false;
  }

  private emitShareScopeRejection(
    requestId: string | undefined,
    requestType: string,
    error: string,
  ): void {
    this.sessionLogger.warn(
      {
        requestType,
        requestId,
        shareWorkspaceId: this.shareScope?.workspaceId,
        ownerUserId: this.shareScope?.ownerUserId,
      },
      "Rejecting request — violates share scope",
    );
    this.emit({
      type: "rpc_error",
      payload: {
        requestId: requestId ?? "",
        requestType,
        error,
        code: "share_scope_denied",
      },
    });
  }

  /**
   * Get the client's current activity state
   */
  public getClientActivity(): {
    deviceType: "web" | "mobile";
    focusedAgentId: string | null;
    lastActivityAt: Date;
    appVisible: boolean;
    appVisibilityChangedAt: Date;
  } | null {
    return this.clientActivity;
  }

  public getRuntimeMetrics(): SessionRuntimeMetrics {
    return {
      terminalDirectorySubscriptionCount: this.subscribedTerminalDirectories.size,
      terminalSubscriptionCount: this.activeTerminalStreams.size,
      inflightRequests: this.inflightRequests,
      peakInflightRequests: this.peakInflightRequests,
    };
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
  ): AgentPromptInput {
    const normalized = text?.trim() ?? "";
    if (!images || images.length === 0) {
      return normalized;
    }
    const blocks: AgentPromptContentBlock[] = [];
    if (normalized.length > 0) {
      blocks.push({ type: "text", text: normalized });
    }
    for (const image of images) {
      blocks.push({ type: "image", data: image.data, mimeType: image.mimeType });
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
      this.sessionLogger.trace({ agentId }, "interruptAgentIfRunning: agent not found");
      throw new Error(`Agent ${agentId} not found`);
    }

    const hasInFlightRun = this.agentManager.hasInFlightRun(agentId);
    if (!hasInFlightRun) {
      this.sessionLogger.trace(
        { agentId, lifecycle: snapshot.lifecycle, hasInFlightRun },
        "interruptAgentIfRunning: skipping because agent is not running",
      );
      return;
    }

    this.sessionLogger.debug(
      { agentId, lifecycle: snapshot.lifecycle, hasInFlightRun },
      "interruptAgentIfRunning: interrupting",
    );

    try {
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
    } catch (error) {
      throw error;
    }
  }

  private hasActiveAgentRun(agentId: string | null): boolean {
    if (!agentId) {
      return false;
    }
    return this.agentManager.hasInFlightRun(agentId);
  }

  /**
   * Start streaming an agent run and forward results via the websocket broadcast
   */
  private startAgentStream(
    agentId: string,
    prompt: AgentPromptInput,
    runOptions?: AgentRunOptions,
  ): { ok: true } | { ok: false; error: string } {
    this.sessionLogger.trace(
      {
        agentId,
        promptType: typeof prompt === "string" ? "string" : "structured",
        hasRunOptions: Boolean(runOptions),
      },
      "startAgentStream: requested",
    );
    let iterator: AsyncGenerator<AgentStreamEvent>;
    try {
      const shouldReplace = this.agentManager.hasInFlightRun(agentId);
      iterator = shouldReplace
        ? this.agentManager.replaceAgentRun(agentId, prompt, runOptions)
        : this.agentManager.streamAgent(agentId, prompt, runOptions);
      this.sessionLogger.trace(
        { agentId, shouldReplace },
        "startAgentStream: agent iterator returned",
      );
    } catch (error) {
      this.handleAgentRunError(agentId, error, "Failed to start agent run");
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : "Unknown error";
      return { ok: false, error: message };
    }

    void (async () => {
      try {
        for await (const _ of iterator) {
          // Events are forwarded via the session's AgentManager subscription.
        }
        this.sessionLogger.trace({ agentId }, "startAgentStream: iterator drained");
      } catch (error) {
        this.sessionLogger.trace({ agentId, err: error }, "startAgentStream: iterator threw");
        this.handleAgentRunError(agentId, error, "Agent stream failed");
      }
    })();

    return { ok: true };
  }

  private handleAgentRunError(agentId: string, error: unknown, context: string): void {
    const message =
      error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";
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
      const transport = new StreamableHTTPClientTransport(new URL(this.mcpBaseUrl));

      this.agentMcpClient = await experimental_createMCPClient({
        transport,
      });

      this.agentTools = (await this.agentMcpClient.tools()) as ToolSet;
      const agentToolCount = Object.keys(this.agentTools ?? {}).length;
      this.sessionLogger.trace(
        { agentToolCount },
        `Agent MCP initialized with ${agentToolCount} tools`,
      );
    } catch (error) {
      this.sessionLogger.error({ err: error }, "Failed to initialize Agent MCP");
    }
  }

  /**
   * Subscribe to AgentManager events and forward them to the client
   */
  private subscribeToAgentEvents(): void {
    if (this.unsubscribeAgentEvents) {
      this.unsubscribeAgentEvents();
    }

    this.unsubscribeAgentEvents = this.agentManager.subscribe(
      (event) => {
        if (event.type === "agent_state") {
          void this.forwardAgentUpdate(event.agent);
          return;
        }

        if (
          this.isVoiceMode &&
          this.voiceModeAgentId === event.agentId &&
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

        // Reduce bandwidth/CPU on mobile: only forward high-frequency agent stream events
        // for the focused agent, with a short grace window while backgrounded.
        // History catch-up is handled via pull-based `fetch_agent_timeline_request`.
        const activity = this.clientActivity;
        if (activity?.deviceType === "mobile") {
          if (!activity.focusedAgentId) {
            return;
          }
          if (activity.focusedAgentId !== event.agentId) {
            return;
          }
          if (!activity.appVisible) {
            const hiddenForMs = Date.now() - activity.appVisibilityChangedAt.getTime();
            if (hiddenForMs >= this.MOBILE_BACKGROUND_STREAM_GRACE_MS) {
              return;
            }
          }
        }

        const serializedEvent = serializeAgentStreamEvent(event.event);
        if (!serializedEvent) {
          return;
        }

        const payload = {
          agentId: event.agentId,
          event: serializedEvent,
          timestamp: new Date().toISOString(),
          ...(typeof event.seq === "number" ? { seq: event.seq } : {}),
          ...(typeof event.epoch === "string" ? { epoch: event.epoch } : {}),
        } as const;

        this.emit({
          type: "agent_stream",
          payload,
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

  private async buildAgentPayload(agent: ManagedAgent): Promise<AgentSnapshotPayload> {
    const storedRecord = await this.agentStorage.get(agent.id);
    const title = storedRecord?.title ?? storedRecord?.config?.title ?? null;
    const payload = toAgentPayload(agent, { title });
    const storedUpdatedAt = storedRecord
      ? this.resolveStoredAgentPayloadUpdatedAt(storedRecord)
      : null;
    if (storedUpdatedAt) {
      const liveUpdatedAt = Date.parse(payload.updatedAt);
      const persistedUpdatedAt = Date.parse(storedUpdatedAt);
      if (
        !Number.isNaN(persistedUpdatedAt) &&
        (Number.isNaN(liveUpdatedAt) || persistedUpdatedAt > liveUpdatedAt)
      ) {
        payload.updatedAt = storedUpdatedAt;
      }
    }
    payload.archivedAt = storedRecord?.archivedAt ?? null;
    return payload;
  }

  private buildStoredAgentPayload(record: StoredAgentRecord): AgentSnapshotPayload {
    const defaultCapabilities = {
      supportsStreaming: false,
      supportsSessionPersistence: true,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: true,
    } as const;

    const createdAt = new Date(record.createdAt);
    const updatedAt = new Date(this.resolveStoredAgentPayloadUpdatedAt(record));
    const lastUserMessageAt = record.lastUserMessageAt ? new Date(record.lastUserMessageAt) : null;

    const provider = coerceAgentProvider(
      this.sessionLogger,
      this.providerRegistry,
      record.provider,
      record.id,
    );
    const runtimeInfo = record.runtimeInfo
      ? {
          provider: coerceAgentProvider(
            this.sessionLogger,
            this.providerRegistry,
            record.runtimeInfo.provider,
            record.id,
          ),
          sessionId: record.runtimeInfo.sessionId,
          ...(Object.prototype.hasOwnProperty.call(record.runtimeInfo, "model")
            ? { model: record.runtimeInfo.model ?? null }
            : {}),
          ...(Object.prototype.hasOwnProperty.call(record.runtimeInfo, "thinkingOptionId")
            ? { thinkingOptionId: record.runtimeInfo.thinkingOptionId ?? null }
            : {}),
          ...(Object.prototype.hasOwnProperty.call(record.runtimeInfo, "modeId")
            ? { modeId: record.runtimeInfo.modeId ?? null }
            : {}),
          ...(record.runtimeInfo.extra ? { extra: record.runtimeInfo.extra } : {}),
        }
      : undefined;
    return {
      id: record.id,
      provider,
      cwd: record.cwd,
      model: record.config?.model ?? null,
      thinkingOptionId: record.config?.thinkingOptionId ?? null,
      effectiveThinkingOptionId: resolveEffectiveThinkingOptionId({
        runtimeInfo,
        configuredThinkingOptionId: record.config?.thinkingOptionId ?? null,
      }),
      ...(runtimeInfo ? { runtimeInfo } : {}),
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
      lastUserMessageAt: lastUserMessageAt ? lastUserMessageAt.toISOString() : null,
      status: record.lastStatus,
      capabilities: defaultCapabilities,
      currentModeId: record.lastModeId ?? null,
      availableModes: [],
      pendingPermissions: [],
      persistence: toAgentPersistenceHandle(
        this.sessionLogger,
        this.providerRegistry,
        record.persistence,
      ),
      lastUsage: undefined,
      lastError: undefined,
      title: record.title ?? record.config?.title ?? null,
      requiresAttention: record.requiresAttention ?? false,
      attentionReason: record.attentionReason ?? null,
      attentionTimestamp: record.attentionTimestamp ?? null,
      archivedAt: record.archivedAt ?? null,
      labels: record.labels,
    };
  }

  private resolveStoredAgentPayloadUpdatedAt(record: StoredAgentRecord): string {
    const timestamps = [record.updatedAt, record.lastActivityAt]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .map((value) => ({
        raw: value,
        parsed: Date.parse(value),
      }))
      .filter((value) => !Number.isNaN(value.parsed));

    if (timestamps.length === 0) {
      return record.updatedAt;
    }

    timestamps.sort((a, b) => b.parsed - a.parsed);
    return timestamps[0].raw;
  }

  private async ensureAgentLoaded(agentId: string): Promise<ManagedAgent> {
    const existing = this.agentManager.getAgent(agentId);
    if (existing) {
      return existing;
    }

    const inflight = pendingAgentInitializations.get(agentId);
    if (inflight) {
      return inflight;
    }

    const initPromise = (async () => {
      const record = await this.agentStorage.get(agentId);
      if (!record) {
        throw new Error(`Agent not found: ${agentId}`);
      }

      const handle = toAgentPersistenceHandle(
        this.sessionLogger,
        this.providerRegistry,
        record.persistence,
      );
      let snapshot: ManagedAgent;
      if (handle) {
        snapshot = await this.agentManager.resumeAgentFromPersistence(
          handle,
          buildConfigOverrides(record),
          agentId,
          extractTimestamps(record),
        );
        this.sessionLogger.info(
          { agentId, provider: record.provider },
          "Agent resumed from persistence",
        );
      } else {
        const config = buildSessionConfig(record, {
          validProviders: Object.keys(this.providerRegistry),
          logger: this.sessionLogger,
        });
        if (!config) {
          throw new Error(`Agent ${agentId} references unavailable provider '${record.provider}'`);
        }
        snapshot = await this.agentManager.createAgent(config, agentId, { labels: record.labels });
        this.sessionLogger.info(
          { agentId, provider: record.provider },
          "Agent created from stored config",
        );
      }

      await this.agentManager.hydrateTimelineFromProvider(agentId);
      return this.agentManager.getAgent(agentId) ?? snapshot;
    })();

    pendingAgentInitializations.set(agentId, initPromise);

    try {
      return await initPromise;
    } finally {
      const current = pendingAgentInitializations.get(agentId);
      if (current === initPromise) {
        pendingAgentInitializations.delete(agentId);
      }
    }
  }

  // TODO: Remove once all app store clients are on >=0.1.45.
  private isProviderVisibleToClient(provider: string): boolean {
    if (clientSupportsAllProviders(this.appVersion)) return true;
    return LEGACY_PROVIDER_IDS.has(provider);
  }

  private filterEditorsForClient(
    editors: EditorTargetDescriptorPayload[],
  ): EditorTargetDescriptorPayload[] {
    if (clientSupportsFlexibleEditorIds(this.appVersion)) {
      return editors;
    }
    return editors.filter((editor) => isLegacyEditorTargetId(editor.id));
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

    if (filter?.thinkingOptionId !== undefined) {
      const expectedThinkingOptionId = resolveEffectiveThinkingOptionId({
        configuredThinkingOptionId: filter.thinkingOptionId ?? null,
      });
      const resolvedThinkingOptionId =
        agent.effectiveThinkingOptionId ??
        resolveEffectiveThinkingOptionId({
          runtimeInfo: agent.runtimeInfo,
          configuredThinkingOptionId: agent.thinkingOptionId ?? null,
        });
      if (resolvedThinkingOptionId !== expectedThinkingOptionId) {
        return false;
      }
    }

    if (filter?.statuses && filter.statuses.length > 0) {
      const statuses = new Set(filter.statuses);
      if (!statuses.has(agent.status)) {
        return false;
      }
    }

    if (typeof filter?.requiresAttention === "boolean") {
      const requiresAttention = agent.requiresAttention ?? false;
      if (requiresAttention !== filter.requiresAttention) {
        return false;
      }
    }

    if (filter?.projectKeys && filter.projectKeys.length > 0) {
      const projectKeys = new Set(filter.projectKeys.filter((item) => item.trim().length > 0));
      if (projectKeys.size > 0 && !projectKeys.has(project.projectKey)) {
        return false;
      }
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
    // TODO: Remove once all app store clients are on >=0.1.45.
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

  private async buildProjectPlacement(cwd: string): Promise<ProjectPlacementPayload> {
    return buildProjectPlacementForCwd({
      cwd,
      hubcodeHome: this.hubcodeHome,
    });
  }

  private buildPersistedProjectRecord(input: {
    workspaceId: string;
    placement: ProjectPlacementPayload;
    createdAt: string;
    updatedAt: string;
  }): PersistedProjectRecord {
    return createPersistedProjectRecord({
      projectId: input.placement.projectKey,
      rootPath: deriveProjectRootPath({
        cwd: input.workspaceId,
        checkout: input.placement.checkout,
      }),
      kind: deriveProjectKind(input.placement.checkout),
      displayName: input.placement.projectName,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      archivedAt: null,
    });
  }

  private buildPersistedWorkspaceRecord(input: {
    workspaceId: string;
    placement: ProjectPlacementPayload;
    createdAt: string;
    updatedAt: string;
    workspaceDisplayName?: string;
    issueContext?: PersistedWorkspaceRecord["issueContext"];
    issueMetadata?: PersistedWorkspaceRecord["issueMetadata"];
    prompt?: string;
    autoApprove?: boolean;
    kanbanStatus?: PersistedWorkspaceRecord["kanbanStatus"];
    agentProvider?: string;
    agentMode?: PersistedWorkspaceRecord["agentMode"];
    orgId?: string;
  }): PersistedWorkspaceRecord {
    return createPersistedWorkspaceRecord({
      workspaceId: input.workspaceId,
      projectId: input.placement.projectKey,
      cwd: input.workspaceId,
      kind: deriveWorkspaceKind(input.placement.checkout),
      displayName:
        input.workspaceDisplayName ??
        deriveWorkspaceDisplayName({
          cwd: input.workspaceId,
          checkout: input.placement.checkout,
        }),
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      archivedAt: null,
      issueContext: input.issueContext,
      issueMetadata: input.issueMetadata,
      prompt: input.prompt,
      autoApprove: input.autoApprove,
      kanbanStatus: input.kanbanStatus,
      agentProvider: input.agentProvider,
      agentMode: input.agentMode,
      orgId: input.orgId,
    });
  }

  private async archiveProjectRecordIfEmpty(projectId: string, archivedAt: string): Promise<void> {
    const siblingWorkspaces = (await this.workspaceRegistry.list()).filter(
      (workspace) => workspace.projectId === projectId && !workspace.archivedAt,
    );
    if (siblingWorkspaces.length === 0) {
      await this.projectRegistry.archive(projectId, archivedAt);
    }
  }

  private async reconcileWorkspaceRecord(
    workspaceId: string,
    options?: { orgId?: string },
  ): Promise<{
    workspace: PersistedWorkspaceRecord;
    changed: boolean;
    removedWorkspaceId: string | null;
  }> {
    const normalizedCwd = normalizePersistedWorkspaceId(workspaceId);
    const placement = await this.buildProjectPlacement(normalizedCwd);
    const resolvedWorkspaceId = deriveWorkspaceId(normalizedCwd, placement.checkout);
    const staleWorkspace =
      resolvedWorkspaceId === normalizedCwd
        ? null
        : await this.workspaceRegistry.get(normalizedCwd);
    const existing = (await this.workspaceRegistry.get(resolvedWorkspaceId)) ?? staleWorkspace;
    await this.syncWorkspaceGitWatchTarget(resolvedWorkspaceId, {
      isGit: placement.checkout.isGit,
    });
    const now = new Date().toISOString();
    const nextProjectCreatedAt = existing?.createdAt ?? now;
    const nextWorkspaceCreatedAt = existing?.createdAt ?? now;
    const currentProjectRecord = await this.projectRegistry.get(placement.projectKey);
    const nextProjectRecord = this.buildPersistedProjectRecord({
      workspaceId: resolvedWorkspaceId,
      placement,
      createdAt: currentProjectRecord?.createdAt ?? nextProjectCreatedAt,
      updatedAt: now,
    });
    const nextWorkspaceRecord = this.buildPersistedWorkspaceRecord({
      workspaceId: resolvedWorkspaceId,
      placement,
      createdAt: nextWorkspaceCreatedAt,
      updatedAt: now,
      workspaceDisplayName:
        existing?.kind === "worktree" && deriveWorkspaceKind(placement.checkout) === "worktree"
          ? existing.displayName
          : undefined,
      // Preserve issue/kanban data from the existing record
      issueContext: existing?.issueContext,
      issueMetadata: existing?.issueMetadata,
      prompt: existing?.prompt,
      autoApprove: existing?.autoApprove,
      kanbanStatus: existing?.kanbanStatus,
      agentProvider: existing?.agentProvider,
      agentMode: existing?.agentMode,
      orgId: existing?.orgId ?? options?.orgId,
    });

    const needsWorkspaceUpdate =
      !existing ||
      existing.archivedAt ||
      existing.projectId !== nextWorkspaceRecord.projectId ||
      existing.kind !== nextWorkspaceRecord.kind ||
      existing.displayName !== nextWorkspaceRecord.displayName;

    const needsProjectUpdate =
      !currentProjectRecord ||
      currentProjectRecord.archivedAt ||
      currentProjectRecord.rootPath !== nextProjectRecord.rootPath ||
      currentProjectRecord.kind !== nextProjectRecord.kind ||
      currentProjectRecord.displayName !== nextProjectRecord.displayName;
    const needsStaleWorkspaceCleanup =
      !!staleWorkspace &&
      !staleWorkspace.archivedAt &&
      staleWorkspace.workspaceId !== resolvedWorkspaceId;

    let removedWorkspaceId: string | null = null;
    if (needsStaleWorkspaceCleanup) {
      await this.workspaceRegistry.archive(staleWorkspace.workspaceId, now);
      this.removeWorkspaceGitSubscription(staleWorkspace.workspaceId);
      removedWorkspaceId = staleWorkspace.workspaceId;
    }

    if (!needsWorkspaceUpdate && !needsProjectUpdate && !needsStaleWorkspaceCleanup) {
      return {
        workspace: existing!,
        changed: false,
        removedWorkspaceId: null,
      };
    }

    await this.projectRegistry.upsert(nextProjectRecord);
    await this.workspaceRegistry.upsert(nextWorkspaceRecord);
    if (existing && existing.workspaceId !== resolvedWorkspaceId) {
      await this.workspaceRegistry.archive(existing.workspaceId, now);
      this.removeWorkspaceGitSubscription(existing.workspaceId);
      removedWorkspaceId ??= existing.workspaceId;
    }

    if (existing && !existing.archivedAt && existing.projectId !== nextWorkspaceRecord.projectId) {
      await this.archiveProjectRecordIfEmpty(existing.projectId, now);
    }

    return {
      workspace: nextWorkspaceRecord,
      changed: true,
      removedWorkspaceId,
    };
  }

  private async reconcileActiveWorkspaceRecords(): Promise<Set<string>> {
    const changedWorkspaceIds = new Set<string>();
    const activeWorkspaces = (await this.workspaceRegistry.list()).filter(
      (workspace) => !workspace.archivedAt,
    );
    const staleWorkspaceIds = await detectStaleWorkspaces({
      activeWorkspaces,
      checkDirectoryExists: async (cwd) => {
        try {
          await stat(cwd);
          return true;
        } catch {
          return false;
        }
      },
    });

    for (const workspaceId of staleWorkspaceIds) {
      await this.archiveWorkspaceRecord(workspaceId);
      changedWorkspaceIds.add(workspaceId);
    }

    for (const workspace of activeWorkspaces) {
      if (staleWorkspaceIds.has(workspace.workspaceId)) {
        continue;
      }

      const result = await this.reconcileWorkspaceRecord(workspace.workspaceId);
      if (result.changed) {
        changedWorkspaceIds.add(result.workspace.workspaceId);
        if (result.removedWorkspaceId) {
          changedWorkspaceIds.add(result.removedWorkspaceId);
        }
      }
    }

    return changedWorkspaceIds;
  }

  private async forwardAgentUpdate(agent: ManagedAgent): Promise<void> {
    try {
      await this.ensureWorkspaceRegistered(agent.cwd);
      const subscription = this.agentUpdatesSubscription;
      const payload = await this.buildAgentPayload(agent);
      if (subscription) {
        const project = await this.buildProjectPlacement(payload.cwd);
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

      await this.emitWorkspaceUpdateForCwd(payload.cwd);
    } catch (error) {
      this.sessionLogger.error({ err: error }, "Failed to emit agent update");
    }
  }

  /**
   * Main entry point for processing session messages
   */
  public async handleMessage(rawMsg: SessionInboundMessage): Promise<void> {
    this.inflightRequests++;
    if (this.inflightRequests > this.peakInflightRequests) {
      this.peakInflightRequests = this.inflightRequests;
    }
    try {
      this.sessionLogger.trace(
        { messageType: rawMsg.type, payloadBytes: JSON.stringify(rawMsg).length },
        "inbound message",
      );
      // Cast to any to avoid TypeScript narrowing through the full 116-member union
      // on every case. Each handler retains its own typed signature.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg = rawMsg as any;
      // Share-scoped sessions go through a centralized guard that rejects
      // out-of-scope or disallowed operations before they reach the handler.
      if (this.enforceShareScopeOnMessage(msg)) {
        return;
      }
      try {
        switch (msg.type) {
          case "voice_audio_chunk":
            await this.handleAudioChunk(msg);
            break;

          case "abort_request":
            await this.handleAbort();
            break;

          case "audio_played":
            this.handleAudioPlayed(msg.id);
            break;

          case "fetch_agents_request":
            await this.handleFetchAgents(msg);
            break;

          case "fetch_workspaces_request":
            await this.handleFetchWorkspacesRequest(msg);
            break;

          case "fetch_agent_request":
            await this.handleFetchAgent(msg.agentId, msg.requestId);
            break;

          case "delete_agent_request":
            await this.handleDeleteAgentRequest(msg.agentId, msg.requestId);
            break;

          case "archive_agent_request":
            await this.handleArchiveAgentRequest(msg.agentId, msg.requestId);
            break;

          case "close_items_request":
            await this.handleCloseItemsRequest(msg);
            break;

          case "update_agent_request":
            await this.handleUpdateAgentRequest(msg.agentId, msg.name, msg.labels, msg.requestId);
            break;

          case "set_voice_mode":
            await this.handleSetVoiceMode(msg.enabled, msg.agentId, msg.requestId);
            break;

          case "send_agent_message_request":
            await this.handleSendAgentMessageRequest(msg);
            break;

          case "wait_for_finish_request":
            await this.handleWaitForFinish(msg.agentId, msg.requestId, msg.timeoutMs);
            break;

          case "get_daemon_config_request":
            this.emit({
              type: "get_daemon_config_response",
              payload: {
                requestId: msg.requestId,
                config: this.daemonConfigStore.get(),
              },
            });
            break;

          case "set_daemon_config_request":
            this.emit({
              type: "set_daemon_config_response",
              payload: {
                requestId: msg.requestId,
                config: this.daemonConfigStore.patch(msg.config),
              },
            });
            break;

          case "dictation_stream_start":
            {
              const unavailable = this.resolveVoiceFeatureUnavailableContext("dictation");
              if (unavailable) {
                this.emit({
                  type: "dictation_stream_error",
                  payload: {
                    dictationId: msg.dictationId,
                    error: unavailable.message,
                    retryable: unavailable.retryable,
                    reasonCode: unavailable.reasonCode,
                    missingModelIds: unavailable.missingModelIds,
                  },
                });
                break;
              }
            }
            await this.dictationStreamManager.handleStart(msg.dictationId, msg.format);
            break;

          case "dictation_stream_chunk":
            await this.dictationStreamManager.handleChunk({
              dictationId: msg.dictationId,
              seq: msg.seq,
              audioBase64: msg.audio,
              format: msg.format,
            });
            break;

          case "dictation_stream_finish":
            await this.dictationStreamManager.handleFinish(msg.dictationId, msg.finalSeq);
            break;

          case "dictation_stream_cancel":
            this.dictationStreamManager.handleCancel(msg.dictationId);
            break;

          case "create_agent_request":
            await this.handleCreateAgentRequest(msg);
            break;

          case "resume_agent_request":
            await this.handleResumeAgentRequest(msg);
            break;

          case "refresh_agent_request":
            await this.handleRefreshAgentRequest(msg);
            break;

          case "cancel_agent_request":
            await this.handleCancelAgentRequest(msg.agentId);
            break;

          case "restart_server_request":
            await this.handleRestartServerRequest(msg.requestId, msg.reason);
            break;

          case "shutdown_server_request":
            await this.handleShutdownServerRequest(msg.requestId);
            break;

          case "fetch_agent_timeline_request":
            await this.handleFetchAgentTimelineRequest(msg);
            break;

          case "set_agent_mode_request":
            await this.handleSetAgentModeRequest(msg.agentId, msg.modeId, msg.requestId);
            break;

          case "set_agent_model_request":
            await this.handleSetAgentModelRequest(msg.agentId, msg.modelId, msg.requestId);
            break;

          case "set_agent_feature_request":
            await this.handleSetAgentFeatureRequest(
              msg.agentId,
              msg.featureId,
              msg.value,
              msg.requestId,
            );
            break;

          case "set_agent_thinking_request":
            await this.handleSetAgentThinkingRequest(
              msg.agentId,
              msg.thinkingOptionId,
              msg.requestId,
            );
            break;

          case "agent_permission_response":
            await this.handleAgentPermissionResponse(msg.agentId, msg.requestId, msg.response);
            break;

          case "checkout_status_request":
            await this.handleCheckoutStatusRequest(msg);
            break;

          case "validate_branch_request":
            await this.handleValidateBranchRequest(msg);
            break;

          case "branch_suggestions_request":
            await this.handleBranchSuggestionsRequest(msg);
            break;

          case "directory_suggestions_request":
            await this.handleDirectorySuggestionsRequest(msg);
            break;

          case "subscribe_checkout_diff_request":
            await this.handleSubscribeCheckoutDiffRequest(msg);
            break;

          case "unsubscribe_checkout_diff_request":
            this.handleUnsubscribeCheckoutDiffRequest(msg);
            break;

          case "checkout_switch_branch_request":
            await this.handleCheckoutSwitchBranchRequest(msg);
            break;

          case "stash_save_request":
            await this.handleStashSaveRequest(msg);
            break;

          case "stash_pop_request":
            await this.handleStashPopRequest(msg);
            break;

          case "stash_list_request":
            await this.handleStashListRequest(msg);
            break;

          case "checkout_commit_request":
            await this.handleCheckoutCommitRequest(msg);
            break;

          case "checkout_merge_request":
            await this.handleCheckoutMergeRequest(msg);
            break;

          case "checkout_merge_from_base_request":
            await this.handleCheckoutMergeFromBaseRequest(msg);
            break;

          case "checkout_pull_request":
            await this.handleCheckoutPullRequest(msg);
            break;

          case "checkout_push_request":
            await this.handleCheckoutPushRequest(msg);
            break;

          case "checkout_pr_create_request":
            await this.handleCheckoutPrCreateRequest(msg);
            break;

          case "checkout_pr_status_request":
            await this.handleCheckoutPrStatusRequest(msg);
            break;

          case "hubcode_worktree_list_request":
            await this.handleHubcodeWorktreeListRequest(msg);
            break;

          case "hubcode_worktree_archive_request":
            await this.handleHubcodeWorktreeArchiveRequest(msg);
            break;

          case "create_hubcode_worktree_request":
            await this.handleCreateHubcodeWorktreeRequest(msg);
            break;

          case "list_available_editors_request":
            await this.handleListAvailableEditorsRequest(msg);
            break;

          case "open_in_editor_request":
            await this.handleOpenInEditorRequest(msg);
            break;

          case "open_project_request":
            await this.handleOpenProjectRequest(msg);
            break;

          case "clone_repository_request":
            await this.handleCloneRepositoryRequest(msg);
            break;

          case "archive_workspace_request":
            await this.handleArchiveWorkspaceRequest(msg);
            break;

          case "file_explorer_request":
            await this.handleFileExplorerRequest(msg);
            break;

          case "file_write_request":
            await this.handleFileWriteRequest(msg);
            break;

          case "file_rename_request":
            await this.handleFileRenameRequest(msg);
            break;

          case "file_delete_request":
            await this.handleFileDeleteRequest(msg);
            break;

          case "project_icon_request":
            await this.handleProjectIconRequest(msg);
            break;

          case "file_download_token_request":
            await this.handleFileDownloadTokenRequest(msg);
            break;

          case "list_provider_models_request":
            await this.handleListProviderModelsRequest(msg);
            break;

          case "list_provider_modes_request":
            await this.handleListProviderModesRequest(msg);
            break;

          case "list_provider_features_request":
            await this.handleListProviderFeaturesRequest(msg);
            break;

          case "list_available_providers_request":
            await this.handleListAvailableProvidersRequest(msg);
            break;

          case "get_providers_snapshot_request":
            await this.handleGetProvidersSnapshotRequest(msg);
            break;

          case "refresh_providers_snapshot_request":
            await this.handleRefreshProvidersSnapshotRequest(msg);
            break;

          case "provider_diagnostic_request":
            await this.handleProviderDiagnosticRequest(msg);
            break;

          case "clear_agent_attention":
            await this.handleClearAgentAttention(msg.agentId);
            break;

          case "client_heartbeat":
            this.handleClientHeartbeat(msg);
            break;

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
            break;
          }

          case "list_commands_request":
            await this.handleListCommandsRequest(msg);
            break;

          case "register_push_token":
            this.handleRegisterPushToken(msg.token);
            break;

          case "subscribe_terminals_request":
            this.handleSubscribeTerminalsRequest(msg);
            break;

          case "unsubscribe_terminals_request":
            this.handleUnsubscribeTerminalsRequest(msg);
            break;

          case "list_terminals_request":
            await this.handleListTerminalsRequest(msg);
            break;

          case "create_terminal_request":
            await this.handleCreateTerminalRequest(msg);
            break;

          case "subscribe_terminal_request":
            await this.handleSubscribeTerminalRequest(msg);
            break;

          case "unsubscribe_terminal_request":
            this.handleUnsubscribeTerminalRequest(msg);
            break;

          case "terminal_input":
            this.handleTerminalInput(msg);
            break;

          case "kill_terminal_request":
            await this.handleKillTerminalRequest(msg);
            break;

          case "capture_terminal_request":
            await this.handleCaptureTerminalRequest(msg);
            break;

          // Browser
          case "browser_launch_request":
            await this.handleBrowserLaunchRequest(msg);
            break;
          case "browser_state_request":
            await this.handleBrowserStateRequest(msg);
            break;
          case "browser_screenshot_request":
            await this.handleBrowserScreenshotRequest(msg);
            break;
          case "browser_navigate_request":
            await this.handleBrowserNavigateRequest(msg);
            break;
          case "browser_go_back_request":
            await this.handleBrowserGoBackRequest(msg);
            break;
          case "browser_go_forward_request":
            await this.handleBrowserGoForwardRequest(msg);
            break;
          case "browser_close_request":
            await this.handleBrowserCloseRequest(msg);
            break;
          case "browser_resize_request":
            await this.handleBrowserResizeRequest(msg);
            break;

          case "chat/create":
            await this.handleChatCreateRequest(msg);
            break;

          case "chat/list":
            await this.handleChatListRequest(msg);
            break;

          case "chat/inspect":
            await this.handleChatInspectRequest(msg);
            break;

          case "chat/delete":
            await this.handleChatDeleteRequest(msg);
            break;

          case "chat/post":
            await this.handleChatPostRequest(msg);
            break;

          case "chat/read":
            await this.handleChatReadRequest(msg);
            break;

          case "chat/wait":
            await this.handleChatWaitRequest(msg);
            break;

          case "schedule/create":
            await this.handleScheduleCreateRequest(msg);
            break;

          case "schedule/list":
            await this.handleScheduleListRequest(msg);
            break;

          case "schedule/inspect":
            await this.handleScheduleInspectRequest(msg);
            break;

          case "schedule/logs":
            await this.handleScheduleLogsRequest(msg);
            break;

          case "schedule/pause":
            await this.handleSchedulePauseRequest(msg);
            break;

          case "schedule/resume":
            await this.handleScheduleResumeRequest(msg);
            break;

          case "schedule/delete":
            await this.handleScheduleDeleteRequest(msg);
            break;

          case "loop/run":
            await this.handleLoopRunRequest(msg);
            break;

          case "loop/list":
            await this.handleLoopListRequest(msg);
            break;

          case "loop/inspect":
            await this.handleLoopInspectRequest(msg);
            break;

          case "loop/logs":
            await this.handleLoopLogsRequest(msg);
            break;

          case "loop/stop":
            await this.handleLoopStopRequest(msg);
            break;

          // Code indexing RPC
          case "indexing/list":
            await this.handleIndexingListRequest(msg);
            break;
          case "indexing/get":
            await this.handleIndexingGetRequest(msg);
            break;
          case "indexing/set-enabled":
            await this.handleIndexingSetEnabledRequest(msg);
            break;
          case "indexing/set-expose-to":
            await this.handleIndexingSetExposeToRequest(msg);
            break;
          case "indexing/set-embedding-provider":
            await this.handleIndexingSetEmbeddingProviderRequest(msg);
            break;
          case "indexing/set-watchlist":
            await this.handleIndexingSetWatchlistRequest(msg);
            break;
          case "indexing/detect":
            await this.handleIndexingDetectRequest(msg);
            break;
          case "indexing/install":
            await this.handleIndexingInstallRequest(msg);
            break;
          case "indexing/tools/list":
            await this.handleIndexingToolsListRequest(msg);
            break;
          case "indexing/reindex":
            await this.handleIndexingReindexRequest(msg);
            break;
          case "indexing/cancel-reindex":
            await this.handleIndexingCancelReindexRequest(msg);
            break;
          case "indexing/restart-subprocess":
            await this.handleIndexingRestartSubprocessRequest(msg);
            break;
          case "indexing/stderr-tail":
            await this.handleIndexingStderrTailRequest(msg);
            break;

          // Integration RPC
          case "integration_list_status_request":
            await this.handleIntegrationListStatus(msg);
            break;
          case "integration_connect_request":
            await this.handleIntegrationConnect(msg);
            break;
          case "integration_disconnect_request":
            await this.handleIntegrationDisconnect(msg);
            break;
          case "integration_search_request":
            await this.handleIntegrationSearch(msg);
            break;
          case "integration_fetch_items_request":
            await this.handleIntegrationFetchItems(msg);
            break;

          // CLI Agent Detection RPC
          case "cli_agent_list_request":
            await this.handleCliAgentListRequest(msg);
            break;

          // Workspace metadata update
          case "update_workspace_metadata_request":
            await this.handleUpdateWorkspaceMetadata(msg);
            break;

          // Client browser command result
          case "browser_command_result":
            this.handleBrowserCommandResult(msg);
            break;

          // Screencast streaming for shared-session visitors (no native
          // WebContentsView). Start/stop CDP screencast on demand.
          case "browser_subscribe_frames":
            void this.clientBrowserManager
              .startScreencast(msg.payload.browserId, { url: msg.payload.url })
              .catch((err: unknown) => {
                this.sessionLogger.warn(
                  { err, browserId: msg.payload.browserId },
                  "browser_subscribe_frames failed",
                );
              });
            break;
          case "browser_unsubscribe_frames":
            void this.clientBrowserManager.stopScreencast(msg.payload.browserId).catch(() => {});
            break;
          case "browser_input":
            void this.clientBrowserManager.dispatchInput(msg.payload).catch((err: unknown) => {
              this.sessionLogger.debug(
                { err, kind: msg.payload.kind, browserId: msg.payload.browserId },
                "browser_input dispatch failed",
              );
            });
            break;

          // Library sync (PR7) — apply user's activated MCP/Skill entries to
          // the local CLI configs (~/.claude.json, ~/.codex/config.toml,
          // ~/.config/opencode/opencode.json, ~/.agentskills/).
          case "library_sync_request":
            await this.handleLibrarySyncRequest(msg);
            break;
          case "library_agents_request":
            await this.handleLibraryAgentsRequest(msg);
            break;
          case "file_search_request":
            await this.handleFileSearchRequest(msg);
            break;
        }
      } catch (error: any) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.sessionLogger.error({ err }, "Error handling message");

        const requestId = (msg as { requestId?: unknown }).requestId;
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

  public resetPeakInflight(): void {
    this.peakInflightRequests = this.inflightRequests;
  }

  public handleBinaryFrame(frame: TerminalStreamFrame): void {
    const activeStream = this.activeTerminalStreams.get(frame.slot);
    if (!activeStream || !this.terminalManager) {
      return;
    }
    const terminal = this.terminalManager.getTerminal(activeStream.terminalId);
    if (!terminal) {
      this.detachTerminalStream(activeStream.terminalId, { emitExit: true });
      return;
    }

    switch (frame.opcode) {
      case TerminalStreamOpcode.Input: {
        if (frame.payload.byteLength === 0) {
          return;
        }
        const text = Buffer.from(frame.payload).toString("utf8");
        if (!text) {
          return;
        }
        terminal.send({ type: "input", data: text });
        return;
      }

      case TerminalStreamOpcode.Resize: {
        const resize = decodeTerminalResizePayload(frame.payload);
        if (!resize) {
          return;
        }
        terminal.send({ type: "resize", rows: resize.rows, cols: resize.cols });
        return;
      }

      default:
        return;
    }
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

    const knownCwd =
      this.agentManager.getAgent(agentId)?.cwd ??
      (await this.agentStorage.get(agentId))?.cwd ??
      null;

    // Prevent the persistence hook from re-creating the record while we close/delete.
    this.agentStorage.beginDelete(agentId);

    try {
      await this.agentManager.closeAgent(agentId);
    } catch (error: any) {
      this.sessionLogger.warn(
        { err: error, agentId },
        `Failed to close agent ${agentId} during delete`,
      );
    }

    try {
      await this.agentStorage.remove(agentId);
    } catch (error: any) {
      this.sessionLogger.error(
        { err: error, agentId },
        `Failed to remove agent ${agentId} from registry`,
      );
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

    if (knownCwd) {
      await this.emitWorkspaceUpdateForCwd(knownCwd);
    }
  }

  private async handleArchiveAgentRequest(agentId: string, requestId: string): Promise<void> {
    const result = await this.archiveAgentForClose(agentId);
    this.emit({
      type: "agent_archived",
      payload: {
        agentId: result.agentId,
        archivedAt: result.archivedAt,
        requestId,
      },
    });
  }

  private async archiveStoredAgentForClose(
    agentId: string,
  ): Promise<{ agentId: string; archivedAt: string }> {
    const existing = await this.agentStorage.get(agentId);
    if (!existing) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    if (existing.archivedAt) {
      return {
        agentId,
        archivedAt: existing.archivedAt,
      };
    }

    const archivedAt = new Date().toISOString();
    const normalizedStatus =
      existing.lastStatus === "running" || existing.lastStatus === "initializing"
        ? "idle"
        : existing.lastStatus;

    await this.agentStorage.upsert({
      ...existing,
      archivedAt,
      updatedAt: archivedAt,
      lastStatus: normalizedStatus,
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: null,
    });

    return { agentId, archivedAt };
  }

  private async archiveAgentForClose(
    agentId: string,
  ): Promise<{ agentId: string; archivedAt: string }> {
    this.sessionLogger.info({ agentId }, `Archiving agent ${agentId}`);

    const liveAgent = this.agentManager.getAgent(agentId);
    if (liveAgent) {
      await this.interruptAgentIfRunning(agentId);
      await this.agentManager.clearAgentAttention(agentId).catch(() => undefined);
      await this.agentManager.archiveAgent(agentId);
    } else {
      await this.archiveStoredAgentForClose(agentId);
    }
    const archivedRecord = await this.agentStorage.get(agentId);
    if (!archivedRecord) {
      throw new Error(`Agent not found in storage after archive: ${agentId}`);
    }

    if (this.agentUpdatesSubscription) {
      const payload = this.buildStoredAgentPayload(archivedRecord);
      const project = await this.buildProjectPlacement(payload.cwd);
      const matches = this.matchesAgentFilter({
        agent: payload,
        project,
        filter: this.agentUpdatesSubscription.filter,
      });
      this.bufferOrEmitAgentUpdate(
        this.agentUpdatesSubscription,
        matches
          ? {
              kind: "upsert",
              agent: payload,
              project,
            }
          : {
              kind: "remove",
              agentId,
            },
      );
      await this.emitWorkspaceUpdateForCwd(payload.cwd);
    }

    if (!archivedRecord.archivedAt) {
      throw new Error(`Agent missing archivedAt after archive: ${agentId}`);
    }

    return { agentId, archivedAt: archivedRecord.archivedAt };
  }

  private async handleCloseItemsRequest(msg: CloseItemsRequest): Promise<void> {
    const agents = [];
    for (const agentId of msg.agentIds) {
      try {
        agents.push(await this.archiveAgentForClose(agentId));
      } catch (error: any) {
        this.sessionLogger.warn(
          { err: error, agentId, requestId: msg.requestId },
          "Failed to archive agent during close_items batch",
        );
      }
    }

    const terminals = [];
    for (const terminalId of msg.terminalIds) {
      try {
        terminals.push(this.killTerminalForClose(terminalId));
      } catch (error: any) {
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

  private async unarchiveAgentState(agentId: string): Promise<boolean> {
    const record = await this.agentStorage.get(agentId);
    if (!record || !record.archivedAt) {
      return false;
    }
    const updatedAt = new Date().toISOString();
    await this.agentStorage.upsert({
      ...record,
      archivedAt: null,
      updatedAt,
    });
    this.agentManager.notifyAgentState(agentId);
    return true;
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
    await this.unarchiveAgentState(matched.id);
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

    const normalizedName = name?.trim();
    const normalizedLabels = labels && Object.keys(labels).length > 0 ? labels : undefined;

    if (!normalizedName && !normalizedLabels) {
      this.emit({
        type: "update_agent_response",
        payload: {
          requestId,
          agentId,
          accepted: false,
          error: "Nothing to update (provide name and/or labels)",
        },
      });
      return;
    }

    try {
      const liveAgent = this.agentManager.getAgent(agentId);
      if (liveAgent) {
        if (normalizedName) {
          await this.agentManager.setTitle(agentId, normalizedName);
        }
        if (normalizedLabels) {
          await this.agentManager.setLabels(agentId, normalizedLabels);
        }
      } else {
        const existing = await this.agentStorage.get(agentId);
        if (!existing) {
          throw new Error(`Agent not found: ${agentId}`);
        }

        await this.agentStorage.upsert({
          ...existing,
          ...(normalizedName ? { title: normalizedName } : {}),
          ...(normalizedLabels ? { labels: { ...existing.labels, ...normalizedLabels } } : {}),
        });
      }

      this.emit({
        type: "update_agent_response",
        payload: { requestId, agentId, accepted: true, error: null },
      });
    } catch (error: any) {
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
          content: `Failed to update agent: ${error.message}`,
        },
      });
      this.emit({
        type: "update_agent_response",
        payload: {
          requestId,
          agentId,
          accepted: false,
          error: error?.message ? String(error.message) : "Failed to update agent",
        },
      });
    }
  }

  private toVoiceFeatureUnavailableContext(
    state: SpeechReadinessState,
  ): VoiceFeatureUnavailableContext {
    return {
      reasonCode: state.reasonCode,
      message: state.message,
      retryable: state.retryable,
      missingModelIds: [...state.missingModelIds],
    };
  }

  private resolveModeReadinessState(
    readiness: SpeechReadinessSnapshot,
    mode: "voice_mode" | "dictation",
  ): SpeechReadinessState {
    if (mode === "voice_mode") {
      return readiness.realtimeVoice;
    }
    return readiness.dictation;
  }

  private getVoiceFeatureUnavailableResponseMetadata(
    error: unknown,
  ): VoiceFeatureUnavailableResponseMetadata {
    if (!(error instanceof VoiceFeatureUnavailableError)) {
      return {};
    }
    return {
      reasonCode: error.reasonCode,
      retryable: error.retryable,
      missingModelIds: error.missingModelIds,
    };
  }

  private resolveVoiceFeatureUnavailableContext(
    mode: "voice_mode" | "dictation",
  ): VoiceFeatureUnavailableContext | null {
    const readiness = this.getSpeechReadiness?.();
    if (!readiness) {
      return null;
    }

    const modeReadiness = this.resolveModeReadinessState(readiness, mode);
    if (!modeReadiness.enabled) {
      return this.toVoiceFeatureUnavailableContext(modeReadiness);
    }
    if (!readiness.voiceFeature.available) {
      return this.toVoiceFeatureUnavailableContext(readiness.voiceFeature);
    }
    if (!modeReadiness.available) {
      return this.toVoiceFeatureUnavailableContext(modeReadiness);
    }
    return null;
  }

  /**
   * Handle voice mode toggle
   */
  private async handleSetVoiceMode(
    enabled: boolean,
    agentId?: string,
    requestId?: string,
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      this.sessionLogger.info(
        { enabled, requestedAgentId: agentId ?? null, requestId: requestId ?? null },
        "set_voice_mode started",
      );
      if (enabled) {
        const unavailable = this.resolveVoiceFeatureUnavailableContext("voice_mode");
        if (unavailable) {
          throw new VoiceFeatureUnavailableError(unavailable);
        }

        const normalizedAgentId = this.parseVoiceTargetAgentId(agentId ?? "", "set_voice_mode");

        if (
          this.isVoiceMode &&
          this.voiceModeAgentId &&
          this.voiceModeAgentId !== normalizedAgentId
        ) {
          this.sessionLogger.info(
            {
              previousAgentId: this.voiceModeAgentId,
              nextAgentId: normalizedAgentId,
              elapsedMs: Date.now() - startedAt,
            },
            "set_voice_mode disabling previous active voice agent",
          );
          await this.disableVoiceModeForActiveAgent(true);
        }

        if (!this.isVoiceMode || this.voiceModeAgentId !== normalizedAgentId) {
          this.sessionLogger.info(
            { agentId: normalizedAgentId, elapsedMs: Date.now() - startedAt },
            "set_voice_mode enabling voice for agent",
          );
          const refreshedAgentId = await this.enableVoiceModeForAgent(normalizedAgentId);
          this.voiceModeAgentId = refreshedAgentId;
          this.sessionLogger.info(
            { agentId: refreshedAgentId, elapsedMs: Date.now() - startedAt },
            "set_voice_mode agent enable complete",
          );
        }

        this.sessionLogger.info(
          { agentId: this.voiceModeAgentId, elapsedMs: Date.now() - startedAt },
          "set_voice_mode starting voice turn controller",
        );
        await this.startVoiceTurnController();
        this.sessionLogger.info(
          { agentId: this.voiceModeAgentId, elapsedMs: Date.now() - startedAt },
          "set_voice_mode voice turn controller started",
        );
        this.isVoiceMode = true;
        this.sessionLogger.info(
          {
            agentId: this.voiceModeAgentId,
            elapsedMs: Date.now() - startedAt,
          },
          "Voice mode enabled for existing agent",
        );
        if (requestId) {
          this.emit({
            type: "set_voice_mode_response",
            payload: {
              requestId,
              enabled: true,
              agentId: this.voiceModeAgentId,
              accepted: true,
              error: null,
            },
          });
        }
        return;
      }

      this.sessionLogger.info(
        { agentId: this.voiceModeAgentId, elapsedMs: Date.now() - startedAt },
        "set_voice_mode disabling active voice mode",
      );
      await this.disableVoiceModeForActiveAgent(true);
      this.isVoiceMode = false;
      this.sessionLogger.info({ elapsedMs: Date.now() - startedAt }, "Voice mode disabled");
      if (requestId) {
        this.emit({
          type: "set_voice_mode_response",
          payload: {
            requestId,
            enabled: false,
            agentId: null,
            accepted: true,
            error: null,
          },
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Failed to set voice mode";
      const unavailable = this.getVoiceFeatureUnavailableResponseMetadata(error);
      this.sessionLogger.error(
        {
          err: error,
          enabled,
          requestedAgentId: agentId ?? null,
          elapsedMs: Date.now() - startedAt,
        },
        "set_voice_mode failed",
      );
      if (requestId) {
        this.emit({
          type: "set_voice_mode_response",
          payload: {
            requestId,
            enabled: this.isVoiceMode,
            agentId: this.voiceModeAgentId,
            accepted: false,
            error: errorMessage,
            ...unavailable,
          },
        });
        return;
      }
      throw error;
    }
  }

  private parseVoiceTargetAgentId(rawId: string, source: string): string {
    const parsed = AgentIdSchema.safeParse(rawId.trim());
    if (!parsed.success) {
      throw new Error(`${source}: agentId must be a UUID`);
    }
    return parsed.data;
  }

  private async enableVoiceModeForAgent(agentId: string): Promise<string> {
    const startedAt = Date.now();
    this.sessionLogger.info({ agentId }, "enableVoiceModeForAgent.ensureAgentLoaded.start");
    const existing = await this.ensureAgentLoaded(agentId);
    this.sessionLogger.info(
      { agentId, elapsedMs: Date.now() - startedAt },
      "enableVoiceModeForAgent.ensureAgentLoaded.done",
    );

    this.registerVoiceBridgeForAgent(agentId);

    const baseConfig: VoiceModeBaseConfig = {
      systemPrompt: stripVoiceModeSystemPrompt(existing.config.systemPrompt),
    };
    this.voiceModeBaseConfig = baseConfig;
    const refreshOverrides: Partial<AgentSessionConfig> = {
      systemPrompt: buildVoiceModeSystemPrompt(baseConfig.systemPrompt, true),
    };

    try {
      this.sessionLogger.info(
        { agentId, elapsedMs: Date.now() - startedAt },
        "enableVoiceModeForAgent.reloadAgentSession.start",
      );
      const refreshed = await this.agentManager.reloadAgentSession(agentId, refreshOverrides);
      this.sessionLogger.info(
        { agentId, refreshedAgentId: refreshed.id, elapsedMs: Date.now() - startedAt },
        "enableVoiceModeForAgent.reloadAgentSession.done",
      );
      return refreshed.id;
    } catch (error) {
      this.unregisterVoiceSpeakHandler?.(agentId);
      this.unregisterVoiceCallerContext?.(agentId);
      this.voiceModeBaseConfig = null;
      throw error;
    }
  }

  private async disableVoiceModeForActiveAgent(restoreAgentConfig: boolean): Promise<void> {
    await this.stopVoiceTurnController();

    const agentId = this.voiceModeAgentId;
    if (!agentId) {
      this.voiceModeBaseConfig = null;
      return;
    }

    this.unregisterVoiceSpeakHandler?.(agentId);
    this.unregisterVoiceCallerContext?.(agentId);

    if (restoreAgentConfig && this.voiceModeBaseConfig) {
      const baseConfig = this.voiceModeBaseConfig;
      try {
        await this.agentManager.reloadAgentSession(agentId, {
          systemPrompt: buildVoiceModeSystemPrompt(baseConfig.systemPrompt, false),
        });
      } catch (error) {
        this.sessionLogger.warn(
          { err: error, agentId },
          "Failed to restore agent config while disabling voice mode",
        );
      }
    }

    this.voiceModeBaseConfig = null;
    this.voiceModeAgentId = null;
  }

  private handleDictationManagerMessage(msg: DictationStreamOutboundMessage): void {
    this.emit(msg as unknown as SessionOutboundMessage);
  }

  private async startVoiceTurnController(): Promise<void> {
    if (this.voiceTurnController) {
      this.sessionLogger.info("startVoiceTurnController skipped: already running");
      return;
    }

    const turnDetection = this.resolveVoiceTurnDetection();
    if (!turnDetection) {
      throw new Error("Voice turn detection is not configured");
    }

    this.sessionLogger.info(
      { providerId: turnDetection.id },
      "startVoiceTurnController creating controller",
    );

    const controller = createVoiceTurnController({
      logger: this.sessionLogger.child({ component: "voice-turn-controller" }),
      turnDetection,
      utteranceSink: {
        submitUtterance: async ({ pcm16, format, sampleRate, startedAt, endedAt }) => {
          this.sessionLogger.debug(
            {
              audioBytes: pcm16.length,
              sampleRate,
              startedAt,
              endedAt,
              durationMs: Math.max(0, endedAt - startedAt),
            },
            "Submitting detected voice utterance",
          );
          await this.processCompletedAudio(pcm16, format);
        },
      },
      callbacks: {
        onSpeechStarted: async () => {
          this.handleProvisionalVoiceSpeechStarted();
        },
        onSpeechStopped: async () => {
          this.handleVoiceSpeechStopped();
        },
        onError: (error) => {
          this.sessionLogger.error({ err: error }, "Voice turn controller failed");
        },
      },
    });

    this.sessionLogger.info("startVoiceTurnController connecting controller");
    await controller.start();
    this.voiceTurnController = controller;
    this.sessionLogger.info("startVoiceTurnController connected");
  }

  private async stopVoiceTurnController(): Promise<void> {
    if (!this.voiceTurnController) {
      return;
    }

    this.clearPendingVoiceSpeechStart("turn-controller-stop");
    const controller = this.voiceTurnController;
    this.voiceTurnController = null;
    await controller.stop();
  }

  private clearPendingVoiceSpeechStart(reason: string): void {
    if (this.pendingVoiceSpeechTimer) {
      clearTimeout(this.pendingVoiceSpeechTimer);
      this.pendingVoiceSpeechTimer = null;
    }
    if (this.pendingVoiceSpeechStartAt !== null) {
      this.sessionLogger.debug({ reason }, "Clearing provisional voice speech start");
      this.pendingVoiceSpeechStartAt = null;
    }
  }

  private handleProvisionalVoiceSpeechStarted(): void {
    if (this.speechInProgress || this.pendingVoiceSpeechTimer) {
      return;
    }

    const startedAt = Date.now();
    this.pendingVoiceSpeechStartAt = startedAt;
    this.sessionLogger.info(
      { confirmationMs: VOICE_INTERRUPT_CONFIRMATION_MS },
      "Silero VAD provisional speech_started",
    );
    this.pendingVoiceSpeechTimer = setTimeout(() => {
      this.pendingVoiceSpeechTimer = null;
      if (this.pendingVoiceSpeechStartAt !== startedAt || this.speechInProgress) {
        return;
      }

      this.pendingVoiceSpeechStartAt = null;
      this.sessionLogger.info("voice_input_state emitting isSpeaking=true");
      this.emit({
        type: "voice_input_state",
        payload: {
          isSpeaking: true,
        },
      });
      void this.handleVoiceSpeechStart();
    }, VOICE_INTERRUPT_CONFIRMATION_MS);
  }

  private handleVoiceSpeechStopped(): void {
    if (this.pendingVoiceSpeechStartAt !== null) {
      const durationMs = Date.now() - this.pendingVoiceSpeechStartAt;
      this.clearPendingVoiceSpeechStart("speech-stopped-before-confirmation");
      this.sessionLogger.info(
        { durationMs, confirmationMs: VOICE_INTERRUPT_CONFIRMATION_MS },
        "Ignoring provisional voice speech start that ended before confirmation",
      );
      return;
    }

    this.sessionLogger.info("voice_input_state emitting isSpeaking=false");
    this.emit({
      type: "voice_input_state",
      payload: {
        isSpeaking: false,
      },
    });
  }

  /**
   * Handle text message to agent (with optional image attachments)
   */
  private async handleSendAgentMessage(
    agentId: string,
    text: string,
    messageId?: string,
    images?: Array<{ data: string; mimeType: string }>,
    runOptions?: AgentRunOptions,
    options?: { spokenInput?: boolean },
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    this.sessionLogger.info(
      { agentId, textPreview: text.substring(0, 50), imageCount: images?.length ?? 0 },
      `Sending text to agent ${agentId}${images && images.length > 0 ? ` with ${images.length} image attachment(s)` : ""}`,
    );

    await this.unarchiveAgentState(agentId);

    try {
      await this.ensureAgentLoaded(agentId);
    } catch (error) {
      this.handleAgentRunError(agentId, error, "Failed to initialize agent before sending prompt");
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    try {
      this.agentManager.recordUserMessage(agentId, text, {
        messageId,
        emitState: false,
      });
    } catch (error) {
      this.sessionLogger.error(
        { err: error, agentId },
        `Failed to record user message for agent ${agentId}`,
      );
    }

    const promptText = options?.spokenInput ? wrapSpokenInput(text) : text;
    const prompt = this.buildAgentPrompt(promptText, images);

    return this.startAgentStream(agentId, prompt, runOptions);
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
      images,
      labels,
    } = msg;
    this.sessionLogger.info(
      { cwd: config.cwd, provider: config.provider, worktreeName },
      `Creating agent in ${config.cwd} (${config.provider})${
        worktreeName ? ` with worktree ${worktreeName}` : ""
      }`,
    );

    try {
      const trimmedPrompt = initialPrompt?.trim();
      const { explicitTitle, provisionalTitle } = resolveCreateAgentTitles({
        configTitle: config.title,
        initialPrompt: trimmedPrompt,
      });
      const mergedMcpServers = this.libraryStore.mcpServersForProvider(
        config.provider,
        config.mcpServers,
      );
      const mergedSystemPrompt = this.libraryStore.skillsInstructionsForProvider(
        config.provider,
        config.systemPrompt,
      );
      const resolvedConfig: AgentSessionConfig = {
        ...config,
        ...(provisionalTitle ? { title: provisionalTitle } : {}),
        ...(mergedMcpServers ? { mcpServers: mergedMcpServers } : {}),
        ...(mergedSystemPrompt !== config.systemPrompt ? { systemPrompt: mergedSystemPrompt } : {}),
      };

      const { sessionConfig, worktreeConfig } = await this.buildAgentSessionConfig(
        resolvedConfig,
        git,
        worktreeName,
        labels,
      );
      await this.ensureWorkspaceRegistered(sessionConfig.cwd);
      const snapshot = await this.agentManager.createAgent(sessionConfig, undefined, { labels });
      await this.forwardAgentUpdate(snapshot);

      if (trimmedPrompt) {
        scheduleAgentMetadataGeneration({
          agentManager: this.agentManager,
          agentId: snapshot.id,
          cwd: snapshot.cwd,
          initialPrompt: trimmedPrompt,
          explicitTitle,
          hubcodeHome: this.hubcodeHome,
          logger: this.sessionLogger,
        });

        const started = await this.handleSendAgentMessage(
          snapshot.id,
          trimmedPrompt,
          resolveClientMessageId(clientMessageId),
          images,
          outputSchema ? { outputSchema } : undefined,
        );
        if (!started.ok) {
          throw new Error(started.error);
        }
      }

      if (requestId) {
        const agentPayload = await this.getAgentPayloadById(snapshot.id);
        if (!agentPayload) {
          throw new Error(`Agent ${snapshot.id} not found after creation`);
        }
        this.emit({
          type: "status",
          payload: {
            status: "agent_created",
            agentId: snapshot.id,
            requestId,
            agent: agentPayload,
          },
        });
      }

      if (worktreeConfig) {
        void runAsyncWorktreeBootstrap({
          agentId: snapshot.id,
          worktree: worktreeConfig,
          terminalManager: this.terminalManager,
          appendTimelineItem: (item) =>
            appendTimelineItemIfAgentKnown({
              agentManager: this.agentManager,
              agentId: snapshot.id,
              item,
            }),
          emitLiveTimelineItem: (item) =>
            emitLiveTimelineItemIfAgentKnown({
              agentManager: this.agentManager,
              agentId: snapshot.id,
              item,
            }),
          logger: this.sessionLogger,
        });
      }

      this.sessionLogger.info(
        { agentId: snapshot.id, provider: snapshot.provider },
        `Created agent ${snapshot.id} (${snapshot.provider})`,
      );
    } catch (error: any) {
      this.sessionLogger.error({ err: error }, "Failed to create agent");
      if (requestId) {
        this.emit({
          type: "status",
          payload: {
            status: "agent_create_failed",
            requestId,
            error: (error as Error)?.message ?? String(error),
          },
        });
      }
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to create agent: ${error.message}`,
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
      await this.unarchiveAgentState(snapshot.id);
      await this.agentManager.hydrateTimelineFromProvider(snapshot.id);
      await this.forwardAgentUpdate(snapshot);
      const timelineSize = this.agentManager.getTimeline(snapshot.id).length;
      if (requestId) {
        const agentPayload = await this.getAgentPayloadById(snapshot.id);
        if (!agentPayload) {
          throw new Error(`Agent ${snapshot.id} not found after resume`);
        }
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
    } catch (error: any) {
      this.sessionLogger.error({ err: error }, "Failed to resume agent");
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to resume agent: ${error.message}`,
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
      await this.unarchiveAgentState(agentId);
      let snapshot: ManagedAgent;
      const existing = this.agentManager.getAgent(agentId);
      if (existing) {
        await this.interruptAgentIfRunning(agentId);
        snapshot = await this.agentManager.reloadAgentSession(agentId);
      } else {
        const record = await this.agentStorage.get(agentId);
        if (!record) {
          throw new Error(`Agent not found: ${agentId}`);
        }
        const handle = toAgentPersistenceHandle(
          this.sessionLogger,
          this.providerRegistry,
          record.persistence,
        );
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
    } catch (error: any) {
      this.sessionLogger.error({ err: error, agentId }, `Failed to refresh agent ${agentId}`);
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to refresh agent: ${error.message}`,
        },
      });
    }
  }

  private async handleCancelAgentRequest(agentId: string): Promise<void> {
    this.sessionLogger.info({ agentId }, `Cancel request received for agent ${agentId}`);

    try {
      await this.interruptAgentIfRunning(agentId);
    } catch (error) {
      this.handleAgentRunError(agentId, error, "Failed to cancel running agent on request");
    }
  }

  private async buildAgentSessionConfig(
    config: AgentSessionConfig,
    gitOptions?: GitSetupOptions,
    legacyWorktreeName?: string,
    _labels?: Record<string, string>,
  ): Promise<{ sessionConfig: AgentSessionConfig; worktreeConfig?: WorktreeConfig }> {
    return buildWorktreeAgentSessionConfig(
      {
        hubcodeHome: this.hubcodeHome,
        sessionLogger: this.sessionLogger,
        checkoutExistingBranch: (cwd, branch) => this.checkoutExistingBranch(cwd, branch),
        createBranchFromBase: (params) => this.createBranchFromBase(params),
      },
      config,
      gitOptions,
      legacyWorktreeName,
      _labels,
    );
  }

  private async handleListProviderModelsRequest(
    msg: Extract<SessionInboundMessage, { type: "list_provider_models_request" }>,
  ): Promise<void> {
    const fetchedAt = new Date().toISOString();
    try {
      const models = await this.providerRegistry[msg.provider].fetchModels({
        cwd: msg.cwd ? expandTilde(msg.cwd) : undefined,
      });
      this.emit({
        type: "list_provider_models_response",
        payload: {
          provider: msg.provider,
          models,
          error: null,
          fetchedAt,
          requestId: msg.requestId,
        },
      });
    } catch (error) {
      this.sessionLogger.error(
        { err: error, provider: msg.provider },
        `Failed to list models for ${msg.provider}`,
      );
      this.emit({
        type: "list_provider_models_response",
        payload: {
          provider: msg.provider,
          error: (error as Error)?.message ?? String(error),
          fetchedAt,
          requestId: msg.requestId,
        },
      });
    }
  }

  private async handleListProviderModesRequest(
    msg: Extract<SessionInboundMessage, { type: "list_provider_modes_request" }>,
  ): Promise<void> {
    const fetchedAt = new Date().toISOString();
    try {
      const modes = await this.providerRegistry[msg.provider].fetchModes({
        cwd: msg.cwd ? expandTilde(msg.cwd) : undefined,
      });
      this.emit({
        type: "list_provider_modes_response",
        payload: {
          provider: msg.provider,
          modes,
          error: null,
          fetchedAt,
          requestId: msg.requestId,
        },
      });
    } catch (error) {
      this.sessionLogger.error(
        { err: error, provider: msg.provider },
        `Failed to list modes for ${msg.provider}`,
      );
      this.emit({
        type: "list_provider_modes_response",
        payload: {
          provider: msg.provider,
          error: (error as Error)?.message ?? String(error),
          fetchedAt,
          requestId: msg.requestId,
        },
      });
    }
  }

  private buildDraftAgentSessionConfig(draftConfig: {
    provider: AgentProvider;
    cwd: string;
    modeId?: string;
    model?: string;
    thinkingOptionId?: string;
    featureValues?: Record<string, unknown>;
  }): AgentSessionConfig {
    return {
      provider: draftConfig.provider,
      cwd: expandTilde(draftConfig.cwd),
      ...(draftConfig.modeId ? { modeId: draftConfig.modeId } : {}),
      ...(draftConfig.model ? { model: draftConfig.model } : {}),
      ...(draftConfig.thinkingOptionId ? { thinkingOptionId: draftConfig.thinkingOptionId } : {}),
      ...(draftConfig.featureValues ? { featureValues: draftConfig.featureValues } : {}),
    };
  }

  private async handleListProviderFeaturesRequest(
    msg: Extract<SessionInboundMessage, { type: "list_provider_features_request" }>,
  ): Promise<void> {
    const fetchedAt = new Date().toISOString();
    try {
      const sessionConfig = this.buildDraftAgentSessionConfig(msg.draftConfig);
      const features = await this.agentManager.listDraftFeatures(sessionConfig);
      this.emit({
        type: "list_provider_features_response",
        payload: {
          provider: msg.draftConfig.provider,
          features,
          error: null,
          fetchedAt,
          requestId: msg.requestId,
        },
      });
    } catch (error) {
      this.sessionLogger.error(
        { err: error, provider: msg.draftConfig.provider, draftConfig: msg.draftConfig },
        `Failed to list features for ${msg.draftConfig.provider}`,
      );
      this.emit({
        type: "list_provider_features_response",
        payload: {
          provider: msg.draftConfig.provider,
          error: (error as Error)?.message ?? String(error),
          fetchedAt,
          requestId: msg.requestId,
        },
      });
    }
  }

  private async handleListAvailableProvidersRequest(
    msg: Extract<SessionInboundMessage, { type: "list_available_providers_request" }>,
  ): Promise<void> {
    const fetchedAt = new Date().toISOString();
    try {
      let providers = await this.agentManager.listProviderAvailability();

      // TODO: Remove once all app store clients are on >=0.1.45.
      providers = providers.filter((p) => this.isProviderVisibleToClient(p.provider));

      this.emit({
        type: "list_available_providers_response",
        payload: {
          providers,
          error: null,
          fetchedAt,
          requestId: msg.requestId,
        },
      });
    } catch (error) {
      this.sessionLogger.error({ err: error }, "Failed to list provider availability");
      this.emit({
        type: "list_available_providers_response",
        payload: {
          providers: [],
          error: (error as Error)?.message ?? String(error),
          fetchedAt,
          requestId: msg.requestId,
        },
      });
    }
  }

  private async handleGetProvidersSnapshotRequest(
    msg: Extract<SessionInboundMessage, { type: "get_providers_snapshot_request" }>,
  ): Promise<void> {
    // COMPAT(providersSnapshot): keep legacy provider-list RPCs alongside snapshot flow.
    const entries = this.providerSnapshotManager
      ? this.providerSnapshotManager
          .getSnapshot(msg.cwd ? expandTilde(msg.cwd) : undefined)
          .filter((entry) => this.isProviderVisibleToClient(entry.provider))
      : [];

    this.emit({
      type: "get_providers_snapshot_response",
      payload: {
        entries,
        generatedAt: new Date().toISOString(),
        requestId: msg.requestId,
      },
    });
  }

  private async handleRefreshProvidersSnapshotRequest(
    msg: Extract<SessionInboundMessage, { type: "refresh_providers_snapshot_request" }>,
  ): Promise<void> {
    this.providerSnapshotManager?.refresh(msg.cwd ? expandTilde(msg.cwd) : undefined);
    this.emit({
      type: "refresh_providers_snapshot_response",
      payload: {
        acknowledged: true,
        requestId: msg.requestId,
      },
    });
  }

  private async handleProviderDiagnosticRequest(
    msg: Extract<SessionInboundMessage, { type: "provider_diagnostic_request" }>,
  ): Promise<void> {
    try {
      const client = this.providerRegistry[msg.provider].createClient(this.sessionLogger);
      const diagnostic = client.getDiagnostic
        ? (await client.getDiagnostic()).diagnostic
        : "No diagnostic available for this provider.";
      this.emit({
        type: "provider_diagnostic_response",
        payload: {
          provider: msg.provider,
          diagnostic,
          requestId: msg.requestId,
        },
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.sessionLogger.error(
        { err, provider: msg.provider },
        `Failed to get provider diagnostic for ${msg.provider}`,
      );
      this.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: `Failed to get provider diagnostic: ${err.message}`,
          code: "provider_diagnostic_failed",
        },
      });
    }
  }

  private assertSafeGitRef(ref: string, label: string): void {
    if (!/^[A-Za-z0-9._/-]+$/.test(ref)) {
      throw new Error(`Invalid ${label}: ${ref}`);
    }
    assertWorktreeSafeGitRef(ref, label);
  }

  private isPathWithinRoot(rootPath: string, candidatePath: string): boolean {
    const resolvedRoot = resolve(rootPath);
    const resolvedCandidate = resolve(candidatePath);
    if (resolvedCandidate === resolvedRoot) {
      return true;
    }
    return resolvedCandidate.startsWith(resolvedRoot + sep);
  }

  private async generateCommitMessage(cwd: string): Promise<string> {
    const diff = await getCheckoutDiff(
      cwd,
      { mode: "uncommitted", includeStructured: true },
      { hubcodeHome: this.hubcodeHome },
    );
    const schema = z.object({
      message: z
        .string()
        .min(1)
        .max(72)
        .describe("Concise git commit message, imperative mood, no trailing period."),
    });
    const fileList =
      diff.structured && diff.structured.length > 0
        ? [
            "Files changed:",
            ...diff.structured.map((file) => {
              const changeType = file.isNew ? "A" : file.isDeleted ? "D" : "M";
              const status = file.status && file.status !== "ok" ? ` [${file.status}]` : "";
              return `${changeType}\t${file.path}\t(+${file.additions} -${file.deletions})${status}`;
            }),
          ].join("\n")
        : "Files changed: (unknown)";
    const maxPatchChars = 120_000;
    const patch =
      diff.diff.length > maxPatchChars
        ? `${diff.diff.slice(0, maxPatchChars)}\n\n... (diff truncated to ${maxPatchChars} chars)\n`
        : diff.diff;
    const prompt = [
      "Write a concise git commit message for the changes below.",
      "Return JSON only with a single field 'message'.",
      "",
      fileList,
      "",
      patch.length > 0 ? patch : "(No diff available)",
    ].join("\n");
    try {
      const result = await generateStructuredAgentResponseWithFallback({
        manager: this.agentManager,
        cwd,
        prompt,
        schema,
        schemaName: "CommitMessage",
        maxRetries: 2,
        providers: DEFAULT_STRUCTURED_GENERATION_PROVIDERS,
        agentConfigOverrides: {
          title: "Commit generator",
          internal: true,
        },
      });
      return result.message;
    } catch (error) {
      if (
        error instanceof StructuredAgentResponseError ||
        error instanceof StructuredAgentFallbackError
      ) {
        return "Update files";
      }
      throw error;
    }
  }

  private async generatePullRequestText(
    cwd: string,
    baseRef?: string,
  ): Promise<{
    title: string;
    body: string;
  }> {
    const diff = await getCheckoutDiff(
      cwd,
      {
        mode: "base",
        baseRef,
        includeStructured: true,
      },
      { hubcodeHome: this.hubcodeHome },
    );
    const schema = z.object({
      title: z.string().min(1).max(72),
      body: z.string().min(1),
    });
    const fileList =
      diff.structured && diff.structured.length > 0
        ? [
            "Files changed:",
            ...diff.structured.map((file) => {
              const changeType = file.isNew ? "A" : file.isDeleted ? "D" : "M";
              const status = file.status && file.status !== "ok" ? ` [${file.status}]` : "";
              return `${changeType}\t${file.path}\t(+${file.additions} -${file.deletions})${status}`;
            }),
          ].join("\n")
        : "Files changed: (unknown)";
    const maxPatchChars = 200_000;
    const patch =
      diff.diff.length > maxPatchChars
        ? `${diff.diff.slice(0, maxPatchChars)}\n\n... (diff truncated to ${maxPatchChars} chars)\n`
        : diff.diff;
    const prompt = [
      "Write a pull request title and body for the changes below.",
      "Return JSON only with fields 'title' and 'body'.",
      "",
      fileList,
      "",
      patch.length > 0 ? patch : "(No diff available)",
    ].join("\n");
    try {
      return await generateStructuredAgentResponseWithFallback({
        manager: this.agentManager,
        cwd,
        prompt,
        schema,
        schemaName: "PullRequest",
        maxRetries: 2,
        providers: DEFAULT_STRUCTURED_GENERATION_PROVIDERS,
        agentConfigOverrides: {
          title: "PR generator",
          internal: true,
        },
      });
    } catch (error) {
      if (
        error instanceof StructuredAgentResponseError ||
        error instanceof StructuredAgentFallbackError
      ) {
        return {
          title: "Update changes",
          body: "Automated PR generated by Hubcode.",
        };
      }
      throw error;
    }
  }

  private async ensureCleanWorkingTree(cwd: string): Promise<void> {
    const dirty = await this.isWorkingTreeDirty(cwd);
    if (dirty) {
      throw new Error(
        "Working directory has uncommitted changes. Commit or stash before switching branches.",
      );
    }
  }

  private async isWorkingTreeDirty(cwd: string): Promise<boolean> {
    try {
      const { stdout } = await execAsync("git status --porcelain", {
        cwd,
        env: READ_ONLY_GIT_ENV,
      });
      return stdout.trim().length > 0;
    } catch (error) {
      throw new Error(`Unable to inspect git status for ${cwd}: ${(error as Error).message}`);
    }
  }

  private async checkoutExistingBranch(cwd: string, branch: string): Promise<void> {
    this.assertSafeGitRef(branch, "branch");
    try {
      await execCommand("git", ["rev-parse", "--verify", branch], { cwd });
    } catch (error) {
      throw new Error(`Branch not found: ${branch}`);
    }

    const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", {
      cwd,
    });
    const current = stdout.trim();
    if (current === branch) {
      return;
    }

    await this.ensureCleanWorkingTree(cwd);
    await execCommand("git", ["checkout", branch], { cwd });
  }

  private async createBranchFromBase(params: {
    cwd: string;
    baseBranch: string;
    newBranchName: string;
  }): Promise<void> {
    const { cwd, baseBranch, newBranchName } = params;
    this.assertSafeGitRef(baseBranch, "base branch");
    this.assertSafeGitRef(newBranchName, "new branch");

    try {
      await execCommand("git", ["rev-parse", "--verify", baseBranch], { cwd });
    } catch (error) {
      throw new Error(`Base branch not found: ${baseBranch}`);
    }

    const exists = await this.doesLocalBranchExist(cwd, newBranchName);
    if (exists) {
      throw new Error(`Branch already exists: ${newBranchName}`);
    }

    await this.ensureCleanWorkingTree(cwd);
    await execCommand("git", ["checkout", "-b", newBranchName, baseBranch], {
      cwd,
    });
  }

  private async doesLocalBranchExist(cwd: string, branch: string): Promise<boolean> {
    this.assertSafeGitRef(branch, "branch");
    try {
      await execCommand("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
        cwd,
      });
      return true;
    } catch (error: any) {
      return false;
    }
  }

  /**
   * Handle set agent mode request
   */
  private async handleSetAgentModeRequest(
    agentId: string,
    modeId: string,
    requestId: string,
  ): Promise<void> {
    this.sessionLogger.info({ agentId, modeId, requestId }, "session: set_agent_mode_request");

    try {
      await this.agentManager.setAgentMode(agentId, modeId);
      this.sessionLogger.info(
        { agentId, modeId, requestId },
        "session: set_agent_mode_request success",
      );
      this.emit({
        type: "set_agent_mode_response",
        payload: { requestId, agentId, accepted: true, error: null },
      });
    } catch (error: any) {
      this.sessionLogger.error(
        { err: error, agentId, modeId, requestId },
        "session: set_agent_mode_request error",
      );
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to set agent mode: ${error.message}`,
        },
      });
      this.emit({
        type: "set_agent_mode_response",
        payload: {
          requestId,
          agentId,
          accepted: false,
          error: error?.message ? String(error.message) : "Failed to set agent mode",
        },
      });
    }
  }

  private async handleSetAgentModelRequest(
    agentId: string,
    modelId: string | null,
    requestId: string,
  ): Promise<void> {
    this.sessionLogger.info({ agentId, modelId, requestId }, "session: set_agent_model_request");

    try {
      await this.agentManager.setAgentModel(agentId, modelId);
      this.sessionLogger.info(
        { agentId, modelId, requestId },
        "session: set_agent_model_request success",
      );
      this.emit({
        type: "set_agent_model_response",
        payload: { requestId, agentId, accepted: true, error: null },
      });
    } catch (error: any) {
      this.sessionLogger.error(
        { err: error, agentId, modelId, requestId },
        "session: set_agent_model_request error",
      );
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to set agent model: ${error.message}`,
        },
      });
      this.emit({
        type: "set_agent_model_response",
        payload: {
          requestId,
          agentId,
          accepted: false,
          error: error?.message ? String(error.message) : "Failed to set agent model",
        },
      });
    }
  }

  private async handleSetAgentFeatureRequest(
    agentId: string,
    featureId: string,
    value: unknown,
    requestId: string,
  ): Promise<void> {
    this.sessionLogger.info(
      { agentId, featureId, value, requestId },
      "session: set_agent_feature_request",
    );

    try {
      await this.agentManager.setAgentFeature(agentId, featureId, value);
      this.sessionLogger.info(
        { agentId, featureId, value, requestId },
        "session: set_agent_feature_request success",
      );
      this.emit({
        type: "set_agent_feature_response",
        payload: { requestId, agentId, accepted: true, error: null },
      });
    } catch (error: any) {
      this.sessionLogger.error(
        { err: error, agentId, featureId, value, requestId },
        "session: set_agent_feature_request error",
      );
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to set agent feature: ${error.message}`,
        },
      });
      this.emit({
        type: "set_agent_feature_response",
        payload: {
          requestId,
          agentId,
          accepted: false,
          error: error?.message ? String(error.message) : "Failed to set agent feature",
        },
      });
    }
  }

  private async handleSetAgentThinkingRequest(
    agentId: string,
    thinkingOptionId: string | null,
    requestId: string,
  ): Promise<void> {
    this.sessionLogger.info(
      { agentId, thinkingOptionId, requestId },
      "session: set_agent_thinking_request",
    );

    try {
      await this.agentManager.setAgentThinkingOption(agentId, thinkingOptionId);
      this.sessionLogger.info(
        { agentId, thinkingOptionId, requestId },
        "session: set_agent_thinking_request success",
      );
      this.emit({
        type: "set_agent_thinking_response",
        payload: { requestId, agentId, accepted: true, error: null },
      });
    } catch (error: any) {
      this.sessionLogger.error(
        { err: error, agentId, thinkingOptionId, requestId },
        "session: set_agent_thinking_request error",
      );
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to set agent thinking option: ${error.message}`,
        },
      });
      this.emit({
        type: "set_agent_thinking_response",
        payload: {
          requestId,
          agentId,
          accepted: false,
          error: error?.message ? String(error.message) : "Failed to set agent thinking option",
        },
      });
    }
  }

  /**
   * Handle clearing agent attention flag
   */
  private async handleClearAgentAttention(agentId: string | string[]): Promise<void> {
    const agentIds = Array.isArray(agentId) ? agentId : [agentId];

    try {
      await Promise.all(agentIds.map((id) => this.agentManager.clearAgentAttention(id)));
    } catch (error: any) {
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
    lastActivityAt: string;
    appVisible: boolean;
    appVisibilityChangedAt?: string;
  }): void {
    const appVisibilityChangedAt = msg.appVisibilityChangedAt
      ? new Date(msg.appVisibilityChangedAt)
      : new Date(msg.lastActivityAt);
    this.clientActivity = {
      deviceType: msg.deviceType,
      focusedAgentId: msg.focusedAgentId,
      lastActivityAt: new Date(msg.lastActivityAt),
      appVisible: msg.appVisible,
      appVisibilityChangedAt,
    };
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
        const sessionConfig = this.buildDraftAgentSessionConfig(draftConfig);
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
    } catch (error: any) {
      this.sessionLogger.error({ err: error, agentId, draftConfig }, "Failed to list commands");
      this.emit({
        type: "list_commands_response",
        payload: {
          agentId,
          commands: [],
          error: error.message,
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
    this.sessionLogger.debug(
      { agentId, requestId },
      `Handling permission response for agent ${agentId}, request ${requestId}`,
    );

    try {
      const result = await this.agentManager.respondToPermission(agentId, requestId, response);
      this.sessionLogger.debug({ agentId }, `Permission response forwarded to agent ${agentId}`);

      if (result?.followUpPrompt) {
        this.sessionLogger.debug(
          { agentId },
          "Permission response requires follow-up turn, starting agent stream",
        );
        this.startAgentStream(agentId, result.followUpPrompt);
      }
    } catch (error: any) {
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
          content: `Failed to respond to permission: ${error.message}`,
        },
      });
      throw error;
    }
  }

  private async handleCheckoutStatusRequest(
    msg: Extract<SessionInboundMessage, { type: "checkout_status_request" }>,
  ): Promise<void> {
    const { cwd, requestId } = msg;
    const resolvedCwd = expandTilde(cwd);

    try {
      const status = await getCheckoutStatus(resolvedCwd, { hubcodeHome: this.hubcodeHome });
      if (!status.isGit) {
        this.emit({
          type: "checkout_status_response",
          payload: {
            cwd,
            isGit: false,
            repoRoot: null,
            currentBranch: null,
            isDirty: null,
            baseRef: null,
            aheadBehind: null,
            aheadOfOrigin: null,
            behindOfOrigin: null,
            hasRemote: false,
            remoteUrl: null,
            isHubcodeOwnedWorktree: false,
            error: null,
            requestId,
          },
        });
        return;
      }

      if (status.isHubcodeOwnedWorktree) {
        this.emit({
          type: "checkout_status_response",
          payload: {
            cwd,
            isGit: true,
            repoRoot: status.repoRoot ?? null,
            mainRepoRoot: status.mainRepoRoot,
            currentBranch: status.currentBranch ?? null,
            isDirty: status.isDirty ?? null,
            baseRef: status.baseRef,
            aheadBehind: status.aheadBehind ?? null,
            aheadOfOrigin: status.aheadOfOrigin ?? null,
            behindOfOrigin: status.behindOfOrigin ?? null,
            hasRemote: status.hasRemote,
            remoteUrl: status.remoteUrl,
            isHubcodeOwnedWorktree: true,
            error: null,
            requestId,
          },
        });
        return;
      }

      this.emit({
        type: "checkout_status_response",
        payload: {
          cwd,
          isGit: true,
          repoRoot: status.repoRoot ?? null,
          currentBranch: status.currentBranch ?? null,
          isDirty: status.isDirty ?? null,
          baseRef: status.baseRef ?? null,
          aheadBehind: status.aheadBehind ?? null,
          aheadOfOrigin: status.aheadOfOrigin ?? null,
          behindOfOrigin: status.behindOfOrigin ?? null,
          hasRemote: status.hasRemote,
          remoteUrl: status.remoteUrl,
          isHubcodeOwnedWorktree: false,
          error: null,
          requestId,
        },
      });
    } catch (error) {
      this.emit({
        type: "checkout_status_response",
        payload: {
          cwd,
          isGit: false,
          repoRoot: null,
          currentBranch: null,
          isDirty: null,
          baseRef: null,
          aheadBehind: null,
          aheadOfOrigin: null,
          behindOfOrigin: null,
          hasRemote: false,
          remoteUrl: null,
          isHubcodeOwnedWorktree: false,
          error: toCheckoutError(error),
          requestId,
        },
      });
    }
  }

  private async handleValidateBranchRequest(
    msg: Extract<SessionInboundMessage, { type: "validate_branch_request" }>,
  ): Promise<void> {
    const { cwd, branchName, requestId } = msg;

    try {
      const resolvedCwd = expandTilde(cwd);
      this.assertSafeGitRef(branchName, "branch");

      // Try local branch first
      try {
        await execCommand("git", ["rev-parse", "--verify", branchName], {
          cwd: resolvedCwd,
          env: READ_ONLY_GIT_ENV,
        });
        this.emit({
          type: "validate_branch_response",
          payload: {
            exists: true,
            resolvedRef: branchName,
            isRemote: false,
            error: null,
            requestId,
          },
        });
        return;
      } catch {
        // Local branch doesn't exist, try remote
      }

      // Try remote branch (origin/{branchName})
      try {
        await execCommand("git", ["rev-parse", "--verify", `origin/${branchName}`], {
          cwd: resolvedCwd,
          env: READ_ONLY_GIT_ENV,
        });
        this.emit({
          type: "validate_branch_response",
          payload: {
            exists: true,
            resolvedRef: `origin/${branchName}`,
            isRemote: true,
            error: null,
            requestId,
          },
        });
        return;
      } catch {
        // Remote branch doesn't exist either
      }

      // Branch not found anywhere
      this.emit({
        type: "validate_branch_response",
        payload: {
          exists: false,
          resolvedRef: null,
          isRemote: false,
          error: null,
          requestId,
        },
      });
    } catch (error) {
      this.emit({
        type: "validate_branch_response",
        payload: {
          exists: false,
          resolvedRef: null,
          isRemote: false,
          error: error instanceof Error ? error.message : String(error),
          requestId,
        },
      });
    }
  }

  private async handleBranchSuggestionsRequest(
    msg: Extract<SessionInboundMessage, { type: "branch_suggestions_request" }>,
  ): Promise<void> {
    const { cwd, query, limit, requestId } = msg;

    try {
      const resolvedCwd = expandTilde(cwd);
      const branches = await listBranchSuggestions(resolvedCwd, { query, limit });
      this.emit({
        type: "branch_suggestions_response",
        payload: {
          branches,
          error: null,
          requestId,
        },
      });
    } catch (error) {
      this.emit({
        type: "branch_suggestions_response",
        payload: {
          branches: [],
          error: error instanceof Error ? error.message : String(error),
          requestId,
        },
      });
    }
  }

  private async handleDirectorySuggestionsRequest(msg: DirectorySuggestionsRequest): Promise<void> {
    const { query, limit, requestId, cwd, includeFiles, includeDirectories } = msg;

    try {
      const workspaceCwd = cwd?.trim();
      const entries = workspaceCwd
        ? await searchWorkspaceEntries({
            cwd: expandTilde(workspaceCwd),
            query,
            limit,
            includeFiles,
            includeDirectories,
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

  private removeWorkspaceGitSubscription(cwd: string): void {
    const workspaceId = normalizePersistedWorkspaceId(cwd);
    this.workspaceGitSubscriptions.get(workspaceId)?.();
    this.workspaceGitSubscriptions.delete(workspaceId);
  }

  private async syncWorkspaceGitWatchTarget(
    cwd: string,
    options: { isGit: boolean },
  ): Promise<void> {
    const workspaceId = normalizePersistedWorkspaceId(cwd);
    if (!options.isGit) {
      this.removeWorkspaceGitSubscription(workspaceId);
      return;
    }

    if (this.workspaceGitSubscriptions.has(workspaceId)) {
      return;
    }

    const subscription = await this.workspaceGitService.subscribe({ cwd: workspaceId }, () => {
      void this.emitWorkspaceUpdateForCwd(workspaceId);
    });
    this.workspaceGitSubscriptions.set(workspaceId, subscription.unsubscribe);
  }

  private async handleSubscribeCheckoutDiffRequest(
    msg: SubscribeCheckoutDiffRequest,
  ): Promise<void> {
    const cwd = expandTilde(msg.cwd);
    this.checkoutDiffSubscriptions.get(msg.subscriptionId)?.();
    this.checkoutDiffSubscriptions.delete(msg.subscriptionId);
    const subscription = await this.checkoutDiffManager.subscribe(
      { cwd, compare: msg.compare },
      (snapshot) => {
        this.emit({
          type: "checkout_diff_update",
          payload: {
            subscriptionId: msg.subscriptionId,
            ...snapshot,
          },
        });
      },
    );
    this.checkoutDiffSubscriptions.set(msg.subscriptionId, subscription.unsubscribe);

    this.emit({
      type: "subscribe_checkout_diff_response",
      payload: {
        subscriptionId: msg.subscriptionId,
        ...subscription.initial,
        requestId: msg.requestId,
      },
    });
  }

  private handleUnsubscribeCheckoutDiffRequest(msg: UnsubscribeCheckoutDiffRequest): void {
    this.checkoutDiffSubscriptions.get(msg.subscriptionId)?.();
    this.checkoutDiffSubscriptions.delete(msg.subscriptionId);
  }

  private async handleCheckoutSwitchBranchRequest(
    msg: Extract<SessionInboundMessage, { type: "checkout_switch_branch_request" }>,
  ): Promise<void> {
    const { cwd, branch, requestId } = msg;

    try {
      await this.checkoutExistingBranch(cwd, branch);
      this.checkoutDiffManager.scheduleRefreshForCwd(cwd);

      // Push a workspace_update immediately so the sidebar/header reflect
      // the new branch name without waiting for the background git watcher.
      await this.emitWorkspaceUpdateForCwd(cwd);

      this.emit({
        type: "checkout_switch_branch_response",
        payload: {
          cwd,
          success: true,
          branch,
          error: null,
          requestId,
        },
      });
    } catch (error) {
      this.emit({
        type: "checkout_switch_branch_response",
        payload: {
          cwd,
          success: false,
          branch,
          error: toCheckoutError(error),
          requestId,
        },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Stash handlers
  // ---------------------------------------------------------------------------

  private static readonly HUBCODE_STASH_PREFIX = "hubcode-auto-stash:";

  private async handleStashSaveRequest(
    msg: Extract<SessionInboundMessage, { type: "stash_save_request" }>,
  ): Promise<void> {
    const { cwd, requestId } = msg;
    try {
      const branchLabel = msg.branch?.trim() ?? "";
      const message = branchLabel
        ? `${Session.HUBCODE_STASH_PREFIX} ${branchLabel}`
        : `${Session.HUBCODE_STASH_PREFIX} unnamed`;
      await execCommand("git", ["stash", "push", "--include-untracked", "-m", message], { cwd });
      this.checkoutDiffManager.scheduleRefreshForCwd(cwd);
      this.emit({
        type: "stash_save_response",
        payload: { cwd, success: true, error: null, requestId },
      });
    } catch (error) {
      this.emit({
        type: "stash_save_response",
        payload: { cwd, success: false, error: toCheckoutError(error), requestId },
      });
    }
  }

  private async handleStashPopRequest(
    msg: Extract<SessionInboundMessage, { type: "stash_pop_request" }>,
  ): Promise<void> {
    const { cwd, stashIndex, requestId } = msg;
    try {
      await execCommand("git", ["stash", "pop", `stash@{${stashIndex}}`], { cwd });
      this.checkoutDiffManager.scheduleRefreshForCwd(cwd);
      this.emit({
        type: "stash_pop_response",
        payload: { cwd, success: true, error: null, requestId },
      });
    } catch (error) {
      this.emit({
        type: "stash_pop_response",
        payload: { cwd, success: false, error: toCheckoutError(error), requestId },
      });
    }
  }

  private async handleStashListRequest(
    msg: Extract<SessionInboundMessage, { type: "stash_list_request" }>,
  ): Promise<void> {
    const { cwd, requestId } = msg;
    const hubcodeOnly = msg.hubcodeOnly !== false;
    try {
      const { stdout } = await execAsync("git stash list --format=%gd%x00%s", {
        cwd,
        env: READ_ONLY_GIT_ENV,
      });
      const lines = stdout.trim().split("\n").filter(Boolean);
      const entries: Array<{
        index: number;
        message: string;
        branch: string | null;
        isHubcode: boolean;
      }> = [];

      for (const line of lines) {
        const sepIdx = line.indexOf("\0");
        if (sepIdx < 0) continue;
        const refPart = line.slice(0, sepIdx);
        const subject = line.slice(sepIdx + 1);
        const indexMatch = refPart.match(/\{(\d+)\}/);
        if (!indexMatch) continue;
        const index = Number(indexMatch[1]);
        const prefixIdx = subject.indexOf(Session.HUBCODE_STASH_PREFIX);
        const isHubcode = prefixIdx >= 0;
        const branch = isHubcode
          ? subject.slice(prefixIdx + Session.HUBCODE_STASH_PREFIX.length).trim() || null
          : null;

        if (hubcodeOnly && !isHubcode) continue;
        entries.push({ index, message: subject, branch, isHubcode });
      }

      this.emit({
        type: "stash_list_response",
        payload: { cwd, entries, error: null, requestId },
      });
    } catch (error) {
      this.emit({
        type: "stash_list_response",
        payload: { cwd, entries: [], error: toCheckoutError(error), requestId },
      });
    }
  }

  private async handleCheckoutCommitRequest(
    msg: Extract<SessionInboundMessage, { type: "checkout_commit_request" }>,
  ): Promise<void> {
    const { cwd, requestId } = msg;

    try {
      let message = msg.message?.trim() ?? "";
      if (!message) {
        message = await this.generateCommitMessage(cwd);
      }
      if (!message) {
        throw new Error("Commit message is required");
      }

      await commitChanges(cwd, {
        message,
        addAll: msg.addAll ?? true,
      });
      this.checkoutDiffManager.scheduleRefreshForCwd(cwd);

      this.emit({
        type: "checkout_commit_response",
        payload: {
          cwd,
          success: true,
          error: null,
          requestId,
        },
      });
    } catch (error) {
      this.emit({
        type: "checkout_commit_response",
        payload: {
          cwd,
          success: false,
          error: toCheckoutError(error),
          requestId,
        },
      });
    }
  }

  private async handleCheckoutMergeRequest(
    msg: Extract<SessionInboundMessage, { type: "checkout_merge_request" }>,
  ): Promise<void> {
    const { cwd, requestId } = msg;

    try {
      const status = await getCheckoutStatus(cwd, { hubcodeHome: this.hubcodeHome });
      if (!status.isGit) {
        try {
          await execAsync("git rev-parse --is-inside-work-tree", {
            cwd,
            env: READ_ONLY_GIT_ENV,
          });
        } catch (error) {
          const details =
            typeof (error as any)?.stderr === "string"
              ? String((error as any).stderr).trim()
              : error instanceof Error
                ? error.message
                : String(error);
          throw new Error(`Not a git repository: ${cwd}\n${details}`.trim());
        }
      }

      if (msg.requireCleanTarget) {
        const { stdout } = await execAsync("git status --porcelain", {
          cwd,
          env: READ_ONLY_GIT_ENV,
        });
        if (stdout.trim().length > 0) {
          throw new Error("Working directory has uncommitted changes.");
        }
      }

      let baseRef = msg.baseRef ?? (status.isGit ? status.baseRef : null);
      if (!baseRef) {
        throw new Error("Base branch is required for merge");
      }
      if (baseRef.startsWith("origin/")) {
        baseRef = baseRef.slice("origin/".length);
      }

      await mergeToBase(
        cwd,
        {
          baseRef,
          mode: msg.strategy === "squash" ? "squash" : "merge",
        },
        { hubcodeHome: this.hubcodeHome },
      );
      this.checkoutDiffManager.scheduleRefreshForCwd(cwd);

      this.emit({
        type: "checkout_merge_response",
        payload: {
          cwd,
          success: true,
          error: null,
          requestId,
        },
      });
    } catch (error) {
      this.emit({
        type: "checkout_merge_response",
        payload: {
          cwd,
          success: false,
          error: toCheckoutError(error),
          requestId,
        },
      });
    }
  }

  private async handleCheckoutMergeFromBaseRequest(
    msg: Extract<SessionInboundMessage, { type: "checkout_merge_from_base_request" }>,
  ): Promise<void> {
    const { cwd, requestId } = msg;

    try {
      if (msg.requireCleanTarget ?? true) {
        const { stdout } = await execAsync("git status --porcelain", {
          cwd,
          env: READ_ONLY_GIT_ENV,
        });
        if (stdout.trim().length > 0) {
          throw new Error("Working directory has uncommitted changes.");
        }
      }

      await mergeFromBase(cwd, {
        baseRef: msg.baseRef,
        requireCleanTarget: msg.requireCleanTarget ?? true,
      });
      this.checkoutDiffManager.scheduleRefreshForCwd(cwd);

      this.emit({
        type: "checkout_merge_from_base_response",
        payload: {
          cwd,
          success: true,
          error: null,
          requestId,
        },
      });
    } catch (error) {
      this.emit({
        type: "checkout_merge_from_base_response",
        payload: {
          cwd,
          success: false,
          error: toCheckoutError(error),
          requestId,
        },
      });
    }
  }

  private async handleCheckoutPullRequest(
    msg: Extract<SessionInboundMessage, { type: "checkout_pull_request" }>,
  ): Promise<void> {
    const { cwd, requestId } = msg;

    try {
      await pullCurrentBranch(cwd);
      this.checkoutDiffManager.scheduleRefreshForCwd(cwd);

      this.emit({
        type: "checkout_pull_response",
        payload: {
          cwd,
          success: true,
          error: null,
          requestId,
        },
      });
    } catch (error) {
      this.emit({
        type: "checkout_pull_response",
        payload: {
          cwd,
          success: false,
          error: toCheckoutError(error),
          requestId,
        },
      });
    }
  }

  private async handleCheckoutPushRequest(
    msg: Extract<SessionInboundMessage, { type: "checkout_push_request" }>,
  ): Promise<void> {
    const { cwd, requestId } = msg;

    try {
      await pushCurrentBranch(cwd);
      this.emit({
        type: "checkout_push_response",
        payload: {
          cwd,
          success: true,
          error: null,
          requestId,
        },
      });
    } catch (error) {
      this.emit({
        type: "checkout_push_response",
        payload: {
          cwd,
          success: false,
          error: toCheckoutError(error),
          requestId,
        },
      });
    }
  }

  private async handleCheckoutPrCreateRequest(
    msg: Extract<SessionInboundMessage, { type: "checkout_pr_create_request" }>,
  ): Promise<void> {
    const { cwd, requestId } = msg;

    try {
      let title = msg.title?.trim() ?? "";
      let body = msg.body?.trim() ?? "";

      if (!title || !body) {
        const generated = await this.generatePullRequestText(cwd, msg.baseRef);
        if (!title) title = generated.title;
        if (!body) body = generated.body;
      }

      const result = await createPullRequest(cwd, {
        title,
        body,
        base: msg.baseRef,
      });

      this.emit({
        type: "checkout_pr_create_response",
        payload: {
          cwd,
          url: result.url ?? null,
          number: result.number ?? null,
          error: null,
          requestId,
        },
      });
    } catch (error) {
      this.emit({
        type: "checkout_pr_create_response",
        payload: {
          cwd,
          url: null,
          number: null,
          error: toCheckoutError(error),
          requestId,
        },
      });
    }
  }

  private async handleCheckoutPrStatusRequest(
    msg: Extract<SessionInboundMessage, { type: "checkout_pr_status_request" }>,
  ): Promise<void> {
    const { cwd, requestId } = msg;

    try {
      await this.workspaceGitService.refresh(cwd, { priority: "high" });
      const snapshot = await this.workspaceGitService.getSnapshot(cwd);
      this.emit({
        type: "checkout_pr_status_response",
        payload: {
          cwd,
          status: snapshot.github.pullRequest,
          githubFeaturesEnabled: snapshot.github.featuresEnabled,
          error: snapshot.github.error
            ? {
                code: "UNKNOWN",
                message: snapshot.github.error.message,
              }
            : null,
          requestId,
        },
      });
    } catch (error) {
      this.emit({
        type: "checkout_pr_status_response",
        payload: {
          cwd,
          status: null,
          githubFeaturesEnabled: true,
          error: toCheckoutError(error),
          requestId,
        },
      });
    }
  }

  private async handleHubcodeWorktreeListRequest(
    msg: Extract<SessionInboundMessage, { type: "hubcode_worktree_list_request" }>,
  ): Promise<void> {
    return handleWorktreeListRequest(
      {
        emit: (message) => this.emit(message),
        hubcodeHome: this.hubcodeHome,
      },
      msg,
    );
  }

  private async handleHubcodeWorktreeArchiveRequest(
    msg: Extract<SessionInboundMessage, { type: "hubcode_worktree_archive_request" }>,
  ): Promise<void> {
    return handleWorktreeArchiveRequest(
      {
        hubcodeHome: this.hubcodeHome,
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        archiveWorkspaceRecord: (workspaceId) => this.archiveWorkspaceRecord(workspaceId),
        emit: (message) => this.emit(message),
        emitWorkspaceUpdatesForCwds: (cwds) => this.emitWorkspaceUpdatesForCwds(cwds),
        isPathWithinRoot: (rootPath, candidatePath) =>
          this.isPathWithinRoot(rootPath, candidatePath),
        killTerminalsUnderPath: (rootPath) => this.killTerminalsUnderPath(rootPath),
      },
      msg,
    );
  }

  /**
   * Handle read-only file explorer requests scoped to a workspace cwd
   */
  private async handleFileExplorerRequest(request: FileExplorerRequest): Promise<void> {
    const { cwd: workspaceCwd, path: requestedPath = ".", mode, requestId } = request;
    const cwd = workspaceCwd.trim();
    if (!cwd) {
      this.emit({
        type: "file_explorer_response",
        payload: {
          cwd: workspaceCwd,
          path: requestedPath,
          mode,
          directory: null,
          file: null,
          error: "cwd is required",
          requestId,
        },
      });
      return;
    }

    try {
      if (mode === "list") {
        const directory = await listDirectoryEntries({
          root: cwd,
          relativePath: requestedPath,
        });

        this.emit({
          type: "file_explorer_response",
          payload: {
            cwd,
            path: directory.path,
            mode,
            directory,
            file: null,
            error: null,
            requestId,
          },
        });
      } else {
        const file = await readExplorerFile({
          root: cwd,
          relativePath: requestedPath,
        });

        this.emit({
          type: "file_explorer_response",
          payload: {
            cwd,
            path: file.path,
            mode,
            directory: null,
            file,
            error: null,
            requestId,
          },
        });
      }
    } catch (error: any) {
      this.sessionLogger.error(
        { err: error, cwd, path: requestedPath },
        `Failed to fulfill file explorer request for workspace ${cwd}`,
      );
      this.emit({
        type: "file_explorer_response",
        payload: {
          cwd,
          path: requestedPath,
          mode,
          directory: null,
          file: null,
          error: error.message,
          requestId,
        },
      });
    }
  }

  private async handleFileWriteRequest(request: FileWriteRequest): Promise<void> {
    const { cwd: workspaceCwd, path: requestedPath, content, requestId } = request;
    const cwd = workspaceCwd.trim();
    if (!cwd) {
      this.emit({
        type: "file_write_response",
        payload: { cwd: workspaceCwd, path: requestedPath, error: "cwd is required", requestId },
      });
      return;
    }
    try {
      await writeExplorerFile({ root: cwd, relativePath: requestedPath, content });
      this.emit({
        type: "file_write_response",
        payload: { cwd, path: requestedPath, error: null, requestId },
      });
    } catch (error: unknown) {
      this.sessionLogger.error(
        { err: error, cwd, path: requestedPath },
        `Failed to write file in workspace ${cwd}`,
      );
      this.emit({
        type: "file_write_response",
        payload: {
          cwd,
          path: requestedPath,
          error: error instanceof Error ? error.message : String(error),
          requestId,
        },
      });
    }
  }

  private async handleFileRenameRequest(request: FileRenameRequest): Promise<void> {
    const { cwd: workspaceCwd, oldPath, newPath, requestId } = request;
    const cwd = workspaceCwd.trim();
    if (!cwd) {
      this.emit({
        type: "file_rename_response",
        payload: { cwd: workspaceCwd, oldPath, newPath, error: "cwd is required", requestId },
      });
      return;
    }
    try {
      await renameExplorerEntry({ root: cwd, oldRelativePath: oldPath, newRelativePath: newPath });
      this.emit({
        type: "file_rename_response",
        payload: { cwd, oldPath, newPath, error: null, requestId },
      });
    } catch (error: unknown) {
      this.emit({
        type: "file_rename_response",
        payload: {
          cwd,
          oldPath,
          newPath,
          error: error instanceof Error ? error.message : String(error),
          requestId,
        },
      });
    }
  }

  private async handleFileDeleteRequest(request: FileDeleteRequest): Promise<void> {
    const { cwd: workspaceCwd, path: requestedPath, requestId } = request;
    const cwd = workspaceCwd.trim();
    if (!cwd) {
      this.emit({
        type: "file_delete_response",
        payload: { cwd: workspaceCwd, path: requestedPath, error: "cwd is required", requestId },
      });
      return;
    }
    try {
      await deleteExplorerEntry({ root: cwd, relativePath: requestedPath });
      this.emit({
        type: "file_delete_response",
        payload: { cwd, path: requestedPath, error: null, requestId },
      });
    } catch (error: unknown) {
      this.emit({
        type: "file_delete_response",
        payload: {
          cwd,
          path: requestedPath,
          error: error instanceof Error ? error.message : String(error),
          requestId,
        },
      });
    }
  }

  /**
   * Handle project icon request for a given cwd
   */
  private async handleProjectIconRequest(
    request: Extract<SessionInboundMessage, { type: "project_icon_request" }>,
  ): Promise<void> {
    const { cwd, requestId } = request;

    try {
      const icon = await getProjectIcon(cwd);
      this.emit({
        type: "project_icon_response",
        payload: {
          cwd,
          icon,
          error: null,
          requestId,
        },
      });
    } catch (error: any) {
      this.emit({
        type: "project_icon_response",
        payload: {
          cwd,
          icon: null,
          error: error.message,
          requestId,
        },
      });
    }
  }

  /**
   * Handle file download token request scoped to a workspace cwd
   */
  private async handleFileDownloadTokenRequest(request: FileDownloadTokenRequest): Promise<void> {
    const { cwd: workspaceCwd, path: requestedPath, requestId } = request;
    const cwd = workspaceCwd.trim();
    if (!cwd) {
      this.emit({
        type: "file_download_token_response",
        payload: {
          cwd: workspaceCwd,
          path: requestedPath,
          token: null,
          fileName: null,
          mimeType: null,
          size: null,
          error: "cwd is required",
          requestId,
        },
      });
      return;
    }

    this.sessionLogger.debug(
      { cwd, path: requestedPath },
      `Handling file download token request for workspace ${cwd} (${requestedPath})`,
    );

    try {
      const info = await getDownloadableFileInfo({
        root: cwd,
        relativePath: requestedPath,
      });

      const entry = this.downloadTokenStore.issueToken({
        path: info.path,
        absolutePath: info.absolutePath,
        fileName: info.fileName,
        mimeType: info.mimeType,
        size: info.size,
      });

      this.emit({
        type: "file_download_token_response",
        payload: {
          cwd,
          path: info.path,
          token: entry.token,
          fileName: entry.fileName,
          mimeType: entry.mimeType,
          size: entry.size,
          error: null,
          requestId,
        },
      });
    } catch (error: any) {
      this.sessionLogger.error(
        { err: error, cwd, path: requestedPath },
        `Failed to issue download token for workspace ${cwd}`,
      );
      this.emit({
        type: "file_download_token_response",
        payload: {
          cwd,
          path: requestedPath,
          token: null,
          fileName: null,
          mimeType: null,
          size: null,
          error: error.message,
          requestId,
        },
      });
    }
  }

  /**
   * Build the current agent list payload (live + persisted), optionally filtered by labels.
   */
  private async listAgentPayloads(filter?: {
    labels?: Record<string, string>;
  }): Promise<AgentSnapshotPayload[]> {
    // Get live agents with session modes
    const agentSnapshots = this.agentManager.listAgents();
    const liveAgents = await Promise.all(
      agentSnapshots.map((agent) => this.buildAgentPayload(agent)),
    );

    // Add persisted agents that have not been lazily initialized yet
    // (excluding internal agents which are for ephemeral system tasks)
    const registryRecords = await this.agentStorage.list();
    const liveIds = new Set(agentSnapshots.map((a) => a.id));
    const persistedAgents = registryRecords
      .filter((record) => !liveIds.has(record.id) && !record.internal)
      .map((record) => this.buildStoredAgentPayload(record));

    let agents = [...liveAgents, ...persistedAgents];

    // Filter by labels if filter provided
    if (filter?.labels) {
      const filterLabels = filter.labels;
      agents = agents.filter((agent) =>
        Object.entries(filterLabels).every(([key, value]) => agent.labels[key] === value),
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
      return await this.buildAgentPayload(live);
    }

    const record = await this.agentStorage.get(agentId);
    if (!record || record.internal) {
      return null;
    }
    return this.buildStoredAgentPayload(record);
  }

  private normalizeFetchAgentsSort(
    sort: FetchAgentsRequestSort[] | undefined,
  ): FetchAgentsRequestSort[] {
    const fallback: FetchAgentsRequestSort[] = [{ key: "updated_at", direction: "desc" }];
    if (!sort || sort.length === 0) {
      return fallback;
    }

    const deduped: FetchAgentsRequestSort[] = [];
    const seen = new Set<string>();
    for (const entry of sort) {
      if (seen.has(entry.key)) {
        continue;
      }
      seen.add(entry.key);
      deduped.push(entry);
    }
    return deduped.length > 0 ? deduped : fallback;
  }

  private getStatusPriority(agent: AgentSnapshotPayload): number {
    const attentionReason = agent.attentionReason ?? null;
    const hasPendingPermission = (agent.pendingPermissions?.length ?? 0) > 0;
    if (hasPendingPermission || attentionReason === "permission") {
      return 0;
    }
    if (agent.status === "error" || attentionReason === "error") {
      return 1;
    }
    if (agent.status === "running") {
      return 2;
    }
    if (agent.status === "initializing") {
      return 3;
    }
    return 4;
  }

  private getFetchAgentsSortValue(
    entry: FetchAgentsResponseEntry,
    key: FetchAgentsRequestSort["key"],
  ): string | number | null {
    switch (key) {
      case "status_priority":
        return this.getStatusPriority(entry.agent);
      case "created_at":
        return Date.parse(entry.agent.createdAt);
      case "updated_at":
        return Date.parse(entry.agent.updatedAt);
      case "title":
        return entry.agent.title?.toLocaleLowerCase() ?? "";
    }
  }

  private getFetchAgentsSortValueFromAgent(
    agent: AgentSnapshotPayload,
    key: FetchAgentsRequestSort["key"],
  ): string | number | null {
    switch (key) {
      case "status_priority":
        return this.getStatusPriority(agent);
      case "created_at":
        return Date.parse(agent.createdAt);
      case "updated_at":
        return Date.parse(agent.updatedAt);
      case "title":
        return agent.title?.toLocaleLowerCase() ?? "";
    }
  }

  private compareSortValues(left: string | number | null, right: string | number | null): number {
    if (left === right) {
      return 0;
    }
    if (left === null) {
      return -1;
    }
    if (right === null) {
      return 1;
    }
    if (typeof left === "number" && typeof right === "number") {
      return left < right ? -1 : 1;
    }
    return String(left).localeCompare(String(right));
  }

  private compareFetchAgentsAgents(
    left: AgentSnapshotPayload,
    right: AgentSnapshotPayload,
    sort: FetchAgentsRequestSort[],
  ): number {
    for (const spec of sort) {
      const leftValue = this.getFetchAgentsSortValueFromAgent(left, spec.key);
      const rightValue = this.getFetchAgentsSortValueFromAgent(right, spec.key);
      const base = this.compareSortValues(leftValue, rightValue);
      if (base === 0) {
        continue;
      }
      return spec.direction === "asc" ? base : -base;
    }
    return left.id.localeCompare(right.id);
  }

  private encodeFetchAgentsCursor(
    entry: FetchAgentsResponseEntry,
    sort: FetchAgentsRequestSort[],
  ): string {
    const values: Record<string, string | number | null> = {};
    for (const spec of sort) {
      values[spec.key] = this.getFetchAgentsSortValue(entry, spec.key);
    }
    return Buffer.from(
      JSON.stringify({
        sort,
        values,
        id: entry.agent.id,
      }),
      "utf8",
    ).toString("base64url");
  }

  private decodeFetchAgentsCursor(
    cursor: string,
    sort: FetchAgentsRequestSort[],
  ): FetchAgentsCursor {
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    } catch {
      throw new SessionRequestError("invalid_cursor", "Invalid fetch_agents cursor");
    }

    if (!parsed || typeof parsed !== "object") {
      throw new SessionRequestError("invalid_cursor", "Invalid fetch_agents cursor");
    }

    const payload = parsed as {
      sort?: unknown;
      values?: unknown;
      id?: unknown;
    };

    if (!Array.isArray(payload.sort) || typeof payload.id !== "string") {
      throw new SessionRequestError("invalid_cursor", "Invalid fetch_agents cursor");
    }
    if (!payload.values || typeof payload.values !== "object") {
      throw new SessionRequestError("invalid_cursor", "Invalid fetch_agents cursor");
    }

    const cursorSort: FetchAgentsRequestSort[] = [];
    for (const item of payload.sort) {
      if (
        !item ||
        typeof item !== "object" ||
        typeof (item as { key?: unknown }).key !== "string" ||
        typeof (item as { direction?: unknown }).direction !== "string"
      ) {
        throw new SessionRequestError("invalid_cursor", "Invalid fetch_agents cursor");
      }

      const key = (item as { key: string }).key;
      const direction = (item as { direction: string }).direction;
      if (
        (key !== "status_priority" &&
          key !== "created_at" &&
          key !== "updated_at" &&
          key !== "title") ||
        (direction !== "asc" && direction !== "desc")
      ) {
        throw new SessionRequestError("invalid_cursor", "Invalid fetch_agents cursor");
      }
      cursorSort.push({ key, direction });
    }

    if (
      cursorSort.length !== sort.length ||
      cursorSort.some(
        (entry, index) =>
          entry.key !== sort[index]?.key || entry.direction !== sort[index]?.direction,
      )
    ) {
      throw new SessionRequestError(
        "invalid_cursor",
        "fetch_agents cursor does not match current sort",
      );
    }

    return {
      sort: cursorSort,
      values: payload.values as Record<string, string | number | null>,
      id: payload.id,
    };
  }

  private compareAgentWithCursor(
    agent: AgentSnapshotPayload,
    cursor: FetchAgentsCursor,
    sort: FetchAgentsRequestSort[],
  ): number {
    for (const spec of sort) {
      const leftValue = this.getFetchAgentsSortValueFromAgent(agent, spec.key);
      const rightValue =
        cursor.values[spec.key] !== undefined ? (cursor.values[spec.key] ?? null) : null;
      const base = this.compareSortValues(leftValue, rightValue);
      if (base === 0) {
        continue;
      }
      return spec.direction === "asc" ? base : -base;
    }
    return agent.id.localeCompare(cursor.id);
  }

  private async listFetchAgentsEntries(
    request: Extract<SessionInboundMessage, { type: "fetch_agents_request" }>,
  ): Promise<{
    entries: FetchAgentsResponseEntry[];
    pageInfo: FetchAgentsResponsePageInfo;
  }> {
    const filter = request.filter;
    const sort = this.normalizeFetchAgentsSort(request.sort);

    const agents = await this.listAgentPayloads({
      labels: filter?.labels,
    });

    const placementByCwd = new Map<string, Promise<ProjectPlacementPayload>>();
    const getPlacement = (cwd: string): Promise<ProjectPlacementPayload> => {
      const existing = placementByCwd.get(cwd);
      if (existing) {
        return existing;
      }
      const placementPromise = this.buildProjectPlacement(cwd);
      placementByCwd.set(cwd, placementPromise);
      return placementPromise;
    };

    let candidates = [...agents];
    candidates.sort((left, right) => this.compareFetchAgentsAgents(left, right, sort));
    const cursorToken = request.page?.cursor;
    if (cursorToken) {
      const cursor = this.decodeFetchAgentsCursor(cursorToken, sort);
      candidates = candidates.filter(
        (agent) => this.compareAgentWithCursor(agent, cursor, sort) > 0,
      );
    }

    const limit = request.page?.limit ?? 200;

    const matchedEntries: FetchAgentsResponseEntry[] = [];
    const batchSize = 25;
    for (
      let start = 0;
      start < candidates.length && matchedEntries.length <= limit;
      start += batchSize
    ) {
      const batch = candidates.slice(start, start + batchSize);
      const batchEntries = await Promise.all(
        batch.map(async (agent) => ({
          agent,
          project: await getPlacement(agent.cwd),
        })),
      );
      for (const entry of batchEntries) {
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

    const pagedEntries = matchedEntries.slice(0, limit);
    const hasMore = matchedEntries.length > limit;
    const nextCursor =
      hasMore && pagedEntries.length > 0
        ? this.encodeFetchAgentsCursor(pagedEntries[pagedEntries.length - 1], sort)
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

  private readonly workspaceStatePriority: Record<WorkspaceStateBucket, number> = {
    needs_input: 0,
    failed: 1,
    running: 2,
    attention: 3,
    done: 4,
  };

  private deriveWorkspaceStateBucket(agent: AgentSnapshotPayload): WorkspaceStateBucket {
    const pendingPermissionCount = agent.pendingPermissions?.length ?? 0;
    if (pendingPermissionCount > 0 || agent.attentionReason === "permission") {
      return "needs_input";
    }
    if (agent.status === "error" || agent.attentionReason === "error") {
      return "failed";
    }
    if (agent.status === "running") {
      return "running";
    }
    if (agent.requiresAttention) {
      return "attention";
    }
    return "done";
  }

  private async describeWorkspaceRecord(
    workspace: PersistedWorkspaceRecord,
    projectRecord?: PersistedProjectRecord | null,
  ): Promise<WorkspaceDescriptorPayload> {
    const resolvedProjectRecord =
      projectRecord ?? (await this.projectRegistry.get(workspace.projectId));

    return {
      id: workspace.workspaceId,
      projectId: workspace.projectId,
      projectDisplayName: resolvedProjectRecord?.displayName ?? workspace.projectId,
      projectRootPath: resolvedProjectRecord?.rootPath ?? workspace.cwd,
      projectKind: resolvedProjectRecord?.kind ?? "non_git",
      workspaceKind: workspace.kind,
      name: workspace.displayName,
      status: "done",
      activityAt: null,
      diffStat: null,
      // Issue/integration data
      ...(workspace.issueContext ? { issueContext: workspace.issueContext } : {}),
      ...(workspace.issueMetadata ? { issueMetadata: workspace.issueMetadata } : {}),
      ...(workspace.prompt ? { prompt: workspace.prompt } : {}),
      ...(workspace.autoApprove != null ? { autoApprove: workspace.autoApprove } : {}),
      ...(workspace.kanbanStatus ? { kanbanStatus: workspace.kanbanStatus } : {}),
      ...(workspace.agentProvider ? { agentProvider: workspace.agentProvider } : {}),
      ...(workspace.agentMode ? { agentMode: workspace.agentMode } : {}),
      ...(workspace.orgId ? { orgId: workspace.orgId } : {}),
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
      isHubcodeOwnedWorktree: snapshot.git.isHubcodeOwnedWorktree,
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
      refreshedAt: snapshot.github.refreshedAt,
    };
  }

  private async describeWorkspaceRecordWithGitData(
    workspace: PersistedWorkspaceRecord,
    projectRecord?: PersistedProjectRecord | null,
  ): Promise<WorkspaceDescriptorPayload> {
    const base = await this.describeWorkspaceRecord(workspace, projectRecord);
    let displayName = workspace.displayName;
    if (workspace.kind !== "worktree") {
      try {
        const placement = await this.buildProjectPlacement(workspace.cwd);
        displayName = deriveWorkspaceDisplayName({
          cwd: workspace.cwd,
          checkout: placement.checkout,
        });
      } catch {
        // Fall back to the persisted label if checkout metadata is unavailable.
      }
    }

    let snapshot: WorkspaceGitRuntimeSnapshot | null = null;
    snapshot = this.workspaceGitService.peekSnapshot(workspace.cwd);

    return {
      ...base,
      name: displayName,
      diffStat: snapshot?.git.diffStat ?? null,
      gitRuntime: snapshot ? this.buildWorkspaceGitRuntimePayload(snapshot) : undefined,
      githubRuntime: snapshot ? this.buildWorkspaceGitHubRuntimePayload(snapshot) : undefined,
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

  private async buildWorkspaceDescriptorMap(options: {
    includeGitData: boolean;
    workspaceIds?: Iterable<string>;
  }): Promise<Map<string, WorkspaceDescriptorPayload>> {
    const [agents, persistedWorkspaces, persistedProjects] = await Promise.all([
      this.listAgentPayloads(),
      this.workspaceRegistry.list(),
      this.projectRegistry.list(),
    ]);

    const activeRecords = persistedWorkspaces.filter((workspace) => !workspace.archivedAt);
    const activeProjects = new Map(
      persistedProjects
        .filter((project) => !project.archivedAt)
        .map((project) => [project.projectId, project] as const),
    );
    const descriptorsByWorkspaceId = new Map<string, WorkspaceDescriptorPayload>();
    const workspaceIds = options.workspaceIds
      ? new Set(
          Array.from(options.workspaceIds, (workspaceId) =>
            normalizePersistedWorkspaceId(workspaceId),
          ),
        )
      : null;

    for (const workspace of activeRecords) {
      if (workspaceIds && !workspaceIds.has(workspace.workspaceId)) {
        continue;
      }
      const projectRecord = activeProjects.get(workspace.projectId) ?? null;
      descriptorsByWorkspaceId.set(
        workspace.workspaceId,
        await this.buildWorkspaceDescriptor({
          workspace,
          projectRecord,
          includeGitData: options.includeGitData,
        }),
      );
    }

    for (const agent of agents) {
      if (agent.archivedAt) {
        continue;
      }

      const workspaceId = this.resolveRegisteredWorkspaceIdForCwd(agent.cwd, activeRecords);
      const existing = descriptorsByWorkspaceId.get(workspaceId);
      if (!existing) {
        continue;
      }

      const bucket = this.deriveWorkspaceStateBucket(agent);
      if (this.workspaceStatePriority[bucket] < this.workspaceStatePriority[existing.status]) {
        existing.status = bucket;
      }
    }

    return descriptorsByWorkspaceId;
  }

  private resolveRegisteredWorkspaceIdForCwd(
    cwd: string,
    workspaces: PersistedWorkspaceRecord[],
  ): string {
    const normalizedCwd = normalizePersistedWorkspaceId(cwd);
    const exact = workspaces.find((workspace) => workspace.workspaceId === normalizedCwd);
    if (exact) {
      return exact.workspaceId;
    }

    let bestMatch: PersistedWorkspaceRecord | null = null;
    for (const workspace of workspaces) {
      const prefix = workspace.workspaceId.endsWith(sep)
        ? workspace.workspaceId
        : `${workspace.workspaceId}${sep}`;
      if (!normalizedCwd.startsWith(prefix)) {
        continue;
      }
      if (!bestMatch || workspace.workspaceId.length > bestMatch.workspaceId.length) {
        bestMatch = workspace;
      }
    }

    return bestMatch?.workspaceId ?? normalizedCwd;
  }

  private async listWorkspaceDescriptors(): Promise<WorkspaceDescriptorPayload[]> {
    return Array.from(
      (
        await this.buildWorkspaceDescriptorMap({
          includeGitData: true,
        })
      ).values(),
    );
  }

  private normalizeFetchWorkspacesSort(
    sort: FetchWorkspacesRequestSort[] | undefined,
  ): FetchWorkspacesRequestSort[] {
    const fallback: FetchWorkspacesRequestSort[] = [{ key: "activity_at", direction: "desc" }];
    if (!sort || sort.length === 0) {
      return fallback;
    }
    const deduped: FetchWorkspacesRequestSort[] = [];
    const seen = new Set<string>();
    for (const entry of sort) {
      if (seen.has(entry.key)) {
        continue;
      }
      seen.add(entry.key);
      deduped.push(entry);
    }
    return deduped.length > 0 ? deduped : fallback;
  }

  private getFetchWorkspacesSortValue(
    workspace: WorkspaceDescriptorPayload,
    key: FetchWorkspacesRequestSort["key"],
  ): string | number | null {
    switch (key) {
      case "status_priority":
        return this.workspaceStatePriority[workspace.status];
      case "activity_at":
        return workspace.activityAt ? Date.parse(workspace.activityAt) : null;
      case "name":
        return workspace.name.toLocaleLowerCase();
      case "project_id":
        return workspace.projectId.toLocaleLowerCase();
    }
  }

  private compareFetchWorkspacesEntries(
    left: WorkspaceDescriptorPayload,
    right: WorkspaceDescriptorPayload,
    sort: FetchWorkspacesRequestSort[],
  ): number {
    for (const spec of sort) {
      const leftValue = this.getFetchWorkspacesSortValue(left, spec.key);
      const rightValue = this.getFetchWorkspacesSortValue(right, spec.key);
      const base = this.compareSortValues(leftValue, rightValue);
      if (base === 0) {
        continue;
      }
      return spec.direction === "asc" ? base : -base;
    }
    return left.id.localeCompare(right.id);
  }

  private encodeFetchWorkspacesCursor(
    entry: FetchWorkspacesResponseEntry,
    sort: FetchWorkspacesRequestSort[],
  ): string {
    const values: Record<string, string | number | null> = {};
    for (const spec of sort) {
      values[spec.key] = this.getFetchWorkspacesSortValue(entry, spec.key);
    }
    return Buffer.from(
      JSON.stringify({
        sort,
        values,
        id: entry.id,
      }),
      "utf8",
    ).toString("base64url");
  }

  private decodeFetchWorkspacesCursor(
    cursor: string,
    sort: FetchWorkspacesRequestSort[],
  ): FetchWorkspacesCursor {
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    } catch {
      throw new SessionRequestError("invalid_cursor", "Invalid fetch_workspaces cursor");
    }

    if (!parsed || typeof parsed !== "object") {
      throw new SessionRequestError("invalid_cursor", "Invalid fetch_workspaces cursor");
    }

    const payload = parsed as {
      sort?: unknown;
      values?: unknown;
      id?: unknown;
    };

    if (!Array.isArray(payload.sort) || typeof payload.id !== "string") {
      throw new SessionRequestError("invalid_cursor", "Invalid fetch_workspaces cursor");
    }
    if (!payload.values || typeof payload.values !== "object") {
      throw new SessionRequestError("invalid_cursor", "Invalid fetch_workspaces cursor");
    }

    const cursorSort: FetchWorkspacesRequestSort[] = [];
    for (const item of payload.sort) {
      if (
        !item ||
        typeof item !== "object" ||
        typeof (item as { key?: unknown }).key !== "string" ||
        typeof (item as { direction?: unknown }).direction !== "string"
      ) {
        throw new SessionRequestError("invalid_cursor", "Invalid fetch_workspaces cursor");
      }

      const key = (item as { key: string }).key;
      const direction = (item as { direction: string }).direction;
      if (
        (key !== "status_priority" &&
          key !== "activity_at" &&
          key !== "name" &&
          key !== "project_id") ||
        (direction !== "asc" && direction !== "desc")
      ) {
        throw new SessionRequestError("invalid_cursor", "Invalid fetch_workspaces cursor");
      }
      cursorSort.push({ key, direction });
    }

    if (
      cursorSort.length !== sort.length ||
      cursorSort.some(
        (entry, index) =>
          entry.key !== sort[index]?.key || entry.direction !== sort[index]?.direction,
      )
    ) {
      throw new SessionRequestError(
        "invalid_cursor",
        "fetch_workspaces cursor does not match current sort",
      );
    }

    return {
      sort: cursorSort,
      values: payload.values as Record<string, string | number | null>,
      id: payload.id,
    };
  }

  private compareWorkspaceWithCursor(
    workspace: WorkspaceDescriptorPayload,
    cursor: FetchWorkspacesCursor,
    sort: FetchWorkspacesRequestSort[],
  ): number {
    for (const spec of sort) {
      const leftValue = this.getFetchWorkspacesSortValue(workspace, spec.key);
      const rightValue =
        cursor.values[spec.key] !== undefined ? (cursor.values[spec.key] ?? null) : null;
      const base = this.compareSortValues(leftValue, rightValue);
      if (base === 0) {
        continue;
      }
      return spec.direction === "asc" ? base : -base;
    }
    return workspace.id.localeCompare(cursor.id);
  }

  private matchesWorkspaceFilter(input: {
    workspace: WorkspaceDescriptorPayload;
    filter: FetchWorkspacesRequestFilter | undefined;
  }): boolean {
    const { workspace, filter } = input;
    if (!filter) {
      return true;
    }

    if (filter.projectId && filter.projectId.trim().length > 0) {
      if (workspace.projectId !== filter.projectId.trim()) {
        return false;
      }
    }

    if (filter.idPrefix && filter.idPrefix.trim().length > 0) {
      if (!workspace.id.startsWith(filter.idPrefix.trim())) {
        return false;
      }
    }

    if (filter.query && filter.query.trim().length > 0) {
      const query = filter.query.trim().toLocaleLowerCase();
      const haystacks = [workspace.name, workspace.projectId, workspace.id];
      if (!haystacks.some((value) => value.toLocaleLowerCase().includes(query))) {
        return false;
      }
    }

    return true;
  }

  private async listFetchWorkspacesEntries(
    request: Extract<SessionInboundMessage, { type: "fetch_workspaces_request" }>,
  ): Promise<{
    entries: FetchWorkspacesResponseEntry[];
    pageInfo: FetchWorkspacesResponsePageInfo;
  }> {
    const filter = request.filter;
    const sort = this.normalizeFetchWorkspacesSort(request.sort);
    let entries = await this.listWorkspaceDescriptors();
    entries = entries.filter((workspace) => this.matchesWorkspaceFilter({ workspace, filter }));
    entries.sort((left, right) => this.compareFetchWorkspacesEntries(left, right, sort));

    const cursorToken = request.page?.cursor;
    if (cursorToken) {
      const cursor = this.decodeFetchWorkspacesCursor(cursorToken, sort);
      entries = entries.filter(
        (workspace) => this.compareWorkspaceWithCursor(workspace, cursor, sort) > 0,
      );
    }

    const limit = request.page?.limit ?? 200;
    const pagedEntries = entries.slice(0, limit);
    const hasMore = entries.length > limit;
    const nextCursor =
      hasMore && pagedEntries.length > 0
        ? this.encodeFetchWorkspacesCursor(pagedEntries[pagedEntries.length - 1], sort)
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
    snapshotLatestActivityByWorkspaceId?: Map<string, number>;
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
        const snapshotLatestActivity = options?.snapshotLatestActivityByWorkspaceId?.get(
          payload.workspace.id,
        );
        if (typeof snapshotLatestActivity === "number") {
          const updateLatestActivity = payload.workspace.activityAt
            ? Date.parse(payload.workspace.activityAt)
            : Number.NEGATIVE_INFINITY;
          if (
            !Number.isNaN(updateLatestActivity) &&
            updateLatestActivity <= snapshotLatestActivity
          ) {
            continue;
          }
        }
      }
      this.emit({
        type: "workspace_update",
        payload,
      });
    }
  }

  private async ensureWorkspaceRegistered(
    cwd: string,
    options?: { orgId?: string },
  ): Promise<PersistedWorkspaceRecord> {
    return (await this.reconcileWorkspaceRecord(cwd, options)).workspace;
  }

  private async registerPendingWorktreeWorkspace(options: {
    repoRoot: string;
    worktreePath: string;
    branchName: string;
    workspaceName?: string;
    issueContext?: PersistedWorkspaceRecord["issueContext"];
    issueMetadata?: PersistedWorkspaceRecord["issueMetadata"];
    prompt?: string;
    autoApprove?: boolean;
    kanbanStatus?: PersistedWorkspaceRecord["kanbanStatus"];
    agentProvider?: string;
    agentMode?: PersistedWorkspaceRecord["agentMode"];
    orgId?: string;
  }): Promise<PersistedWorkspaceRecord> {
    return registerPendingWorktreeWorkspaceSession(
      {
        buildPersistedProjectRecord: (input) => this.buildPersistedProjectRecord(input),
        buildPersistedWorkspaceRecord: (input) => this.buildPersistedWorkspaceRecord(input),
        buildProjectPlacement: (cwd) => this.buildProjectPlacement(cwd),
        projectRegistry: this.projectRegistry,
        syncWorkspaceGitWatchTarget: (cwd, syncOptions) =>
          this.syncWorkspaceGitWatchTarget(cwd, syncOptions),
        workspaceRegistry: this.workspaceRegistry,
        archiveProjectRecordIfEmpty: (projectId, archivedAt) =>
          this.archiveProjectRecordIfEmpty(projectId, archivedAt),
      },
      options,
    );
  }

  private async archiveWorkspaceRecord(workspaceId: string, archivedAt?: string): Promise<void> {
    const existing = await this.workspaceRegistry.get(workspaceId);
    if (!existing || existing.archivedAt) {
      this.removeWorkspaceGitSubscription(workspaceId);
      return;
    }

    const nextArchivedAt = archivedAt ?? new Date().toISOString();
    await this.workspaceRegistry.archive(workspaceId, nextArchivedAt);
    this.removeWorkspaceGitSubscription(workspaceId);

    const siblingWorkspaces = (await this.workspaceRegistry.list()).filter(
      (workspace) => workspace.projectId === existing.projectId && !workspace.archivedAt,
    );
    if (siblingWorkspaces.length === 0) {
      await this.projectRegistry.archive(existing.projectId, nextArchivedAt);
    }
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

  private async emitWorkspaceUpdatesForWorkspaceIds(
    workspaceIds: Iterable<string>,
    options?: { skipReconcile?: boolean },
  ): Promise<void> {
    const subscription = this.workspaceUpdatesSubscription;
    if (!subscription) {
      return;
    }

    const uniqueWorkspaceIds = new Set(
      Array.from(workspaceIds, (workspaceId) => normalizePersistedWorkspaceId(workspaceId)),
    );
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

      if (!nextWorkspace) {
        subscription.lastEmittedByWorkspaceId.delete(workspaceId);
        this.bufferOrEmitWorkspaceUpdate(subscription, {
          kind: "remove",
          id: workspaceId,
        });
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

  private async emitWorkspaceUpdateForCwd(
    cwd: string,
    options?: { skipReconcile?: boolean },
  ): Promise<void> {
    const activeWorkspaces = (await this.workspaceRegistry.list()).filter(
      (workspace) => !workspace.archivedAt,
    );
    const workspaceId = this.resolveRegisteredWorkspaceIdForCwd(cwd, activeWorkspaces);
    await this.emitWorkspaceUpdatesForWorkspaceIds([workspaceId], options);
  }

  private async emitWorkspaceUpdatesForCwds(cwds: Iterable<string>): Promise<void> {
    const activeWorkspaces = (await this.workspaceRegistry.list()).filter(
      (workspace) => !workspace.archivedAt,
    );
    const uniqueWorkspaceIds = new Set<string>();
    for (const cwd of cwds) {
      uniqueWorkspaceIds.add(this.resolveRegisteredWorkspaceIdForCwd(cwd, activeWorkspaces));
    }
    await this.emitWorkspaceUpdatesForWorkspaceIds(uniqueWorkspaceIds);
  }

  private async handleFetchAgents(
    request: Extract<SessionInboundMessage, { type: "fetch_agents_request" }>,
  ): Promise<void> {
    const requestedSubscriptionId = request.subscribe?.subscriptionId?.trim();
    const subscriptionId = request.subscribe
      ? requestedSubscriptionId && requestedSubscriptionId.length > 0
        ? requestedSubscriptionId
        : uuidv4()
      : null;

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

      // TODO: Remove once all app store clients are on >=0.1.45.
      payload.entries = payload.entries.filter((entry) =>
        this.isProviderVisibleToClient(entry.agent.provider),
      );

      // Share-scoped filter: recipients only see agents inside their workspace.
      if (this.shareScope) {
        payload.entries = payload.entries.filter(
          (entry) => this.checkWorkspaceAccess(entry.agent.cwd) === null,
        );
        payload.pageInfo = { ...payload.pageInfo, hasMore: false, nextCursor: null };
      }

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

  private async handleFetchWorkspacesRequest(
    request: Extract<SessionInboundMessage, { type: "fetch_workspaces_request" }>,
  ): Promise<void> {
    const requestedSubscriptionId = request.subscribe?.subscriptionId?.trim();
    const subscriptionId = request.subscribe
      ? requestedSubscriptionId && requestedSubscriptionId.length > 0
        ? requestedSubscriptionId
        : uuidv4()
      : null;

    try {
      if (subscriptionId) {
        this.workspaceUpdatesSubscription = {
          subscriptionId,
          filter: request.filter,
          isBootstrapping: true,
          pendingUpdatesByWorkspaceId: new Map(),
          lastEmittedByWorkspaceId: new Map(),
        };
      }

      const payloadRaw = await this.listFetchWorkspacesEntries(request);
      // Share-scoped sessions get a filtered view: only the authorized workspace.
      const payload = this.shareScope
        ? {
            ...payloadRaw,
            entries: payloadRaw.entries.filter((e) => {
              const err = this.checkWorkspaceAccess(e.id);
              return err === null;
            }),
            pageInfo: { ...payloadRaw.pageInfo, hasMore: false, nextCursor: null },
          }
        : payloadRaw;
      const snapshotLatestActivityByWorkspaceId = new Map<string, number>();
      for (const entry of payload.entries) {
        const parsedLatestActivity = entry.activityAt
          ? Date.parse(entry.activityAt)
          : Number.NEGATIVE_INFINITY;
        if (!Number.isNaN(parsedLatestActivity)) {
          snapshotLatestActivityByWorkspaceId.set(entry.id, parsedLatestActivity);
        }
      }

      this.emit({
        type: "fetch_workspaces_response",
        payload: {
          requestId: request.requestId,
          ...(subscriptionId ? { subscriptionId } : {}),
          ...payload,
        },
      });

      if (subscriptionId && this.workspaceUpdatesSubscription?.subscriptionId === subscriptionId) {
        this.flushBootstrappedWorkspaceUpdates({ snapshotLatestActivityByWorkspaceId });
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

  private async handleOpenProjectRequest(
    request: Extract<SessionInboundMessage, { type: "open_project_request" }>,
  ): Promise<void> {
    try {
      const workspace = await this.ensureWorkspaceRegistered(request.cwd, {
        orgId: request.orgId,
      });
      await this.emitWorkspaceUpdateForCwd(workspace.cwd, {
        skipReconcile: true,
      });
      const descriptor = await this.describeWorkspaceRecordWithGitData(workspace);
      this.emit({
        type: "open_project_response",
        payload: {
          requestId: request.requestId,
          workspace: descriptor,
          error: null,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to open project";
      this.sessionLogger.error({ err: error, cwd: request.cwd }, "Failed to open project");
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

  /**
   * Clone a git repository into `<parentDir>/<directoryName>` using a detached
   * child process. Does not register the resulting directory as a project —
   * the client is expected to follow up with `open_project_request` once the
   * clone finishes so the normal project-discovery pipeline takes over.
   */
  private async handleCloneRepositoryRequest(
    request: Extract<SessionInboundMessage, { type: "clone_repository_request" }>,
  ): Promise<void> {
    const { requestId, remoteUrl, parentDir, directoryName } = request;
    try {
      const trimmedRemote = remoteUrl.trim();
      const trimmedParent = parentDir.trim();
      if (!trimmedRemote) throw new Error("remoteUrl is required");
      if (!trimmedParent) throw new Error("parentDir is required");

      const dirName = (directoryName ?? deriveRepoDirectoryName(trimmedRemote)).trim();
      if (!dirName || dirName.includes(sep) || dirName === "." || dirName === "..") {
        throw new Error("Invalid directory name");
      }

      const resolvedParent = resolve(trimmedParent);
      await mkdir(resolvedParent, { recursive: true });
      const target = join(resolvedParent, dirName);
      try {
        await stat(target);
        throw new Error(`Target already exists: ${target}`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
      }

      await runGitClone(trimmedRemote, target, this.sessionLogger);

      this.emit({
        type: "clone_repository_response",
        payload: { requestId, cwd: target, error: null },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to clone repository";
      this.sessionLogger.error({ err: error, remoteUrl }, "Failed to clone repository");
      this.emit({
        type: "clone_repository_response",
        payload: { requestId, cwd: null, error: message },
      });
    }
  }

  async getAvailableEditorTargets() {
    return this.filterEditorsForClient(await listAvailableEditorTargets());
  }

  async openEditorTarget(options: { editorId: EditorTargetId; path: string }): Promise<void> {
    await openInEditorTarget(options);
  }

  private async handleListAvailableEditorsRequest(
    request: Extract<SessionInboundMessage, { type: "list_available_editors_request" }>,
  ): Promise<void> {
    try {
      const editors = await this.getAvailableEditorTargets();
      this.emit({
        type: "list_available_editors_response",
        payload: {
          requestId: request.requestId,
          editors,
          error: null,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to list available editors";
      this.sessionLogger.error(
        { err: error, requestType: request.type },
        "Failed to list available editors",
      );
      this.emit({
        type: "list_available_editors_response",
        payload: {
          requestId: request.requestId,
          editors: [],
          error: message,
        },
      });
    }
  }

  private async handleOpenInEditorRequest(
    request: Extract<SessionInboundMessage, { type: "open_in_editor_request" }>,
  ): Promise<void> {
    try {
      await this.openEditorTarget({ editorId: request.editorId, path: request.path });
      this.emit({
        type: "open_in_editor_response",
        payload: {
          requestId: request.requestId,
          error: null,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to open in editor";
      this.sessionLogger.error(
        {
          err: error,
          editorId: request.editorId,
          path: request.path,
          requestType: request.type,
        },
        "Failed to open in editor",
      );
      this.emit({
        type: "open_in_editor_response",
        payload: {
          requestId: request.requestId,
          error: message,
        },
      });
    }
  }

  private async handleCreateHubcodeWorktreeRequest(
    request: Extract<SessionInboundMessage, { type: "create_hubcode_worktree_request" }>,
  ): Promise<void> {
    return handleCreateWorktreeRequest(
      {
        hubcodeHome: this.hubcodeHome,
        describeWorkspaceRecord: (workspace) => this.describeWorkspaceRecordWithGitData(workspace),
        emit: (message) => this.emit(message),
        registerPendingWorktreeWorkspace: (options) =>
          this.registerPendingWorktreeWorkspace(options),
        sessionLogger: this.sessionLogger,
        runWorktreeSetupInBackground: (options) => this.runWorktreeSetupInBackground(options),
      },
      request,
    );
  }

  private async runWorktreeSetupInBackground(options: {
    requestCwd: string;
    repoRoot: string;
    slug: string;
    worktreePath: string;
  }): Promise<void> {
    return runWorktreeSetupInBackgroundSession(
      {
        hubcodeHome: this.hubcodeHome,
        emitWorkspaceUpdateForCwd: (cwd) => this.emitWorkspaceUpdateForCwd(cwd),
        sessionLogger: this.sessionLogger,
        terminalManager: this.terminalManager,
      },
      options,
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
      if (existing.kind === "worktree") {
        throw new Error("Use worktree archive for Hubcode worktrees");
      }
      const archivedAt = new Date().toISOString();
      await this.archiveWorkspaceRecord(request.workspaceId, archivedAt);
      await this.emitWorkspaceUpdateForCwd(existing.cwd);
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

    const project = await this.buildProjectPlacement(agent.cwd);
    this.emit({
      type: "fetch_agent_response",
      payload: { requestId, agent, project, error: null },
    });
  }

  private async handleFetchAgentTimelineRequest(
    msg: Extract<SessionInboundMessage, { type: "fetch_agent_timeline_request" }>,
  ): Promise<void> {
    const direction: AgentTimelineFetchDirection = msg.direction ?? (msg.cursor ? "after" : "tail");
    const projection: TimelineProjectionMode = msg.projection ?? "projected";
    const requestedLimit = msg.limit;
    const limit = requestedLimit ?? (direction === "after" ? 0 : undefined);
    const shouldLimitByProjectedWindow =
      projection === "canonical" &&
      direction === "tail" &&
      typeof requestedLimit === "number" &&
      requestedLimit > 0;
    const cursor: AgentTimelineCursor | undefined = msg.cursor
      ? {
          epoch: msg.cursor.epoch,
          seq: msg.cursor.seq,
        }
      : undefined;

    try {
      const snapshot = await this.ensureAgentLoaded(msg.agentId);
      const agentPayload = await this.buildAgentPayload(snapshot);

      let timeline = this.agentManager.fetchTimeline(msg.agentId, {
        direction,
        cursor,
        limit:
          shouldLimitByProjectedWindow && typeof requestedLimit === "number"
            ? Math.max(1, Math.floor(requestedLimit))
            : limit,
      });

      let hasOlder = timeline.hasOlder;
      let hasNewer = timeline.hasNewer;
      let startCursor: { epoch: string; seq: number } | null = null;
      let endCursor: { epoch: string; seq: number } | null = null;
      let entries: ReturnType<typeof projectTimelineRows>;

      if (shouldLimitByProjectedWindow) {
        const projectedLimit = Math.max(1, Math.floor(requestedLimit));
        let fetchLimit = projectedLimit;
        let projectedWindow = selectTimelineWindowByProjectedLimit({
          rows: timeline.rows,
          provider: snapshot.provider,
          direction,
          limit: projectedLimit,
          collapseToolLifecycle: false,
        });

        while (timeline.hasOlder) {
          const needsMoreProjectedEntries =
            projectedWindow.projectedEntries.length < projectedLimit;
          const firstLoadedRow = timeline.rows[0];
          const firstSelectedRow = projectedWindow.selectedRows[0];
          const startsAtLoadedBoundary =
            firstLoadedRow != null &&
            firstSelectedRow != null &&
            firstSelectedRow.seq === firstLoadedRow.seq;
          const boundaryIsAssistantChunk =
            startsAtLoadedBoundary && firstLoadedRow.item.type === "assistant_message";

          if (!needsMoreProjectedEntries && !boundaryIsAssistantChunk) {
            break;
          }

          const maxRows = Math.max(0, timeline.window.maxSeq - timeline.window.minSeq + 1);
          const nextFetchLimit = Math.min(maxRows, fetchLimit * 2);
          if (nextFetchLimit <= fetchLimit) {
            break;
          }

          fetchLimit = nextFetchLimit;
          timeline = this.agentManager.fetchTimeline(msg.agentId, {
            direction,
            cursor,
            limit: fetchLimit,
          });
          projectedWindow = selectTimelineWindowByProjectedLimit({
            rows: timeline.rows,
            provider: snapshot.provider,
            direction,
            limit: projectedLimit,
            collapseToolLifecycle: false,
          });
        }

        const selectedRows = projectedWindow.selectedRows;

        entries = projectTimelineRows(selectedRows, snapshot.provider, projection);

        if (projectedWindow.minSeq !== null && projectedWindow.maxSeq !== null) {
          startCursor = { epoch: timeline.epoch, seq: projectedWindow.minSeq };
          endCursor = { epoch: timeline.epoch, seq: projectedWindow.maxSeq };
          hasOlder = projectedWindow.minSeq > timeline.window.minSeq;
          hasNewer = false;
        }
      } else {
        const firstRow = timeline.rows[0];
        const lastRow = timeline.rows[timeline.rows.length - 1];
        startCursor = firstRow ? { epoch: timeline.epoch, seq: firstRow.seq } : null;
        endCursor = lastRow ? { epoch: timeline.epoch, seq: lastRow.seq } : null;
        entries = projectTimelineRows(timeline.rows, snapshot.provider, projection);
      }

      this.emit({
        type: "fetch_agent_timeline_response",
        payload: {
          requestId: msg.requestId,
          agentId: msg.agentId,
          agent: agentPayload,
          direction,
          projection,
          epoch: timeline.epoch,
          reset: timeline.reset,
          staleCursor: timeline.staleCursor,
          gap: timeline.gap,
          window: timeline.window,
          startCursor,
          endCursor,
          hasOlder,
          hasNewer,
          entries,
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
      await this.unarchiveAgentState(agentId);

      await this.ensureAgentLoaded(agentId);

      this.sessionLogger.trace(
        { agentId, messageId: msg.messageId, textPrefix: msg.text.slice(0, 80) },
        "send_agent_message_request: recording user message",
      );
      try {
        this.agentManager.recordUserMessage(agentId, msg.text, {
          messageId: msg.messageId,
          emitState: false,
          ...(msg.author ? { author: msg.author } : {}),
        });
      } catch (error) {
        this.sessionLogger.error(
          { err: error, agentId },
          "Failed to record user message for send_agent_message_request",
        );
      }

      const prompt = this.buildAgentPrompt(msg.text, msg.images);
      this.sessionLogger.trace(
        { agentId, messageId: msg.messageId },
        "send_agent_message_request: starting agent stream",
      );
      const started = this.startAgentStream(agentId, prompt);
      if (!started.ok) {
        this.emit({
          type: "send_agent_message_response",
          payload: {
            requestId: msg.requestId,
            agentId,
            accepted: false,
            error: started.error,
          },
        });
        return;
      }

      const startAbort = new AbortController();
      const startTimeoutMs = 15_000;
      const startTimeout = setTimeout(() => startAbort.abort("timeout"), startTimeoutMs);
      try {
        await this.agentManager.waitForAgentRunStart(agentId, { signal: startAbort.signal });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : "Unknown error";
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
      } finally {
        clearTimeout(startTimeout);
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
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : "Unknown error";
      this.emit({
        type: "send_agent_message_response",
        payload: {
          requestId: msg.requestId,
          agentId: resolved.agentId,
          accepted: false,
          error: message,
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
      const status =
        record.attentionReason === "permission"
          ? "permission"
          : record.lastStatus === "error"
            ? "error"
            : "idle";
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

      let status: "permission" | "error" | "idle" = result.permission
        ? "permission"
        : result.status === "error"
          ? "error"
          : "idle";
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
        const message =
          error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : "Unknown error";
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
        throw new Error(`Agent ${agentId} disappeared while waiting`);
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
   * Handle audio chunk for buffering and transcription
   */
  private async handleAudioChunk(
    msg: Extract<SessionInboundMessage, { type: "voice_audio_chunk" }>,
  ): Promise<void> {
    if (!this.isVoiceMode) {
      this.sessionLogger.warn(
        "Received voice_audio_chunk while voice mode is disabled; transcript will be emitted but voice assistant turn is skipped",
      );
    }

    const chunkFormat = msg.format || "audio/wav";

    if (this.isVoiceMode) {
      if (!this.voiceTurnController) {
        throw new Error("Voice mode is enabled but the voice turn controller is not running");
      }
      const chunkBytes = Buffer.byteLength(msg.audio, "base64");
      this.voiceInputChunkCount += 1;
      this.voiceInputBytes += chunkBytes;
      if (this.voiceInputChunkCount === 1) {
        this.sessionLogger.info(
          {
            format: chunkFormat,
            audioBytes: chunkBytes,
          },
          "Received first voice_audio_chunk for active voice mode",
        );
      }
      const now = Date.now();
      if (this.voiceInputChunkCount % 50 === 0 || now - this.voiceInputWindowStartedAt >= 1000) {
        this.sessionLogger.info(
          {
            chunkCount: this.voiceInputChunkCount,
            audioBytes: this.voiceInputBytes,
            windowMs: now - this.voiceInputWindowStartedAt,
            format: chunkFormat,
          },
          "Voice input chunk summary",
        );
        this.voiceInputWindowStartedAt = now;
        this.voiceInputChunkCount = 0;
        this.voiceInputBytes = 0;
      }
      await this.voiceTurnController.appendClientChunk({
        audioBase64: msg.audio,
        format: chunkFormat,
      });
      return;
    }

    const chunkBuffer = Buffer.from(msg.audio, "base64");
    const isPCMChunk = chunkFormat.toLowerCase().includes("pcm");

    if (!this.audioBuffer) {
      this.audioBuffer = {
        chunks: [],
        format: chunkFormat,
        isPCM: isPCMChunk,
        totalPCMBytes: 0,
      };
    }

    // If the format changes mid-stream, flush what we have first
    if (this.audioBuffer.isPCM !== isPCMChunk) {
      this.sessionLogger.debug(
        {
          oldFormat: this.audioBuffer.isPCM ? "pcm" : this.audioBuffer.format,
          newFormat: chunkFormat,
        },
        `Audio format changed mid-stream, flushing current buffer`,
      );
      const finalized = this.finalizeBufferedAudio();
      if (finalized) {
        await this.processCompletedAudio(finalized.audio, finalized.format);
      }
      this.audioBuffer = {
        chunks: [],
        format: chunkFormat,
        isPCM: isPCMChunk,
        totalPCMBytes: 0,
      };
    } else if (!this.audioBuffer.isPCM) {
      // Keep latest format info for non-PCM blobs
      this.audioBuffer.format = chunkFormat;
    }

    this.audioBuffer.chunks.push(chunkBuffer);
    if (this.audioBuffer.isPCM) {
      this.audioBuffer.totalPCMBytes += chunkBuffer.length;
    }

    // In non-voice mode, use streaming threshold to process chunks
    const reachedStreamingThreshold =
      !this.isVoiceMode &&
      this.audioBuffer.isPCM &&
      this.audioBuffer.totalPCMBytes >= MIN_STREAMING_SEGMENT_BYTES;

    if (!msg.isLast && reachedStreamingThreshold) {
      return;
    }

    const bufferedState = this.audioBuffer;
    const finalized = this.finalizeBufferedAudio();
    if (!finalized) {
      return;
    }

    if (!msg.isLast && reachedStreamingThreshold) {
      this.sessionLogger.debug(
        {
          minDuration: MIN_STREAMING_SEGMENT_DURATION_MS,
          pcmBytes: bufferedState?.totalPCMBytes ?? 0,
        },
        `Minimum chunk duration reached (~${MIN_STREAMING_SEGMENT_DURATION_MS}ms, ${
          bufferedState?.totalPCMBytes ?? 0
        } PCM bytes) – triggering STT`,
      );
    } else {
      this.sessionLogger.debug(
        { audioBytes: finalized.audio.length, chunks: bufferedState?.chunks.length ?? 0 },
        `Complete audio segment (${finalized.audio.length} bytes, ${bufferedState?.chunks.length ?? 0} chunk(s))`,
      );
    }

    await this.processCompletedAudio(finalized.audio, finalized.format);
  }

  private finalizeBufferedAudio(): { audio: Buffer; format: string } | null {
    if (!this.audioBuffer) {
      return null;
    }

    const bufferState = this.audioBuffer;
    this.audioBuffer = null;

    if (bufferState.isPCM) {
      const pcmBuffer = Buffer.concat(bufferState.chunks);
      const wavBuffer = convertPCMToWavBuffer(
        pcmBuffer,
        PCM_SAMPLE_RATE,
        PCM_CHANNELS,
        PCM_BITS_PER_SAMPLE,
      );
      return {
        audio: wavBuffer,
        format: "audio/wav",
      };
    }

    return {
      audio: Buffer.concat(bufferState.chunks),
      format: bufferState.format,
    };
  }

  private async processCompletedAudio(audio: Buffer, format: string): Promise<void> {
    if (this.processingPhase === "transcribing") {
      this.sessionLogger.debug(
        { phase: this.processingPhase, segmentCount: this.pendingAudioSegments.length + 1 },
        `Buffering audio segment (phase: ${this.processingPhase})`,
      );
      this.pendingAudioSegments.push({
        audio,
        format,
      });
      this.setBufferTimeout();
      return;
    }

    if (this.pendingAudioSegments.length > 0) {
      this.pendingAudioSegments.push({
        audio,
        format,
      });
      this.sessionLogger.debug(
        { segmentCount: this.pendingAudioSegments.length },
        `Processing ${this.pendingAudioSegments.length} buffered segments together`,
      );

      const pendingSegments = [...this.pendingAudioSegments];
      this.pendingAudioSegments = [];
      this.clearBufferTimeout();

      const combinedAudio = Buffer.concat(pendingSegments.map((segment) => segment.audio));
      const combinedFormat = pendingSegments[pendingSegments.length - 1].format;

      await this.processAudio(combinedAudio, combinedFormat);
      return;
    }

    await this.processAudio(audio, format);
  }

  private async flushPendingAudioSegments(reason: string): Promise<void> {
    if (this.processingPhase === "transcribing" || this.pendingAudioSegments.length === 0) {
      return;
    }

    const pendingSegments = [...this.pendingAudioSegments];
    this.pendingAudioSegments = [];
    this.clearBufferTimeout();

    this.sessionLogger.debug(
      { reason, segmentCount: pendingSegments.length },
      `Flushing ${pendingSegments.length} buffered audio segment(s)`,
    );

    const combinedAudio = Buffer.concat(pendingSegments.map((segment) => segment.audio));
    const combinedFormat = pendingSegments[pendingSegments.length - 1]!.format;

    await this.processAudio(combinedAudio, combinedFormat);
  }

  /**
   * Process audio through STT and then LLM
   */
  private async processAudio(audio: Buffer, format: string): Promise<void> {
    this.setPhase("transcribing");

    this.emit({
      type: "activity_log",
      payload: {
        id: uuidv4(),
        timestamp: new Date(),
        type: "system",
        content: "Transcribing audio...",
      },
    });

    try {
      const requestId = uuidv4();
      const result = await this.sttManager.transcribe(audio, format, {
        requestId,
        label: this.isVoiceMode ? "voice" : "buffered",
      });

      const transcriptText = result.text.trim();
      this.sessionLogger.info(
        {
          requestId,
          isVoiceMode: this.isVoiceMode,
          transcriptLength: transcriptText.length,
          transcript: transcriptText,
        },
        "Transcription result",
      );

      await this.handleTranscriptionResultPayload({
        text: result.text,
        language: result.language,
        duration: result.duration,
        requestId,
        avgLogprob: result.avgLogprob,
        isLowConfidence: result.isLowConfidence,
        byteLength: result.byteLength,
        format: result.format,
        debugRecordingPath: result.debugRecordingPath,
      });
    } catch (error: any) {
      this.setPhase("idle");
      this.clearSpeechInProgress("transcription error");
      await this.flushPendingAudioSegments("transcription error");
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Transcription error: ${error.message}`,
        },
      });
      throw error;
    }
  }

  private async handleTranscriptionResultPayload(
    result: VoiceTranscriptionResultPayload,
  ): Promise<void> {
    const transcriptText = result.text.trim();

    this.emit({
      type: "transcription_result",
      payload: {
        text: result.text,
        ...(result.language ? { language: result.language } : {}),
        ...(result.duration !== undefined ? { duration: result.duration } : {}),
        requestId: result.requestId,
        ...(result.avgLogprob !== undefined ? { avgLogprob: result.avgLogprob } : {}),
        ...(result.isLowConfidence !== undefined
          ? { isLowConfidence: result.isLowConfidence }
          : {}),
        ...(result.byteLength !== undefined ? { byteLength: result.byteLength } : {}),
        ...(result.format ? { format: result.format } : {}),
        ...(result.debugRecordingPath ? { debugRecordingPath: result.debugRecordingPath } : {}),
      },
    });

    if (!transcriptText) {
      this.sessionLogger.debug("Empty transcription (false positive), not aborting");
      this.setPhase("idle");
      this.clearSpeechInProgress("empty transcription");
      await this.flushPendingAudioSegments("empty transcription");
      return;
    }

    // Has content - abort any in-progress stream now
    this.createAbortController();

    if (result.debugRecordingPath) {
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "system",
          content: `Saved input audio: ${result.debugRecordingPath}`,
          metadata: {
            recordingPath: result.debugRecordingPath,
            ...(result.format ? { format: result.format } : {}),
            requestId: result.requestId,
          },
        },
      });
    }

    this.emit({
      type: "activity_log",
      payload: {
        id: uuidv4(),
        timestamp: new Date(),
        type: "transcript",
        content: result.text,
        metadata: {
          ...(result.language ? { language: result.language } : {}),
          ...(result.duration !== undefined ? { duration: result.duration } : {}),
        },
      },
    });

    this.clearSpeechInProgress("transcription complete");
    this.setPhase("idle");
    if (!this.isVoiceMode) {
      this.sessionLogger.debug(
        { requestId: result.requestId },
        "Skipping voice agent processing because voice mode is disabled",
      );
      await this.flushPendingAudioSegments("voice mode disabled");
      return;
    }

    const agentId = this.voiceModeAgentId;
    if (!agentId) {
      this.sessionLogger.warn(
        { requestId: result.requestId },
        "Skipping voice agent processing because no agent is currently voice-enabled",
      );
      await this.flushPendingAudioSegments("no active voice agent");
      return;
    }

    await this.handleSendAgentMessage(agentId, result.text, undefined, undefined, undefined, {
      spokenInput: true,
    });
    await this.flushPendingAudioSegments("transcription complete");
  }

  private registerVoiceBridgeForAgent(agentId: string): void {
    this.registerVoiceSpeakHandler?.(agentId, async ({ text, signal }) => {
      this.sessionLogger.info(
        {
          agentId,
          textLength: text.length,
          preview: text.slice(0, 160),
        },
        "Voice speak tool call received by session handler",
      );
      const abortSignal = signal ?? this.abortController.signal;
      await this.ttsManager.generateAndWaitForPlayback(
        text,
        (msg) => this.emit(msg),
        abortSignal,
        true,
      );
      this.sessionLogger.info(
        { agentId, textLength: text.length },
        "Voice speak tool call finished playback",
      );
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "assistant",
          content: text,
        },
      });
    });

    this.registerVoiceCallerContext?.(agentId, {
      childAgentDefaultLabels: {},
      allowCustomCwd: false,
      enableVoiceTools: true,
    });
  }

  /**
   * Handle abort request from client
   */
  private async handleAbort(): Promise<void> {
    this.sessionLogger.info(
      { phase: this.processingPhase },
      `Abort request, phase: ${this.processingPhase}`,
    );

    this.abortController.abort();
    this.ttsManager.cancelPendingPlaybacks("abort request");

    // Voice abort should always interrupt active agent output immediately.
    if (this.isVoiceMode && this.voiceModeAgentId) {
      try {
        await this.interruptAgentIfRunning(this.voiceModeAgentId);
      } catch (error) {
        this.sessionLogger.warn(
          { err: error, agentId: this.voiceModeAgentId },
          "Failed to interrupt active voice-mode agent on abort",
        );
      }
    }

    if (this.processingPhase === "transcribing") {
      // Still in STT phase - we'll buffer the next audio
      this.sessionLogger.debug("Will buffer next audio (currently transcribing)");
      // Phase stays as 'transcribing', handleAudioChunk will handle buffering
      return;
    }

    // Reset phase to idle and clear pending non-voice buffers.
    this.setPhase("idle");
    this.pendingAudioSegments = [];
    this.clearBufferTimeout();
  }

  /**
   * Handle audio playback confirmation from client
   */
  private handleAudioPlayed(id: string): void {
    this.ttsManager.confirmAudioPlayed(id);
  }

  /**
   * Mark speech detection start and abort any active playback/agent run.
   */
  private async handleVoiceSpeechStart(): Promise<void> {
    if (this.speechInProgress) {
      return;
    }

    const chunkReceivedAt = Date.now();
    const phaseBeforeAbort = this.processingPhase;
    const hadActiveStream = this.hasActiveAgentRun(this.voiceModeAgentId);

    this.speechInProgress = true;
    this.sessionLogger.debug("Voice speech detected – aborting playback and active agent run");

    if (this.pendingAudioSegments.length > 0) {
      this.sessionLogger.debug(
        { segmentCount: this.pendingAudioSegments.length },
        `Dropping ${this.pendingAudioSegments.length} buffered audio segment(s) due to voice speech`,
      );
      this.pendingAudioSegments = [];
    }

    if (this.audioBuffer) {
      this.sessionLogger.debug(
        { chunks: this.audioBuffer.chunks.length, pcmBytes: this.audioBuffer.totalPCMBytes },
        `Clearing partial audio buffer (${this.audioBuffer.chunks.length} chunk(s)${
          this.audioBuffer.isPCM ? `, ${this.audioBuffer.totalPCMBytes} PCM bytes` : ""
        })`,
      );
      this.audioBuffer = null;
    }

    this.clearBufferTimeout();

    this.abortController.abort();
    await this.handleAbort();

    const latencyMs = Date.now() - chunkReceivedAt;
    this.sessionLogger.debug(
      { latencyMs, phaseBeforeAbort, hadActiveStream },
      "[Telemetry] barge_in.llm_abort_latency",
    );
  }

  /**
   * Clear speech-in-progress flag once the user turn has completed
   */
  private clearSpeechInProgress(reason: string): void {
    this.clearPendingVoiceSpeechStart(`clear-speech-in-progress:${reason}`);
    if (!this.speechInProgress) {
      return;
    }

    this.speechInProgress = false;
    this.sessionLogger.debug({ reason }, `Speech turn complete (${reason}) – resuming TTS`);
  }

  /**
   * Create new AbortController, aborting the previous one
   */
  private createAbortController(): AbortController {
    this.abortController.abort();
    this.abortController = new AbortController();
    this.ttsDebugStreams.clear();
    return this.abortController;
  }

  /**
   * Set the processing phase
   */
  private setPhase(phase: ProcessingPhase): void {
    this.processingPhase = phase;
    this.sessionLogger.debug({ phase }, `Phase: ${phase}`);
  }

  /**
   * Set timeout to process buffered audio segments
   */
  private setBufferTimeout(): void {
    this.clearBufferTimeout();

    this.bufferTimeout = setTimeout(async () => {
      this.sessionLogger.debug("Buffer timeout reached, processing pending segments");

      if (this.processingPhase === "transcribing") {
        this.sessionLogger.debug(
          { segmentCount: this.pendingAudioSegments.length },
          "Buffer timeout deferred because transcription is still in progress",
        );
        this.setBufferTimeout();
        return;
      }

      if (this.pendingAudioSegments.length > 0) {
        const segments = [...this.pendingAudioSegments];
        this.pendingAudioSegments = [];
        this.bufferTimeout = null;

        const combined = Buffer.concat(segments.map((s) => s.audio));
        await this.processAudio(combined, segments[0].format);
      }
    }, 10000); // 10 second timeout
  }

  /**
   * Clear buffer timeout
   */
  private clearBufferTimeout(): void {
    if (this.bufferTimeout) {
      clearTimeout(this.bufferTimeout);
      this.bufferTimeout = null;
    }
  }

  /**
   * Emit a message to the client
   */
  private emit(msg: SessionOutboundMessage): void {
    this.sessionLogger.trace(
      { messageType: msg.type, payloadBytes: JSON.stringify(msg).length },
      "outbound message",
    );
    if (
      msg.type === "audio_output" &&
      (process.env.TTS_DEBUG_AUDIO_DIR || isHubcodeDictationDebugEnabled()) &&
      msg.payload.groupId &&
      typeof msg.payload.audio === "string"
    ) {
      const groupId = msg.payload.groupId;
      const existing =
        this.ttsDebugStreams.get(groupId) ??
        ({ format: msg.payload.format, chunks: [] } satisfies {
          format: string;
          chunks: Buffer[];
        });

      try {
        existing.chunks.push(Buffer.from(msg.payload.audio, "base64"));
        existing.format = msg.payload.format;
        this.ttsDebugStreams.set(groupId, existing);
      } catch {
        // ignore malformed base64
      }

      if (msg.payload.isLastChunk) {
        const final = this.ttsDebugStreams.get(groupId);
        this.ttsDebugStreams.delete(groupId);
        if (final && final.chunks.length > 0) {
          void (async () => {
            const recordingPath = await maybePersistTtsDebugAudio(
              Buffer.concat(final.chunks),
              { sessionId: this.sessionId, groupId, format: final.format },
              this.sessionLogger,
            );
            if (recordingPath) {
              this.onMessage({
                type: "activity_log",
                payload: {
                  id: uuidv4(),
                  timestamp: new Date(),
                  type: "system",
                  content: `Saved TTS audio: ${recordingPath}`,
                  metadata: { recordingPath, format: final.format, groupId },
                },
              });
            }
          })();
        }
      }
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
    this.sessionLogger.trace("Cleaning up");

    if (this.unsubscribeAgentEvents) {
      this.unsubscribeAgentEvents();
      this.unsubscribeAgentEvents = null;
    }
    if (this.unsubscribeProviderSnapshotEvents) {
      this.unsubscribeProviderSnapshotEvents();
      this.unsubscribeProviderSnapshotEvents = null;
    }

    // Abort any ongoing operations
    this.abortController.abort();

    // Clear timeouts
    this.clearBufferTimeout();

    // Clear buffers
    this.pendingAudioSegments = [];
    this.audioBuffer = null;
    await this.stopVoiceTurnController();

    // Cleanup managers
    this.ttsManager.cleanup();
    this.sttManager.cleanup();
    this.dictationStreamManager.cleanupAll();

    // Note: browserManager is shared — disposed by bootstrap, not per-session.
    if (this.unsubscribeBrowserLaunched) {
      this.unsubscribeBrowserLaunched();
      this.unsubscribeBrowserLaunched = null;
    }
    if (this.unsubscribeClientBrowserLaunched) {
      this.unsubscribeClientBrowserLaunched();
      this.unsubscribeClientBrowserLaunched = null;
    }
    // Release our emit closure on the shared clientBrowserManager so any
    // pending browser tool call from the agent fails fast with "Client
    // disconnected" instead of hanging for the full command timeout.
    if (this.releaseClientBrowserEmit) {
      this.releaseClientBrowserEmit();
      this.releaseClientBrowserEmit = null;
    }

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

    await this.disableVoiceModeForActiveAgent(true);
    this.isVoiceMode = false;

    // Unsubscribe from all terminals
    if (this.unsubscribeTerminalsChanged) {
      this.unsubscribeTerminalsChanged();
      this.unsubscribeTerminalsChanged = null;
    }
    this.subscribedTerminalDirectories.clear();

    for (const unsubscribeExit of this.terminalExitSubscriptions.values()) {
      unsubscribeExit();
    }
    this.terminalExitSubscriptions.clear();
    this.disposeTerminalSubscriptions();

    if (this.unsubscribeIndexingStatus) {
      this.unsubscribeIndexingStatus();
      this.unsubscribeIndexingStatus = null;
    }
    if (this.unsubscribeIndexingProcessState) {
      this.unsubscribeIndexingProcessState();
      this.unsubscribeIndexingProcessState = null;
    }
    if (this.unsubscribeIndexingToolsChanged) {
      this.unsubscribeIndexingToolsChanged();
      this.unsubscribeIndexingToolsChanged = null;
    }
    if (this.unsubscribeIndexingFsTrigger) {
      this.unsubscribeIndexingFsTrigger();
      this.unsubscribeIndexingFsTrigger = null;
    }

    for (const unsubscribe of this.checkoutDiffSubscriptions.values()) {
      unsubscribe();
    }
    this.checkoutDiffSubscriptions.clear();

    for (const unsubscribe of this.workspaceGitSubscriptions.values()) {
      unsubscribe();
    }
    this.workspaceGitSubscriptions.clear();
  }

  // ============================================================================
  // Terminal Handlers
  // ============================================================================

  private ensureTerminalExitSubscription(terminal: TerminalSession): void {
    if (this.terminalExitSubscriptions.has(terminal.id)) {
      return;
    }

    const unsubscribeExit = terminal.onExit(() => {
      this.handleTerminalExited(terminal.id);
    });
    this.terminalExitSubscriptions.set(terminal.id, unsubscribeExit);
  }

  private handleTerminalExited(terminalId: string): void {
    const unsubscribeExit = this.terminalExitSubscriptions.get(terminalId);
    if (unsubscribeExit) {
      unsubscribeExit();
      this.terminalExitSubscriptions.delete(terminalId);
    }

    this.detachTerminalStream(terminalId, { emitExit: true });
  }

  private emitChatRpcError(request: { requestId: string; type: string }, error: unknown): void {
    const message = error instanceof Error ? error.message : "Chat request failed";
    const code = error instanceof ChatServiceError ? error.code : "chat_request_failed";
    this.sessionLogger.error({ err: error, requestType: request.type }, "Chat request failed");
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

  private async handleChatCreateRequest(
    request: Extract<SessionInboundMessage, { type: "chat/create" }>,
  ): Promise<void> {
    try {
      const room = await this.chatService.createRoom({
        name: request.name,
        purpose: request.purpose,
      });
      this.emit({
        type: "chat/create/response",
        payload: {
          requestId: request.requestId,
          room,
          error: null,
        },
      });
    } catch (error) {
      this.emitChatRpcError(request, error);
    }
  }

  private async handleChatListRequest(
    request: Extract<SessionInboundMessage, { type: "chat/list" }>,
  ): Promise<void> {
    try {
      const rooms = await this.chatService.listRooms();
      this.emit({
        type: "chat/list/response",
        payload: {
          requestId: request.requestId,
          rooms,
          error: null,
        },
      });
    } catch (error) {
      this.emitChatRpcError(request, error);
    }
  }

  private async handleChatInspectRequest(
    request: Extract<SessionInboundMessage, { type: "chat/inspect" }>,
  ): Promise<void> {
    try {
      const result = await this.chatService.inspectRoom({
        room: request.room,
      });
      this.emit({
        type: "chat/inspect/response",
        payload: {
          requestId: request.requestId,
          room: result.room,
          error: null,
        },
      });
    } catch (error) {
      this.emitChatRpcError(request, error);
    }
  }

  private async handleChatDeleteRequest(
    request: Extract<SessionInboundMessage, { type: "chat/delete" }>,
  ): Promise<void> {
    try {
      const result = await this.chatService.deleteRoom({
        room: request.room,
      });
      this.emit({
        type: "chat/delete/response",
        payload: {
          requestId: request.requestId,
          room: result.room,
          error: null,
        },
      });
    } catch (error) {
      this.emitChatRpcError(request, error);
    }
  }

  private async handleChatPostRequest(
    request: Extract<SessionInboundMessage, { type: "chat/post" }>,
  ): Promise<void> {
    try {
      const authorAgentId = request.authorAgentId?.trim() || this.clientId;
      const message = await this.chatService.postMessage({
        room: request.room,
        authorAgentId,
        body: request.body,
        replyToMessageId: request.replyToMessageId,
      });
      this.emit({
        type: "chat/post/response",
        payload: {
          requestId: request.requestId,
          message,
          error: null,
        },
      });
      void notifyChatMentions({
        room: request.room,
        authorAgentId,
        body: request.body,
        mentionAgentIds: message.mentionAgentIds,
        logger: this.sessionLogger,
        listStoredAgents: () => this.agentStorage.list(),
        listLiveAgents: () => this.agentManager.listAgents(),
        resolveAgentIdentifier: (identifier) => this.resolveAgentIdentifier(identifier),
        sendAgentMessage: async (agentId, text) => {
          await this.handleSendAgentMessage(agentId, text);
        },
      });
    } catch (error) {
      this.emitChatRpcError(request, error);
    }
  }

  private async handleChatReadRequest(
    request: Extract<SessionInboundMessage, { type: "chat/read" }>,
  ): Promise<void> {
    try {
      const messages = await this.chatService.readMessages({
        room: request.room,
        limit: request.limit,
        since: request.since,
        authorAgentId: request.authorAgentId,
      });
      this.emit({
        type: "chat/read/response",
        payload: {
          requestId: request.requestId,
          messages,
          error: null,
        },
      });
    } catch (error) {
      this.emitChatRpcError(request, error);
    }
  }

  private async handleChatWaitRequest(
    request: Extract<SessionInboundMessage, { type: "chat/wait" }>,
  ): Promise<void> {
    try {
      const messages = await this.chatService.waitForMessages({
        room: request.room,
        afterMessageId: request.afterMessageId,
        timeoutMs: request.timeoutMs,
      });
      this.emit({
        type: "chat/wait/response",
        payload: {
          requestId: request.requestId,
          messages,
          timedOut: messages.length === 0,
          error: null,
        },
      });
    } catch (error) {
      this.emitChatRpcError(request, error);
    }
  }

  private toScheduleSummary(
    schedule: Awaited<ReturnType<ScheduleService["inspect"]>>,
  ): Extract<
    SessionOutboundMessage,
    { type: "schedule/list/response" }
  >["payload"]["schedules"][number] {
    const { runs: _runs, ...summary } = schedule;
    return summary;
  }

  private emitScheduleRpcError(
    request: Extract<
      SessionInboundMessage,
      {
        type:
          | "schedule/create"
          | "schedule/list"
          | "schedule/inspect"
          | "schedule/logs"
          | "schedule/pause"
          | "schedule/resume"
          | "schedule/delete";
      }
    >,
    error: unknown,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    this.sessionLogger.error({ err: error, requestType: request.type }, "Schedule request failed");
    this.emit({
      type: "rpc_error",
      payload: {
        requestId: request.requestId,
        requestType: request.type,
        error: message,
        code: "schedule_request_failed",
      },
    });
  }

  private async handleScheduleCreateRequest(
    request: Extract<SessionInboundMessage, { type: "schedule/create" }>,
  ): Promise<void> {
    try {
      const target =
        request.target.type === "self"
          ? { type: "agent" as const, agentId: request.target.agentId }
          : request.target;
      const schedule = await this.scheduleService.create({
        prompt: request.prompt,
        name: request.name,
        cadence: request.cadence,
        target,
        maxRuns: request.maxRuns,
        expiresAt: request.expiresAt,
      });
      this.emit({
        type: "schedule/create/response",
        payload: {
          requestId: request.requestId,
          schedule: this.toScheduleSummary(schedule),
          error: null,
        },
      });
    } catch (error) {
      this.emitScheduleRpcError(request, error);
    }
  }

  private async handleScheduleListRequest(
    request: Extract<SessionInboundMessage, { type: "schedule/list" }>,
  ): Promise<void> {
    try {
      const schedules = await this.scheduleService.list();
      this.emit({
        type: "schedule/list/response",
        payload: {
          requestId: request.requestId,
          schedules: schedules.map((schedule) => this.toScheduleSummary(schedule)),
          error: null,
        },
      });
    } catch (error) {
      this.emitScheduleRpcError(request, error);
    }
  }

  private async handleScheduleInspectRequest(
    request: Extract<SessionInboundMessage, { type: "schedule/inspect" }>,
  ): Promise<void> {
    try {
      const schedule = await this.scheduleService.inspect(request.scheduleId);
      this.emit({
        type: "schedule/inspect/response",
        payload: {
          requestId: request.requestId,
          schedule,
          error: null,
        },
      });
    } catch (error) {
      this.emitScheduleRpcError(request, error);
    }
  }

  private async handleScheduleLogsRequest(
    request: Extract<SessionInboundMessage, { type: "schedule/logs" }>,
  ): Promise<void> {
    try {
      const runs = await this.scheduleService.logs(request.scheduleId);
      this.emit({
        type: "schedule/logs/response",
        payload: {
          requestId: request.requestId,
          runs,
          error: null,
        },
      });
    } catch (error) {
      this.emitScheduleRpcError(request, error);
    }
  }

  private async handleSchedulePauseRequest(
    request: Extract<SessionInboundMessage, { type: "schedule/pause" }>,
  ): Promise<void> {
    try {
      const schedule = await this.scheduleService.pause(request.scheduleId);
      this.emit({
        type: "schedule/pause/response",
        payload: {
          requestId: request.requestId,
          schedule: this.toScheduleSummary(schedule),
          error: null,
        },
      });
    } catch (error) {
      this.emitScheduleRpcError(request, error);
    }
  }

  private async handleScheduleResumeRequest(
    request: Extract<SessionInboundMessage, { type: "schedule/resume" }>,
  ): Promise<void> {
    try {
      const schedule = await this.scheduleService.resume(request.scheduleId);
      this.emit({
        type: "schedule/resume/response",
        payload: {
          requestId: request.requestId,
          schedule: this.toScheduleSummary(schedule),
          error: null,
        },
      });
    } catch (error) {
      this.emitScheduleRpcError(request, error);
    }
  }

  private async handleScheduleDeleteRequest(
    request: Extract<SessionInboundMessage, { type: "schedule/delete" }>,
  ): Promise<void> {
    try {
      await this.scheduleService.delete(request.scheduleId);
      this.emit({
        type: "schedule/delete/response",
        payload: {
          requestId: request.requestId,
          scheduleId: request.scheduleId,
          error: null,
        },
      });
    } catch (error) {
      this.emitScheduleRpcError(request, error);
    }
  }

  private emitLoopRpcError(
    request: Extract<
      SessionInboundMessage,
      {
        type: "loop/run" | "loop/list" | "loop/inspect" | "loop/logs" | "loop/stop";
      }
    >,
    error: unknown,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    this.sessionLogger.error({ err: error, requestType: request.type }, "Loop request failed");
    this.emit({
      type: "rpc_error",
      payload: {
        requestId: request.requestId,
        requestType: request.type,
        error: message,
        code: "loop_request_failed",
      },
    });
  }

  private async handleLoopRunRequest(
    request: Extract<SessionInboundMessage, { type: "loop/run" }>,
  ): Promise<void> {
    try {
      const loop = await this.loopService.runLoop({
        prompt: request.prompt,
        cwd: request.cwd,
        provider: request.provider,
        model: request.model,
        workerProvider: request.workerProvider,
        workerModel: request.workerModel,
        verifierProvider: request.verifierProvider,
        verifierModel: request.verifierModel,
        verifyPrompt: request.verifyPrompt,
        verifyChecks: request.verifyChecks,
        archive: request.archive,
        name: request.name,
        sleepMs: request.sleepMs,
        maxIterations: request.maxIterations,
        maxTimeMs: request.maxTimeMs,
      });
      this.emit({
        type: "loop/run/response",
        payload: {
          requestId: request.requestId,
          loop,
          error: null,
        },
      });
    } catch (error) {
      this.emitLoopRpcError(request, error);
    }
  }

  private async handleLoopListRequest(
    request: Extract<SessionInboundMessage, { type: "loop/list" }>,
  ): Promise<void> {
    try {
      const loops = await this.loopService.listLoops();
      this.emit({
        type: "loop/list/response",
        payload: {
          requestId: request.requestId,
          loops,
          error: null,
        },
      });
    } catch (error) {
      this.emitLoopRpcError(request, error);
    }
  }

  private async handleLoopInspectRequest(
    request: Extract<SessionInboundMessage, { type: "loop/inspect" }>,
  ): Promise<void> {
    try {
      const loop = await this.loopService.inspectLoop(request.id);
      this.emit({
        type: "loop/inspect/response",
        payload: {
          requestId: request.requestId,
          loop,
          error: null,
        },
      });
    } catch (error) {
      this.emitLoopRpcError(request, error);
    }
  }

  private async handleLoopLogsRequest(
    request: Extract<SessionInboundMessage, { type: "loop/logs" }>,
  ): Promise<void> {
    try {
      const result = await this.loopService.getLoopLogs(request.id, request.afterSeq ?? 0);
      this.emit({
        type: "loop/logs/response",
        payload: {
          requestId: request.requestId,
          loop: result.loop,
          entries: result.entries,
          nextCursor: result.nextCursor,
          error: null,
        },
      });
    } catch (error) {
      this.emitLoopRpcError(request, error);
    }
  }

  private async handleLoopStopRequest(
    request: Extract<SessionInboundMessage, { type: "loop/stop" }>,
  ): Promise<void> {
    try {
      const loop = await this.loopService.stopLoop(request.id);
      this.emit({
        type: "loop/stop/response",
        payload: {
          requestId: request.requestId,
          loop,
          error: null,
        },
      });
    } catch (error) {
      this.emitLoopRpcError(request, error);
    }
  }

  // ==========================================================================
  // Integration RPC handlers
  // ==========================================================================

  private async handleIntegrationListStatus(
    request: Extract<SessionInboundMessage, { type: "integration_list_status_request" }>,
  ): Promise<void> {
    try {
      const { listIntegrationStatus } = await import("./integration-service.js");
      const integrations = await listIntegrationStatus();
      this.emit({
        type: "integration_list_status_response",
        payload: { requestId: request.requestId, integrations },
      });
    } catch (err) {
      const integrations = ["github", "linear", "jira", "gitlab", "plain", "forgejo", "sentry"].map(
        (id) => ({ id, connected: false }),
      );
      this.emit({
        type: "integration_list_status_response",
        payload: { requestId: request.requestId, integrations },
      });
    }
  }

  private async handleIntegrationConnect(
    request: Extract<SessionInboundMessage, { type: "integration_connect_request" }>,
  ): Promise<void> {
    try {
      const { connectIntegration } = await import("./integration-service.js");
      const result = await connectIntegration(request.integrationId, request.credentials);
      this.emit({
        type: "integration_connect_response",
        payload: {
          requestId: request.requestId,
          integrationId: request.integrationId,
          success: result.success,
          account: result.account,
          error: result.error,
        },
      });
    } catch (err) {
      this.emit({
        type: "integration_connect_response",
        payload: {
          requestId: request.requestId,
          integrationId: request.integrationId,
          success: false,
          error: err instanceof Error ? err.message : "Connection failed",
        },
      });
    }
  }

  private async handleIntegrationDisconnect(
    request: Extract<SessionInboundMessage, { type: "integration_disconnect_request" }>,
  ): Promise<void> {
    try {
      const { disconnectIntegration } = await import("./integration-service.js");
      const result = await disconnectIntegration(request.integrationId);
      this.emit({
        type: "integration_disconnect_response",
        payload: {
          requestId: request.requestId,
          integrationId: request.integrationId,
          success: result.success,
        },
      });
    } catch {
      this.emit({
        type: "integration_disconnect_response",
        payload: {
          requestId: request.requestId,
          integrationId: request.integrationId,
          success: false,
        },
      });
    }
  }

  private async handleIntegrationSearch(
    request: Extract<SessionInboundMessage, { type: "integration_search_request" }>,
  ): Promise<void> {
    try {
      const { searchIntegrationItems } = await import("./integration-service.js");
      const result = await searchIntegrationItems(
        request.integrationId,
        request.query,
        request.cwd,
        request.limit,
      );
      this.emit({
        type: "integration_search_response",
        payload: {
          requestId: request.requestId,
          integrationId: request.integrationId,
          items: result.items,
          error: result.error,
        },
      });
    } catch (err) {
      this.emit({
        type: "integration_search_response",
        payload: {
          requestId: request.requestId,
          integrationId: request.integrationId,
          items: [],
          error: err instanceof Error ? err.message : "Search failed",
        },
      });
    }
  }

  private async handleIntegrationFetchItems(
    request: Extract<SessionInboundMessage, { type: "integration_fetch_items_request" }>,
  ): Promise<void> {
    try {
      const { fetchIntegrationItems } = await import("./integration-service.js");
      const result = await fetchIntegrationItems(request.integrationId, request.cwd, request.limit);
      this.emit({
        type: "integration_fetch_items_response",
        payload: {
          requestId: request.requestId,
          integrationId: request.integrationId,
          items: result.items,
          error: result.error,
        },
      });
    } catch (err) {
      this.emit({
        type: "integration_fetch_items_response",
        payload: {
          requestId: request.requestId,
          integrationId: request.integrationId,
          items: [],
          error: err instanceof Error ? err.message : "Fetch failed",
        },
      });
    }
  }

  private async handleCliAgentListRequest(
    request: Extract<SessionInboundMessage, { type: "cli_agent_list_request" }>,
  ): Promise<void> {
    try {
      const { detectCliAgents } = await import("./cli-connections-service.js");
      const agents = await detectCliAgents({
        refresh: request.refresh ?? false,
        overrides: this.daemonConfigStore.get().agents?.cliProviders,
      });
      this.emit({
        type: "cli_agent_list_response",
        payload: { requestId: request.requestId, agents },
      });
    } catch (error: any) {
      this.sessionLogger.error({ err: error }, "CLI agent detection failed");
      this.emit({
        type: "cli_agent_list_response",
        payload: {
          requestId: request.requestId,
          agents: [],
          error: error.message ?? "CLI agent detection failed",
        },
      });
    }
  }

  private handleBrowserCommandResult(
    msg: Extract<SessionInboundMessage, { type: "browser_command_result" }>,
  ): void {
    this.clientBrowserManager.handleCommandResult({
      requestId: msg.requestId,
      browserId: msg.browserId,
      success: msg.success,
      result: msg.result,
      error: msg.error,
    });
  }

  private async handleFileSearchRequest(
    msg: Extract<SessionInboundMessage, { type: "file_search_request" }>,
  ): Promise<void> {
    try {
      const { searchFiles } = await import("./search/file-search.js");
      const allWorkspaces = await this.workspaceRegistry.list();
      const scoped = msg.workspaceIds.length
        ? allWorkspaces.filter((w) => msg.workspaceIds.includes(w.workspaceId))
        : allWorkspaces;
      const result = await searchFiles({
        query: msg.query,
        limit: msg.limit,
        workspaces: scoped.map((w) => ({
          workspaceId: w.workspaceId,
          workspaceName: w.displayName,
          cwd: w.cwd,
        })),
      });
      this.emit({
        type: "file_search_response",
        requestId: msg.requestId,
        ok: true,
        results: result.matches.map((m) => ({
          workspaceId: m.workspaceId,
          workspaceName: m.workspaceName,
          relativePath: m.relativePath,
        })),
        truncated: result.truncated,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sessionLogger.warn({ err }, "file_search_request failed");
      this.emit({
        type: "file_search_response",
        requestId: msg.requestId,
        ok: false,
        error: message,
        results: [],
        truncated: false,
      });
    }
  }

  private async handleLibraryAgentsRequest(
    msg: Extract<SessionInboundMessage, { type: "library_agents_request" }>,
  ): Promise<void> {
    const { detectInstalledAgents, agentMetaForClient } = await import(
      "./library/detect-installed.js"
    );
    const agents = agentMetaForClient();
    let installedIds: string[] = [];
    try {
      installedIds = await detectInstalledAgents();
    } catch (err) {
      this.sessionLogger.warn({ err }, "library_agents_request detection failed");
    }
    this.emit({
      type: "library_agents_response",
      requestId: msg.requestId,
      agents,
      installedIds,
    });
  }

  private async handleLibrarySyncRequest(
    msg: Extract<SessionInboundMessage, { type: "library_sync_request" }>,
  ): Promise<void> {
    try {
      const { syncLibraryToTargets } = await import("./library/sync-writers.js");
      this.libraryStore.setMcps(msg.mcps);
      this.libraryStore.setSkills(msg.skills);
      const report = await syncLibraryToTargets({
        hubcodeHome: this.hubcodeHome,
        mcps: msg.mcps,
        skills: msg.skills,
      });
      const runningAgentIds = this.agentManager
        .listAgents()
        .filter((a) => a.lifecycle === "running" || a.lifecycle === "initializing")
        .map((a) => a.id);
      this.emit({
        type: "library_sync_response",
        requestId: msg.requestId,
        ok: true,
        counts: report.counts,
        runningAgentIds,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sessionLogger.error({ err }, "library_sync_request failed");
      this.emit({
        type: "library_sync_response",
        requestId: msg.requestId,
        ok: false,
        error: message,
        runningAgentIds: [],
      });
    }
  }

  private async handleUpdateWorkspaceMetadata(
    request: Extract<SessionInboundMessage, { type: "update_workspace_metadata_request" }>,
  ): Promise<void> {
    try {
      const existing = await this.workspaceRegistry.get(request.workspaceId);
      if (!existing) {
        this.emit({
          type: "update_workspace_metadata_response",
          payload: {
            requestId: request.requestId,
            error: `Workspace not found: ${request.workspaceId}`,
          },
        });
        return;
      }

      const changes = request.changes;
      const updated = {
        ...existing,
        updatedAt: new Date().toISOString(),
        ...(changes.kanbanStatus !== undefined ? { kanbanStatus: changes.kanbanStatus } : {}),
        ...(changes.issueContext !== undefined ? { issueContext: changes.issueContext } : {}),
        ...(changes.issueMetadata !== undefined ? { issueMetadata: changes.issueMetadata } : {}),
        ...(changes.prompt !== undefined ? { prompt: changes.prompt } : {}),
        ...(changes.autoApprove !== undefined ? { autoApprove: changes.autoApprove } : {}),
        ...(changes.agentProvider !== undefined ? { agentProvider: changes.agentProvider } : {}),
        ...(changes.agentMode !== undefined ? { agentMode: changes.agentMode } : {}),
        ...(changes.orgId !== undefined ? { orgId: changes.orgId } : {}),
      };

      await this.workspaceRegistry.upsert(updated);
      await this.emitWorkspaceUpdateForCwd(existing.cwd);

      this.emit({
        type: "update_workspace_metadata_response",
        payload: { requestId: request.requestId, error: null },
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to update workspace metadata";
      this.sessionLogger.error(
        { err: error, workspaceId: request.workspaceId },
        "Failed to update workspace metadata",
      );
      this.emit({
        type: "update_workspace_metadata_response",
        payload: { requestId: request.requestId, error: message },
      });
    }
  }

  private emitTerminalsChangedSnapshot(input: {
    cwd: string;
    terminals: Array<{ id: string; name: string }>;
  }): void {
    this.emit({
      type: "terminals_changed",
      payload: {
        cwd: input.cwd,
        terminals: input.terminals,
      },
    });
  }

  private handleTerminalsChanged(event: TerminalsChangedEvent): void {
    if (!this.subscribedTerminalDirectories.has(event.cwd)) {
      return;
    }

    this.emitTerminalsChangedSnapshot({
      cwd: event.cwd,
      terminals: event.terminals.map((terminal) => ({
        id: terminal.id,
        name: terminal.name,
      })),
    });
  }

  private handleSubscribeTerminalsRequest(msg: SubscribeTerminalsRequest): void {
    this.subscribedTerminalDirectories.add(msg.cwd);
    void this.emitInitialTerminalsChangedSnapshot(msg.cwd);
  }

  private handleUnsubscribeTerminalsRequest(msg: UnsubscribeTerminalsRequest): void {
    this.subscribedTerminalDirectories.delete(msg.cwd);
  }

  private async emitInitialTerminalsChangedSnapshot(cwd: string): Promise<void> {
    if (!this.terminalManager || !this.subscribedTerminalDirectories.has(cwd)) {
      return;
    }

    try {
      const terminals = await this.terminalManager.getTerminals(cwd);
      for (const terminal of terminals) {
        this.ensureTerminalExitSubscription(terminal);
      }

      if (!this.subscribedTerminalDirectories.has(cwd)) {
        return;
      }

      this.emitTerminalsChangedSnapshot({
        cwd,
        terminals: terminals.map((terminal) => ({
          id: terminal.id,
          name: terminal.name,
        })),
      });
    } catch (error) {
      this.sessionLogger.warn({ err: error, cwd }, "Failed to emit initial terminal snapshot");
    }
  }

  private async handleListTerminalsRequest(msg: ListTerminalsRequest): Promise<void> {
    if (!this.terminalManager) {
      this.emit({
        type: "list_terminals_response",
        payload: {
          ...(msg.cwd ? { cwd: msg.cwd } : {}),
          terminals: [],
          requestId: msg.requestId,
        },
      });
      return;
    }

    try {
      const terminals =
        typeof msg.cwd === "string"
          ? await this.terminalManager.getTerminals(msg.cwd)
          : await this.getAllTerminalSessions();
      for (const terminal of terminals) {
        this.ensureTerminalExitSubscription(terminal);
      }
      this.emit({
        type: "list_terminals_response",
        payload: {
          ...(msg.cwd ? { cwd: msg.cwd } : {}),
          terminals: terminals.map((t) => ({ id: t.id, name: t.name })),
          requestId: msg.requestId,
        },
      });
    } catch (error: any) {
      this.sessionLogger.error({ err: error, cwd: msg.cwd }, "Failed to list terminals");
      this.emit({
        type: "list_terminals_response",
        payload: {
          ...(msg.cwd ? { cwd: msg.cwd } : {}),
          terminals: [],
          requestId: msg.requestId,
        },
      });
    }
  }

  private async getAllTerminalSessions(): Promise<TerminalSession[]> {
    if (!this.terminalManager) {
      return [];
    }

    const directories = this.terminalManager.listDirectories();
    const terminalsByDirectory = await Promise.all(
      directories.map((cwd) => this.terminalManager!.getTerminals(cwd)),
    );
    return terminalsByDirectory.flat();
  }

  private async handleCreateTerminalRequest(msg: CreateTerminalRequest): Promise<void> {
    if (!this.terminalManager) {
      this.emit({
        type: "create_terminal_response",
        payload: {
          terminal: null,
          error: "Terminal manager not available",
          requestId: msg.requestId,
        },
      });
      return;
    }

    try {
      const session = await this.terminalManager.createTerminal({
        cwd: msg.cwd,
        name: msg.name,
        ...(msg.command ? { command: msg.command, args: msg.args } : {}),
        ...(msg.env ? { env: msg.env } : {}),
      });
      this.ensureTerminalExitSubscription(session);
      this.emit({
        type: "create_terminal_response",
        payload: {
          terminal: { id: session.id, name: session.name, cwd: session.cwd },
          error: null,
          requestId: msg.requestId,
        },
      });
    } catch (error: any) {
      this.sessionLogger.error({ err: error, cwd: msg.cwd }, "Failed to create terminal");
      this.emit({
        type: "create_terminal_response",
        payload: {
          terminal: null,
          error: error.message,
          requestId: msg.requestId,
        },
      });
    }
  }

  private async handleSubscribeTerminalRequest(msg: SubscribeTerminalRequest): Promise<void> {
    if (!this.terminalManager) {
      this.emit({
        type: "subscribe_terminal_response",
        payload: {
          terminalId: msg.terminalId,
          error: "Terminal manager not available",
          requestId: msg.requestId,
        },
      });
      return;
    }

    const session = this.terminalManager.getTerminal(msg.terminalId);
    if (!session) {
      this.emit({
        type: "subscribe_terminal_response",
        payload: {
          terminalId: msg.terminalId,
          error: "Terminal not found",
          requestId: msg.requestId,
        },
      });
      return;
    }
    this.ensureTerminalExitSubscription(session);

    const slot = this.bindActiveTerminalStream(session);
    if (slot === null) {
      this.sessionLogger.warn(
        {
          terminalId: msg.terminalId,
          activeTerminalStreamCount: this.activeTerminalStreams.size,
        },
        "Terminal stream slot exhaustion",
      );
      this.emit({
        type: "subscribe_terminal_response",
        payload: {
          terminalId: msg.terminalId,
          error: "No terminal stream slots available",
          requestId: msg.requestId,
        },
      });
      return;
    }

    this.emit({
      type: "subscribe_terminal_response",
      payload: {
        terminalId: msg.terminalId,
        slot,
        error: null,
        requestId: msg.requestId,
      },
    });

    const activeStream = this.activeTerminalStreams.get(slot);
    if (activeStream) {
      this.trySendTerminalSnapshot(activeStream);
    }
  }

  private handleUnsubscribeTerminalRequest(msg: UnsubscribeTerminalRequest): void {
    this.detachTerminalStream(msg.terminalId, { emitExit: false });
  }

  private handleTerminalInput(msg: TerminalInput): void {
    if (!this.terminalManager) {
      return;
    }

    const session = this.terminalManager.getTerminal(msg.terminalId);
    if (!session) {
      this.sessionLogger.warn({ terminalId: msg.terminalId }, "Terminal not found for input");
      return;
    }
    this.ensureTerminalExitSubscription(session);

    if (msg.message.type === "resize") {
      const currentSize = session.getSize();
      if (currentSize.rows === msg.message.rows && currentSize.cols === msg.message.cols) {
        return;
      }
    }

    session.send(msg.message);
  }

  private killTrackedTerminal(terminalId: string, options?: { emitExit: boolean }): void {
    this.detachTerminalStream(terminalId, { emitExit: options?.emitExit ?? true });
    this.terminalManager?.killTerminal(terminalId);
  }

  private async killTerminalsUnderPath(rootPath: string): Promise<void> {
    return killWorktreeTerminalsUnderPath(
      {
        isPathWithinRoot: (pathRoot, candidatePath) =>
          this.isPathWithinRoot(pathRoot, candidatePath),
        killTrackedTerminal: (terminalId, options) => this.killTrackedTerminal(terminalId, options),
        sessionLogger: this.sessionLogger,
        terminalManager: this.terminalManager,
      },
      rootPath,
    );
  }

  private async handleKillTerminalRequest(msg: KillTerminalRequest): Promise<void> {
    const result = this.killTerminalForClose(msg.terminalId);
    this.emit({
      type: "kill_terminal_response",
      payload: {
        terminalId: result.terminalId,
        success: result.success,
        requestId: msg.requestId,
      },
    });
  }

  private killTerminalForClose(terminalId: string): { terminalId: string; success: boolean } {
    if (!this.terminalManager) {
      return {
        terminalId,
        success: false,
      };
    }

    this.killTrackedTerminal(terminalId, { emitExit: true });
    return {
      terminalId,
      success: true,
    };
  }

  private async handleCaptureTerminalRequest(msg: CaptureTerminalRequest): Promise<void> {
    if (!this.terminalManager) {
      this.emit({
        type: "capture_terminal_response",
        payload: {
          terminalId: msg.terminalId,
          lines: [],
          totalLines: 0,
          requestId: msg.requestId,
        },
      });
      return;
    }

    const session = this.terminalManager.getTerminal(msg.terminalId);
    if (!session) {
      this.emit({
        type: "capture_terminal_response",
        payload: {
          terminalId: msg.terminalId,
          lines: [],
          totalLines: 0,
          requestId: msg.requestId,
        },
      });
      return;
    }

    this.ensureTerminalExitSubscription(session);

    try {
      const capture = captureTerminalLines(session, {
        start: msg.start,
        end: msg.end,
        stripAnsi: msg.stripAnsi,
      });
      this.emit({
        type: "capture_terminal_response",
        payload: {
          terminalId: msg.terminalId,
          lines: capture.lines,
          totalLines: capture.totalLines,
          requestId: msg.requestId,
        },
      });
    } catch (error: any) {
      this.sessionLogger.error(
        { err: error, terminalId: msg.terminalId },
        "Failed to capture terminal",
      );
      this.emit({
        type: "capture_terminal_response",
        payload: {
          terminalId: msg.terminalId,
          lines: [],
          totalLines: 0,
          requestId: msg.requestId,
        },
      });
    }
  }

  // =========================================================================
  // Browser handlers
  // =========================================================================

  private async handleBrowserLaunchRequest(msg: BrowserLaunchRequest): Promise<void> {
    try {
      const result = await this.clientBrowserManager.launch({ url: msg.url });
      this.emit({
        type: "browser_launch_response",
        payload: {
          browserId: result.browserId,
          url: result.url,
          title: result.title,
          requestId: msg.requestId,
        },
      });
    } catch (error: any) {
      this.sessionLogger.error({ err: error }, "Failed to launch browser");
      this.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: error?.message ?? "Failed to launch browser",
          code: "browser_launch_failed",
        },
      });
    }
  }

  private async handleBrowserStateRequest(msg: BrowserStateRequest): Promise<void> {
    try {
      const state = await this.clientBrowserManager.getPageState(msg.browserId);
      this.emit({
        type: "browser_state_response",
        payload: {
          browserId: msg.browserId,
          url: state.url,
          title: state.title,
          requestId: msg.requestId,
        },
      });
    } catch (error: any) {
      this.sessionLogger.error(
        { err: error, browserId: msg.browserId },
        "Failed to get browser state",
      );
      this.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: error?.message ?? "Failed to get browser state",
          code: "browser_state_failed",
        },
      });
    }
  }

  private async handleBrowserScreenshotRequest(msg: BrowserScreenshotRequest): Promise<void> {
    try {
      const shot = await this.clientBrowserManager.screenshot(msg.browserId);
      this.emit({
        type: "browser_screenshot_response",
        payload: {
          browserId: msg.browserId,
          data: shot.data,
          mimeType: shot.mimeType,
          requestId: msg.requestId,
        },
      });
    } catch (error: any) {
      this.sessionLogger.error(
        { err: error, browserId: msg.browserId },
        "Failed to take screenshot",
      );
      this.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: error?.message ?? "Failed to take screenshot",
          code: "browser_screenshot_failed",
        },
      });
    }
  }

  private async handleBrowserNavigateRequest(msg: BrowserNavigateRequest): Promise<void> {
    try {
      const result = await this.clientBrowserManager.navigate(msg.browserId, msg.url);
      this.emit({
        type: "browser_navigate_response",
        payload: {
          browserId: msg.browserId,
          url: result.url,
          title: result.title,
          requestId: msg.requestId,
        },
      });
    } catch (error: any) {
      this.sessionLogger.error({ err: error, browserId: msg.browserId }, "Failed to navigate");
      this.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: error?.message ?? "Failed to navigate",
          code: "browser_navigate_failed",
        },
      });
    }
  }

  private async handleBrowserGoBackRequest(msg: BrowserGoBackRequest): Promise<void> {
    try {
      const result = await this.clientBrowserManager.goBack(msg.browserId);
      this.emit({
        type: "browser_go_back_response",
        payload: {
          browserId: msg.browserId,
          url: result.url,
          title: result.title,
          requestId: msg.requestId,
        },
      });
    } catch (error: any) {
      this.sessionLogger.error({ err: error, browserId: msg.browserId }, "Failed to go back");
      this.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: error?.message ?? "Failed to go back",
          code: "browser_go_back_failed",
        },
      });
    }
  }

  private async handleBrowserGoForwardRequest(msg: BrowserGoForwardRequest): Promise<void> {
    try {
      const result = await this.clientBrowserManager.goForward(msg.browserId);
      this.emit({
        type: "browser_go_forward_response",
        payload: {
          browserId: msg.browserId,
          url: result.url,
          title: result.title,
          requestId: msg.requestId,
        },
      });
    } catch (error: any) {
      this.sessionLogger.error({ err: error, browserId: msg.browserId }, "Failed to go forward");
      this.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: error?.message ?? "Failed to go forward",
          code: "browser_go_forward_failed",
        },
      });
    }
  }

  private async handleBrowserCloseRequest(msg: BrowserCloseRequest): Promise<void> {
    try {
      await this.clientBrowserManager.close(msg.browserId);
      this.emit({
        type: "browser_close_response",
        payload: { browserId: msg.browserId, success: true, requestId: msg.requestId },
      });
    } catch (error: any) {
      this.sessionLogger.error({ err: error, browserId: msg.browserId }, "Failed to close browser");
      this.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: error?.message ?? "Failed to close browser",
          code: "browser_close_failed",
        },
      });
    }
  }

  private async handleBrowserResizeRequest(msg: BrowserResizeRequest): Promise<void> {
    try {
      // Client webview handles its own sizing — this is a no-op for client-side browsers
      this.emit({
        type: "browser_resize_response",
        payload: { browserId: msg.browserId, success: true, requestId: msg.requestId },
      });
    } catch (error: any) {
      this.sessionLogger.error(
        { err: error, browserId: msg.browserId },
        "Failed to resize browser viewport",
      );
      this.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: error?.message ?? "Failed to resize browser",
          code: "browser_resize_failed",
        },
      });
    }
  }

  private bindActiveTerminalStream(terminal: TerminalSession): number | null {
    if (!this.onBinaryMessage) {
      return null;
    }

    const existingSlot = this.terminalIdToSlot.get(terminal.id);
    if (typeof existingSlot === "number") {
      const existingStream = this.activeTerminalStreams.get(existingSlot);
      if (existingStream) {
        existingStream.needsSnapshot = true;
        return existingSlot;
      }
      this.terminalIdToSlot.delete(terminal.id);
    }

    const slot = this.allocateTerminalSlot();
    if (slot === null) {
      return null;
    }

    const activeStream: ActiveTerminalStream = {
      terminalId: terminal.id,
      slot,
      unsubscribe: () => {},
      needsSnapshot: true,
    };

    this.activeTerminalStreams.set(slot, activeStream);
    this.terminalIdToSlot.set(terminal.id, slot);

    activeStream.unsubscribe = terminal.subscribe((message) => {
      if (this.activeTerminalStreams.get(slot) !== activeStream) {
        return;
      }
      if (message.type === "snapshot") {
        this.trySendTerminalSnapshot(activeStream);
        return;
      }
      if (activeStream.needsSnapshot || message.data.length === 0) {
        return;
      }
      this.emitBinary(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Output,
          slot,
          payload: new Uint8Array(Buffer.from(message.data, "utf8")),
        }),
      );
    });
    return slot;
  }

  private trySendTerminalSnapshot(activeStream: ActiveTerminalStream): void {
    if (
      this.activeTerminalStreams.get(activeStream.slot) !== activeStream ||
      !activeStream.needsSnapshot
    ) {
      return;
    }

    const terminal = this.terminalManager?.getTerminal(activeStream.terminalId);
    if (!terminal) {
      this.detachTerminalStream(activeStream.terminalId, { emitExit: true });
      return;
    }

    activeStream.needsSnapshot = false;
    this.emitBinary(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Snapshot,
        slot: activeStream.slot,
        payload: encodeTerminalSnapshotPayload(terminal.getState()),
      }),
    );
  }

  private allocateTerminalSlot(): number | null {
    for (let attempt = 0; attempt < MAX_TERMINAL_STREAM_SLOTS; attempt += 1) {
      const slot = (this.nextTerminalSlot + attempt) % MAX_TERMINAL_STREAM_SLOTS;
      if (this.activeTerminalStreams.has(slot)) {
        continue;
      }
      this.nextTerminalSlot = (slot + 1) % MAX_TERMINAL_STREAM_SLOTS;
      return slot;
    }
    return null;
  }

  private detachTerminalStream(terminalId: string, options?: { emitExit: boolean }): boolean {
    const slot = this.terminalIdToSlot.get(terminalId);
    if (typeof slot !== "number") {
      return false;
    }
    const activeStream = this.activeTerminalStreams.get(slot);
    if (!activeStream) {
      this.terminalIdToSlot.delete(terminalId);
      return false;
    }
    this.activeTerminalStreams.delete(slot);
    this.terminalIdToSlot.delete(terminalId);
    try {
      activeStream.unsubscribe();
    } catch (error) {
      this.sessionLogger.warn({ err: error }, "Failed to unsubscribe terminal stream");
    }
    if (options?.emitExit) {
      this.emit({
        type: "terminal_stream_exit",
        payload: {
          terminalId: activeStream.terminalId,
        },
      });
    }
    return true;
  }

  private disposeTerminalSubscriptions(): void {
    for (const terminalId of [...this.terminalIdToSlot.keys()]) {
      this.detachTerminalStream(terminalId, { emitExit: false });
    }
  }

  // -------------------------------------------------------------------------
  // Code indexing RPC (PR2a — server-only wiring; lifecycle + UI land later)
  // -------------------------------------------------------------------------

  private ensureIndexingService(): IndexingService | null {
    return this.indexingService;
  }

  private emitIndexingError(
    requestId: string,
    responseType:
      | "indexing/list/response"
      | "indexing/get/response"
      | "indexing/state/response"
      | "indexing/detect/response",
    error: unknown,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    if (responseType === "indexing/list/response") {
      this.emit({
        type: responseType,
        payload: { requestId, error: message, entries: [] },
      });
      return;
    }
    if (responseType === "indexing/get/response") {
      this.emit({
        type: responseType,
        payload: { requestId, error: message, entry: null },
      });
      return;
    }
    if (responseType === "indexing/state/response") {
      this.emit({
        type: responseType,
        payload: { requestId, error: message, workspaceId: "", indexing: null },
      });
      return;
    }
    this.emit({
      type: responseType,
      payload: { requestId, error: message, detection: null },
    });
  }

  private async handleIndexingListRequest(
    request: Extract<SessionInboundMessage, { type: "indexing/list" }>,
  ): Promise<void> {
    const svc = this.ensureIndexingService();
    if (!svc) {
      this.emitIndexingError(
        request.requestId,
        "indexing/list/response",
        "Indexing service unavailable",
      );
      return;
    }
    try {
      // Return ALL workspaces (with default state when not yet enabled) so
      // the UI can render per-workspace toggles before any are turned on.
      const entries = (await svc.listAll()).map((e) => ({
        workspaceId: e.workspaceId,
        indexing: e.state,
      }));
      this.emit({
        type: "indexing/list/response",
        payload: { requestId: request.requestId, error: null, entries },
      });
    } catch (err) {
      this.emitIndexingError(request.requestId, "indexing/list/response", err);
    }
  }

  private async handleIndexingGetRequest(
    request: Extract<SessionInboundMessage, { type: "indexing/get" }>,
  ): Promise<void> {
    const svc = this.ensureIndexingService();
    if (!svc) {
      this.emitIndexingError(
        request.requestId,
        "indexing/get/response",
        "Indexing service unavailable",
      );
      return;
    }
    try {
      const state = await svc.getState(request.workspaceId);
      this.emit({
        type: "indexing/get/response",
        payload: {
          requestId: request.requestId,
          error: null,
          entry: { workspaceId: request.workspaceId, indexing: state },
        },
      });
    } catch (err) {
      this.emitIndexingError(request.requestId, "indexing/get/response", err);
    }
  }

  private async handleIndexingSetEnabledRequest(
    request: Extract<SessionInboundMessage, { type: "indexing/set-enabled" }>,
  ): Promise<void> {
    const svc = this.ensureIndexingService();
    if (!svc) {
      this.emitIndexingError(
        request.requestId,
        "indexing/state/response",
        "Indexing service unavailable",
      );
      return;
    }
    try {
      const state = await svc.setEnabled(request.workspaceId, request.enabled);
      this.emit({
        type: "indexing/state/response",
        payload: {
          requestId: request.requestId,
          error: null,
          workspaceId: request.workspaceId,
          indexing: state,
        },
      });
    } catch (err) {
      this.emitIndexingError(request.requestId, "indexing/state/response", err);
    }
  }

  private async handleIndexingSetExposeToRequest(
    request: Extract<SessionInboundMessage, { type: "indexing/set-expose-to" }>,
  ): Promise<void> {
    const svc = this.ensureIndexingService();
    if (!svc) {
      this.emitIndexingError(
        request.requestId,
        "indexing/state/response",
        "Indexing service unavailable",
      );
      return;
    }
    try {
      const state = await svc.setExposeTo(request.workspaceId, request.agentId, request.entry);
      this.emit({
        type: "indexing/state/response",
        payload: {
          requestId: request.requestId,
          error: null,
          workspaceId: request.workspaceId,
          indexing: state,
        },
      });
    } catch (err) {
      this.emitIndexingError(request.requestId, "indexing/state/response", err);
    }
  }

  private async handleIndexingSetEmbeddingProviderRequest(
    request: Extract<SessionInboundMessage, { type: "indexing/set-embedding-provider" }>,
  ): Promise<void> {
    const svc = this.ensureIndexingService();
    if (!svc) {
      this.emitIndexingError(
        request.requestId,
        "indexing/state/response",
        "Indexing service unavailable",
      );
      return;
    }
    try {
      const state = await svc.update(request.workspaceId, {
        embeddingProvider: request.provider ?? undefined,
      });
      this.emit({
        type: "indexing/state/response",
        payload: {
          requestId: request.requestId,
          error: null,
          workspaceId: request.workspaceId,
          indexing: state,
        },
      });
    } catch (err) {
      this.emitIndexingError(request.requestId, "indexing/state/response", err);
    }
  }

  private async handleIndexingSetWatchlistRequest(
    request: Extract<SessionInboundMessage, { type: "indexing/set-watchlist" }>,
  ): Promise<void> {
    const svc = this.ensureIndexingService();
    if (!svc) {
      this.emitIndexingError(
        request.requestId,
        "indexing/state/response",
        "Indexing service unavailable",
      );
      return;
    }
    try {
      const state = await svc.update(request.workspaceId, { watchlist: request.watchlist });
      this.emit({
        type: "indexing/state/response",
        payload: {
          requestId: request.requestId,
          error: null,
          workspaceId: request.workspaceId,
          indexing: state,
        },
      });
    } catch (err) {
      this.emitIndexingError(request.requestId, "indexing/state/response", err);
    }
  }

  private async handleIndexingDetectRequest(
    request: Extract<SessionInboundMessage, { type: "indexing/detect" }>,
  ): Promise<void> {
    const svc = this.ensureIndexingService();
    if (!svc) {
      this.emitIndexingError(
        request.requestId,
        "indexing/detect/response",
        "Indexing service unavailable",
      );
      return;
    }
    try {
      const detection = await svc.getDetection(request.force === true);
      this.emit({
        type: "indexing/detect/response",
        payload: { requestId: request.requestId, error: null, detection },
      });
    } catch (err) {
      this.emitIndexingError(request.requestId, "indexing/detect/response", err);
    }
  }

  private async handleIndexingToolsListRequest(
    request: Extract<SessionInboundMessage, { type: "indexing/tools/list" }>,
  ): Promise<void> {
    const svc = this.ensureIndexingService();
    if (!svc) {
      this.emit({
        type: "indexing/tools/list/response",
        payload: {
          requestId: request.requestId,
          error: "Indexing service unavailable",
          tools: [],
        },
      });
      return;
    }
    try {
      const tools = svc.getCrgTools().map((t) => ({ name: t.name, description: t.description }));
      this.emit({
        type: "indexing/tools/list/response",
        payload: { requestId: request.requestId, error: null, tools },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit({
        type: "indexing/tools/list/response",
        payload: { requestId: request.requestId, error: message, tools: [] },
      });
    }
  }

  private async handleIndexingReindexRequest(
    request: Extract<SessionInboundMessage, { type: "indexing/reindex" }>,
  ): Promise<void> {
    const svc = this.ensureIndexingService();
    if (!svc) {
      this.emitIndexingError(
        request.requestId,
        "indexing/state/response",
        "Indexing service unavailable",
      );
      return;
    }
    try {
      const result = await svc.reindex(request.workspaceId);
      const state = await svc.getState(request.workspaceId);
      this.emit({
        type: "indexing/state/response",
        payload: {
          requestId: request.requestId,
          error: result.ok ? null : (result.error ?? "Reindex failed"),
          workspaceId: request.workspaceId,
          indexing: state,
        },
      });
    } catch (err) {
      this.emitIndexingError(request.requestId, "indexing/state/response", err);
    }
  }

  private async handleIndexingCancelReindexRequest(
    request: Extract<SessionInboundMessage, { type: "indexing/cancel-reindex" }>,
  ): Promise<void> {
    const svc = this.ensureIndexingService();
    if (!svc) {
      this.emit({
        type: "indexing/cancel-reindex/response",
        payload: {
          requestId: request.requestId,
          error: "Indexing service unavailable",
          cancelled: false,
        },
      });
      return;
    }
    const result = svc.cancelReindex(request.workspaceId);
    this.emit({
      type: "indexing/cancel-reindex/response",
      payload: {
        requestId: request.requestId,
        error: result.ok ? null : "Cancel not wired",
        cancelled: result.cancelled,
      },
    });
  }

  private async handleIndexingRestartSubprocessRequest(
    request: Extract<SessionInboundMessage, { type: "indexing/restart-subprocess" }>,
  ): Promise<void> {
    const svc = this.ensureIndexingService();
    if (!svc) {
      this.emit({
        type: "indexing/restart-subprocess/response",
        payload: {
          requestId: request.requestId,
          error: "Indexing service unavailable",
          restarted: false,
        },
      });
      return;
    }
    try {
      await svc.restartProcess();
      this.emit({
        type: "indexing/restart-subprocess/response",
        payload: { requestId: request.requestId, error: null, restarted: true },
      });
    } catch (err) {
      this.emit({
        type: "indexing/restart-subprocess/response",
        payload: {
          requestId: request.requestId,
          error: err instanceof Error ? err.message : String(err),
          restarted: false,
        },
      });
    }
  }

  private async handleIndexingStderrTailRequest(
    request: Extract<SessionInboundMessage, { type: "indexing/stderr-tail" }>,
  ): Promise<void> {
    const svc = this.ensureIndexingService();
    if (!svc) {
      this.emit({
        type: "indexing/stderr-tail/response",
        payload: { requestId: request.requestId, error: "Indexing service unavailable", text: "" },
      });
      return;
    }
    this.emit({
      type: "indexing/stderr-tail/response",
      payload: { requestId: request.requestId, error: null, text: svc.getStderrTail() },
    });
  }

  private async handleIndexingInstallRequest(
    request: Extract<SessionInboundMessage, { type: "indexing/install" }>,
  ): Promise<void> {
    const svc = this.ensureIndexingService();
    if (!svc) {
      this.emit({
        type: "indexing/install/event",
        payload: {
          requestId: request.requestId,
          event: {
            type: "completed",
            success: false,
            error: "Indexing service unavailable",
          },
        },
      });
      return;
    }
    try {
      for await (const event of svc.runInstall()) {
        this.emit({
          type: "indexing/install/event",
          payload: { requestId: request.requestId, event },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit({
        type: "indexing/install/event",
        payload: {
          requestId: request.requestId,
          event: { type: "completed", success: false, error: message },
        },
      });
    }
  }
}

function deriveRepoDirectoryName(remoteUrl: string): string {
  // Extract repo name from typical URL shapes. Fall back to a timestamp when
  // the remote shape is unusual so we don't crash the clone.
  const trimmed = remoteUrl.trim().replace(/\.git$/, "");
  const sshMatch = trimmed.match(/^[^@]+@[^:]+:(.+)$/);
  const pathPart = sshMatch ? sshMatch[1] : trimmed.replace(/^[a-z]+:\/\/[^/]+\//i, "");
  const name = basename(pathPart);
  return name && /^[A-Za-z0-9._-]+$/.test(name) ? name : `repo-${Date.now()}`;
}

function runGitClone(
  remoteUrl: string,
  target: string,
  logger: {
    info: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
  },
): Promise<void> {
  return new Promise((resolveClone, rejectClone) => {
    const child = spawn("git", ["clone", "--", remoteUrl, target], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // Fail fast on credential prompts — we don't have a TTY to answer.
        GIT_TERMINAL_PROMPT: "0",
      },
    });

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timeout = setTimeout(
      () => {
        try {
          child.kill("SIGKILL");
        } catch {}
        rejectClone(new Error("git clone timed out after 5 minutes"));
      },
      5 * 60 * 1000,
    );

    child.on("error", (err) => {
      clearTimeout(timeout);
      rejectClone(err);
    });

    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        logger.info({ remoteUrl, target }, "git clone succeeded");
        resolveClone();
      } else {
        const reason = stderr.trim() || `git clone exited with code ${code}`;
        rejectClone(new Error(reason));
      }
    });
  });
}
