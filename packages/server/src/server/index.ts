import "dotenv/config";
import express from "express";
import basicAuth from "express-basic-auth";
import { createServer as createHTTPServer } from "http";
import { randomUUID } from "node:crypto";
import { VoiceAssistantWebSocketServer } from "./websocket-server.js";
import { initializeSTT, type STTConfig } from "./agent/stt-openai.js";
import { initializeTTS } from "./agent/tts-openai.js";
import { listConversations, deleteConversation } from "./persistence.js";
import { AgentManager } from "./agent/agent-manager.js";
import { AgentRegistry } from "./agent/agent-registry.js";
import { ClaudeAgentClient } from "./agent/providers/claude-agent.js";
import { CodexAgentClient } from "./agent/providers/codex-agent.js";
import { resolvePaseoPort } from "./config.js";
import { initializeTitleGenerator } from "../services/agent-title-generator.js";
import { attachAgentRegistryPersistence } from "./persistence-hooks.js";
import { createAgentMcpServer } from "./agent/mcp-server.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

type AgentMcpTransportMap = Map<
  string,
  StreamableHTTPServerTransport
>;

const BASIC_AUTH_USERS = { mo: "bo" } as const;

function createServer() {
  const app = express();

  // Serve static files from public directory (no auth required for APK downloads)
  app.use("/public", express.static("public"));

  // Basic authentication (skip for /public routes)
  app.use(
    basicAuth({
      users: BASIC_AUTH_USERS,
      challenge: true,
      realm: "Voice Assistant",
    })
  );

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

  return app;
}

async function main() {
  const port = resolvePaseoPort();
  const agentMcpRoute = "/mcp/agents";
  const agentMcpUrl = `http://127.0.0.1:${port}${agentMcpRoute}`;
  const [agentMcpUser, agentMcpPassword] =
    Object.entries(BASIC_AUTH_USERS)[0] ?? [];
  const agentMcpAuthHeader =
    agentMcpUser && agentMcpPassword
      ? `Basic ${Buffer.from(
          `${agentMcpUser}:${agentMcpPassword}`
        ).toString("base64")}`
      : undefined;

  const app = createServer();
  const httpServer = createHTTPServer(app);

  // Initialize global agent manager + registry
  const agentRegistry = new AgentRegistry();
  const agentManager = new AgentManager({
    clients: {
      claude: new ClaudeAgentClient({
        agentControlMcp: {
          url: agentMcpUrl,
          ...(agentMcpAuthHeader
            ? { headers: { Authorization: agentMcpAuthHeader } }
            : {}),
        },
      }),
      codex: new CodexAgentClient(),
    },
    registry: agentRegistry,
  });

  attachAgentRegistryPersistence(agentManager, agentRegistry);
  const persistedRecords = await agentRegistry.list();
  console.log(
    `✓ Agent registry loaded (${persistedRecords.length} record${
      persistedRecords.length === 1 ? "" : "s"
    }); agents will initialize on demand`
  );

  const agentMcpTransports: AgentMcpTransportMap = new Map();

  const createAgentMcpTransport = async (callerAgentId?: string) => {
    // Create a NEW McpServer instance per session (not shared across sessions)
    // Pass the caller agent ID so create_agent can auto-set parentAgentId
    const agentMcpServer = await createAgentMcpServer({
      agentManager,
      agentRegistry,
      callerAgentId,
      agentControlMcpUrl: agentMcpUrl,
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
      allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
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

  const handleAgentMcpRequest: express.RequestHandler = async (
    req,
    res
  ) => {
    try {
      const sessionId = req.header("mcp-session-id");
      let transport = sessionId
        ? agentMcpTransports.get(sessionId)
        : undefined;

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
        // Extract optional caller agent ID from query string (sent by agents when connecting)
        const callerAgentIdRaw = req.query.callerAgentId;
        const callerAgentId =
          typeof callerAgentIdRaw === "string"
            ? callerAgentIdRaw
            : Array.isArray(callerAgentIdRaw)
              ? callerAgentIdRaw[0]
              : undefined;
        transport = await createAgentMcpTransport(callerAgentId);
      }

      await transport.handleRequest(
        req as any,
        res as any,
        req.body
      );
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

  // Initialize WebSocket server
  const wsServer = new VoiceAssistantWebSocketServer(
    httpServer,
    agentManager,
    agentRegistry,
    {
      agentMcpUrl,
      agentMcpHeaders: agentMcpAuthHeader
        ? {
            Authorization: agentMcpAuthHeader,
          }
        : undefined,
    }
  );

  // Initialize OpenAI client
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) {
    console.log("✓ OpenAI client initialized");

    // Initialize STT (Whisper)
    const sttConfidenceThreshold = process.env.STT_CONFIDENCE_THRESHOLD
      ? parseFloat(process.env.STT_CONFIDENCE_THRESHOLD)
      : undefined; // Will default to -3.0 in stt-openai.ts

    const sttModel = process.env.STT_MODEL as STTConfig["model"];

    initializeSTT({
      apiKey,
      confidenceThreshold: sttConfidenceThreshold,
      ...(sttModel ? { model: sttModel } : {}),
    });

    // Initialize TTS
    const ttsVoice = (process.env.TTS_VOICE || "alloy") as
      | "alloy"
      | "echo"
      | "fable"
      | "onyx"
      | "nova"
      | "shimmer";
    const ttsModel = (process.env.TTS_MODEL || "tts-1") as "tts-1" | "tts-1-hd";
    initializeTTS({
      apiKey,
      voice: ttsVoice,
      model: ttsModel,
      responseFormat: "pcm",
    });

    // Initialize agent title generator
    initializeTitleGenerator(apiKey);
  } else {
    console.warn(
      "⚠ OPENAI_API_KEY not set - LLM, STT, and TTS features will not work"
    );
  }

  httpServer.listen(port, () => {
    console.log(
      `\n✓ Voice Assistant server running on http://localhost:${port}`
    );
  });

  // Graceful shutdown
  const handleShutdown = async (signal: string) => {
    console.log(`\n${signal} received, shutting down gracefully...`);

    // Wait for agents to finish work
    await closeAllAgents(agentManager);

    // Close WebSocket and HTTP servers
    wsServer.close();
    httpServer.close(() => {
      console.log("Server closed");
      process.exit(0);
    });

    // Force exit after 10 seconds if HTTP server doesn't close
    // This runs AFTER agent shutdown completes
    setTimeout(() => {
      console.log("Forcing shutdown - HTTP server didn't close in time");
      process.exit(1);
    }, 10000);
  };

  process.on("SIGTERM", () => handleShutdown("SIGTERM"));
  process.on("SIGINT", () => handleShutdown("SIGINT"));
}

main();

async function closeAllAgents(agentManager: AgentManager): Promise<void> {
  const agents = agentManager.listAgents();
  for (const agent of agents) {
    try {
      await agentManager.closeAgent(agent.id);
    } catch (error) {
      console.error(
        `[Agents] Failed to close agent ${agent.id}:`,
        error
      );
    }
  }

  // All agents have been asked to stop; let the caller finish shutdown
}
