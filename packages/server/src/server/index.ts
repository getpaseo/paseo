import "dotenv/config";
import express from "express";
import basicAuth from "express-basic-auth";
import { createServer as createHTTPServer } from "http";
import { VoiceAssistantWebSocketServer } from "./websocket-server.js";
import { initializeSTT } from "./agent/stt-openai.js";
import { initializeTTS } from "./agent/tts-openai.js";
import {
  listConversations,
  deleteConversation,
} from "./persistence.js";
import { AgentManager } from "./acp/agent-manager.js";
import { initializeTitleGenerator } from "../services/agent-title-generator.js";

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

function main() {
  const port = parseInt(process.env.PORT || "6767", 10);

  const app = createServer();
  const httpServer = createHTTPServer(app);

  // Initialize global agent manager
  const agentManager = new AgentManager();
  console.log("✓ Global agent manager initialized");

  // Initialize WebSocket server
  const wsServer = new VoiceAssistantWebSocketServer(httpServer, agentManager);

  // Initialize OpenAI client
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) {
    console.log("✓ OpenAI client initialized");

    // Initialize STT (Whisper)
    initializeSTT({ apiKey });

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
  process.on("SIGTERM", () => {
    console.log("\nSIGTERM received, shutting down gracefully...");
    wsServer.close();
    httpServer.close(() => {
      console.log("Server closed");
      process.exit(0);
    });
  });
}

main();
