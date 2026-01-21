import { WebSocketServer } from "ws";
import type { Server as HTTPServer } from "http";
import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentRegistry } from "./agent/agent-registry.js";
import type { DownloadTokenStore } from "./file-download/token-store.js";
import type { OpenAISTT } from "./agent/stt-openai.js";
import type { OpenAITTS } from "./agent/tts-openai.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import type pino from "pino";
import type { WSOutboundMessage } from "./messages.js";
import { WebSocketSessionBridge } from "./websocket-session-bridge.js";

type AgentMcpClientConfig = {
  agentMcpUrl: string;
  agentMcpHeaders?: Record<string, string>;
};

type WebSocketServerConfig = {
  allowedOrigins: Set<string>;
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
    agentRegistry: AgentRegistry,
    downloadTokenStore: DownloadTokenStore,
    agentMcpConfig: AgentMcpClientConfig,
    wsConfig: WebSocketServerConfig,
    speech?: { stt: OpenAISTT | null; tts: OpenAITTS | null },
    terminalManager?: TerminalManager | null
  ) {
    this.logger = logger.child({ module: "websocket-server" });
    this.bridge = new WebSocketSessionBridge(
      this.logger,
      agentManager,
      agentRegistry,
      downloadTokenStore,
      agentMcpConfig,
      speech,
      terminalManager
    );

    const { allowedOrigins } = wsConfig;
    this.wss = new WebSocketServer({
      server,
      path: "/ws",
      verifyClient: ({ req }, callback) => {
        const origin = req.headers.origin;
        if (!origin || allowedOrigins.has(origin)) {
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

  public async close(): Promise<void> {
    await this.bridge.closeAll();
    this.wss.close();
  }
}

