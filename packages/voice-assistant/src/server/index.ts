import "dotenv/config";
import express from "express";
import basicAuth from "express-basic-auth";
import path from "path";
import { fileURLToPath } from "url";
import { createServer as createHTTPServer, Server as HttpServer } from "http";
import { readFile } from "fs/promises";
import { createServer as createViteServer } from "vite";
import type { ViteDevServer } from "vite";
import type { ServerConfig } from "./types.js";
import { VoiceAssistantWebSocketServer } from "./websocket-server.js";
import { initializeSTT } from "./agent/stt-openai.js";
import { initializeTTS } from "./agent/tts-openai.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function createServer(httpServer: HttpServer, config: ServerConfig) {
  const app = express();

  // Basic authentication
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
  const port = parseInt(process.env.PORT || "6767", 10);
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
