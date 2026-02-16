import { v4 as uuidv4 } from "uuid";
import { watch, type FSWatcher } from "node:fs";
import { stat } from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import { join, resolve, sep } from "path";
import { z } from "zod";
import type { ToolSet } from "ai";
import {
  serializeAgentStreamEvent,
  type AgentSnapshotPayload,
  type SessionInboundMessage,
  type SessionOutboundMessage,
  type FileExplorerRequest,
  type FileDownloadTokenRequest,
  type GitSetupOptions,
  type ListTerminalsRequest,
  type SubscribeTerminalsRequest,
  type UnsubscribeTerminalsRequest,
  type CreateTerminalRequest,
  type SubscribeTerminalRequest,
  type UnsubscribeTerminalRequest,
  type TerminalInput,
  type KillTerminalRequest,
  type AttachTerminalStreamRequest,
  type DetachTerminalStreamRequest,
  type SubscribeCheckoutDiffRequest,
  type UnsubscribeCheckoutDiffRequest,
  type ProjectCheckoutLitePayload,
  type ProjectPlacementPayload,
} from "./messages.js";
import type {
  TerminalManager,
  TerminalsChangedEvent,
} from "../terminal/terminal-manager.js";
import type { TerminalSession } from "../terminal/terminal.js";
import {
  BinaryMuxChannel,
  TerminalBinaryFlags,
  TerminalBinaryMessageType,
  type BinaryMuxFrame,
} from "../shared/binary-mux.js";
import { TTSManager } from "./agent/tts-manager.js";
import { STTManager } from "./agent/stt-manager.js";
import type { SpeechToTextProvider, TextToSpeechProvider } from "./speech/speech-provider.js";
import { maybePersistTtsDebugAudio } from "./agent/tts-debug.js";
import { isPaseoDictationDebugEnabled } from "./agent/recordings-debug.js";
import {
  DictationStreamManager,
  type DictationStreamOutboundMessage,
} from "./dictation/dictation-stream-manager.js";
import {
  buildConfigOverrides,
  buildSessionConfig,
  extractTimestamps,
} from "./persistence-hooks.js";
import { experimental_createMCPClient } from "ai";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  VoiceCallerContext,
  VoiceMcpStdioConfig,
  VoiceSpeakHandler,
} from "./voice-types.js";

export type AgentMcpTransportFactory = () => Promise<Transport>;
import { buildProviderRegistry } from "./agent/provider-registry.js";
import type { AgentProviderRuntimeSettingsMap } from "./agent/provider-launch-config.js";
import { AgentManager } from "./agent/agent-manager.js";
import type {
  AgentTimelineCursor,
  AgentTimelineFetchDirection,
  ManagedAgent,
} from "./agent/agent-manager.js";
import { scheduleAgentMetadataGeneration } from "./agent/agent-metadata-generator.js";
import { toAgentPayload } from "./agent/agent-projections.js";
import {
  appendTimelineItemIfAgentKnown,
  emitLiveTimelineItemIfAgentKnown,
} from "./agent/timeline-append.js";
import { projectTimelineRows, type TimelineProjectionMode } from "./agent/timeline-projection.js";
import {
  StructuredAgentResponseError,
  generateStructuredAgentResponse,
} from "./agent/agent-response-loop.js";
import type {
  AgentPermissionResponse,
  AgentPromptContentBlock,
  AgentPromptInput,
  AgentRunOptions,
  McpServerConfig,
  AgentSessionConfig,
  AgentStreamEvent,
  AgentProvider,
  AgentPersistenceHandle,
} from "./agent/agent-sdk-types.js";
import { AgentStorage, type StoredAgentRecord } from "./agent/agent-storage.js";
import { isValidAgentProvider, AGENT_PROVIDER_IDS } from "./agent/provider-manifest.js";
import {
  buildVoiceAgentMcpServerConfig,
  buildVoiceModeSystemPrompt,
  stripVoiceModeSystemPrompt,
} from "./voice-config.js";
import { isVoicePermissionAllowed } from "./voice-permission-policy.js";
import {
  listDirectoryEntries,
  readExplorerFile,
  getDownloadableFileInfo,
} from "./file-explorer/service.js";
import { DownloadTokenStore } from "./file-download/token-store.js";
import { PushTokenStore } from "./push/token-store.js";
import {
  type WorktreeConfig,
  slugify,
  validateBranchSlug,
  listPaseoWorktrees,
  deletePaseoWorktree,
  isPaseoOwnedWorktreeCwd,
  resolvePaseoWorktreeRootForCwd,
} from "../utils/worktree.js";
import {
  createAgentWorktree,
  runAsyncWorktreeBootstrap,
} from "./worktree-bootstrap.js";
import {
  getCheckoutDiff,
  getCheckoutStatus,
  getCheckoutStatusLite,
  listBranchSuggestions,
  NotGitRepoError,
  MergeConflictError,
  MergeFromBaseConflictError,
  commitChanges,
  mergeToBase,
  mergeFromBase,
  pushCurrentBranch,
  createPullRequest,
  getPullRequestStatus,
} from "../utils/checkout-git.js";
import { getProjectIcon } from "../utils/project-icon.js";
import { expandTilde } from "../utils/path.js";
import {
  ensureLocalSpeechModels,
  getLocalSpeechModelDir,
  listLocalSpeechModels,
  type LocalSpeechModelId,
} from "./speech/providers/local/models.js";
import type { Resolvable } from "./speech/provider-resolver.js";
import type { SpeechReadinessSnapshot, SpeechReadinessState } from "./speech/speech-runtime.js";
import type pino from "pino";

const execAsync = promisify(exec);
const READ_ONLY_GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_OPTIONAL_LOCKS: "0",
};
const pendingAgentInitializations = new Map<string, Promise<ManagedAgent>>();
let restartRequested = false;
const DEFAULT_AGENT_PROVIDER = AGENT_PROVIDER_IDS[0];
const RESTART_EXIT_DELAY_MS = 250;
const CHECKOUT_DIFF_WATCH_DEBOUNCE_MS = 150;
const CHECKOUT_DIFF_FALLBACK_REFRESH_MS = 5_000;
const TERMINAL_STREAM_WINDOW_BYTES = 256 * 1024;
const TERMINAL_STREAM_MAX_PENDING_BYTES = 2 * 1024 * 1024;
const TERMINAL_STREAM_MAX_PENDING_CHUNKS = 2048;

/**
 * Default model used for auto-generating commit messages and PR descriptions.
 * Uses Claude Haiku for speed and cost efficiency.
 */
const AUTO_GEN_MODEL = "haiku";

function deriveRemoteProjectKey(remoteUrl: string | null): string | null {
  if (!remoteUrl) {
    return null;
  }

  const trimmed = remoteUrl.trim();
  if (!trimmed) {
    return null;
  }

  let host: string | null = null;
  let path: string | null = null;

  const scpLike = trimmed.match(/^[^@]+@([^:]+):(.+)$/);
  if (scpLike) {
    host = scpLike[1] ?? null;
    path = scpLike[2] ?? null;
  } else if (trimmed.includes("://")) {
    try {
      const parsed = new URL(trimmed);
      host = parsed.hostname || null;
      path = parsed.pathname ? parsed.pathname.replace(/^\//, "") : null;
    } catch {
      return null;
    }
  }

  if (!host || !path) {
    return null;
  }

  let cleanedPath = path.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (cleanedPath.endsWith(".git")) {
    cleanedPath = cleanedPath.slice(0, -4);
  }
  if (!cleanedPath.includes("/")) {
    return null;
  }

  const cleanedHost = host.toLowerCase();
  if (cleanedHost === "github.com") {
    return `remote:github.com/${cleanedPath}`;
  }

  return `remote:${cleanedHost}/${cleanedPath}`;
}

function deriveProjectGroupingKey(options: {
  cwd: string;
  remoteUrl: string | null;
}): string {
  const remoteKey = deriveRemoteProjectKey(options.remoteUrl);
  if (remoteKey) {
    return remoteKey;
  }

  const worktreeMarker = ".paseo/worktrees/";
  const idx = options.cwd.indexOf(worktreeMarker);
  if (idx !== -1) {
    return options.cwd.slice(0, idx).replace(/\/$/, "");
  }

  return options.cwd;
}

function deriveProjectGroupingName(projectKey: string): string {
  const githubRemotePrefix = "remote:github.com/";
  if (projectKey.startsWith(githubRemotePrefix)) {
    return projectKey.slice(githubRemotePrefix.length) || projectKey;
  }

  const segments = projectKey.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] || projectKey;
}

type ProcessingPhase = "idle" | "transcribing";

type CheckoutDiffCompareInput = SubscribeCheckoutDiffRequest["compare"];

type CheckoutDiffSnapshotPayload = Omit<
  Extract<SessionOutboundMessage, { type: "checkout_diff_update" }>["payload"],
  "subscriptionId"
>;

type CheckoutDiffWatchTarget = {
  key: string;
  cwd: string;
  diffCwd: string;
  compare: CheckoutDiffCompareInput;
  subscriptions: Set<string>;
  watchers: FSWatcher[];
  fallbackRefreshInterval: NodeJS.Timeout | null;
  debounceTimer: NodeJS.Timeout | null;
  refreshPromise: Promise<void> | null;
  refreshQueued: boolean;
  latestPayload: CheckoutDiffSnapshotPayload | null;
  latestFingerprint: string | null;
};

type NormalizedGitOptions = {
  baseBranch?: string;
  createNewBranch: boolean;
  newBranchName?: string;
  createWorktree: boolean;
  worktreeSlug?: string;
};

type CheckoutErrorCode = "NOT_GIT_REPO" | "NOT_ALLOWED" | "MERGE_CONFLICT" | "UNKNOWN";

type CheckoutErrorPayload = {
  code: CheckoutErrorCode;
  message: string;
};

type TerminalStreamPendingChunk = {
  data: string;
  startOffset: number;
  endOffset: number;
  replay: boolean;
};

type FetchAgentsRequestMessage = Extract<
  SessionInboundMessage,
  { type: "fetch_agents_request" }
>;
type FetchAgentsRequestSort = NonNullable<FetchAgentsRequestMessage["sort"]>[number];
type FetchAgentsResponsePayload = Extract<
  SessionOutboundMessage,
  { type: "fetch_agents_response" }
>["payload"];
type FetchAgentsResponseEntry = FetchAgentsResponsePayload["entries"][number];
type FetchAgentsResponsePageInfo = FetchAgentsResponsePayload["pageInfo"];
type FetchAgentsCursor = {
  sort: FetchAgentsRequestSort[];
  values: Record<string, string | number | null>;
  id: string;
};

class SessionRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SessionRequestError";
  }
}

const PCM_SAMPLE_RATE = 16000;
const PCM_CHANNELS = 1;
const PCM_BITS_PER_SAMPLE = 16;
const PCM_BYTES_PER_MS =
  (PCM_SAMPLE_RATE * PCM_CHANNELS * (PCM_BITS_PER_SAMPLE / 8)) / 1000;
const MIN_STREAMING_SEGMENT_DURATION_MS = 1000;
const MIN_STREAMING_SEGMENT_BYTES = Math.round(
  PCM_BYTES_PER_MS * MIN_STREAMING_SEGMENT_DURATION_MS
);
const VOICE_MODE_INACTIVITY_FLUSH_MS = 4500;
const VOICE_INTERNAL_DICTATION_ID_PREFIX = "__voice_turn__:";
const SAFE_GIT_REF_PATTERN = /^[A-Za-z0-9._\/-]+$/;
const AgentIdSchema = z.string().uuid();
const VOICE_MCP_SERVER_NAME = "paseo_voice";

type VoiceModeBaseConfig = {
  systemPrompt?: string;
  mcpServers?: Record<string, McpServerConfig>;
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
  onMessage: (msg: SessionOutboundMessage) => void;
  onBinaryMessage?: (frame: BinaryMuxFrame) => void;
  logger: pino.Logger;
  downloadTokenStore: DownloadTokenStore;
  pushTokenStore: PushTokenStore;
  paseoHome: string;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  createAgentMcpTransport: AgentMcpTransportFactory;
  stt: Resolvable<SpeechToTextProvider | null>;
  tts: Resolvable<TextToSpeechProvider | null>;
  terminalManager: TerminalManager | null;
  voice?: {
    voiceAgentMcpStdio?: VoiceMcpStdioConfig | null;
  };
  voiceBridge?: {
    registerVoiceSpeakHandler?: (agentId: string, handler: VoiceSpeakHandler) => void;
    unregisterVoiceSpeakHandler?: (agentId: string) => void;
    registerVoiceCallerContext?: (agentId: string, context: VoiceCallerContext) => void;
    unregisterVoiceCallerContext?: (agentId: string) => void;
    ensureVoiceMcpSocketForAgent?: (agentId: string) => Promise<string>;
    removeVoiceMcpSocketForAgent?: (agentId: string) => Promise<void>;
  };
  dictation?: {
    finalTimeoutMs?: number;
    stt?: Resolvable<SpeechToTextProvider | null>;
    localModels?: {
      modelsDir: string;
      defaultModelIds: LocalSpeechModelId[];
    };
    getSpeechReadiness?: () => SpeechReadinessSnapshot;
  };
  agentProviderRuntimeSettings?: AgentProviderRuntimeSettingsMap;
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
  bitsPerSample: number
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

function coerceAgentProvider(
  logger: pino.Logger,
  value: string,
  agentId?: string
): AgentProvider {
  if (isValidAgentProvider(value)) {
    return value;
  }
  logger.warn(
    { value, agentId, defaultProvider: DEFAULT_AGENT_PROVIDER },
    `Unknown provider '${value}' for agent ${agentId ?? "unknown"}; defaulting to '${DEFAULT_AGENT_PROVIDER}'`
  );
  return DEFAULT_AGENT_PROVIDER;
}

function toAgentPersistenceHandle(
  logger: pino.Logger,
  handle: StoredAgentRecord["persistence"]
): AgentPersistenceHandle | null {
  if (!handle) {
    return null;
  }
  const provider = handle.provider;
  if (!isValidAgentProvider(provider)) {
    logger.warn(
      { provider },
      `Ignoring persistence handle with unknown provider '${provider}'`
    );
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
  private readonly sessionId: string;
  private readonly onMessage: (msg: SessionOutboundMessage) => void;
  private readonly onBinaryMessage: ((frame: BinaryMuxFrame) => void) | null;
  private readonly sessionLogger: pino.Logger;
  private readonly paseoHome: string;

  // State machine
  private abortController: AbortController;
  private processingPhase: ProcessingPhase = "idle";

  // Voice mode state
  private isVoiceMode = false;
  private speechInProgress = false;

  private readonly dictationStreamManager: DictationStreamManager;
  private readonly voiceStreamManager: DictationStreamManager;

  // Audio buffering for interruption handling
  private pendingAudioSegments: Array<{ audio: Buffer; format: string }> = [];
  private bufferTimeout: NodeJS.Timeout | null = null;
  private voiceModeInactivityTimeout: NodeJS.Timeout | null = null;
  private audioBuffer: AudioBufferState | null = null;
  private activeVoiceDictationId: string | null = null;
  private activeVoiceDictationFormat: string | null = null;
  private activeVoiceDictationNextSeq = 0;
  private activeVoiceDictationStartPromise: Promise<void> | null = null;
  private activeVoiceDictationFinalizePromise: Promise<void> | null = null;
  private activeVoiceDictationResultPromise:
    | Promise<{ text: string; debugRecordingPath?: string }>
    | null = null;
  private activeVoiceDictationResolve:
    | ((value: { text: string; debugRecordingPath?: string }) => void)
    | null = null;
  private activeVoiceDictationReject: ((error: Error) => void) | null = null;

  // Optional TTS debug capture (persisted per utterance)
  private readonly ttsDebugStreams = new Map<
    string,
    { format: string; chunks: Buffer[] }
  >();

  // Per-session managers
  private readonly ttsManager: TTSManager;
  private readonly sttManager: STTManager;

  // Per-session MCP client and tools
  private agentMcpClient: Awaited<
    ReturnType<typeof experimental_createMCPClient>
  > | null = null;
  private agentTools: ToolSet | null = null;
  private agentManager: AgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly createAgentMcpTransport: AgentMcpTransportFactory;
  private readonly downloadTokenStore: DownloadTokenStore;
  private readonly pushTokenStore: PushTokenStore;
  private readonly providerRegistry: ReturnType<typeof buildProviderRegistry>;
  private unsubscribeAgentEvents: (() => void) | null = null;
  private agentUpdatesSubscription:
    | {
        subscriptionId: string;
        filter?: { labels?: Record<string, string>; agentId?: string };
      }
    | null = null;
  private clientActivity: {
    deviceType: "web" | "mobile";
    focusedAgentId: string | null;
    lastActivityAt: Date;
    appVisible: boolean;
    appVisibilityChangedAt: Date;
  } | null = null;
  private readonly MOBILE_BACKGROUND_STREAM_GRACE_MS = 60_000;
  private readonly terminalManager: TerminalManager | null;
  private readonly subscribedTerminalDirectories = new Set<string>();
  private unsubscribeTerminalsChanged: (() => void) | null = null;
  private terminalSubscriptions: Map<string, () => void> = new Map();
  private terminalExitSubscriptions: Map<string, () => void> = new Map();
  private readonly terminalStreams = new Map<
    number,
    {
      terminalId: string;
      unsubscribe: () => void;
      lastOutputOffset: number;
      lastAckOffset: number;
      pendingChunks: TerminalStreamPendingChunk[];
      pendingBytes: number;
    }
  >();
  private readonly terminalStreamByTerminalId = new Map<string, number>();
  private nextTerminalStreamId = 1;
  private readonly checkoutDiffSubscriptions = new Map<string, { targetKey: string }>();
  private readonly checkoutDiffTargets = new Map<string, CheckoutDiffWatchTarget>();
  private readonly voiceAgentMcpStdio: VoiceMcpStdioConfig | null;
  private readonly localSpeechModelsDir: string;
  private readonly defaultLocalSpeechModelIds: LocalSpeechModelId[];
  private readonly registerVoiceSpeakHandler?: (
    agentId: string,
    handler: VoiceSpeakHandler
  ) => void;
  private readonly unregisterVoiceSpeakHandler?: (agentId: string) => void;
  private readonly registerVoiceCallerContext?: (
    agentId: string,
    context: VoiceCallerContext
  ) => void;
  private readonly unregisterVoiceCallerContext?: (agentId: string) => void;
  private readonly ensureVoiceMcpSocketForAgent?: (agentId: string) => Promise<string>;
  private readonly removeVoiceMcpSocketForAgent?: (agentId: string) => Promise<void>;
  private readonly getSpeechReadiness?: () => SpeechReadinessSnapshot;
  private readonly agentProviderRuntimeSettings: AgentProviderRuntimeSettingsMap | undefined;
  private voiceModeAgentId: string | null = null;
  private voiceModeBaseConfig: VoiceModeBaseConfig | null = null;

  constructor(options: SessionOptions) {
    const {
      clientId,
      onMessage,
      onBinaryMessage,
      logger,
      downloadTokenStore,
      pushTokenStore,
      paseoHome,
      agentManager,
      agentStorage,
      createAgentMcpTransport,
      stt,
      tts,
      terminalManager,
      voice,
      voiceBridge,
      dictation,
      agentProviderRuntimeSettings,
    } = options;
    this.clientId = clientId;
    this.sessionId = uuidv4();
    this.onMessage = onMessage;
    this.onBinaryMessage = onBinaryMessage ?? null;
    this.downloadTokenStore = downloadTokenStore;
    this.pushTokenStore = pushTokenStore;
    this.paseoHome = paseoHome;
    this.agentManager = agentManager;
    this.agentStorage = agentStorage;
    this.createAgentMcpTransport = createAgentMcpTransport;
    this.terminalManager = terminalManager;
    if (this.terminalManager) {
      this.unsubscribeTerminalsChanged = this.terminalManager.subscribeTerminalsChanged(
        (event) => this.handleTerminalsChanged(event)
      );
    }
    this.voiceAgentMcpStdio = voice?.voiceAgentMcpStdio ?? null;
    const configuredModelsDir = dictation?.localModels?.modelsDir?.trim();
    this.localSpeechModelsDir =
      configuredModelsDir && configuredModelsDir.length > 0
        ? configuredModelsDir
        : join(this.paseoHome, "models", "local-speech");
    this.defaultLocalSpeechModelIds =
      dictation?.localModels?.defaultModelIds && dictation.localModels.defaultModelIds.length > 0
        ? [...new Set(dictation.localModels.defaultModelIds)]
        : ["parakeet-tdt-0.6b-v2-int8", "kokoro-en-v0_19"];
    this.registerVoiceSpeakHandler = voiceBridge?.registerVoiceSpeakHandler;
    this.unregisterVoiceSpeakHandler = voiceBridge?.unregisterVoiceSpeakHandler;
    this.registerVoiceCallerContext = voiceBridge?.registerVoiceCallerContext;
    this.unregisterVoiceCallerContext = voiceBridge?.unregisterVoiceCallerContext;
    this.ensureVoiceMcpSocketForAgent = voiceBridge?.ensureVoiceMcpSocketForAgent;
    this.removeVoiceMcpSocketForAgent = voiceBridge?.removeVoiceMcpSocketForAgent;
    this.getSpeechReadiness = dictation?.getSpeechReadiness;
    this.agentProviderRuntimeSettings = agentProviderRuntimeSettings;
    this.abortController = new AbortController();
    this.sessionLogger = logger.child({
      module: "session",
      clientId: this.clientId,
      sessionId: this.sessionId,
    });
    this.providerRegistry = buildProviderRegistry(this.sessionLogger, {
      runtimeSettings: this.agentProviderRuntimeSettings,
    });

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
    this.voiceStreamManager = new DictationStreamManager({
      logger: this.sessionLogger.child({ stream: "voice-internal" }),
      sessionId: this.sessionId,
      emit: (msg) => this.handleDictationManagerMessage(msg),
      stt: stt,
      finalTimeoutMs: dictation?.finalTimeoutMs,
    });

    // Initialize agent MCP client asynchronously
    void this.initializeAgentMcp();
    this.subscribeToAgentEvents();

    this.sessionLogger.trace("Session created");
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
    images?: Array<{ data: string; mimeType: string }>
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
      throw new Error(`Agent ${agentId} not found`);
    }

    if (snapshot.lifecycle !== "running" && !snapshot.pendingRun) {
      this.sessionLogger.debug(
        { agentId, lifecycle: snapshot.lifecycle, pendingRun: Boolean(snapshot.pendingRun) },
        "interruptAgentIfRunning: not running, skipping"
      );
      return;
    }

    this.sessionLogger.debug(
      { agentId, lifecycle: snapshot.lifecycle, pendingRun: Boolean(snapshot.pendingRun) },
      "interruptAgentIfRunning: interrupting"
    );

    try {
      const t0 = Date.now();
      const cancelled = await this.agentManager.cancelAgentRun(agentId);
      this.sessionLogger.debug(
        { agentId, cancelled, durationMs: Date.now() - t0 },
        "interruptAgentIfRunning: cancelAgentRun completed"
      );
      if (!cancelled) {
        this.sessionLogger.warn(
          { agentId },
          "interruptAgentIfRunning: reported running but no active run was cancelled"
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

    const snapshot = this.agentManager.getAgent(agentId);
    if (!snapshot) {
      return false;
    }

    return snapshot.lifecycle === "running" || Boolean(snapshot.pendingRun);
  }

  /**
   * Start streaming an agent run and forward results via the websocket broadcast
   */
  private startAgentStream(
    agentId: string,
    prompt: AgentPromptInput,
    runOptions?: AgentRunOptions
  ): { ok: true } | { ok: false; error: string } {
    this.sessionLogger.info(
      { agentId },
      `Starting agent stream for ${agentId}`
    );

    let iterator: AsyncGenerator<AgentStreamEvent>;
    try {
      iterator = this.agentManager.streamAgent(agentId, prompt, runOptions);
    } catch (error) {
      this.handleAgentRunError(agentId, error, "Failed to start agent run");
      const message =
        error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";
      return { ok: false, error: message };
    }

    void (async () => {
      try {
        for await (const _ of iterator) {
          // Events are forwarded via the session's AgentManager subscription.
        }
      } catch (error) {
        this.handleAgentRunError(agentId, error, "Agent stream failed");
      }
    })();

    return { ok: true };
  }

  private handleAgentRunError(
    agentId: string,
    error: unknown,
    context: string
  ): void {
    const message =
      error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";
    this.sessionLogger.error(
      { err: error, agentId, context },
      `${context} for agent ${agentId}`
    );
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
   * Initialize Agent MCP client for this session using in-memory transport
   */
  private async initializeAgentMcp(): Promise<void> {
    try {
      // Create an in-memory transport connected to the Agent MCP server
      const transport = await this.createAgentMcpTransport();

      this.agentMcpClient = await experimental_createMCPClient({
        transport,
      });

      this.agentTools = (await this.agentMcpClient.tools()) as ToolSet;
      const agentToolCount = Object.keys(this.agentTools ?? {}).length;
      this.sessionLogger.trace(
        { agentToolCount },
        `Agent MCP initialized with ${agentToolCount} tools`
      );
    } catch (error) {
      this.sessionLogger.error(
        { err: error },
        "Failed to initialize Agent MCP"
      );
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
                "Failed to auto-allow speak tool permission in voice mode"
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
      { replayState: false }
    );
  }

  private async buildAgentPayload(
    agent: ManagedAgent
  ): Promise<AgentSnapshotPayload> {
    const storedRecord = await this.agentStorage.get(agent.id);
    const title = storedRecord?.title ?? null;
    const payload = toAgentPayload(agent, { title });
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
    const updatedAt = new Date(record.lastActivityAt ?? record.updatedAt);
    const lastUserMessageAt = record.lastUserMessageAt
      ? new Date(record.lastUserMessageAt)
      : null;

    const provider = coerceAgentProvider(this.sessionLogger, record.provider, record.id);
    return {
      id: record.id,
      provider,
      cwd: record.cwd,
      model: record.config?.model ?? null,
      thinkingOptionId: record.config?.thinkingOptionId ?? null,
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
      lastUserMessageAt: lastUserMessageAt ? lastUserMessageAt.toISOString() : null,
      status: record.lastStatus,
      capabilities: defaultCapabilities,
      currentModeId: record.lastModeId ?? null,
      availableModes: [],
      pendingPermissions: [],
      persistence: toAgentPersistenceHandle(this.sessionLogger, record.persistence),
      lastUsage: undefined,
      lastError: undefined,
      title: record.title ?? null,
      requiresAttention: record.requiresAttention ?? false,
      attentionReason: record.attentionReason ?? null,
      attentionTimestamp: record.attentionTimestamp ?? null,
      archivedAt: record.archivedAt ?? null,
      labels: record.labels,
    };
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

      const handle = toAgentPersistenceHandle(this.sessionLogger, record.persistence);
      let snapshot: ManagedAgent;
      if (handle) {
        snapshot = await this.agentManager.resumeAgentFromPersistence(
          handle,
          buildConfigOverrides(record),
          agentId,
          extractTimestamps(record)
        );
        this.sessionLogger.info(
          { agentId, provider: record.provider },
          "Agent resumed from persistence"
        );
      } else {
        const config = buildSessionConfig(record);
        snapshot = await this.agentManager.createAgent(config, agentId, { labels: record.labels });
        this.sessionLogger.info(
          { agentId, provider: record.provider },
          "Agent created from stored config"
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

  private matchesAgentFilter(
    agent: AgentSnapshotPayload,
    filter?: { labels?: Record<string, string>; agentId?: string }
  ): boolean {
    if (filter?.agentId && agent.id !== filter.agentId) {
      return false;
    }
    if (!filter?.labels) {
      return true;
    }
    return Object.entries(filter.labels).every(
      ([key, value]) => agent.labels[key] === value
    );
  }

  private buildFallbackProjectCheckout(cwd: string): ProjectCheckoutLitePayload {
    return {
      cwd,
      isGit: false,
      currentBranch: null,
      remoteUrl: null,
      isPaseoOwnedWorktree: false,
      mainRepoRoot: null,
    };
  }

  private toProjectCheckoutLite(
    cwd: string,
    status: Awaited<ReturnType<typeof getCheckoutStatusLite>>
  ): ProjectCheckoutLitePayload {
    if (!status.isGit) {
      return this.buildFallbackProjectCheckout(cwd);
    }

    if (status.isPaseoOwnedWorktree) {
      return {
        cwd,
        isGit: true,
        currentBranch: status.currentBranch,
        remoteUrl: status.remoteUrl,
        isPaseoOwnedWorktree: true,
        mainRepoRoot: status.mainRepoRoot,
      };
    }

    return {
      cwd,
      isGit: true,
      currentBranch: status.currentBranch,
      remoteUrl: status.remoteUrl,
      isPaseoOwnedWorktree: false,
      mainRepoRoot: null,
    };
  }

  private async buildProjectPlacement(cwd: string): Promise<ProjectPlacementPayload> {
    const checkout = await getCheckoutStatusLite(cwd, { paseoHome: this.paseoHome })
      .then((status) => this.toProjectCheckoutLite(cwd, status))
      .catch(() => this.buildFallbackProjectCheckout(cwd));
    const projectKey = deriveProjectGroupingKey({
      cwd,
      remoteUrl: checkout.remoteUrl,
    });
    return {
      projectKey,
      projectName: deriveProjectGroupingName(projectKey),
      checkout,
    };
  }

  private async forwardAgentUpdate(agent: ManagedAgent): Promise<void> {
    try {
      const subscription = this.agentUpdatesSubscription;
      if (!subscription) {
        return;
      }

      const payload = await this.buildAgentPayload(agent);
      const matches = this.matchesAgentFilter(payload, subscription.filter);

      if (matches) {
        const project = await this.buildProjectPlacement(payload.cwd);
        this.emit({
          type: "agent_update",
          payload: { kind: "upsert", agent: payload, project },
        });
        return;
      }

      this.emit({
        type: "agent_update",
        payload: { kind: "remove", agentId: payload.id },
      });
    } catch (error) {
      this.sessionLogger.error({ err: error }, "Failed to emit agent update");
    }
  }

  /**
   * Main entry point for processing session messages
   */
  public async handleMessage(msg: SessionInboundMessage): Promise<void> {
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

        case "fetch_agent_request":
          await this.handleFetchAgent(msg.agentId, msg.requestId);
          break;

        case "subscribe_agent_updates":
          this.agentUpdatesSubscription = {
            subscriptionId: msg.subscriptionId,
            filter: msg.filter,
          };
          break;

        case "unsubscribe_agent_updates":
          if (
            this.agentUpdatesSubscription?.subscriptionId === msg.subscriptionId
          ) {
            this.agentUpdatesSubscription = null;
          }
          break;

        case "delete_agent_request":
          await this.handleDeleteAgentRequest(msg.agentId, msg.requestId);
          break;

        case "archive_agent_request":
          await this.handleArchiveAgentRequest(msg.agentId, msg.requestId);
          break;

        case "update_agent_request":
          await this.handleUpdateAgentRequest(
            msg.agentId,
            msg.name,
            msg.labels,
            msg.requestId
          );
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

        case "fetch_agent_timeline_request":
          await this.handleFetchAgentTimelineRequest(msg);
          break;

        case "set_agent_mode_request":
          await this.handleSetAgentModeRequest(msg.agentId, msg.modeId, msg.requestId);
          break;

        case "set_agent_model_request":
          await this.handleSetAgentModelRequest(msg.agentId, msg.modelId, msg.requestId);
          break;

        case "set_agent_thinking_request":
          await this.handleSetAgentThinkingRequest(
            msg.agentId,
            msg.thinkingOptionId,
            msg.requestId
          );
          break;

        case "agent_permission_response":
          await this.handleAgentPermissionResponse(
            msg.agentId,
            msg.requestId,
            msg.response
          );
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

        case "subscribe_checkout_diff_request":
          await this.handleSubscribeCheckoutDiffRequest(msg);
          break;

        case "unsubscribe_checkout_diff_request":
          this.handleUnsubscribeCheckoutDiffRequest(msg);
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

	        case "checkout_push_request":
	          await this.handleCheckoutPushRequest(msg);
	          break;

	        case "checkout_pr_create_request":
	          await this.handleCheckoutPrCreateRequest(msg);
	          break;

        case "checkout_pr_status_request":
          await this.handleCheckoutPrStatusRequest(msg);
          break;

        case "paseo_worktree_list_request":
          await this.handlePaseoWorktreeListRequest(msg);
          break;

        case "paseo_worktree_archive_request":
          await this.handlePaseoWorktreeArchiveRequest(msg);
          break;

        case "file_explorer_request":
          await this.handleFileExplorerRequest(msg);
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

        case "list_available_providers_request":
          await this.handleListAvailableProvidersRequest(msg);
          break;

        case "speech_models_list_request":
          await this.handleSpeechModelsListRequest(msg);
          break;

        case "speech_models_download_request":
          await this.handleSpeechModelsDownloadRequest(msg);
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
          await this.handleListCommandsRequest(msg.agentId, msg.requestId);
          break;

        case "execute_command_request":
          await this.handleExecuteCommandRequest(
            msg.agentId,
            msg.commandName,
            msg.args,
            msg.requestId
          );
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

        case "attach_terminal_stream_request":
          await this.handleAttachTerminalStreamRequest(msg);
          break;

        case "detach_terminal_stream_request":
          this.handleDetachTerminalStreamRequest(msg);
          break;
      }
    } catch (error: any) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.sessionLogger.error(
        { err },
        "Error handling message"
      );

      const requestId = (msg as { requestId?: unknown }).requestId;
      if (typeof requestId === "string") {
        try {
          this.emit({
            type: "rpc_error",
            payload: {
              requestId,
              requestType: msg.type,
              error: "Request failed",
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
  }

  public handleBinaryFrame(frame: BinaryMuxFrame): void {
    switch (frame.channel) {
      case BinaryMuxChannel.Terminal:
        this.handleTerminalBinaryFrame(frame);
        break;
      default:
        this.sessionLogger.warn(
          { channel: frame.channel, messageType: frame.messageType },
          "Unhandled binary mux channel"
        );
        break;
    }
  }

  private handleTerminalBinaryFrame(frame: BinaryMuxFrame): void {
    if (frame.messageType === TerminalBinaryMessageType.InputUtf8) {
      const binding = this.terminalStreams.get(frame.streamId);
      if (!binding) {
        this.sessionLogger.warn({ streamId: frame.streamId }, "Terminal stream not found for input");
        return;
      }
      if (!this.terminalManager) {
        return;
      }
      const session = this.terminalManager.getTerminal(binding.terminalId);
      if (!session) {
        this.detachTerminalStream(frame.streamId, { emitExit: true });
        return;
      }

      const payload = frame.payload ?? new Uint8Array(0);
      if (payload.byteLength === 0) {
        return;
      }
      const text = Buffer.from(payload).toString("utf8");
      if (!text) {
        return;
      }
      session.send({ type: "input", data: text });
      return;
    }

    if (frame.messageType === TerminalBinaryMessageType.Ack) {
      const binding = this.terminalStreams.get(frame.streamId);
      if (binding) {
        if (!Number.isFinite(frame.offset) || frame.offset < 0) {
          return;
        }
        const nextAckOffset = Math.max(
          binding.lastAckOffset,
          Math.min(Math.floor(frame.offset), binding.lastOutputOffset)
        );
        if (nextAckOffset > binding.lastAckOffset) {
          binding.lastAckOffset = nextAckOffset;
          this.flushPendingTerminalStreamChunks(frame.streamId, binding);
        }
      }
      return;
    }

    this.sessionLogger.warn(
      { streamId: frame.streamId, messageType: frame.messageType },
      "Unhandled terminal binary frame"
    );
  }

  private async handleRestartServerRequest(
    requestId: string,
    reason?: string
  ): Promise<void> {
    if (restartRequested) {
      this.sessionLogger.debug("Restart already requested, ignoring duplicate");
      return;
    }

    restartRequested = true;
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

    if (typeof process.send === "function") {
      process.send({
        type: "paseo:restart",
        ...(reason ? { reason } : {}),
      });
      return;
    }

    setTimeout(() => {
      process.exit(0);
    }, RESTART_EXIT_DELAY_MS);
  }

  private async handleDeleteAgentRequest(
    agentId: string,
    requestId: string
  ): Promise<void> {
    this.sessionLogger.info(
      { agentId },
      `Deleting agent ${agentId} from registry`
    );

    // Prevent the persistence hook from re-creating the record while we close/delete.
    this.agentStorage.beginDelete(agentId);

    try {
      await this.agentManager.closeAgent(agentId);
    } catch (error: any) {
      this.sessionLogger.warn(
        { err: error, agentId },
        `Failed to close agent ${agentId} during delete`
      );
    }

    try {
      await this.agentStorage.remove(agentId);
    } catch (error: any) {
      this.sessionLogger.error(
        { err: error, agentId },
        `Failed to remove agent ${agentId} from registry`
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
      this.emit({
        type: "agent_update",
        payload: { kind: "remove", agentId },
      });
    }
  }

  private async handleArchiveAgentRequest(
    agentId: string,
    requestId: string
  ): Promise<void> {
    this.sessionLogger.info(
      { agentId },
      `Archiving agent ${agentId}`
    );

    const archivedAt = new Date().toISOString();

    try {
      const existing = await this.agentStorage.get(agentId);
      if (existing) {
        await this.agentStorage.upsert({
          ...existing,
          archivedAt,
        });
      }
      this.agentManager.notifyAgentState(agentId);
    } catch (error: any) {
      this.sessionLogger.error(
        { err: error, agentId },
        `Failed to archive agent ${agentId}`
      );
    }

    this.emit({
      type: "agent_archived",
      payload: {
        agentId,
        archivedAt,
        requestId,
      },
    });
  }

  private async handleUpdateAgentRequest(
    agentId: string,
    name: string | undefined,
    labels: Record<string, string> | undefined,
    requestId: string
  ): Promise<void> {
    this.sessionLogger.info(
      { agentId, requestId, hasName: typeof name === "string", labelCount: labels ? Object.keys(labels).length : 0 },
      "session: update_agent_request"
    );

    const normalizedName = name?.trim();
    const normalizedLabels =
      labels && Object.keys(labels).length > 0 ? labels : undefined;

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
          ...(normalizedLabels
            ? { labels: { ...existing.labels, ...normalizedLabels } }
            : {}),
        });
      }

      this.emit({
        type: "update_agent_response",
        payload: { requestId, agentId, accepted: true, error: null },
      });
    } catch (error: any) {
      this.sessionLogger.error(
        { err: error, agentId, requestId },
        "session: update_agent_request error"
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
    state: SpeechReadinessState
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
    mode: "voice_mode" | "dictation"
  ): SpeechReadinessState {
    if (mode === "voice_mode") {
      return readiness.realtimeVoice;
    }
    return readiness.dictation;
  }

  private getVoiceFeatureUnavailableResponseMetadata(
    error: unknown
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
    mode: "voice_mode" | "dictation"
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
    requestId?: string
  ): Promise<void> {
    try {
      if (enabled) {
        const unavailable = this.resolveVoiceFeatureUnavailableContext("voice_mode");
        if (unavailable) {
          throw new VoiceFeatureUnavailableError(unavailable);
        }

        const normalizedAgentId = this.parseVoiceTargetAgentId(
          agentId ?? "",
          "set_voice_mode"
        );

        if (
          this.isVoiceMode &&
          this.voiceModeAgentId &&
          this.voiceModeAgentId !== normalizedAgentId
        ) {
          await this.disableVoiceModeForActiveAgent(true);
        }

        if (!this.isVoiceMode || this.voiceModeAgentId !== normalizedAgentId) {
          const refreshedAgentId = await this.enableVoiceModeForAgent(normalizedAgentId);
          this.voiceModeAgentId = refreshedAgentId;
        }

        this.isVoiceMode = true;
        this.sessionLogger.info(
          {
            agentId: this.voiceModeAgentId,
          },
          "Voice mode enabled for existing agent"
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

      await this.disableVoiceModeForActiveAgent(true);
      this.isVoiceMode = false;
      this.sessionLogger.info("Voice mode disabled");
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
      const errorMessage =
        error instanceof Error ? error.message : "Failed to set voice mode";
      const unavailable = this.getVoiceFeatureUnavailableResponseMetadata(error);
      this.sessionLogger.error(
        {
          err: error,
          enabled,
          requestedAgentId: agentId ?? null,
        },
        "set_voice_mode failed"
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

  private cloneMcpServers(
    servers: Record<string, McpServerConfig> | undefined
  ): Record<string, McpServerConfig> | undefined {
    if (!servers) {
      return undefined;
    }
    return JSON.parse(JSON.stringify(servers)) as Record<string, McpServerConfig>;
  }

  private buildVoiceModeMcpServers(
    existing: Record<string, McpServerConfig> | undefined,
    socketPath: string
  ): Record<string, McpServerConfig> {
    const mcpStdio = this.voiceAgentMcpStdio;
    if (!mcpStdio) {
      throw new Error("Voice MCP stdio bridge is not configured");
    }
    return {
      ...(existing ?? {}),
      [VOICE_MCP_SERVER_NAME]: buildVoiceAgentMcpServerConfig({
        command: mcpStdio.command,
        baseArgs: mcpStdio.baseArgs,
        socketPath,
        env: mcpStdio.env,
      }),
    };
  }

  private async enableVoiceModeForAgent(agentId: string): Promise<string> {
    const ensureVoiceSocket = this.ensureVoiceMcpSocketForAgent;
    if (!ensureVoiceSocket) {
      throw new Error("Voice MCP socket bridge is not configured");
    }

    const existing = await this.ensureAgentLoaded(agentId);

    const socketPath = await ensureVoiceSocket(agentId);
    this.registerVoiceBridgeForAgent(agentId);

    const baseConfig: VoiceModeBaseConfig = {
      systemPrompt: stripVoiceModeSystemPrompt(existing.config.systemPrompt),
      mcpServers: this.cloneMcpServers(existing.config.mcpServers),
    };
    this.voiceModeBaseConfig = baseConfig;
    const refreshOverrides: Partial<AgentSessionConfig> = {
      systemPrompt: buildVoiceModeSystemPrompt(baseConfig.systemPrompt, true),
      mcpServers: this.buildVoiceModeMcpServers(baseConfig.mcpServers, socketPath),
    };

    try {
      const refreshed = await this.agentManager.reloadAgentSession(
        agentId,
        refreshOverrides
      );
      return refreshed.id;
    } catch (error) {
      this.unregisterVoiceSpeakHandler?.(agentId);
      this.unregisterVoiceCallerContext?.(agentId);
      await this.removeVoiceMcpSocketForAgent?.(agentId).catch(() => undefined);
      this.voiceModeBaseConfig = null;
      throw error;
    }
  }

  private async disableVoiceModeForActiveAgent(
    restoreAgentConfig: boolean
  ): Promise<void> {
    this.clearVoiceModeInactivityTimeout();
    this.cancelActiveVoiceDictationStream("voice mode disabled");

    const agentId = this.voiceModeAgentId;
    if (!agentId) {
      this.voiceModeBaseConfig = null;
      return;
    }

    this.unregisterVoiceSpeakHandler?.(agentId);
    this.unregisterVoiceCallerContext?.(agentId);
    await this.removeVoiceMcpSocketForAgent?.(agentId).catch((error) => {
      this.sessionLogger.warn(
        { err: error, agentId },
        "Failed to remove voice MCP socket bridge on disable"
      );
    });

    if (restoreAgentConfig && this.voiceModeBaseConfig) {
      const baseConfig = this.voiceModeBaseConfig;
      try {
        await this.agentManager.reloadAgentSession(agentId, {
          systemPrompt: buildVoiceModeSystemPrompt(baseConfig.systemPrompt, false),
          mcpServers: this.cloneMcpServers(baseConfig.mcpServers),
        });
      } catch (error) {
        this.sessionLogger.warn(
          { err: error, agentId },
          "Failed to restore agent config while disabling voice mode"
        );
      }
    }

    this.voiceModeBaseConfig = null;
    this.voiceModeAgentId = null;
  }

  private isInternalVoiceDictationId(dictationId: string): boolean {
    return dictationId.startsWith(VOICE_INTERNAL_DICTATION_ID_PREFIX);
  }

  private handleDictationManagerMessage(msg: DictationStreamOutboundMessage): void {
    if (msg.type === "activity_log") {
      const metadata = msg.payload.metadata as { dictationId?: unknown } | undefined;
      const dictationId =
        metadata && typeof metadata.dictationId === "string" ? metadata.dictationId : null;
      if (dictationId && this.isInternalVoiceDictationId(dictationId)) {
        return;
      }
      this.emit(msg as unknown as SessionOutboundMessage);
      return;
    }

    const payloadWithDictationId = msg.payload as { dictationId?: unknown };
    const dictationId =
      payloadWithDictationId && typeof payloadWithDictationId.dictationId === "string"
        ? payloadWithDictationId.dictationId
        : null;

    if (!dictationId || !this.isInternalVoiceDictationId(dictationId)) {
      this.emit(msg as unknown as SessionOutboundMessage);
      return;
    }

    if (msg.type === "dictation_stream_final") {
      if (dictationId !== this.activeVoiceDictationId || !this.activeVoiceDictationResolve) {
        return;
      }
      this.activeVoiceDictationResolve({
        text: msg.payload.text,
        ...(msg.payload.debugRecordingPath
          ? { debugRecordingPath: msg.payload.debugRecordingPath }
          : {}),
      });
      return;
    }

    if (msg.type === "dictation_stream_error") {
      if (dictationId !== this.activeVoiceDictationId || !this.activeVoiceDictationReject) {
        return;
      }
      this.activeVoiceDictationReject(new Error(msg.payload.error));
      return;
    }

    // Ack/partial messages for internal voice dictation are consumed server-side.
  }

  private resetActiveVoiceDictationState(): void {
    this.activeVoiceDictationId = null;
    this.activeVoiceDictationFormat = null;
    this.activeVoiceDictationNextSeq = 0;
    this.activeVoiceDictationStartPromise = null;
    this.activeVoiceDictationFinalizePromise = null;
    this.activeVoiceDictationResultPromise = null;
    this.activeVoiceDictationResolve = null;
    this.activeVoiceDictationReject = null;
  }

  private cancelActiveVoiceDictationStream(reason: string): void {
    const dictationId = this.activeVoiceDictationId;
    if (!dictationId) {
      return;
    }

    this.sessionLogger.debug({ dictationId, reason }, "Cancelling active internal voice dictation stream");
    if (this.activeVoiceDictationReject) {
      this.activeVoiceDictationReject(new Error(`Voice dictation cancelled: ${reason}`));
    }
    this.voiceStreamManager.handleCancel(dictationId);
    this.resetActiveVoiceDictationState();
  }

  private async ensureActiveVoiceDictationStream(format: string): Promise<void> {
    if (this.activeVoiceDictationId && this.activeVoiceDictationFormat === format) {
      if (this.activeVoiceDictationStartPromise) {
        await this.activeVoiceDictationStartPromise;
      }
      return;
    }

    if (this.activeVoiceDictationId) {
      await this.finalizeActiveVoiceDictationStream("voice format changed");
    }

    const dictationId = `${VOICE_INTERNAL_DICTATION_ID_PREFIX}${uuidv4()}`;
    let resolve:
      | ((value: { text: string; debugRecordingPath?: string }) => void)
      | null = null;
    let reject: ((error: Error) => void) | null = null;
    const resultPromise = new Promise<{ text: string; debugRecordingPath?: string }>(
      (resolveFn, rejectFn) => {
        resolve = resolveFn;
        reject = rejectFn;
      }
    );
    // Prevent process-level unhandled rejection warnings when cancellation races are resolved later.
    void resultPromise.catch(() => undefined);

    this.activeVoiceDictationId = dictationId;
    this.activeVoiceDictationFormat = format;
    this.activeVoiceDictationNextSeq = 0;
    this.activeVoiceDictationFinalizePromise = null;
    this.activeVoiceDictationResultPromise = resultPromise;
    this.activeVoiceDictationResolve = resolve;
    this.activeVoiceDictationReject = reject;
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

    const startPromise = this.voiceStreamManager.handleStart(dictationId, format);
    this.activeVoiceDictationStartPromise = startPromise;
    try {
      await startPromise;
    } catch (error) {
      this.resetActiveVoiceDictationState();
      throw error;
    } finally {
      if (this.activeVoiceDictationId === dictationId) {
        this.activeVoiceDictationStartPromise = null;
      }
    }
  }

  private async appendToActiveVoiceDictationStream(
    audioBase64: string,
    format: string
  ): Promise<void> {
    if (this.activeVoiceDictationFinalizePromise) {
      await this.activeVoiceDictationFinalizePromise.catch(() => undefined);
    }
    await this.ensureActiveVoiceDictationStream(format);
    const dictationId = this.activeVoiceDictationId;
    if (!dictationId) {
      throw new Error("Voice dictation stream did not initialize");
    }

    const seq = this.activeVoiceDictationNextSeq;
    this.activeVoiceDictationNextSeq += 1;
    await this.voiceStreamManager.handleChunk({
      dictationId,
      seq,
      audioBase64,
      format,
    });
  }

  private async finalizeActiveVoiceDictationStream(reason: string): Promise<void> {
    const dictationId = this.activeVoiceDictationId;
    if (!dictationId) {
      return;
    }
    this.clearVoiceModeInactivityTimeout();
    if (this.activeVoiceDictationStartPromise) {
      await this.activeVoiceDictationStartPromise;
    }

    if (this.activeVoiceDictationFinalizePromise) {
      await this.activeVoiceDictationFinalizePromise;
      return;
    }

    const finalSeq = this.activeVoiceDictationNextSeq - 1;
    const resultPromise = this.activeVoiceDictationResultPromise;
    if (!resultPromise) {
      this.resetActiveVoiceDictationState();
      return;
    }

    this.activeVoiceDictationFinalizePromise = (async () => {
      this.sessionLogger.debug(
        { dictationId, finalSeq, reason },
        "Finalizing internal voice dictation stream"
      );
      await this.voiceStreamManager.handleFinish(dictationId, finalSeq);
      const result = await resultPromise;
      this.resetActiveVoiceDictationState();
      const requestId = uuidv4();
      const transcriptText = result.text.trim();
      this.sessionLogger.info(
        {
          requestId,
          isVoiceMode: this.isVoiceMode,
          transcriptLength: transcriptText.length,
          transcript: transcriptText,
        },
        "Transcription result"
      );
      await this.handleTranscriptionResultPayload({
        text: result.text,
        requestId,
        ...(result.debugRecordingPath
          ? { debugRecordingPath: result.debugRecordingPath, format: "audio/wav" }
          : {}),
      });
    })();

    try {
      await this.activeVoiceDictationFinalizePromise;
    } catch (error) {
      this.resetActiveVoiceDictationState();
      this.setPhase("idle");
      this.clearSpeechInProgress("transcription error");
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Transcription error: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      });
      throw error;
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
    runOptions?: AgentRunOptions
  ): Promise<void> {
    this.sessionLogger.info(
      { agentId, textPreview: text.substring(0, 50), imageCount: images?.length ?? 0 },
      `Sending text to agent ${agentId}${images && images.length > 0 ? ` with ${images.length} image attachment(s)` : ''}`
    );

    try {
      await this.ensureAgentLoaded(agentId);
    } catch (error) {
      this.handleAgentRunError(
        agentId,
        error,
        "Failed to initialize agent before sending prompt"
      );
      return;
    }

    try {
      await this.interruptAgentIfRunning(agentId);
    } catch (error) {
      this.handleAgentRunError(
        agentId,
        error,
        "Failed to interrupt running agent before sending prompt"
      );
      return;
    }

    const prompt = this.buildAgentPrompt(text, images);

    try {
      this.agentManager.recordUserMessage(agentId, text, {
        messageId,
        emitState: false,
      });
    } catch (error) {
      this.sessionLogger.error(
        { err: error, agentId },
        `Failed to record user message for agent ${agentId}`
      );
    }

    this.startAgentStream(agentId, prompt, runOptions);
  }

  /**
   * Handle create agent request
   */
  private async handleCreateAgentRequest(
    msg: Extract<SessionInboundMessage, { type: "create_agent_request" }>
  ): Promise<void> {
    const { config, worktreeName, requestId, initialPrompt, outputSchema, git, images, labels } = msg;
    this.sessionLogger.info(
      { cwd: config.cwd, provider: config.provider, worktreeName },
      `Creating agent in ${config.cwd} (${config.provider})${
        worktreeName ? ` with worktree ${worktreeName}` : ""
      }`
    );

    try {
      const { sessionConfig, worktreeConfig } = await this.buildAgentSessionConfig(
        config,
        git,
        worktreeName,
        labels
      );
      const snapshot = await this.agentManager.createAgent(
        sessionConfig,
        undefined,
        { labels }
      );
      await this.forwardAgentUpdate(snapshot);

      const trimmedPrompt = initialPrompt?.trim();
      if (trimmedPrompt) {
        scheduleAgentMetadataGeneration({
          agentManager: this.agentManager,
          agentId: snapshot.id,
          cwd: snapshot.cwd,
          initialPrompt: trimmedPrompt,
          explicitTitle: snapshot.config.title,
          paseoHome: this.paseoHome,
          logger: this.sessionLogger,
        });

        try {
          await this.handleSendAgentMessage(
            snapshot.id,
            trimmedPrompt,
            uuidv4(),
            images,
            outputSchema ? { outputSchema } : undefined
          );
        } catch (promptError) {
          this.sessionLogger.error(
            { err: promptError, agentId: snapshot.id },
            `Failed to run initial prompt for agent ${snapshot.id}`
          );
          this.emit({
            type: "activity_log",
            payload: {
              id: uuidv4(),
              timestamp: new Date(),
              type: "error",
              content: `Initial prompt failed: ${(promptError as Error)?.message ?? promptError}`,
            },
          });
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
        `Created agent ${snapshot.id} (${snapshot.provider})`
      );
    } catch (error: any) {
      this.sessionLogger.error(
        { err: error },
        "Failed to create agent"
      );
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
    msg: Extract<SessionInboundMessage, { type: "resume_agent_request" }>
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
      `Resuming agent ${handle.sessionId} (${handle.provider})`
    );
    try {
      const snapshot = await this.agentManager.resumeAgentFromPersistence(
        handle,
        overrides
      );
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
      this.sessionLogger.error(
        { err: error },
        "Failed to resume agent"
      );
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
    msg: Extract<SessionInboundMessage, { type: "refresh_agent_request" }>
  ): Promise<void> {
    const { agentId, requestId } = msg;
    this.sessionLogger.info(
      { agentId },
      `Refreshing agent ${agentId} from persistence`
    );

    try {
      let snapshot: ManagedAgent;
      const existing = this.agentManager.getAgent(agentId);
      if (existing) {
        await this.interruptAgentIfRunning(agentId);
        if (existing.persistence) {
          snapshot = await this.agentManager.reloadAgentSession(
            agentId
          );
        } else {
          snapshot = existing;
        }
      } else {
        const record = await this.agentStorage.get(agentId);
        if (!record) {
          throw new Error(`Agent not found: ${agentId}`);
        }
        const handle = toAgentPersistenceHandle(this.sessionLogger, record.persistence);
        if (!handle) {
          throw new Error(
            `Agent ${agentId} cannot be refreshed because it lacks persistence`
          );
        }
        snapshot = await this.agentManager.resumeAgentFromPersistence(
          handle,
          buildConfigOverrides(record),
          agentId,
          extractTimestamps(record)
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
      this.sessionLogger.error(
        { err: error, agentId },
        `Failed to refresh agent ${agentId}`
      );
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
    this.sessionLogger.info(
      { agentId },
      `Cancel request received for agent ${agentId}`
    );

    try {
      await this.interruptAgentIfRunning(agentId);
    } catch (error) {
      this.handleAgentRunError(
        agentId,
        error,
        "Failed to cancel running agent on request"
      );
    }
  }

  private async buildAgentSessionConfig(
    config: AgentSessionConfig,
    gitOptions?: GitSetupOptions,
    legacyWorktreeName?: string,
    _labels?: Record<string, string>
  ): Promise<{ sessionConfig: AgentSessionConfig; worktreeConfig?: WorktreeConfig }> {
    let cwd = expandTilde(config.cwd);
    const normalized = this.normalizeGitOptions(gitOptions, legacyWorktreeName);
    let worktreeConfig: WorktreeConfig | undefined;

    if (!normalized) {
      return {
        sessionConfig: {
          ...config,
          cwd,
        },
      };
    }

    if (normalized.createWorktree) {
      let targetBranch: string;

      if (normalized.createNewBranch) {
        targetBranch = normalized.newBranchName!;
      } else {
        // Resolve current branch name from HEAD
        const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", {
          cwd,
          env: READ_ONLY_GIT_ENV,
        });
        targetBranch = stdout.trim();
      }

      if (!targetBranch) {
        throw new Error(
          "A branch name is required when creating a worktree."
        );
      }

      this.sessionLogger.info(
        { worktreeSlug: normalized.worktreeSlug ?? targetBranch, branch: targetBranch },
        `Creating worktree '${
          normalized.worktreeSlug ?? targetBranch
        }' for branch ${targetBranch}`
      );

      const createdWorktree = await createAgentWorktree({
        branchName: targetBranch,
        cwd,
        baseBranch: normalized.baseBranch!,
        worktreeSlug: normalized.worktreeSlug ?? targetBranch,
        paseoHome: this.paseoHome,
      });
      cwd = createdWorktree.worktreePath;
      worktreeConfig = createdWorktree;
    } else if (normalized.createNewBranch) {
      await this.createBranchFromBase({
        cwd,
        baseBranch: normalized.baseBranch!,
        newBranchName: normalized.newBranchName!,
      });
    } else if (normalized.baseBranch) {
      await this.checkoutExistingBranch(cwd, normalized.baseBranch);
    }

    return {
      sessionConfig: {
        ...config,
        cwd,
      },
      worktreeConfig,
    };
  }

  private async handleListProviderModelsRequest(
    msg: Extract<SessionInboundMessage, { type: "list_provider_models_request" }>
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
        `Failed to list models for ${msg.provider}`
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

  private async handleListAvailableProvidersRequest(
    msg: Extract<SessionInboundMessage, { type: "list_available_providers_request" }>
  ): Promise<void> {
    const fetchedAt = new Date().toISOString();
    try {
      const providers = await this.agentManager.listProviderAvailability();
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
      this.sessionLogger.error(
        { err: error },
        "Failed to list provider availability"
      );
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

  private async handleSpeechModelsListRequest(
    msg: Extract<SessionInboundMessage, { type: "speech_models_list_request" }>
  ): Promise<void> {
    const modelsDir = this.localSpeechModelsDir;

    const models = await Promise.all(
      listLocalSpeechModels().map(async (model) => {
        const modelDir = getLocalSpeechModelDir(modelsDir, model.id);
        const missingFiles: string[] = [];
        for (const rel of model.requiredFiles) {
          const filePath = join(modelDir, rel);
          try {
            const fileStat = await stat(filePath);
            if (fileStat.isDirectory()) {
              continue;
            }
            if (!fileStat.isFile() || fileStat.size <= 0) {
              missingFiles.push(rel);
            }
          } catch {
            missingFiles.push(rel);
          }
        }

        return {
          id: model.id,
          kind: model.kind,
          description: model.description,
          modelDir,
          isDownloaded: missingFiles.length === 0,
          ...(missingFiles.length > 0 ? { missingFiles } : {}),
        };
      })
    );

    this.emit({
      type: "speech_models_list_response",
      payload: {
        modelsDir,
        models,
        requestId: msg.requestId,
      },
    });
  }

  private async handleSpeechModelsDownloadRequest(
    msg: Extract<SessionInboundMessage, { type: "speech_models_download_request" }>
  ): Promise<void> {
    const modelsDir = this.localSpeechModelsDir;

    const modelIdsRaw =
      msg.modelIds && msg.modelIds.length > 0
        ? msg.modelIds
        : this.defaultLocalSpeechModelIds;

    const allModelIds = new Set(listLocalSpeechModels().map((m) => m.id));
    const invalid = modelIdsRaw.filter((id) => !allModelIds.has(id as LocalSpeechModelId));
    if (invalid.length > 0) {
      this.emit({
        type: "speech_models_download_response",
        payload: {
          modelsDir,
          downloadedModelIds: [],
          error: `Unknown speech model id(s): ${invalid.join(", ")}`,
          requestId: msg.requestId,
        },
      });
      return;
    }

    const modelIds = modelIdsRaw as LocalSpeechModelId[];
    try {
      await ensureLocalSpeechModels({
        modelsDir,
        modelIds,
        autoDownload: true,
        logger: this.sessionLogger,
      });
      this.emit({
        type: "speech_models_download_response",
        payload: {
          modelsDir,
          downloadedModelIds: modelIds,
          error: null,
          requestId: msg.requestId,
        },
      });
    } catch (error) {
      this.sessionLogger.error({ err: error, modelIds }, "Failed to download speech models");
      this.emit({
        type: "speech_models_download_response",
        payload: {
          modelsDir,
          downloadedModelIds: [],
          error: error instanceof Error ? error.message : String(error),
          requestId: msg.requestId,
        },
      });
    }
  }

  private normalizeGitOptions(
    gitOptions?: GitSetupOptions,
    legacyWorktreeName?: string
  ): NormalizedGitOptions | null {
    const fallbackOptions: GitSetupOptions | undefined = legacyWorktreeName
      ? {
          createWorktree: true,
          createNewBranch: true,
          newBranchName: legacyWorktreeName,
          worktreeSlug: legacyWorktreeName,
        }
      : undefined;

    const merged = gitOptions ?? fallbackOptions;
    if (!merged) {
      return null;
    }

    const baseBranch = merged.baseBranch?.trim() || undefined;
    const createWorktree = Boolean(merged.createWorktree);
    const createNewBranch = Boolean(merged.createNewBranch);
    const normalizedBranchName = merged.newBranchName
      ? slugify(merged.newBranchName)
      : undefined;
    const normalizedWorktreeSlug = merged.worktreeSlug
      ? slugify(merged.worktreeSlug)
      : normalizedBranchName;

    if (!createWorktree && !createNewBranch && !baseBranch) {
      return null;
    }

    if (baseBranch) {
      this.assertSafeGitRef(baseBranch, "base branch");
    }

    if (createWorktree && !baseBranch) {
      throw new Error("Base branch is required when creating a worktree");
    }
    if (createNewBranch && !baseBranch) {
      throw new Error("Base branch is required when creating a new branch");
    }

    if (createNewBranch) {
      if (!normalizedBranchName) {
        throw new Error("New branch name is required");
      }
      const validation = validateBranchSlug(normalizedBranchName);
      if (!validation.valid) {
        throw new Error(`Invalid branch name: ${validation.error}`);
      }
    }

    if (normalizedWorktreeSlug) {
      const validation = validateBranchSlug(normalizedWorktreeSlug);
      if (!validation.valid) {
        throw new Error(`Invalid worktree name: ${validation.error}`);
      }
    }

    return {
      baseBranch,
      createNewBranch,
      newBranchName: normalizedBranchName,
      createWorktree,
      worktreeSlug: normalizedWorktreeSlug,
    };
  }

  private assertSafeGitRef(ref: string, label: string): void {
    if (!SAFE_GIT_REF_PATTERN.test(ref) || ref.includes("..") || ref.includes("@{")) {
      throw new Error(`Invalid ${label}: ${ref}`);
    }
  }

  private toCheckoutError(error: unknown): CheckoutErrorPayload {
    if (error instanceof NotGitRepoError) {
      return { code: "NOT_GIT_REPO", message: error.message };
    }
    if (error instanceof MergeConflictError) {
      return { code: "MERGE_CONFLICT", message: error.message };
    }
    if (error instanceof MergeFromBaseConflictError) {
      return { code: "MERGE_CONFLICT", message: error.message };
    }
    if (error instanceof Error) {
      return { code: "UNKNOWN", message: error.message };
    }
    return { code: "UNKNOWN", message: String(error) };
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
      { paseoHome: this.paseoHome }
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
      const result = await generateStructuredAgentResponse({
        manager: this.agentManager,
        agentConfig: {
          provider: "claude",
          model: AUTO_GEN_MODEL,
          cwd,
          title: "Commit generator",
          internal: true,
        },
        prompt,
        schema,
        schemaName: "CommitMessage",
        maxRetries: 2,
      });
      return result.message;
    } catch (error) {
      if (error instanceof StructuredAgentResponseError) {
        return "Update files";
      }
      throw error;
    }
  }

  private async generatePullRequestText(cwd: string, baseRef?: string): Promise<{
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
      { paseoHome: this.paseoHome }
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
      return await generateStructuredAgentResponse({
        manager: this.agentManager,
        agentConfig: {
          provider: "claude",
          model: AUTO_GEN_MODEL,
          cwd,
          title: "PR generator",
          internal: true,
        },
        prompt,
        schema,
        schemaName: "PullRequest",
        maxRetries: 2,
      });
    } catch (error) {
      if (error instanceof StructuredAgentResponseError) {
        return {
          title: "Update changes",
          body: "Automated PR generated by Paseo.",
        };
      }
      throw error;
    }
  }

  private async ensureCleanWorkingTree(cwd: string): Promise<void> {
    const dirty = await this.isWorkingTreeDirty(cwd);
    if (dirty) {
      throw new Error(
        "Working directory has uncommitted changes. Commit or stash before switching branches."
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
      throw new Error(
        `Unable to inspect git status for ${cwd}: ${(error as Error).message}`
      );
    }
  }

  private async checkoutExistingBranch(
    cwd: string,
    branch: string
  ): Promise<void> {
    this.assertSafeGitRef(branch, "branch");
    try {
      await execAsync(`git rev-parse --verify ${branch}`, { cwd });
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
    await execAsync(`git checkout ${branch}`, { cwd });
  }

  private async createBranchFromBase(params: {
    cwd: string;
    baseBranch: string;
    newBranchName: string;
  }): Promise<void> {
    const { cwd, baseBranch, newBranchName } = params;
    this.assertSafeGitRef(baseBranch, "base branch");

    try {
      await execAsync(`git rev-parse --verify ${baseBranch}`, { cwd });
    } catch (error) {
      throw new Error(`Base branch not found: ${baseBranch}`);
    }

    const exists = await this.doesLocalBranchExist(cwd, newBranchName);
    if (exists) {
      throw new Error(`Branch already exists: ${newBranchName}`);
    }

    await this.ensureCleanWorkingTree(cwd);
    await execAsync(`git checkout -b ${newBranchName} ${baseBranch}`, {
      cwd,
    });
  }

  private async doesLocalBranchExist(
    cwd: string,
    branch: string
  ): Promise<boolean> {
    try {
      await execAsync(`git show-ref --verify --quiet refs/heads/${branch}` , {
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
    requestId: string
  ): Promise<void> {
    this.sessionLogger.info(
      { agentId, modeId, requestId },
      "session: set_agent_mode_request"
    );

    try {
      await this.agentManager.setAgentMode(agentId, modeId);
      this.sessionLogger.info(
        { agentId, modeId, requestId },
        "session: set_agent_mode_request success"
      );
      this.emit({
        type: "set_agent_mode_response",
        payload: { requestId, agentId, accepted: true, error: null },
      });
    } catch (error: any) {
      this.sessionLogger.error(
        { err: error, agentId, modeId, requestId },
        "session: set_agent_mode_request error"
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
    requestId: string
  ): Promise<void> {
    this.sessionLogger.info(
      { agentId, modelId, requestId },
      "session: set_agent_model_request"
    );

    try {
      await this.agentManager.setAgentModel(agentId, modelId);
      this.sessionLogger.info(
        { agentId, modelId, requestId },
        "session: set_agent_model_request success"
      );
      this.emit({
        type: "set_agent_model_response",
        payload: { requestId, agentId, accepted: true, error: null },
      });
    } catch (error: any) {
      this.sessionLogger.error(
        { err: error, agentId, modelId, requestId },
        "session: set_agent_model_request error"
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

  private async handleSetAgentThinkingRequest(
    agentId: string,
    thinkingOptionId: string | null,
    requestId: string
  ): Promise<void> {
    this.sessionLogger.info(
      { agentId, thinkingOptionId, requestId },
      "session: set_agent_thinking_request"
    );

    try {
      await this.agentManager.setAgentThinkingOption(agentId, thinkingOptionId);
      this.sessionLogger.info(
        { agentId, thinkingOptionId, requestId },
        "session: set_agent_thinking_request success"
      );
      this.emit({
        type: "set_agent_thinking_response",
        payload: { requestId, agentId, accepted: true, error: null },
      });
    } catch (error: any) {
      this.sessionLogger.error(
        { err: error, agentId, thinkingOptionId, requestId },
        "session: set_agent_thinking_request error"
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
          error: error?.message
            ? String(error.message)
            : "Failed to set agent thinking option",
        },
      });
    }
  }

  /**
   * Handle clearing agent attention flag
   */
  private async handleClearAgentAttention(agentId: string | string[]): Promise<void> {
    const agentIds = Array.isArray(agentId) ? agentId : [agentId];
    this.sessionLogger.debug(
      { agentIds },
      `Clearing attention for ${agentIds.length} agent(s): ${agentIds.join(", ")}`
    );

    try {
      await Promise.all(
        agentIds.map((id) => this.agentManager.clearAgentAttention(id))
      );
    } catch (error: any) {
      this.sessionLogger.error(
        { err: error, agentIds },
        "Failed to clear agent attention"
      );
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
  private async handleListCommandsRequest(agentId: string, requestId: string): Promise<void> {
    this.sessionLogger.debug(
      { agentId },
      `Handling list commands request for agent ${agentId}`
    );

    try {
      const agents = this.agentManager.listAgents();
      const agent = agents.find((a) => a.id === agentId);

      if (!agent) {
        this.emit({
          type: "list_commands_response",
          payload: {
            agentId,
            commands: [],
            error: `Agent not found: ${agentId}`,
            requestId,
          },
        });
        return;
      }

      const session = agent.session;
      if (!session || !session.listCommands) {
        this.emit({
          type: "list_commands_response",
          payload: {
            agentId,
            commands: [],
            error: `Agent does not support listing commands`,
            requestId,
          },
        });
        return;
      }

      const commands = await session.listCommands();

      this.emit({
        type: "list_commands_response",
        payload: {
          agentId,
          commands,
          error: null,
          requestId,
        },
      });
    } catch (error: any) {
      this.sessionLogger.error(
        { err: error, agentId },
        "Failed to list commands"
      );
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
   * Handle execute command request for an agent
   */
  private async handleExecuteCommandRequest(
    agentId: string,
    commandName: string,
    args: string | undefined,
    requestId: string
  ): Promise<void> {
    this.sessionLogger.debug(
      { agentId, commandName },
      `Handling execute command request for agent ${agentId}`
    );

    try {
      const agents = this.agentManager.listAgents();
      const agent = agents.find((a) => a.id === agentId);

      if (!agent) {
        this.emit({
          type: "execute_command_response",
          payload: {
            agentId,
            result: null,
            error: `Agent not found: ${agentId}`,
            requestId,
          },
        });
        return;
      }

      const session = agent.session;
      if (!session || !session.executeCommand) {
        this.emit({
          type: "execute_command_response",
          payload: {
            agentId,
            result: null,
            error: `Agent does not support executing commands`,
            requestId,
          },
        });
        return;
      }

      const result = await session.executeCommand(commandName, args);

      this.emit({
        type: "execute_command_response",
        payload: {
          agentId,
          result,
          error: null,
          requestId,
        },
      });
    } catch (error: any) {
      this.sessionLogger.error(
        { err: error, agentId, commandName },
        "Failed to execute command"
      );
      this.emit({
        type: "execute_command_response",
        payload: {
          agentId,
          result: null,
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
    response: AgentPermissionResponse
  ): Promise<void> {
    this.sessionLogger.debug(
      { agentId, requestId },
      `Handling permission response for agent ${agentId}, request ${requestId}`
    );

    try {
      await this.agentManager.respondToPermission(agentId, requestId, response);
      this.sessionLogger.debug(
        { agentId },
        `Permission response forwarded to agent ${agentId}`
      );
    } catch (error: any) {
      this.sessionLogger.error(
        { err: error, agentId, requestId },
        "Failed to respond to permission"
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
    msg: Extract<SessionInboundMessage, { type: "checkout_status_request" }>
  ): Promise<void> {
    const { cwd, requestId } = msg;

    try {
      const status = await getCheckoutStatus(cwd, { paseoHome: this.paseoHome });
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
            hasRemote: false,
            remoteUrl: null,
            isPaseoOwnedWorktree: false,
            error: null,
            requestId,
          },
        });
        return;
      }

      if (status.isPaseoOwnedWorktree) {
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
            hasRemote: status.hasRemote,
            remoteUrl: status.remoteUrl,
            isPaseoOwnedWorktree: true,
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
          hasRemote: status.hasRemote,
          remoteUrl: status.remoteUrl,
          isPaseoOwnedWorktree: false,
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
          hasRemote: false,
          remoteUrl: null,
          isPaseoOwnedWorktree: false,
          error: this.toCheckoutError(error),
          requestId,
        },
      });
    }
  }

  private async handleValidateBranchRequest(
    msg: Extract<SessionInboundMessage, { type: "validate_branch_request" }>
  ): Promise<void> {
    const { cwd, branchName, requestId } = msg;

    try {
      const resolvedCwd = expandTilde(cwd);

      // Try local branch first
      try {
        await execAsync(`git rev-parse --verify ${branchName}`, {
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
        await execAsync(`git rev-parse --verify origin/${branchName}`, {
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
    msg: Extract<SessionInboundMessage, { type: "branch_suggestions_request" }>
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

  private normalizeCheckoutDiffCompare(compare: CheckoutDiffCompareInput): CheckoutDiffCompareInput {
    if (compare.mode === "uncommitted") {
      return { mode: "uncommitted" };
    }
    const trimmedBaseRef = compare.baseRef?.trim();
    return trimmedBaseRef
      ? { mode: "base", baseRef: trimmedBaseRef }
      : { mode: "base" };
  }

  private buildCheckoutDiffTargetKey(cwd: string, compare: CheckoutDiffCompareInput): string {
    return JSON.stringify([
      cwd,
      compare.mode,
      compare.mode === "base" ? (compare.baseRef ?? "") : "",
    ]);
  }

  private closeCheckoutDiffWatchTarget(target: CheckoutDiffWatchTarget): void {
    if (target.debounceTimer) {
      clearTimeout(target.debounceTimer);
      target.debounceTimer = null;
    }
    if (target.fallbackRefreshInterval) {
      clearInterval(target.fallbackRefreshInterval);
      target.fallbackRefreshInterval = null;
    }
    for (const watcher of target.watchers) {
      watcher.close();
    }
    target.watchers = [];
  }

  private removeCheckoutDiffSubscription(subscriptionId: string): void {
    const subscription = this.checkoutDiffSubscriptions.get(subscriptionId);
    if (!subscription) {
      return;
    }
    this.checkoutDiffSubscriptions.delete(subscriptionId);

    const target = this.checkoutDiffTargets.get(subscription.targetKey);
    if (!target) {
      return;
    }
    target.subscriptions.delete(subscriptionId);
    if (target.subscriptions.size === 0) {
      this.closeCheckoutDiffWatchTarget(target);
      this.checkoutDiffTargets.delete(subscription.targetKey);
    }
  }

  private async resolveCheckoutGitDir(cwd: string): Promise<string | null> {
    try {
      const { stdout } = await execAsync("git rev-parse --absolute-git-dir", {
        cwd,
        env: READ_ONLY_GIT_ENV,
      });
      const gitDir = stdout.trim();
      return gitDir.length > 0 ? gitDir : null;
    } catch {
      return null;
    }
  }

  private async resolveCheckoutWatchRoot(cwd: string): Promise<string | null> {
    try {
      const { stdout } = await execAsync(
        "git rev-parse --path-format=absolute --show-toplevel",
        {
          cwd,
          env: READ_ONLY_GIT_ENV,
        }
      );
      const root = stdout.trim();
      return root.length > 0 ? root : null;
    } catch {
      return null;
    }
  }

  private scheduleCheckoutDiffTargetRefresh(target: CheckoutDiffWatchTarget): void {
    if (target.debounceTimer) {
      clearTimeout(target.debounceTimer);
    }
    target.debounceTimer = setTimeout(() => {
      target.debounceTimer = null;
      void this.refreshCheckoutDiffTarget(target);
    }, CHECKOUT_DIFF_WATCH_DEBOUNCE_MS);
  }

  private emitCheckoutDiffUpdate(
    target: CheckoutDiffWatchTarget,
    snapshot: CheckoutDiffSnapshotPayload
  ): void {
    if (target.subscriptions.size === 0) {
      return;
    }
    for (const subscriptionId of target.subscriptions) {
      this.emit({
        type: "checkout_diff_update",
        payload: {
          subscriptionId,
          ...snapshot,
        },
      });
    }
  }

  private checkoutDiffSnapshotFingerprint(snapshot: CheckoutDiffSnapshotPayload): string {
    return JSON.stringify(snapshot);
  }

  private async computeCheckoutDiffSnapshot(
    cwd: string,
    compare: CheckoutDiffCompareInput,
    options?: { diffCwd?: string }
  ): Promise<CheckoutDiffSnapshotPayload> {
    const diffCwd = options?.diffCwd ?? cwd;
    try {
      const diffResult = await getCheckoutDiff(
        diffCwd,
        {
          mode: compare.mode,
          baseRef: compare.baseRef,
          includeStructured: true,
        },
        { paseoHome: this.paseoHome }
      );
      const files = [...(diffResult.structured ?? [])];
      files.sort((a, b) => {
        if (a.path === b.path) return 0;
        return a.path < b.path ? -1 : 1;
      });
      return {
        cwd,
        files,
        error: null,
      };
    } catch (error) {
      return {
        cwd,
        files: [],
        error: this.toCheckoutError(error),
      };
    }
  }

  private async refreshCheckoutDiffTarget(target: CheckoutDiffWatchTarget): Promise<void> {
    if (target.refreshPromise) {
      target.refreshQueued = true;
      return;
    }

    target.refreshPromise = (async () => {
      do {
        target.refreshQueued = false;
        const snapshot = await this.computeCheckoutDiffSnapshot(
          target.cwd,
          target.compare,
          { diffCwd: target.diffCwd }
        );
        target.latestPayload = snapshot;
        const fingerprint = this.checkoutDiffSnapshotFingerprint(snapshot);
        if (fingerprint !== target.latestFingerprint) {
          target.latestFingerprint = fingerprint;
          this.emitCheckoutDiffUpdate(target, snapshot);
        }
      } while (target.refreshQueued);
    })();

    try {
      await target.refreshPromise;
    } finally {
      target.refreshPromise = null;
    }
  }

  private async ensureCheckoutDiffWatchTarget(
    cwd: string,
    compare: CheckoutDiffCompareInput
  ): Promise<CheckoutDiffWatchTarget> {
    const targetKey = this.buildCheckoutDiffTargetKey(cwd, compare);
    const existing = this.checkoutDiffTargets.get(targetKey);
    if (existing) {
      return existing;
    }

    const watchRoot = await this.resolveCheckoutWatchRoot(cwd);
    const target: CheckoutDiffWatchTarget = {
      key: targetKey,
      cwd,
      diffCwd: watchRoot ?? cwd,
      compare,
      subscriptions: new Set(),
      watchers: [],
      fallbackRefreshInterval: null,
      debounceTimer: null,
      refreshPromise: null,
      refreshQueued: false,
      latestPayload: null,
      latestFingerprint: null,
    };

    const repoWatchPath = watchRoot ?? cwd;
    const watchPaths = new Set<string>([repoWatchPath]);
    const gitDir = await this.resolveCheckoutGitDir(cwd);
    if (gitDir) {
      watchPaths.add(gitDir);
    }

    let hasRecursiveRepoCoverage = false;
    const allowRecursiveRepoWatch = process.platform !== "linux";
    for (const watchPath of watchPaths) {
      const shouldTryRecursive = watchPath === repoWatchPath && allowRecursiveRepoWatch;
      const createWatcher = (recursive: boolean): FSWatcher =>
        watch(
          watchPath,
          { recursive },
          () => {
            this.scheduleCheckoutDiffTargetRefresh(target);
          }
        );

      let watcher: FSWatcher | null = null;
      let watcherIsRecursive = false;
      try {
        if (shouldTryRecursive) {
          watcher = createWatcher(true);
          watcherIsRecursive = true;
        } else {
          watcher = createWatcher(false);
        }
      } catch (error) {
        if (shouldTryRecursive) {
          try {
            watcher = createWatcher(false);
            this.sessionLogger.warn(
              { err: error, watchPath, cwd, compare },
              "Checkout diff recursive watch unavailable; using non-recursive fallback"
            );
          } catch (fallbackError) {
            this.sessionLogger.warn(
              { err: fallbackError, watchPath, cwd, compare },
              "Failed to start checkout diff watcher"
            );
          }
        } else {
          this.sessionLogger.warn(
            { err: error, watchPath, cwd, compare },
            "Failed to start checkout diff watcher"
          );
        }
      }

      if (!watcher) {
        continue;
      }

      watcher.on("error", (error) => {
        this.sessionLogger.warn(
          { err: error, watchPath, cwd, compare },
          "Checkout diff watcher error"
        );
      });
      target.watchers.push(watcher);
      if (watchPath === repoWatchPath && watcherIsRecursive) {
        hasRecursiveRepoCoverage = true;
      }
    }

    const missingRepoCoverage = !hasRecursiveRepoCoverage;
    if (target.watchers.length === 0 || missingRepoCoverage) {
      target.fallbackRefreshInterval = setInterval(() => {
        this.scheduleCheckoutDiffTargetRefresh(target);
      }, CHECKOUT_DIFF_FALLBACK_REFRESH_MS);
      this.sessionLogger.warn(
        {
          cwd,
          compare,
          intervalMs: CHECKOUT_DIFF_FALLBACK_REFRESH_MS,
          reason:
            target.watchers.length === 0
              ? "no_watchers"
              : "missing_recursive_repo_root_coverage",
        },
        "Checkout diff watchers unavailable; using timed refresh fallback"
      );
    }

    this.checkoutDiffTargets.set(targetKey, target);
    return target;
  }

  private async handleSubscribeCheckoutDiffRequest(
    msg: SubscribeCheckoutDiffRequest
  ): Promise<void> {
    const cwd = expandTilde(msg.cwd);
    const compare = this.normalizeCheckoutDiffCompare(msg.compare);

    this.removeCheckoutDiffSubscription(msg.subscriptionId);
    const target = await this.ensureCheckoutDiffWatchTarget(cwd, compare);
    target.subscriptions.add(msg.subscriptionId);
    this.checkoutDiffSubscriptions.set(msg.subscriptionId, {
      targetKey: target.key,
    });

    const snapshot =
      target.latestPayload ??
      (await this.computeCheckoutDiffSnapshot(cwd, compare, {
        diffCwd: target.diffCwd,
      }));
    target.latestPayload = snapshot;
    target.latestFingerprint = this.checkoutDiffSnapshotFingerprint(snapshot);

    this.emit({
      type: "subscribe_checkout_diff_response",
      payload: {
        subscriptionId: msg.subscriptionId,
        ...snapshot,
        requestId: msg.requestId,
      },
    });
  }

  private handleUnsubscribeCheckoutDiffRequest(
    msg: UnsubscribeCheckoutDiffRequest
  ): void {
    this.removeCheckoutDiffSubscription(msg.subscriptionId);
  }

  private scheduleCheckoutDiffRefreshForCwd(cwd: string): void {
    const resolvedCwd = expandTilde(cwd);
    for (const target of this.checkoutDiffTargets.values()) {
      if (target.cwd !== resolvedCwd && target.diffCwd !== resolvedCwd) {
        continue;
      }
      this.scheduleCheckoutDiffTargetRefresh(target);
    }
  }

  private async handleCheckoutCommitRequest(
    msg: Extract<SessionInboundMessage, { type: "checkout_commit_request" }>
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
      this.scheduleCheckoutDiffRefreshForCwd(cwd);

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
          error: this.toCheckoutError(error),
          requestId,
        },
      });
    }
  }

  private async handleCheckoutMergeRequest(
    msg: Extract<SessionInboundMessage, { type: "checkout_merge_request" }>
  ): Promise<void> {
    const { cwd, requestId } = msg;

    try {
      const status = await getCheckoutStatus(cwd, { paseoHome: this.paseoHome });
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
        { paseoHome: this.paseoHome }
      );
      this.scheduleCheckoutDiffRefreshForCwd(cwd);

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
          error: this.toCheckoutError(error),
          requestId,
        },
      });
    }
  }

  private async handleCheckoutMergeFromBaseRequest(
    msg: Extract<SessionInboundMessage, { type: "checkout_merge_from_base_request" }>
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

      await mergeFromBase(
        cwd,
        {
          baseRef: msg.baseRef,
          requireCleanTarget: msg.requireCleanTarget ?? true,
        },
      );
      this.scheduleCheckoutDiffRefreshForCwd(cwd);

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
          error: this.toCheckoutError(error),
          requestId,
        },
      });
    }
  }

  private async handleCheckoutPushRequest(
    msg: Extract<SessionInboundMessage, { type: "checkout_push_request" }>
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
          error: this.toCheckoutError(error),
          requestId,
        },
      });
    }
  }

  private async handleCheckoutPrCreateRequest(
    msg: Extract<SessionInboundMessage, { type: "checkout_pr_create_request" }>
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
          error: this.toCheckoutError(error),
          requestId,
        },
      });
    }
  }

  private async handleCheckoutPrStatusRequest(
    msg: Extract<SessionInboundMessage, { type: "checkout_pr_status_request" }>
  ): Promise<void> {
    const { cwd, requestId } = msg;

    try {
      const prStatus = await getPullRequestStatus(cwd);
      this.emit({
        type: "checkout_pr_status_response",
        payload: {
          cwd,
          status: prStatus.status,
          githubFeaturesEnabled: prStatus.githubFeaturesEnabled,
          error: null,
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
          error: this.toCheckoutError(error),
          requestId,
        },
      });
    }
  }

  private async handlePaseoWorktreeListRequest(
    msg: Extract<SessionInboundMessage, { type: "paseo_worktree_list_request" }>
  ): Promise<void> {
    const { requestId } = msg;
    const cwd = msg.repoRoot ?? msg.cwd;
    if (!cwd) {
      this.emit({
        type: "paseo_worktree_list_response",
        payload: {
          worktrees: [],
          error: { code: "UNKNOWN", message: "cwd or repoRoot is required" },
          requestId,
        },
      });
      return;
    }

    try {
      const worktrees = await listPaseoWorktrees({ cwd, paseoHome: this.paseoHome });
      this.emit({
        type: "paseo_worktree_list_response",
        payload: {
          worktrees: worktrees.map((entry) => ({
            worktreePath: entry.path,
            branchName: entry.branchName ?? null,
            head: entry.head ?? null,
          })),
          error: null,
          requestId,
        },
      });
    } catch (error) {
      this.emit({
        type: "paseo_worktree_list_response",
        payload: {
          worktrees: [],
          error: this.toCheckoutError(error),
          requestId,
        },
      });
    }
  }

	  private async handlePaseoWorktreeArchiveRequest(
	    msg: Extract<SessionInboundMessage, { type: "paseo_worktree_archive_request" }>
	  ): Promise<void> {
	    const { requestId } = msg;
	    let targetPath = msg.worktreePath;
	    let repoRoot = msg.repoRoot ?? null;

    try {
      if (!targetPath) {
        if (!repoRoot || !msg.branchName) {
          throw new Error("worktreePath or repoRoot+branchName is required");
        }
        const worktrees = await listPaseoWorktrees({ cwd: repoRoot, paseoHome: this.paseoHome });
        const match = worktrees.find((entry) => entry.branchName === msg.branchName);
        if (!match) {
          throw new Error(`Paseo worktree not found for branch ${msg.branchName}`);
        }
        targetPath = match.path;
      }

      const ownership = await isPaseoOwnedWorktreeCwd(targetPath, { paseoHome: this.paseoHome });
      if (!ownership.allowed) {
        this.emit({
          type: "paseo_worktree_archive_response",
          payload: {
            success: false,
            removedAgents: [],
            error: {
              code: "NOT_ALLOWED",
              message: "Worktree is not a Paseo-owned worktree",
            },
            requestId,
          },
        });
        return;
      }

	      repoRoot = ownership.repoRoot ?? repoRoot ?? null;
	      if (!repoRoot) {
	        throw new Error("Unable to resolve repo root for worktree");
	      }

	      const resolvedWorktree = await resolvePaseoWorktreeRootForCwd(targetPath, {
	        paseoHome: this.paseoHome,
	      });
	      if (resolvedWorktree) {
	        targetPath = resolvedWorktree.worktreePath;
	      }

	      const removedAgents = new Set<string>();
	      const agents = this.agentManager.listAgents();
	      for (const agent of agents) {
	        if (this.isPathWithinRoot(targetPath, agent.cwd)) {
	          removedAgents.add(agent.id);
          try {
            await this.agentManager.closeAgent(agent.id);
          } catch {
            // ignore cleanup errors
          }
          try {
            await this.agentStorage.remove(agent.id);
          } catch {
            // ignore cleanup errors
          }
        }
      }

      const registryRecords = await this.agentStorage.list();
      for (const record of registryRecords) {
        if (this.isPathWithinRoot(targetPath, record.cwd)) {
          removedAgents.add(record.id);
          try {
            await this.agentStorage.remove(record.id);
          } catch {
            // ignore cleanup errors
          }
        }
      }

      await this.killTerminalsUnderPath(targetPath);

      await deletePaseoWorktree({
        cwd: repoRoot,
        worktreePath: targetPath,
        paseoHome: this.paseoHome,
      });

      for (const agentId of removedAgents) {
        this.emit({
          type: "agent_deleted",
          payload: {
            agentId,
            requestId,
          },
        });
      }

      this.emit({
        type: "paseo_worktree_archive_response",
        payload: {
          success: true,
          removedAgents: Array.from(removedAgents),
          error: null,
          requestId,
        },
      });
    } catch (error) {
      this.emit({
        type: "paseo_worktree_archive_response",
        payload: {
          success: false,
          removedAgents: [],
          error: this.toCheckoutError(error),
          requestId,
        },
      });
    }
  }

  /**
   * Handle read-only file explorer requests scoped to an agent's cwd
   */
  private async handleFileExplorerRequest(
    request: FileExplorerRequest
  ): Promise<void> {
    const { agentId, path: requestedPath = ".", mode, requestId } = request;

    this.sessionLogger.debug(
      { agentId, mode, path: requestedPath },
      `Handling file explorer request for agent ${agentId} (${mode} ${requestedPath})`
    );

    try {
      const agents = this.agentManager.listAgents();
      const agent = agents.find((a) => a.id === agentId);

      if (!agent) {
        this.emit({
          type: "file_explorer_response",
          payload: {
            agentId,
            path: requestedPath,
            mode,
            directory: null,
            file: null,
            error: `Agent not found: ${agentId}`,
            requestId,
          },
        });
        return;
      }

      if (mode === "list") {
        const directory = await listDirectoryEntries({
          root: agent.cwd,
          relativePath: requestedPath,
        });

        this.emit({
          type: "file_explorer_response",
          payload: {
            agentId,
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
          root: agent.cwd,
          relativePath: requestedPath,
        });

        this.emit({
          type: "file_explorer_response",
          payload: {
            agentId,
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
        { err: error, agentId, path: requestedPath },
        `Failed to fulfill file explorer request for agent ${agentId}`
      );
      this.emit({
        type: "file_explorer_response",
        payload: {
          agentId,
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

  /**
   * Handle project icon request for a given cwd
   */
  private async handleProjectIconRequest(
    request: Extract<SessionInboundMessage, { type: "project_icon_request" }>
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
   * Handle file download token request scoped to an agent's cwd
   */
  private async handleFileDownloadTokenRequest(
    request: FileDownloadTokenRequest
  ): Promise<void> {
    const { agentId, path: requestedPath, requestId } = request;

    this.sessionLogger.debug(
      { agentId, path: requestedPath },
      `Handling file download token request for agent ${agentId} (${requestedPath})`
    );

    try {
      const agents = this.agentManager.listAgents();
      const agent = agents.find((a) => a.id === agentId);

      if (!agent) {
        this.emit({
          type: "file_download_token_response",
          payload: {
            agentId,
            path: requestedPath,
            token: null,
            fileName: null,
            mimeType: null,
            size: null,
            error: `Agent not found: ${agentId}`,
            requestId,
          },
        });
        return;
      }

      const info = await getDownloadableFileInfo({
        root: agent.cwd,
        relativePath: requestedPath,
      });

      const entry = this.downloadTokenStore.issueToken({
        agentId,
        path: info.path,
        absolutePath: info.absolutePath,
        fileName: info.fileName,
        mimeType: info.mimeType,
        size: info.size,
      });

      this.emit({
        type: "file_download_token_response",
        payload: {
          agentId,
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
        { err: error, agentId, path: requestedPath },
        `Failed to issue download token for agent ${agentId}`
      );
      this.emit({
        type: "file_download_token_response",
        payload: {
          agentId,
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
  private async listAgentPayloads(filter?: { labels?: Record<string, string> }): Promise<AgentSnapshotPayload[]> {
    // Get live agents with session modes
    const agentSnapshots = this.agentManager.listAgents();
    const liveAgents = await Promise.all(
      agentSnapshots.map((agent) => this.buildAgentPayload(agent))
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
        Object.entries(filterLabels).every(([key, value]) => agent.labels[key] === value)
      );
    }

    return agents;
  }

  private async resolveAgentIdentifier(
    identifier: string
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
    sort: FetchAgentsRequestSort[] | undefined
  ): FetchAgentsRequestSort[] {
    const fallback: FetchAgentsRequestSort[] = [
      { key: "updated_at", direction: "desc" },
    ];
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
    const requiresAttention = agent.requiresAttention ?? false;
    const attentionReason = agent.attentionReason ?? null;
    if (requiresAttention && attentionReason === "permission") {
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
    key: FetchAgentsRequestSort["key"]
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

  private compareSortValues(
    left: string | number | null,
    right: string | number | null
  ): number {
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

  private compareFetchAgentsEntries(
    left: FetchAgentsResponseEntry,
    right: FetchAgentsResponseEntry,
    sort: FetchAgentsRequestSort[]
  ): number {
    for (const spec of sort) {
      const leftValue = this.getFetchAgentsSortValue(left, spec.key);
      const rightValue = this.getFetchAgentsSortValue(right, spec.key);
      const base = this.compareSortValues(leftValue, rightValue);
      if (base === 0) {
        continue;
      }
      return spec.direction === "asc" ? base : -base;
    }
    return left.agent.id.localeCompare(right.agent.id);
  }

  private encodeFetchAgentsCursor(
    entry: FetchAgentsResponseEntry,
    sort: FetchAgentsRequestSort[]
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
      "utf8"
    ).toString("base64url");
  }

  private decodeFetchAgentsCursor(
    cursor: string,
    sort: FetchAgentsRequestSort[]
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
          entry.key !== sort[index]?.key ||
          entry.direction !== sort[index]?.direction
      )
    ) {
      throw new SessionRequestError(
        "invalid_cursor",
        "fetch_agents cursor does not match current sort"
      );
    }

    return {
      sort: cursorSort,
      values: payload.values as Record<string, string | number | null>,
      id: payload.id,
    };
  }

  private compareEntryWithCursor(
    entry: FetchAgentsResponseEntry,
    cursor: FetchAgentsCursor,
    sort: FetchAgentsRequestSort[]
  ): number {
    for (const spec of sort) {
      const leftValue = this.getFetchAgentsSortValue(entry, spec.key);
      const rightValue =
        cursor.values[spec.key] !== undefined ? cursor.values[spec.key] ?? null : null;
      const base = this.compareSortValues(leftValue, rightValue);
      if (base === 0) {
        continue;
      }
      return spec.direction === "asc" ? base : -base;
    }
    return entry.agent.id.localeCompare(cursor.id);
  }

  private async listFetchAgentsEntries(
    request: Extract<SessionInboundMessage, { type: "fetch_agents_request" }>
  ): Promise<{
    entries: FetchAgentsResponseEntry[];
    pageInfo: FetchAgentsResponsePageInfo;
  }> {
    const filter = request.filter;
    const sort = this.normalizeFetchAgentsSort(request.sort);
    const includeArchived = filter?.includeArchived ?? false;

    let agents = await this.listAgentPayloads({
      labels: filter?.labels,
    });

    if (!includeArchived) {
      agents = agents.filter((agent) => !agent.archivedAt);
    }

    if (filter?.statuses && filter.statuses.length > 0) {
      const statuses = new Set(filter.statuses);
      agents = agents.filter((agent) => statuses.has(agent.status));
    }

    if (typeof filter?.requiresAttention === "boolean") {
      agents = agents.filter(
        (agent) =>
          (agent.requiresAttention ?? false) === filter.requiresAttention
      );
    }

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

    let entries = await Promise.all(
      agents.map(async (agent) => ({
        agent,
        project: await getPlacement(agent.cwd),
      }))
    );

    if (filter?.projectKeys && filter.projectKeys.length > 0) {
      const projectKeys = new Set(filter.projectKeys.filter((item) => item.trim().length > 0));
      entries = entries.filter((entry) => projectKeys.has(entry.project.projectKey));
    }

    entries.sort((left, right) =>
      this.compareFetchAgentsEntries(left, right, sort)
    );

    const cursorToken = request.page?.cursor;
    if (cursorToken) {
      const cursor = this.decodeFetchAgentsCursor(cursorToken, sort);
      entries = entries.filter(
        (entry) => this.compareEntryWithCursor(entry, cursor, sort) > 0
      );
    }

    const limit = request.page?.limit ?? entries.length;
    const pagedEntries = entries.slice(0, limit);
    const hasMore = entries.length > limit;
    const nextCursor =
      hasMore && pagedEntries.length > 0
        ? this.encodeFetchAgentsCursor(
            pagedEntries[pagedEntries.length - 1],
            sort
          )
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

  private async handleFetchAgents(
    request: Extract<SessionInboundMessage, { type: "fetch_agents_request" }>
  ): Promise<void> {
    try {
      const payload = await this.listFetchAgentsEntries(request);
      this.emit({
        type: "fetch_agents_response",
        payload: {
          requestId: request.requestId,
          ...payload,
        },
      });
    } catch (error) {
      const code =
        error instanceof SessionRequestError ? error.code : "fetch_agents_failed";
      const message =
        error instanceof Error ? error.message : "Failed to fetch agents";
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

  private async handleFetchAgent(agentIdOrIdentifier: string, requestId: string): Promise<void> {
    const resolved = await this.resolveAgentIdentifier(agentIdOrIdentifier);
    if (!resolved.ok) {
      this.emit({
        type: "fetch_agent_response",
        payload: { requestId, agent: null, error: resolved.error },
      });
      return;
    }

    const agent = await this.getAgentPayloadById(resolved.agentId);
    if (!agent) {
      this.emit({
        type: "fetch_agent_response",
        payload: { requestId, agent: null, error: `Agent not found: ${resolved.agentId}` },
      });
      return;
    }

    this.emit({
      type: "fetch_agent_response",
      payload: { requestId, agent, error: null },
    });
  }

  private async handleFetchAgentTimelineRequest(
    msg: Extract<SessionInboundMessage, { type: "fetch_agent_timeline_request" }>
  ): Promise<void> {
    const direction: AgentTimelineFetchDirection =
      msg.direction ?? (msg.cursor ? "after" : "tail");
    const projection: TimelineProjectionMode = msg.projection ?? "projected";
    const limit = msg.limit ?? (direction === "after" ? 0 : undefined);
    const cursor: AgentTimelineCursor | undefined = msg.cursor
      ? {
          epoch: msg.cursor.epoch,
          seq: msg.cursor.seq,
        }
      : undefined;

    try {
      const snapshot = await this.ensureAgentLoaded(msg.agentId);

      const timeline = this.agentManager.fetchTimeline(msg.agentId, {
        direction,
        cursor,
        limit,
      });

      const projected = projectTimelineRows(
        timeline.rows,
        snapshot.provider,
        projection
      );

      const firstRow = timeline.rows[0];
      const lastRow = timeline.rows[timeline.rows.length - 1];
      const startCursor = firstRow
        ? { epoch: timeline.epoch, seq: firstRow.seq }
        : null;
      const endCursor = lastRow
        ? { epoch: timeline.epoch, seq: lastRow.seq }
        : null;

      this.emit({
        type: "fetch_agent_timeline_response",
        payload: {
          requestId: msg.requestId,
          agentId: msg.agentId,
          direction,
          projection,
          epoch: timeline.epoch,
          reset: timeline.reset,
          staleCursor: timeline.staleCursor,
          gap: timeline.gap,
          window: timeline.window,
          startCursor,
          endCursor,
          hasOlder: timeline.hasOlder,
          hasNewer: timeline.hasNewer,
          entries: projected,
          error: null,
        },
      });
    } catch (error) {
      this.sessionLogger.error(
        { err: error, agentId: msg.agentId },
        "Failed to handle fetch_agent_timeline_request"
      );
      this.emit({
        type: "fetch_agent_timeline_response",
        payload: {
          requestId: msg.requestId,
          agentId: msg.agentId,
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
    msg: Extract<SessionInboundMessage, { type: "send_agent_message_request" }>
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

      await this.ensureAgentLoaded(agentId);
      await this.interruptAgentIfRunning(agentId);

      try {
        this.agentManager.recordUserMessage(agentId, msg.text, {
          messageId: msg.messageId,
          emitState: false,
        });
      } catch (error) {
        this.sessionLogger.error(
          { err: error, agentId },
          "Failed to record user message for send_agent_message_request"
        );
      }

      const prompt = this.buildAgentPrompt(msg.text, msg.images);
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
          error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";
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
        error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";
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
    timeoutMs?: number
  ): Promise<void> {
    const resolved = await this.resolveAgentIdentifier(agentIdOrIdentifier);
    if (!resolved.ok) {
      this.emit({
        type: "wait_for_finish_response",
        payload: { requestId, status: "error", final: null, error: resolved.error, lastMessage: null },
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
      this.emit({
        type: "wait_for_finish_response",
        payload: { requestId, status, final, error: null, lastMessage: null },
      });
      return;
    }

    const abortController = new AbortController();
    const effectiveTimeoutMs = timeoutMs ?? 600_000; // 10 minutes default
    const timeoutHandle = setTimeout(() => {
      abortController.abort("timeout");
    }, effectiveTimeoutMs);

    try {
      const result = await this.agentManager.waitForAgentEvent(agentId, {
        signal: abortController.signal,
      });

      const final = await this.getAgentPayloadById(agentId);
      if (!final) {
        throw new Error(`Agent ${agentId} disappeared while waiting`);
      }

      const status =
        result.permission
          ? "permission"
          : result.status === "error"
            ? "error"
            : "idle";

      this.emit({
        type: "wait_for_finish_response",
        payload: { requestId, status, final, error: null, lastMessage: result.lastMessage },
      });
    } catch (error) {
      const isAbort =
        error instanceof Error &&
        (error.name === "AbortError" || error.message.toLowerCase().includes("aborted"));
      if (!isAbort) {
        const message =
          error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";
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
      clearTimeout(timeoutHandle);
    }
  }

  /**
   * Handle audio chunk for buffering and transcription
   */
  private async handleAudioChunk(
    msg: Extract<SessionInboundMessage, { type: "voice_audio_chunk" }>
  ): Promise<void> {
    if (!this.isVoiceMode) {
      this.sessionLogger.warn(
        "Received voice_audio_chunk while voice mode is disabled; transcript will be emitted but voice assistant turn is skipped"
      );
    }

    await this.handleVoiceSpeechStart();

    const chunkFormat = msg.format || "audio/wav";

    if (this.isVoiceMode) {
      await this.appendToActiveVoiceDictationStream(msg.audio, chunkFormat);
      if (!msg.isLast) {
        this.setVoiceModeInactivityTimeout();
        this.sessionLogger.debug("Voice mode: streaming chunk, waiting for speech end");
        return;
      }

      this.clearVoiceModeInactivityTimeout();
      this.sessionLogger.debug("Voice mode: speech ended, finalizing streaming transcription");
      await this.finalizeActiveVoiceDictationStream("speech ended");
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
        { oldFormat: this.audioBuffer.isPCM ? "pcm" : this.audioBuffer.format, newFormat: chunkFormat },
        `Audio format changed mid-stream, flushing current buffer`
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
        { minDuration: MIN_STREAMING_SEGMENT_DURATION_MS, pcmBytes: bufferedState?.totalPCMBytes ?? 0 },
        `Minimum chunk duration reached (~${MIN_STREAMING_SEGMENT_DURATION_MS}ms, ${
          bufferedState?.totalPCMBytes ?? 0
        } PCM bytes) – triggering STT`
      );
    } else {
      this.sessionLogger.debug(
        { audioBytes: finalized.audio.length, chunks: bufferedState?.chunks.length ?? 0 },
        `Complete audio segment (${finalized.audio.length} bytes, ${bufferedState?.chunks.length ?? 0} chunk(s))`
      );
    }

    await this.processCompletedAudio(finalized.audio, finalized.format);
  }

  private finalizeBufferedAudio():
    | { audio: Buffer; format: string }
    | null {
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
        PCM_BITS_PER_SAMPLE
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

  private async processCompletedAudio(
    audio: Buffer,
    format: string
  ): Promise<void> {
    const shouldBuffer =
      this.processingPhase === "transcribing" &&
      this.pendingAudioSegments.length === 0;

    if (shouldBuffer) {
      this.sessionLogger.debug(
        { phase: this.processingPhase },
        `Buffering audio segment (phase: ${this.processingPhase})`
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
        `Processing ${this.pendingAudioSegments.length} buffered segments together`
      );

      const pendingSegments = [...this.pendingAudioSegments];
      this.pendingAudioSegments = [];
      this.clearBufferTimeout();

      const combinedAudio = Buffer.concat(
        pendingSegments.map((segment) => segment.audio)
      );
      const combinedFormat =
        pendingSegments[pendingSegments.length - 1].format;

      await this.processAudio(combinedAudio, combinedFormat);
      return;
    }

    await this.processAudio(audio, format);
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
        "Transcription result"
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
    result: VoiceTranscriptionResultPayload
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
        ...(result.isLowConfidence !== undefined ? { isLowConfidence: result.isLowConfidence } : {}),
        ...(result.byteLength !== undefined ? { byteLength: result.byteLength } : {}),
        ...(result.format ? { format: result.format } : {}),
        ...(result.debugRecordingPath ? { debugRecordingPath: result.debugRecordingPath } : {}),
      },
    });

    if (!transcriptText) {
      this.sessionLogger.debug("Empty transcription (false positive), not aborting");
      this.setPhase("idle");
      this.clearSpeechInProgress("empty transcription");
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
        "Skipping voice agent processing because voice mode is disabled"
      );
      return;
    }

    const agentId = this.voiceModeAgentId;
    if (!agentId) {
      this.sessionLogger.warn(
        { requestId: result.requestId },
        "Skipping voice agent processing because no agent is currently voice-enabled"
      );
      return;
    }

    // Route voice utterances through the same send path as regular text input:
    // interrupt-if-running, record message, then start a new stream.
    await this.handleSendAgentMessage(agentId, result.text);
  }

  private registerVoiceBridgeForAgent(agentId: string): void {
    this.registerVoiceSpeakHandler?.(agentId, async ({ text, signal }) => {
      this.sessionLogger.info(
        {
          agentId,
          textLength: text.length,
          preview: text.slice(0, 160),
        },
        "Voice speak tool call received by session handler"
      );
      const abortSignal = signal ?? this.abortController.signal;
      await this.ttsManager.generateAndWaitForPlayback(
        text,
        (msg) => this.emit(msg),
        abortSignal,
        true
      );
      this.sessionLogger.info(
        { agentId, textLength: text.length },
        "Voice speak tool call finished playback"
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
      childAgentDefaultLabels: { ui: "true" },
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
      `Abort request, phase: ${this.processingPhase}`
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
          "Failed to interrupt active voice-mode agent on abort"
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
        `Dropping ${this.pendingAudioSegments.length} buffered audio segment(s) due to voice speech`
      );
      this.pendingAudioSegments = [];
    }

    if (this.audioBuffer) {
      this.sessionLogger.debug(
        { chunks: this.audioBuffer.chunks.length, pcmBytes: this.audioBuffer.totalPCMBytes },
        `Clearing partial audio buffer (${this.audioBuffer.chunks.length} chunk(s)${
          this.audioBuffer.isPCM
            ? `, ${this.audioBuffer.totalPCMBytes} PCM bytes`
            : ""
        })`
      );
      this.audioBuffer = null;
    }

    this.cancelActiveVoiceDictationStream("new speech turn started");
    this.clearVoiceModeInactivityTimeout();
    this.clearBufferTimeout();

    this.abortController.abort();
    await this.handleAbort();

    const latencyMs = Date.now() - chunkReceivedAt;
    this.sessionLogger.debug(
      { latencyMs, phaseBeforeAbort, hadActiveStream },
      "[Telemetry] barge_in.llm_abort_latency"
    );
  }

  /**
   * Clear speech-in-progress flag once the user turn has completed
   */
  private clearSpeechInProgress(reason: string): void {
    if (!this.speechInProgress) {
      return;
    }

    this.speechInProgress = false;
    this.sessionLogger.debug(
      { reason },
      `Speech turn complete (${reason}) – resuming TTS`
    );
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

      if (this.pendingAudioSegments.length > 0) {
        const segments = [...this.pendingAudioSegments];
        this.pendingAudioSegments = [];
        this.bufferTimeout = null;

        const combined = Buffer.concat(segments.map((s) => s.audio));
        await this.processAudio(combined, segments[0].format);
      }
    }, 10000); // 10 second timeout
  }

  private setVoiceModeInactivityTimeout(): void {
    if (!this.isVoiceMode) {
      return;
    }

    this.clearVoiceModeInactivityTimeout();
    this.voiceModeInactivityTimeout = setTimeout(() => {
      this.voiceModeInactivityTimeout = null;
      if (!this.isVoiceMode || !this.activeVoiceDictationId) {
        return;
      }

      this.sessionLogger.warn(
        {
          timeoutMs: VOICE_MODE_INACTIVITY_FLUSH_MS,
          dictationId: this.activeVoiceDictationId,
          nextSeq: this.activeVoiceDictationNextSeq,
        },
        "Voice mode inactivity timeout reached without isLast; finalizing active voice dictation stream"
      );

      void this.finalizeActiveVoiceDictationStream("inactivity timeout").catch((error) => {
        this.sessionLogger.error(
          { err: error },
          "Failed to finalize voice dictation stream after inactivity timeout"
        );
      });
    }, VOICE_MODE_INACTIVITY_FLUSH_MS);
  }

  private clearVoiceModeInactivityTimeout(): void {
    if (this.voiceModeInactivityTimeout) {
      clearTimeout(this.voiceModeInactivityTimeout);
      this.voiceModeInactivityTimeout = null;
    }
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
    if (
      msg.type === "audio_output" &&
      (process.env.TTS_DEBUG_AUDIO_DIR || isPaseoDictationDebugEnabled()) &&
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
              this.sessionLogger
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

  private emitBinary(frame: BinaryMuxFrame): void {
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

    // Abort any ongoing operations
    this.abortController.abort();

    // Clear timeouts
    this.clearVoiceModeInactivityTimeout();
    this.clearBufferTimeout();

    // Clear buffers
    this.cancelActiveVoiceDictationStream("session cleanup");
    this.pendingAudioSegments = [];
    this.audioBuffer = null;

    // Cleanup managers
    this.ttsManager.cleanup();
    this.sttManager.cleanup();
    this.voiceStreamManager.cleanupAll();
    this.dictationStreamManager.cleanupAll();

    // Close MCP clients
    if (this.agentMcpClient) {
      try {
        await this.agentMcpClient.close();
        this.sessionLogger.debug("Agent MCP client closed");
      } catch (error) {
        this.sessionLogger.error(
          { err: error },
          "Failed to close Agent MCP client"
        );
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

    for (const unsubscribe of this.terminalSubscriptions.values()) {
      unsubscribe();
    }
    this.terminalSubscriptions.clear();
    for (const unsubscribeExit of this.terminalExitSubscriptions.values()) {
      unsubscribeExit();
    }
    this.terminalExitSubscriptions.clear();
    this.detachAllTerminalStreams({ emitExit: false });

    for (const target of this.checkoutDiffTargets.values()) {
      this.closeCheckoutDiffWatchTarget(target);
    }
    this.checkoutDiffTargets.clear();
    this.checkoutDiffSubscriptions.clear();
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

    const unsubscribe = this.terminalSubscriptions.get(terminalId);
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch (error) {
        this.sessionLogger.warn(
          { err: error, terminalId },
          "Failed to unsubscribe terminal after process exit"
        );
      }
      this.terminalSubscriptions.delete(terminalId);
    }

    const streamId = this.terminalStreamByTerminalId.get(terminalId);
    if (typeof streamId === "number") {
      this.detachTerminalStream(streamId, { emitExit: true });
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

    const hadDirectoryBeforeSubscribe = this.terminalManager
      .listDirectories()
      .includes(cwd);

    try {
      const terminals = await this.terminalManager.getTerminals(cwd);
      for (const terminal of terminals) {
        this.ensureTerminalExitSubscription(terminal);
      }

      // New directories auto-create Terminal 1, which already emits through
      // terminal-manager change listeners.
      if (!hadDirectoryBeforeSubscribe) {
        return;
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
      this.sessionLogger.warn(
        { err: error, cwd },
        "Failed to emit initial terminal snapshot"
      );
    }
  }

  private async handleListTerminalsRequest(msg: ListTerminalsRequest): Promise<void> {
    if (!this.terminalManager) {
      this.emit({
        type: "list_terminals_response",
        payload: {
          cwd: msg.cwd,
          terminals: [],
          requestId: msg.requestId,
        },
      });
      return;
    }

    try {
      const terminals = await this.terminalManager.getTerminals(msg.cwd);
      for (const terminal of terminals) {
        this.ensureTerminalExitSubscription(terminal);
      }
      this.emit({
        type: "list_terminals_response",
        payload: {
          cwd: msg.cwd,
          terminals: terminals.map((t) => ({ id: t.id, name: t.name })),
          requestId: msg.requestId,
        },
      });
    } catch (error: any) {
      this.sessionLogger.error({ err: error, cwd: msg.cwd }, "Failed to list terminals");
      this.emit({
        type: "list_terminals_response",
        payload: {
          cwd: msg.cwd,
          terminals: [],
          requestId: msg.requestId,
        },
      });
    }
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
          state: null,
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
          state: null,
          error: "Terminal not found",
          requestId: msg.requestId,
        },
      });
      return;
    }
    this.ensureTerminalExitSubscription(session);

    // Unsubscribe from previous subscription if any
    const existing = this.terminalSubscriptions.get(msg.terminalId);
    if (existing) {
      existing();
    }

    // Subscribe to terminal updates
    const unsubscribe = session.subscribe((serverMsg) => {
      if (serverMsg.type === "full") {
        this.emit({
          type: "terminal_output",
          payload: {
            terminalId: msg.terminalId,
            state: serverMsg.state,
          },
        });
      }
    });
    this.terminalSubscriptions.set(msg.terminalId, unsubscribe);

    // Send initial state
    this.emit({
      type: "subscribe_terminal_response",
      payload: {
        terminalId: msg.terminalId,
        state: session.getState(),
        error: null,
        requestId: msg.requestId,
      },
    });
  }

  private handleUnsubscribeTerminalRequest(msg: UnsubscribeTerminalRequest): void {
    const unsubscribe = this.terminalSubscriptions.get(msg.terminalId);
    if (unsubscribe) {
      unsubscribe();
      this.terminalSubscriptions.delete(msg.terminalId);
    }
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

    session.send(msg.message);
  }

  private killTrackedTerminal(terminalId: string, options?: { emitExit: boolean }): void {
    const unsubscribe = this.terminalSubscriptions.get(terminalId);
    if (unsubscribe) {
      unsubscribe();
      this.terminalSubscriptions.delete(terminalId);
    }

    const streamId = this.terminalStreamByTerminalId.get(terminalId);
    if (typeof streamId === "number") {
      this.detachTerminalStream(streamId, { emitExit: options?.emitExit ?? true });
    }

    this.terminalManager?.killTerminal(terminalId);
  }

  private async killTerminalsUnderPath(rootPath: string): Promise<void> {
    if (!this.terminalManager) {
      return;
    }

    const cleanupErrors: Array<{ cwd: string; message: string }> = [];
    const terminalDirectories = [...this.terminalManager.listDirectories()];
    for (const terminalCwd of terminalDirectories) {
      if (!this.isPathWithinRoot(rootPath, terminalCwd)) {
        continue;
      }

      try {
        const terminals = await this.terminalManager.getTerminals(terminalCwd);
        for (const terminal of [...terminals]) {
          this.killTrackedTerminal(terminal.id, { emitExit: true });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        cleanupErrors.push({ cwd: terminalCwd, message });
        this.sessionLogger.warn(
          { err: error, cwd: terminalCwd },
          "Failed to clean up worktree terminals during archive"
        );
      }
    }

    if (cleanupErrors.length > 0) {
      const details = cleanupErrors
        .map((entry) => `${entry.cwd}: ${entry.message}`)
        .join("; ");
      throw new Error(`Failed to clean up worktree terminals during archive (${details})`);
    }
  }

  private async handleKillTerminalRequest(msg: KillTerminalRequest): Promise<void> {
    if (!this.terminalManager) {
      this.emit({
        type: "kill_terminal_response",
        payload: {
          terminalId: msg.terminalId,
          success: false,
          requestId: msg.requestId,
        },
      });
      return;
    }

    this.killTrackedTerminal(msg.terminalId, { emitExit: true });
    this.emit({
      type: "kill_terminal_response",
      payload: {
        terminalId: msg.terminalId,
        success: true,
        requestId: msg.requestId,
      },
    });
  }

  private async handleAttachTerminalStreamRequest(
    msg: AttachTerminalStreamRequest
  ): Promise<void> {
    if (!this.terminalManager || !this.onBinaryMessage) {
      this.emit({
        type: "attach_terminal_stream_response",
        payload: {
          terminalId: msg.terminalId,
          streamId: null,
          replayedFrom: 0,
          currentOffset: 0,
          earliestAvailableOffset: 0,
          reset: true,
          error: "Terminal streaming not available",
          requestId: msg.requestId,
        },
      });
      return;
    }

    const session = this.terminalManager.getTerminal(msg.terminalId);
    if (!session) {
      this.emit({
        type: "attach_terminal_stream_response",
        payload: {
          terminalId: msg.terminalId,
          streamId: null,
          replayedFrom: 0,
          currentOffset: 0,
          earliestAvailableOffset: 0,
          reset: true,
          error: "Terminal not found",
          requestId: msg.requestId,
        },
      });
      return;
    }

    if (msg.rows || msg.cols) {
      const state = session.getState();
      session.send({
        type: "resize",
        rows: msg.rows ?? state.rows,
        cols: msg.cols ?? state.cols,
      });
    }

    const existingStreamId = this.terminalStreamByTerminalId.get(msg.terminalId);
    if (typeof existingStreamId === "number") {
      this.detachTerminalStream(existingStreamId, { emitExit: false });
    }

    const streamId = this.allocateTerminalStreamId();
    const initialOffset = Math.max(0, Math.floor(msg.resumeOffset ?? 0));
    const binding: {
      terminalId: string;
      unsubscribe: () => void;
      lastOutputOffset: number;
      lastAckOffset: number;
      pendingChunks: TerminalStreamPendingChunk[];
      pendingBytes: number;
    } = {
      terminalId: msg.terminalId,
      unsubscribe: () => {},
      lastOutputOffset: initialOffset,
      lastAckOffset: initialOffset,
      pendingChunks: [],
      pendingBytes: 0,
    };
    this.terminalStreams.set(streamId, binding);
    this.terminalStreamByTerminalId.set(msg.terminalId, streamId);

    let rawSub;
    try {
      rawSub = session.subscribeRaw(
        (chunk) => {
          const currentBinding = this.terminalStreams.get(streamId);
          if (!currentBinding) {
            return;
          }
          this.enqueueOrEmitTerminalStreamChunk(streamId, currentBinding, {
            data: chunk.data,
            startOffset: chunk.startOffset,
            endOffset: chunk.endOffset,
            replay: chunk.replay,
          });
        },
        { fromOffset: msg.resumeOffset ?? 0 }
      );
    } catch (error) {
      this.terminalStreams.delete(streamId);
      this.terminalStreamByTerminalId.delete(msg.terminalId);
      throw error;
    }

    binding.unsubscribe = rawSub.unsubscribe;
    binding.lastAckOffset = rawSub.replayedFrom;
    if (binding.lastOutputOffset < rawSub.replayedFrom) {
      binding.lastOutputOffset = rawSub.replayedFrom;
    }
    this.flushPendingTerminalStreamChunks(streamId, binding);

    this.emit({
      type: "attach_terminal_stream_response",
      payload: {
        terminalId: msg.terminalId,
        streamId,
        replayedFrom: rawSub.replayedFrom,
        currentOffset: rawSub.currentOffset,
        earliestAvailableOffset: rawSub.earliestAvailableOffset,
        reset: rawSub.reset,
        error: null,
        requestId: msg.requestId,
      },
    });
  }

  private getTerminalStreamChunkByteLength(chunk: TerminalStreamPendingChunk): number {
    return Math.max(0, chunk.endOffset - chunk.startOffset);
  }

  private canEmitTerminalStreamChunk(
    binding: {
      lastAckOffset: number;
    },
    chunk: TerminalStreamPendingChunk
  ): boolean {
    return chunk.startOffset < binding.lastAckOffset + TERMINAL_STREAM_WINDOW_BYTES;
  }

  private emitTerminalStreamChunk(
    streamId: number,
    binding: {
      lastOutputOffset: number;
    },
    chunk: TerminalStreamPendingChunk
  ): void {
    const payload = new Uint8Array(Buffer.from(chunk.data, "utf8"));
    this.emitBinary({
      channel: BinaryMuxChannel.Terminal,
      messageType: TerminalBinaryMessageType.OutputUtf8,
      streamId,
      offset: chunk.startOffset,
      flags: chunk.replay ? TerminalBinaryFlags.Replay : 0,
      payload,
    });
    binding.lastOutputOffset = chunk.endOffset;
  }

  private enqueueOrEmitTerminalStreamChunk(
    streamId: number,
    binding: {
      lastAckOffset: number;
      lastOutputOffset: number;
      pendingChunks: TerminalStreamPendingChunk[];
      pendingBytes: number;
    },
    chunk: TerminalStreamPendingChunk
  ): void {
    const chunkBytes = this.getTerminalStreamChunkByteLength(chunk);

    if (binding.pendingChunks.length > 0 || !this.canEmitTerminalStreamChunk(binding, chunk)) {
      if (
        binding.pendingChunks.length >= TERMINAL_STREAM_MAX_PENDING_CHUNKS ||
        binding.pendingBytes + chunkBytes > TERMINAL_STREAM_MAX_PENDING_BYTES
      ) {
        this.sessionLogger.warn(
          {
            streamId,
            pendingChunks: binding.pendingChunks.length,
            pendingBytes: binding.pendingBytes,
            chunkBytes,
          },
          "Terminal stream pending buffer overflow; closing stream"
        );
        this.detachTerminalStream(streamId, { emitExit: true });
        return;
      }
      binding.pendingChunks.push(chunk);
      binding.pendingBytes += chunkBytes;
      return;
    }

    this.emitTerminalStreamChunk(streamId, binding, chunk);
  }

  private flushPendingTerminalStreamChunks(
    streamId: number,
    binding: {
      lastAckOffset: number;
      lastOutputOffset: number;
      pendingChunks: TerminalStreamPendingChunk[];
      pendingBytes: number;
    }
  ): void {
    while (binding.pendingChunks.length > 0) {
      const next = binding.pendingChunks[0];
      if (!next || !this.canEmitTerminalStreamChunk(binding, next)) {
        break;
      }
      binding.pendingChunks.shift();
      binding.pendingBytes -= this.getTerminalStreamChunkByteLength(next);
      if (binding.pendingBytes < 0) {
        binding.pendingBytes = 0;
      }
      this.emitTerminalStreamChunk(streamId, binding, next);
    }
  }

  private handleDetachTerminalStreamRequest(msg: DetachTerminalStreamRequest): void {
    const success = this.detachTerminalStream(msg.streamId, { emitExit: false });
    this.emit({
      type: "detach_terminal_stream_response",
      payload: {
        streamId: msg.streamId,
        success,
        requestId: msg.requestId,
      },
    });
  }

  private detachAllTerminalStreams(options?: { emitExit: boolean }): void {
    for (const streamId of Array.from(this.terminalStreams.keys())) {
      this.detachTerminalStream(streamId, options);
    }
  }

  private detachTerminalStream(
    streamId: number,
    options?: { emitExit: boolean }
  ): boolean {
    const binding = this.terminalStreams.get(streamId);
    if (!binding) {
      return false;
    }

    try {
      binding.unsubscribe();
    } catch (error) {
      this.sessionLogger.warn({ err: error, streamId }, "Failed to unsubscribe terminal stream");
    }
    this.terminalStreams.delete(streamId);
    if (this.terminalStreamByTerminalId.get(binding.terminalId) === streamId) {
      this.terminalStreamByTerminalId.delete(binding.terminalId);
    }

    if (options?.emitExit) {
      this.emit({
        type: "terminal_stream_exit",
        payload: {
          streamId,
          terminalId: binding.terminalId,
        },
      });
    }
    return true;
  }

  private allocateTerminalStreamId(): number {
    let attempts = 0;
    while (attempts < 0xffffffff) {
      const candidate = this.nextTerminalStreamId >>> 0;
      this.nextTerminalStreamId = ((this.nextTerminalStreamId + 1) & 0xffffffff) >>> 0;
      if (candidate === 0) {
        attempts += 1;
        continue;
      }
      if (!this.terminalStreams.has(candidate)) {
        return candidate;
      }
      attempts += 1;
    }
    throw new Error("Unable to allocate terminal stream id");
  }
}
