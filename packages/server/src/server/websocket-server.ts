import { WebSocketServer } from "ws";
import type { Server as HTTPServer } from "http";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { join } from "path";
import { hostname as getHostname } from "node:os";
import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import type { DownloadTokenStore } from "./file-download/token-store.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import type pino from "pino";
import {
  type ServerInfoStatusPayload,
  type WSHelloMessage,
  type WSWelcomeMessage,
  WSInboundMessageSchema,
  type ServerCapabilityState,
  type ServerCapabilities,
  type WSOutboundMessage,
  wrapSessionMessage,
} from "./messages.js";
import {
  asUint8Array,
  decodeBinaryMuxFrame,
  encodeBinaryMuxFrame,
} from "../shared/binary-mux.js";
import type { AllowedHostsConfig } from "./allowed-hosts.js";
import { isHostAllowed } from "./allowed-hosts.js";
import { Session, type SessionLifecycleIntent } from "./session.js";
import type { AgentProvider } from "./agent/agent-sdk-types.js";
import type { AgentProviderRuntimeSettingsMap } from "./agent/provider-launch-config.js";
import { PushTokenStore } from "./push/token-store.js";
import { PushService } from "./push/push-service.js";
import type { SpeechToTextProvider, TextToSpeechProvider } from "./speech/speech-provider.js";
import type { Resolvable } from "./speech/provider-resolver.js";
import type { SpeechReadinessSnapshot } from "./speech/speech-runtime.js";
import type { LocalSpeechModelId } from "./speech/providers/local/models.js";
import type {
  VoiceCallerContext,
  VoiceMcpStdioConfig,
  VoiceSpeakHandler,
} from "./voice-types.js";
import {
  computeShouldNotifyClient,
  computeShouldSendPush,
  type ClientAttentionState,
} from "./agent-attention-policy.js";
import {
  buildAgentAttentionNotificationPayload,
  findLatestAssistantMessageFromTimeline,
  findLatestPermissionRequest,
} from "../shared/agent-attention-notification.js";

export type AgentMcpTransportFactory = () => Promise<Transport>;
export type ExternalSocketMetadata = {
  transport: "relay";
  externalSessionKey?: string;
};

type PendingConnection = {
  connectionLogger: pino.Logger;
  helloTimeout: ReturnType<typeof setTimeout> | null;
};

type WebSocketServerConfig = {
  allowedOrigins: Set<string>;
  allowedHosts?: AllowedHostsConfig;
};

function toServerCapabilityState(
  params: {
    state: SpeechReadinessSnapshot["dictation"];
    reason: string;
  }
): ServerCapabilityState {
  const { state, reason } = params;
  return {
    enabled: state.enabled,
    reason,
  };
}

function resolveCapabilityReason(params: {
  state: SpeechReadinessSnapshot["dictation"];
  readiness: SpeechReadinessSnapshot;
}): string {
  const { state, readiness } = params;
  if (state.available) {
    return "";
  }

  if (readiness.voiceFeature.reasonCode === "model_download_in_progress") {
    const baseMessage = readiness.voiceFeature.message.trim();
    if (baseMessage.includes("Try again in a few minutes")) {
      return baseMessage;
    }
    return `${baseMessage} Try again in a few minutes.`;
  }

  return state.message;
}

function buildServerCapabilities(params: {
  readiness: SpeechReadinessSnapshot | null;
}): ServerCapabilities | undefined {
  const readiness = params.readiness;
  if (!readiness) {
    return undefined;
  }
  return {
    voice: {
      dictation: toServerCapabilityState({
        state: readiness.dictation,
        reason: resolveCapabilityReason({
          state: readiness.dictation,
          readiness,
        }),
      }),
      voice: toServerCapabilityState({
        state: readiness.realtimeVoice,
        reason: resolveCapabilityReason({
          state: readiness.realtimeVoice,
          readiness,
        }),
      }),
    },
  };
}

function areServerCapabilitiesEqual(
  current: ServerCapabilities | undefined,
  next: ServerCapabilities | undefined
): boolean {
  return JSON.stringify(current ?? null) === JSON.stringify(next ?? null);
}

function bufferFromWsData(data: Buffer | ArrayBuffer | Buffer[] | string): Buffer {
  if (typeof data === "string") return Buffer.from(data, "utf8");
  if (Array.isArray(data)) {
    return Buffer.concat(
      data.map((item) =>
        Buffer.isBuffer(item) ? item : Buffer.from(item as ArrayBuffer)
      )
    );
  }
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(data as ArrayBuffer);
}

type WebSocketLike = {
  readyState: number;
  send: (data: string | Uint8Array | ArrayBuffer) => void;
  close: (code?: number, reason?: string) => void;
  on: (event: "message" | "close" | "error", listener: (...args: any[]) => void) => void;
  once: (event: "close" | "error", listener: (...args: any[]) => void) => void;
};

type SessionConnection = {
  session: Session;
  clientId: string;
  connectionLogger: pino.Logger;
  sockets: Set<WebSocketLike>;
  externalDisconnectCleanupTimeout: ReturnType<typeof setTimeout> | null;
};

const EXTERNAL_SESSION_DISCONNECT_GRACE_MS = 90_000;
const HELLO_TIMEOUT_MS = 15_000;
const WS_CLOSE_HELLO_TIMEOUT = 4001;
const WS_CLOSE_INVALID_HELLO = 4002;
const WS_CLOSE_INCOMPATIBLE_PROTOCOL = 4003;
const WS_PROTOCOL_VERSION = 1;

export class MissingDaemonVersionError extends Error {
  constructor() {
    super("VoiceAssistantWebSocketServer requires a non-empty daemonVersion.");
    this.name = "MissingDaemonVersionError";
  }
}

/**
 * WebSocket server that only accepts sockets + parses/forwards messages to the session layer.
 */
export class VoiceAssistantWebSocketServer {
  private readonly logger: pino.Logger;
  private readonly wss: WebSocketServer;
  private readonly pendingConnections: Map<WebSocketLike, PendingConnection> = new Map();
  private readonly sessions: Map<WebSocketLike, SessionConnection> = new Map();
  private readonly externalSessionsByKey: Map<string, SessionConnection> = new Map();
  private readonly serverId: string;
  private readonly daemonVersion: string;
  private readonly agentManager: AgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly downloadTokenStore: DownloadTokenStore;
  private readonly paseoHome: string;
  private readonly pushTokenStore: PushTokenStore;
  private readonly pushService: PushService;
  private readonly createAgentMcpTransport: AgentMcpTransportFactory;
  private readonly stt: Resolvable<SpeechToTextProvider | null>;
  private readonly tts: Resolvable<TextToSpeechProvider | null>;
  private readonly terminalManager: TerminalManager | null;
  private readonly dictation: {
    finalTimeoutMs?: number;
    stt?: Resolvable<SpeechToTextProvider | null>;
    localModels?: {
      modelsDir: string;
      defaultModelIds: LocalSpeechModelId[];
    };
    getSpeechReadiness?: () => SpeechReadinessSnapshot;
  } | null;
  private readonly voice: {
    voiceAgentMcpStdio?: VoiceMcpStdioConfig | null;
    ensureVoiceMcpSocketForAgent?: (agentId: string) => Promise<string>;
    removeVoiceMcpSocketForAgent?: (agentId: string) => Promise<void>;
  } | null;
  private readonly voiceSpeakHandlers = new Map<
    string,
    VoiceSpeakHandler
  >();
  private readonly voiceCallerContexts = new Map<string, VoiceCallerContext>();
  private readonly agentProviderRuntimeSettings: AgentProviderRuntimeSettingsMap | undefined;
  private readonly onLifecycleIntent: ((intent: SessionLifecycleIntent) => void) | null;
  private serverCapabilities: ServerCapabilities | undefined;

  constructor(
    server: HTTPServer,
    logger: pino.Logger,
    serverId: string,
    agentManager: AgentManager,
    agentStorage: AgentStorage,
    downloadTokenStore: DownloadTokenStore,
    paseoHome: string,
    createAgentMcpTransport: AgentMcpTransportFactory,
    wsConfig: WebSocketServerConfig,
    speech?: {
      stt: Resolvable<SpeechToTextProvider | null>;
      tts: Resolvable<TextToSpeechProvider | null>;
    },
    terminalManager?: TerminalManager | null,
    voice?: {
      voiceAgentMcpStdio?: VoiceMcpStdioConfig | null;
      ensureVoiceMcpSocketForAgent?: (agentId: string) => Promise<string>;
      removeVoiceMcpSocketForAgent?: (agentId: string) => Promise<void>;
    },
    dictation?: {
      finalTimeoutMs?: number;
      stt?: Resolvable<SpeechToTextProvider | null>;
      localModels?: {
        modelsDir: string;
        defaultModelIds: LocalSpeechModelId[];
      };
      getSpeechReadiness?: () => SpeechReadinessSnapshot;
    },
    agentProviderRuntimeSettings?: AgentProviderRuntimeSettingsMap,
    daemonVersion?: string,
    onLifecycleIntent?: (intent: SessionLifecycleIntent) => void
  ) {
    this.logger = logger.child({ module: "websocket-server" });
    this.serverId = serverId;
    if (typeof daemonVersion !== "string" || daemonVersion.trim().length === 0) {
      throw new MissingDaemonVersionError();
    }
    this.daemonVersion = daemonVersion.trim();
    this.agentManager = agentManager;
    this.agentStorage = agentStorage;
    this.downloadTokenStore = downloadTokenStore;
    this.paseoHome = paseoHome;
    this.createAgentMcpTransport = createAgentMcpTransport;
    this.stt = speech?.stt ?? null;
    this.tts = speech?.tts ?? null;
    this.terminalManager = terminalManager ?? null;
    this.voice = voice ?? null;
    this.dictation = dictation ?? null;
    this.agentProviderRuntimeSettings = agentProviderRuntimeSettings;
    this.onLifecycleIntent = onLifecycleIntent ?? null;
    this.serverCapabilities = buildServerCapabilities({
      readiness: this.dictation?.getSpeechReadiness?.() ?? null,
    });

    const pushLogger = this.logger.child({ module: "push" });
    this.pushTokenStore = new PushTokenStore(
      pushLogger,
      join(paseoHome, "push-tokens.json")
    );
    this.pushService = new PushService(pushLogger, this.pushTokenStore);

    this.agentManager.setAgentAttentionCallback((params) => {
      this.broadcastAgentAttention(params);
    });

    const { allowedOrigins, allowedHosts } = wsConfig;
    this.wss = new WebSocketServer({
      server,
      path: "/ws",
      verifyClient: ({ req }, callback) => {
        const requestMetadata = extractSocketRequestMetadata(req);
        const origin = requestMetadata.origin;
        const requestHost = requestMetadata.host ?? null;
        if (requestHost && !isHostAllowed(requestHost, allowedHosts)) {
          this.logger.warn(
            { ...requestMetadata, host: requestHost },
            "Rejected connection from disallowed host"
          );
          callback(false, 403, "Host not allowed");
          return;
        }
        const sameOrigin =
          !!origin &&
          !!requestHost &&
          (origin === `http://${requestHost}` || origin === `https://${requestHost}`);

        if (!origin || allowedOrigins.has(origin) || sameOrigin) {
          callback(true);
        } else {
          this.logger.warn(
            { ...requestMetadata, origin },
            "Rejected connection from origin"
          );
          callback(false, 403, "Origin not allowed");
        }
      },
    });

    this.wss.on("connection", (ws, request) => {
      void this.attachSocket(ws, request);
    });

    this.logger.info("WebSocket server initialized on /ws");
  }

  public broadcast(message: WSOutboundMessage): void {
    const payload = JSON.stringify(message);
    for (const ws of this.sessions.keys()) {
      // WebSocket.OPEN = 1
      if (ws.readyState === 1) {
        ws.send(payload);
      }
    }
  }

  public publishSpeechReadiness(readiness: SpeechReadinessSnapshot | null): void {
    this.updateServerCapabilities(buildServerCapabilities({ readiness }));
  }

  public updateServerCapabilities(
    capabilities: ServerCapabilities | null | undefined
  ): void {
    const next = capabilities ?? undefined;
    if (areServerCapabilitiesEqual(this.serverCapabilities, next)) {
      return;
    }
    this.serverCapabilities = next;
    this.broadcastCapabilitiesUpdate();
  }

  public async attachExternalSocket(
    ws: WebSocketLike,
    metadata?: ExternalSocketMetadata
  ): Promise<void> {
    await this.attachSocket(ws, undefined, metadata);
  }

  public async close(): Promise<void> {
    const uniqueConnections = new Set<SessionConnection>([
      ...this.sessions.values(),
      ...this.externalSessionsByKey.values(),
    ]);

    const pendingSockets = new Set<WebSocketLike>(this.pendingConnections.keys());
    for (const pending of this.pendingConnections.values()) {
      if (pending.helloTimeout) {
        clearTimeout(pending.helloTimeout);
        pending.helloTimeout = null;
      }
    }

    const cleanupPromises: Promise<void>[] = [];
    for (const connection of uniqueConnections) {
      if (connection.externalDisconnectCleanupTimeout) {
        clearTimeout(connection.externalDisconnectCleanupTimeout);
        connection.externalDisconnectCleanupTimeout = null;
      }

      cleanupPromises.push(connection.session.cleanup());
      for (const ws of connection.sockets) {
        cleanupPromises.push(
          new Promise<void>((resolve) => {
            // WebSocket.CLOSED = 3
            if (ws.readyState === 3) {
              resolve();
              return;
            }
            ws.once("close", () => resolve());
            ws.close();
          })
        );
      }
    }

    for (const ws of pendingSockets) {
      cleanupPromises.push(
        new Promise<void>((resolve) => {
          if (ws.readyState === 3) {
            resolve();
            return;
          }
          ws.once("close", () => resolve());
          ws.close();
        })
      );
    }

    await Promise.all(cleanupPromises);
    this.pendingConnections.clear();
    this.sessions.clear();
    this.externalSessionsByKey.clear();
    this.wss.close();
  }

  private sendToClient(ws: WebSocketLike, message: WSOutboundMessage): void {
    // WebSocket.OPEN = 1
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(message));
    }
  }

  private sendBinaryToClient(
    ws: WebSocketLike,
    frame: Parameters<typeof encodeBinaryMuxFrame>[0]
  ): void {
    if (ws.readyState !== 1) {
      return;
    }
    ws.send(encodeBinaryMuxFrame(frame));
  }

  private sendToConnection(connection: SessionConnection, message: WSOutboundMessage): void {
    for (const ws of connection.sockets) {
      this.sendToClient(ws, message);
    }
  }

  private sendBinaryToConnection(
    connection: SessionConnection,
    frame: Parameters<typeof encodeBinaryMuxFrame>[0]
  ): void {
    for (const ws of connection.sockets) {
      this.sendBinaryToClient(ws, frame);
    }
  }

  private async attachSocket(
    ws: WebSocketLike,
    request?: unknown,
    metadata?: ExternalSocketMetadata
  ): Promise<void> {
    const requestMetadata = extractSocketRequestMetadata(request);
    const connectionLoggerFields: Record<string, string> = {
      transport: metadata?.transport === "relay" ? "relay" : "direct",
    };
    if (requestMetadata.host) {
      connectionLoggerFields.host = requestMetadata.host;
    }
    if (requestMetadata.origin) {
      connectionLoggerFields.origin = requestMetadata.origin;
    }
    if (requestMetadata.userAgent) {
      connectionLoggerFields.userAgent = requestMetadata.userAgent;
    }
    if (requestMetadata.remoteAddress) {
      connectionLoggerFields.remoteAddress = requestMetadata.remoteAddress;
    }
    const connectionLogger = this.logger.child(connectionLoggerFields);

    const pending: PendingConnection = {
      connectionLogger,
      helloTimeout: null,
    };
    const timeout = setTimeout(() => {
      if (this.pendingConnections.get(ws) !== pending) {
        return;
      }
      pending.helloTimeout = null;
      this.pendingConnections.delete(ws);
      pending.connectionLogger.warn(
        { timeoutMs: HELLO_TIMEOUT_MS },
        "Closing connection due to missing hello"
      );
      try {
        ws.close(WS_CLOSE_HELLO_TIMEOUT, "Hello timeout");
      } catch {
        // ignore close errors
      }
    }, HELLO_TIMEOUT_MS);
    pending.helloTimeout = timeout;
    (timeout as unknown as { unref?: () => void }).unref?.();

    this.pendingConnections.set(ws, pending);
    this.bindSocketHandlers(ws);

    pending.connectionLogger.trace(
      {
        totalPendingConnections: this.pendingConnections.size,
      },
      "Client connected; awaiting hello"
    );
  }

  private createSessionConnection(params: {
    ws: WebSocketLike;
    clientId: string;
    connectionLogger: pino.Logger;
  }): SessionConnection {
    const { ws, clientId, connectionLogger } = params;
    let connection: SessionConnection | null = null;

    const session = new Session({
      clientId,
      onMessage: (msg) => {
        if (!connection) {
          return;
        }
        this.sendToConnection(connection, wrapSessionMessage(msg));
      },
      onBinaryMessage: (frame) => {
        if (!connection) {
          return;
        }
        this.sendBinaryToConnection(connection, frame);
      },
      onLifecycleIntent: (intent) => {
        this.onLifecycleIntent?.(intent);
      },
      logger: connectionLogger.child({ module: "session" }),
      downloadTokenStore: this.downloadTokenStore,
      pushTokenStore: this.pushTokenStore,
      paseoHome: this.paseoHome,
      agentManager: this.agentManager,
      agentStorage: this.agentStorage,
      createAgentMcpTransport: this.createAgentMcpTransport,
      stt: this.stt,
      tts: this.tts,
      terminalManager: this.terminalManager,
      voice: this.voice ?? undefined,
      voiceBridge: {
        registerVoiceSpeakHandler: (agentId, handler) => {
          this.voiceSpeakHandlers.set(agentId, handler);
        },
        unregisterVoiceSpeakHandler: (agentId) => {
          this.voiceSpeakHandlers.delete(agentId);
        },
        registerVoiceCallerContext: (agentId, context) => {
          this.voiceCallerContexts.set(agentId, context);
        },
        unregisterVoiceCallerContext: (agentId) => {
          this.voiceCallerContexts.delete(agentId);
        },
        ensureVoiceMcpSocketForAgent: this.voice?.ensureVoiceMcpSocketForAgent,
        removeVoiceMcpSocketForAgent: this.voice?.removeVoiceMcpSocketForAgent,
      },
      dictation: this.dictation ?? undefined,
      agentProviderRuntimeSettings: this.agentProviderRuntimeSettings,
    });

    connection = {
      session,
      clientId,
      connectionLogger,
      sockets: new Set([ws]),
      externalDisconnectCleanupTimeout: null,
    };
    return connection;
  }

  private clearPendingConnection(ws: WebSocketLike): PendingConnection | null {
    const pending = this.pendingConnections.get(ws);
    if (!pending) {
      return null;
    }
    if (pending.helloTimeout) {
      clearTimeout(pending.helloTimeout);
      pending.helloTimeout = null;
    }
    this.pendingConnections.delete(ws);
    return pending;
  }

  private buildWelcomeMessage(params: { resumed: boolean }): WSWelcomeMessage {
    return {
      type: "welcome",
      serverId: this.serverId,
      hostname: getHostname(),
      version: this.daemonVersion,
      resumed: params.resumed,
      ...(this.serverCapabilities ? { capabilities: this.serverCapabilities } : {}),
    };
  }

  private handleHello(params: {
    ws: WebSocketLike;
    message: WSHelloMessage;
    pending: PendingConnection;
  }): void {
    const { ws, message, pending } = params;

    if (message.protocolVersion !== WS_PROTOCOL_VERSION) {
      this.clearPendingConnection(ws);
      pending.connectionLogger.warn(
        {
          receivedProtocolVersion: message.protocolVersion,
          expectedProtocolVersion: WS_PROTOCOL_VERSION,
        },
        "Rejected hello due to protocol version mismatch"
      );
      try {
        ws.close(WS_CLOSE_INCOMPATIBLE_PROTOCOL, "Incompatible protocol version");
      } catch {
        // ignore close errors
      }
      return;
    }

    const clientId = message.clientId.trim();
    if (clientId.length === 0) {
      this.clearPendingConnection(ws);
      pending.connectionLogger.warn("Rejected hello with empty clientId");
      try {
        ws.close(WS_CLOSE_INVALID_HELLO, "Invalid hello");
      } catch {
        // ignore close errors
      }
      return;
    }

    this.clearPendingConnection(ws);
    const existing = this.externalSessionsByKey.get(clientId);
    if (existing) {
      if (existing.externalDisconnectCleanupTimeout) {
        clearTimeout(existing.externalDisconnectCleanupTimeout);
        existing.externalDisconnectCleanupTimeout = null;
      }
      existing.sockets.add(ws);
      this.sessions.set(ws, existing);
      this.sendToClient(ws, this.buildWelcomeMessage({ resumed: true }));
      existing.connectionLogger.trace(
        {
          clientId,
          resumed: true,
          totalSessions: this.sessions.size,
        },
        "Client connected via hello"
      );
      return;
    }

    const connectionLogger = pending.connectionLogger.child({ clientId });
    const connection = this.createSessionConnection({
      ws,
      clientId,
      connectionLogger,
    });
    this.sessions.set(ws, connection);
    this.externalSessionsByKey.set(clientId, connection);
    this.sendToClient(ws, this.buildWelcomeMessage({ resumed: false }));
    connection.connectionLogger.trace(
      {
        clientId,
        resumed: false,
        totalSessions: this.sessions.size,
      },
      "Client connected via hello"
    );
  }

  private buildServerInfoStatusPayload(): ServerInfoStatusPayload {
    return {
      status: "server_info",
      serverId: this.serverId,
      hostname: getHostname(),
      version: this.daemonVersion,
      ...(this.serverCapabilities ? { capabilities: this.serverCapabilities } : {}),
    };
  }

  private broadcastCapabilitiesUpdate(): void {
    this.broadcast(
      wrapSessionMessage({
        type: "status",
        payload: this.buildServerInfoStatusPayload(),
      })
    );
  }

  private bindSocketHandlers(ws: WebSocketLike): void {
    ws.on("message", (data) => {
      void this.handleRawMessage(ws, data);
    });

    ws.on("close", async (code: number, reason: unknown) => {
      await this.detachSocket(ws, {
        code: typeof code === "number" ? code : undefined,
        reason,
      });
    });

    ws.on("error", async (error) => {
      const err = error instanceof Error ? error : new Error(String(error));
      const active = this.sessions.get(ws);
      const pending = this.pendingConnections.get(ws);
      const log = active?.connectionLogger ?? pending?.connectionLogger ?? this.logger;
      log.error({ err }, "Client error");
      await this.detachSocket(ws, { error: err });
    });
  }

  public resolveVoiceSpeakHandler(
    callerAgentId: string
  ): VoiceSpeakHandler | null {
    return this.voiceSpeakHandlers.get(callerAgentId) ?? null;
  }

  public resolveVoiceCallerContext(
    callerAgentId: string
  ): VoiceCallerContext | null {
    return this.voiceCallerContexts.get(callerAgentId) ?? null;
  }

  private async detachSocket(
    ws: WebSocketLike,
    details: {
      code?: number;
      reason?: unknown;
      error?: Error;
    }
  ): Promise<void> {
    const pending = this.clearPendingConnection(ws);
    if (pending) {
      pending.connectionLogger.trace(
        {
          code: details.code,
          reason: stringifyCloseReason(details.reason),
        },
        "Pending client disconnected"
      );
      return;
    }

    const connection = this.sessions.get(ws);
    if (!connection) {
      return;
    }

    this.sessions.delete(ws);
    connection.sockets.delete(ws);

    if (connection.sockets.size === 0) {
      if (connection.externalDisconnectCleanupTimeout) {
        clearTimeout(connection.externalDisconnectCleanupTimeout);
      }
      const timeout = setTimeout(() => {
        if (connection.externalDisconnectCleanupTimeout !== timeout) {
          return;
        }
        connection.externalDisconnectCleanupTimeout = null;
        void this.cleanupConnection(connection, "Client disconnected (grace timeout)");
      }, EXTERNAL_SESSION_DISCONNECT_GRACE_MS);
      connection.externalDisconnectCleanupTimeout = timeout;

      connection.connectionLogger.trace(
        {
          clientId: connection.clientId,
          code: details.code,
          reason: stringifyCloseReason(details.reason),
          reconnectGraceMs: EXTERNAL_SESSION_DISCONNECT_GRACE_MS,
        },
        "Client disconnected; waiting for reconnect"
      );
      return;
    }

    if (connection.sockets.size > 0) {
      connection.connectionLogger.trace(
        {
          clientId: connection.clientId,
          remainingSockets: connection.sockets.size,
          code: details.code,
          reason: stringifyCloseReason(details.reason),
        },
        "Client socket disconnected; session remains attached"
      );
      return;
    }

    await this.cleanupConnection(connection, "Client disconnected");
  }

  private async cleanupConnection(
    connection: SessionConnection,
    logMessage: string
  ): Promise<void> {
    if (connection.externalDisconnectCleanupTimeout) {
      clearTimeout(connection.externalDisconnectCleanupTimeout);
      connection.externalDisconnectCleanupTimeout = null;
    }

    for (const socket of connection.sockets) {
      this.sessions.delete(socket);
    }
    connection.sockets.clear();
    const existing = this.externalSessionsByKey.get(connection.clientId);
    if (existing === connection) {
      this.externalSessionsByKey.delete(connection.clientId);
    }

    connection.connectionLogger.trace(
      { clientId: connection.clientId, totalSessions: this.sessions.size },
      logMessage
    );
    await connection.session.cleanup();
  }

  private async handleRawMessage(
    ws: WebSocketLike,
    data: Buffer | ArrayBuffer | Buffer[] | string
  ): Promise<void> {
    const activeConnection = this.sessions.get(ws);
    const pendingConnection = this.pendingConnections.get(ws);
    const log = activeConnection?.connectionLogger ?? pendingConnection?.connectionLogger ?? this.logger;

    try {
      const buffer = bufferFromWsData(data);
      const asBytes = asUint8Array(buffer);
      if (asBytes) {
        const frame = decodeBinaryMuxFrame(asBytes);
        if (frame) {
          if (!activeConnection) {
            log.warn("Rejected binary frame before hello");
            this.clearPendingConnection(ws);
            try {
              ws.close(WS_CLOSE_INVALID_HELLO, "Session message before hello");
            } catch {
              // ignore close errors
            }
            return;
          }
          activeConnection.session.handleBinaryFrame(frame);
          return;
        }
      }
      const parsed = JSON.parse(buffer.toString());
      const parsedMessage = WSInboundMessageSchema.safeParse(parsed);
      if (!parsedMessage.success) {
        if (pendingConnection) {
          pendingConnection.connectionLogger.warn(
            {
              error: parsedMessage.error.message,
            },
            "Rejected pending message before hello"
          );
          this.clearPendingConnection(ws);
          try {
            ws.close(WS_CLOSE_INVALID_HELLO, "Invalid hello");
          } catch {
            // ignore close errors
          }
          return;
        }

        const requestInfo = extractRequestInfoFromUnknownWsInbound(parsed);
        const isUnknownSchema =
          requestInfo?.requestId != null &&
          typeof parsed === "object" &&
          parsed != null &&
          "type" in parsed &&
          (parsed as { type?: unknown }).type === "session";

        log.warn(
          {
            clientId: activeConnection?.clientId,
            requestId: requestInfo?.requestId,
            requestType: requestInfo?.requestType,
            error: parsedMessage.error.message,
          },
          "WS inbound message validation failed"
        );

        if (requestInfo) {
          this.sendToClient(
            ws,
            wrapSessionMessage({
              type: "rpc_error",
              payload: {
                requestId: requestInfo.requestId,
                requestType: requestInfo.requestType,
                error: isUnknownSchema ? "Unknown request schema" : "Invalid message",
                code: isUnknownSchema ? "unknown_schema" : "invalid_message",
              },
            })
          );
          return;
        }

        const errorMessage = `Invalid message: ${parsedMessage.error.message}`;
        this.sendToClient(
          ws,
          wrapSessionMessage({
            type: "status",
            payload: {
              status: "error",
              message: errorMessage,
            },
          })
        );
        return;
      }

      const message = parsedMessage.data;

      if (message.type === "ping") {
        this.sendToClient(ws, { type: "pong" });
        return;
      }

      if (message.type === "recording_state") {
        return;
      }

      if (pendingConnection) {
        if (message.type === "hello") {
          this.handleHello({
            ws,
            message,
            pending: pendingConnection,
          });
          return;
        }

        pendingConnection.connectionLogger.warn(
          {
            messageType: message.type,
          },
          "Rejected pending message before hello"
        );
        this.clearPendingConnection(ws);
        try {
          ws.close(WS_CLOSE_INVALID_HELLO, "Session message before hello");
        } catch {
          // ignore close errors
        }
        return;
      }

      if (!activeConnection) {
        this.logger.error("No connection found for websocket");
        return;
      }

      if (message.type === "hello") {
        activeConnection.connectionLogger.warn("Received hello on active connection");
        try {
          ws.close(WS_CLOSE_INVALID_HELLO, "Unexpected hello");
        } catch {
          // ignore close errors
        }
        return;
      }

      if (message.type === "session") {
        await activeConnection.session.handleMessage(message.message);
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      let rawPayload: string | null = null;
      let parsedPayload: unknown = null;

      try {
        const buffer = bufferFromWsData(data);
        rawPayload = buffer.toString();
        parsedPayload = JSON.parse(rawPayload);
      } catch (payloadError) {
        rawPayload = rawPayload ?? "<unreadable>";
        parsedPayload = parsedPayload ?? rawPayload;
        const payloadErr =
          payloadError instanceof Error ? payloadError : new Error(String(payloadError));
        this.logger.error({ err: payloadErr }, "Failed to decode raw payload");
      }

      const trimmedRawPayload =
        typeof rawPayload === "string" && rawPayload.length > 2000
          ? `${rawPayload.slice(0, 2000)}... (truncated)`
          : rawPayload;

      log.error(
        {
          err,
          rawPayload: trimmedRawPayload,
          parsedPayload,
        },
        "Failed to parse/handle message"
      );

      if (this.pendingConnections.has(ws)) {
        this.clearPendingConnection(ws);
        try {
          ws.close(WS_CLOSE_INVALID_HELLO, "Invalid hello");
        } catch {
          // ignore close errors
        }
        return;
      }

      const requestInfo = extractRequestInfoFromUnknownWsInbound(parsedPayload);
      if (requestInfo) {
        this.sendToClient(
          ws,
          wrapSessionMessage({
            type: "rpc_error",
            payload: {
              requestId: requestInfo.requestId,
              requestType: requestInfo.requestType,
              error: "Invalid message",
              code: "invalid_message",
            },
          })
        );
        return;
      }

      this.sendToClient(
        ws,
        wrapSessionMessage({
          type: "status",
          payload: {
            status: "error",
            message: `Invalid message: ${err.message}`,
          },
        })
      );
    }
  }

  private readonly ACTIVITY_THRESHOLD_MS = 120_000;

  private getClientActivityState(session: Session): ClientAttentionState {
    const activity = session.getClientActivity();
    if (!activity) {
      return { deviceType: null, focusedAgentId: null, isStale: true, appVisible: false };
    }
    const now = Date.now();
    const ageMs = now - activity.lastActivityAt.getTime();
    const isStale = ageMs >= this.ACTIVITY_THRESHOLD_MS;
    return {
      deviceType: activity.deviceType,
      focusedAgentId: activity.focusedAgentId,
      isStale,
      appVisible: activity.appVisible,
    };
  }

  private broadcastAgentAttention(params: {
    agentId: string;
    provider: AgentProvider;
    reason: "finished" | "error" | "permission";
  }): void {
    const clientEntries: Array<{
      ws: WebSocketLike;
      state: ClientAttentionState;
    }> = [];

    for (const [ws, connection] of this.sessions) {
      clientEntries.push({
        ws,
        state: this.getClientActivityState(connection.session),
      });
    }

    const allStates = clientEntries.map((e) => e.state);
    const agent = this.agentManager.getAgent(params.agentId);
    if (agent?.labels?.ui !== "true") {
      this.logger.debug(
        {
          agentId: params.agentId,
          labels: agent?.labels ?? null,
        },
        "Skipping attention notification for non-UI agent"
      );
      return;
    }
    const notification = buildAgentAttentionNotificationPayload({
      reason: params.reason,
      serverId: this.serverId,
      agentId: params.agentId,
      assistantMessage: agent
        ? findLatestAssistantMessageFromTimeline(agent.timeline)
        : null,
      permissionRequest: agent
        ? findLatestPermissionRequest(agent.pendingPermissions)
        : null,
    });

    // Push is only a fallback when the user is away from desktop/web.
    // Also suppress push if they're actively using the mobile app.
    const shouldSendPush = computeShouldSendPush({
      reason: params.reason,
      allClientStates: allStates,
    });

    if (shouldSendPush) {
      const tokens = this.pushTokenStore.getAllTokens();
      this.logger.info({ tokenCount: tokens.length }, "Sending push notification");
      if (tokens.length > 0) {
        void this.pushService.sendPush(tokens, notification);
      }
    }

    for (const { ws, state } of clientEntries) {
      const shouldNotify = computeShouldNotifyClient({
        clientState: state,
        allClientStates: allStates,
        agentId: params.agentId,
      });

      const message = wrapSessionMessage({
        type: "agent_stream",
        payload: {
          agentId: params.agentId,
          event: {
            type: "attention_required",
            provider: params.provider,
            reason: params.reason,
            timestamp: new Date().toISOString(),
            shouldNotify,
            notification,
          },
          timestamp: new Date().toISOString(),
        },
      });

      this.sendToClient(ws, message);
    }
  }
}

type SocketRequestMetadata = {
  host?: string;
  origin?: string;
  userAgent?: string;
  remoteAddress?: string;
};

function extractSocketRequestMetadata(request: unknown): SocketRequestMetadata {
  if (!request || typeof request !== "object") {
    return {};
  }

  const record = request as {
    headers?: {
      host?: unknown;
      origin?: unknown;
      "user-agent"?: unknown;
    };
    url?: unknown;
    socket?: {
      remoteAddress?: unknown;
    };
  };

  const host = typeof record.headers?.host === "string" ? record.headers.host : undefined;
  const origin =
    typeof record.headers?.origin === "string" ? record.headers.origin : undefined;
  const userAgent =
    typeof record.headers?.["user-agent"] === "string"
      ? record.headers["user-agent"]
      : undefined;
  const remoteAddress =
    typeof record.socket?.remoteAddress === "string"
      ? record.socket.remoteAddress
      : undefined;

  return {
    ...(host ? { host } : {}),
    ...(origin ? { origin } : {}),
    ...(userAgent ? { userAgent } : {}),
    ...(remoteAddress ? { remoteAddress } : {}),
  };
}

function stringifyCloseReason(reason: unknown): string | null {
  if (typeof reason === "string") {
    return reason.length > 0 ? reason : null;
  }
  if (Buffer.isBuffer(reason)) {
    const text = reason.toString();
    return text.length > 0 ? text : null;
  }
  if (reason == null) {
    return null;
  }
  const text = String(reason);
  return text.length > 0 ? text : null;
}

function extractRequestInfoFromUnknownWsInbound(
  payload: unknown
): { requestId: string; requestType?: string } | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const record = payload as {
    type?: unknown;
    requestId?: unknown;
    message?: unknown;
  };

  // Session-wrapped messages
  if (record.type === "session" && record.message && typeof record.message === "object") {
    const msg = record.message as { requestId?: unknown; type?: unknown };
    if (typeof msg.requestId === "string") {
      return {
        requestId: msg.requestId,
        ...(typeof msg.type === "string" ? { requestType: msg.type } : {}),
      };
    }
  }

  // Non-session messages (future-proof)
  if (typeof record.requestId === "string") {
    return {
      requestId: record.requestId,
      ...(typeof record.type === "string" ? { requestType: record.type } : {}),
    };
  }

  return null;
}
