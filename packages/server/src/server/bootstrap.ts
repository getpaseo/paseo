import express, { type Express } from "express";
import basicAuth from "express-basic-auth";
import { createServer as createHTTPServer, type Server as HTTPServer } from "http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { VoiceAssistantWebSocketServer } from "./websocket-server.js";
import { initializeSTT, type STTConfig } from "./agent/stt-openai.js";
import { initializeTTS, type TTSConfig } from "./agent/tts-openai.js";
import { listConversations, deleteConversation } from "./persistence.js";
import { AgentManager } from "./agent/agent-manager.js";
import { AgentRegistry } from "./agent/agent-registry.js";
import { ClaudeAgentClient } from "./agent/providers/claude-agent.js";
import { CodexMcpAgentClient } from "./agent/providers/codex-mcp-agent.js";
import { initializeTitleGenerator } from "../services/agent-title-generator.js";
import { attachAgentRegistryPersistence } from "./persistence-hooks.js";
import { createAgentMcpServer } from "./agent/mcp-server.js";
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
  port: number;
  paseoHome: string;
  agentMcpRoute: string;
  agentMcpAllowedHosts: string[];
  auth: PaseoAuthConfig;
  staticDir: string;
  mcpDebug: boolean;
  agentClients: Partial<Record<AgentProvider, AgentClient>>;
  agentRegistryPath: string;
  agentControlMcp: AgentControlMcpConfig;
  openai?: PaseoOpenAIConfig;
};

export type PaseoDaemonHandles = {
  httpServer: HTTPServer;
  app: Express;
  wsServer: VoiceAssistantWebSocketServer;
  agentManager: AgentManager;
  agentRegistry: AgentRegistry;
  close: () => Promise<void>;
};

export async function createPaseoDaemon(
  config: PaseoDaemonConfig
): Promise<PaseoDaemonHandles> {
  const agentMcpRoute = config.agentMcpRoute;
  const basicAuthUsers = config.auth.basicUsers;
  const staticDir = config.staticDir;
  const authRealm = config.auth.realm ?? "Voice Assistant";

  const agentMcpBearerToken = config.auth.agentMcpBearerToken;

  const app = express();

  // Serve static files from public directory (no auth required for APK downloads)
  app.use("/public", express.static(staticDir));

  // Basic authentication (skip for /public routes)
  const basicAuthMiddleware = basicAuth({
    users: basicAuthUsers,
    challenge: true,
    realm: authRealm,
  });
  app.use((req, res, next) => {
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

  const httpServer = createHTTPServer(app);

  const agentRegistry = new AgentRegistry(config.agentRegistryPath);
  const agentManager = new AgentManager({
    clients: {
      claude: new ClaudeAgentClient(),
      codex: new CodexMcpAgentClient(),
      "codex-mcp": new CodexMcpAgentClient(),
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
    {
      agentMcpUrl: config.agentControlMcp.url,
      agentMcpHeaders: config.agentControlMcp.headers,
    }
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

  const close = async () => {
    await closeAllAgents(agentManager);
    await wsServer.close();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  };

  return {
    httpServer,
    app,
    wsServer,
    agentManager,
    agentRegistry,
    close,
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
