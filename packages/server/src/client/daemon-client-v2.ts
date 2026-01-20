import type { z } from "zod";
import {
  AgentCreateFailedStatusPayloadSchema,
  AgentCreatedStatusPayloadSchema,
  AgentRefreshedStatusPayloadSchema,
  AgentResumedStatusPayloadSchema,
  RestartRequestedStatusPayloadSchema,
  SessionInboundMessageSchema,
  WSOutboundMessageSchema,
} from "../shared/messages.js";
import type {
  AgentStreamEventPayload,
  AgentSnapshotPayload,
  AgentPermissionResolvedMessage,
  ConversationLoadedMessage,
  CreateAgentRequestMessage,
  DeleteConversationResponseMessage,
  FileDownloadTokenResponse,
  FileExplorerResponse,
  GitDiffResponse,
  GitSetupOptions,
  GitRepoInfoResponse,
  HighlightedDiffResponse,
  ListCommandsResponse,
  ListConversationsResponseMessage,
  ListProviderModelsResponseMessage,
  ListTerminalsResponse,
  CreateTerminalResponse,
  SubscribeTerminalResponse,
  TerminalOutput,
  KillTerminalResponse,
  TerminalInput,
  SendAgentMessage,
  SessionInboundMessage,
  SessionOutboundMessage,
  TranscriptionResultMessage,
} from "../shared/messages.js";
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentProvider,
  AgentSessionConfig,
} from "../server/agent/agent-sdk-types.js";
import { getAgentProviderDefinition } from "../server/agent/provider-manifest.js";

export interface Logger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

const consoleLogger: Logger = {
  debug: (obj, msg) => console.debug(msg, obj),
  info: (obj, msg) => console.info(msg, obj),
  warn: (obj, msg) => console.warn(msg, obj),
  error: (obj, msg) => console.error(msg, obj),
};

export type DaemonTransport = {
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  onMessage: (handler: (data: unknown) => void) => () => void;
  onOpen: (handler: () => void) => () => void;
  onClose: (handler: (event?: unknown) => void) => () => void;
  onError: (handler: (event?: unknown) => void) => () => void;
};

export type DaemonTransportFactory = (options: {
  url: string;
  headers?: Record<string, string>;
}) => DaemonTransport;

export type WebSocketFactory = (
  url: string,
  options?: { headers?: Record<string, string> }
) => WebSocketLike;

export type WebSocketLike = {
  readyState: number;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  on?: (event: string, listener: (...args: any[]) => void) => void;
  off?: (event: string, listener: (...args: any[]) => void) => void;
  removeListener?: (event: string, listener: (...args: any[]) => void) => void;
  addEventListener?: (event: string, listener: (event: any) => void) => void;
  removeEventListener?: (event: string, listener: (event: any) => void) => void;
  onopen?: ((event: any) => void) | null;
  onclose?: ((event: any) => void) | null;
  onerror?: ((event: any) => void) | null;
  onmessage?: ((event: any) => void) | null;
};

export type ConnectionState =
  | { status: "idle" }
  | { status: "connecting"; attempt: number }
  | { status: "connected" }
  | { status: "disconnected"; reason?: string };

export type DaemonEvent =
  | { type: "agent_state"; agentId: string; payload: AgentSnapshotPayload }
  | {
      type: "agent_stream";
      agentId: string;
      event: AgentStreamEventPayload;
      timestamp: string;
    }
  | { type: "session_state"; agents: AgentSnapshotPayload[] }
  | { type: "status"; payload: { status: string } & Record<string, unknown> }
  | { type: "agent_deleted"; agentId: string }
  | {
      type: "agent_permission_request";
      agentId: string;
      request: AgentPermissionRequest;
    }
  | {
      type: "agent_permission_resolved";
      agentId: string;
      requestId: string;
      resolution: AgentPermissionResponse;
    }
  | { type: "error"; message: string };

export type DaemonEventHandler = (event: DaemonEvent) => void;

export type DaemonClientV2Config = {
  url: string;
  authHeader?: string;
  conversationId?: string | null;
  suppressSendErrors?: boolean;
  transportFactory?: DaemonTransportFactory;
  webSocketFactory?: WebSocketFactory;
  logger?: Logger;
  reconnect?: {
    enabled?: boolean;
    baseDelayMs?: number;
    maxDelayMs?: number;
  };
  messageQueueLimit?: number | null;
};

export type SendMessageOptions = Pick<SendAgentMessage, "messageId" | "images">;

export type TranscribeAudioOptions = {
  audio: string; // base64 encoded
  format: string;
  timeout?: number;
};

type AgentConfigOverrides = Partial<Omit<AgentSessionConfig, "provider" | "cwd">>;

export type CreateAgentRequestOptions = {
  config?: AgentSessionConfig;
  provider?: AgentProvider;
  cwd?: string;
  initialPrompt?: string;
  images?: CreateAgentRequestMessage["images"];
  git?: GitSetupOptions;
  worktreeName?: string;
  requestId?: string;
} & AgentConfigOverrides;

type ConversationLoadedPayload = ConversationLoadedMessage["payload"];
type ListConversationsPayload = ListConversationsResponseMessage["payload"];
type DeleteConversationPayload = DeleteConversationResponseMessage["payload"];
type GitDiffPayload = GitDiffResponse["payload"];
type HighlightedDiffPayload = HighlightedDiffResponse["payload"];
type GitRepoInfoPayload = GitRepoInfoResponse["payload"];
type FileExplorerPayload = FileExplorerResponse["payload"];
type FileDownloadTokenPayload = FileDownloadTokenResponse["payload"];
type ListProviderModelsPayload = ListProviderModelsResponseMessage["payload"];
type ListCommandsPayload = ListCommandsResponse["payload"];
type TranscriptionResultPayload = TranscriptionResultMessage["payload"];
type AgentPermissionResolvedPayload = AgentPermissionResolvedMessage["payload"];
type ListTerminalsPayload = ListTerminalsResponse["payload"];
type CreateTerminalPayload = CreateTerminalResponse["payload"];
type SubscribeTerminalPayload = SubscribeTerminalResponse["payload"];
type TerminalOutputPayload = TerminalOutput["payload"];
type KillTerminalPayload = KillTerminalResponse["payload"];

type AgentCreateFailedStatusPayload = z.infer<
  typeof AgentCreateFailedStatusPayloadSchema
>;
type AgentRefreshedStatusPayload = z.infer<
  typeof AgentRefreshedStatusPayloadSchema
>;
type RestartRequestedStatusPayload = z.infer<
  typeof RestartRequestedStatusPayloadSchema
>;

type Waiter<T> = {
  predicate: (msg: SessionOutboundMessage) => T | null;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
};

const DEFAULT_RECONNECT_BASE_DELAY_MS = 1500;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30000;
const DEFAULT_MESSAGE_QUEUE_LIMIT = 0;

export class DaemonClientV2 {
  private transport: DaemonTransport | null = null;
  private transportCleanup: Array<() => void> = [];
  private messageQueue: SessionOutboundMessage[] = [];
  private messageHandlers: Map<
    SessionOutboundMessage["type"],
    Set<(message: SessionOutboundMessage) => void>
  > = new Map();
  private eventListeners: Set<DaemonEventHandler> = new Set();
  private waiters: Set<Waiter<any>> = new Set();
  private connectionListeners: Set<(status: ConnectionState) => void> =
    new Set();
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private shouldReconnect = true;
  private connectPromise: Promise<void> | null = null;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((error: Error) => void) | null = null;
  private lastErrorValue: string | null = null;
  private conversationId: string | null = null;
  private connectionState: ConnectionState = { status: "idle" };
  private messageQueueLimit: number | null;
  private agentIndex: Map<string, AgentSnapshotPayload> = new Map();
  private logger: Logger;

  constructor(private config: DaemonClientV2Config) {
    this.messageQueueLimit =
      config.messageQueueLimit === undefined
        ? DEFAULT_MESSAGE_QUEUE_LIMIT
        : config.messageQueueLimit;
    this.conversationId = config.conversationId ?? null;
    this.logger = config.logger ?? consoleLogger;
  }

  // ============================================================================
  // Connection
  // ============================================================================

  async connect(): Promise<void> {
    if (this.connectionState.status === "connected") {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.shouldReconnect = true;
    this.connectPromise = new Promise((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
      this.attemptConnect();
    });

    return this.connectPromise;
  }

  private attemptConnect(): void {
    if (!this.shouldReconnect) {
      this.rejectConnect(new Error("Daemon client is closed"));
      return;
    }

    if (this.connectionState.status === "connecting") {
      return;
    }

    const headers: Record<string, string> = {};
    if (this.config.authHeader) {
      headers["Authorization"] = this.config.authHeader;
    }

    const targetUrl = this.conversationId
      ? `${this.config.url}?conversationId=${encodeURIComponent(
          this.conversationId
        )}`
      : this.config.url;

    try {
      this.cleanupTransport();
      const transportFactory =
        this.config.transportFactory ??
        createWebSocketTransportFactory(
          this.config.webSocketFactory ?? defaultWebSocketFactory
        );
      const transport = transportFactory({ url: targetUrl, headers });
      this.transport = transport;

      this.updateConnectionState({
        status: "connecting",
        attempt: this.reconnectAttempt,
      });

      this.transportCleanup = [
        transport.onOpen(() => {
          this.lastErrorValue = null;
          this.reconnectAttempt = 0;
          this.updateConnectionState({ status: "connected" });
          this.resolveConnect();
        }),
        transport.onClose((event) => {
          const reason = describeTransportClose(event);
          if (reason) {
            this.lastErrorValue = reason;
          }
          this.updateConnectionState({
            status: "disconnected",
            ...(reason ? { reason } : {}),
          });
          this.scheduleReconnect(reason);
        }),
        transport.onError((event) => {
          const reason = describeTransportError(event);
          this.lastErrorValue = reason;
          this.updateConnectionState({
            status: "disconnected",
            reason,
          });
          this.scheduleReconnect(reason);
        }),
        transport.onMessage((data) => this.handleTransportMessage(data)),
      ];
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to connect";
      this.lastErrorValue = message;
      this.scheduleReconnect(message);
      this.rejectConnect(error instanceof Error ? error : new Error(message));
    }
  }

  private resolveConnect(): void {
    if (this.connectResolve) {
      this.connectResolve();
    }
    this.connectPromise = null;
    this.connectResolve = null;
    this.connectReject = null;
  }

  private rejectConnect(error: Error): void {
    if (this.connectReject) {
      this.connectReject(error);
    }
    this.connectPromise = null;
    this.connectResolve = null;
    this.connectReject = null;
  }

  async close(): Promise<void> {
    this.shouldReconnect = false;
    this.connectPromise = null;
    this.connectResolve = null;
    this.connectReject = null;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.cleanupTransport();
    if (this.transport) {
      try {
        this.transport.close();
      } catch {
        // no-op
      }
      this.transport = null;
    }
    this.clearWaiters(new Error("Daemon client closed"));
    this.updateConnectionState({
      status: "disconnected",
      reason: "client_closed",
    });
  }

  ensureConnected(): void {
    if (!this.shouldReconnect) {
      this.shouldReconnect = true;
    }
    if (
      this.connectionState.status === "connected" ||
      this.connectionState.status === "connecting"
    ) {
      return;
    }
    void this.connect();
  }

  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  subscribeConnectionStatus(
    listener: (status: ConnectionState) => void
  ): () => void {
    this.connectionListeners.add(listener);
    listener(this.connectionState);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  get isConnected(): boolean {
    return this.connectionState.status === "connected";
  }

  get isConnecting(): boolean {
    return this.connectionState.status === "connecting";
  }

  get lastError(): string | null {
    return this.lastErrorValue;
  }

  get currentConversationId(): string | null {
    return this.conversationId;
  }

  // ============================================================================
  // Message Subscription
  // ============================================================================

  subscribe(handler: DaemonEventHandler): () => void {
    this.eventListeners.add(handler);
    return () => this.eventListeners.delete(handler);
  }

  on(type: SessionOutboundMessage["type"], handler: (message: SessionOutboundMessage) => void): () => void;
  on(handler: DaemonEventHandler): () => void;
  on(
    arg1: SessionOutboundMessage["type"] | DaemonEventHandler,
    arg2?: (message: SessionOutboundMessage) => void
  ): () => void {
    if (typeof arg1 === "function") {
      return this.subscribe(arg1);
    }

    const type = arg1 as SessionOutboundMessage["type"];
    const handler = arg2 as (message: SessionOutboundMessage) => void;

    if (!this.messageHandlers.has(type)) {
      this.messageHandlers.set(type, new Set());
    }
    this.messageHandlers.get(type)!.add(handler);

    return () => {
      const handlers = this.messageHandlers.get(type);
      if (!handlers) {
        return;
      }
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.messageHandlers.delete(type);
      }
    };
  }

  // ============================================================================
  // Core Send Helpers
  // ============================================================================

  private sendSessionMessage(message: SessionInboundMessage): void {
    if (!this.transport || this.connectionState.status !== "connected") {
      if (this.config.suppressSendErrors) {
        return;
      }
      throw new Error("Transport not connected");
    }
    const payload = SessionInboundMessageSchema.parse(message);
    this.transport.send(JSON.stringify({ type: "session", message: payload }));
  }

  sendUserMessage(text: string): void {
    this.sendSessionMessage({ type: "user_text", text });
  }

  clearAgentAttention(agentId: string | string[]): void {
    this.sendSessionMessage({ type: "clear_agent_attention", agentId });
  }

  sendHeartbeat(params: {
    deviceType: "web" | "mobile";
    focusedAgentId: string | null;
    lastActivityAt: string;
    appVisible: boolean;
  }): void {
    this.sendSessionMessage({
      type: "client_heartbeat",
      deviceType: params.deviceType,
      focusedAgentId: params.focusedAgentId,
      lastActivityAt: params.lastActivityAt,
      appVisible: params.appVisible,
    });
  }

  registerPushToken(token: string): void {
    this.sendSessionMessage({
      type: "register_push_token",
      token,
    });
  }

  // ============================================================================
  // Conversation / Session RPC
  // ============================================================================

  async loadConversation(
    conversationId?: string,
    requestId?: string
  ): Promise<ConversationLoadedPayload> {
    const resolvedRequestId = this.createRequestId(requestId);
    const message = SessionInboundMessageSchema.parse({
      type: "load_conversation_request",
      conversationId: conversationId ?? "",
      requestId: resolvedRequestId,
    });
    const response = this.waitFor(
      (msg) => {
        if (msg.type !== "conversation_loaded") {
          return null;
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null;
        }
        return msg.payload;
      },
      10000,
      { skipQueue: true }
    );
    this.sendSessionMessage(message);
    return response;
  }

  async listConversations(requestId?: string): Promise<ListConversationsPayload> {
    const resolvedRequestId = this.createRequestId(requestId);
    const message = SessionInboundMessageSchema.parse({
      type: "list_conversations_request",
      requestId: resolvedRequestId,
    });
    const response = this.waitFor(
      (msg) => {
        if (msg.type !== "list_conversations_response") {
          return null;
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null;
        }
        return msg.payload;
      },
      10000,
      { skipQueue: true }
    );
    this.sendSessionMessage(message);
    return response;
  }

  async deleteConversation(
    conversationId: string,
    requestId?: string
  ): Promise<DeleteConversationPayload> {
    const resolvedRequestId = this.createRequestId(requestId);
    const message = SessionInboundMessageSchema.parse({
      type: "delete_conversation_request",
      conversationId,
      requestId: resolvedRequestId,
    });
    const response = this.waitFor(
      (msg) => {
        if (msg.type !== "delete_conversation_response") {
          return null;
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null;
        }
        return msg.payload;
      },
      10000,
      { skipQueue: true }
    );
    this.sendSessionMessage(message);
    return response;
  }

  // ============================================================================
  // Agent Lifecycle
  // ============================================================================

  async createAgent(options: CreateAgentRequestOptions): Promise<AgentSnapshotPayload> {
    const requestId = this.createRequestId(options.requestId);
    const config = resolveAgentConfig(options);

    const message = SessionInboundMessageSchema.parse({
      type: "create_agent_request",
      requestId,
      config,
      ...(options.initialPrompt ? { initialPrompt: options.initialPrompt } : {}),
      ...(options.images && options.images.length > 0
        ? { images: options.images }
        : {}),
      ...(options.git ? { git: options.git } : {}),
      ...(options.worktreeName ? { worktreeName: options.worktreeName } : {}),
    });

    const statusPromise = this.waitFor(
      (msg) => {
        if (msg.type !== "status") {
          return null;
        }
        const created = AgentCreatedStatusPayloadSchema.safeParse(msg.payload);
        if (created.success && created.data.requestId === requestId) {
          return created.data;
        }
        const failed = AgentCreateFailedStatusPayloadSchema.safeParse(msg.payload);
        if (failed.success && failed.data.requestId === requestId) {
          return failed.data;
        }
        return null;
      },
      15000,
      { skipQueue: true }
    );

    this.sendSessionMessage(message);
    const status = await statusPromise;
    if (status.status === "agent_create_failed") {
      throw new Error(status.error);
    }

    return this.waitForAgentState(
      status.agentId,
      (snapshot) => snapshot.status === "idle",
      60000
    );
  }

  async createAgentExpectFail(
    options: CreateAgentRequestOptions
  ): Promise<AgentCreateFailedStatusPayload> {
    const requestId = this.createRequestId(options.requestId);
    const config = resolveAgentConfig(options);

    const message = SessionInboundMessageSchema.parse({
      type: "create_agent_request",
      requestId,
      config,
      ...(options.initialPrompt ? { initialPrompt: options.initialPrompt } : {}),
    });

    const response = this.waitFor(
      (msg) => {
        if (msg.type !== "status") {
          return null;
        }
        const failed = AgentCreateFailedStatusPayloadSchema.safeParse(msg.payload);
        if (failed.success && failed.data.requestId === requestId) {
          return failed.data;
        }
        return null;
      },
      10000,
      { skipQueue: true }
    );

    this.sendSessionMessage(message);
    return response;
  }

  async deleteAgent(agentId: string): Promise<void> {
    const requestId = this.createRequestId();
    const message = SessionInboundMessageSchema.parse({
      type: "delete_agent_request",
      agentId,
      requestId,
    });
    const response = this.waitFor(
      (msg) => {
        if (msg.type !== "agent_deleted") {
          return null;
        }
        if (msg.payload.requestId !== requestId) {
          return null;
        }
        return msg.payload;
      },
      10000,
      { skipQueue: true }
    );
    this.sendSessionMessage(message);
    await response;
  }

  listAgents(): AgentSnapshotPayload[] {
    return Array.from(this.agentIndex.values());
  }

  getMessageQueue(): SessionOutboundMessage[] {
    return [...this.messageQueue];
  }

  clearMessageQueue(): void {
    this.messageQueue = [];
  }

  async resumeAgent(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>
  ): Promise<AgentSnapshotPayload> {
    const requestId = this.createRequestId();
    const message = SessionInboundMessageSchema.parse({
      type: "resume_agent_request",
      requestId,
      handle,
      ...(overrides ? { overrides } : {}),
    });

    const statusPromise = this.waitFor(
      (msg) => {
        if (msg.type !== "status") {
          return null;
        }
        const resumed = AgentResumedStatusPayloadSchema.safeParse(msg.payload);
        if (resumed.success && resumed.data.requestId === requestId) {
          return resumed.data;
        }
        return null;
      },
      15000,
      { skipQueue: true }
    );

    this.sendSessionMessage(message);
    const status = await statusPromise;

    return this.waitForAgentState(
      status.agentId,
      (snapshot) => snapshot.status === "idle",
      60000
    );
  }

  async refreshAgent(
    agentId: string,
    requestId?: string
  ): Promise<AgentRefreshedStatusPayload> {
    const resolvedRequestId = this.createRequestId(requestId);
    const message = SessionInboundMessageSchema.parse({
      type: "refresh_agent_request",
      agentId,
      requestId: resolvedRequestId,
    });
    const response = this.waitFor(
      (msg) => {
        if (msg.type !== "status") {
          return null;
        }
        const refreshed = AgentRefreshedStatusPayloadSchema.safeParse(msg.payload);
        if (refreshed.success && refreshed.data.requestId === resolvedRequestId) {
          return refreshed.data;
        }
        return null;
      },
      15000,
      { skipQueue: true }
    );
    this.sendSessionMessage(message);
    return response;
  }

  async initializeAgent(
    agentId: string,
    requestId?: string
  ): Promise<AgentSnapshotPayload> {
    const resolvedRequestId = this.createRequestId(requestId);
    const message = SessionInboundMessageSchema.parse({
      type: "initialize_agent_request",
      agentId,
      requestId: resolvedRequestId,
    });
    const response = this.waitFor(
      (msg) => {
        if (msg.type !== "initialize_agent_request") {
          return null;
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null;
        }
        return msg.payload;
      },
      10000,
      { skipQueue: true }
    );
    this.sendSessionMessage(message);
    const payload = await response;
    if (payload.error) {
      throw new Error(payload.error);
    }
    return this.waitForAgentState(agentId, () => true, 10000);
  }

  // ============================================================================
  // Agent Interaction
  // ============================================================================

  async sendAgentMessage(
    agentId: string,
    text: string,
    options?: SendMessageOptions
  ): Promise<void> {
    const messageId = options?.messageId ?? crypto.randomUUID();
    const message = SessionInboundMessageSchema.parse({
      type: "send_agent_message",
      agentId,
      text,
      messageId,
      images: options?.images,
    });
    this.sendSessionMessage(message);
  }

  async sendMessage(
    agentId: string,
    text: string,
    options?: SendMessageOptions
  ): Promise<void> {
    await this.sendAgentMessage(agentId, text, options);
  }

  async transcribeAudio(
    options: TranscribeAudioOptions
  ): Promise<TranscriptionResultPayload> {
    const requestId = this.createRequestId();
    const timeout = options.timeout ?? 120000;

    const responsePromise = this.waitFor(
      (msg) => {
        if (msg.type !== "transcription_result") {
          return null;
        }
        if (msg.payload.requestId !== requestId) {
          return null;
        }
        return msg.payload;
      },
      timeout,
      { skipQueue: true }
    );

    const message = SessionInboundMessageSchema.parse({
      type: "transcribe_audio_request",
      audio: options.audio,
      format: options.format,
      requestId,
    });
    this.sendSessionMessage(message);

    return responsePromise;
  }

  async cancelAgent(agentId: string): Promise<void> {
    this.sendSessionMessage({ type: "cancel_agent_request", agentId });
  }

  async setAgentMode(agentId: string, modeId: string): Promise<void> {
    this.sendSessionMessage({ type: "set_agent_mode", agentId, modeId });
  }

  async restartServer(
    reason?: string,
    requestId?: string
  ): Promise<RestartRequestedStatusPayload> {
    const resolvedRequestId = this.createRequestId(requestId);
    const message = SessionInboundMessageSchema.parse({
      type: "restart_server_request",
      ...(reason && reason.trim().length > 0 ? { reason } : {}),
      requestId: resolvedRequestId,
    });

    const response = this.waitFor(
      (msg) => {
        if (msg.type !== "status") {
          return null;
        }
        const restarted = RestartRequestedStatusPayloadSchema.safeParse(
          msg.payload
        );
        if (!restarted.success) {
          return null;
        }
        if (restarted.data.requestId !== resolvedRequestId) {
          return null;
        }
        return restarted.data;
      },
      10000,
      { skipQueue: true }
    );

    this.sendSessionMessage(message);
    return response;
  }

  // ============================================================================
  // Audio / Realtime
  // ============================================================================

  async setRealtimeMode(enabled: boolean): Promise<void> {
    this.sendSessionMessage({ type: "set_realtime_mode", enabled });
  }

  async sendRealtimeAudioChunk(
    audio: string,
    format: string,
    isLast: boolean
  ): Promise<void> {
    this.sendSessionMessage({ type: "realtime_audio_chunk", audio, format, isLast });
  }

  async abortRequest(): Promise<void> {
    this.sendSessionMessage({ type: "abort_request" });
  }

  async audioPlayed(id: string): Promise<void> {
    this.sendSessionMessage({ type: "audio_played", id });
  }

  // ============================================================================
  // Git Operations
  // ============================================================================

  async getGitDiff(
    agentId: string,
    requestId?: string
  ): Promise<GitDiffPayload> {
    const resolvedRequestId = this.createRequestId(requestId);
    const message = SessionInboundMessageSchema.parse({
      type: "git_diff_request",
      agentId,
      requestId: resolvedRequestId,
    });
    const response = this.waitFor(
      (msg) => {
        if (msg.type !== "git_diff_response") {
          return null;
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null;
        }
        return msg.payload;
      },
      10000,
      { skipQueue: true }
    );
    this.sendSessionMessage(message);
    return response;
  }

  async getHighlightedDiff(
    agentId: string,
    requestId?: string
  ): Promise<HighlightedDiffPayload> {
    const resolvedRequestId = this.createRequestId(requestId);
    const message = SessionInboundMessageSchema.parse({
      type: "highlighted_diff_request",
      agentId,
      requestId: resolvedRequestId,
    });
    const response = this.waitFor(
      (msg) => {
        if (msg.type !== "highlighted_diff_response") {
          return null;
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null;
        }
        return msg.payload;
      },
      10000,
      { skipQueue: true }
    );
    this.sendSessionMessage(message);
    return response;
  }

  async getGitRepoInfo(
    input: string | { cwd: string } | { agentId: string },
    requestId?: string
  ): Promise<GitRepoInfoPayload> {
    const normalizedInput =
      typeof input === "string" ? { agentId: input } : input;
    const resolvedRequestId = this.createRequestId(requestId);
    const cwd =
      "cwd" in normalizedInput
        ? normalizedInput.cwd
        : this.listAgents().find((agent) => agent.id === normalizedInput.agentId)
            ?.cwd;

    if (!cwd) {
      return {
        cwd: "cwd" in normalizedInput ? normalizedInput.cwd : "",
        repoRoot: "",
        requestId: resolvedRequestId,
        error: `Agent not found: ${
          "agentId" in normalizedInput ? normalizedInput.agentId : ""
        }`,
      };
    }

    const message = SessionInboundMessageSchema.parse({
      type: "git_repo_info_request",
      cwd,
      requestId: resolvedRequestId,
    });
    const response = this.waitFor(
      (msg) => {
        if (msg.type !== "git_repo_info_response") {
          return null;
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null;
        }
        return msg.payload;
      },
      10000,
      { skipQueue: true }
    );
    this.sendSessionMessage(message);
    return response;
  }

  // ============================================================================
  // File Explorer
  // ============================================================================

  async exploreFileSystem(
    agentId: string,
    path: string,
    mode: "list" | "file" = "list",
    requestId?: string
  ): Promise<FileExplorerPayload> {
    const resolvedRequestId = this.createRequestId(requestId);
    const message = SessionInboundMessageSchema.parse({
      type: "file_explorer_request",
      agentId,
      path,
      mode,
      requestId: resolvedRequestId,
    });
    const response = this.waitFor(
      (msg) => {
        if (msg.type !== "file_explorer_response") {
          return null;
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null;
        }
        return msg.payload;
      },
      10000,
      { skipQueue: true }
    );
    this.sendSessionMessage(message);
    return response;
  }

  async requestDownloadToken(
    agentId: string,
    path: string,
    requestId?: string
  ): Promise<FileDownloadTokenPayload> {
    const resolvedRequestId = this.createRequestId(requestId);
    const message = SessionInboundMessageSchema.parse({
      type: "file_download_token_request",
      agentId,
      path,
      requestId: resolvedRequestId,
    });
    const response = this.waitFor(
      (msg) => {
        if (msg.type !== "file_download_token_response") {
          return null;
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null;
        }
        return msg.payload;
      },
      10000,
      { skipQueue: true }
    );
    this.sendSessionMessage(message);
    return response;
  }

  // ============================================================================
  // Provider Models / Commands
  // ============================================================================

  async listProviderModels(
    provider: AgentProvider,
    options?: { cwd?: string; requestId?: string }
  ): Promise<ListProviderModelsPayload> {
    const resolvedRequestId = this.createRequestId(options?.requestId);
    const message = SessionInboundMessageSchema.parse({
      type: "list_provider_models_request",
      provider,
      cwd: options?.cwd,
      requestId: resolvedRequestId,
    });
    const response = this.waitFor(
      (msg) => {
        if (msg.type !== "list_provider_models_response") {
          return null;
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null;
        }
        return msg.payload;
      },
      30000,
      { skipQueue: true }
    );
    this.sendSessionMessage(message);
    return response;
  }

  async listCommands(
    agentId: string,
    requestId?: string
  ): Promise<ListCommandsPayload> {
    const resolvedRequestId = this.createRequestId(requestId);
    const message = SessionInboundMessageSchema.parse({
      type: "list_commands_request",
      agentId,
      requestId: resolvedRequestId,
    });
    const response = this.waitFor(
      (msg) => {
        if (msg.type !== "list_commands_response") {
          return null;
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null;
        }
        return msg.payload;
      },
      30000,
      { skipQueue: true }
    );
    this.sendSessionMessage(message);
    return response;
  }

  // ============================================================================
  // Permissions
  // ============================================================================

  async respondToPermission(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse
  ): Promise<void> {
    this.sendSessionMessage({
      type: "agent_permission_response",
      agentId,
      requestId,
      response,
    });
  }

  async respondToPermissionAndWait(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
    timeout = 15000
  ): Promise<AgentPermissionResolvedPayload> {
    const message = SessionInboundMessageSchema.parse({
      type: "agent_permission_response",
      agentId,
      requestId,
      response,
    });
    const resolved = this.waitFor(
      (msg) => {
        if (msg.type !== "agent_permission_resolved") {
          return null;
        }
        if (msg.payload.requestId !== requestId) {
          return null;
        }
        if (msg.payload.agentId !== agentId) {
          return null;
        }
        return msg.payload;
      },
      timeout,
      { skipQueue: true }
    );
    this.sendSessionMessage(message);
    return resolved;
  }

  // ============================================================================
  // Waiting / Streaming Helpers
  // ============================================================================

  async waitForAgentState(
    agentId: string,
    predicate: (snapshot: AgentSnapshotPayload) => boolean,
    timeout = 60000
  ): Promise<AgentSnapshotPayload> {
    const current = this.agentIndex.get(agentId);
    if (current && predicate(current)) {
      return current;
    }
    return this.waitFor(
      (msg) => {
        if (msg.type === "agent_state" && msg.payload.id === agentId) {
          if (predicate(msg.payload)) {
            return msg.payload;
          }
        }
        return null;
      },
      timeout,
      { skipQueue: true }
    );
  }

  async waitForAgentIdle(
    agentId: string,
    timeout = 60000
  ): Promise<AgentSnapshotPayload> {
    const current = this.agentIndex.get(agentId);
    const pendingPermissionIds = new Set<string>();
    if (current?.pendingPermissions) {
      for (const request of current.pendingPermissions) {
        pendingPermissionIds.add(request.id);
      }
    }

    // Track whether we've seen a running state. Important: we only set this
    // when we see running IN THE QUEUE, not based on current state. This prevents
    // finding old idle states that occurred before the current run started.
    let sawRunningInQueue = false;
    let queuedIdle: AgentSnapshotPayload | null = null;

    const updatePendingPermissions = (msg: SessionOutboundMessage): void => {
      if (
        msg.type === "agent_permission_request" &&
        msg.payload.agentId === agentId
      ) {
        pendingPermissionIds.add(msg.payload.request.id);
        return;
      }
      if (
        msg.type === "agent_permission_resolved" &&
        msg.payload.agentId === agentId
      ) {
        pendingPermissionIds.delete(msg.payload.requestId);
        return;
      }
      if (msg.type === "agent_stream" && msg.payload.agentId === agentId) {
        if (msg.payload.event.type === "permission_requested") {
          pendingPermissionIds.add(msg.payload.event.request.id);
        } else if (msg.payload.event.type === "permission_resolved") {
          pendingPermissionIds.delete(msg.payload.event.requestId);
        }
      }
    };

    for (const msg of this.messageQueue) {
      updatePendingPermissions(msg);
      if (msg.type !== "agent_state" || msg.payload.id !== agentId) {
        continue;
      }
      const status = msg.payload.status;
      const hasPendingPermissions =
        (msg.payload.pendingPermissions?.length ?? 0) > 0 ||
        pendingPermissionIds.size > 0;
      if (status === "running" || hasPendingPermissions) {
        sawRunningInQueue = true;
        queuedIdle = null; // Reset: any previous idle was before this run
      }
      if (
        sawRunningInQueue &&
        (status === "idle" || status === "error") &&
        !hasPendingPermissions
      ) {
        queuedIdle = msg.payload;
      }
    }
    if (queuedIdle) {
      return queuedIdle;
    }

    // If current state is running (or has pending permissions), we need to wait
    // for the next idle. If current is already idle and we didn't see running
    // in the queue, this is an edge case - the agent might not have started yet
    // or was already idle. Use the current state's running status to seed the waiter.
    let sawRunning =
      sawRunningInQueue ||
      current?.status === "running" ||
      pendingPermissionIds.size > 0;

    return this.waitFor(
      (msg) => {
        updatePendingPermissions(msg);
        if (msg.type === "agent_state" && msg.payload.id === agentId) {
          const status = msg.payload.status;
          const hasPendingPermissions =
            (msg.payload.pendingPermissions?.length ?? 0) > 0 ||
            pendingPermissionIds.size > 0;
          if (status === "running" || hasPendingPermissions) {
            sawRunning = true;
          }
          if (
            sawRunning &&
            (status === "idle" || status === "error") &&
            !hasPendingPermissions
          ) {
            return msg.payload;
          }
        }
        return null;
      },
      timeout,
      { skipQueue: true }
    );
  }

  async waitForPermission(
    agentId: string,
    timeout = 30000
  ): Promise<AgentPermissionRequest> {
    const snapshotPending = this.agentIndex.get(agentId)?.pendingPermissions?.[0];
    if (snapshotPending) {
      return snapshotPending;
    }

    let queuedRequest: AgentPermissionRequest | null = null;
    const pendingById = new Map<string, AgentPermissionRequest>();
    for (const msg of this.messageQueue) {
      if (
        msg.type === "agent_permission_request" &&
        msg.payload.agentId === agentId
      ) {
        pendingById.set(msg.payload.request.id, msg.payload.request);
        queuedRequest = msg.payload.request;
        continue;
      }
      if (msg.type === "agent_permission_resolved") {
        if (msg.payload.agentId === agentId) {
          pendingById.delete(msg.payload.requestId);
          if (queuedRequest?.id === msg.payload.requestId) {
            queuedRequest = null;
          }
        }
        continue;
      }
      if (msg.type === "agent_stream" && msg.payload.agentId === agentId) {
        if (msg.payload.event.type === "permission_requested") {
          pendingById.set(
            msg.payload.event.request.id,
            msg.payload.event.request
          );
          queuedRequest = msg.payload.event.request;
          continue;
        }
        if (msg.payload.event.type === "permission_resolved") {
          pendingById.delete(msg.payload.event.requestId);
          if (queuedRequest?.id === msg.payload.event.requestId) {
            queuedRequest = null;
          }
        }
      }
    }

    if (queuedRequest && pendingById.has(queuedRequest.id)) {
      return queuedRequest;
    }
    if (pendingById.size > 0) {
      let mostRecent: AgentPermissionRequest | null = null;
      for (const request of pendingById.values()) {
        mostRecent = request;
      }
      if (mostRecent) {
        return mostRecent;
      }
    }

    return this.waitFor(
      (msg) => {
        if (
          msg.type === "agent_permission_request" &&
          msg.payload.agentId === agentId
        ) {
          return msg.payload.request;
        }
        if (msg.type === "agent_stream" && msg.payload.agentId === agentId) {
          if (msg.payload.event.type === "permission_requested") {
            return msg.payload.event.request;
          }
        }
        return null;
      },
      timeout,
      { skipQueue: true }
    );
  }

  // ============================================================================
  // Terminals
  // ============================================================================

  async listTerminals(
    cwd: string,
    requestId?: string
  ): Promise<ListTerminalsPayload> {
    const resolvedRequestId = this.createRequestId(requestId);
    const message = SessionInboundMessageSchema.parse({
      type: "list_terminals_request",
      cwd,
      requestId: resolvedRequestId,
    });
    const response = this.waitFor(
      (msg) => {
        if (msg.type !== "list_terminals_response") {
          return null;
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null;
        }
        return msg.payload;
      },
      10000,
      { skipQueue: true }
    );
    this.sendSessionMessage(message);
    return response;
  }

  async createTerminal(
    cwd: string,
    name?: string,
    requestId?: string
  ): Promise<CreateTerminalPayload> {
    const resolvedRequestId = this.createRequestId(requestId);
    const message = SessionInboundMessageSchema.parse({
      type: "create_terminal_request",
      cwd,
      name,
      requestId: resolvedRequestId,
    });
    const response = this.waitFor(
      (msg) => {
        if (msg.type !== "create_terminal_response") {
          return null;
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null;
        }
        return msg.payload;
      },
      10000,
      { skipQueue: true }
    );
    this.sendSessionMessage(message);
    return response;
  }

  async subscribeTerminal(
    terminalId: string,
    requestId?: string
  ): Promise<SubscribeTerminalPayload> {
    const resolvedRequestId = this.createRequestId(requestId);
    const message = SessionInboundMessageSchema.parse({
      type: "subscribe_terminal_request",
      terminalId,
      requestId: resolvedRequestId,
    });
    const response = this.waitFor(
      (msg) => {
        if (msg.type !== "subscribe_terminal_response") {
          return null;
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null;
        }
        return msg.payload;
      },
      10000,
      { skipQueue: true }
    );
    this.sendSessionMessage(message);
    return response;
  }

  unsubscribeTerminal(terminalId: string): void {
    this.sendSessionMessage({
      type: "unsubscribe_terminal_request",
      terminalId,
    });
  }

  sendTerminalInput(
    terminalId: string,
    message: TerminalInput["message"]
  ): void {
    this.sendSessionMessage({
      type: "terminal_input",
      terminalId,
      message,
    });
  }

  async killTerminal(
    terminalId: string,
    requestId?: string
  ): Promise<KillTerminalPayload> {
    const resolvedRequestId = this.createRequestId(requestId);
    const message = SessionInboundMessageSchema.parse({
      type: "kill_terminal_request",
      terminalId,
      requestId: resolvedRequestId,
    });
    const response = this.waitFor(
      (msg) => {
        if (msg.type !== "kill_terminal_response") {
          return null;
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null;
        }
        return msg.payload;
      },
      10000,
      { skipQueue: true }
    );
    this.sendSessionMessage(message);
    return response;
  }

  async waitForTerminalOutput(
    terminalId: string,
    timeout = 5000
  ): Promise<TerminalOutputPayload> {
    return this.waitFor(
      (msg) => {
        if (msg.type !== "terminal_output") {
          return null;
        }
        if (msg.payload.terminalId !== terminalId) {
          return null;
        }
        return msg.payload;
      },
      timeout,
      { skipQueue: true }
    );
  }

  // ============================================================================
  // Internals
  // ============================================================================

  private createRequestId(requestId?: string): string {
    return requestId ?? crypto.randomUUID();
  }

  private cleanupTransport(): void {
    for (const cleanup of this.transportCleanup) {
      try {
        cleanup();
      } catch {
        // no-op
      }
    }
    this.transportCleanup = [];
  }

  private handleTransportMessage(data: unknown): void {
    const rawData =
      data && typeof data === "object" && "data" in data
        ? (data as { data: unknown }).data
        : data;
    const payload = decodeMessageData(rawData);
    if (!payload) {
      return;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(payload);
    } catch {
      return;
    }

    const parsed = WSOutboundMessageSchema.safeParse(parsedJson);
    if (!parsed.success) {
      const msgType = (parsedJson as { message?: { type?: string } })?.message?.type ?? "unknown";
      this.logger.warn({ msgType, error: parsed.error.message }, "Message validation failed");
      return;
    }

    if (parsed.data.type === "pong") {
      return;
    }

    this.handleSessionMessage(parsed.data.message);
  }

  private updateConnectionState(next: ConnectionState): void {
    this.connectionState = next;
    for (const listener of this.connectionListeners) {
      try {
        listener(next);
      } catch {
        // no-op
      }
    }
  }

  private scheduleReconnect(reason?: string): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (!this.shouldReconnect || this.config.reconnect?.enabled === false) {
      this.rejectConnect(
        new Error(reason ?? "Transport disconnected before connect")
      );
      return;
    }

    const attempt = this.reconnectAttempt;
    const baseDelay =
      this.config.reconnect?.baseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS;
    const maxDelay =
      this.config.reconnect?.maxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
    const delay = Math.min(baseDelay * 2 ** attempt, maxDelay);
    this.reconnectAttempt = attempt + 1;

    if (typeof reason === "string" && reason.trim().length > 0) {
      this.lastErrorValue = reason.trim();
    }

    this.updateConnectionState({
      status: "disconnected",
      ...(reason ? { reason } : {}),
    });
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      if (!this.shouldReconnect) {
        return;
      }
      this.attemptConnect();
    }, delay);
  }

  private handleSessionMessage(msg: SessionOutboundMessage): void {
    if (msg.type === "conversation_loaded") {
      this.conversationId = msg.payload.conversationId;
    }

    if (msg.type === "session_state") {
      this.agentIndex = new Map(
        msg.payload.agents.map((agent) => [agent.id, agent])
      );
    } else if (msg.type === "agent_state") {
      this.agentIndex.set(msg.payload.id, msg.payload);
    } else if (msg.type === "agent_deleted") {
      this.agentIndex.delete(msg.payload.agentId);
    }

    if (this.messageQueueLimit !== 0) {
      this.messageQueue.push(msg);
      if (
        this.messageQueueLimit !== null &&
        this.messageQueue.length > this.messageQueueLimit
      ) {
        this.messageQueue.splice(
          0,
          this.messageQueue.length - this.messageQueueLimit
        );
      }
    }

    const handlers = this.messageHandlers.get(msg.type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(msg);
        } catch {
          // no-op
        }
      }
    }

    const event = this.toEvent(msg);
    if (event) {
      for (const handler of this.eventListeners) {
        handler(event);
      }
    }

    this.resolveWaiters(msg);
  }

  private resolveWaiters(msg: SessionOutboundMessage): void {
    for (const waiter of Array.from(this.waiters)) {
      const result = waiter.predicate(msg);
      if (result !== null) {
        this.waiters.delete(waiter);
        if (waiter.timeoutHandle) {
          clearTimeout(waiter.timeoutHandle);
        }
        waiter.resolve(result);
      }
    }
  }

  private clearWaiters(error: Error): void {
    for (const waiter of Array.from(this.waiters)) {
      if (waiter.timeoutHandle) {
        clearTimeout(waiter.timeoutHandle);
      }
      waiter.reject(error);
    }
    this.waiters.clear();
  }

  private toEvent(msg: SessionOutboundMessage): DaemonEvent | null {
    switch (msg.type) {
      case "agent_state":
        return {
          type: "agent_state",
          agentId: msg.payload.id,
          payload: msg.payload,
        };
      case "agent_stream":
        return {
          type: "agent_stream",
          agentId: msg.payload.agentId,
          event: msg.payload.event,
          timestamp: msg.payload.timestamp,
        };
      case "session_state":
        return { type: "session_state", agents: msg.payload.agents };
      case "status":
        return { type: "status", payload: msg.payload };
      case "agent_deleted":
        return { type: "agent_deleted", agentId: msg.payload.agentId };
      case "agent_permission_request":
        return {
          type: "agent_permission_request",
          agentId: msg.payload.agentId,
          request: msg.payload.request,
        };
      case "agent_permission_resolved":
        return {
          type: "agent_permission_resolved",
          agentId: msg.payload.agentId,
          requestId: msg.payload.requestId,
          resolution: msg.payload.resolution,
        };
      default:
        return null;
    }
  }

  private async waitFor<T>(
    predicate: (msg: SessionOutboundMessage) => T | null,
    timeout = 30000,
    options?: { skipQueue?: boolean }
  ): Promise<T> {
    if (!options?.skipQueue && this.messageQueue.length > 0) {
      for (const msg of this.messageQueue) {
        const result = predicate(msg);
        if (result !== null) {
          return result;
        }
      }
    }

    return new Promise((resolve, reject) => {
      const timeoutHandle =
        timeout > 0
          ? setTimeout(() => {
              this.waiters.delete(waiter);
              reject(new Error(`Timeout waiting for message (${timeout}ms)`));
            }, timeout)
          : null;

      const waiter: Waiter<T> = {
        predicate,
        resolve,
        reject,
        timeoutHandle,
      };
      this.waiters.add(waiter);
    });
  }
}

// ============================================================================
// Helpers
// ============================================================================

function defaultWebSocketFactory(
  url: string,
  _options?: { headers?: Record<string, string> }
): WebSocketLike {
  const globalWs = (globalThis as { WebSocket?: any }).WebSocket;
  if (!globalWs) {
    throw new Error("WebSocket is not available in this runtime");
  }
  return new globalWs(url);
}

function createWebSocketTransportFactory(
  factory: WebSocketFactory
): DaemonTransportFactory {
  return ({ url, headers }) => {
    const ws = factory(url, { headers });
    return {
      send: (data) => ws.send(data),
      close: (code?: number, reason?: string) => ws.close(code, reason),
      onOpen: (handler) => bindWsHandler(ws, "open", handler),
      onClose: (handler) => bindWsHandler(ws, "close", handler),
      onError: (handler) => bindWsHandler(ws, "error", handler),
      onMessage: (handler) => bindWsHandler(ws, "message", handler),
    };
  };
}

function bindWsHandler(
  ws: WebSocketLike,
  event: "open" | "close" | "error" | "message",
  handler: (...args: any[]) => void
): () => void {
  if (typeof ws.addEventListener === "function") {
    ws.addEventListener(event, handler);
    return () => {
      if (typeof ws.removeEventListener === "function") {
        ws.removeEventListener(event, handler);
      }
    };
  }
  if (typeof ws.on === "function") {
    ws.on(event, handler);
    return () => {
      if (typeof ws.off === "function") {
        ws.off(event, handler);
        return;
      }
      if (typeof ws.removeListener === "function") {
        ws.removeListener(event, handler);
      }
    };
  }
  const prop = `on${event}` as "onopen" | "onclose" | "onerror" | "onmessage";
  const previous = (ws as any)[prop];
  (ws as any)[prop] = handler;
  return () => {
    if ((ws as any)[prop] === handler) {
      (ws as any)[prop] = previous ?? null;
    }
  };
}

function describeTransportClose(event?: unknown): string {
  if (!event) {
    return "Transport closed";
  }
  if (event instanceof Error) {
    return event.message;
  }
  if (typeof event === "string") {
    return event;
  }
  if (typeof event === "object") {
    const record = event as { reason?: unknown; message?: unknown; code?: unknown };
    if (typeof record.reason === "string" && record.reason.trim().length > 0) {
      return record.reason.trim();
    }
    if (typeof record.message === "string" && record.message.trim().length > 0) {
      return record.message.trim();
    }
    if (typeof record.code === "number") {
      return `Transport closed (code ${record.code})`;
    }
  }
  return "Transport closed";
}

function describeTransportError(event?: unknown): string {
  if (!event) {
    return "Transport error";
  }
  if (event instanceof Error) {
    return event.message;
  }
  if (typeof event === "string") {
    return event;
  }
  if (typeof event === "object") {
    const record = event as { message?: unknown };
    if (typeof record.message === "string" && record.message.trim().length > 0) {
      return record.message.trim();
    }
  }
  return "Transport error";
}

function decodeMessageData(data: unknown): string | null {
  if (data === null || data === undefined) {
    return null;
  }
  if (typeof data === "string") {
    return data;
  }
  if (typeof ArrayBuffer !== "undefined" && data instanceof ArrayBuffer) {
    if (typeof Buffer !== "undefined") {
      return Buffer.from(data).toString("utf8");
    }
    if (typeof TextDecoder !== "undefined") {
      return new TextDecoder().decode(data);
    }
  }
  if (ArrayBuffer.isView(data)) {
    const view = new Uint8Array(
      data.buffer,
      data.byteOffset,
      data.byteLength
    );
    if (typeof Buffer !== "undefined") {
      return Buffer.from(view).toString("utf8");
    }
    if (typeof TextDecoder !== "undefined") {
      return new TextDecoder().decode(view);
    }
  }
  if (typeof (data as { toString?: () => string }).toString === "function") {
    return (data as { toString: () => string }).toString();
  }
  return null;
}

function resolveAgentConfig(options: CreateAgentRequestOptions): AgentSessionConfig {
  const {
    config,
    provider,
    cwd,
    initialPrompt: _initialPrompt,
    images: _images,
    git: _git,
    worktreeName: _worktreeName,
    requestId: _requestId,
    ...overrides
  } = options;

  const baseConfig: Partial<AgentSessionConfig> = {
    ...(provider ? { provider } : {}),
    ...(cwd ? { cwd } : {}),
    ...overrides,
  };

  const merged = config ? { ...baseConfig, ...config } : baseConfig;

  if (!merged.provider || !merged.cwd) {
    throw new Error("createAgent requires provider and cwd");
  }

  if (!merged.modeId) {
    merged.modeId = getAgentProviderDefinition(merged.provider).defaultModeId ?? undefined;
  }

  return {
    ...merged,
    provider: merged.provider,
    cwd: merged.cwd,
  };
}
