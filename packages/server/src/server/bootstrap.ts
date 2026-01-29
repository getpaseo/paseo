import express from "express";
import { createServer as createHTTPServer } from "http";
import { createReadStream, unlinkSync, existsSync } from "fs";
import { stat } from "fs/promises";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "pino";

type ListenTarget =
  | { type: "tcp"; host: string; port: number }
  | { type: "socket"; path: string };

function parseListenString(listen: string): ListenTarget {
  // Unix socket: starts with / or ~ or contains .sock
  if (listen.startsWith("/") || listen.startsWith("~") || listen.includes(".sock")) {
    return { type: "socket", path: listen };
  }
  // Explicit unix:// prefix
  if (listen.startsWith("unix://")) {
    return { type: "socket", path: listen.slice(7) };
  }
  // TCP: host:port or just port
  if (listen.includes(":")) {
    const [host, portStr] = listen.split(":");
    const port = parseInt(portStr, 10);
    if (!Number.isFinite(port)) {
      throw new Error(`Invalid port in listen string: ${listen}`);
    }
    return { type: "tcp", host: host || "127.0.0.1", port };
  }
  // Just a port number
  const port = parseInt(listen, 10);
  if (Number.isFinite(port)) {
    return { type: "tcp", host: "127.0.0.1", port };
  }
  throw new Error(`Invalid listen string: ${listen}`);
}

import { VoiceAssistantWebSocketServer } from "./websocket-server.js";
import { DownloadTokenStore } from "./file-download/token-store.js";
import { OpenAISTT, type STTConfig } from "./agent/stt-openai.js";
import { OpenAITTS, type TTSConfig } from "./agent/tts-openai.js";
import { AgentManager } from "./agent/agent-manager.js";
import { AgentStorage } from "./agent/agent-storage.js";
import { attachAgentStoragePersistence } from "./persistence-hooks.js";
import { createAgentMcpServer } from "./agent/mcp-server.js";
import { createAllClients, shutdownProviders } from "./agent/provider-registry.js";
import { createTerminalManager, type TerminalManager } from "../terminal/terminal-manager.js";
import {
  buildOfferEndpoints,
  createConnectionOfferV1,
  encodeOfferToFragmentUrl,
} from "./connection-offer.js";
import { printPairingQrIfEnabled } from "./pairing-qr.js";
import { startRelayTransport, type RelayTransportController } from "./relay-transport.js";
import type {
  AgentClient,
  AgentProvider,
} from "./agent/agent-sdk-types.js";

type AgentMcpTransportMap = Map<string, StreamableHTTPServerTransport>;

export type PaseoOpenAIConfig = {
  apiKey?: string;
  stt?: Partial<STTConfig> & { apiKey?: string };
  tts?: Partial<TTSConfig> & { apiKey?: string };
};

export type PaseoDaemonConfig = {
  listen: string;
  paseoHome: string;
  corsAllowedOrigins: string[];
  agentMcpRoute: string;
  agentMcpAllowedHosts: string[];
  staticDir: string;
  mcpDebug: boolean;
  agentClients: Partial<Record<AgentProvider, AgentClient>>;
  agentStoragePath: string;
  relayEnabled?: boolean;
  relayEndpoint?: string;
  appBaseUrl?: string;
  openai?: PaseoOpenAIConfig;
  downloadTokenTtlMs?: number;
};

export interface PaseoDaemon {
  config: PaseoDaemonConfig;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  terminalManager: TerminalManager;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function createPaseoDaemon(
  config: PaseoDaemonConfig,
  rootLogger: Logger
  ): Promise<PaseoDaemon> {
  const logger = rootLogger.child({ module: "bootstrap" });
  const connectionSessionId = randomUUID();
  let relayTransport: RelayTransportController | null = null;

  const agentMcpRoute = config.agentMcpRoute;
  const staticDir = config.staticDir;
  const downloadTokenTtlMs = config.downloadTokenTtlMs ?? 60000;

  const downloadTokenStore = new DownloadTokenStore({ ttlMs: downloadTokenTtlMs });

  const listenTarget = parseListenString(config.listen);

  const app = express();

  // CORS - allow same-origin + configured origins
  const allowedOrigins = new Set([
    ...config.corsAllowedOrigins,
    // For TCP, add localhost variants
    ...(listenTarget.type === "tcp"
      ? [
          `http://${listenTarget.host}:${listenTarget.port}`,
          `http://localhost:${listenTarget.port}`,
          `http://127.0.0.1:${listenTarget.port}`,
        ]
      : []),
  ]);

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  // Serve static files from public directory
  app.use("/public", express.static(staticDir));

  // Middleware
  app.use(express.json());

  // Health check endpoint
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.get("/api/files/download", async (req, res) => {
    const token =
      typeof req.query.token === "string" && req.query.token.trim().length > 0
        ? req.query.token.trim()
        : null;

    if (!token) {
      res.status(400).json({ error: "Missing download token" });
      return;
    }

    const entry = downloadTokenStore.consumeToken(token);
    if (!entry) {
      res.status(403).json({ error: "Invalid or expired token" });
      return;
    }

    try {
      const fileStats = await stat(entry.absolutePath);
      if (!fileStats.isFile()) {
        res.status(404).json({ error: "File not found" });
        return;
      }

      const safeFileName = entry.fileName.replace(/["\r\n]/g, "_");
      res.setHeader("Content-Type", entry.mimeType);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${safeFileName}"`
      );
      res.setHeader("Content-Length", entry.size.toString());

      const stream = createReadStream(entry.absolutePath);
      stream.on("error", (err) => {
        logger.error({ err }, "Failed to stream download");
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to read file" });
        } else {
          res.end();
        }
      });
      stream.pipe(res);
    } catch (err) {
      logger.error({ err }, "Failed to download file");
      if (!res.headersSent) {
        res.status(404).json({ error: "File not found" });
      }
    }
  });

  const httpServer = createHTTPServer(app);

  const agentStorage = new AgentStorage(config.agentStoragePath, logger);
  const agentManager = new AgentManager({
    clients: {
      ...createAllClients(logger),
      ...config.agentClients,
    },
    registry: agentStorage,
    logger,
  });

  const terminalManager = createTerminalManager();

  attachAgentStoragePersistence(logger, agentManager, agentStorage);
  const persistedRecords = await agentStorage.list();
  logger.info(
    `Agent registry loaded (${persistedRecords.length} record${persistedRecords.length === 1 ? "" : "s"}); agents will initialize on demand`
  );

  const agentMcpTransports: AgentMcpTransportMap = new Map();
  const allowedHosts = config.agentMcpAllowedHosts;

  const createAgentMcpTransport = async (callerAgentId?: string) => {
    const agentMcpServer = await createAgentMcpServer({
      agentManager,
      agentStorage,
      paseoHome: config.paseoHome,
      callerAgentId,
      logger,
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        agentMcpTransports.set(sessionId, transport);
        logger.debug({ sessionId }, "Agent MCP session initialized");
      },
      onsessionclosed: (sessionId) => {
        agentMcpTransports.delete(sessionId);
        logger.debug({ sessionId }, "Agent MCP session closed");
      },
      enableDnsRebindingProtection: true,
      allowedHosts,
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        agentMcpTransports.delete(transport.sessionId);
      }
    };
    transport.onerror = (err) => {
      logger.error({ err }, "Agent MCP transport error");
    };

    await agentMcpServer.connect(transport);

    return transport;
  };

  const handleAgentMcpRequest: express.RequestHandler = async (req, res) => {
    if (config.mcpDebug) {
      logger.debug(
        {
          method: req.method,
          url: req.originalUrl,
          sessionId: req.header("mcp-session-id"),
          authorization: req.header("authorization"),
          body: req.body,
        },
        "Agent MCP request"
      );
    }
    try {
      const sessionId = req.header("mcp-session-id");
      let transport = sessionId ? agentMcpTransports.get(sessionId) : undefined;

      if (!transport) {
        if (req.method !== "POST") {
          res.status(400).json({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Missing or invalid MCP session",
            },
            id: null,
          });
          return;
        }
        if (!isInitializeRequest(req.body)) {
          res.status(400).json({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Initialization request expected",
            },
            id: null,
          });
          return;
        }
        const callerAgentIdRaw = req.query.callerAgentId;
        const callerAgentId =
          typeof callerAgentIdRaw === "string"
            ? callerAgentIdRaw
            : Array.isArray(callerAgentIdRaw) && typeof callerAgentIdRaw[0] === "string"
              ? callerAgentIdRaw[0]
              : undefined;
        transport = await createAgentMcpTransport(callerAgentId);
      }

      await transport.handleRequest(req as any, res as any, req.body);
    } catch (err) {
      logger.error({ err }, "Failed to handle Agent MCP request");
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal MCP server error",
          },
          id: null,
        });
      }
    }
  };

  app.post(agentMcpRoute, handleAgentMcpRequest);
  app.get(agentMcpRoute, handleAgentMcpRequest);
  app.delete(agentMcpRoute, handleAgentMcpRequest);
  logger.info({ route: agentMcpRoute }, "Agent MCP server mounted");

  let sttService: OpenAISTT | null = null;
  let ttsService: OpenAITTS | null = null;

  const openaiApiKey = config.openai?.apiKey;
  if (openaiApiKey) {
    logger.info("OpenAI client initialized");

    const sttApiKey = config.openai?.stt?.apiKey ?? openaiApiKey;
    if (sttApiKey) {
      const { apiKey: _sttApiKey, ...sttConfig } = config.openai?.stt ?? {};
      sttService = new OpenAISTT(
        {
          apiKey: sttApiKey,
          ...sttConfig,
        },
        logger
      );
    }

    const ttsApiKey = config.openai?.tts?.apiKey ?? openaiApiKey;
    if (ttsApiKey) {
      const { apiKey: _ttsApiKey, ...ttsConfig } = config.openai?.tts ?? {};
      ttsService = new OpenAITTS(
        {
          apiKey: ttsApiKey,
          voice: "alloy",
          model: "tts-1",
          responseFormat: "pcm",
          ...ttsConfig,
        },
        logger
      );
    }

  } else {
    logger.warn("OPENAI_API_KEY not set - LLM, STT, and TTS features will not work");
  }

  const wsServer = new VoiceAssistantWebSocketServer(
    httpServer,
    logger,
    agentManager,
    agentStorage,
    downloadTokenStore,
    config.paseoHome,
    agentMcpRoute,
    { allowedOrigins },
    { stt: sttService, tts: ttsService },
    terminalManager
  );

  const start = async () => {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        httpServer.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        httpServer.off("error", onError);
        const logAndResolve = async () => {
          if (listenTarget.type === "tcp") {
            logger.info(
              { host: listenTarget.host, port: listenTarget.port },
              `Server listening on http://${listenTarget.host}:${listenTarget.port}`
            );

            const relayEnabled = config.relayEnabled ?? true;
            const relayEndpoint = config.relayEndpoint ?? "relay.paseo.sh:443";
            const appBaseUrl = config.appBaseUrl ?? "https://app.paseo.sh";

            const endpoints = buildOfferEndpoints({
              listenHost: listenTarget.host,
              port: listenTarget.port,
              relayEnabled,
              relayEndpoint,
            });

            const offer = await createConnectionOfferV1({
              sessionId: connectionSessionId,
              endpoints,
            });

            const url = encodeOfferToFragmentUrl({ offer, appBaseUrl });
            logger.info({ url }, "pairing_offer");
            void printPairingQrIfEnabled({ url, logger }).catch(() => undefined);

            if (relayEnabled) {
              relayTransport?.stop().catch(() => undefined);
              relayTransport = startRelayTransport({
                logger,
                attachSocket: (ws) => wsServer.attachExternalSocket(ws),
                relayEndpoint,
                sessionId: connectionSessionId,
              });
            }
          } else {
            logger.info({ path: listenTarget.path }, `Server listening on ${listenTarget.path}`);
          }
        };

        logAndResolve().then(resolve, reject);
      };
      httpServer.once("error", onError);
      httpServer.once("listening", onListening);

      if (listenTarget.type === "tcp") {
        httpServer.listen(listenTarget.port, listenTarget.host);
      } else {
        // Remove stale socket file if it exists
        if (existsSync(listenTarget.path)) {
          unlinkSync(listenTarget.path);
        }
        httpServer.listen(listenTarget.path);
      }
    });
  };

  const stop = async () => {
    await closeAllAgents(logger, agentManager);
    await shutdownProviders(logger);
    terminalManager.killAll();
    await relayTransport?.stop().catch(() => undefined);
    await wsServer.close();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    // Clean up socket file
    if (listenTarget.type === "socket" && existsSync(listenTarget.path)) {
      unlinkSync(listenTarget.path);
    }
  };

  return {
    config,
    agentManager,
    agentStorage,
    terminalManager,
    start,
    stop,
  };
}

async function closeAllAgents(
  logger: Logger,
  agentManager: AgentManager
): Promise<void> {
  const agents = agentManager.listAgents();
  for (const agent of agents) {
    try {
      await agentManager.closeAgent(agent.id);
    } catch (err) {
      logger.error({ err, agentId: agent.id }, "Failed to close agent");
    }
  }
}
