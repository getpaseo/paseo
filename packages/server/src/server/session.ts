import { v4 as uuidv4 } from "uuid";
import { readFile, mkdir, writeFile } from "fs/promises";
import { exec } from "child_process";
import { promisify, inspect } from "util";
import { join } from "path";
import invariant from "tiny-invariant";
import { streamText, stepCountIs } from "ai";
import type { ToolSet } from "ai";
import type { ModelMessage } from "@ai-sdk/provider-utils";
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
  type GitSetupOptions,
} from "./messages.js";
import { getSystemPrompt } from "./agent/system-prompt.js";
import { getAllTools } from "./agent/llm-openai.js";
import { TTSManager } from "./agent/tts-manager.js";
import { STTManager } from "./agent/stt-manager.js";
import {
  saveConversation,
  listConversations,
  deleteConversation,
} from "./persistence.js";
import {
  buildConfigOverrides,
  buildSessionConfig,
} from "./persistence-hooks.js";
import { experimental_createMCPClient } from "ai";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTerminalMcpServer } from "./terminal-mcp/index.js";
import { fetchProviderModelCatalog } from "./agent/model-catalog.js";
import { AgentManager } from "./agent/agent-manager.js";
import type { ManagedAgent } from "./agent/agent-manager.js";
import { toAgentPayload } from "./agent/agent-projections.js";
import type {
  AgentPermissionResponse,
  AgentPromptInput,
  AgentSessionConfig,
  AgentStreamEvent,
  AgentProvider,
  AgentPersistenceHandle,
} from "./agent/agent-sdk-types.js";
import { AgentRegistry, type StoredAgentRecord } from "./agent/agent-registry.js";
import { expandTilde } from "./terminal-mcp/tmux.js";
import {
  listDirectoryEntries,
  readExplorerFile,
} from "./file-explorer/service.js";
import {
  generateAgentTitle,
  isTitleGeneratorInitialized,
} from "../services/agent-title-generator.js";
import type { TerminalManager } from "./terminal-mcp/terminal-manager.js";
import {
  createWorktree,
  detectRepoInfo,
  slugify,
  validateBranchSlug,
} from "../utils/worktree.js";

type AgentMcpClientConfig = {
  agentMcpUrl: string;
  agentMcpHeaders?: Record<string, string>;
};

const execAsync = promisify(exec);
const ACTIVE_TITLE_GENERATIONS = new Set<string>();
let restartRequested = false;
const KNOWN_AGENT_PROVIDERS: AgentProvider[] = ["claude", "codex"];
const RESTART_EXIT_DELAY_MS = 250;

type ProcessingPhase = "idle" | "transcribing" | "llm";

type NormalizedGitOptions = {
  baseBranch?: string;
  createNewBranch: boolean;
  newBranchName?: string;
  createWorktree: boolean;
  worktreeSlug?: string;
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
const SAFE_GIT_REF_PATTERN = /^[A-Za-z0-9._\/-]+$/;

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

function isKnownAgentProvider(value: string): value is AgentProvider {
  return KNOWN_AGENT_PROVIDERS.includes(value as AgentProvider);
}

function coerceAgentProvider(value: string, agentId?: string): AgentProvider {
  if (isKnownAgentProvider(value)) {
    return value;
  }
  console.warn(
    `[Session] Unknown provider '${value}' for agent ${agentId ?? "unknown"}; defaulting to 'claude'`
  );
  return "claude";
}

function toAgentPersistenceHandle(
  handle: StoredAgentRecord["persistence"]
): AgentPersistenceHandle | null {
  if (!handle) {
    return null;
  }
  const provider = handle.provider;
  if (!isKnownAgentProvider(provider)) {
    console.warn(
      `[Session] Ignoring persistence handle with unknown provider '${provider}'`
    );
    return null;
  }
  if (!handle.sessionId) {
    console.warn("[Session] Ignoring persistence handle missing sessionId");
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
  private readonly conversationId: string;
  private readonly onMessage: (msg: SessionOutboundMessage) => void;

  // State machine
  private abortController: AbortController;
  private processingPhase: ProcessingPhase = "idle";
  private currentStreamPromise: Promise<void> | null = null;

  // Realtime mode state
  private isRealtimeMode = false;
  private speechInProgress = false;

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
  private terminalMcpClient: Awaited<
    ReturnType<typeof experimental_createMCPClient>
  > | null = null;
  private terminalTools: ToolSet | null = null;
  private terminalManager: TerminalManager | null = null;
  private agentMcpClient: Awaited<
    ReturnType<typeof experimental_createMCPClient>
  > | null = null;
  private agentTools: ToolSet | null = null;
  private agentManager: AgentManager;
  private readonly agentRegistry: AgentRegistry;
  private readonly agentMcpConfig: AgentMcpClientConfig;
  private agentTitleCache: Map<string, string | null> = new Map();
  private unsubscribeAgentEvents: (() => void) | null = null;
  private pendingAgentInitializations: Map<
    string,
    Promise<ManagedAgent>
  > = new Map();

  constructor(
    clientId: string,
    onMessage: (msg: SessionOutboundMessage) => void,
    agentManager: AgentManager,
    agentRegistry: AgentRegistry,
    agentMcpConfig: AgentMcpClientConfig,
    options?: {
      conversationId?: string;
      initialMessages?: ModelMessage[];
    }
  ) {
    this.clientId = clientId;
    this.conversationId = options?.conversationId || uuidv4();
    this.onMessage = onMessage;
    this.agentManager = agentManager;
    this.agentRegistry = agentRegistry;
    this.agentMcpConfig = agentMcpConfig;
    this.abortController = new AbortController();

    // Initialize conversation history
    if (options?.initialMessages) {
      this.messages = options.initialMessages;
      console.log(
        `[Session ${this.clientId}] Restored conversation ${this.conversationId} with ${this.messages.length} messages`
      );
    }

    // Initialize per-session managers
    this.ttsManager = new TTSManager(this.conversationId);
    this.sttManager = new STTManager(this.conversationId);

    // Initialize terminal + agent MCP clients asynchronously
    void this.initializeTerminalMcp();
    void this.initializeAgentMcp();
    this.subscribeToAgentEvents();

    console.log(
      `[Session ${this.clientId}] Created with conversation ${this.conversationId}`
    );
  }

  /**
   * Get the conversation ID for this session
   */
  public getConversationId(): string {
    return this.conversationId;
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

    const attachmentSummary = images
      .map((image, index) => {
        const sizeKb = Math.round((image.data.length * 0.75) / 1024);
        return `Attachment ${index + 1}: ${image.mimeType}, ~${sizeKb}KB base64`;
      })
      .join("\n");

    const base = normalized.length > 0 ? normalized : "User shared image attachment(s).";
    return `${base}\n\n[Image attachments]\n${attachmentSummary}\n(Actual image bytes omitted; request a screenshot or file if needed.)`;
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

    if (snapshot.lifecycle !== "running") {
      return;
    }

    console.log(
      `[Session ${this.clientId}] Interrupting active run for agent ${agentId}`
    );

    try {
      const cancelled = await this.agentManager.cancelAgentRun(agentId);
      if (!cancelled) {
        console.warn(
          `[Session ${this.clientId}] Agent ${agentId} reported running but no active run was cancelled`
        );
      }
    } catch (error) {
      console.error(
        `[Session ${this.clientId}] Failed to interrupt agent ${agentId}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Start streaming an agent run and forward results via the websocket broadcast
   */
  private startAgentStream(agentId: string, prompt: AgentPromptInput): void {
    console.log(
      `[Session ${this.clientId}] Starting agent stream for ${agentId}`
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
    console.error(
      `[Session ${this.clientId}] ${context} for agent ${agentId}:`,
      error
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
   * Initialize Terminal MCP client for this session
   */
  private async initializeTerminalMcp(): Promise<void> {
    try {
      // Create Terminal Manager directly
      const { TerminalManager } = await import(
        "./terminal-mcp/terminal-manager.js"
      );
      this.terminalManager = new TerminalManager(this.conversationId);
      await this.terminalManager.initialize();

      // Create Terminal MCP server with conversation-specific session
      const server = await createTerminalMcpServer({
        sessionName: this.conversationId,
      });

      // Create linked transport pair
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();

      // Connect server to its transport
      await server.connect(serverTransport);

      // Create client connected to the other side
      this.terminalMcpClient = await experimental_createMCPClient({
        transport: clientTransport,
      });

      // Get tools from the client
      this.terminalTools = (await this.terminalMcpClient.tools()) as ToolSet;

      console.log(
        `[Session ${this.clientId}] Terminal MCP initialized with session ${this.conversationId}`
      );
    } catch (error) {
      console.error(
        `[Session ${this.clientId}] Failed to initialize Terminal MCP:`,
        error
      );
      throw error;
    }
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
      console.log(
        `[Session ${this.clientId}] Agent MCP initialized with ${agentToolCount} tools`
      );
    } catch (error) {
      console.error(
        `[Session ${this.clientId}] Failed to initialize Agent MCP:`,
        error
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

        if (
          event.event.type === "timeline" ||
          event.event.type === "turn_completed"
        ) {
          void this.maybeGenerateAgentTitle(event.agentId);
        }
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

    const provider = coerceAgentProvider(record.provider, record.id);
    return {
      id: record.id,
      provider,
      cwd: record.cwd,
      model: record.config?.model ?? null,
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
      lastUserMessageAt: lastUserMessageAt ? lastUserMessageAt.toISOString() : null,
      status: record.lastStatus,
      sessionId: null,
      capabilities: defaultCapabilities,
      currentModeId: record.lastModeId ?? null,
      availableModes: [],
      pendingPermissions: [],
      persistence: toAgentPersistenceHandle(record.persistence),
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

    const inflight = this.pendingAgentInitializations.get(agentId);
    if (inflight) {
      return inflight;
    }

    const initPromise = (async () => {
      const record = await this.agentRegistry.get(agentId);
      if (!record) {
        throw new Error(`Agent not found: ${agentId}`);
      }

      const handle = toAgentPersistenceHandle(record.persistence);
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

    this.pendingAgentInitializations.set(agentId, initPromise);

    try {
      return await initPromise;
    } finally {
      this.pendingAgentInitializations.delete(agentId);
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
      console.error(
        `[Session ${this.clientId}] Failed to emit agent state:`,
        error
      );
    }
  }

  private async getStoredAgentTitle(agentId: string): Promise<string | null> {
    if (this.agentTitleCache.has(agentId)) {
      return this.agentTitleCache.get(agentId) ?? null;
    }

    try {
      const record = await this.agentRegistry.get(agentId);
      const title = record?.title ?? null;
      this.agentTitleCache.set(agentId, title);
      return title;
    } catch (error) {
      console.error(
        `[Session ${this.clientId}] Failed to load registry record for agent ${agentId}:`,
        error
      );
      return null;
    }
  }

  private setCachedTitle(agentId: string, title: string | null): void {
    this.agentTitleCache.set(agentId, title);
  }

  private async maybeGenerateAgentTitle(agentId: string): Promise<void> {
    if (!isTitleGeneratorInitialized()) {
      return;
    }

    const existingTitle = await this.getStoredAgentTitle(agentId);
    if (existingTitle) {
      return;
    }

    if (ACTIVE_TITLE_GENERATIONS.has(agentId)) {
      return;
    }

    const timeline = this.agentManager.getTimeline(agentId);
    if (timeline.length === 0) {
      return;
    }

    const snapshot = this.agentManager.getAgent(agentId);
    if (!snapshot) {
      return;
    }

    ACTIVE_TITLE_GENERATIONS.add(agentId);
    try {
      console.log(
        `[Session ${this.clientId}] Generating title for agent ${agentId}`
      );
      const title = await generateAgentTitle(timeline, snapshot.cwd);
      await this.agentRegistry.setTitle(agentId, title);
      this.setCachedTitle(agentId, title);
      const latest = this.agentManager.getAgent(agentId) ?? snapshot;
      await this.forwardAgentState(latest);
    } catch (error) {
      console.error(
        `[Session ${this.clientId}] Failed to generate title for agent ${agentId}:`,
        error
      );
    } finally {
      ACTIVE_TITLE_GENERATIONS.delete(agentId);
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

        case "load_conversation_request":
          await this.handleLoadConversation();
          break;

        case "list_conversations_request":
          await this.handleListConversations();
          break;

        case "delete_conversation_request":
          await this.handleDeleteConversation(msg.conversationId);
          break;

        case "delete_agent_request":
          await this.handleDeleteAgentRequest(msg.agentId);
          break;

        case "set_realtime_mode":
          this.handleSetRealtimeMode(msg.enabled);
          break;

        case "send_agent_message":
          await this.handleSendAgentMessage(
            msg.agentId,
            msg.text,
            msg.messageId,
            msg.images
          );
          break;

        case "send_agent_audio":
          await this.handleSendAgentAudio(msg);
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
        await this.handleRestartServerRequest(msg.reason);
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
          await this.handleGitDiffRequest(msg.agentId);
          break;

        case "file_explorer_request":
          await this.handleFileExplorerRequest(msg);
          break;

        case "list_persisted_agents_request":
          await this.handleListPersistedAgentsRequest(msg);
          break;

        case "git_repo_info_request":
          await this.handleGitRepoInfoRequest(msg);
          break;

        case "list_provider_models_request":
          await this.handleListProviderModelsRequest(msg);
          break;
      }
    } catch (error: any) {
      console.error(
        `[Session ${this.clientId}] Error handling message:`,
        error
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
   * Load existing conversation
   */
  public async handleLoadConversation(): Promise<void> {
    // This is handled during construction, but we emit a confirmation message
    this.emit({
      type: "conversation_loaded",
      payload: {
        conversationId: this.conversationId,
        messageCount: this.messages.length,
      },
    });

    // Send current session state (live agents and commands)
    await this.sendSessionState();
  }

  /**
   * List all conversations
   */
  public async handleListConversations(): Promise<void> {
    try {
      const conversations = await listConversations();
      this.emit({
        type: "list_conversations_response",
        payload: {
          conversations: conversations.map((conv) => ({
            id: conv.id,
            lastUpdated: conv.lastUpdated.toISOString(),
            messageCount: conv.messageCount,
          })),
        },
      });
    } catch (error: any) {
      console.error(
        `[Session ${this.clientId}] Failed to list conversations:`,
        error
      );
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to list conversations: ${error.message}`,
        },
      });
    }
  }

  /**
   * Delete a conversation
   */
  public async handleDeleteConversation(conversationId: string): Promise<void> {
    try {
      await deleteConversation(conversationId);
      this.emit({
        type: "delete_conversation_response",
        payload: {
          conversationId,
          success: true,
        },
      });
      console.log(
        `[Session ${this.clientId}] Deleted conversation ${conversationId}`
      );
    } catch (error: any) {
      console.error(
        `[Session ${this.clientId}] Failed to delete conversation ${conversationId}:`,
        error
      );
      this.emit({
        type: "delete_conversation_response",
        payload: {
          conversationId,
          success: false,
          error: error.message,
        },
      });
    }
  }

  private async handleRestartServerRequest(reason?: string): Promise<void> {
    if (restartRequested) {
      console.log(
        `[Session ${this.clientId}] Restart already requested, ignoring duplicate`
      );
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

    console.warn(`[Session ${this.clientId}] Restart requested via websocket`);
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

  private async handleDeleteAgentRequest(agentId: string): Promise<void> {
    console.log(
      `[Session ${this.clientId}] Deleting agent ${agentId} from registry`
    );

    try {
      await this.agentManager.closeAgent(agentId);
    } catch (error: any) {
      console.warn(
        `[Session ${this.clientId}] Failed to close agent ${agentId} during delete:`,
        error
      );
    }

    try {
      await this.agentRegistry.remove(agentId);
    } catch (error: any) {
      console.error(
        `[Session ${this.clientId}] Failed to remove agent ${agentId} from registry:`,
        error
      );
    }

    this.agentTitleCache.delete(agentId);
    this.emit({
      type: "agent_deleted",
      payload: {
        agentId,
      },
    });
  }

  /**
   * Handle realtime mode toggle
   */
  private handleSetRealtimeMode(enabled: boolean): void {
    this.isRealtimeMode = enabled;
    console.log(
      `[Session ${this.clientId}] Realtime mode ${
        enabled ? "enabled" : "disabled"
      }`
    );
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
    console.log(
      `[Session ${
        this.clientId
      }] Sending text to agent ${agentId}: ${text.substring(0, 50)}...${images && images.length > 0 ? ` with ${images.length} image attachment(s)` : ''}`
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
      this.agentManager.recordUserMessage(agentId, text, { messageId });
    } catch (error) {
      console.error(
        `[Session ${this.clientId}] Failed to record user message for agent ${agentId}:`,
        error
      );
    }

    this.startAgentStream(agentId, prompt);
  }

  /**
   * Handle audio message to agent (transcribe then send)
   */
  private async handleSendAgentAudio(
    msg: Extract<SessionInboundMessage, { type: "send_agent_audio" }>
  ): Promise<void> {
    const { agentId, audio, format, isLast, requestId, mode } = msg;
    const shouldAutoRun = mode === "auto_run";

    // Decode base64
    const audioBuffer = Buffer.from(audio, "base64");

    // For now, we'll process each audio segment immediately
    // In the future, we might want to buffer chunks similar to realtime audio
    if (!isLast) {
      console.log(
        `[Session ${this.clientId}] Buffering agent audio chunk for agent ${agentId}`
      );
      // TODO: Implement buffering if needed
      return;
    }

    console.log(
      `[Session ${this.clientId}] Transcribing audio for agent ${agentId}`
    );

    try {
      // Transcribe the audio
      const result = await this.sttManager.transcribe(audioBuffer, format, {
        agentId,
        requestId,
        label: shouldAutoRun ? "dictation:auto_run" : "dictation",
      });

      const transcriptText = result.text.trim();
      if (!transcriptText) {
        console.log(
          `[Session ${this.clientId}] Empty transcription for agent ${agentId}, ignoring`
        );
        return;
      }

      console.log(
        `[Session ${this.clientId}] Transcribed audio for agent ${agentId}: ${transcriptText}`
      );

      // Emit transcription result to client with requestId
      this.emit({
        type: "transcription_result",
        payload: {
          text: result.text,
          language: result.language,
          duration: result.duration,
          requestId,
          avgLogprob: result.avgLogprob,
          isLowConfidence: result.isLowConfidence,
          byteLength: result.byteLength,
          format: result.format,
          debugRecordingPath: result.debugRecordingPath,
        },
      });

      if (!shouldAutoRun) {
        console.log(
          `[Session ${this.clientId}] Completed transcription for agent ${agentId} (requestId: ${requestId ?? "n/a"})`
        );
        return;
      }

      try {
        await this.ensureAgentLoaded(agentId);
      } catch (error) {
        this.handleAgentRunError(
          agentId,
          error,
          "Failed to initialize agent before sending audio prompt"
        );
        return;
      }

      try {
        await this.interruptAgentIfRunning(agentId);
      } catch (error) {
        this.handleAgentRunError(
          agentId,
          error,
          "Failed to interrupt running agent before sending audio prompt"
        );
        return;
      }

      try {
        this.agentManager.recordUserMessage(agentId, transcriptText);
      } catch (recordError) {
        console.error(
          `[Session ${this.clientId}] Failed to record transcribed user message for agent ${agentId}:`,
          recordError
        );
      }

      // Send transcribed text to agent
      this.startAgentStream(agentId, transcriptText);
      console.log(
        `[Session ${this.clientId}] Sent transcribed text to agent ${agentId}`
      );
    } catch (error: any) {
      console.error(
        `[Session ${this.clientId}] Failed to process audio for agent ${agentId}:`,
        error
      );
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to process audio for agent: ${error.message}`,
        },
      });
      throw error;
    }
  }

  /**
   * Handle on-demand agent initialization request from client
   */
  private async handleInitializeAgentRequest(
    agentId: string,
    requestId?: string
  ): Promise<void> {
    console.log(
      `[Session ${this.clientId}] Initializing agent ${agentId} on demand`
    );

    try {
      const snapshot = await this.ensureAgentLoaded(agentId);
      await this.forwardAgentState(snapshot);

      // Send timeline snapshot after hydration (if any)
      const timelineSize = this.emitAgentTimelineSnapshot(snapshot);

      if (requestId) {
        this.emit({
          type: "status",
          payload: {
            status: "agent_initialized",
            agentId,
            agentStatus: snapshot.lifecycle,
            requestId,
            timelineSize,
          },
        });
      }

      console.log(
        `[Session ${this.clientId}] Agent ${agentId} initialized with ${timelineSize} timeline item(s); status=${snapshot.lifecycle}`
      );
    } catch (error: any) {
      console.error(
        `[Session ${this.clientId}] Failed to initialize agent ${agentId}:`,
        error
      );
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to initialize agent: ${error.message}`,
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
    const { config, worktreeName, requestId, initialPrompt, git } = msg;
    console.log(
      `[Session ${this.clientId}] Creating agent in ${config.cwd} (${config.provider})${
        worktreeName ? ` with worktree ${worktreeName}` : ""
      }`
    );

    try {
      const sessionConfig = await this.buildAgentSessionConfig(
        config,
        git,
        worktreeName
      );
      const snapshot = await this.agentManager.createAgent(sessionConfig);
      this.setCachedTitle(snapshot.id, null);
      await this.forwardAgentState(snapshot);

      const trimmedPrompt = initialPrompt?.trim();
      if (trimmedPrompt) {
        try {
          await this.handleSendAgentMessage(
            snapshot.id,
            trimmedPrompt,
            uuidv4()
          );
        } catch (promptError) {
          console.error(
            `[Session ${this.clientId}] Failed to run initial prompt for agent ${snapshot.id}:`,
            promptError
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

      console.log(
        `[Session ${this.clientId}] Created agent ${snapshot.id} (${snapshot.provider})`
      );
    } catch (error: any) {
      console.error(
        `[Session ${this.clientId}] Failed to create agent:`,
        error
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
      console.warn(
        `[Session ${this.clientId}] Resume request missing persistence handle`
      );
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
    console.log(
      `[Session ${this.clientId}] Resuming agent ${handle.sessionId} (${handle.provider})`
    );
    try {
      const snapshot = await this.agentManager.resumeAgent(handle, overrides);
      this.setCachedTitle(snapshot.id, null);
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
      console.error(
        `[Session ${this.clientId}] Failed to resume agent:`,
        error
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
    console.log(
      `[Session ${this.clientId}] Refreshing agent ${agentId} from persistence`
    );

    try {
      let snapshot: ManagedAgent;
      const existing = this.agentManager.getAgent(agentId);
      if (existing) {
        await this.interruptAgentIfRunning(agentId);
        snapshot = await this.agentManager.refreshAgentFromPersistence(
          agentId
        );
      } else {
        const record = await this.agentRegistry.get(agentId);
        if (!record) {
          throw new Error(`Agent not found: ${agentId}`);
        }
        const handle = toAgentPersistenceHandle(record.persistence);
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
        this.setCachedTitle(agentId, null);
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
      console.error(
        `[Session ${this.clientId}] Failed to refresh agent ${agentId}:`,
        error
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
    console.log(
      `[Session ${this.clientId}] Cancel request received for agent ${agentId}`
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
  ): Promise<AgentSessionConfig> {
    let cwd = expandTilde(config.cwd);
    const normalized = this.normalizeGitOptions(gitOptions, legacyWorktreeName);

    if (!normalized) {
      return {
        ...config,
        cwd,
      };
    }

    if (!normalized.createWorktree) {
      await this.ensureCleanWorkingTree(cwd);
    }

    if (normalized.createWorktree) {
      const targetBranch = normalized.createNewBranch
        ? normalized.newBranchName
        : normalized.baseBranch;

      if (!targetBranch) {
        throw new Error(
          "A branch name is required when creating a worktree."
        );
      }

      console.log(
        `[Session ${this.clientId}] Creating worktree '${
          normalized.worktreeSlug ?? targetBranch
        }' for branch ${targetBranch}`
      );

      const worktreeConfig = await createWorktree({
        branchName: targetBranch,
        cwd,
        baseBranch: normalized.createNewBranch
          ? normalized.baseBranch
          : undefined,
        worktreeSlug: normalized.worktreeSlug ?? targetBranch,
      });
      cwd = worktreeConfig.worktreePath;
    } else if (normalized.createNewBranch) {
      await this.createBranchFromBase({
        cwd,
        baseBranch: normalized.baseBranch ?? "HEAD",
        newBranchName: normalized.newBranchName!,
      });
    } else if (normalized.baseBranch) {
      await this.checkoutExistingBranch(cwd, normalized.baseBranch);
    }

    return {
      ...config,
      cwd,
    };
  }

  private async handleGitRepoInfoRequest(
    msg: Extract<SessionInboundMessage, { type: "git_repo_info_request" }>
  ): Promise<void> {
    const { cwd, requestId } = msg;
    const resolvedCwd = expandTilde(cwd);

    try {
      const repoInfo = await detectRepoInfo(resolvedCwd);
      const { stdout: branchesRaw } = await execAsync(
        "git branch --format='%(refname:short)'",
        { cwd: repoInfo.path }
      );
      const { stdout: currentRaw } = await execAsync(
        "git rev-parse --abbrev-ref HEAD",
        { cwd: resolvedCwd }
      );
      const currentBranch = currentRaw.trim();
      const branches = branchesRaw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((name) => ({
          name,
          isCurrent: name === currentBranch,
        }));

      const isDirty = await this.isWorkingTreeDirty(resolvedCwd);

      this.emit({
        type: "git_repo_info_response",
        payload: {
          cwd: resolvedCwd,
          repoRoot: repoInfo.path,
          requestId,
          branches,
          currentBranch: currentBranch || null,
          isDirty,
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
      const models = await fetchProviderModelCatalog(msg.provider, {
        cwd: msg.cwd ? expandTilde(msg.cwd) : undefined,
      });
      this.emit({
        type: "list_provider_models_response",
        payload: {
          provider: msg.provider,
          models,
          fetchedAt,
          ...(msg.requestId ? { requestId: msg.requestId } : {}),
        },
      });
    } catch (error) {
      console.error(
        `[Session ${this.clientId}] Failed to list models for ${msg.provider}:`,
        error
      );
      this.emit({
        type: "list_provider_models_response",
        payload: {
          provider: msg.provider,
          error: (error as Error)?.message ?? String(error),
          fetchedAt,
          ...(msg.requestId ? { requestId: msg.requestId } : {}),
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

    if (createWorktree && !createNewBranch && !baseBranch) {
      throw new Error(
        "Base branch is required when creating a worktree without a new branch"
      );
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
      const { stdout } = await execAsync("git status --porcelain", { cwd });
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

  private async handleListPersistedAgentsRequest(
    msg: Extract<SessionInboundMessage, { type: "list_persisted_agents_request" }>
  ): Promise<void> {
    const { provider, limit } = msg;
    try {
      const entries = await this.agentManager.listPersistedAgents({
        provider,
        limit,
      });
      this.emit({
        type: "list_persisted_agents_response",
        payload: {
          items: entries.map((entry) => ({
            provider: entry.provider,
            sessionId: entry.sessionId,
            cwd: entry.cwd,
            title: entry.title ?? `Session ${entry.sessionId.slice(0, 8)}`,
            lastActivityAt: entry.lastActivityAt.toISOString(),
            persistence: entry.persistence,
            timeline: entry.timeline ?? [],
          })),
        },
      });
    } catch (error) {
      console.error(
        `[Session ${this.clientId}] Failed to list persisted agents:`,
        error
      );
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to list saved agents: ${
            (error as Error)?.message ?? error
          }`,
        },
      });
    }
  }

  /**
   * Handle set agent mode request
   */
  private async handleSetAgentMode(
    agentId: string,
    modeId: string
  ): Promise<void> {
    console.log(
      `[Session ${this.clientId}] Setting agent ${agentId} mode to ${modeId}`
    );

    try {
      await this.agentManager.setAgentMode(agentId, modeId);
      console.log(
        `[Session ${this.clientId}] Agent ${agentId} mode set to ${modeId}`
      );
    } catch (error: any) {
      console.error(
        `[Session ${this.clientId}] Failed to set agent mode:`,
        error
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
   * Handle agent permission response from user
   */
  private async handleAgentPermissionResponse(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse
  ): Promise<void> {
    console.log(
      `[Session ${this.clientId}] Handling permission response for agent ${agentId}, request ${requestId}`
    );

    try {
      await this.agentManager.respondToPermission(agentId, requestId, response);
      console.log(
        `[Session ${this.clientId}] Permission response forwarded to agent ${agentId}`
      );
    } catch (error: any) {
      console.error(
        `[Session ${this.clientId}] Failed to respond to permission:`,
        error
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
  private async handleGitDiffRequest(agentId: string): Promise<void> {
    console.log(
      `[Session ${this.clientId}] Handling git diff request for agent ${agentId}`
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
          },
        });
        return;
      }

      const { stdout } = await execAsync("git diff HEAD", {
        cwd: agent.cwd,
      });

      this.emit({
        type: "git_diff_response",
        payload: {
          agentId,
          diff: stdout,
          error: null,
        },
      });

      console.log(
        `[Session ${this.clientId}] Git diff for agent ${agentId} completed (${stdout.length} bytes)`
      );
    } catch (error: any) {
      console.error(
        `[Session ${this.clientId}] Failed to get git diff for agent ${agentId}:`,
        error
      );
      this.emit({
        type: "git_diff_response",
        payload: {
          agentId,
          diff: "",
          error: error.message,
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
    const { agentId, path: requestedPath = ".", mode } = request;

    console.log(
      `[Session ${this.clientId}] Handling file explorer request for agent ${agentId} (${mode} ${requestedPath})`
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
          },
        });
      }
    } catch (error: any) {
      console.error(
        `[Session ${this.clientId}] Failed to fulfill file explorer request for agent ${agentId}:`,
        error
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
      const registryRecords = await this.agentRegistry.list();
      const liveIds = new Set(agentSnapshots.map((a) => a.id));
      const persistedAgents = registryRecords
        .filter((record) => !liveIds.has(record.id))
        .map((record) => this.buildStoredAgentPayload(record));

      const agents = [...liveAgents, ...persistedAgents];

      // Get live commands from terminal manager
      let commands: any[] = [];
      if (this.terminalManager) {
        try {
          commands = await this.terminalManager.listCommands();
        } catch (error) {
          console.error(
            `[Session ${this.clientId}] Failed to list commands:`,
            error
          );
        }
      }

      // Emit session state
      this.emit({
        type: "session_state",
        payload: {
          agents,
          commands,
        },
      });

      console.log(
        `[Session ${this.clientId}] Sent session state: ${agents.length} agents, ${commands.length} commands`
      );
    } catch (error) {
      console.error(
        `[Session ${this.clientId}] Failed to send session state:`,
        error
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
      console.log(
        `[Session ${this.clientId}] Waiting for aborted stream to finish cleanup`
      );
      await this.currentStreamPromise;
      console.log(`[Session ${this.clientId}] Aborted stream finished cleanup`);
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
      console.log(
        `[Session ${this.clientId}] Audio format changed mid-stream (${this.audioBuffer.isPCM ? "pcm" : this.audioBuffer.format} → ${chunkFormat}), flushing current buffer`
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

    console.log(
      `[Session ${this.clientId}] Buffered audio chunk (${chunkBuffer.length} bytes, chunks: ${this.audioBuffer.chunks.length}${this.audioBuffer.isPCM ? `, PCM bytes: ${this.audioBuffer.totalPCMBytes}` : ""})`
    );

    // In realtime mode, only process audio when the user has finished speaking (isLast = true)
    // This prevents partial transcriptions from being sent to the LLM
    if (this.isRealtimeMode) {
      if (!msg.isLast) {
        console.log(
          `[Session ${this.clientId}] Realtime mode: buffering audio, waiting for speech end`
        );
        return;
      }
      console.log(
        `[Session ${this.clientId}] Realtime mode: speech ended, processing complete audio`
      );
    }

    // In non-realtime mode, use streaming threshold to process chunks
    const reachedStreamingThreshold =
      !this.isRealtimeMode &&
      this.audioBuffer.isPCM &&
      this.audioBuffer.totalPCMBytes >= MIN_STREAMING_SEGMENT_BYTES;

    if (!msg.isLast && !reachedStreamingThreshold) {
      return;
    }

    const bufferedState = this.audioBuffer;
    const finalized = this.finalizeBufferedAudio();
    if (!finalized) {
      return;
    }

    if (!msg.isLast && reachedStreamingThreshold) {
      console.log(
        `[Session ${this.clientId}] Minimum chunk duration reached (~${MIN_STREAMING_SEGMENT_DURATION_MS}ms, ${
          bufferedState?.totalPCMBytes ?? 0
        } PCM bytes) – triggering STT`
      );
    } else {
      console.log(
        `[Session ${this.clientId}] Complete audio segment (${finalized.audio.length} bytes, ${bufferedState?.chunks.length ?? 0} chunk(s))`
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
      console.log(
        `[Session ${this.clientId}] Buffering audio segment (phase: ${this.processingPhase})`
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
      console.log(
        `[Session ${this.clientId}] Processing ${this.pendingAudioSegments.length} buffered segments together`
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
        console.log(
          `[Session ${this.clientId}] Empty transcription (false positive), not aborting`
        );
        this.setPhase("idle");
        this.clearSpeechInProgress("empty transcription");
        return;
      }

      // Has content - abort any in-progress stream now
      this.createAbortController();

      // Wait for aborted stream to finish cleanup (save partial response)
      if (this.currentStreamPromise) {
        console.log(
          `[Session ${this.clientId}] Waiting for aborted stream to finish cleanup`
        );
        await this.currentStreamPromise;
      }

      // Emit transcription result
      this.emit({
        type: "transcription_result",
        payload: {
          text: result.text,
          language: result.language,
          duration: result.duration,
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
          console.log(
            `[Session ${this.clientId}] Skipping TTS chunk while speech in progress`
          );
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

      // Wait for terminal MCP to initialize if needed
      if (!this.terminalTools) {
        console.log(
          `[Session ${this.clientId}] Waiting for terminal MCP initialization...`
        );
        // Wait up to 5 seconds for initialization
        const startTime = Date.now();
        while (!this.terminalTools && Date.now() - startTime < 5000) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!this.terminalTools) {
          throw new Error("Terminal MCP failed to initialize");
        }
      }

      if (!this.agentTools) {
        console.log(
          `[Session ${this.clientId}] Waiting for agent MCP initialization...`
        );
        const startTime = Date.now();
        while (!this.agentTools && Date.now() - startTime < 5000) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!this.agentTools) {
          console.log(
            `[Session ${this.clientId}] Agent MCP tools unavailable; continuing with default tool set`
          );
        }
      }

      const allTools = await getAllTools(this.terminalTools, this.agentTools ?? undefined);

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
            console.log(
              `[Session ${this.clientId}] onFinish - saved message with ${newMessages.length} steps`
            );
          }

          // Persist conversation to disk
          try {
            await saveConversation(this.conversationId, this.messages);
          } catch (error) {
            console.error(
              `[Session ${this.clientId}] Failed to persist conversation:`,
              error
            );
            // Don't break conversation flow on persistence errors
          }
        },
        onChunk: async ({ chunk }) => {
          if (chunk.type === "text-delta") {
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
              console.log(
                `[Session ${this.clientId}] Waiting for TTS before executing ${chunk.toolName}`
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
            // Check if this is a create_coding_agent result
            if (chunk.toolName === "create_coding_agent" && chunk.output) {
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
          console.error(error);

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

      // Flush any remaining text at the end
      flushTextBuffer();

      // Note: Message is saved by onFinish callback with proper tool calls

      // Now wait for any pending TTS, but don't fail if it times out
      if (pendingTTS) {
        try {
          await pendingTTS;
        } catch (ttsError) {
          console.error(
            `[Session ${this.clientId}] TTS playback failed (message already saved):`,
            ttsError
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
        console.log(
          `[Session ${this.clientId}] Stream aborted (partial response saved)`
        );
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
      console.error(
        `[Session ${this.clientId}] Failed to resolve artifact source:`,
        error
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
    console.log(
      `[Session ${this.clientId}] Abort request, phase: ${this.processingPhase}`
    );

    if (this.processingPhase === "llm") {
      // Already in LLM phase - abort and wait for cleanup
      this.abortController.abort();
      console.log(`[Session ${this.clientId}] Aborted LLM processing`);

      // Wait for stream to finish saving partial response
      if (this.currentStreamPromise) {
        console.log(
          `[Session ${this.clientId}] Waiting for stream cleanup after abort`
        );
        await this.currentStreamPromise;
      }

      // Reset phase to idle
      this.setPhase("idle");

      // Clear any pending segments and timeouts
      this.pendingAudioSegments = [];
      this.clearBufferTimeout();
    } else if (this.processingPhase === "transcribing") {
      // Still in STT phase - we'll buffer the next audio
      console.log(
        `[Session ${this.clientId}] Will buffer next audio (currently transcribing)`
      );
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
    console.log(
      `[Session ${this.clientId}] Realtime speech chunk detected – aborting playback and LLM`
    );
    this.ttsManager.cancelPendingPlaybacks("realtime speech detected");

    if (this.pendingAudioSegments.length > 0) {
      console.log(
        `[Session ${this.clientId}] Dropping ${this.pendingAudioSegments.length} buffered audio segment(s) due to realtime speech`
      );
      this.pendingAudioSegments = [];
    }

    if (this.audioBuffer) {
      console.log(
        `[Session ${this.clientId}] Clearing partial audio buffer (${this.audioBuffer.chunks.length} chunk(s)${
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
    console.log("[Telemetry] barge_in.llm_abort_latency", {
      latencyMs,
      conversationId: this.conversationId,
      phaseBeforeAbort,
      hadActiveStream,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Clear speech-in-progress flag once the user turn has completed
   */
  private clearSpeechInProgress(reason: string): void {
    if (!this.speechInProgress) {
      return;
    }

    this.speechInProgress = false;
    console.log(
      `[Session ${this.clientId}] Speech turn complete (${reason}) – resuming TTS`
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
    console.log(`[Session ${this.clientId}] Phase: ${phase}`);
  }

  /**
   * Set timeout to process buffered audio segments
   */
  private setBufferTimeout(): void {
    this.clearBufferTimeout();

    this.bufferTimeout = setTimeout(async () => {
      console.log(
        `[Session ${this.clientId}] Buffer timeout reached, processing pending segments`
      );

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

      const filename = `${this.conversationId}-${this.turnIndex}.json`;
      const filepath = join(dumpDir, filename);

      const dump = {
        conversationId: this.conversationId,
        turnIndex: this.turnIndex,
        timestamp: new Date().toISOString(),
        messages: this.messages,
      };

      await writeFile(filepath, inspect(dump, { depth: null }), "utf-8");
      console.log(
        `[Session ${this.clientId}] Dumped conversation to ${filepath}`
      );
    } catch (error) {
      console.error(
        `[Session ${this.clientId}] Failed to dump conversation:`,
        error
      );
    }
  }

  /**
   * Clean up session resources
   */
  public async cleanup(): Promise<void> {
    console.log(`[Session ${this.clientId}] Cleaning up`);

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

    // Kill tmux session for this conversation
    try {
      console.log(
        `[Session ${this.clientId}] Killing tmux session ${this.conversationId}`
      );
      await execAsync(`tmux kill-session -t ${this.conversationId}`);
      console.log(
        `[Session ${this.clientId}] Tmux session ${this.conversationId} killed`
      );
    } catch (error) {
      // Session might not exist or already be killed - that's okay
      console.log(
        `[Session ${this.clientId}] Tmux session cleanup (session may not exist):`,
        error instanceof Error ? error.message : String(error)
      );
    }

    // Close MCP clients
    if (this.terminalMcpClient) {
      try {
        await this.terminalMcpClient.close();
        console.log(`[Session ${this.clientId}] Terminal MCP client closed`);
      } catch (error) {
        console.error(
          `[Session ${this.clientId}] Failed to close Terminal MCP client:`,
          error
        );
      }
    }

    if (this.agentMcpClient) {
      try {
        await this.agentMcpClient.close();
        console.log(`[Session ${this.clientId}] Agent MCP client closed`);
      } catch (error) {
        console.error(
          `[Session ${this.clientId}] Failed to close Agent MCP client:`,
          error
        );
      }
      this.agentMcpClient = null;
      this.agentTools = null;
    }

  }
}
