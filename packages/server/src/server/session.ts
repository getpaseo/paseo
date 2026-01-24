import { v4 as uuidv4 } from "uuid";
import { readFile, mkdir, writeFile, stat } from "fs/promises";
import { exec } from "child_process";
import { promisify, inspect } from "util";
import { join, resolve, sep } from "path";
import invariant from "tiny-invariant";
import { streamText, stepCountIs } from "ai";
import type { ToolSet } from "ai";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { z } from "zod";
import {
  createOpenRouter,
  OpenRouterProviderOptions,
} from "@openrouter/ai-sdk-provider";
import {
  serializeAgentStreamEvent,
  type AgentSnapshotPayload,
  type SessionInboundMessage,
  type SessionOutboundMessage,
  type FileExplorerRequest,
  type FileDownloadTokenRequest,
  type GitSetupOptions,
  type ListTerminalsRequest,
  type CreateTerminalRequest,
  type SubscribeTerminalRequest,
  type UnsubscribeTerminalRequest,
  type TerminalInput,
  type KillTerminalRequest,
} from "./messages.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import { parseAndHighlightDiff, type ParsedDiffFile } from "./utils/diff-highlighter.js";
import { getSystemPrompt } from "./agent/system-prompt.js";
import { getAllTools } from "./agent/llm-openai.js";
import { TTSManager } from "./agent/tts-manager.js";
import { STTManager } from "./agent/stt-manager.js";
import type { OpenAISTT } from "./agent/stt-openai.js";
import type { OpenAITTS } from "./agent/tts-openai.js";
import { OpenAIRealtimeTranscriptionSession } from "./agent/openai-realtime-transcription.js";
import { Pcm16MonoResampler } from "./agent/pcm16-resampler.js";
import type { VoiceConversationStore } from "./voice-conversation-store.js";
import {
  buildConfigOverrides,
  buildSessionConfig,
} from "./persistence-hooks.js";
import { experimental_createMCPClient } from "ai";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildProviderRegistry } from "./agent/provider-registry.js";
import { AgentManager } from "./agent/agent-manager.js";
import type { ManagedAgent } from "./agent/agent-manager.js";
import { injectLeadingPaseoInstructionTag } from "./agent/paseo-instructions-tag.js";
import { toAgentPayload } from "./agent/agent-projections.js";
import {
  StructuredAgentResponseError,
  generateStructuredAgentResponse,
} from "./agent/agent-response-loop.js";
import type {
  AgentPermissionResponse,
  AgentPromptContentBlock,
  AgentPromptInput,
  AgentSessionConfig,
  AgentStreamEvent,
  AgentProvider,
  AgentPersistenceHandle,
  AgentTimelineItem,
} from "./agent/agent-sdk-types.js";
import { AgentStorage, type StoredAgentRecord } from "./agent/agent-storage.js";
import { isValidAgentProvider, AGENT_PROVIDER_IDS } from "./agent/provider-manifest.js";
import {
  listDirectoryEntries,
  readExplorerFile,
  getDownloadableFileInfo,
} from "./file-explorer/service.js";
import { DownloadTokenStore } from "./file-download/token-store.js";
import { PushTokenStore } from "./push/token-store.js";
import {
  createWorktree,
  runWorktreeSetupCommands,
  WorktreeSetupError,
  type WorktreeConfig,
  type WorktreeSetupCommandResult,
  slugify,
  validateBranchSlug,
  listPaseoWorktrees,
  deletePaseoWorktree,
  isPaseoOwnedWorktreeCwd,
} from "../utils/worktree.js";
import {
  getCheckoutDiff,
  getCheckoutStatus,
  NotGitRepoError,
  MergeConflictError,
  commitChanges,
  mergeToBase,
  createPullRequest,
  getPullRequestStatus,
} from "../utils/checkout-git.js";
import { expandTilde } from "../utils/path.js";
import type pino from "pino";

type AgentMcpClientConfig = {
  agentMcpUrl: string;
  agentMcpHeaders?: Record<string, string>;
};

const execAsync = promisify(exec);
const READ_ONLY_GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_OPTIONAL_LOCKS: "0",
};
const pendingAgentInitializations = new Map<string, Promise<ManagedAgent>>();
let restartRequested = false;
const DEFAULT_AGENT_PROVIDER = AGENT_PROVIDER_IDS[0];
const RESTART_EXIT_DELAY_MS = 250;

type ProcessingPhase = "idle" | "transcribing" | "llm";

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

const PCM_SAMPLE_RATE = 16000;
const PCM_CHANNELS = 1;
const PCM_BITS_PER_SAMPLE = 16;
const PCM_BYTES_PER_MS =
  (PCM_SAMPLE_RATE * PCM_CHANNELS * (PCM_BITS_PER_SAMPLE / 8)) / 1000;
const MIN_STREAMING_SEGMENT_DURATION_MS = 1000;
const MIN_STREAMING_SEGMENT_BYTES = Math.round(
  PCM_BYTES_PER_MS * MIN_STREAMING_SEGMENT_DURATION_MS
);

const DICTATION_PCM_INPUT_RATE = 16000;
const DICTATION_PCM_OUTPUT_RATE = 24000;
const DICTATION_FINAL_TIMEOUT_MS = 120000;
const DICTATION_SILENCE_PEAK_THRESHOLD = Number.parseInt(
  process.env.OPENAI_REALTIME_DICTATION_SILENCE_PEAK_THRESHOLD ?? "300",
  10
);
const DICTATION_TURN_DETECTION = (process.env.OPENAI_REALTIME_DICTATION_TURN_DETECTION ?? "semantic_vad").trim();
const DICTATION_SEMANTIC_VAD_EAGERNESS = (process.env.OPENAI_REALTIME_DICTATION_SEMANTIC_VAD_EAGERNESS ?? "medium").trim();
const DICTATION_FLUSH_SILENCE_MS = Number.parseInt(
  process.env.OPENAI_REALTIME_DICTATION_FLUSH_SILENCE_MS ?? "800",
  10
);
const SAFE_GIT_REF_PATTERN = /^[A-Za-z0-9._\/-]+$/;

function pcm16lePeakAbs(pcm16le: Buffer): number {
  if (pcm16le.length === 0) {
    return 0;
  }
  if (pcm16le.length % 2 !== 0) {
    throw new Error(`PCM16 chunk byteLength must be even, got ${pcm16le.length}`);
  }
  const samples = new Int16Array(
    pcm16le.buffer,
    pcm16le.byteOffset,
    pcm16le.byteLength / 2
  );
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = samples[i]!;
    const abs = v < 0 ? -v : v;
    if (abs > peak) {
      peak = abs;
      if (peak >= 32767) {
        break;
      }
    }
  }
  return peak;
}

function parseDictationTurnDetection():
  | null
  | { type: "server_vad"; create_response: false; threshold?: number; prefix_padding_ms?: number; silence_duration_ms?: number }
  | { type: "semantic_vad"; create_response: false; eagerness?: "low" | "medium" | "high" } {
  if (!DICTATION_TURN_DETECTION || DICTATION_TURN_DETECTION === "none" || DICTATION_TURN_DETECTION === "null") {
    return null;
  }
  if (DICTATION_TURN_DETECTION === "server_vad") {
    return { type: "server_vad", create_response: false };
  }
  const eagerness =
    DICTATION_SEMANTIC_VAD_EAGERNESS === "low" ||
    DICTATION_SEMANTIC_VAD_EAGERNESS === "high"
      ? (DICTATION_SEMANTIC_VAD_EAGERNESS as "low" | "high")
      : ("medium" as const);
  return { type: "semantic_vad", create_response: false, eagerness };
}

/**
 * Type for present_artifact tool arguments
 */
interface PresentArtifactArgs {
  type: "markdown" | "diff" | "image" | "code";
  source:
    | { type: "file"; path: string }
    | { type: "command_output"; command: string }
    | { type: "text"; text: string };
  title: string;
}

interface AudioBufferState {
  chunks: Buffer[];
  format: string;
  isPCM: boolean;
  totalPCMBytes: number;
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
 * Session represents a single client conversation session.
 * It owns all state management, orchestration logic, and message processing.
 * Session has no knowledge of WebSockets - it only emits and receives messages.
 */
export class Session {
  private readonly clientId: string;
  private readonly sessionId: string;
  private readonly onMessage: (msg: SessionOutboundMessage) => void;
  private readonly sessionLogger: pino.Logger;
  private readonly voiceConversationStore: VoiceConversationStore;

  // State machine
  private abortController: AbortController;
  private processingPhase: ProcessingPhase = "idle";
  private currentStreamPromise: Promise<void> | null = null;

  // Realtime mode state
  private isRealtimeMode = false;
  private speechInProgress = false;
  private voiceConversationId: string | null = null;

  private dictationStreams = new Map<
    string,
    {
      dictationId: string;
      inputFormat: string;
      openai: OpenAIRealtimeTranscriptionSession;
      resampler: Pcm16MonoResampler;
      receivedChunks: Map<number, Buffer>;
      nextSeqToForward: number;
      ackSeq: number;
      bytesSinceCommit: number;
      peakSinceCommit: number;
      committedItemIds: string[];
      transcriptsByItemId: Map<string, string>;
      finalTranscriptItemIds: Set<string>;
      awaitingFinalCommit: boolean;
      finishRequested: boolean;
      finalSeq: number | null;
      finalTimeout: ReturnType<typeof setTimeout> | null;
    }
  >();

  // Audio buffering for interruption handling
  private pendingAudioSegments: Array<{ audio: Buffer; format: string }> = [];
  private bufferTimeout: NodeJS.Timeout | null = null;
  private audioBuffer: AudioBufferState | null = null;

  // Conversation history
  private messages: ModelMessage[] = [];
  private turnIndex = 0;

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
  private readonly agentMcpConfig: AgentMcpClientConfig;
  private readonly downloadTokenStore: DownloadTokenStore;
  private readonly pushTokenStore: PushTokenStore;
  private readonly providerRegistry: ReturnType<typeof buildProviderRegistry>;
  private unsubscribeAgentEvents: (() => void) | null = null;
  private clientActivity: {
    deviceType: "web" | "mobile";
    focusedAgentId: string | null;
    lastActivityAt: Date;
    appVisible: boolean;
  } | null = null;
  private readonly terminalManager: TerminalManager | null;
  private terminalSubscriptions: Map<string, () => void> = new Map();

  constructor(
    clientId: string,
    onMessage: (msg: SessionOutboundMessage) => void,
    logger: pino.Logger,
    downloadTokenStore: DownloadTokenStore,
    pushTokenStore: PushTokenStore,
    agentManager: AgentManager,
    agentStorage: AgentStorage,
    agentMcpConfig: AgentMcpClientConfig,
    stt: OpenAISTT | null,
    tts: OpenAITTS | null,
    terminalManager: TerminalManager | null,
    voiceConversationStore: VoiceConversationStore
  ) {
    this.clientId = clientId;
    this.sessionId = uuidv4();
    this.onMessage = onMessage;
    this.downloadTokenStore = downloadTokenStore;
    this.pushTokenStore = pushTokenStore;
    this.agentManager = agentManager;
    this.agentStorage = agentStorage;
    this.agentMcpConfig = agentMcpConfig;
    this.terminalManager = terminalManager;
    this.voiceConversationStore = voiceConversationStore;
    this.abortController = new AbortController();
    this.sessionLogger = logger.child({
      module: "session",
      clientId: this.clientId,
      sessionId: this.sessionId,
    });
    this.providerRegistry = buildProviderRegistry(this.sessionLogger);

    // Initialize per-session managers
    this.ttsManager = new TTSManager(this.sessionId, this.sessionLogger, tts);
    this.sttManager = new STTManager(this.sessionId, this.sessionLogger, stt);

    // Initialize agent MCP client asynchronously
    void this.initializeAgentMcp();
    this.subscribeToAgentEvents();

    this.sessionLogger.info("Session created");
  }

  /**
   * Get the client's current activity state
   */
  public getClientActivity(): {
    deviceType: "web" | "mobile";
    focusedAgentId: string | null;
    lastActivityAt: Date;
    appVisible: boolean;
  } | null {
    return this.clientActivity;
  }

  /**
   * Send initial state to client after connection
   */
  public async sendInitialState(): Promise<void> {
    await this.sendSessionState();
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
   * Returns once the manager confirms the stream has been cancelled AND
   * the agent has fully transitioned to idle state.
   */
  private async interruptAgentIfRunning(agentId: string): Promise<void> {
    const snapshot = this.agentManager.getAgent(agentId);
    if (!snapshot) {
      throw new Error(`Agent ${agentId} not found`);
    }

    if (snapshot.lifecycle !== "running" && !snapshot.pendingRun) {
      console.error(`[INTERRUPT:${agentId.substring(0, 8)}] not running, skipping. lifecycle=${snapshot.lifecycle} pendingRun=${!!snapshot.pendingRun}`);
      return;
    }

    console.error(`[INTERRUPT:${agentId.substring(0, 8)}] starting interrupt. lifecycle=${snapshot.lifecycle} pendingRun=${!!snapshot.pendingRun}`);

    try {
      const t0 = Date.now();
      const cancelled = await this.agentManager.cancelAgentRun(agentId);
      console.error(`[INTERRUPT] cancelAgentRun returned cancelled=${cancelled} in ${Date.now() - t0}ms`);
      if (!cancelled) {
        console.error(`[INTERRUPT] WARNING: reported running but no active run was cancelled`);
      }

      // Wait for the agent to become idle after cancellation
      const maxWaitMs = 5000;
      const pollIntervalMs = 50;
      const startTime = Date.now();
      while (Date.now() - startTime < maxWaitMs) {
        const current = this.agentManager.getAgent(agentId);
        if (!current) {
          throw new Error(`Agent ${agentId} not found during cancellation wait`);
        }
        if (current.lifecycle !== "running" && !current.pendingRun) {
          console.error(`[INTERRUPT] agent became idle after ${Date.now() - startTime}ms`);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
      const finalState = this.agentManager.getAgent(agentId);
      if (finalState?.lifecycle === "running" || finalState?.pendingRun) {
        console.error(`[INTERRUPT] WARNING: agent still running after 5s wait! lifecycle=${finalState?.lifecycle} pendingRun=${!!finalState?.pendingRun}`);
      }
    } catch (error) {
      console.error(`[INTERRUPT] ERROR:`, error);
      throw error;
    }
  }

  /**
   * Start streaming an agent run and forward results via the websocket broadcast
   */
  private startAgentStream(agentId: string, prompt: AgentPromptInput): void {
    console.error(`[SESSION:startAgentStream] starting for agent ${agentId.substring(0, 8)}, prompt="${typeof prompt === 'string' ? prompt.substring(0, 40) : 'object'}"`);
    this.sessionLogger.info(
      { agentId },
      `Starting agent stream for ${agentId}`
    );

    let iterator: AsyncGenerator<AgentStreamEvent>;
    try {
      iterator = this.agentManager.streamAgent(agentId, prompt);
    } catch (error) {
      this.handleAgentRunError(agentId, error, "Failed to start agent run");
      return;
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
   * Initialize Agent MCP client for this session
   */
  private async initializeAgentMcp(): Promise<void> {
    try {
      const transport = new StreamableHTTPClientTransport(
        new URL(this.agentMcpConfig.agentMcpUrl),
        this.agentMcpConfig.agentMcpHeaders
          ? {
              requestInit: {
                headers: this.agentMcpConfig.agentMcpHeaders,
              },
            }
          : undefined
      );

      this.agentMcpClient = await experimental_createMCPClient({
        transport,
      });

      this.agentTools = (await this.agentMcpClient.tools()) as ToolSet;
      const agentToolCount = Object.keys(this.agentTools ?? {}).length;
      this.sessionLogger.info(
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
          void this.forwardAgentState(event.agent);
          return;
        }

        const payload = {
          agentId: event.agentId,
          event: serializeAgentStreamEvent(event.event),
          timestamp: new Date().toISOString(),
        } as const;

        const itemType = event.event.type === "timeline" ? event.event.item.type : undefined;
        this.sessionLogger.debug(
          { timestamp: Date.now(), agentId: event.agentId, eventType: event.event.type, itemType },
          "Agent stream event"
        );
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

        // Title updates are now handled by set_title MCP tool calls.
      },
      { replayState: false }
    );
  }

  private async buildAgentPayload(
    agent: ManagedAgent
  ): Promise<AgentSnapshotPayload> {
    const title = await this.getStoredAgentTitle(agent.id);
    return toAgentPayload(agent, { title });
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
        snapshot = await this.agentManager.resumeAgent(
          handle,
          buildConfigOverrides(record),
          agentId
        );
      } else {
        const config = buildSessionConfig(record);
        snapshot = await this.agentManager.createAgent(config, agentId);
      }

      await this.agentManager.primeAgentHistory(agentId);
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

  private async forwardAgentState(agent: ManagedAgent): Promise<void> {
    try {
      const payload = await this.buildAgentPayload(agent);
      this.emit({
        type: "agent_state",
        payload,
      });
    } catch (error) {
      this.sessionLogger.error(
        { err: error },
        "Failed to emit agent state"
      );
    }
  }

  private async getStoredAgentTitle(agentId: string): Promise<string | null> {
    try {
      const record = await this.agentStorage.get(agentId);
      const title = record?.title ?? null;
      return title;
    } catch (error) {
      this.sessionLogger.error(
        { err: error, agentId },
        `Failed to load registry record for agent ${agentId}`
      );
      return null;
    }
  }

  /**
   * Main entry point for processing session messages
   */
  public async handleMessage(msg: SessionInboundMessage): Promise<void> {
    try {
      switch (msg.type) {
        case "user_text":
          await this.handleUserText(msg.text);
          break;

        case "realtime_audio_chunk":
          await this.handleAudioChunk(msg);
          break;

        case "abort_request":
          await this.handleAbort();
          break;

        case "audio_played":
          this.handleAudioPlayed(msg.id);
          break;

        case "request_session_state":
          await this.sendSessionState();
          break;

        case "load_voice_conversation_request":
          await this.handleLoadVoiceConversation(msg.voiceConversationId, msg.requestId);
          break;

        case "list_voice_conversations_request":
          await this.handleListVoiceConversations(msg.requestId);
          break;

        case "delete_voice_conversation_request":
          await this.handleDeleteVoiceConversation(
            msg.voiceConversationId,
            msg.requestId
          );
          break;

        case "delete_agent_request":
          await this.handleDeleteAgentRequest(msg.agentId, msg.requestId);
          break;

        case "set_voice_conversation":
          await this.handleSetVoiceConversation(msg.enabled, msg.voiceConversationId);
          break;

        case "send_agent_message":
          await this.handleSendAgentMessage(
            msg.agentId,
            msg.text,
            msg.messageId,
            msg.images
          );
          break;

        case "dictation_stream_start":
          await this.handleDictationStreamStart(msg);
          break;

        case "dictation_stream_chunk":
          await this.handleDictationStreamChunk(msg);
          break;

        case "dictation_stream_finish":
          await this.handleDictationStreamFinish(msg);
          break;

        case "dictation_stream_cancel":
          await this.handleDictationStreamCancel(msg);
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

      case "initialize_agent_request":
        await this.handleInitializeAgentRequest(msg.agentId, msg.requestId);
        break;

        case "set_agent_mode":
          await this.handleSetAgentMode(msg.agentId, msg.modeId);
          break;

        case "agent_permission_response":
          await this.handleAgentPermissionResponse(
            msg.agentId,
            msg.requestId,
            msg.response
          );
          break;

        case "git_diff_request":
          await this.handleGitDiffRequest(msg.agentId, msg.requestId);
          break;

        case "checkout_status_request":
          await this.handleCheckoutStatusRequest(msg);
          break;

        case "checkout_diff_request":
          await this.handleCheckoutDiffRequest(msg);
          break;

        case "checkout_commit_request":
          await this.handleCheckoutCommitRequest(msg);
          break;

        case "checkout_merge_request":
          await this.handleCheckoutMergeRequest(msg);
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

        case "highlighted_diff_request":
          await this.handleHighlightedDiffRequest(msg.agentId, msg.requestId);
          break;

        case "file_explorer_request":
          await this.handleFileExplorerRequest(msg);
          break;

        case "file_download_token_request":
          await this.handleFileDownloadTokenRequest(msg);
          break;

        case "git_repo_info_request":
          await this.handleGitRepoInfoRequest(msg);
          break;

        case "list_provider_models_request":
          await this.handleListProviderModelsRequest(msg);
          break;

        case "clear_agent_attention":
          await this.handleClearAgentAttention(msg.agentId);
          break;

        case "client_heartbeat":
          this.handleClientHeartbeat(msg);
          break;

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
      }
    } catch (error: any) {
      this.sessionLogger.error(
        { err: error },
        "Error handling message"
      );
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Error: ${error.message}`,
        },
      });
    }
  }

  /**
   * Load a voice conversation into this session (best-effort).
   */
  public async handleLoadVoiceConversation(
    voiceConversationId: string,
    requestId: string
  ): Promise<void> {
    const loaded = await this.voiceConversationStore.load(
      this.sessionLogger,
      voiceConversationId
    );

    this.voiceConversationId = voiceConversationId;
    this.messages = loaded ?? [];

    this.emit({
      type: "voice_conversation_loaded",
      payload: {
        voiceConversationId,
        messageCount: this.messages.length,
        requestId,
      },
    });

    // Send current session state (live agents and commands)
    await this.sendSessionState();
  }

  /**
   * List all voice conversations
   */
  public async handleListVoiceConversations(requestId: string): Promise<void> {
    try {
      const conversations = await this.voiceConversationStore.list(this.sessionLogger);
      this.emit({
        type: "list_voice_conversations_response",
        payload: {
          conversations: conversations.map((conv) => ({
            id: conv.id,
            lastUpdated: conv.lastUpdated.toISOString(),
            messageCount: conv.messageCount,
          })),
          requestId,
        },
      });
    } catch (error: any) {
      this.sessionLogger.error(
        { err: error },
        "Failed to list voice conversations"
      );
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to list voice conversations: ${error.message}`,
        },
      });
    }
  }

  /**
   * Delete a voice conversation
   */
  public async handleDeleteVoiceConversation(
    voiceConversationId: string,
    requestId: string
  ): Promise<void> {
    try {
      await this.voiceConversationStore.delete(this.sessionLogger, voiceConversationId);
      this.emit({
        type: "delete_voice_conversation_response",
        payload: {
          voiceConversationId,
          success: true,
          requestId,
        },
      });
      this.sessionLogger.info(
        { voiceConversationId },
        `Deleted voice conversation ${voiceConversationId}`
      );
    } catch (error: any) {
      this.sessionLogger.error(
        { err: error, voiceConversationId },
        `Failed to delete voice conversation ${voiceConversationId}`
      );
      this.emit({
        type: "delete_voice_conversation_response",
        payload: {
          voiceConversationId,
          success: false,
          error: error.message,
          requestId,
        },
      });
    }
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
  }

  /**
   * Handle realtime mode toggle
   */
  private async handleSetVoiceConversation(
    enabled: boolean,
    voiceConversationId?: string
  ): Promise<void> {
    if (enabled) {
      if (!voiceConversationId || voiceConversationId.trim().length === 0) {
        this.sessionLogger.warn("set_voice_conversation missing voiceConversationId; ignoring");
        return;
      }

      this.isRealtimeMode = true;
      this.voiceConversationId = voiceConversationId;

      const loaded = await this.voiceConversationStore.load(
        this.sessionLogger,
        voiceConversationId
      );
      this.messages = loaded ?? [];

      this.sessionLogger.info(
        { voiceConversationId, messageCount: this.messages.length },
        "Voice conversation enabled"
      );
      return;
    }

    this.isRealtimeMode = false;
    const idToPersist = this.voiceConversationId;
    if (idToPersist) {
      try {
        await this.voiceConversationStore.save(
          this.sessionLogger,
          idToPersist,
          this.messages
        );
      } catch (error) {
        this.sessionLogger.warn({ err: error }, "Failed to persist voice conversation");
      }
    }

    this.sessionLogger.info({ voiceConversationId: idToPersist }, "Voice conversation disabled");
  }

  /**
   * Handle text message to agent (with optional image attachments)
   */
  private async handleSendAgentMessage(
    agentId: string,
    text: string,
    messageId?: string,
    images?: Array<{ data: string; mimeType: string }>
  ): Promise<void> {
    console.error(`[SESSION:handleSendAgentMessage] ENTERED agentId=${agentId.substring(0, 8)} text="${text.substring(0, 40)}"`);
    this.sessionLogger.info(
      { agentId, textPreview: text.substring(0, 50), imageCount: images?.length ?? 0 },
      `Sending text to agent ${agentId}${images && images.length > 0 ? ` with ${images.length} image attachment(s)` : ''}`
    );

    try {
      console.error(`[SESSION:handleSendAgentMessage] calling ensureAgentLoaded...`);
      await this.ensureAgentLoaded(agentId);
      console.error(`[SESSION:handleSendAgentMessage] ensureAgentLoaded done`);
    } catch (error) {
      console.error(`[SESSION:handleSendAgentMessage] ensureAgentLoaded FAILED:`, error);
      this.handleAgentRunError(
        agentId,
        error,
        "Failed to initialize agent before sending prompt"
      );
      return;
    }

    try {
      const snapshotBeforeInterrupt = this.agentManager.getAgent(agentId);
      console.error(`[SESSION:handleSendAgentMessage] before interrupt: lifecycle=${snapshotBeforeInterrupt?.lifecycle} pendingRun=${!!snapshotBeforeInterrupt?.pendingRun}`);
      await this.interruptAgentIfRunning(agentId);
      console.error(`[SESSION:handleSendAgentMessage] interrupt done`);
    } catch (error) {
      console.error(`[SESSION:handleSendAgentMessage] interrupt FAILED:`, error);
      this.handleAgentRunError(
        agentId,
        error,
        "Failed to interrupt running agent before sending prompt"
      );
      return;
    }

    const prompt = this.buildAgentPrompt(text, images);
    console.error(`[SESSION:handleSendAgentMessage] calling recordUserMessage...`);

    try {
      this.agentManager.recordUserMessage(agentId, text, { messageId });
    } catch (error) {
      this.sessionLogger.error(
        { err: error, agentId },
        `Failed to record user message for agent ${agentId}`
      );
    }

    console.error(`[SESSION:handleSendAgentMessage] calling startAgentStream...`);
    this.startAgentStream(agentId, prompt);
  }

  private emitDictationAck(dictationId: string, ackSeq: number): void {
    this.emit({
      type: "dictation_stream_ack",
      payload: { dictationId, ackSeq },
    });
  }

  private failDictationStream(dictationId: string, error: string, retryable: boolean): void {
    this.emit({
      type: "dictation_stream_error",
      payload: { dictationId, error, retryable },
    });
  }

  private cleanupDictationStream(dictationId: string): void {
    const state = this.dictationStreams.get(dictationId) ?? null;
    if (!state) {
      return;
    }
    if (state.finalTimeout) {
      clearTimeout(state.finalTimeout);
    }
    try {
      state.openai.close();
    } catch {
      // no-op
    }
    this.dictationStreams.delete(dictationId);
  }

  private emitDictationPartial(dictationId: string, text: string): void {
    this.emit({
      type: "dictation_stream_partial",
      payload: { dictationId, text },
    });
  }

  private maybeFinalizeDictationStream(dictationId: string): void {
    const state = this.dictationStreams.get(dictationId);
    if (!state) {
      return;
    }

    if (!state.finishRequested || state.finalSeq === null) {
      return;
    }
    if (state.ackSeq < state.finalSeq) {
      return;
    }
    if (state.awaitingFinalCommit) {
      return;
    }

    if (state.committedItemIds.length === 0) {
      return;
    }

    const allTranscriptsReady = state.committedItemIds.every((itemId) =>
      state.finalTranscriptItemIds.has(itemId)
    );
    if (!allTranscriptsReady) {
      return;
    }

    const orderedText = state.committedItemIds
      .map((itemId) => state.transcriptsByItemId.get(itemId) ?? "")
      .join(" ")
      .trim();

    this.emit({
      type: "dictation_stream_final",
      payload: { dictationId, text: orderedText },
    });

    this.cleanupDictationStream(dictationId);
  }

  private async handleDictationStreamStart(
    msg: Extract<SessionInboundMessage, { type: "dictation_stream_start" }>
  ): Promise<void> {
    const dictationId = msg.dictationId;
    this.cleanupDictationStream(dictationId);

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      this.failDictationStream(dictationId, "OPENAI_API_KEY not set", false);
      return;
    }

    const transcriptionModel =
      process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL ?? "gpt-4o-transcribe";
    const transcriptionPrompt =
      process.env.OPENAI_REALTIME_DICTATION_TRANSCRIPTION_PROMPT ??
      "Transcribe only what the speaker says. Do not add words. Preserve punctuation and casing. If the audio is silence or non-speech noise, return an empty transcript.";

    const openai = new OpenAIRealtimeTranscriptionSession({
      apiKey,
      logger: this.sessionLogger.child({ dictationId }),
      transcriptionModel,
      language: "en",
      prompt: transcriptionPrompt,
      turnDetection: parseDictationTurnDetection(),
    });

    openai.on("committed", ({ itemId }: { itemId: string }) => {
      const state = this.dictationStreams.get(dictationId);
      if (!state) {
        return;
      }
      state.committedItemIds.push(itemId);
      state.bytesSinceCommit = 0;
      state.peakSinceCommit = 0;

      // When finishing, we require at least one commit after finish if we flushed pending audio.
      if (state.finishRequested && state.awaitingFinalCommit) {
        state.awaitingFinalCommit = false;
      }

      this.maybeFinalizeDictationStream(dictationId);
    });

    openai.on(
      "transcript",
      ({ itemId, transcript, isFinal }: { itemId: string; transcript: string; isFinal: boolean }) => {
        const state = this.dictationStreams.get(dictationId);
        if (!state) {
          return;
        }
        state.transcriptsByItemId.set(itemId, transcript);
        if (isFinal) {
          state.finalTranscriptItemIds.add(itemId);
        }

        const orderedIds = state.committedItemIds.includes(itemId)
          ? state.committedItemIds
          : [...state.committedItemIds, itemId];
        const partialText = orderedIds
          .map((id) => state.transcriptsByItemId.get(id) ?? "")
          .join(" ")
          .trim();
        this.emitDictationPartial(dictationId, partialText);

        this.maybeFinalizeDictationStream(dictationId);
      }
    );

    openai.on("error", (err) => {
      const message = err instanceof Error ? err.message : String(err);
      this.failDictationStream(dictationId, message, true);
      this.cleanupDictationStream(dictationId);
    });

    await openai.connect();

    this.dictationStreams.set(dictationId, {
      dictationId,
      inputFormat: msg.format,
      openai,
      resampler: new Pcm16MonoResampler({
        inputRate: DICTATION_PCM_INPUT_RATE,
        outputRate: DICTATION_PCM_OUTPUT_RATE,
      }),
      receivedChunks: new Map(),
      nextSeqToForward: 0,
      ackSeq: -1,
      bytesSinceCommit: 0,
      peakSinceCommit: 0,
      committedItemIds: [],
      transcriptsByItemId: new Map(),
      finalTranscriptItemIds: new Set(),
      awaitingFinalCommit: false,
      finishRequested: false,
      finalSeq: null,
      finalTimeout: null,
    });

    this.emitDictationAck(dictationId, -1);
  }

  private async handleDictationStreamChunk(
    msg: Extract<SessionInboundMessage, { type: "dictation_stream_chunk" }>
  ): Promise<void> {
    const state = this.dictationStreams.get(msg.dictationId);
    if (!state) {
      this.failDictationStream(msg.dictationId, "Dictation stream not started", true);
      return;
    }

    if (msg.format !== state.inputFormat) {
      this.failDictationStream(
        msg.dictationId,
        `Mismatched dictation stream format: ${msg.format}`,
        false
      );
      return;
    }

    if (msg.seq < state.nextSeqToForward) {
      this.emitDictationAck(msg.dictationId, state.ackSeq);
      return;
    }

    if (!state.receivedChunks.has(msg.seq)) {
      state.receivedChunks.set(msg.seq, Buffer.from(msg.audio, "base64"));
    }

    while (state.receivedChunks.has(state.nextSeqToForward)) {
      const seq = state.nextSeqToForward;
      const pcm16 = state.receivedChunks.get(seq)!;
      state.receivedChunks.delete(seq);

      const resampled = state.resampler.processChunk(pcm16);
      if (resampled.length > 0) {
        state.openai.appendPcm16Base64(resampled.toString("base64"));
        state.bytesSinceCommit += resampled.length;
        state.peakSinceCommit = Math.max(state.peakSinceCommit, pcm16lePeakAbs(resampled));
      }

      state.nextSeqToForward += 1;
      state.ackSeq = state.nextSeqToForward - 1;
    }

    this.emitDictationAck(msg.dictationId, state.ackSeq);
  }

  private async handleDictationStreamFinish(
    msg: Extract<SessionInboundMessage, { type: "dictation_stream_finish" }>
  ): Promise<void> {
    const state = this.dictationStreams.get(msg.dictationId);
    if (!state) {
      this.failDictationStream(msg.dictationId, "Dictation stream not started", true);
      return;
    }

    state.finishRequested = true;
    state.finalSeq = msg.finalSeq;

    // If the client claims it sent audio (finalSeq >= 0) but we haven't received any chunks at all,
    // we should fail fast instead of hanging until DICTATION_FINAL_TIMEOUT_MS.
    if (msg.finalSeq >= 0 && state.ackSeq < 0 && state.nextSeqToForward === 0 && state.receivedChunks.size === 0) {
      this.sessionLogger.debug(
        {
          dictationId: msg.dictationId,
          finalSeq: msg.finalSeq,
          ackSeq: state.ackSeq,
          nextSeqToForward: state.nextSeqToForward,
          receivedChunks: state.receivedChunks.size,
          bytesSinceCommit: state.bytesSinceCommit,
        },
        "Dictation finish: no chunks received (failing fast)"
      );
      this.failDictationStream(
        msg.dictationId,
        `Dictation finished (finalSeq=${msg.finalSeq}) but no audio chunks were received`,
        true
      );
      this.cleanupDictationStream(msg.dictationId);
      return;
    }

    // Force-flush any remaining audio so we get a final transcription even if VAD hasn't committed yet.
    if (state.bytesSinceCommit > 0) {
      if (state.peakSinceCommit < DICTATION_SILENCE_PEAK_THRESHOLD) {
        this.sessionLogger.debug(
          {
            dictationId: msg.dictationId,
            bytesSinceCommit: state.bytesSinceCommit,
            peakSinceCommit: state.peakSinceCommit,
          },
          "Dictation finish: clearing silence-only tail (skip final commit)"
        );
        state.openai.clear();
        state.bytesSinceCommit = 0;
        state.peakSinceCommit = 0;
        state.awaitingFinalCommit = false;
      } else {
        // We do not manually commit for dictation (to avoid chopping words). Instead we rely on
        // OpenAI semantic VAD to commit utterances. When the user presses OK, we append a short
        // silence tail so VAD has enough silence to close out the final utterance promptly.
        const silenceBytes = Math.max(
          0,
          Math.round((DICTATION_PCM_OUTPUT_RATE * 2 * DICTATION_FLUSH_SILENCE_MS) / 1000)
        );
        if (silenceBytes > 0) {
          this.sessionLogger.debug(
            { dictationId: msg.dictationId, silenceMs: DICTATION_FLUSH_SILENCE_MS, silenceBytes },
            "Dictation finish: appending silence tail for semantic VAD flush"
          );
          state.openai.appendPcm16Base64(Buffer.alloc(silenceBytes).toString("base64"));
          state.bytesSinceCommit += silenceBytes;
        }
        state.awaitingFinalCommit = true;
      }
    } else {
      state.awaitingFinalCommit = false;
    }

    if (state.finalTimeout) {
      clearTimeout(state.finalTimeout);
    }
    state.finalTimeout = setTimeout(() => {
      this.failDictationStream(
        msg.dictationId,
        "Timed out waiting for final transcription",
        true
      );
      this.cleanupDictationStream(msg.dictationId);
    }, DICTATION_FINAL_TIMEOUT_MS);

    this.maybeFinalizeDictationStream(msg.dictationId);
  }

  private async handleDictationStreamCancel(
    msg: Extract<SessionInboundMessage, { type: "dictation_stream_cancel" }>
  ): Promise<void> {
    this.cleanupDictationStream(msg.dictationId);
  }

  /**
   * Handle on-demand agent initialization request from client
   */
  private async handleInitializeAgentRequest(
    agentId: string,
    requestId: string
  ): Promise<void> {
    this.sessionLogger.info(
      { agentId },
      `Initializing agent ${agentId} on demand`
    );

    try {
      const snapshot = await this.ensureAgentLoaded(agentId);
      await this.forwardAgentState(snapshot);

      // Send timeline snapshot after hydration (if any)
      const timelineSize = this.emitAgentTimelineSnapshot(snapshot);

      this.emit({
        type: "initialize_agent_request",
        payload: {
          agentId,
          agentStatus: snapshot.lifecycle,
          timelineSize,
          requestId,
        },
      });

      this.sessionLogger.info(
        { agentId, timelineSize, status: snapshot.lifecycle },
        `Agent ${agentId} initialized with ${timelineSize} timeline item(s); status=${snapshot.lifecycle}`
      );
    } catch (error: any) {
      this.sessionLogger.error(
        { err: error, agentId },
        `Failed to initialize agent ${agentId}`
      );
      this.emit({
        type: "initialize_agent_request",
        payload: {
          agentId,
          requestId,
          error: error?.message ?? "Failed to initialize agent",
        },
      });
    }
  }

  /**
   * Handle create agent request
   */
  private async handleCreateAgentRequest(
    msg: Extract<SessionInboundMessage, { type: "create_agent_request" }>
  ): Promise<void> {
    const { config, worktreeName, requestId, initialPrompt, git, images } = msg;
    this.sessionLogger.info(
      { cwd: config.cwd, provider: config.provider, worktreeName },
      `Creating agent in ${config.cwd} (${config.provider})${
        worktreeName ? ` with worktree ${worktreeName}` : ""
      }`
    );

    try {
      // Validate that the working directory exists
      const resolvedCwd = expandTilde(config.cwd);
      try {
        const stats = await stat(resolvedCwd);
        if (!stats.isDirectory()) {
          throw new Error(
            `Working directory is not a directory: ${config.cwd}`
          );
        }
      } catch (statError: any) {
        if (statError.code === "ENOENT") {
          throw new Error(
            `Working directory does not exist: ${config.cwd}`
          );
        }
        throw statError;
      }

      const { sessionConfig, worktreeConfig } = await this.buildAgentSessionConfig(
        config,
        git,
        worktreeName
      );
      const snapshot = await this.agentManager.createAgent(sessionConfig);
      await this.forwardAgentState(snapshot);

      const trimmedPrompt = initialPrompt?.trim();
      if (trimmedPrompt) {
        try {
          const initialPromptWithInstructions = injectLeadingPaseoInstructionTag(
            trimmedPrompt,
            snapshot.config.paseoPromptInstructions
          );
          await this.handleSendAgentMessage(
            snapshot.id,
            initialPromptWithInstructions,
            uuidv4(),
            images
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
        this.emit({
          type: "status",
          payload: {
            status: "agent_created",
            agentId: snapshot.id,
            requestId,
          },
        });
      }

      if (worktreeConfig) {
        void this.runAsyncWorktreeSetup(snapshot.id, worktreeConfig);
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
      const snapshot = await this.agentManager.resumeAgent(
        handle,
        overrides
      );
      await this.agentManager.primeAgentHistory(snapshot.id);
      await this.forwardAgentState(snapshot);
      const timelineSize = this.emitAgentTimelineSnapshot(snapshot);
      if (requestId) {
        this.emit({
          type: "status",
          payload: {
            status: "agent_resumed",
            agentId: snapshot.id,
            requestId,
            timelineSize,
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
          snapshot = await this.agentManager.refreshAgentFromPersistence(
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
        snapshot = await this.agentManager.resumeAgent(
          handle,
          buildConfigOverrides(record),
          agentId
        );
      }
      await this.agentManager.primeAgentHistory(agentId);
      await this.forwardAgentState(snapshot);
      const timelineSize = this.emitAgentTimelineSnapshot(snapshot);
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
    legacyWorktreeName?: string
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

      const createdWorktree = await createWorktree({
        branchName: targetBranch,
        cwd,
        baseBranch: normalized.baseBranch!,
        worktreeSlug: normalized.worktreeSlug ?? targetBranch,
        runSetup: false,
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

  private async runAsyncWorktreeSetup(
    agentId: string,
    worktree: WorktreeConfig
  ): Promise<void> {
    const callId = uuidv4();
    let results: WorktreeSetupCommandResult[] = [];
    try {
      const started = await this.safeAppendTimelineItem(agentId, {
        type: "tool_call",
        name: "paseo_worktree_setup",
        callId,
        status: "running",
        input: {
          repoRoot: worktree.repoPath,
          worktreePath: worktree.worktreePath,
          branchName: worktree.branchName,
        },
      });
      if (!started) {
        return;
      }

      results = await runWorktreeSetupCommands({
        repoRoot: worktree.repoPath,
        worktreePath: worktree.worktreePath,
        branchName: worktree.branchName,
        cleanupOnFailure: false,
      });

      await this.safeAppendTimelineItem(agentId, {
        type: "tool_call",
        name: "paseo_worktree_setup",
        callId,
        status: "completed",
        output: {
          worktreePath: worktree.worktreePath,
          commands: results.map((result) => ({
            command: result.command,
            cwd: result.cwd,
            exitCode: result.exitCode,
            output: `${result.stdout ?? ""}${result.stderr ? `\n${result.stderr}` : ""}`.trim(),
          })),
        },
      });
    } catch (error: any) {
      if (error instanceof WorktreeSetupError) {
        results = error.results;
      }
      const message = error instanceof Error ? error.message : String(error);
      await this.safeAppendTimelineItem(agentId, {
        type: "tool_call",
        name: "paseo_worktree_setup",
        callId,
        status: "failed",
        output: {
          worktreePath: worktree.worktreePath,
          commands: results.map((result) => ({
            command: result.command,
            cwd: result.cwd,
            exitCode: result.exitCode,
            output: `${result.stdout ?? ""}${result.stderr ? `\n${result.stderr}` : ""}`.trim(),
          })),
        },
        error: { message },
      });
    }
  }

  private async safeAppendTimelineItem(
    agentId: string,
    item: AgentTimelineItem
  ): Promise<boolean> {
    try {
      await this.agentManager.appendTimelineItem(agentId, item);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Unknown agent")) {
        return false;
      }
      throw error;
    }
  }

  private async handleGitRepoInfoRequest(
    msg: Extract<SessionInboundMessage, { type: "git_repo_info_request" }>
  ): Promise<void> {
    const { cwd, requestId } = msg;
    const resolvedCwd = expandTilde(cwd);

    try {
      const status = await getCheckoutStatus(resolvedCwd);
      if (!status.isGit) {
        throw new NotGitRepoError(resolvedCwd);
      }
      const repoRoot = status.repoRoot ?? resolvedCwd;
      const { stdout: branchesRaw } = await execAsync(
        "git branch --format='%(refname:short)'",
        { cwd: repoRoot, env: READ_ONLY_GIT_ENV }
      );
      const currentBranch = status.currentBranch ?? "";
      const branches = branchesRaw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((name) => ({
          name,
          isCurrent: name === currentBranch,
        }));

      const isDirty = status.isDirty ?? false;

      this.emit({
        type: "git_repo_info_response",
        payload: {
          cwd: resolvedCwd,
          repoRoot,
          requestId,
          branches,
          currentBranch: currentBranch || null,
          isDirty,
          error: null,
        },
      });
    } catch (error) {
      this.emit({
        type: "git_repo_info_response",
        payload: {
          cwd,
          repoRoot: cwd,
          requestId,
          error: (error as Error)?.message ?? String(error),
        },
      });
    }
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

  private buildEphemeralAgentConfig(agent: ManagedAgent, title: string): AgentSessionConfig {
    return {
      ...agent.config,
      cwd: agent.cwd,
      title,
      parentAgentId: agent.id,
      internal: true,
    };
  }

  private async generateCommitMessage(agent: ManagedAgent): Promise<string> {
    const diff = await getCheckoutDiff(agent.cwd, { mode: "uncommitted" });
    const schema = z.object({
      message: z
        .string()
        .min(1)
        .max(72)
        .describe("Concise git commit message, imperative mood, no trailing period."),
    });
    const prompt = [
      "Write a concise git commit message for the changes below.",
      "Return JSON only with a single field 'message'.",
      "",
      diff.diff.length > 0 ? diff.diff : "(No diff available)",
    ].join("\n");
    try {
      const result = await generateStructuredAgentResponse({
        manager: this.agentManager,
        agentConfig: this.buildEphemeralAgentConfig(agent, "Commit generator"),
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

  private async generatePullRequestText(agent: ManagedAgent, baseRef?: string): Promise<{
    title: string;
    body: string;
  }> {
    const diff = await getCheckoutDiff(agent.cwd, {
      mode: "base",
      baseRef,
    });
    const schema = z.object({
      title: z.string().min(1).max(72),
      body: z.string().min(1),
    });
    const prompt = [
      "Write a pull request title and body for the changes below.",
      "Return JSON only with fields 'title' and 'body'.",
      "",
      diff.diff.length > 0 ? diff.diff : "(No diff available)",
    ].join("\n");
    try {
      return await generateStructuredAgentResponse({
        manager: this.agentManager,
        agentConfig: this.buildEphemeralAgentConfig(agent, "PR generator"),
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
  private async handleSetAgentMode(
    agentId: string,
    modeId: string
  ): Promise<void> {
    this.sessionLogger.info(
      { agentId, modeId },
      `Setting agent ${agentId} mode to ${modeId}`
    );

    try {
      await this.agentManager.setAgentMode(agentId, modeId);
      this.sessionLogger.info(
        { agentId, modeId },
        `Agent ${agentId} mode set to ${modeId}`
      );
    } catch (error: any) {
      this.sessionLogger.error(
        { err: error, agentId, modeId },
        "Failed to set agent mode"
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
      throw error;
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
  }): void {
    this.sessionLogger.debug({ heartbeat: msg }, "Client heartbeat");
    this.clientActivity = {
      deviceType: msg.deviceType,
      focusedAgentId: msg.focusedAgentId,
      lastActivityAt: new Date(msg.lastActivityAt),
      appVisible: msg.appVisible,
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

  /**
   * Handle git diff request for an agent
   */
  private async handleGitDiffRequest(agentId: string, requestId: string): Promise<void> {
    this.sessionLogger.debug(
      { agentId },
      `Handling git diff request for agent ${agentId}`
    );

    try {
      const agents = this.agentManager.listAgents();
      const agent = agents.find((a) => a.id === agentId);

      if (!agent) {
        this.emit({
          type: "git_diff_response",
          payload: {
            agentId,
            diff: "",
            error: `Agent not found: ${agentId}`,
            requestId,
          },
        });
        return;
      }

      const diffResult = await getCheckoutDiff(agent.cwd, { mode: "uncommitted" });
      const combinedDiff = diffResult.diff;

      this.emit({
        type: "git_diff_response",
        payload: {
          agentId,
          diff: combinedDiff,
          error: null,
          requestId,
        },
      });

      this.sessionLogger.debug(
        { agentId, diffBytes: combinedDiff.length },
        `Git diff for agent ${agentId} completed (${combinedDiff.length} bytes)`
      );
    } catch (error: any) {
      this.sessionLogger.error(
        { err: error, agentId },
        `Failed to get git diff for agent ${agentId}`
      );
      this.emit({
        type: "git_diff_response",
        payload: {
          agentId,
          diff: "",
          error: error.message,
          requestId,
        },
      });
    }
  }

  private async handleCheckoutStatusRequest(
    msg: Extract<SessionInboundMessage, { type: "checkout_status_request" }>
  ): Promise<void> {
    const { agentId, requestId } = msg;
    const agent = this.agentManager.getAgent(agentId);
    if (!agent) {
      this.emit({
        type: "checkout_status_response",
        payload: {
          agentId,
          cwd: "",
          isGit: false,
          repoRoot: null,
          currentBranch: null,
          isDirty: null,
          baseRef: null,
          aheadBehind: null,
          isPaseoOwnedWorktree: false,
          error: { code: "UNKNOWN", message: `Agent not found: ${agentId}` },
          requestId,
        },
      });
      return;
    }

    try {
      const status = await getCheckoutStatus(agent.cwd);
      if (!status.isGit) {
        this.emit({
          type: "checkout_status_response",
          payload: {
            agentId,
            cwd: agent.cwd,
            isGit: false,
            repoRoot: null,
            currentBranch: null,
            isDirty: null,
            baseRef: null,
            aheadBehind: null,
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
            agentId,
            cwd: agent.cwd,
            isGit: true,
            repoRoot: status.repoRoot ?? null,
            currentBranch: status.currentBranch ?? null,
            isDirty: status.isDirty ?? null,
            baseRef: status.baseRef,
            aheadBehind: status.aheadBehind ?? null,
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
          agentId,
          cwd: agent.cwd,
          isGit: true,
          repoRoot: status.repoRoot ?? null,
          currentBranch: status.currentBranch ?? null,
          isDirty: status.isDirty ?? null,
          baseRef: status.baseRef ?? null,
          aheadBehind: status.aheadBehind ?? null,
          isPaseoOwnedWorktree: false,
          error: null,
          requestId,
        },
      });
    } catch (error) {
      this.emit({
        type: "checkout_status_response",
        payload: {
          agentId,
          cwd: agent.cwd,
          isGit: false,
          repoRoot: null,
          currentBranch: null,
          isDirty: null,
          baseRef: null,
          aheadBehind: null,
          isPaseoOwnedWorktree: false,
          error: this.toCheckoutError(error),
          requestId,
        },
      });
    }
  }

  private async handleCheckoutDiffRequest(
    msg: Extract<SessionInboundMessage, { type: "checkout_diff_request" }>
  ): Promise<void> {
    const { agentId, requestId, compare } = msg;
    const agent = this.agentManager.getAgent(agentId);
    if (!agent) {
      this.emit({
        type: "checkout_diff_response",
        payload: {
          agentId,
          files: [],
          error: { code: "UNKNOWN", message: `Agent not found: ${agentId}` },
          requestId,
        },
      });
      return;
    }

    try {
      const diffResult = await getCheckoutDiff(agent.cwd, {
        mode: compare.mode,
        baseRef: compare.baseRef,
        includeStructured: true,
      });
      this.emit({
        type: "checkout_diff_response",
        payload: {
          agentId,
          files: diffResult.structured ?? [],
          error: null,
          requestId,
        },
      });
    } catch (error) {
      this.emit({
        type: "checkout_diff_response",
        payload: {
          agentId,
          files: [],
          error: this.toCheckoutError(error),
          requestId,
        },
      });
    }
  }

  private async handleCheckoutCommitRequest(
    msg: Extract<SessionInboundMessage, { type: "checkout_commit_request" }>
  ): Promise<void> {
    const { agentId, requestId } = msg;
    const agent = this.agentManager.getAgent(agentId);
    if (!agent) {
      this.emit({
        type: "checkout_commit_response",
        payload: {
          agentId,
          success: false,
          error: { code: "UNKNOWN", message: `Agent not found: ${agentId}` },
          requestId,
        },
      });
      return;
    }

    try {
      let message = msg.message?.trim() ?? "";
      if (!message) {
        message = await this.generateCommitMessage(agent);
      }
      if (!message) {
        throw new Error("Commit message is required");
      }

      await commitChanges(agent.cwd, {
        message,
        addAll: msg.addAll ?? true,
      });

      this.emit({
        type: "checkout_commit_response",
        payload: {
          agentId,
          success: true,
          error: null,
          requestId,
        },
      });
    } catch (error) {
      this.emit({
        type: "checkout_commit_response",
        payload: {
          agentId,
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
    const { agentId, requestId } = msg;
    const agent = this.agentManager.getAgent(agentId);
    if (!agent) {
      this.emit({
        type: "checkout_merge_response",
        payload: {
          agentId,
          success: false,
          error: { code: "UNKNOWN", message: `Agent not found: ${agentId}` },
          requestId,
        },
      });
      return;
    }

    try {
      const status = await getCheckoutStatus(agent.cwd);
      if (!status.isGit) {
        // `getCheckoutStatus` can return `isGit=false` in transient situations (e.g. cwd lookup
        // running during other git operations). Double-check with git directly before failing.
        try {
          await execAsync("git rev-parse --is-inside-work-tree", {
            cwd: agent.cwd,
            env: READ_ONLY_GIT_ENV,
          });
        } catch (error) {
          const details =
            typeof (error as any)?.stderr === "string"
              ? String((error as any).stderr).trim()
              : error instanceof Error
                ? error.message
                : String(error);
          throw new Error(`Not a git repository: ${agent.cwd}\n${details}`.trim());
        }
      }

      if (msg.requireCleanTarget) {
        const { stdout } = await execAsync("git status --porcelain", {
          cwd: agent.cwd,
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

      await mergeToBase(agent.cwd, {
        baseRef,
        mode: msg.strategy === "squash" ? "squash" : "merge",
      });

      this.emit({
        type: "checkout_merge_response",
        payload: {
          agentId,
          success: true,
          error: null,
          requestId,
        },
      });
    } catch (error) {
      this.emit({
        type: "checkout_merge_response",
        payload: {
          agentId,
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
    const { agentId, requestId } = msg;
    const agent = this.agentManager.getAgent(agentId);
    if (!agent) {
      this.emit({
        type: "checkout_pr_create_response",
        payload: {
          agentId,
          url: null,
          number: null,
          error: { code: "UNKNOWN", message: `Agent not found: ${agentId}` },
          requestId,
        },
      });
      return;
    }

    try {
      let title = msg.title?.trim() ?? "";
      let body = msg.body?.trim() ?? "";
      if (!title || !body) {
        const generated = await this.generatePullRequestText(agent, msg.baseRef);
        if (!title) {
          title = generated.title;
        }
        if (!body) {
          body = generated.body;
        }
      }
      if (!title) {
        throw new Error("Pull request title is required");
      }

      const result = await createPullRequest(agent.cwd, {
        title,
        body,
        base: msg.baseRef,
      });

      this.emit({
        type: "checkout_pr_create_response",
        payload: {
          agentId,
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
          agentId,
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
    const { agentId, requestId } = msg;
    const agent = this.agentManager.getAgent(agentId);
    if (!agent) {
      this.emit({
        type: "checkout_pr_status_response",
        payload: {
          agentId,
          status: null,
          error: { code: "UNKNOWN", message: `Agent not found: ${agentId}` },
          requestId,
        },
      });
      return;
    }

    try {
      const status = await getPullRequestStatus(agent.cwd);
      this.emit({
        type: "checkout_pr_status_response",
        payload: {
          agentId,
          status,
          error: null,
          requestId,
        },
      });
    } catch (error) {
      this.emit({
        type: "checkout_pr_status_response",
        payload: {
          agentId,
          status: null,
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
      const worktrees = await listPaseoWorktrees({ cwd });
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
        const worktrees = await listPaseoWorktrees({ cwd: repoRoot });
        const match = worktrees.find((entry) => entry.branchName === msg.branchName);
        if (!match) {
          throw new Error(`Paseo worktree not found for branch ${msg.branchName}`);
        }
        targetPath = match.path;
      }

      const ownership = await isPaseoOwnedWorktreeCwd(targetPath);
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

      await deletePaseoWorktree({
        cwd: repoRoot,
        worktreePath: targetPath,
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
   * Handle highlighted diff request - returns parsed and syntax-highlighted diff
   */
  private async handleHighlightedDiffRequest(
    agentId: string,
    requestId: string
  ): Promise<void> {
    this.sessionLogger.debug(
      { agentId },
      `Handling highlighted diff request for agent ${agentId}`
    );

    // Maximum lines changed before we skip showing the diff content
    const MAX_DIFF_LINES = 5000;

    try {
      const agents = this.agentManager.listAgents();
      const agent = agents.find((a) => a.id === agentId);

      if (!agent) {
        this.emit({
          type: "highlighted_diff_response",
          payload: {
            agentId,
            files: [],
            error: `Agent not found: ${agentId}`,
            requestId,
          },
        });
        return;
      }

      // Step 1: Get the list of changed files with their stats (numstat gives additions/deletions per file)
      const { stdout: numstatOutput } = await execAsync(
        "git diff --numstat HEAD",
        { cwd: agent.cwd }
      );

      // Get file statuses (A=added, D=deleted, M=modified) to detect deleted files
      const { stdout: nameStatusOutput } = await execAsync(
        "git diff --name-status HEAD",
        { cwd: agent.cwd }
      );
      const deletedFiles = new Set<string>();
      const addedFiles = new Set<string>();
      for (const line of nameStatusOutput.trim().split("\n").filter(Boolean)) {
        const [status, ...pathParts] = line.split("\t");
        const path = pathParts.join("\t");
        if (status === "D") {
          deletedFiles.add(path);
        } else if (status === "A") {
          addedFiles.add(path);
        }
      }

      // Parse numstat output: "additions\tdeletions\tfilepath" or "-\t-\tfilepath" for binary
      interface FileStats {
        path: string;
        additions: number;
        deletions: number;
        isBinary: boolean;
        isTracked: boolean;
        isDeleted: boolean;
        isNew: boolean;
      }
      const fileStats: FileStats[] = [];

      for (const line of numstatOutput.trim().split("\n").filter(Boolean)) {
        const parts = line.split("\t");
        if (parts.length >= 3) {
          const [addStr, delStr, ...pathParts] = parts;
          const path = pathParts.join("\t"); // Handle paths with tabs
          const isBinary = addStr === "-" && delStr === "-";
          fileStats.push({
            path,
            additions: isBinary ? 0 : parseInt(addStr, 10),
            deletions: isBinary ? 0 : parseInt(delStr, 10),
            isBinary,
            isTracked: true,
            isDeleted: deletedFiles.has(path),
            isNew: addedFiles.has(path),
          });
        }
      }

      // Step 2: Get untracked files
      try {
        const { stdout: untrackedFiles } = await execAsync(
          "git ls-files --others --exclude-standard",
          { cwd: agent.cwd }
        );
        for (const filePath of untrackedFiles.trim().split("\n").filter(Boolean)) {
          // Use git's numstat with --no-index to detect binary files (cross-platform)
          // Binary files show as "-\t-\tfilepath", text files show line counts
          try {
            const { stdout: numstatLine } = await execAsync(
              `git diff --numstat --no-index /dev/null "${filePath}" || true`,
              { cwd: agent.cwd }
            );
            const parts = numstatLine.trim().split("\t");
            const isBinary = parts[0] === "-" && parts[1] === "-";
            const additions = isBinary ? 0 : (parseInt(parts[0], 10) || 0);

            fileStats.push({
              path: filePath,
              additions,
              deletions: 0,
              isBinary,
              isTracked: false,
              isDeleted: false,
              isNew: true,
            });
          } catch {
            // If we can't determine, assume text and try to get it
            fileStats.push({
              path: filePath,
              additions: 0,
              deletions: 0,
              isBinary: false,
              isTracked: false,
              isDeleted: false,
              isNew: true,
            });
          }
        }
      } catch {
        // Ignore errors getting untracked files
      }

      // Step 3: Fetch diffs per-file, respecting limits
      const allFiles: ParsedDiffFile[] = [];

      for (const stats of fileStats) {
        const totalLines = stats.additions + stats.deletions;

        // Handle binary files
        if (stats.isBinary) {
          allFiles.push({
            path: stats.path,
            isNew: stats.isNew,
            isDeleted: stats.isDeleted,
            additions: 0,
            deletions: 0,
            hunks: [],
            status: "binary",
          });
          continue;
        }

        // Handle files that are too large
        if (totalLines > MAX_DIFF_LINES) {
          allFiles.push({
            path: stats.path,
            isNew: stats.isNew,
            isDeleted: stats.isDeleted,
            additions: stats.additions,
            deletions: stats.deletions,
            hunks: [],
            status: "too_large",
          });
          continue;
        }

        // Fetch the actual diff for this file
        try {
          let fileDiff: string;
          if (stats.isTracked) {
            const { stdout } = await execAsync(
              `git diff HEAD -- "${stats.path}"`,
              { cwd: agent.cwd }
            );
            fileDiff = stdout;
          } else {
            const { stdout } = await execAsync(
              `git diff --no-index /dev/null "${stats.path}" || true`,
              { cwd: agent.cwd }
            );
            fileDiff = stdout;
          }

          if (fileDiff) {
            const parsedFiles = await parseAndHighlightDiff(fileDiff, agent.cwd);
            for (const file of parsedFiles) {
              allFiles.push({ ...file, status: "ok" });
            }
          }
        } catch {
          // If diff fails for this file, add it with empty hunks
          allFiles.push({
            path: stats.path,
            isNew: stats.isNew,
            isDeleted: stats.isDeleted,
            additions: stats.additions,
            deletions: stats.deletions,
            hunks: [],
            status: "ok",
          });
        }
      }

      this.emit({
        type: "highlighted_diff_response",
        payload: {
          agentId,
          files: allFiles,
          error: null,
          requestId,
        },
      });

      this.sessionLogger.debug(
        { agentId, fileCount: allFiles.length },
        `Highlighted diff for agent ${agentId} completed (${allFiles.length} files)`
      );
    } catch (error: any) {
      this.sessionLogger.error(
        { err: error, agentId },
        `Failed to get highlighted diff for agent ${agentId}`
      );
      this.emit({
        type: "highlighted_diff_response",
        payload: {
          agentId,
          files: [],
          error: error.message,
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
   * Send current session state (live agents and commands) to client
   */
  private async sendSessionState(): Promise<void> {
    try {
      // Get live agents with session modes
      const agentSnapshots = this.agentManager.listAgents();
      const liveAgents = await Promise.all(
        agentSnapshots.map((agent) => this.buildAgentPayload(agent))
      );

      // Add persisted agents that have not been lazily initialized yet
      const registryRecords = await this.agentStorage.list();
      const liveIds = new Set(agentSnapshots.map((a) => a.id));
      const persistedAgents = registryRecords
        .filter((record) => !liveIds.has(record.id))
        .map((record) => this.buildStoredAgentPayload(record));

      const agents = [...liveAgents, ...persistedAgents];

      // Emit session state
      this.emit({
        type: "session_state",
        payload: {
          agents,
        },
      });

      this.sessionLogger.debug(
        { agentCount: agents.length },
        `Sent session state: ${agents.length} agents`
      );
    } catch (error) {
      this.sessionLogger.error(
        { err: error },
        "Failed to send session state"
      );
    }
  }

  private emitAgentTimelineSnapshot(agent: ManagedAgent): number {
    const timeline = this.agentManager.getTimeline(agent.id);
    const events = timeline.map((item) => ({
      event: serializeAgentStreamEvent({
        type: "timeline",
        provider: agent.provider,
        item,
      }),
      timestamp: new Date().toISOString(),
    }));

    this.emit({
      type: "agent_stream_snapshot",
      payload: { agentId: agent.id, events },
    });

    return timeline.length;
  }

  /**
   * Handle text message from user
   */
  private async handleUserText(text: string): Promise<void> {
    // Abort any in-progress stream immediately
    this.createAbortController();

    // Wait for aborted stream to finish cleanup (save partial response)
    if (this.currentStreamPromise) {
      this.sessionLogger.debug("Waiting for aborted stream to finish cleanup");
      await this.currentStreamPromise;
      this.sessionLogger.debug("Aborted stream finished cleanup");
    }

    // Emit user message activity log
    this.emit({
      type: "activity_log",
      payload: {
        id: uuidv4(),
        timestamp: new Date(),
        type: "transcript",
        content: text,
      },
    });

    // Add to conversation
    this.messages.push({ role: "user", content: text });

    // Process through LLM (TTS enabled in realtime mode for voice conversations)
    this.currentStreamPromise = this.processWithLLM(this.isRealtimeMode);
    await this.currentStreamPromise;
  }

  /**
   * Handle audio chunk for buffering and transcription
   */
  private async handleAudioChunk(
    msg: Extract<SessionInboundMessage, { type: "realtime_audio_chunk" }>
  ): Promise<void> {
    await this.handleRealtimeSpeechStart();

    const chunkBuffer = Buffer.from(msg.audio, "base64");
    const chunkFormat = msg.format || "audio/wav";
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

    this.sessionLogger.debug(
      { bytes: chunkBuffer.length, chunks: this.audioBuffer.chunks.length, pcmBytes: this.audioBuffer.totalPCMBytes },
      `Buffered audio chunk (${chunkBuffer.length} bytes, chunks: ${this.audioBuffer.chunks.length}${this.audioBuffer.isPCM ? `, PCM bytes: ${this.audioBuffer.totalPCMBytes}` : ""})`
    );

    // In realtime mode, only process audio when the user has finished speaking (isLast = true)
    // This prevents partial transcriptions from being sent to the LLM
    if (this.isRealtimeMode) {
      if (!msg.isLast) {
        this.sessionLogger.debug("Realtime mode: buffering audio, waiting for speech end");
        return;
      }
      this.sessionLogger.debug("Realtime mode: speech ended, processing complete audio");
    }

    // In non-realtime mode, use streaming threshold to process chunks
    const reachedStreamingThreshold =
      !this.isRealtimeMode &&
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
      const result = await this.sttManager.transcribe(audio, format, {
        label: this.isRealtimeMode ? "realtime" : "buffered",
      });

      const transcriptText = result.text.trim();
      if (!transcriptText) {
        this.sessionLogger.debug("Empty transcription (false positive), not aborting");
        this.setPhase("idle");
        this.clearSpeechInProgress("empty transcription");
        return;
      }

      // Has content - abort any in-progress stream now
      this.createAbortController();

      // Wait for aborted stream to finish cleanup (save partial response)
      if (this.currentStreamPromise) {
        this.sessionLogger.debug("Waiting for aborted stream to finish cleanup");
        await this.currentStreamPromise;
      }

      // Emit transcription result
      this.emit({
        type: "transcription_result",
        payload: {
          text: result.text,
          language: result.language,
          duration: result.duration,
          requestId: uuidv4(),
          avgLogprob: result.avgLogprob,
          isLowConfidence: result.isLowConfidence,
          byteLength: result.byteLength,
          format: result.format,
          debugRecordingPath: result.debugRecordingPath,
        },
      });

      // Emit activity log
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "transcript",
          content: result.text,
          metadata: {
            language: result.language,
            duration: result.duration,
          },
        },
      });

      // Add to conversation
      this.messages.push({ role: "user", content: result.text });

      // Set phase to LLM and process (TTS enabled in realtime mode for voice conversations)
      this.clearSpeechInProgress("transcription complete");
      this.setPhase("llm");
      this.currentStreamPromise = this.processWithLLM(this.isRealtimeMode);
      await this.currentStreamPromise;
      this.setPhase("idle");
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

  /**
   * Process user message through LLM with streaming and tool execution
   */
  private async processWithLLM(enableTTS: boolean): Promise<void> {
    let assistantResponse = "";
    let pendingTTS: Promise<void> | null = null;
    let textBuffer = "";
    let sawTextDelta = false;

    const flushTextBuffer = () => {
      if (textBuffer.length > 0) {
        // TTS handling (capture mode at generation time for drift protection)
        if (enableTTS && !this.speechInProgress) {
          const modeAtGeneration = this.isRealtimeMode;
          pendingTTS = this.ttsManager.generateAndWaitForPlayback(
            textBuffer,
            (msg) => this.emit(msg),
            this.abortController.signal,
            modeAtGeneration
          );
        } else if (enableTTS && this.speechInProgress) {
          this.sessionLogger.debug("Skipping TTS chunk while speech in progress");
        }

        // Emit activity log
        this.emit({
          type: "activity_log",
          payload: {
            id: uuidv4(),
            timestamp: new Date(),
            type: "assistant",
            content: textBuffer,
          },
        });
      }
      textBuffer = "";
    };

    try {
      // Debug: dump conversation before LLM call
      await this.dumpConversation();

      invariant(
        process.env.OPENROUTER_API_KEY,
        "OPENROUTER_API_KEY is required"
      );

      const openrouter = createOpenRouter({
        apiKey: process.env.OPENROUTER_API_KEY,
      });

      // Wait for agent MCP to initialize if needed
      if (!this.agentTools) {
        this.sessionLogger.debug("Waiting for agent MCP initialization...");
        const startTime = Date.now();
        while (!this.agentTools && Date.now() - startTime < 5000) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!this.agentTools) {
          this.sessionLogger.info("Agent MCP tools unavailable; continuing with default tool set");
        }
      }

      const allTools = getAllTools(this.agentTools ?? undefined);

      const result = await streamText({
        model: openrouter("anthropic/claude-haiku-4.5"),
        system: getSystemPrompt(),
        providerOptions: {
          openrouter: {
            transforms: ["middle-out"], // Compress prompts that are > context size.
          } as OpenRouterProviderOptions,
        },
        messages: this.messages,
        tools: allTools,
        abortSignal: this.abortController.signal,
        onFinish: async (event) => {
          const newMessages = event.response.messages;
          if (newMessages.length > 0) {
            this.messages.push(...newMessages);
            this.sessionLogger.debug(
              { messageCount: newMessages.length },
              `onFinish - saved message with ${newMessages.length} steps`
            );
          }

          // Persist voice conversation to disk (best-effort; voice-only)
          if (enableTTS && this.voiceConversationId) {
            try {
              await this.voiceConversationStore.save(
                this.sessionLogger,
                this.voiceConversationId,
                this.messages
              );
            } catch (error) {
              this.sessionLogger.warn(
                { err: error, voiceConversationId: this.voiceConversationId },
                "Failed to persist voice conversation"
              );
            }
          }
        },
        onChunk: async ({ chunk }) => {
          if (chunk.type === "text-delta") {
            sawTextDelta = true;
            // Accumulate text in buffer
            textBuffer += chunk.text;
            assistantResponse += chunk.text;

            // Emit chunk for UI streaming
            this.emit({
              type: "assistant_chunk",
              payload: { chunk: chunk.text },
            });
          } else if (chunk.type === "tool-call") {
            // Flush accumulated text as a segment before tool call
            flushTextBuffer();

            // Wait for pending TTS before executing tool
            if (pendingTTS) {
              this.sessionLogger.debug(
                { toolName: chunk.toolName },
                `Waiting for TTS before executing ${chunk.toolName}`
              );
              await pendingTTS;
            }

            // Handle present_artifact tool specially
            if (chunk.toolName === "present_artifact") {
              await this.handlePresentArtifact(
                chunk.toolCallId,
                chunk.input as PresentArtifactArgs
              );
            }

            // Emit tool call activity log
            this.emit({
              type: "activity_log",
              payload: {
                id: chunk.toolCallId,
                timestamp: new Date(),
                type: "tool_call",
                content: `Calling ${chunk.toolName}`,
                metadata: {
                  toolCallId: chunk.toolCallId,
                  toolName: chunk.toolName,
                  arguments: chunk.input,
                },
              },
            });
          } else if (chunk.type === "tool-result") {
            // Check if this is a create_agent result
            if (chunk.toolName === "create_agent" && chunk.output) {
              const result = chunk.output as any;
              if (result.structuredContent?.agentId) {
                const agentId = result.structuredContent.agentId;
                this.emit({
                  type: "status",
                  payload: {
                    status: "agent_created",
                    agentId,
                  },
                });
              }
            }

            // Emit tool result event
            this.emit({
              type: "activity_log",
              payload: {
                id: chunk.toolCallId,
                timestamp: new Date(),
                type: "tool_result",
                content: `Tool ${chunk.toolName} completed`,
                metadata: {
                  toolCallId: chunk.toolCallId,
                  toolName: chunk.toolName,
                  result: chunk.output,
                },
              },
            });
          }
        },
        onError: async (error) => {
          this.sessionLogger.error({ err: error }, "Stream error");

          this.emit({
            type: "activity_log",
            payload: {
              id: uuidv4(),
              timestamp: new Date(),
              type: "error",
              content: `Stream error: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          });
        },
        stopWhen: stepCountIs(10),
      });

      // Consume the fullStream to handle tool-error chunks
      for await (const part of result.fullStream) {
        if (part.type === "tool-error") {
          this.emit({
            type: "activity_log",
            payload: {
              id: part.toolCallId,
              timestamp: new Date(),
              type: "error",
              content: `Tool ${part.toolName} failed: ${
                part.error instanceof Error
                  ? part.error.message
                  : String(part.error)
              }`,
              metadata: {
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                error: part.error,
              },
            },
          });
        }
      }

      if (!sawTextDelta) {
        let fallbackText = "";
        try {
          fallbackText = (await result.text).trim();
        } catch {
          fallbackText = "";
        }
        if (fallbackText.length > 0) {
          textBuffer += fallbackText;
          assistantResponse += fallbackText;
          this.emit({
            type: "assistant_chunk",
            payload: { chunk: fallbackText },
          });
        }
      }

      // Flush any remaining text at the end
      flushTextBuffer();

      // Note: Message is saved by onFinish callback with proper tool calls

      // Now wait for any pending TTS, but don't fail if it times out
      if (pendingTTS) {
        try {
          await pendingTTS;
        } catch (ttsError) {
          this.sessionLogger.error(
            { err: ttsError },
            "TTS playback failed (message already saved)"
          );
        }
      }
    } catch (error) {
      // Note: Partial messages are saved by onAbort callback with proper tool calls

      // Check if this is an abort error
      const isAbortError =
        error instanceof Error && error.name === "AbortError";

      // Only emit error log for non-abort errors
      if (!isAbortError) {
        this.emit({
          type: "activity_log",
          payload: {
            id: uuidv4(),
            timestamp: new Date(),
            type: "error",
            content: `Error: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        });
      }

      // Don't re-throw abort errors (they're expected during interruptions)
      if (isAbortError) {
        this.sessionLogger.debug("Stream aborted (partial response saved)");
        return;
      }

      // Re-throw unexpected errors
      throw error;
    } finally {
      // Increment turn index for next LLM call
      this.turnIndex++;

      // Clear the stream promise tracker
      this.currentStreamPromise = null;
    }
  }

  /**
   * Handle present_artifact tool execution
   */
  private async handlePresentArtifact(
    toolCallId: string,
    args: PresentArtifactArgs
  ): Promise<void> {
    let content: string;
    let isBase64 = false;

    try {
      if (args.source.type === "file") {
        const fileBuffer = await readFile(args.source.path);
        content = fileBuffer.toString("base64");
        isBase64 = true;
      } else if (args.source.type === "command_output") {
        const { stdout } = await execAsync(args.source.command, {
          encoding: "buffer",
        });
        content = stdout.toString("base64");
        isBase64 = true;
      } else if (args.source.type === "text") {
        content = args.source.text;
        isBase64 = false;
      } else {
        content = "[Unknown source type]";
        isBase64 = false;
      }
    } catch (error) {
      this.sessionLogger.error(
        { err: error },
        "Failed to resolve artifact source"
      );
      content = `[Error: ${
        error instanceof Error ? error.message : String(error)
      }]`;
      isBase64 = false;
    }

    // Emit artifact message
    this.emit({
      type: "artifact",
      payload: {
        type: args.type,
        id: toolCallId,
        title: args.title,
        content,
        isBase64,
      },
    });

    // Emit activity log for artifact
    this.emit({
      type: "activity_log",
      payload: {
        id: toolCallId,
        timestamp: new Date(),
        type: "system",
        content: `${args.type} artifact: ${args.title}`,
        metadata: { artifactId: toolCallId, artifactType: args.type },
      },
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

    if (this.processingPhase === "llm") {
      // Already in LLM phase - abort and wait for cleanup
      this.abortController.abort();
      this.sessionLogger.debug("Aborted LLM processing");

      // Wait for stream to finish saving partial response
      if (this.currentStreamPromise) {
        this.sessionLogger.debug("Waiting for stream cleanup after abort");
        await this.currentStreamPromise;
      }

      // Reset phase to idle
      this.setPhase("idle");

      // Clear any pending segments and timeouts
      this.pendingAudioSegments = [];
      this.clearBufferTimeout();
    } else if (this.processingPhase === "transcribing") {
      // Still in STT phase - we'll buffer the next audio
      this.sessionLogger.debug("Will buffer next audio (currently transcribing)");
      // Phase stays as 'transcribing', handleAudioChunk will handle buffering
    }
    // If idle, nothing to do
  }

  /**
   * Handle audio playback confirmation from client
   */
  private handleAudioPlayed(id: string): void {
    this.ttsManager.confirmAudioPlayed(id);
  }

  /**
   * Mark speech detection start and abort any active playback/LLM
   */
  private async handleRealtimeSpeechStart(): Promise<void> {
    if (this.speechInProgress) {
      return;
    }

    const chunkReceivedAt = Date.now();
    const phaseBeforeAbort = this.processingPhase;
    const hadActiveStream = Boolean(this.currentStreamPromise);

    this.speechInProgress = true;
    this.sessionLogger.debug("Realtime speech chunk detected – aborting playback and LLM");
    this.ttsManager.cancelPendingPlaybacks("realtime speech detected");

    if (this.pendingAudioSegments.length > 0) {
      this.sessionLogger.debug(
        { segmentCount: this.pendingAudioSegments.length },
        `Dropping ${this.pendingAudioSegments.length} buffered audio segment(s) due to realtime speech`
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
    this.onMessage(msg);
  }

  /**
   * Debug helper: dump conversation to disk
   */
  private async dumpConversation(): Promise<void> {
    try {
      const dumpDir = join(process.cwd(), ".debug.conversations");
      await mkdir(dumpDir, { recursive: true });

      const filename = `${this.voiceConversationId ?? this.sessionId}-${this.turnIndex}.json`;
      const filepath = join(dumpDir, filename);

      const dump = {
        voiceConversationId: this.voiceConversationId,
        sessionId: this.sessionId,
        turnIndex: this.turnIndex,
        timestamp: new Date().toISOString(),
        messages: this.messages,
      };

      await writeFile(filepath, inspect(dump, { depth: null }), "utf-8");
      this.sessionLogger.debug(
        { filepath },
        `Dumped conversation to ${filepath}`
      );
    } catch (error) {
      this.sessionLogger.error(
        { err: error },
        "Failed to dump conversation"
      );
    }
  }

  /**
   * Clean up session resources
   */
  public async cleanup(): Promise<void> {
    this.sessionLogger.info("Cleaning up");

    if (this.unsubscribeAgentEvents) {
      this.unsubscribeAgentEvents();
      this.unsubscribeAgentEvents = null;
    }

    // Abort any ongoing operations
    this.abortController.abort();

    // Clear timeouts
    this.clearBufferTimeout();

    // Clear buffers
    this.pendingAudioSegments = [];
    this.audioBuffer = null;

    // Cleanup managers
    this.ttsManager.cleanup();
    this.sttManager.cleanup();

    for (const dictationId of this.dictationStreams.keys()) {
      this.cleanupDictationStream(dictationId);
    }

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

    // Unsubscribe from all terminals
    for (const unsubscribe of this.terminalSubscriptions.values()) {
      unsubscribe();
    }
    this.terminalSubscriptions.clear();
  }

  // ============================================================================
  // Terminal Handlers
  // ============================================================================

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

    session.send(msg.message);
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

    // Unsubscribe first
    const unsubscribe = this.terminalSubscriptions.get(msg.terminalId);
    if (unsubscribe) {
      unsubscribe();
      this.terminalSubscriptions.delete(msg.terminalId);
    }

    this.terminalManager.killTerminal(msg.terminalId);
    this.emit({
      type: "kill_terminal_response",
      payload: {
        terminalId: msg.terminalId,
        success: true,
        requestId: msg.requestId,
      },
    });
  }
}
