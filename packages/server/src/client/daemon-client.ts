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
  CreateAgentRequestMessage,
  FileDownloadTokenResponse,
  FileExplorerResponse,
  GitSetupOptions,
  CheckoutStatusResponse,
  CheckoutCommitResponse,
  CheckoutMergeResponse,
  CheckoutMergeFromBaseResponse,
  CheckoutPushResponse,
  CheckoutPrCreateResponse,
  CheckoutPrStatusResponse,
  ValidateBranchResponse,
  BranchSuggestionsResponse,
  PaseoWorktreeListResponse,
  PaseoWorktreeArchiveResponse,
  ProjectIconResponse,
  ListCommandsResponse,
  ExecuteCommandResponse,
  ListProviderModelsResponseMessage,
  ListAvailableProvidersResponse,
  SpeechModelsListResponse,
  SpeechModelsDownloadResponse,
  ListTerminalsResponse,
  CreateTerminalResponse,
  SubscribeTerminalResponse,
  TerminalOutput,
  KillTerminalResponse,
  TerminalInput,
  SessionInboundMessage,
  SessionOutboundMessage,
} from "../shared/messages.js";
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentProvider,
  AgentSessionConfig,
} from "../server/agent/agent-sdk-types.js";
import { getAgentProviderDefinition } from "../server/agent/provider-manifest.js";
import {
  createClientChannel,
  type EncryptedChannel,
  type Transport as RelayTransport,
} from "@getpaseo/relay/e2ee";
import { isRelayClientWebSocketUrl } from "../shared/daemon-endpoints.js";

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
  | {
      type: "agent_update";
      agentId: string;
      payload: Extract<SessionOutboundMessage, { type: "agent_update" }>["payload"];
    }
  | {
      type: "agent_stream";
      agentId: string;
      event: AgentStreamEventPayload;
      timestamp: string;
    }
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

export type DaemonClientConfig = {
  url: string;
  authHeader?: string;
  suppressSendErrors?: boolean;
  transportFactory?: DaemonTransportFactory;
  webSocketFactory?: WebSocketFactory;
  logger?: Logger;
  e2ee?: {
    enabled?: boolean;
    daemonPublicKeyB64?: string;
  };
  reconnect?: {
    enabled?: boolean;
    baseDelayMs?: number;
    maxDelayMs?: number;
  };
};

export type SendMessageOptions = {
  messageId?: string;
  images?: Array<{ data: string; mimeType: string }>;
};

type AgentConfigOverrides = Partial<Omit<AgentSessionConfig, "provider" | "cwd">>;

export type CreateAgentRequestOptions = {
  config?: AgentSessionConfig;
  provider?: AgentProvider;
  cwd?: string;
  initialPrompt?: string;
  outputSchema?: Record<string, unknown>;
  images?: CreateAgentRequestMessage["images"];
  git?: GitSetupOptions;
  worktreeName?: string;
  requestId?: string;
  labels?: Record<string, string>;
} & AgentConfigOverrides;

type CheckoutStatusPayload = CheckoutStatusResponse["payload"];
type SubscribeCheckoutDiffPayload = Extract<
  SessionOutboundMessage,
  { type: "subscribe_checkout_diff_response" }
>["payload"];
type CheckoutDiffPayload = Omit<SubscribeCheckoutDiffPayload, "subscriptionId">;
type CheckoutCommitPayload = CheckoutCommitResponse["payload"];
type CheckoutMergePayload = CheckoutMergeResponse["payload"];
type CheckoutMergeFromBasePayload = CheckoutMergeFromBaseResponse["payload"];
type CheckoutPushPayload = CheckoutPushResponse["payload"];
type CheckoutPrCreatePayload = CheckoutPrCreateResponse["payload"];
type CheckoutPrStatusPayload = CheckoutPrStatusResponse["payload"];
type ValidateBranchPayload = ValidateBranchResponse["payload"];
type BranchSuggestionsPayload = BranchSuggestionsResponse["payload"];
type PaseoWorktreeListPayload = PaseoWorktreeListResponse["payload"];
type PaseoWorktreeArchivePayload = PaseoWorktreeArchiveResponse["payload"];
type FileExplorerPayload = FileExplorerResponse["payload"];
type FileDownloadTokenPayload = FileDownloadTokenResponse["payload"];
type ListProviderModelsPayload = ListProviderModelsResponseMessage["payload"];
type ListAvailableProvidersPayload = ListAvailableProvidersResponse["payload"];
type SpeechModelsListPayload = SpeechModelsListResponse["payload"];
type SpeechModelsDownloadPayload = SpeechModelsDownloadResponse["payload"];
type ListCommandsPayload = ListCommandsResponse["payload"];
type ExecuteCommandPayload = ExecuteCommandResponse["payload"];
type SetVoiceModePayload = Extract<
  SessionOutboundMessage,
  { type: "set_voice_mode_response" }
>["payload"];
type AgentPermissionResolvedPayload = AgentPermissionResolvedMessage["payload"];
type ListTerminalsPayload = ListTerminalsResponse["payload"];
type CreateTerminalPayload = CreateTerminalResponse["payload"];
type SubscribeTerminalPayload = SubscribeTerminalResponse["payload"];
type TerminalOutputPayload = TerminalOutput["payload"];
type KillTerminalPayload = KillTerminalResponse["payload"];

type AgentRefreshedStatusPayload = z.infer<
  typeof AgentRefreshedStatusPayloadSchema
>;
type RestartRequestedStatusPayload = z.infer<
  typeof RestartRequestedStatusPayloadSchema
>;
type FetchAgentsGroupedByProjectPayload = Extract<
  SessionOutboundMessage,
  { type: "fetch_agents_grouped_by_project_response" }
>["payload"];

export type WaitForFinishResult = {
  status: "idle" | "error" | "permission" | "timeout";
  final: AgentSnapshotPayload | null;
  error: string | null;
  lastMessage: string | null;
};

type Waiter<T> = {
  predicate: (msg: SessionOutboundMessage) => T | null;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
};

type WaitHandle<T> = {
  promise: Promise<T>;
  cancel: (error: Error) => void;
};

type RpcWaitResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "error"; error: DaemonRpcError };

class DaemonRpcError extends Error {
  readonly requestId: string;
  readonly requestType?: string;
  readonly code?: string;

  constructor(params: { requestId: string; error: string; requestType?: string; code?: string }) {
    super(params.error);
    this.name = "DaemonRpcError";
    this.requestId = params.requestId;
    this.requestType = params.requestType;
    this.code = params.code;
  }
}

const DEFAULT_RECONNECT_BASE_DELAY_MS = 1500;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30000;

/** Default timeout for waiting for connection before sending queued messages */
const DEFAULT_SEND_QUEUE_TIMEOUT_MS = 10000;

interface PendingSend {
  message: SessionInboundMessage;
  resolve: () => void;
  reject: (error: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

export class DaemonClient {
  private transport: DaemonTransport | null = null;
  private transportCleanup: Array<() => void> = [];
  private rawMessageListeners: Set<(message: SessionOutboundMessage) => void> = new Set();
  private messageHandlers: Map<
    SessionOutboundMessage["type"],
    Set<(message: SessionOutboundMessage) => void>
  > = new Map();
  private eventListeners: Set<DaemonEventHandler> = new Set();
  private waiters: Set<Waiter<any>> = new Set();
  private checkoutStatusInFlight: Map<string, Promise<CheckoutStatusPayload>> = new Map();
  private connectionListeners: Set<(status: ConnectionState) => void> =
    new Set();
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private pendingGenericTransportErrorTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private shouldReconnect = true;
  private connectPromise: Promise<void> | null = null;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((error: Error) => void) | null = null;
  private lastErrorValue: string | null = null;
  private connectionState: ConnectionState = { status: "idle" };
  private agentUpdateSubscriptions = new Map<
    string,
    { labels?: Record<string, string>; agentId?: string } | undefined
  >();
  private checkoutDiffSubscriptions = new Map<
    string,
    { cwd: string; compare: { mode: "uncommitted" | "base"; baseRef?: string } }
  >();
  private logger: Logger;
  private pendingSendQueue: PendingSend[] = [];
  private relayClientId: string | null = null;

  constructor(private config: DaemonClientConfig) {
    this.logger = config.logger ?? consoleLogger;
    // Relay requires a clientId so the daemon can create an independent
    // socket + E2EE channel per connected client. Generate one per DaemonClient
    // instance (stable across reconnects in this tab/app session).
    if (isRelayClientWebSocketUrl(this.config.url)) {
      try {
        const parsed = new URL(this.config.url);
        if (!parsed.searchParams.get("clientId")) {
          this.relayClientId = `clt_${safeRandomId()}`;
          parsed.searchParams.set("clientId", this.relayClientId);
          this.config.url = parsed.toString();
        }
      } catch {
        // ignore - invalid URL will be handled on connect
      }
    }
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

    try {
      // If we reconnect while the previous socket is still open (common in browsers
      // where `onerror` may fire before `onclose`), we can end up with multiple
      // concurrent relay sockets. Cloudflare then closes the old one with
      // "Replaced by new connection", causing a disconnect loop.
      this.disposeTransport();
      const baseTransportFactory =
        this.config.transportFactory ??
        createWebSocketTransportFactory(
          this.config.webSocketFactory ?? defaultWebSocketFactory
        );
      const shouldUseRelayE2ee =
        this.config.e2ee?.enabled === true &&
        isRelayClientWebSocketUrl(this.config.url);

      let transportFactory = baseTransportFactory;
      if (shouldUseRelayE2ee) {
        const daemonPublicKeyB64 = this.config.e2ee?.daemonPublicKeyB64;
        if (!daemonPublicKeyB64) {
          throw new Error("daemonPublicKeyB64 is required for relay E2EE");
        }
        transportFactory = createRelayE2eeTransportFactory({
          baseFactory: baseTransportFactory,
          daemonPublicKeyB64,
          logger: this.logger,
        });
      }
      const transport = transportFactory({ url: this.config.url, headers });
      this.transport = transport;

      this.updateConnectionState({
        status: "connecting",
        attempt: this.reconnectAttempt,
      });

      this.transportCleanup = [
        transport.onOpen(() => {
          if (this.pendingGenericTransportErrorTimeout) {
            clearTimeout(this.pendingGenericTransportErrorTimeout);
            this.pendingGenericTransportErrorTimeout = null;
          }
          this.lastErrorValue = null;
          this.reconnectAttempt = 0;
          this.updateConnectionState({ status: "connected" });
          this.resubscribeAgentUpdates();
          this.resubscribeCheckoutDiffSubscriptions();
          this.flushPendingSendQueue();
          this.resolveConnect();
        }),
        transport.onClose((event) => {
          if (this.pendingGenericTransportErrorTimeout) {
            clearTimeout(this.pendingGenericTransportErrorTimeout);
            this.pendingGenericTransportErrorTimeout = null;
          }
          const closeRecord = event as { code?: unknown; reason?: unknown } | null;
          const closeCode =
            closeRecord && typeof closeRecord === "object" && typeof closeRecord.code === "number"
              ? closeRecord.code
              : null;
          const closeReason =
            closeRecord && typeof closeRecord === "object" && typeof closeRecord.reason === "string"
              ? closeRecord.reason
              : null;
          const reason = describeTransportClose(event);
          if (reason) {
            this.lastErrorValue = reason;
          }
          this.updateConnectionState({
            status: "disconnected",
            ...(reason ? { reason } : {}),
          });

          // When connecting over the relay, only one client connection is allowed at a time.
          // If another device/tab takes over, we should not auto-reconnect and "fight" the new
          // connection (which causes flapping where both sides repeatedly replace each other).
          if (
            isRelayClientWebSocketUrl(this.config.url) &&
            closeCode === 1008 &&
            (closeReason ?? reason) === "Replaced by new connection"
          ) {
            this.shouldReconnect = false;
            this.clearWaiters(new Error(reason ?? "Replaced by new connection"));
            this.rejectPendingSendQueue(new Error(reason ?? "Replaced by new connection"));
            this.rejectConnect(new Error(reason ?? "Replaced by new connection"));
            return;
          }
          this.scheduleReconnect(reason);
        }),
        transport.onError((event) => {
          const reason = describeTransportError(event);
          const isGeneric = reason === "Transport error";
          // Browser WebSocket.onerror often provides no useful details and is followed
          // by a close event (often with code 1006). Prefer surfacing the close details
          // instead of immediately disconnecting with a generic "Transport error".
          if (isGeneric) {
            this.lastErrorValue ??= reason;
            if (!this.pendingGenericTransportErrorTimeout) {
              this.pendingGenericTransportErrorTimeout = setTimeout(() => {
                this.pendingGenericTransportErrorTimeout = null;
                if (
                  this.connectionState.status === "connected" ||
                  this.connectionState.status === "connecting"
                ) {
                  this.lastErrorValue = reason;
                  this.updateConnectionState({ status: "disconnected", reason });
                  this.scheduleReconnect(reason);
                }
              }, 250);
            }
            return;
          }

          if (this.pendingGenericTransportErrorTimeout) {
            clearTimeout(this.pendingGenericTransportErrorTimeout);
            this.pendingGenericTransportErrorTimeout = null;
          }
          this.lastErrorValue = reason;
          this.updateConnectionState({ status: "disconnected", reason });
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
    this.disposeTransport(1000, "Client closed");
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

  // ============================================================================
  // Message Subscription
  // ============================================================================

  subscribe(handler: DaemonEventHandler): () => void {
    this.eventListeners.add(handler);
    return () => this.eventListeners.delete(handler);
  }

  subscribeRawMessages(handler: (message: SessionOutboundMessage) => void): () => void {
    this.rawMessageListeners.add(handler);
    return () => {
      this.rawMessageListeners.delete(handler);
    };
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

  /**
   * Send a session message. For fire-and-forget messages (heartbeats, etc.),
   * failures are suppressed if `suppressSendErrors` is configured.
   * For RPC methods that wait for responses, use `sendSessionMessageOrThrow` instead.
   */
  private sendSessionMessage(message: SessionInboundMessage): void {
    if (!this.transport || this.connectionState.status !== "connected") {
      if (this.config.suppressSendErrors) {
        return;
      }
      throw new Error(`Transport not connected (status: ${this.connectionState.status})`);
    }
    const payload = SessionInboundMessageSchema.parse(message);
    try {
      this.transport.send(JSON.stringify({ type: "session", message: payload }));
    } catch (error) {
      if (this.config.suppressSendErrors) {
        return;
      }
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * Send a session message for RPC methods that create waiters.
   * If the connection is still being established ("connecting"), the message
   * is queued and will be sent once connected (or rejected after timeout).
   * This prevents waiters from hanging forever when called during connection.
   */
  private sendSessionMessageOrThrow(message: SessionInboundMessage): Promise<void> {
    const status = this.connectionState.status;

    // If connected, send immediately
    if (this.transport && status === "connected") {
      const payload = SessionInboundMessageSchema.parse(message);
      this.transport.send(JSON.stringify({ type: "session", message: payload }));
      return Promise.resolve();
    }

    // If connecting, queue the message to be sent once connected
    if (status === "connecting") {
      return new Promise((resolve, reject) => {
        const timeoutHandle = setTimeout(() => {
          // Remove from queue
          const idx = this.pendingSendQueue.findIndex((p) => p.resolve === resolve);
          if (idx !== -1) {
            this.pendingSendQueue.splice(idx, 1);
          }
          reject(new Error(`Timed out waiting for connection to send message`));
        }, DEFAULT_SEND_QUEUE_TIMEOUT_MS);

        this.pendingSendQueue.push({ message, resolve, reject, timeoutHandle });
      });
    }

    // Not connected and not connecting - fail immediately
    return Promise.reject(new Error(`Transport not connected (status: ${status})`));
  }

  /**
   * Flush pending send queue - called when connection is established.
   */
  private flushPendingSendQueue(): void {
    const queue = this.pendingSendQueue;
    this.pendingSendQueue = [];

    for (const pending of queue) {
      clearTimeout(pending.timeoutHandle);
      try {
        if (this.transport && this.connectionState.status === "connected") {
          const payload = SessionInboundMessageSchema.parse(pending.message);
          this.transport.send(JSON.stringify({ type: "session", message: payload }));
          pending.resolve();
        } else {
          pending.reject(new Error("Connection lost before message could be sent"));
        }
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  /**
   * Reject all pending sends - called when connection fails or is closed.
   */
  private rejectPendingSendQueue(error: Error): void {
    const queue = this.pendingSendQueue;
    this.pendingSendQueue = [];

    for (const pending of queue) {
      clearTimeout(pending.timeoutHandle);
      pending.reject(error);
    }
  }

  private async sendRequest<T>(
    params: {
      requestId: string;
      message: SessionInboundMessage;
      timeout: number;
      select: (msg: SessionOutboundMessage) => T | null;
      options?: { skipQueue?: boolean };
    }
  ): Promise<T> {
    const { promise, cancel } = this.waitForWithCancel<RpcWaitResult<T>>(
      (msg) => {
        if (msg.type === "rpc_error" && msg.payload.requestId === params.requestId) {
          return {
            kind: "error",
            error: new DaemonRpcError({
              requestId: msg.payload.requestId,
              error: msg.payload.error,
              requestType: msg.payload.requestType,
              code: msg.payload.code,
            }),
          };
        }
        const value = params.select(msg);
        if (value === null) {
          return null;
        }
        return { kind: "ok", value };
      },
      params.timeout,
      params.options
    );

    try {
      await this.sendSessionMessageOrThrow(params.message);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      cancel(err);
      void promise.catch(() => undefined);
      throw err;
    }

    const result = await promise;
    if (result.kind === "error") {
      throw result.error;
    }
    return result.value;
  }

  private sendSessionMessageStrict(message: SessionInboundMessage): void {
    if (!this.transport || this.connectionState.status !== "connected") {
      throw new Error("Transport not connected");
    }
    const payload = SessionInboundMessageSchema.parse(message);
    try {
      this.transport.send(JSON.stringify({ type: "session", message: payload }));
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  clearAgentAttention(agentId: string | string[]): void {
    this.sendSessionMessage({ type: "clear_agent_attention", agentId });
  }

  sendHeartbeat(params: {
    deviceType: "web" | "mobile";
    focusedAgentId: string | null;
    lastActivityAt: string;
    appVisible: boolean;
    appVisibilityChangedAt?: string;
  }): void {
    this.sendSessionMessage({
      type: "client_heartbeat",
      deviceType: params.deviceType,
      focusedAgentId: params.focusedAgentId,
      lastActivityAt: params.lastActivityAt,
      appVisible: params.appVisible,
      appVisibilityChangedAt: params.appVisibilityChangedAt,
    });
  }

  registerPushToken(token: string): void {
    this.sendSessionMessage({
      type: "register_push_token",
      token,
    });
  }

  async ping(params?: { requestId?: string; timeoutMs?: number }): Promise<{
    requestId: string;
    clientSentAt: number;
    serverReceivedAt: number;
    serverSentAt: number;
    rttMs: number;
  }> {
    const requestId =
      params?.requestId ??
      `ping-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const clientSentAt = Date.now();

    const payload = await this.sendRequest({
      requestId,
      message: { type: "ping", requestId, clientSentAt },
      timeout: params?.timeoutMs ?? 5000,
      select: (msg) => {
        if (msg.type !== "pong") return null;
        if (msg.payload.requestId !== requestId) return null;
        if (typeof msg.payload.serverReceivedAt !== "number") return null;
        if (typeof msg.payload.serverSentAt !== "number") return null;
        return msg.payload;
      },
    });

    return {
      requestId,
      clientSentAt,
      serverReceivedAt: payload.serverReceivedAt,
      serverSentAt: payload.serverSentAt,
      rttMs: Date.now() - clientSentAt,
    };
  }

  // ============================================================================
  // Agent RPCs (requestId-correlated)
  // ============================================================================

  async fetchAgents(options?: {
    filter?: { labels?: Record<string, string> };
    requestId?: string;
  }): Promise<AgentSnapshotPayload[]> {
    const resolvedRequestId = this.createRequestId(options?.requestId);
    const message = SessionInboundMessageSchema.parse({
      type: "fetch_agents_request",
      requestId: resolvedRequestId,
      ...(options?.filter ? { filter: options.filter } : {}),
    });
    return this.sendRequest({
      requestId: resolvedRequestId,
      message,
      timeout: 10000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== "fetch_agents_response") {
          return null;
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null;
        }
        return msg.payload.agents;
      },
    });
  }

  async fetchAgentsGroupedByProject(options?: {
    filter?: { labels?: Record<string, string> };
    requestId?: string;
  }): Promise<FetchAgentsGroupedByProjectPayload> {
    const resolvedRequestId = this.createRequestId(options?.requestId);
    const message = SessionInboundMessageSchema.parse({
      type: "fetch_agents_grouped_by_project_request",
      requestId: resolvedRequestId,
      ...(options?.filter ? { filter: options.filter } : {}),
    });
    return this.sendRequest({
      requestId: resolvedRequestId,
      message,
      timeout: 15000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== "fetch_agents_grouped_by_project_response") {
          return null;
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null;
        }
        return msg.payload;
      },
    });
  }

  async fetchAgent(agentId: string, requestId?: string): Promise<AgentSnapshotPayload | null> {
    const resolvedRequestId = this.createRequestId(requestId);
    const message = SessionInboundMessageSchema.parse({
      type: "fetch_agent_request",
      requestId: resolvedRequestId,
      agentId,
    });
    const payload = await this.sendRequest({
      requestId: resolvedRequestId,
      message,
      timeout: 10000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== "fetch_agent_response") {
          return null;
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null;
        }
        return msg.payload;
      },
    });
    if (payload.error) {
      throw new Error(payload.error);
    }
    return payload.agent;
  }

  subscribeAgentUpdates(options?: {
    subscriptionId?: string;
    filter?: { labels?: Record<string, string>; agentId?: string };
  }): string {
    const subscriptionId = options?.subscriptionId ?? crypto.randomUUID();
    this.agentUpdateSubscriptions.set(subscriptionId, options?.filter);
    const message = SessionInboundMessageSchema.parse({
      type: "subscribe_agent_updates",
      subscriptionId,
      ...(options?.filter ? { filter: options.filter } : {}),
    });
    this.sendSessionMessage(message);
    return subscriptionId;
  }

  unsubscribeAgentUpdates(subscriptionId: string): void {
    this.agentUpdateSubscriptions.delete(subscriptionId);
    const message = SessionInboundMessageSchema.parse({
      type: "unsubscribe_agent_updates",
      subscriptionId,
    });
    this.sendSessionMessage(message);
  }

  private resubscribeAgentUpdates(): void {
    if (this.agentUpdateSubscriptions.size === 0) {
      return;
    }
    for (const [subscriptionId, filter] of this.agentUpdateSubscriptions) {
      const message = SessionInboundMessageSchema.parse({
        type: "subscribe_agent_updates",
        subscriptionId,
        ...(filter ? { filter } : {}),
      });
      this.sendSessionMessage(message);
    }
  }

  private resubscribeCheckoutDiffSubscriptions(): void {
    if (this.checkoutDiffSubscriptions.size === 0) {
      return;
    }
    for (const [subscriptionId, subscription] of this.checkoutDiffSubscriptions) {
      const message = SessionInboundMessageSchema.parse({
        type: "subscribe_checkout_diff_request",
        subscriptionId,
        cwd: subscription.cwd,
        compare: subscription.compare,
        requestId: this.createRequestId(),
      });
      this.sendSessionMessage(message);
    }
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
      ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}),
      ...(options.images && options.images.length > 0
        ? { images: options.images }
        : {}),
      ...(options.git ? { git: options.git } : {}),
      ...(options.worktreeName ? { worktreeName: options.worktreeName } : {}),
      ...(options.labels && Object.keys(options.labels).length > 0
        ? { labels: options.labels }
        : {}),
    });

    const status = await this.sendRequest({
      requestId,
      message,
      timeout: 15000,
      options: { skipQueue: true },
      select: (msg) => {
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
    });
    if (status.status === "agent_create_failed") {
      throw new Error(status.error);
    }

    return status.agent;
  }

  async deleteAgent(agentId: string): Promise<void> {
    const requestId = this.createRequestId();
    const message = SessionInboundMessageSchema.parse({
      type: "delete_agent_request",
      agentId,
      requestId,
    });
    await this.sendRequest({
      requestId,
      message,
      timeout: 10000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== "agent_deleted") {
          return null;
        }
        if (msg.payload.requestId !== requestId) {
          return null;
        }
        return msg.payload;
      },
    });
  }

  async archiveAgent(agentId: string): Promise<{ archivedAt: string }> {
    const requestId = this.createRequestId();
    const message = SessionInboundMessageSchema.parse({
      type: "archive_agent_request",
      agentId,
      requestId,
    });
    const result = await this.sendRequest({
      requestId,
      message,
      timeout: 10000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== "agent_archived") {
          return null;
        }
        if (msg.payload.requestId !== requestId) {
          return null;
        }
        return msg.payload;
      },
    });
    return { archivedAt: result.archivedAt };
  }

  async updateAgent(
    agentId: string,
    updates: { name?: string; labels?: Record<string, string> }
  ): Promise<void> {
    const requestId = this.createRequestId();
    const message = SessionInboundMessageSchema.parse({
      type: "update_agent_request",
      agentId,
      ...(updates.name !== undefined ? { name: updates.name } : {}),
      ...(updates.labels && Object.keys(updates.labels).length > 0
        ? { labels: updates.labels }
        : {}),
      requestId,
    });
    const payload = await this.sendRequest({
      requestId,
      message,
      timeout: 10000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== "update_agent_response") {
          return null;
        }
        if (msg.payload.requestId !== requestId) {
          return null;
        }
        return msg.payload;
      },
    });
    if (!payload.accepted) {
      throw new Error(payload.error ?? "updateAgent rejected");
    }
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

    const status = await this.sendRequest({
      requestId,
      message,
      timeout: 15000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== "status") {
          return null;
        }
        const resumed = AgentResumedStatusPayloadSchema.safeParse(msg.payload);
        if (resumed.success && resumed.data.requestId === requestId) {
          return resumed.data;
        }
        return null;
      },
    });

    return status.agent;
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
    return this.sendRequest({
      requestId: resolvedRequestId,
      message,
      timeout: 15000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== "status") {
          return null;
        }
        const refreshed = AgentRefreshedStatusPayloadSchema.safeParse(msg.payload);
        if (refreshed.success && refreshed.data.requestId === resolvedRequestId) {
          return refreshed.data;
        }
        return null;
      },
    });
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
    const payload = await this.sendRequest({
      requestId: resolvedRequestId,
      message,
      timeout: 10000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== "initialize_agent_request") {
          return null;
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null;
        }
        return msg.payload;
      },
    });
    if (payload.error) {
      throw new Error(payload.error);
    }
    const agent = await this.fetchAgent(agentId);
    if (!agent) {
      throw new Error(`Agent not found after initialize: ${agentId}`);
    }
    return agent;
  }

  // ============================================================================
  // Agent Interaction
  // ============================================================================

  async sendAgentMessage(
    agentId: string,
    text: string,
    options?: SendMessageOptions
  ): Promise<void> {
    const requestId = this.createRequestId();
    const messageId = options?.messageId ?? crypto.randomUUID();
    const message = SessionInboundMessageSchema.parse({
      type: "send_agent_message_request",
      requestId,
      agentId,
      text,
      ...(messageId ? { messageId } : {}),
      ...(options?.images ? { images: options.images } : {}),
    });
    const payload = await this.sendRequest({
      requestId,
      message,
      timeout: 15000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== "send_agent_message_response") {
          return null;
        }
        if (msg.payload.requestId !== requestId) {
          return null;
        }
        return msg.payload;
      },
    });
    if (!payload.accepted) {
      throw new Error(payload.error ?? "sendAgentMessage rejected");
    }
  }

  async sendMessage(
    agentId: string,
    text: string,
    options?: SendMessageOptions
  ): Promise<void> {
    await this.sendAgentMessage(agentId, text, options);
  }

  async cancelAgent(agentId: string): Promise<void> {
    this.sendSessionMessage({ type: "cancel_agent_request", agentId });
  }

  async setAgentMode(agentId: string, modeId: string): Promise<void> {
    const requestId = this.createRequestId();
    const message = SessionInboundMessageSchema.parse({
      type: "set_agent_mode_request",
      agentId,
      modeId,
      requestId,
    });
    const payload = await this.sendRequest({
      requestId,
      message,
      timeout: 15000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== "set_agent_mode_response") {
          return null;
        }
        if (msg.payload.requestId !== requestId) {
          return null;
        }
        return msg.payload;
      },
    });
    if (!payload.accepted) {
      throw new Error(payload.error ?? "setAgentMode rejected");
    }
  }

  async setAgentModel(agentId: string, modelId: string | null): Promise<void> {
    const requestId = this.createRequestId();
    const message = SessionInboundMessageSchema.parse({
      type: "set_agent_model_request",
      agentId,
      modelId,
      requestId,
    });
    const payload = await this.sendRequest({
      requestId,
      message,
      timeout: 15000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== "set_agent_model_response") {
          return null;
        }
        if (msg.payload.requestId !== requestId) {
          return null;
        }
        return msg.payload;
      },
    });
    if (!payload.accepted) {
      throw new Error(payload.error ?? "setAgentModel rejected");
    }
  }

  async setAgentThinkingOption(
    agentId: string,
    thinkingOptionId: string | null
  ): Promise<void> {
    const requestId = this.createRequestId();
    const message = SessionInboundMessageSchema.parse({
      type: "set_agent_thinking_request",
      agentId,
      thinkingOptionId,
      requestId,
    });
    const payload = await this.sendRequest({
      requestId,
      message,
      timeout: 15000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== "set_agent_thinking_response") {
          return null;
        }
        if (msg.payload.requestId !== requestId) {
          return null;
        }
        return msg.payload;
      },
    });
    if (!payload.accepted) {
      throw new Error(payload.error ?? "setAgentThinkingOption rejected");
    }
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
    return this.sendRequest({
      requestId: resolvedRequestId,
      message,
      timeout: 10000,
      options: { skipQueue: true },
      select: (msg) => {
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
    });
  }

  // ============================================================================
  // Audio / Voice
  // ============================================================================

  async setVoiceMode(
    enabled: boolean,
    agentId?: string
  ): Promise<SetVoiceModePayload> {
    const requestId = this.createRequestId();
    const message = SessionInboundMessageSchema.parse({
      type: "set_voice_mode",
      enabled,
      ...(agentId ? { agentId } : {}),
      requestId,
    });
    return this.sendRequest({
      requestId,
      message,
      timeout: 10000,
      select: (msg) => {
        if (msg.type !== "set_voice_mode_response") {
          return null;
        }
        if (msg.payload.requestId !== requestId) {
          return null;
        }
        return msg.payload;
      },
    });
  }

  async sendVoiceAudioChunk(
    audio: string,
    format: string,
    isLast: boolean
  ): Promise<void> {
    this.sendSessionMessage({ type: "voice_audio_chunk", audio, format, isLast });
  }

  startDictationStream(dictationId: string, format: string): Promise<void> {
    const ack = this.waitForWithCancel(
      (msg) => {
        if (msg.type !== "dictation_stream_ack") {
          return null;
        }
        if (msg.payload.dictationId !== dictationId) {
          return null;
        }
        if (msg.payload.ackSeq !== -1) {
          return null;
        }
        return msg.payload;
      },
      30000,
      { skipQueue: true }
    );
    const ackPromise = ack.promise.then(() => undefined);

    const streamError = this.waitForWithCancel(
      (msg) => {
        if (msg.type !== "dictation_stream_error") {
          return null;
        }
        if (msg.payload.dictationId !== dictationId) {
          return null;
        }
        return msg.payload;
      },
      30000,
      { skipQueue: true }
    );
    const errorPromise = streamError.promise.then((payload) => {
      throw new Error(payload.error);
    });

    try {
      this.sendSessionMessageStrict({ type: "dictation_stream_start", dictationId, format });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      ack.cancel(err);
      streamError.cancel(err);
      void ackPromise.catch(() => undefined);
      void errorPromise.catch(() => undefined);
      throw err;
    }
    return Promise.race([ackPromise, errorPromise]);
  }

  sendDictationStreamChunk(dictationId: string, seq: number, audio: string, format: string): void {
    this.sendSessionMessageStrict({ type: "dictation_stream_chunk", dictationId, seq, audio, format });
  }

  finishDictationStream(dictationId: string, finalSeq: number): Promise<{ dictationId: string; text: string }> {
    const final = this.waitForWithCancel(
      (msg) => {
        if (msg.type !== "dictation_stream_final") {
          return null;
        }
        if (msg.payload.dictationId !== dictationId) {
          return null;
        }
        return msg.payload;
      },
      30000,
      { skipQueue: true }
    );

    const streamError = this.waitForWithCancel(
      (msg) => {
        if (msg.type !== "dictation_stream_error") {
          return null;
        }
        if (msg.payload.dictationId !== dictationId) {
          return null;
        }
        return msg.payload;
      },
      30000,
      { skipQueue: true }
    );

    const finalPromise = final.promise;
    const errorPromise = streamError.promise.then((payload) => {
      throw new Error(payload.error);
    });

    try {
      this.sendSessionMessageStrict({ type: "dictation_stream_finish", dictationId, finalSeq });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      final.cancel(err);
      streamError.cancel(err);
      void finalPromise.catch(() => undefined);
      void errorPromise.catch(() => undefined);
      throw err;
    }
    return Promise.race([finalPromise, errorPromise]);
  }

  cancelDictationStream(dictationId: string): void {
    this.sendSessionMessageStrict({ type: "dictation_stream_cancel", dictationId });
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

  async getCheckoutStatus(
    cwd: string,
    options?: { requestId?: string }
  ): Promise<CheckoutStatusPayload> {
    const requestId = options?.requestId;

    if (!requestId) {
      const existing = this.checkoutStatusInFlight.get(cwd);
      if (existing) {
        return existing;
      }
    }

    const resolvedRequestId = this.createRequestId(requestId);
    const message = SessionInboundMessageSchema.parse({
      type: "checkout_status_request",
      cwd,
      requestId: resolvedRequestId,
    });

    const responsePromise = this.sendRequest({
      requestId: resolvedRequestId,
      message,
      timeout: 60000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== "checkout_status_response") {
          return null;
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null;
        }
        return msg.payload;
      },
    });

    if (!requestId) {
      this.checkoutStatusInFlight.set(cwd, responsePromise);
      void responsePromise
        .finally(() => {
          if (this.checkoutStatusInFlight.get(cwd) === responsePromise) {
            this.checkoutStatusInFlight.delete(cwd);
          }
        })
        .catch(() => undefined);
    }

    return responsePromise;
  }

  private normalizeCheckoutDiffCompare(
    compare: { mode: "uncommitted" | "base"; baseRef?: string }
  ): { mode: "uncommitted" | "base"; baseRef?: string } {
    if (compare.mode === "uncommitted") {
      return { mode: "uncommitted" };
    }
    const trimmedBaseRef = compare.baseRef?.trim();
    if (!trimmedBaseRef) {
      return { mode: "base" };
    }
    return { mode: "base", baseRef: trimmedBaseRef };
  }

  async getCheckoutDiff(
    cwd: string,
    compare: { mode: "uncommitted" | "base"; baseRef?: string },
    requestId?: string
  ): Promise<CheckoutDiffPayload> {
    const oneShotSubscriptionId = `oneshot-checkout-diff:${crypto.randomUUID()}`;
    try {
      const payload = await this.subscribeCheckoutDiff(cwd, compare, {
        subscriptionId: oneShotSubscriptionId,
        requestId,
      });
      return {
        cwd: payload.cwd,
        files: payload.files,
        error: payload.error,
        requestId: payload.requestId,
      };
    } finally {
      try {
        this.unsubscribeCheckoutDiff(oneShotSubscriptionId);
      } catch {
        // Ignore disconnect races during one-shot cleanup.
      }
    }
  }

  async subscribeCheckoutDiff(
    cwd: string,
    compare: { mode: "uncommitted" | "base"; baseRef?: string },
    options?: { subscriptionId?: string; requestId?: string }
  ): Promise<SubscribeCheckoutDiffPayload> {
    const subscriptionId = options?.subscriptionId ?? crypto.randomUUID();
    const normalizedCompare = this.normalizeCheckoutDiffCompare(compare);
    const previousSubscription = this.checkoutDiffSubscriptions.get(subscriptionId) ?? null;
    this.checkoutDiffSubscriptions.set(subscriptionId, {
      cwd,
      compare: normalizedCompare,
    });

    const resolvedRequestId = this.createRequestId(options?.requestId);
    const message = SessionInboundMessageSchema.parse({
      type: "subscribe_checkout_diff_request",
      subscriptionId,
      cwd,
      compare: normalizedCompare,
      requestId: resolvedRequestId,
    });

    try {
      return await this.sendRequest({
        requestId: resolvedRequestId,
        message,
        timeout: 60000,
        options: { skipQueue: true },
        select: (msg) => {
          if (msg.type !== "subscribe_checkout_diff_response") {
            return null;
          }
          if (msg.payload.requestId !== resolvedRequestId) {
            return null;
          }
          if (msg.payload.subscriptionId !== subscriptionId) {
            return null;
          }
          return msg.payload;
        },
      });
    } catch (error) {
      if (previousSubscription) {
        this.checkoutDiffSubscriptions.set(subscriptionId, previousSubscription);
      } else {
        this.checkoutDiffSubscriptions.delete(subscriptionId);
      }
      throw error;
    }
  }

  unsubscribeCheckoutDiff(subscriptionId: string): void {
    this.checkoutDiffSubscriptions.delete(subscriptionId);
    this.sendSessionMessage({
      type: "unsubscribe_checkout_diff_request",
      subscriptionId,
    });
  }

  async checkoutCommit(
    cwd: string,
    input: { message?: string; addAll?: boolean },
    requestId?: string
  ): Promise<CheckoutCommitPayload> {
    const resolvedRequestId = this.createRequestId(requestId);
    const message = SessionInboundMessageSchema.parse({
      type: "checkout_commit_request",
      cwd,
      message: input.message,
      addAll: input.addAll,
      requestId: resolvedRequestId,
    });
    return this.sendRequest({
      requestId: resolvedRequestId,
      message,
      timeout: 60000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== "checkout_commit_response") {
          return null;
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null;
        }
        return msg.payload;
      },
    });
  }

  async checkoutMerge(
    cwd: string,
    input: { baseRef?: string; strategy?: "merge" | "squash"; requireCleanTarget?: boolean },
    requestId?: string
  ): Promise<CheckoutMergePayload> {
    const resolvedRequestId = this.createRequestId(requestId);
    const message = SessionInboundMessageSchema.parse({
      type: "checkout_merge_request",
      cwd,
      baseRef: input.baseRef,
      strategy: input.strategy,
      requireCleanTarget: input.requireCleanTarget,
      requestId: resolvedRequestId,
    });
    return this.sendRequest({
      requestId: resolvedRequestId,
      message,
      timeout: 60000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== "checkout_merge_response") {
          return null;
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null;
        }
        return msg.payload;
      },
    });
  }

  async checkoutMergeFromBase(
    cwd: string,
    input: { baseRef?: string; requireCleanTarget?: boolean },
    requestId?: string
  ): Promise<CheckoutMergeFromBasePayload> {
    const resolvedRequestId = this.createRequestId(requestId);
    const message = SessionInboundMessageSchema.parse({
      type: "checkout_merge_from_base_request",
      cwd,
      baseRef: input.baseRef,
      requireCleanTarget: input.requireCleanTarget,
      requestId: resolvedRequestId,
    });
    return this.sendRequest({
      requestId: resolvedRequestId,
      message,
      timeout: 60000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== "checkout_merge_from_base_response") {
          return null;
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null;
        }
        return msg.payload;
      },
    });
  }

  async checkoutPush(cwd: string, requestId?: string): Promise<CheckoutPushPayload> {
    const resolvedRequestId = this.createRequestId(requestId);
    const message = SessionInboundMessageSchema.parse({
      type: "checkout_push_request",
      cwd,
      requestId: resolvedRequestId,
    });
    return this.sendRequest({
      requestId: resolvedRequestId,
      message,
      timeout: 60000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== "checkout_push_response") {
          return null;
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null;
        }
        return msg.payload;
      },
    });
  }

  async checkoutPrCreate(
    cwd: string,
    input: { title?: string; body?: string; baseRef?: string },
    requestId?: string
  ): Promise<CheckoutPrCreatePayload> {
    const resolvedRequestId = this.createRequestId(requestId);
    const message = SessionInboundMessageSchema.parse({
      type: "checkout_pr_create_request",
      cwd,
      title: input.title,
      body: input.body,
      baseRef: input.baseRef,
      requestId: resolvedRequestId,
    });
    return this.sendRequest({
      requestId: resolvedRequestId,
      message,
      timeout: 60000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== "checkout_pr_create_response") {
          return null;
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null;
        }
        return msg.payload;
      },
    });
  }

  async checkoutPrStatus(
    cwd: string,
    requestId?: string
  ): Promise<CheckoutPrStatusPayload> {
    const resolvedRequestId = this.createRequestId(requestId);
    const message = SessionInboundMessageSchema.parse({
      type: "checkout_pr_status_request",
      cwd,
      requestId: resolvedRequestId,
    });
    return this.sendRequest({
      requestId: resolvedRequestId,
      message,
      timeout: 60000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== "checkout_pr_status_response") {
          return null;
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null;
        }
        return msg.payload;
      },
    });
  }

  async getPaseoWorktreeList(
    input: { cwd?: string; repoRoot?: string },
    requestId?: string
  ): Promise<PaseoWorktreeListPayload> {
    const resolvedRequestId = this.createRequestId(requestId);
    const message = SessionInboundMessageSchema.parse({
      type: "paseo_worktree_list_request",
      cwd: input.cwd,
      repoRoot: input.repoRoot,
      requestId: resolvedRequestId,
    });
    return this.sendRequest({
      requestId: resolvedRequestId,
      message,
      timeout: 60000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== "paseo_worktree_list_response") {
          return null;
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null;
        }
        return msg.payload;
      },
    });
  }

  async archivePaseoWorktree(
    input: { worktreePath?: string; repoRoot?: string; branchName?: string },
    requestId?: string
  ): Promise<PaseoWorktreeArchivePayload> {
    const resolvedRequestId = this.createRequestId(requestId);
    const message = SessionInboundMessageSchema.parse({
      type: "paseo_worktree_archive_request",
      worktreePath: input.worktreePath,
      repoRoot: input.repoRoot,
      branchName: input.branchName,
      requestId: resolvedRequestId,
    });
    return this.sendRequest({
      requestId: resolvedRequestId,
      message,
      timeout: 20000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== "paseo_worktree_archive_response") {
          return null;
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null;
        }
        return msg.payload;
      },
    });
  }

  async validateBranch(
    options: { cwd: string; branchName: string },
    requestId?: string
  ): Promise<ValidateBranchPayload> {
    const resolvedRequestId = this.createRequestId(requestId);
    const message = SessionInboundMessageSchema.parse({
      type: "validate_branch_request",
      cwd: options.cwd,
      branchName: options.branchName,
      requestId: resolvedRequestId,
    });
    return this.sendRequest({
      requestId: resolvedRequestId,
      message,
      timeout: 10000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== "validate_branch_response") {
          return null;
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null;
        }
        return msg.payload;
      },
    });
  }

  async getBranchSuggestions(
    options: { cwd: string; query?: string; limit?: number },
    requestId?: string
  ): Promise<BranchSuggestionsPayload> {
    const resolvedRequestId = this.createRequestId(requestId);
    const message = SessionInboundMessageSchema.parse({
      type: "branch_suggestions_request",
      cwd: options.cwd,
      query: options.query,
      limit: options.limit,
      requestId: resolvedRequestId,
    });
    return this.sendRequest({
      requestId: resolvedRequestId,
      message,
      timeout: 10000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== "branch_suggestions_response") {
          return null;
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null;
        }
        return msg.payload;
      },
    });
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
    return this.sendRequest({
      requestId: resolvedRequestId,
      message,
      timeout: 10000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== "file_explorer_response") {
          return null;
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null;
        }
        return msg.payload;
      },
    });
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
    return this.sendRequest({
      requestId: resolvedRequestId,
      message,
      timeout: 10000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== "file_download_token_response") {
          return null;
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null;
        }
        return msg.payload;
      },
    });
  }

  async requestProjectIcon(
    cwd: string,
    requestId?: string
  ): Promise<ProjectIconResponse["payload"]> {
    const resolvedRequestId = this.createRequestId(requestId);
    const message = SessionInboundMessageSchema.parse({
      type: "project_icon_request",
      cwd,
      requestId: resolvedRequestId,
    });
    return this.sendRequest({
      requestId: resolvedRequestId,
      message,
      timeout: 10000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== "project_icon_response") {
          return null;
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null;
        }
        return msg.payload;
      },
    });
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
    return this.sendRequest({
      requestId: resolvedRequestId,
      message,
      timeout: 30000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== "list_provider_models_response") {
          return null;
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null;
        }
        return msg.payload;
      },
    });
  }

  async listAvailableProviders(options?: {
    requestId?: string;
  }): Promise<ListAvailableProvidersPayload> {
    const resolvedRequestId = this.createRequestId(options?.requestId);
    const message = SessionInboundMessageSchema.parse({
      type: "list_available_providers_request",
      requestId: resolvedRequestId,
    });
    return this.sendRequest({
      requestId: resolvedRequestId,
      message,
      timeout: 30000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== "list_available_providers_response") {
          return null;
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null;
        }
        return msg.payload;
      },
    });
  }

  async listSpeechModels(requestId?: string): Promise<SpeechModelsListPayload> {
    const resolvedRequestId = this.createRequestId(requestId);
    const message = SessionInboundMessageSchema.parse({
      type: "speech_models_list_request",
      requestId: resolvedRequestId,
    });
    return this.sendRequest({
      requestId: resolvedRequestId,
      message,
      timeout: 30000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== "speech_models_list_response") {
          return null;
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null;
        }
        return msg.payload;
      },
    });
  }

  async downloadSpeechModels(
    options?: { modelIds?: string[]; requestId?: string }
  ): Promise<SpeechModelsDownloadPayload> {
    const resolvedRequestId = this.createRequestId(options?.requestId);
    const message = SessionInboundMessageSchema.parse({
      type: "speech_models_download_request",
      modelIds: options?.modelIds,
      requestId: resolvedRequestId,
    });
    return this.sendRequest({
      requestId: resolvedRequestId,
      message,
      timeout: 30 * 60 * 1000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== "speech_models_download_response") {
          return null;
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null;
        }
        return msg.payload;
      },
    });
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
    return this.sendRequest({
      requestId: resolvedRequestId,
      message,
      timeout: 30000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== "list_commands_response") {
          return null;
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null;
        }
        return msg.payload;
      },
    });
  }

  async executeCommand(
    agentId: string,
    commandName: string,
    args?: string,
    requestId?: string
  ): Promise<ExecuteCommandPayload> {
    const resolvedRequestId = this.createRequestId(requestId);
    const message = SessionInboundMessageSchema.parse({
      type: "execute_command_request",
      agentId,
      commandName,
      args,
      requestId: resolvedRequestId,
    });
    return this.sendRequest({
      requestId: resolvedRequestId,
      message,
      timeout: 30000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== "execute_command_response") {
          return null;
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null;
        }
        return msg.payload;
      },
    });
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
    return this.sendRequest({
      requestId,
      message,
      timeout,
      options: { skipQueue: true },
      select: (msg) => {
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
    });
  }

  // ============================================================================
  // Waiting / Streaming Helpers
  // ============================================================================

  async waitForAgentUpsert(
    agentId: string,
    predicate: (snapshot: AgentSnapshotPayload) => boolean,
    timeout = 60000
  ): Promise<AgentSnapshotPayload> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
      const snapshot = await this.fetchAgent(agentId).catch(() => null);
      if (snapshot && predicate(snapshot)) {
        return snapshot;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Timed out waiting for agent ${agentId}`);
  }

  async waitForFinish(
    agentId: string,
    timeout = 60000
  ): Promise<WaitForFinishResult> {
    const requestId = this.createRequestId();
    const message = SessionInboundMessageSchema.parse({
      type: "wait_for_finish_request",
      requestId,
      agentId,
      timeoutMs: timeout,
    });
    const payload = await this.sendRequest({
      requestId,
      message,
      timeout: timeout + 5000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== "wait_for_finish_response") {
          return null;
        }
        if (msg.payload.requestId !== requestId) {
          return null;
        }
        return msg.payload;
      },
    });
    return {
      status: payload.status,
      final: payload.final,
      error: payload.error,
      lastMessage: payload.lastMessage,
    };
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
    return this.sendRequest({
      requestId: resolvedRequestId,
      message,
      timeout: 10000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== "list_terminals_response") {
          return null;
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null;
        }
        return msg.payload;
      },
    });
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
    return this.sendRequest({
      requestId: resolvedRequestId,
      message,
      timeout: 10000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== "create_terminal_response") {
          return null;
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null;
        }
        return msg.payload;
      },
    });
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
    return this.sendRequest({
      requestId: resolvedRequestId,
      message,
      timeout: 10000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== "subscribe_terminal_response") {
          return null;
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null;
        }
        return msg.payload;
      },
    });
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
    return this.sendRequest({
      requestId: resolvedRequestId,
      message,
      timeout: 10000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== "kill_terminal_response") {
          return null;
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null;
        }
        return msg.payload;
      },
    });
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

  private disposeTransport(code = 1001, reason = "Reconnecting"): void {
    this.cleanupTransport();
    if (this.transport) {
      try {
        this.transport.close(code, reason);
      } catch {
        // no-op
      }
      this.transport = null;
    }
  }

  private cleanupTransport(): void {
    if (this.pendingGenericTransportErrorTimeout) {
      clearTimeout(this.pendingGenericTransportErrorTimeout);
      this.pendingGenericTransportErrorTimeout = null;
    }
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

    // Clear all pending waiters and queued sends since the connection was lost
    // and responses from the previous connection will never arrive.
    this.clearWaiters(new Error(reason ?? "Connection lost"));
    this.rejectPendingSendQueue(new Error(reason ?? "Connection lost"));

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
    if (this.rawMessageListeners.size > 0) {
      for (const handler of this.rawMessageListeners) {
        try {
          handler(msg);
        } catch {
          // no-op
        }
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
      case "agent_update":
        return {
          type: "agent_update",
          agentId:
            msg.payload.kind === "upsert"
              ? msg.payload.agent.id
              : msg.payload.agentId,
          payload: msg.payload,
        };
      case "agent_stream":
        return {
          type: "agent_stream",
          agentId: msg.payload.agentId,
          event: msg.payload.event,
          timestamp: msg.payload.timestamp,
        };
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
    _options?: { skipQueue?: boolean }
  ): Promise<T> {
    return this.waitForWithCancel(predicate, timeout, _options).promise;
  }

  private waitForWithCancel<T>(
    predicate: (msg: SessionOutboundMessage) => T | null,
    timeout = 30000,
    _options?: { skipQueue?: boolean }
  ): WaitHandle<T> {
    // Capture stack trace at call site, not inside setTimeout
    const timeoutError = new Error(`Timeout waiting for message (${timeout}ms)`);

    let waiter: Waiter<T> | null = null;
    let settled = false;
    let rejectFn: ((error: Error) => void) | null = null;

    const promise = new Promise<T>((resolve, reject) => {
      const wrappedResolve = (value: T) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const wrappedReject = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      rejectFn = wrappedReject;

      const timeoutHandle =
        timeout > 0
          ? setTimeout(() => {
              if (waiter) {
                this.waiters.delete(waiter);
              }
              wrappedReject(timeoutError);
            }, timeout)
          : null;

      waiter = {
        predicate,
        resolve: wrappedResolve,
        reject: wrappedReject,
        timeoutHandle,
      };
      this.waiters.add(waiter);
    });

    const cancel = (error: Error) => {
      if (settled) {
        return;
      }

      if (waiter) {
        this.waiters.delete(waiter);
        if (waiter.timeoutHandle) {
          clearTimeout(waiter.timeoutHandle);
        }
      }

      if (rejectFn) {
        rejectFn(error);
        return;
      }

      // Extremely unlikely: cancel called before the Promise executor ran.
      queueMicrotask(() => {
        if (!settled && rejectFn) {
          rejectFn(error);
        }
      });
    };

    return { promise, cancel };
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
      send: (data) => {
        if (typeof ws.readyState === "number" && ws.readyState !== 1) {
          throw new Error(`WebSocket not open (readyState=${ws.readyState})`);
        }
        ws.send(data);
      },
      close: (code?: number, reason?: string) => ws.close(code, reason),
      onOpen: (handler) => bindWsHandler(ws, "open", handler),
      onClose: (handler) => bindWsHandler(ws, "close", handler),
      onError: (handler) => bindWsHandler(ws, "error", handler),
      onMessage: (handler) => bindWsHandler(ws, "message", handler),
    };
  };
}

function createRelayE2eeTransportFactory(args: {
  baseFactory: DaemonTransportFactory;
  daemonPublicKeyB64: string;
  logger: Logger;
}): DaemonTransportFactory {
  return ({ url, headers }) => {
    const base = args.baseFactory({ url, headers });
    return createEncryptedTransport(base, args.daemonPublicKeyB64, args.logger);
  };
}

function createEncryptedTransport(
  base: DaemonTransport,
  daemonPublicKeyB64: string,
  logger: Logger
): DaemonTransport {
  let channel: EncryptedChannel | null = null;
  let opened = false;
  let closed = false;

  const openHandlers = new Set<() => void>();
  const closeHandlers = new Set<(event?: unknown) => void>();
  const errorHandlers = new Set<(event?: unknown) => void>();
  const messageHandlers = new Set<(data: unknown) => void>();

  const emitOpen = () => {
    if (opened || closed) return;
    opened = true;
    for (const handler of openHandlers) {
      try {
        handler();
      } catch {
        // no-op
      }
    }
  };

  const emitClose = (event?: unknown) => {
    if (closed) return;
    closed = true;
    for (const handler of closeHandlers) {
      try {
        handler(event);
      } catch {
        // no-op
      }
    }
  };

  const emitError = (event?: unknown) => {
    if (closed) return;
    for (const handler of errorHandlers) {
      try {
        handler(event);
      } catch {
        // no-op
      }
    }
  };

  const emitMessage = (data: unknown) => {
    if (closed) return;
    for (const handler of messageHandlers) {
      try {
        handler(data);
      } catch {
        // no-op
      }
    }
  };

  const relayTransport: RelayTransport = {
    send: (data) => {
      if (typeof data === "string") {
        base.send(data);
        return;
      }
      if (data instanceof ArrayBuffer) {
        if (typeof TextDecoder !== "undefined") {
          base.send(new TextDecoder().decode(data));
          return;
        }
        if (typeof Buffer !== "undefined") {
          base.send(Buffer.from(data).toString("utf8"));
          return;
        }
        base.send(String(data));
        return;
      }
      base.send(String(data));
    },
    close: (code?: number, reason?: string) => base.close(code, reason),
    onmessage: null,
    onclose: null,
    onerror: null,
  };

  const startHandshake = async () => {
    try {
      channel = await createClientChannel(relayTransport, daemonPublicKeyB64, {
        onopen: emitOpen,
        onmessage: (data) => emitMessage(data),
        onclose: (code, reason) => emitClose({ code, reason }),
        onerror: (error) => emitError(error),
      });
    } catch (error) {
      logger.warn({ err: error }, "relay_e2ee_handshake_failed");
      emitError(error);
      base.close(1011, "E2EE handshake failed");
    }
  };

  base.onOpen(() => {
    void startHandshake();
  });
  base.onMessage((event) => {
    relayTransport.onmessage?.(extractRelayMessageData(event));
  });
  base.onClose((event) => {
    const record = event as { code?: number; reason?: string } | undefined;
    relayTransport.onclose?.(record?.code ?? 0, record?.reason ?? "");
    emitClose(event);
  });
  base.onError((event) => {
    relayTransport.onerror?.(
      event instanceof Error ? event : new Error(String(event))
    );
    emitError(event);
  });

  return {
    send: (data) => {
      if (!channel) {
        throw new Error("Encrypted channel not ready");
      }
      void channel.send(data).catch((error) => {
        emitError(error);
      });
    },
    close: (code?: number, reason?: string) => {
      if (channel) {
        channel.close(code, reason);
      } else {
        base.close(code, reason);
      }
      emitClose({ code, reason });
    },
    onMessage: (handler) => {
      messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },
    onOpen: (handler) => {
      openHandlers.add(handler);
      if (opened) {
        try {
          handler();
        } catch {
          // no-op
        }
      }
      return () => openHandlers.delete(handler);
    },
    onClose: (handler) => {
      closeHandlers.add(handler);
      if (closed) {
        try {
          handler();
        } catch {
          // no-op
        }
      }
      return () => closeHandlers.delete(handler);
    },
    onError: (handler) => {
      errorHandlers.add(handler);
      return () => errorHandlers.delete(handler);
    },
  };
}

function extractRelayMessageData(event: unknown): string | ArrayBuffer {
  const raw =
    event && typeof event === "object" && "data" in event
      ? (event as { data: unknown }).data
      : event;
  if (typeof raw === "string") return raw;
  if (raw instanceof ArrayBuffer) return raw;
  if (ArrayBuffer.isView(raw)) {
    const view = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    const out = new Uint8Array(view.byteLength);
    out.set(view);
    return out.buffer;
  }
  return String(raw ?? "");
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

function safeRandomId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // ignore
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
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
    labels: _labels,
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
