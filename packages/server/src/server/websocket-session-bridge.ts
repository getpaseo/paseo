import type { IncomingMessage } from "http";
import type { WebSocket } from "ws";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { join } from "path";
import {
  WSInboundMessageSchema,
  type WSOutboundMessage,
  wrapSessionMessage,
} from "./messages.js";
import { Session } from "./session.js";
import { AgentManager } from "./agent/agent-manager.js";
import { AgentStorage } from "./agent/agent-storage.js";
import type { AgentProvider } from "./agent/agent-sdk-types.js";
import { DownloadTokenStore } from "./file-download/token-store.js";
import { PushTokenStore } from "./push/token-store.js";
import { PushService } from "./push/push-service.js";
import { VoiceConversationStore } from "./voice-conversation-store.js";
import type { OpenAISTT } from "./agent/stt-openai.js";
import type { OpenAITTS } from "./agent/tts-openai.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import type pino from "pino";

export type AgentMcpTransportFactory = () => Promise<Transport>;

export class WebSocketSessionBridge {
  private readonly logger: pino.Logger;
  private readonly sessions: Map<WebSocket, Session> = new Map();
  private clientIdCounter = 0;
  private readonly agentManager: AgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly downloadTokenStore: DownloadTokenStore;
  private readonly paseoHome: string;
  private readonly pushTokenStore: PushTokenStore;
  private readonly pushService: PushService;
  private readonly createAgentMcpTransport: AgentMcpTransportFactory;
  private readonly stt: OpenAISTT | null;
  private readonly tts: OpenAITTS | null;
  private readonly terminalManager: TerminalManager | null;
  private readonly voiceConversationStore: VoiceConversationStore;
  private readonly dictation: {
    openaiApiKey?: string | null;
    finalTimeoutMs?: number;
  } | null;

  constructor(
    logger: pino.Logger,
    agentManager: AgentManager,
    agentStorage: AgentStorage,
    downloadTokenStore: DownloadTokenStore,
    paseoHome: string,
    createAgentMcpTransport: AgentMcpTransportFactory,
    speech?: { stt: OpenAISTT | null; tts: OpenAITTS | null },
    terminalManager?: TerminalManager | null,
    dictation?: {
      openaiApiKey?: string | null;
      finalTimeoutMs?: number;
    }
  ) {
    this.logger = logger.child({ module: "websocket-session-bridge" });
    this.agentManager = agentManager;
    this.agentStorage = agentStorage;
    this.downloadTokenStore = downloadTokenStore;
    this.paseoHome = paseoHome;
    this.createAgentMcpTransport = createAgentMcpTransport;
    this.stt = speech?.stt ?? null;
    this.tts = speech?.tts ?? null;
    this.terminalManager = terminalManager ?? null;
    this.voiceConversationStore = new VoiceConversationStore(
      join(paseoHome, "voice-conversations")
    );
    this.dictation = dictation ?? null;

    const pushLogger = this.logger.child({ module: "push" });
    this.pushTokenStore = new PushTokenStore(
      pushLogger,
      join(paseoHome, "push-tokens.json")
    );
    this.pushService = new PushService(pushLogger, this.pushTokenStore);

    this.agentManager.setAgentAttentionCallback((params) => {
      this.broadcastAgentAttention(params);
    });
  }

  public getSessionCount(): number {
    return this.sessions.size;
  }

  public async attach(ws: WebSocket, _request: IncomingMessage): Promise<void> {
    const clientId = `client-${++this.clientIdCounter}`;
    const connectionLogger = this.logger.child({ clientId });

    const session = new Session(
      clientId,
      (msg) => {
        this.sendToClient(ws, wrapSessionMessage(msg));
      },
      connectionLogger.child({ module: "session" }),
      this.downloadTokenStore,
      this.pushTokenStore,
      this.paseoHome,
      this.agentManager,
      this.agentStorage,
      this.createAgentMcpTransport,
      this.stt,
      this.tts,
      this.terminalManager,
      this.voiceConversationStore,
      this.dictation ?? undefined
    );

    this.sessions.set(ws, session);

    connectionLogger.info(
      { clientId, totalSessions: this.sessions.size },
      "Client connected"
    );

    ws.on("message", (data) => {
      void this.handleRawMessage(ws, data);
    });

    ws.on("close", async () => {
      await this.detach(ws, connectionLogger, clientId);
    });

    ws.on("error", async (error) => {
      const err = error instanceof Error ? error : new Error(String(error));
      connectionLogger.error({ err }, "Client error");
      await this.detach(ws, connectionLogger, clientId);
    });
  }

  private async detach(ws: WebSocket, connectionLogger: pino.Logger, clientId: string): Promise<void> {
    const session = this.sessions.get(ws);
    if (!session) return;

    connectionLogger.info(
      { clientId, totalSessions: this.sessions.size - 1 },
      "Client disconnected"
    );

    await session.cleanup();
    this.sessions.delete(ws);
  }

  private async handleRawMessage(ws: WebSocket, data: Buffer | ArrayBuffer | Buffer[]): Promise<void> {
    try {
      const parsed = JSON.parse(data.toString());
      const parsedMessage = WSInboundMessageSchema.safeParse(parsed);
      if (!parsedMessage.success) {
        const requestInfo = extractRequestInfoFromUnknownWsInbound(parsed);
        const isUnknownSchema =
          requestInfo?.requestId != null &&
          typeof parsed === "object" &&
          parsed != null &&
          "type" in parsed &&
          (parsed as { type?: unknown }).type === "session";

        this.logger.warn(
          {
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

      const messageSummary = {
        type: message.type,
        ...(message.type === "session" && message.message
          ? { sessionMessageType: message.message.type }
          : {}),
      };
      this.logger.debug(messageSummary, "Received message");

      if (message.type === "ping") {
        this.sendToClient(ws, { type: "pong" });
        return;
      }

      if (message.type === "recording_state") {
        this.logger.debug({ isRecording: message.isRecording }, "Recording state");
        return;
      }

      const session = this.sessions.get(ws);
      if (!session) {
        this.logger.error("No session found for client");
        return;
      }

      if (message.type === "session") {
        if (message.message.type === "create_agent_request") {
          this.logger.debug(
            {
              cwd: message.message.config.cwd,
              initialMode: message.message.config.modeId,
              worktreeName: message.message.worktreeName,
              requestId: message.message.requestId,
            },
            "create_agent_request details"
          );
        }
        await session.handleMessage(message.message);
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      let rawPayload: string | null = null;
      let parsedPayload: unknown = null;

      try {
        const buffer = Array.isArray(data)
          ? Buffer.concat(
              data.map((item) => (Buffer.isBuffer(item) ? item : Buffer.from(item as ArrayBuffer)))
            )
          : Buffer.isBuffer(data)
            ? data
            : Buffer.from(data as ArrayBuffer);
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

      this.logger.error(
        {
          err,
          rawPayload: trimmedRawPayload,
          parsedPayload,
        },
        "Failed to parse/handle message"
      );

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

  private sendToClient(ws: WebSocket, message: WSOutboundMessage): void {
    // WebSocket.OPEN = 1
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(message));
    }
  }

  public broadcast(message: WSOutboundMessage): void {
    const payload = JSON.stringify(message);
    for (const ws of this.sessions.keys()) {
      if (ws.readyState === 1) {
        ws.send(payload);
      }
    }
  }

  public async closeAll(): Promise<void> {
    const cleanupPromises: Promise<void>[] = [];
    for (const [ws, session] of this.sessions) {
      cleanupPromises.push(session.cleanup());
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
    await Promise.all(cleanupPromises);
    this.sessions.clear();
  }

  private readonly ACTIVITY_THRESHOLD_MS = 120_000;

  private getClientActivityState(session: Session): {
    deviceType: "web" | "mobile" | null;
    focusedAgentId: string | null;
    isStale: boolean;
    appVisible: boolean;
  } {
    const activity = session.getClientActivity();
    if (!activity) {
      this.logger.debug("getClientActivityState: no activity for session");
      return { deviceType: null, focusedAgentId: null, isStale: true, appVisible: false };
    }
    const now = Date.now();
    const ageMs = now - activity.lastActivityAt.getTime();
    const isStale = ageMs >= this.ACTIVITY_THRESHOLD_MS;
    this.logger.debug(
      {
        deviceType: activity.deviceType,
        focusedAgentId: activity.focusedAgentId,
        lastActivityAt: activity.lastActivityAt.toISOString(),
        ageMs,
        isStale,
        appVisible: activity.appVisible,
      },
      "getClientActivityState"
    );
    return {
      deviceType: activity.deviceType,
      focusedAgentId: activity.focusedAgentId,
      isStale,
      appVisible: activity.appVisible,
    };
  }

  private computeShouldNotifyForClient(
    clientState: {
      deviceType: "web" | "mobile" | null;
      focusedAgentId: string | null;
      isStale: boolean;
      appVisible: boolean;
    },
    allClientStates: Array<{
      deviceType: "web" | "mobile" | null;
      focusedAgentId: string | null;
      isStale: boolean;
      appVisible: boolean;
    }>,
    agentId: string
  ): boolean {
    const isAnyoneActiveOnAgent = allClientStates.some(
      (state) => state.focusedAgentId === agentId && state.appVisible && !state.isStale
    );
    if (isAnyoneActiveOnAgent) {
      return false;
    }

    if (clientState.deviceType === null) {
      return true;
    }

    if (!clientState.isStale && clientState.appVisible && clientState.focusedAgentId !== null) {
      return true;
    }

    if (!clientState.isStale) {
      return false;
    }

    const hasActiveWebClient = allClientStates.some(
      (state) => state.deviceType === "web" && !state.isStale
    );

    if (clientState.deviceType === "mobile") {
      return !hasActiveWebClient;
    }

    if (clientState.deviceType === "web") {
      const hasOtherClient = allClientStates.some(
        (state) => state !== clientState && (state.deviceType === "mobile" || state.deviceType === null)
      );
      return !hasOtherClient;
    }

    return true;
  }

  private broadcastAgentAttention(params: {
    agentId: string;
    provider: AgentProvider;
    reason: "finished" | "error" | "permission";
  }): void {
    const clientEntries: Array<{
      ws: WebSocket;
      state: {
        deviceType: "web" | "mobile" | null;
        focusedAgentId: string | null;
        isStale: boolean;
        appVisible: boolean;
      };
    }> = [];

    for (const [ws, session] of this.sessions) {
      clientEntries.push({
        ws,
        state: this.getClientActivityState(session),
      });
    }

    const allStates = clientEntries.map((e) => e.state);

    this.logger.debug(
      {
        agentId: params.agentId,
        reason: params.reason,
        clientCount: clientEntries.length,
        allStates,
      },
      "broadcastAgentAttention"
    );

    const hasActiveWebClient = allStates.some(
      (state) => state.deviceType === "web" && !state.isStale
    );
    const hasActiveMobileForegroundClient = allStates.some(
      (state) => state.deviceType === "mobile" && state.appVisible && !state.isStale
    );

    // Push is only a fallback when the user is away from their desktop/web.
    // Also suppress push if they're actively using the mobile app.
    const shouldSendPush =
      params.reason !== "error" &&
      !hasActiveWebClient &&
      !hasActiveMobileForegroundClient;

    this.logger.debug(
      { hasActiveWebClient, hasActiveMobileForegroundClient, shouldSendPush },
      "Push gating check"
    );

    if (shouldSendPush) {
      const tokens = this.pushTokenStore.getAllTokens();
      this.logger.info({ tokenCount: tokens.length }, "Sending push notification");
      if (tokens.length > 0) {
        const agent = this.agentManager.getAgent(params.agentId);
        const agentTitle = agent?.config?.title ?? agent?.cwd ?? params.agentId;
        const title =
          params.reason === "permission" ? "Agent needs permission" : "Agent finished";
        const body =
          params.reason === "permission"
            ? `Permission requested: ${agentTitle}`
            : `Finished: ${agentTitle}`;

        void this.pushService.sendPush(tokens, {
          title,
          body,
          data: { agentId: params.agentId, reason: params.reason },
        });
      }
    }

    for (const { ws, state } of clientEntries) {
      const shouldNotify = this.computeShouldNotifyForClient(state, allStates, params.agentId);

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
          },
          timestamp: new Date().toISOString(),
        },
      });

      this.sendToClient(ws, message);
    }
  }
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
