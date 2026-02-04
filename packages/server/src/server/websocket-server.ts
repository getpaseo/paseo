import { WebSocketServer } from "ws";
import type { Server as HTTPServer } from "http";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import type { DownloadTokenStore } from "./file-download/token-store.js";
import type { OpenAISTT } from "./agent/stt-openai.js";
import type { OpenAITTS } from "./agent/tts-openai.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import type pino from "pino";
import type { WSOutboundMessage } from "./messages.js";
import { WebSocketSessionBridge } from "./websocket-session-bridge.js";
import type { AllowedHostsConfig } from "./allowed-hosts.js";
import { isHostAllowed } from "./allowed-hosts.js";

export type AgentMcpTransportFactory = () => Promise<Transport>;

type WebSocketServerConfig = {
  allowedOrigins: Set<string>;
  allowedHosts?: AllowedHostsConfig;
};

/**
 * WebSocket server that only accepts sockets + parses/forwards messages to the session layer.
 */
export class VoiceAssistantWebSocketServer {
  private readonly logger: pino.Logger;
  private readonly wss: WebSocketServer;
  private readonly bridge: WebSocketSessionBridge;

  constructor(
    server: HTTPServer,
    logger: pino.Logger,
    agentManager: AgentManager,
    agentStorage: AgentStorage,
    downloadTokenStore: DownloadTokenStore,
    paseoHome: string,
    createAgentMcpTransport: AgentMcpTransportFactory,
    wsConfig: WebSocketServerConfig,
    speech?: { stt: OpenAISTT | null; tts: OpenAITTS | null },
    terminalManager?: TerminalManager | null,
    voice?: {
      openrouterApiKey?: string | null;
      voiceLlmModel?: string | null;
    },
    dictation?: {
      openaiApiKey?: string | null;
      finalTimeoutMs?: number;
    }
  ) {
    this.logger = logger.child({ module: "websocket-server" });
    this.bridge = new WebSocketSessionBridge(
      this.logger,
      agentManager,
      agentStorage,
      downloadTokenStore,
      paseoHome,
      createAgentMcpTransport,
      speech,
      terminalManager,
      voice,
      dictation
    );

    const { allowedOrigins, allowedHosts } = wsConfig;
    this.wss = new WebSocketServer({
      server,
      path: "/ws",
      verifyClient: ({ req }, callback) => {
        const origin = req.headers.origin;
        const requestHost = typeof req.headers.host === "string" ? req.headers.host : null;
        if (requestHost && !isHostAllowed(requestHost, allowedHosts)) {
          this.logger.warn({ host: requestHost }, "Rejected connection from disallowed host");
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
          this.logger.warn({ origin }, "Rejected connection from origin");
          callback(false, 403, "Origin not allowed");
        }
      },
    });

    this.wss.on("connection", (ws, request) => {
      void this.bridge.attach(ws, request);
    });

    this.logger.info("WebSocket server initialized on /ws");
  }

  public broadcast(message: WSOutboundMessage): void {
    this.bridge.broadcast(message);
  }

  public async attachExternalSocket(ws: Parameters<WebSocketSessionBridge["attach"]>[0]): Promise<void> {
    const fakeRequest = {
      url: "/ws",
      headers: {},
      method: "GET",
    } as unknown as Parameters<WebSocketSessionBridge["attach"]>[1];
    await this.bridge.attach(ws, fakeRequest);
  }

  public async close(): Promise<void> {
    await this.bridge.closeAll();
    this.wss.close();
  }
}
