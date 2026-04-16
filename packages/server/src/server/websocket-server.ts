import { WebSocketServer } from "ws";
import type { Server as HTTPServer } from "http";
import { join } from "path";
import { hostname as getHostname } from "node:os";
import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import type { DownloadTokenStore } from "./file-download/token-store.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import type pino from "pino";
import type { ProjectRegistry, WorkspaceRegistry } from "./workspace-registry.js";
import type { FileBackedChatService } from "./chat/chat-service.js";
import type { LoopService } from "./loop-service.js";
import type { ScheduleService } from "./schedule/service.js";
import type { CheckoutDiffManager, CheckoutDiffMetrics } from "./checkout-diff-manager.js";
import type { DaemonConfigStore, MutableDaemonConfig } from "./daemon-config-store.js";
import {
  type ServerInfoStatusPayload,
  type WSHelloMessage,
  WSInboundMessageSchema,
  type ServerCapabilityState,
  type ServerCapabilities,
  type WSOutboundMessage,
  wrapSessionMessage,
} from "./messages.js";
import { asUint8Array, decodeTerminalStreamFrame } from "../shared/terminal-stream-protocol.js";
import type { HostnamesConfig } from "./hostnames.js";
import { isHostnameAllowed } from "./hostnames.js";
import { Session, type SessionLifecycleIntent, type SessionRuntimeMetrics } from "./session.js";
import type { AgentProvider } from "./agent/agent-sdk-types.js";
import type {
  AgentProviderRuntimeSettingsMap,
  ProviderOverride,
} from "./agent/provider-launch-config.js";
import { ProviderSnapshotManager } from "./agent/provider-snapshot-manager.js";
import { buildProviderRegistry } from "./agent/provider-registry.js";
import { WorkspaceGitServiceImpl } from "./workspace-git-service.js";
import { PushTokenStore } from "./push/token-store.js";
import { PushService } from "./push/push-service.js";
import type { SpeechReadinessSnapshot, SpeechService } from "./speech/speech-runtime.js";
import type { VoiceCallerContext, VoiceSpeakHandler } from "./voice-types.js";
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
  hostnames?: HostnamesConfig;
};

type WebSocketRuntimeMetrics = SessionRuntimeMetrics & CheckoutDiffMetrics;

function createFallbackWorkspaceGitService(): WorkspaceGitServiceImpl {
  return {
    subscribe: async ({ cwd }: { cwd: string }) => ({
      initial: {
        cwd,
        git: {
          isGit: false,
          repoRoot: null,
          mainRepoRoot: null,
          currentBranch: null,
          remoteUrl: null,
          isPaseoOwnedWorktree: false,
          isDirty: null,
          aheadBehind: null,
          aheadOfOrigin: null,
          behindOfOrigin: null,
          diffStat: null,
        },
        github: {
          featuresEnabled: false,
          pullRequest: null,
          error: null,
          refreshedAt: null,
        },
      },
      unsubscribe: () => {},
    }),
    peekSnapshot: () => null,
    getSnapshot: async (cwd: string) => ({
      cwd,
      git: {
        isGit: false,
        repoRoot: null,
        mainRepoRoot: null,
        currentBranch: null,
        remoteUrl: null,
        isPaseoOwnedWorktree: false,
        isDirty: null,
        aheadBehind: null,
        aheadOfOrigin: null,
        behindOfOrigin: null,
        diffStat: null,
      },
      github: {
        featuresEnabled: false,
        pullRequest: null,
        error: null,
        refreshedAt: null,
      },
    }),
    refresh: async () => {},
    requestWorkingTreeWatch: async (cwd: string) => ({
      repoRoot: cwd,
      unsubscribe: () => {},
    }),
    scheduleRefreshForCwd: () => {},
    dispose: () => {},
  } as unknown as WorkspaceGitServiceImpl;
}

function createNoopProjectRegistry(): ProjectRegistry {
  return {
    initialize: async () => {},
    existsOnDisk: async () => true,
    list: async () => [],
    get: async () => null,
    upsert: async () => {},
    archive: async () => {},
    remove: async () => {},
  };
}

function createNoopWorkspaceRegistry(): WorkspaceRegistry {
  return {
    initialize: async () => {},
    existsOnDisk: async () => true,
    list: async () => [],
    get: async () => null,
    upsert: async () => {},
    archive: async () => {},
    remove: async () => {},
  };
}

function toServerCapabilityState(params: {
  state: SpeechReadinessSnapshot["dictation"];
  reason: string;
}): ServerCapabilityState {
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
  next: ServerCapabilities | undefined,
): boolean {
  return JSON.stringify(current ?? null) === JSON.stringify(next ?? null);
}

function bufferFromWsData(data: Buffer | ArrayBuffer | Buffer[] | string): Buffer {
  if (typeof data === "string") return Buffer.from(data, "utf8");
  if (Array.isArray(data)) {
    return Buffer.concat(
      data.map((item) => (Buffer.isBuffer(item) ? item : Buffer.from(item as ArrayBuffer))),
    );
  }
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(data as ArrayBuffer);
}

type WebSocketLike = {
  readyState: number;
  bufferedAmount?: number;
  send: (data: string | Uint8Array | ArrayBuffer) => void;
  close: (code?: number, reason?: string) => void;
  on: (event: "message" | "close" | "error", listener: (...args: any[]) => void) => void;
  once: (event: "close" | "error", listener: (...args: any[]) => void) => void;
};

type SessionConnection = {
  session: Session;
  clientId: string;
  appVersion: string | null;
  connectionLogger: pino.Logger;
  sockets: Set<WebSocketLike>;
  externalDisconnectCleanupTimeout: ReturnType<typeof setTimeout> | null;
};

type WebSocketRuntimeCounters = {
  connectedAwaitingHello: number;
  helloResumed: number;
  helloNew: number;
  pendingDisconnected: number;
  sessionDisconnectedWaitingReconnect: number;
  sessionSocketDisconnectedAttached: number;
  sessionCleanup: number;
  validationFailed: number;
  binaryBeforeHelloRejected: number;
  pendingMessageRejectedBeforeHello: number;
  missingConnectionForMessage: number;
  unexpectedHelloOnActiveConnection: number;
  relayExternalSocketAttached: number;
  originRejected: number;
  hostRejected: number;
};

const SLOW_REQUEST_THRESHOLD_MS = 500;
const EXTERNAL_SESSION_DISCONNECT_GRACE_MS = 90_000;
const HELLO_TIMEOUT_MS = 15_000;
const WS_CLOSE_HELLO_TIMEOUT = 4001;
const WS_CLOSE_INVALID_HELLO = 4002;
const WS_CLOSE_INCOMPATIBLE_PROTOCOL = 4003;
const WS_PROTOCOL_VERSION = 1;
const WS_RUNTIME_METRICS_FLUSH_MS = 30_000;

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
  private readonly projectRegistry: ProjectRegistry;
  private readonly workspaceRegistry: WorkspaceRegistry;
  private readonly chatService: FileBackedChatService;
  private readonly loopService: LoopService;
  private readonly scheduleService: ScheduleService;
  private readonly checkoutDiffManager: CheckoutDiffManager;
  private readonly workspaceGitService: WorkspaceGitServiceImpl;
  private readonly downloadTokenStore: DownloadTokenStore;
  private readonly paseoHome: string;
  private readonly daemonConfigStore: DaemonConfigStore;
  private readonly pushTokenStore: PushTokenStore;
  private readonly pushService: PushService;
  private readonly mcpBaseUrl: string | null;
  private readonly speech: SpeechService | null;
  private readonly terminalManager: TerminalManager | null;
  private readonly dictation: {
    finalTimeoutMs?: number;
  } | null;
  private readonly voiceSpeakHandlers = new Map<string, VoiceSpeakHandler>();
  private readonly voiceCallerContexts = new Map<string, VoiceCallerContext>();
  private readonly agentProviderRuntimeSettings: AgentProviderRuntimeSettingsMap | undefined;
  private readonly providerOverrides: Record<string, ProviderOverride> | undefined;
  private readonly providerSnapshotManager: ProviderSnapshotManager;
  private readonly onLifecycleIntent: ((intent: SessionLifecycleIntent) => void) | null;
  private serverCapabilities: ServerCapabilities | undefined;
  private runtimeWindowStartedAt = Date.now();
  private readonly runtimeCounters: WebSocketRuntimeCounters = {
    connectedAwaitingHello: 0,
    helloResumed: 0,
    helloNew: 0,
    pendingDisconnected: 0,
    sessionDisconnectedWaitingReconnect: 0,
    sessionSocketDisconnectedAttached: 0,
    sessionCleanup: 0,
    validationFailed: 0,
    binaryBeforeHelloRejected: 0,
    pendingMessageRejectedBeforeHello: 0,
    missingConnectionForMessage: 0,
    unexpectedHelloOnActiveConnection: 0,
    relayExternalSocketAttached: 0,
    originRejected: 0,
    hostRejected: 0,
  };
  private readonly inboundMessageCounts = new Map<string, number>();
  private readonly inboundSessionRequestCounts = new Map<string, number>();
  private readonly requestLatencies = new Map<string, number[]>();
  private runtimeMetricsInterval: ReturnType<typeof setInterval> | null = null;
  private unsubscribeSpeechReadiness: (() => void) | null = null;
  private unsubscribeDaemonConfigChange: (() => void) | null = null;

  constructor(
    server: HTTPServer,
    logger: pino.Logger,
    serverId: string,
    agentManager: AgentManager,
    agentStorage: AgentStorage,
    downloadTokenStore: DownloadTokenStore,
    paseoHome: string,
    daemonConfigStore: DaemonConfigStore,
    mcpBaseUrl: string | null,
    wsConfig: WebSocketServerConfig,
    speech?: SpeechService | null,
    terminalManager?: TerminalManager | null,
    dictation?: {
      finalTimeoutMs?: number;
    },
    agentProviderRuntimeSettings?: AgentProviderRuntimeSettingsMap,
    providerOverrides?: Record<string, ProviderOverride>,
    daemonVersion?: string,
    onLifecycleIntent?: (intent: SessionLifecycleIntent) => void,
    projectRegistry?: ProjectRegistry,
    workspaceRegistry?: WorkspaceRegistry,
    chatService?: FileBackedChatService,
    loopService?: LoopService,
    scheduleService?: ScheduleService,
    checkoutDiffManager?: CheckoutDiffManager,
    workspaceGitService?: WorkspaceGitServiceImpl,
  ) {
    this.logger = logger.child({ module: "websocket-server" });
    this.serverId = serverId;
    if (typeof daemonVersion !== "string" || daemonVersion.trim().length === 0) {
      throw new MissingDaemonVersionError();
    }
    this.daemonVersion = daemonVersion.trim();
    this.agentManager = agentManager;
    this.agentStorage = agentStorage;
    this.projectRegistry = projectRegistry ?? createNoopProjectRegistry();
    this.workspaceRegistry = workspaceRegistry ?? createNoopWorkspaceRegistry();
    if (!chatService) {
      throw new Error("VoiceAssistantWebSocketServer requires a chat service.");
    }
    this.chatService = chatService;
    if (!loopService) {
      throw new Error("VoiceAssistantWebSocketServer requires a loop service.");
    }
    this.loopService = loopService;
    if (!scheduleService) {
      throw new Error("VoiceAssistantWebSocketServer requires a schedule service.");
    }
    this.scheduleService = scheduleService;
    if (!checkoutDiffManager) {
      throw new Error("VoiceAssistantWebSocketServer requires a checkout diff manager.");
    }
    this.checkoutDiffManager = checkoutDiffManager;
    this.workspaceGitService = workspaceGitService ?? createFallbackWorkspaceGitService();
    this.downloadTokenStore = downloadTokenStore;
    this.paseoHome = paseoHome;
    this.daemonConfigStore = daemonConfigStore;
    this.mcpBaseUrl = mcpBaseUrl;
    this.speech = speech ?? null;
    this.terminalManager = terminalManager ?? null;
    this.dictation = dictation ?? null;
    this.agentProviderRuntimeSettings = agentProviderRuntimeSettings;
    this.providerOverrides = providerOverrides;
    const providerSnapshotLogger = this.logger.child({ module: "provider-snapshot-manager" });
    this.providerSnapshotManager = new ProviderSnapshotManager(
      buildProviderRegistry(providerSnapshotLogger, {
        runtimeSettings: this.agentProviderRuntimeSettings,
        providerOverrides: this.providerOverrides,
      }),
      providerSnapshotLogger,
    );
    this.onLifecycleIntent = onLifecycleIntent ?? null;
    this.serverCapabilities = buildServerCapabilities({
      readiness: this.speech?.getReadiness() ?? null,
    });
    this.unsubscribeSpeechReadiness =
      this.speech?.onReadinessChange((snapshot) => {
        this.publishSpeechReadiness(snapshot);
      }) ?? null;
    this.unsubscribeDaemonConfigChange = this.daemonConfigStore.onChange((config) => {
      this.broadcastDaemonConfigChanged(config);
    });

    const pushLogger = this.logger.child({ module: "push" });
    this.pushTokenStore = new PushTokenStore(pushLogger, join(paseoHome, "push-tokens.json"));
    this.pushService = new PushService(pushLogger, this.pushTokenStore);

    this.agentManager.setAgentAttentionCallback((params) => {
      this.broadcastAgentAttention(params);
    });

    const { allowedOrigins, hostnames } = wsConfig;
    this.wss = new WebSocketServer({
      server,
      path: "/ws",
      verifyClient: ({ req }, callback) => {
        const requestMetadata = extractSocketRequestMetadata(req);
        const origin = requestMetadata.origin;
        const requestHost = requestMetadata.host ?? null;
        if (requestHost && !isHostnameAllowed(requestHost, hostnames)) {
          this.incrementRuntimeCounter("hostRejected");
          this.logger.warn(
            { ...requestMetadata, host: requestHost },
            "Rejected connection from disallowed host",
          );
          callback(false, 403, "Host not allowed");
          return;
        }
        const sameOrigin =
          !!origin &&
          !!requestHost &&
          (origin === `http://${requestHost}` || origin === `https://${requestHost}`);

        if (!origin || allowedOrigins.has("*") || allowedOrigins.has(origin) || sameOrigin) {
          callback(true);
        } else {
          this.incrementRuntimeCounter("originRejected");
          this.logger.warn({ ...requestMetadata, origin }, "Rejected connection from origin");
          callback(false, 403, "Origin not allowed");
        }
      },
    });

    this.wss.on("connection", (ws, request) => {
      void this.attachSocket(ws, request);
    });

    const runtimeMetricsInterval = setInterval(() => {
      this.flushRuntimeMetrics();
    }, WS_RUNTIME_METRICS_FLUSH_MS);
    this.runtimeMetricsInterval = runtimeMetricsInterval;
    (runtimeMetricsInterval as unknown as { unref?: () => void }).unref?.();

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

  public updateServerCapabilities(capabilities: ServerCapabilities | null | undefined): void {
    const next = capabilities ?? undefined;
    if (areServerCapabilitiesEqual(this.serverCapabilities, next)) {
      return;
    }
    this.serverCapabilities = next;
    this.broadcastCapabilitiesUpdate();
  }

  public async attachExternalSocket(
    ws: WebSocketLike,
    metadata?: ExternalSocketMetadata,
  ): Promise<void> {
    if (metadata?.transport === "relay") {
      this.incrementRuntimeCounter("relayExternalSocketAttached");
    }
    await this.attachSocket(ws, undefined, metadata);
  }

  public async close(): Promise<void> {
    this.unsubscribeSpeechReadiness?.();
    this.unsubscribeSpeechReadiness = null;
    this.unsubscribeDaemonConfigChange?.();
    this.unsubscribeDaemonConfigChange = null;
    if (this.runtimeMetricsInterval) {
      clearInterval(this.runtimeMetricsInterval);
      this.runtimeMetricsInterval = null;
    }
    this.flushRuntimeMetrics({ final: true });

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
          }),
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
        }),
      );
    }

    await Promise.all(cleanupPromises);
    this.providerSnapshotManager.destroy();
    this.checkoutDiffManager.dispose();
    this.workspaceGitService.dispose();
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

  private sendBinaryToClient(ws: WebSocketLike, frame: Uint8Array): void {
    if (ws.readyState !== 1) {
      return;
    }
    ws.send(frame);
  }

  private sendToConnection(connection: SessionConnection, message: WSOutboundMessage): void {
    for (const ws of connection.sockets) {
      this.sendToClient(ws, message);
    }
  }

  private sendBinaryToConnection(connection: SessionConnection, frame: Uint8Array): void {
    for (const ws of connection.sockets) {
      this.sendBinaryToClient(ws, frame);
    }
  }

  private async attachSocket(
    ws: WebSocketLike,
    request?: unknown,
    metadata?: ExternalSocketMetadata,
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
        "Closing connection due to missing hello",
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
    this.incrementRuntimeCounter("connectedAwaitingHello");
    this.bindSocketHandlers(ws);

    pending.connectionLogger.trace(
      {
        totalPendingConnections: this.pendingConnections.size,
      },
      "Client connected; awaiting hello",
    );
  }

  private createSessionConnection(params: {
    ws: WebSocketLike;
    clientId: string;
    appVersion: string | null;
    connectionLogger: pino.Logger;
  }): SessionConnection {
    const { ws, clientId, appVersion, connectionLogger } = params;
    let connection: SessionConnection | null = null;

    const session = new Session({
      clientId,
      appVersion,
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
      projectRegistry: this.projectRegistry,
      workspaceRegistry: this.workspaceRegistry,
      chatService: this.chatService,
      loopService: this.loopService,
      scheduleService: this.scheduleService,
      checkoutDiffManager: this.checkoutDiffManager,
      workspaceGitService: this.workspaceGitService,
      daemonConfigStore: this.daemonConfigStore,
      mcpBaseUrl: this.mcpBaseUrl,
      stt: () => this.speech?.resolveStt() ?? null,
      tts: () => this.speech?.resolveTts() ?? null,
      terminalManager: this.terminalManager,
      providerSnapshotManager: this.providerSnapshotManager,
      voice: {
        turnDetection: () => this.speech?.resolveTurnDetection() ?? null,
      },
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
      },
      dictation:
        this.dictation || this.speech
          ? {
              finalTimeoutMs: this.dictation?.finalTimeoutMs,
              stt: () => this.speech?.resolveDictationStt() ?? null,
              getSpeechReadiness: () => this.speech!.getReadiness(),
            }
          : undefined,
      agentProviderRuntimeSettings: this.agentProviderRuntimeSettings,
      providerOverrides: this.providerOverrides,
    });

    connection = {
      session,
      clientId,
      appVersion,
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
        "Rejected hello due to protocol version mismatch",
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
      this.incrementRuntimeCounter("helloResumed");
      if (existing.externalDisconnectCleanupTimeout) {
        clearTimeout(existing.externalDisconnectCleanupTimeout);
        existing.externalDisconnectCleanupTimeout = null;
      }
      const newAppVersion = message.appVersion ?? null;
      if (newAppVersion && newAppVersion !== existing.appVersion) {
        existing.appVersion = newAppVersion;
        existing.session.updateAppVersion(newAppVersion);
      }
      existing.sockets.add(ws);
      this.sessions.set(ws, existing);
      this.sendToClient(ws, this.createServerInfoMessage());
      existing.connectionLogger.trace(
        {
          clientId,
          resumed: true,
          totalSessions: this.sessions.size,
        },
        "Client connected via hello",
      );
      return;
    }

    const connectionLogger = pending.connectionLogger.child({ clientId });
    this.incrementRuntimeCounter("helloNew");
    const connection = this.createSessionConnection({
      ws,
      clientId,
      appVersion: message.appVersion ?? null,
      connectionLogger,
    });
    this.sessions.set(ws, connection);
    this.externalSessionsByKey.set(clientId, connection);
    this.sendToClient(ws, this.createServerInfoMessage());
    connection.connectionLogger.trace(
      {
        clientId,
        resumed: false,
        totalSessions: this.sessions.size,
      },
      "Client connected via hello",
    );
  }

  private buildServerInfoStatusPayload(): ServerInfoStatusPayload {
    return {
      status: "server_info",
      serverId: this.serverId,
      hostname: getHostname(),
      version: this.daemonVersion,
      ...(this.serverCapabilities ? { capabilities: this.serverCapabilities } : {}),
      features: {
        // COMPAT(providersSnapshot): keep optional until all clients rely on snapshot flow.
        providersSnapshot: true,
      },
    };
  }

  private createServerInfoMessage(): WSOutboundMessage {
    return {
      type: "session",
      message: {
        type: "status",
        payload: this.buildServerInfoStatusPayload(),
      },
    };
  }

  private createDaemonConfigChangedMessage(config: MutableDaemonConfig): WSOutboundMessage {
    return wrapSessionMessage({
      type: "status",
      payload: {
        status: "daemon_config_changed",
        config,
      },
    });
  }

  private broadcastCapabilitiesUpdate(): void {
    this.broadcast(this.createServerInfoMessage());
  }

  private broadcastDaemonConfigChanged(config: MutableDaemonConfig): void {
    this.broadcast(this.createDaemonConfigChangedMessage(config));
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

  public resolveVoiceSpeakHandler(callerAgentId: string): VoiceSpeakHandler | null {
    return this.voiceSpeakHandlers.get(callerAgentId) ?? null;
  }

  public resolveVoiceCallerContext(callerAgentId: string): VoiceCallerContext | null {
    return this.voiceCallerContexts.get(callerAgentId) ?? null;
  }

  private async detachSocket(
    ws: WebSocketLike,
    details: {
      code?: number;
      reason?: unknown;
      error?: Error;
    },
  ): Promise<void> {
    const pending = this.clearPendingConnection(ws);
    if (pending) {
      this.incrementRuntimeCounter("pendingDisconnected");
      pending.connectionLogger.trace(
        {
          code: details.code,
          reason: stringifyCloseReason(details.reason),
        },
        "Pending client disconnected",
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
      this.incrementRuntimeCounter("sessionDisconnectedWaitingReconnect");
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
        "Client disconnected; waiting for reconnect",
      );
      return;
    }

    if (connection.sockets.size > 0) {
      this.incrementRuntimeCounter("sessionSocketDisconnectedAttached");
      connection.connectionLogger.trace(
        {
          clientId: connection.clientId,
          remainingSockets: connection.sockets.size,
          code: details.code,
          reason: stringifyCloseReason(details.reason),
        },
        "Client socket disconnected; session remains attached",
      );
      return;
    }

    await this.cleanupConnection(connection, "Client disconnected");
  }

  private async cleanupConnection(
    connection: SessionConnection,
    logMessage: string,
  ): Promise<void> {
    this.incrementRuntimeCounter("sessionCleanup");
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
      logMessage,
    );
    await connection.session.cleanup();
  }

  private async handleRawMessage(
    ws: WebSocketLike,
    data: Buffer | ArrayBuffer | Buffer[] | string,
  ): Promise<void> {
    const activeConnection = this.sessions.get(ws);
    const pendingConnection = this.pendingConnections.get(ws);
    const log =
      activeConnection?.connectionLogger ?? pendingConnection?.connectionLogger ?? this.logger;

    try {
      const buffer = bufferFromWsData(data);
      const asBytes = asUint8Array(buffer);
      if (asBytes) {
        const frame = decodeTerminalStreamFrame(asBytes);
        if (frame) {
          if (!activeConnection) {
            this.incrementRuntimeCounter("binaryBeforeHelloRejected");
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
        this.incrementRuntimeCounter("validationFailed");
        if (pendingConnection) {
          pendingConnection.connectionLogger.warn(
            {
              error: parsedMessage.error.message,
            },
            "Rejected pending message before hello",
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
          "WS inbound message validation failed",
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
            }),
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
          }),
        );
        return;
      }

      const message = parsedMessage.data;
      this.recordInboundMessageType(message.type);

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
          "Rejected pending message before hello",
        );
        this.incrementRuntimeCounter("pendingMessageRejectedBeforeHello");
        this.clearPendingConnection(ws);
        try {
          ws.close(WS_CLOSE_INVALID_HELLO, "Session message before hello");
        } catch {
          // ignore close errors
        }
        return;
      }

      if (!activeConnection) {
        this.incrementRuntimeCounter("missingConnectionForMessage");
        this.logger.error("No connection found for websocket");
        return;
      }

      if (message.type === "hello") {
        this.incrementRuntimeCounter("unexpectedHelloOnActiveConnection");
        activeConnection.connectionLogger.warn("Received hello on active connection");
        try {
          ws.close(WS_CLOSE_INVALID_HELLO, "Unexpected hello");
        } catch {
          // ignore close errors
        }
        return;
      }

      if (message.type === "session") {
        this.recordInboundSessionRequestType(message.message.type);
        const startMs = performance.now();
        await activeConnection.session.handleMessage(message.message);
        const durationMs = performance.now() - startMs;
        this.recordRequestLatency(message.message.type, durationMs);

        if (durationMs >= SLOW_REQUEST_THRESHOLD_MS) {
          activeConnection.connectionLogger.warn(
            {
              requestType: message.message.type,
              durationMs: Math.round(durationMs),
              inflightRequests: activeConnection.session.getRuntimeMetrics().inflightRequests,
            },
            "ws_slow_request",
          );
        }
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
        "Failed to parse/handle message",
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
          }),
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
        }),
      );
    }
  }

  private readonly ACTIVITY_THRESHOLD_MS = 120_000;

  private incrementRuntimeCounter(counter: keyof WebSocketRuntimeCounters): void {
    this.runtimeCounters[counter] += 1;
  }

  private incrementCount(map: Map<string, number>, key: string): void {
    map.set(key, (map.get(key) ?? 0) + 1);
  }

  private recordInboundMessageType(type: string): void {
    this.incrementCount(this.inboundMessageCounts, type);
  }

  private recordInboundSessionRequestType(type: string): void {
    this.incrementCount(this.inboundSessionRequestCounts, type);
  }

  private recordRequestLatency(type: string, durationMs: number): void {
    let latencies = this.requestLatencies.get(type);
    if (!latencies) {
      latencies = [];
      this.requestLatencies.set(type, latencies);
    }
    latencies.push(durationMs);
  }

  private getTopCounts(map: Map<string, number>, limit: number): Array<[string, number]> {
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  }

  private computeLatencyStats(): Array<{
    type: string;
    count: number;
    minMs: number;
    maxMs: number;
    p50Ms: number;
    totalMs: number;
  }> {
    const stats: Array<{
      type: string;
      count: number;
      minMs: number;
      maxMs: number;
      p50Ms: number;
      totalMs: number;
    }> = [];
    for (const [type, latencies] of this.requestLatencies) {
      if (latencies.length === 0) continue;
      latencies.sort((a, b) => a - b);
      const count = latencies.length;
      const minMs = Math.round(latencies[0]!);
      const maxMs = Math.round(latencies[count - 1]!);
      const p50Ms = Math.round(latencies[Math.floor(count / 2)]!);
      const totalMs = Math.round(latencies.reduce((sum, v) => sum + v, 0));
      stats.push({ type, count, minMs, maxMs, p50Ms, totalMs });
    }
    stats.sort((a, b) => b.totalMs - a.totalMs);
    return stats.slice(0, 15);
  }

  private collectSessionRuntimeMetrics(): WebSocketRuntimeMetrics {
    const uniqueConnections = new Set<SessionConnection>(this.externalSessionsByKey.values());
    let terminalDirectorySubscriptionCount = 0;
    let terminalSubscriptionCount = 0;
    let inflightRequests = 0;
    let peakInflightRequests = 0;

    for (const connection of uniqueConnections) {
      const sessionMetrics = connection.session.getRuntimeMetrics();
      terminalDirectorySubscriptionCount += sessionMetrics.terminalDirectorySubscriptionCount;
      terminalSubscriptionCount += sessionMetrics.terminalSubscriptionCount;
      inflightRequests += sessionMetrics.inflightRequests;
      peakInflightRequests = Math.max(peakInflightRequests, sessionMetrics.peakInflightRequests);
      connection.session.resetPeakInflight();
    }

    return {
      ...this.checkoutDiffManager.getMetrics(),
      terminalDirectorySubscriptionCount,
      terminalSubscriptionCount,
      inflightRequests,
      peakInflightRequests,
    };
  }

  private flushRuntimeMetrics(options?: { final?: boolean }): void {
    const now = Date.now();
    const windowMs = Math.max(0, now - this.runtimeWindowStartedAt);
    const activeConnections = new Set<SessionConnection>(this.sessions.values()).size;
    const activeSockets = this.sessions.size;
    const pendingConnections = this.pendingConnections.size;
    const reconnectGraceSessions = [...this.externalSessionsByKey.values()].filter(
      (connection) =>
        connection.sockets.size === 0 && connection.externalDisconnectCleanupTimeout !== null,
    ).length;
    const sessionMetrics = this.collectSessionRuntimeMetrics();
    const latencyStats = this.computeLatencyStats();
    const agentSnapshot = this.agentManager.getMetricsSnapshot();

    this.logger.info(
      {
        windowMs,
        final: Boolean(options?.final),
        sessions: {
          activeConnections,
          externalSessionKeys: this.externalSessionsByKey.size,
          reconnectGraceSessions,
        },
        sockets: {
          activeSockets,
          pendingConnections,
        },
        counters: { ...this.runtimeCounters },
        inboundMessageTypesTop: this.getTopCounts(this.inboundMessageCounts, 12),
        inboundSessionRequestTypesTop: this.getTopCounts(this.inboundSessionRequestCounts, 20),
        runtime: sessionMetrics,
        latency: latencyStats,
        agents: agentSnapshot,
      },
      "ws_runtime_metrics",
    );

    for (const counter of Object.keys(this.runtimeCounters) as Array<
      keyof WebSocketRuntimeCounters
    >) {
      this.runtimeCounters[counter] = 0;
    }
    this.inboundMessageCounts.clear();
    this.inboundSessionRequestCounts.clear();
    this.requestLatencies.clear();
    this.runtimeWindowStartedAt = now;
  }

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
    const notification = buildAgentAttentionNotificationPayload({
      reason: params.reason,
      serverId: this.serverId,
      agentId: params.agentId,
      assistantMessage: agent ? findLatestAssistantMessageFromTimeline(agent.timeline) : null,
      permissionRequest: agent ? findLatestPermissionRequest(agent.pendingPermissions) : null,
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
  const origin = typeof record.headers?.origin === "string" ? record.headers.origin : undefined;
  const userAgent =
    typeof record.headers?.["user-agent"] === "string" ? record.headers["user-agent"] : undefined;
  const remoteAddress =
    typeof record.socket?.remoteAddress === "string" ? record.socket.remoteAddress : undefined;

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
  payload: unknown,
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
