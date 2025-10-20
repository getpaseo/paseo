import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createServer as createHTTPServer, Server as HttpServer } from "http";
import { readFile } from "fs/promises";
import { v4 as uuidv4 } from "uuid";
import { createServer as createViteServer } from "vite";
import type { ViteDevServer } from "vite";
import type { ServerConfig } from "./types.js";
import { VoiceAssistantWebSocketServer } from "./websocket-server.js";
import {
  initializeDefaultSession,
  listTerminals,
  createTerminal,
  sendText,
  captureTerminal,
  killTerminal,
} from "./daemon/terminal-manager.js";
import { initializeSTT, transcribeAudio } from "./agent/stt-openai.js";
import { initializeTTS } from "./agent/tts-openai.js";
import {
  processUserMessage,
  cleanupConversations,
} from "./agent/orchestrator.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function createServer(httpServer: HttpServer, config: ServerConfig) {
  const app = express();

  // Middleware
  app.use(express.json());

  // Health check endpoint
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Test endpoint for LLM integration (removed - using orchestrator now)

  // Test endpoint for terminal operations
  app.get("/api/test-terminal", async (_req, res) => {
    try {
      const testResults: string[] = [];

      // 1. Initialize default session
      testResults.push("1. Initializing default session...");
      await initializeDefaultSession();
      testResults.push("   ✓ Session initialized");

      // 2. List existing terminals
      testResults.push("2. Listing existing terminals...");
      const beforeTerminals = await listTerminals();
      testResults.push(
        `   ✓ Found ${beforeTerminals.length} existing terminals`
      );

      // 3. Create a test terminal
      testResults.push("3. Creating test terminal...");
      const terminal = await createTerminal({
        name: "test-terminal",
        workingDirectory: "~",
        initialCommand: undefined,
      });
      testResults.push(
        `   ✓ Created terminal: ${terminal.name}`
      );

      // 4. Send a command to the terminal
      testResults.push('4. Sending command "echo hello world"...');
      await sendText(terminal.name, 'echo "hello world"', true, {
        lines: 20,
      });
      testResults.push("   ✓ Command sent");

      // 5. Capture output
      testResults.push("5. Capturing terminal output...");
      const output = await captureTerminal(terminal.name, 20);
      testResults.push(`   ✓ Captured ${output.split("\n").length} lines`);
      testResults.push(`   Output preview: ${output.substring(0, 100)}...`);

      // 6. List terminals again
      testResults.push("6. Listing terminals again...");
      const afterTerminals = await listTerminals();
      testResults.push(`   ✓ Found ${afterTerminals.length} terminals`);
      const testTerminal = afterTerminals.find(
        (t) => t.name === "test-terminal"
      );
      if (testTerminal) {
        testResults.push(`   ✓ Found test-terminal`);
      }

      // 7. Kill the test terminal
      testResults.push("7. Killing test terminal...");
      await killTerminal(terminal.name);
      testResults.push("   ✓ Terminal killed");

      // 8. Verify it's gone
      testResults.push("8. Verifying terminal was removed...");
      const finalTerminals = await listTerminals();
      const stillExists = finalTerminals.find(
        (t) => t.name === "test-terminal"
      );
      if (!stillExists) {
        testResults.push("   ✓ Terminal successfully removed");
      } else {
        testResults.push("   ✗ Terminal still exists!");
      }

      res.json({
        success: true,
        message: "All terminal operations completed successfully",
        results: testResults,
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: error.message,
        stack: error.stack,
      });
    }
  });

  let vite: ViteDevServer | undefined;

  if (config.isDev) {
    // Development: Create Vite server in middleware mode
    vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: ["localhost", "mohameds-macbook-pro.tail8fe838.ts.net"],
        hmr: {
          server: httpServer,
          port: config.port,
          protocol: "wss",
          path: "/hmr",
        },
      },
      appType: "custom",
    });

    // Use Vite's middleware to handle HMR, module transformation, etc.
    app.use(vite.middlewares);
  } else {
    // Production: Serve static files from dist/ui
    const uiPath = path.join(__dirname, "../ui");
    app.use(express.static(uiPath));
  }

  // SPA fallback - serve index.html for all non-API routes
  app.use("*", async (req, res, next) => {
    if (req.originalUrl.startsWith("/api")) {
      return res.status(404).json({ error: "Not found" });
    }

    try {
      const indexHtmlPath = config.isDev
        ? path.resolve(__dirname, "../../src/ui/index.html")
        : path.join(__dirname, "../ui/index.html");

      let html = await readFile(indexHtmlPath, "utf-8");

      // In development, transform the HTML with Vite
      if (config.isDev && vite) {
        html = await vite.transformIndexHtml(req.originalUrl, html);
      }

      res.status(200).set({ "Content-Type": "text/html" }).end(html);
    } catch (e) {
      if (config.isDev && vite) {
        vite.ssrFixStacktrace(e as Error);
      }
      next(e);
    }
  });

  return { app, vite };
}

async function main() {
  const port = parseInt(process.env.PORT || "3000", 10);
  const isDev = process.env.NODE_ENV !== "production";

  const config: ServerConfig = { port, isDev };

  const httpServer = createHTTPServer((req, res) => {
    app(req, res);
  });

  const { app, vite } = await createServer(httpServer, config);

  // Create HTTP server

  // Initialize WebSocket server
  const wsServer = new VoiceAssistantWebSocketServer(httpServer);

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
      responseFormat: "mp3",
    });
  } else {
    console.warn(
      "⚠ OPENAI_API_KEY not set - LLM, STT, and TTS features will not work"
    );
  }

  // Wire orchestrator to WebSocket for text messages
  wsServer.setMessageHandler(async (conversationId: string, message: string, abortSignal: AbortSignal) => {
    try {
      // Broadcast user's text message as activity log
      wsServer.broadcastActivityLog({
        id: uuidv4(),
        timestamp: new Date(),
        type: "transcript",
        content: message,
      });

      await processUserMessage({
        conversationId,
        message,
        wsServer,
        enableTTS: true,
        abortSignal,
      });
    } catch (error: any) {
      console.error("[Orchestrator] Error processing message:", error);
      wsServer.broadcastActivityLog({
        id: uuidv4(),
        timestamp: new Date(),
        type: "error",
        content: `Error: ${error.message}`,
      });
    }
  });

  // Wire audio handler to WebSocket for voice input (STT)
  wsServer.setAudioHandler(
    async (conversationId: string, audio: Buffer, format: string, abortSignal: AbortSignal): Promise<string> => {
      try {
        // Transcribe audio using OpenAI Whisper
        const result = await transcribeAudio(audio, format);

        // Check if transcription is empty or only whitespace
        const transcriptText = result.text.trim();
        if (!transcriptText) {
          console.log("[STT] Transcription is empty or silence, skipping LLM processing");
          // Reset to idle since we're not processing
          wsServer.setPhaseForConversation(conversationId, 'idle');
          return "";
        }

        // Broadcast transcription result as activity log
        wsServer.broadcastActivityLog({
          id: uuidv4(),
          timestamp: new Date(),
          type: "transcript",
          content: result.text,
          metadata: {
            language: result.language,
            duration: result.duration,
          },
        });

        // Set phase to LLM before processing
        wsServer.setPhaseForConversation(conversationId, 'llm');

        // Process the transcribed text through the orchestrator WITH TTS enabled
        // Since this came from voice input, respond with voice output
        await processUserMessage({
          conversationId,
          message: result.text,
          wsServer,
          enableTTS: true,
          abortSignal,
        });

        // Reset to idle after LLM processing completes
        wsServer.setPhaseForConversation(conversationId, 'idle');

        return result.text;
      } catch (error: any) {
        // Reset to idle on error
        wsServer.setPhaseForConversation(conversationId, 'idle');

        console.error("[STT] Error transcribing audio:", error);
        wsServer.broadcastActivityLog({
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Transcription error: ${error.message}`,
        });
        throw error;
      }
    }
  );

  // Start conversation cleanup interval (every 10 minutes)
  setInterval(() => {
    cleanupConversations(60); // Clean up conversations older than 60 minutes
  }, 10 * 60 * 1000);

  // Initialize default tmux session for terminal control
  try {
    await initializeDefaultSession();
    console.log("✓ Default tmux session initialized");
  } catch (error) {
    console.error("Failed to initialize tmux session:", error);
  }

  httpServer.listen(port, () => {
    console.log(
      `\n✓ Voice Assistant server running on http://localhost:${port}`
    );
    if (isDev) {
      console.log(`✓ Vite dev server integrated (HMR enabled)\n`);
    }
  });

  // Graceful shutdown
  process.on("SIGTERM", async () => {
    console.log("\nSIGTERM received, shutting down gracefully...");
    wsServer.close();
    if (vite) {
      await vite.close();
    }
    httpServer.close(() => {
      console.log("Server closed");
      process.exit(0);
    });
  });
}

main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
