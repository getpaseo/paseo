import "dotenv/config";
import express from "express";
import basicAuth from "express-basic-auth";
import { createServer as createHTTPServer } from "http";
import { VoiceAssistantWebSocketServer } from "./websocket-server.js";
import { initializeSTT, type STTConfig } from "./agent/stt-openai.js";
import { initializeTTS } from "./agent/tts-openai.js";
import { listConversations, deleteConversation } from "./persistence.js";
import { AgentManager } from "./agent/agent-manager.js";
import { AgentRegistry } from "./agent/agent-registry.js";
import { ClaudeAgentClient } from "./agent/providers/claude-agent.js";
import { CodexAgentClient } from "./agent/providers/codex-agent.js";
import { initializeTitleGenerator } from "../services/agent-title-generator.js";
import {
  attachAgentRegistryPersistence,
  restorePersistedAgents,
} from "./persistence-hooks.js";

function createServer() {
  const app = express();

  // Serve static files from public directory (no auth required for APK downloads)
  app.use("/public", express.static("public"));

  // Basic authentication (skip for /public routes)
  app.use(
    basicAuth({
      users: { mo: "bo" },
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
  const port = parseInt(process.env.PORT || "6767", 10);

  const app = createServer();
  const httpServer = createHTTPServer(app);

  // Initialize global agent manager + registry
  const agentRegistry = new AgentRegistry();
  const agentManager = new AgentManager({
    clients: {
      claude: new ClaudeAgentClient(),
      codex: new CodexAgentClient(),
    },
  });

  attachAgentRegistryPersistence(agentManager, agentRegistry);

  await restorePersistedAgents(agentManager, agentRegistry);
  console.log("✓ Global agent manager initialized with persisted agents");

  // Initialize WebSocket server
  const wsServer = new VoiceAssistantWebSocketServer(
    httpServer,
    agentManager,
    agentRegistry
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
