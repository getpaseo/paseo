import express from "express";
import basicAuth from "express-basic-auth";
import { createServer as createHTTPServer } from "http";
import { createReadStream, unlinkSync, existsSync } from "fs";
import { stat } from "fs/promises";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

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
import { initializeSTT, type STTConfig } from "./agent/stt-openai.js";
import { initializeTTS, type TTSConfig } from "./agent/tts-openai.js";
import { listConversations, deleteConversation } from "./persistence.js";
import { AgentManager } from "./agent/agent-manager.js";
import { AgentRegistry } from "./agent/agent-registry.js";
import { initializeTitleGenerator } from "../services/agent-title-generator.js";
import { attachAgentRegistryPersistence } from "./persistence-hooks.js";
import { createAgentMcpServer } from "./agent/mcp-server.js";
import { createAllClients, shutdownProviders } from "./agent/provider-registry.js";
import type {
  AgentClient,
  AgentControlMcpConfig,
  AgentProvider,
} from "./agent/agent-sdk-types.js";

type AgentMcpTransportMap = Map<string, StreamableHTTPServerTransport>;

export type PaseoAuthConfig = {
  basicUsers: Record<string, string>;
  realm?: string;
  agentMcpBearerToken?: string;
  agentMcpAuthHeader?: string;
};

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
  auth: PaseoAuthConfig;
  staticDir: string;
  mcpDebug: boolean;
  agentClients: Partial<Record<AgentProvider, AgentClient>>;
  agentRegistryPath: string;
  agentControlMcp: AgentControlMcpConfig;
  openai?: PaseoOpenAIConfig;
  downloadTokenTtlMs?: number;
};

export interface PaseoDaemon {
  config: PaseoDaemonConfig;
  agentManager: AgentManager;
  agentRegistry: AgentRegistry;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function createPaseoDaemon(
  config: PaseoDaemonConfig
): Promise<PaseoDaemon> {
  const agentMcpRoute = config.agentMcpRoute;
  const basicAuthUsers = config.auth.basicUsers;
  const staticDir = config.staticDir;
  const authRealm = config.auth.realm ?? "Voice Assistant";
  const downloadTokenTtlMs = config.downloadTokenTtlMs ?? 60000;

  const agentMcpBearerToken = config.auth.agentMcpBearerToken;

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

  // Serve static files from public directory (no auth required for APK downloads)
  app.use("/public", express.static(staticDir));

  // Basic authentication (skip for /public routes)
  const basicAuthMiddleware = basicAuth({
    users: basicAuthUsers,
    challenge: true,
    realm: authRealm,
  });
  app.use((req, res, next) => {
    if (req.path === "/api/files/download") {
      return next();
    }
    if (agentMcpBearerToken && req.path.startsWith(agentMcpRoute)) {
      const authHeader = req.header("authorization") ?? "";
      if (authHeader.startsWith("Bearer ")) {
        const token = authHeader.slice("Bearer ".length).trim();
        if (token === agentMcpBearerToken) {
          return next();
        }
      }
    }
    return basicAuthMiddleware(req, res, next);
  });

  // Middleware
  app.use(express.json());

  // Health check endpoint
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Conversation management endpoints
  app.get("/api/conversations", async (_req, res) => {
    try {
      const conversations = await listConversations();
      res.json(conversations);
    } catch (error) {
      console.error("[API] Failed to list conversations:", error);
      res.status(500).json({ error: "Failed to list conversations" });
    }
  });

  app.delete("/api/conversations/:id", async (req, res) => {
    try {
      const { id } = req.params;
      await deleteConversation(id);
      res.json({ success: true });
    } catch (error) {
      console.error("[API] Failed to delete conversation:", error);
      res.status(500).json({ error: "Failed to delete conversation" });
    }
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
      stream.on("error", (error) => {
        console.error("[API] Failed to stream download:", error);
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to read file" });
        } else {
          res.end();
        }
      });
      stream.pipe(res);
    } catch (error) {
      console.error("[API] Failed to download file:", error);
      if (!res.headersSent) {
        res.status(404).json({ error: "File not found" });
      }
    }
  });

  const httpServer = createHTTPServer(app);

  const agentRegistry = new AgentRegistry(config.agentRegistryPath);
  const agentManager = new AgentManager({
    clients: {
      ...createAllClients(),
      ...config.agentClients,
    },
    registry: agentRegistry,
    agentControlMcp: config.agentControlMcp,
  });

  attachAgentRegistryPersistence(agentManager, agentRegistry);
  const persistedRecords = await agentRegistry.list();
  console.log(
    `✓ Agent registry loaded (${persistedRecords.length} record${persistedRecords.length === 1 ? "" : "s"}); agents will initialize on demand`
  );

  const agentMcpTransports: AgentMcpTransportMap = new Map();
  const allowedHosts = config.agentMcpAllowedHosts;

  const createAgentMcpTransport = async (callerAgentId?: string) => {
    const agentMcpServer = await createAgentMcpServer({
      agentManager,
      agentRegistry,
      callerAgentId,
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        agentMcpTransports.set(sessionId, transport);
        console.log(`[Agent MCP] Session initialized: ${sessionId}`);
      },
      onsessionclosed: (sessionId) => {
        agentMcpTransports.delete(sessionId);
        console.log(`[Agent MCP] Session closed: ${sessionId}`);
      },
      enableDnsRebindingProtection: true,
      allowedHosts,
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        agentMcpTransports.delete(transport.sessionId);
      }
    };
    transport.onerror = (error) => {
      console.error("[Agent MCP] Transport error:", error);
    };

    await agentMcpServer.connect(transport);

    return transport;
  };

  const handleAgentMcpRequest: express.RequestHandler = async (req, res) => {
    if (config.mcpDebug) {
      console.log("[Agent MCP] request", {
        method: req.method,
        url: req.originalUrl,
        sessionId: req.header("mcp-session-id"),
        authorization: req.header("authorization"),
        body: req.body,
      });
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
    } catch (error) {
      console.error("[Agent MCP] Failed to handle request:", error);
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
  console.log(`✓ Agent MCP server mounted at ${agentMcpRoute}`);

  const wsServer = new VoiceAssistantWebSocketServer(
    httpServer,
    agentManager,
    agentRegistry,
    downloadTokenStore,
    {
      agentMcpUrl: config.agentControlMcp.url,
      agentMcpHeaders: config.agentControlMcp.headers,
    },
    { allowedOrigins }
  );

  const openaiApiKey = config.openai?.apiKey;
  if (openaiApiKey) {
    console.log("✓ OpenAI client initialized");

    const sttApiKey = config.openai?.stt?.apiKey ?? openaiApiKey;
    if (sttApiKey) {
      const { apiKey: _sttApiKey, ...sttConfig } = config.openai?.stt ?? {};
      initializeSTT({
        apiKey: sttApiKey,
        ...sttConfig,
      });
    }

    const ttsApiKey = config.openai?.tts?.apiKey ?? openaiApiKey;
    if (ttsApiKey) {
      const { apiKey: _ttsApiKey, ...ttsConfig } = config.openai?.tts ?? {};
      initializeTTS({
        apiKey: ttsApiKey,
        voice: "alloy",
        model: "tts-1",
        responseFormat: "pcm",
        ...ttsConfig,
      });
    }

    initializeTitleGenerator(openaiApiKey);
  } else {
    console.warn(
      "⚠ OPENAI_API_KEY not set - LLM, STT, and TTS features will not work"
    );
  }

  const start = async () => {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        httpServer.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        httpServer.off("error", onError);
        if (listenTarget.type === "tcp") {
          console.log(
            `✓ Server listening on http://${listenTarget.host}:${listenTarget.port}`
          );
        } else {
          console.log(`✓ Server listening on ${listenTarget.path}`);
        }
        resolve();
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
    await closeAllAgents(agentManager);
    await shutdownProviders();
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
    agentRegistry,
    start,
    stop,
  };
}

async function closeAllAgents(agentManager: AgentManager): Promise<void> {
  const agents = agentManager.listAgents();
  for (const agent of agents) {
    try {
      await agentManager.closeAgent(agent.id);
    } catch (error) {
      console.error(`[Agents] Failed to close agent ${agent.id}:`, error);
    }
  }
}
