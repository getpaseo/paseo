import express from "express";
import { createServer as createHTTPServer } from "http";
import { createReadStream, unlinkSync, existsSync } from "fs";
import { stat } from "fs/promises";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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
import type { SpeechToTextProvider, TextToSpeechProvider } from "./speech/speech-provider.js";
import type { RealtimeTranscriptionSessionFactory } from "./dictation/dictation-stream-manager.js";
import { SherpaOnlineRecognizerEngine } from "./speech/sherpa/sherpa-online-recognizer.js";
import { SherpaOfflineRecognizerEngine } from "./speech/sherpa/sherpa-offline-recognizer.js";
import { SherpaOnnxSTT } from "./speech/sherpa/sherpa-stt.js";
import { SherpaOnnxParakeetSTT } from "./speech/sherpa/sherpa-parakeet-stt.js";
import { SherpaOnnxTTS } from "./speech/sherpa/sherpa-tts.js";
import { SherpaRealtimeTranscriptionSession } from "./speech/sherpa/sherpa-realtime-session.js";
import { SherpaParakeetRealtimeTranscriptionSession } from "./speech/sherpa/sherpa-parakeet-realtime-session.js";
import { ensureSherpaOnnxModels, getSherpaOnnxModelDir } from "./speech/sherpa/model-downloader.js";
import type { SherpaOnnxModelId } from "./speech/sherpa/model-catalog.js";
import { PocketTtsOnnxTTS } from "./speech/pocket/pocket-tts-onnx.js";
import { AgentManager } from "./agent/agent-manager.js";
import { AgentStorage } from "./agent/agent-storage.js";
import { attachAgentStoragePersistence } from "./persistence-hooks.js";
import { createAgentMcpServer } from "./agent/mcp-server.js";
import { createAllClients, shutdownProviders } from "./agent/provider-registry.js";
import { createTerminalManager, type TerminalManager } from "../terminal/terminal-manager.js";
import {
  buildOfferEndpoints,
  createConnectionOfferV2,
  encodeOfferToFragmentUrl,
} from "./connection-offer.js";
import { loadOrCreateDaemonKeyPair } from "./daemon-keypair.js";
import { printPairingQrIfEnabled } from "./pairing-qr.js";
import { startRelayTransport, type RelayTransportController } from "./relay-transport.js";
import { getOrCreateServerId } from "./server-id.js";
import type {
  AgentClient,
  AgentProvider,
} from "./agent/agent-sdk-types.js";
import { acquirePidLock, releasePidLock } from "./pid-lock.js";
import { isHostAllowed, type AllowedHostsConfig } from "./allowed-hosts.js";

type AgentMcpTransportMap = Map<string, StreamableHTTPServerTransport>;

export type PaseoOpenAIConfig = {
  apiKey?: string;
  stt?: Partial<STTConfig> & { apiKey?: string };
  tts?: Partial<TTSConfig> & { apiKey?: string };
};

export type PaseoSherpaOnnxConfig = {
  modelsDir: string;
  autoDownload?: boolean;
  stt?: {
    preset?: string;
  };
  tts?: {
    preset?: string;
    speakerId?: number;
    speed?: number;
  };
};

export type PaseoSpeechConfig = {
  dictationSttProvider?: "openai" | "sherpa";
  voiceSttProvider?: "openai" | "sherpa";
  voiceTtsProvider?: "openai" | "sherpa";
  sherpaOnnx?: PaseoSherpaOnnxConfig;
};

export type PaseoDaemonConfig = {
  listen: string;
  paseoHome: string;
  corsAllowedOrigins: string[];
  allowedHosts?: AllowedHostsConfig;
  mcpEnabled?: boolean;
  staticDir: string;
  mcpDebug: boolean;
  agentClients: Partial<Record<AgentProvider, AgentClient>>;
  agentStoragePath: string;
  relayEnabled?: boolean;
  relayEndpoint?: string;
  relayPublicEndpoint?: string;
  appBaseUrl?: string;
  openai?: PaseoOpenAIConfig;
  speech?: PaseoSpeechConfig;
  openrouterApiKey?: string | null;
  voiceLlmModel?: string | null;
  dictationFinalTimeoutMs?: number;
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
  const serverId = getOrCreateServerId(config.paseoHome, { logger });
  const daemonKeyPair = await loadOrCreateDaemonKeyPair(config.paseoHome, logger);
  let relayTransport: RelayTransportController | null = null;

  const staticDir = config.staticDir;
  const downloadTokenTtlMs = config.downloadTokenTtlMs ?? 60000;

  const downloadTokenStore = new DownloadTokenStore({ ttlMs: downloadTokenTtlMs });

  const listenTarget = parseListenString(config.listen);

  const app = express();

  // Host allowlist / DNS rebinding protection (vite-like semantics).
  // For non-TCP (unix sockets), skip host validation.
  if (listenTarget.type === "tcp") {
    app.use((req, res, next) => {
      const hostHeader = typeof req.headers.host === "string" ? req.headers.host : undefined;
      if (!isHostAllowed(hostHeader, config.allowedHosts)) {
        res.status(403).json({ error: "Invalid Host header" });
        return;
      }
      next();
    });
  }

  // CORS - allow same-origin + configured origins
  const allowedOrigins = new Set([
    ...config.corsAllowedOrigins,
    // Tauri desktop app WebView origin (used for fetch/WebSocket in production builds).
    // This origin can't be produced by normal websites, so it's safe to allow by default.
    "tauri://localhost",
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

  const detachAgentStoragePersistence = attachAgentStoragePersistence(
    logger,
    agentManager,
    agentStorage
  );
  const persistedRecords = await agentStorage.list();
  logger.info(
    `Agent registry loaded (${persistedRecords.length} record${persistedRecords.length === 1 ? "" : "s"}); agents will initialize on demand`
  );

  // Create in-memory transport for Session's Agent MCP client (voice assistant tools)
  const createInMemoryAgentMcpTransport = async (): Promise<InMemoryTransport> => {
    const agentMcpServer = await createAgentMcpServer({
      agentManager,
      agentStorage,
      paseoHome: config.paseoHome,
      logger,
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await agentMcpServer.connect(serverTransport);

    return clientTransport;
  };

  const mcpEnabled = config.mcpEnabled ?? true;
  if (mcpEnabled) {
    const agentMcpRoute = "/mcp/agents";
    const agentMcpTransports: AgentMcpTransportMap = new Map();

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
        // NOTE: We enforce a Vite-like host allowlist at the app/websocket layer.
        // StreamableHTTPServerTransport's built-in check requires exact Host header matches.
        enableDnsRebindingProtection: false,
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
    logger.info({ route: agentMcpRoute }, "Agent MCP server mounted on main app");
  } else {
    logger.info("Agent MCP HTTP endpoint disabled");
  }


  let sttService: SpeechToTextProvider | null = null;
  let ttsService: TextToSpeechProvider | null = null;
  let dictationSessionFactory: RealtimeTranscriptionSessionFactory | undefined;

  let sherpaOnline: SherpaOnlineRecognizerEngine | null = null;
  let sherpaOffline: SherpaOfflineRecognizerEngine | null = null;
  let sherpaTts: TextToSpeechProvider | null = null;

  const openaiApiKey = config.openai?.apiKey;
  const speechConfig = config.speech ?? null;
  const sherpaConfig = speechConfig?.sherpaOnnx ?? null;

  const wantsSherpaDictation = (speechConfig?.dictationSttProvider ?? "openai") === "sherpa";
  const wantsSherpaVoiceStt = (speechConfig?.voiceSttProvider ?? "openai") === "sherpa";
  const wantsSherpaVoiceTts = (speechConfig?.voiceTtsProvider ?? "openai") === "sherpa";

  if ((wantsSherpaDictation || wantsSherpaVoiceStt || wantsSherpaVoiceTts) && sherpaConfig) {
    const autoDownload = sherpaConfig.autoDownload ?? (process.env.VITEST ? false : true);
    let sttPreset = (sherpaConfig.stt?.preset ?? "zipformer-bilingual-zh-en-2023-02-20").trim();
    if (
      sttPreset !== "zipformer-bilingual-zh-en-2023-02-20" &&
      sttPreset !== "paraformer-bilingual-zh-en" &&
      sttPreset !== "parakeet-tdt-0.6b-v3-int8"
    ) {
      logger.warn(
        { sttPreset },
        "Unknown Sherpa STT preset; falling back to zipformer-bilingual-zh-en-2023-02-20"
      );
      sttPreset = "zipformer-bilingual-zh-en-2023-02-20";
    }

    let ttsPreset = (sherpaConfig.tts?.preset ?? "pocket-tts-onnx-int8").trim();
    if (
      ttsPreset !== "kitten-nano-en-v0_1-fp16" &&
      ttsPreset !== "kokoro-en-v0_19" &&
      ttsPreset !== "pocket-tts-onnx-int8"
    ) {
      logger.warn(
        { ttsPreset },
        "Unknown Sherpa TTS preset; falling back to kitten-nano-en-v0_1-fp16"
      );
      ttsPreset = "kitten-nano-en-v0_1-fp16";
    }

    const modelIds: SherpaOnnxModelId[] = [];
    if (wantsSherpaDictation || wantsSherpaVoiceStt) {
      modelIds.push(sttPreset as SherpaOnnxModelId);
    }
    if (wantsSherpaVoiceTts) {
      modelIds.push(ttsPreset as SherpaOnnxModelId);
    }

    try {
      await ensureSherpaOnnxModels({
        modelsDir: sherpaConfig.modelsDir,
        modelIds,
        autoDownload,
        logger,
      });
    } catch (err) {
      logger.error(
        {
          err,
          modelsDir: sherpaConfig.modelsDir,
          autoDownload,
          hint:
            "Run: npm run dev --workspace=@getpaseo/server, then run: " +
            "`tsx packages/server/scripts/download-speech-models.ts --models-dir <DIR> --model <MODEL_ID>`",
        },
        "Failed to ensure local speech models"
      );
    }
  }

  if ((wantsSherpaDictation || wantsSherpaVoiceStt) && sherpaConfig) {
    let preset = (sherpaConfig.stt?.preset ?? "zipformer-bilingual-zh-en-2023-02-20").trim();
    if (
      preset !== "zipformer-bilingual-zh-en-2023-02-20" &&
      preset !== "paraformer-bilingual-zh-en" &&
      preset !== "parakeet-tdt-0.6b-v3-int8"
    ) {
      logger.warn(
        { preset },
        "Unknown Sherpa STT preset; falling back to zipformer-bilingual-zh-en-2023-02-20"
      );
      preset = "zipformer-bilingual-zh-en-2023-02-20";
    }
    const base = sherpaConfig.modelsDir;

    try {
      if (preset === "parakeet-tdt-0.6b-v3-int8") {
        const modelDir = getSherpaOnnxModelDir(base, "parakeet-tdt-0.6b-v3-int8");
        sherpaOffline = new SherpaOfflineRecognizerEngine(
          {
            model: {
              kind: "nemo_transducer",
              encoder: `${modelDir}/encoder.int8.onnx`,
              decoder: `${modelDir}/decoder.int8.onnx`,
              joiner: `${modelDir}/joiner.int8.onnx`,
              tokens: `${modelDir}/tokens.txt`,
            },
            numThreads: 2,
            debug: 0,
          },
          logger
        );
      } else {
        const model =
          preset === "paraformer-bilingual-zh-en"
            ? {
                kind: "paraformer" as const,
                encoder: `${base}/sherpa-onnx-streaming-paraformer-bilingual-zh-en/encoder.int8.onnx`,
                decoder: `${base}/sherpa-onnx-streaming-paraformer-bilingual-zh-en/decoder.int8.onnx`,
                tokens: `${base}/sherpa-onnx-streaming-paraformer-bilingual-zh-en/tokens.txt`,
              }
            : {
                kind: "transducer" as const,
                encoder: `${base}/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20/encoder-epoch-99-avg-1.onnx`,
                decoder: `${base}/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20/decoder-epoch-99-avg-1.onnx`,
                joiner: `${base}/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20/joiner-epoch-99-avg-1.onnx`,
                tokens: `${base}/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20/tokens.txt`,
                modelType: "zipformer",
              };

        sherpaOnline = new SherpaOnlineRecognizerEngine(
          {
            model,
            numThreads: 1,
            debug: 0,
          },
          logger
        );
      }
    } catch (err) {
      logger.error(
        {
          err,
          modelsDir: sherpaConfig.modelsDir,
          preset,
          hint: `Run: tsx packages/server/scripts/download-speech-models.ts --models-dir '${sherpaConfig.modelsDir}' --model '${preset}'`,
        },
        "Failed to initialize Sherpa STT (models missing or invalid)"
      );
      sherpaOnline = null;
      sherpaOffline = null;
    }
  } else if (wantsSherpaDictation || wantsSherpaVoiceStt) {
    logger.warn(
      { configured: Boolean(sherpaConfig) },
      "Sherpa STT selected but no sherpaOnnx config found; STT will be unavailable"
    );
  }

  if (wantsSherpaVoiceTts && sherpaConfig) {
    let preset = (sherpaConfig.tts?.preset ?? "pocket-tts-onnx-int8").trim();
    if (
      preset !== "kitten-nano-en-v0_1-fp16" &&
      preset !== "kokoro-en-v0_19" &&
      preset !== "pocket-tts-onnx-int8"
    ) {
      logger.warn(
        { preset },
        "Unknown Sherpa TTS preset; falling back to kitten-nano-en-v0_1-fp16"
      );
      preset = "kitten-nano-en-v0_1-fp16";
    }
    try {
      if (preset === "pocket-tts-onnx-int8") {
        const modelDir = getSherpaOnnxModelDir(sherpaConfig.modelsDir, "pocket-tts-onnx-int8");
        sherpaTts = await PocketTtsOnnxTTS.create(
          {
            modelDir,
            precision: "int8",
            targetChunkMs: 50,
          },
          logger
        );
      } else {
        const modelDir = `${sherpaConfig.modelsDir}/${preset}`;
        sherpaTts = new SherpaOnnxTTS(
          {
            preset: preset as any,
            modelDir,
            speakerId: sherpaConfig.tts?.speakerId,
            speed: sherpaConfig.tts?.speed,
          },
          logger
        );
      }
    } catch (err) {
      logger.error(
        {
          err,
          preset,
          hint: `Run: tsx packages/server/scripts/download-speech-models.ts --models-dir '${sherpaConfig.modelsDir}' --model '${preset}'`,
        },
        "Failed to initialize Sherpa TTS (models missing or invalid)"
      );
      sherpaTts = null;
    }
  } else if (wantsSherpaVoiceTts) {
    logger.warn(
      { configured: Boolean(sherpaConfig) },
      "Sherpa TTS selected but no sherpaOnnx config found; TTS will be unavailable"
    );
  }

  if (wantsSherpaVoiceStt && sherpaOffline) {
    sttService = new SherpaOnnxParakeetSTT({ engine: sherpaOffline }, logger);
  } else if (wantsSherpaVoiceStt && sherpaOnline) {
    sttService = new SherpaOnnxSTT({ engine: sherpaOnline }, logger);
  }

  if (wantsSherpaVoiceTts && sherpaTts) {
    ttsService = sherpaTts;
  }

  if (wantsSherpaDictation && sherpaOnline) {
    dictationSessionFactory = () => new SherpaRealtimeTranscriptionSession({ engine: sherpaOnline! });
  } else if (wantsSherpaDictation && sherpaOffline) {
    dictationSessionFactory = () => new SherpaParakeetRealtimeTranscriptionSession({ engine: sherpaOffline! });
  }

  const voiceSttProvider = speechConfig?.voiceSttProvider ?? "openai";
  const voiceTtsProvider = speechConfig?.voiceTtsProvider ?? "openai";
  const dictationSttProvider = speechConfig?.dictationSttProvider ?? "openai";

  const needsOpenAiStt = !sttService && voiceSttProvider === "openai";
  const needsOpenAiTts = !ttsService && voiceTtsProvider === "openai";
  const needsOpenAiDictation =
    dictationSttProvider === "openai" || (dictationSttProvider === "sherpa" && !dictationSessionFactory);

  const fallbackOpenAiStt = !sttService && voiceSttProvider === "sherpa" && Boolean(openaiApiKey);
  const fallbackOpenAiTts = !ttsService && voiceTtsProvider === "sherpa" && Boolean(openaiApiKey);

  if ((needsOpenAiStt || needsOpenAiTts || needsOpenAiDictation || fallbackOpenAiStt || fallbackOpenAiTts) && openaiApiKey) {
    logger.info("OpenAI client initialized");

    if (fallbackOpenAiStt) {
      logger.warn("Falling back to OpenAI STT because Sherpa STT is unavailable");
    }
    if (needsOpenAiStt || fallbackOpenAiStt) {
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
    }

    if (fallbackOpenAiTts) {
      logger.warn("Falling back to OpenAI TTS because Sherpa TTS is unavailable");
    }
    if (needsOpenAiTts || fallbackOpenAiTts) {
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
    }
  } else if (needsOpenAiStt || needsOpenAiTts || needsOpenAiDictation || fallbackOpenAiStt || fallbackOpenAiTts) {
    logger.warn("OPENAI_API_KEY not set - OpenAI STT/TTS/dictation fallback is unavailable");
  }

  const wsServer = new VoiceAssistantWebSocketServer(
    httpServer,
    logger,
    serverId,
    agentManager,
    agentStorage,
    downloadTokenStore,
    config.paseoHome,
    createInMemoryAgentMcpTransport,
    { allowedOrigins, allowedHosts: config.allowedHosts },
    { stt: sttService, tts: ttsService },
    terminalManager,
    {
      openrouterApiKey: config.openrouterApiKey ?? null,
      voiceLlmModel: config.voiceLlmModel ?? null,
    },
    {
      openaiApiKey: config.openai?.apiKey ?? null,
      finalTimeoutMs: config.dictationFinalTimeoutMs,
      ...(dictationSessionFactory ? { sessionFactory: dictationSessionFactory } : {}),
    }
  );

  const start = async () => {
    // Acquire PID lock
    await acquirePidLock(config.paseoHome, config.listen);

    // Start main HTTP server
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
            const relayPublicEndpoint = config.relayPublicEndpoint ?? relayEndpoint;
            const appBaseUrl = config.appBaseUrl ?? "https://app.paseo.sh";

            const directEndpoints = buildOfferEndpoints({
              listenHost: listenTarget.host,
              port: listenTarget.port,
            });

            logger.info(
              {
                serverId,
                endpoints: directEndpoints,
                wsUrls: directEndpoints.map((endpoint) => `ws://${endpoint}/ws`),
              },
              "direct_connect"
            );

            if (relayEnabled) {
              const offer = await createConnectionOfferV2({
                serverId,
                daemonPublicKeyB64: daemonKeyPair.publicKeyB64,
                relay: { endpoint: relayPublicEndpoint },
              });

              const url = encodeOfferToFragmentUrl({ offer, appBaseUrl });
              logger.info({ url }, "pairing_offer");
              void printPairingQrIfEnabled({ url, logger }).catch(() => undefined);
            } else {
              logger.info("relay_disabled");
            }

            if (relayEnabled) {
              relayTransport?.stop().catch(() => undefined);
              relayTransport = startRelayTransport({
                logger,
                attachSocket: (ws) => wsServer.attachExternalSocket(ws),
                relayEndpoint,
                serverId,
                daemonKeyPair: daemonKeyPair.keyPair,
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
    await agentManager.flush().catch(() => undefined);
    detachAgentStoragePersistence();
    await agentStorage.flush().catch(() => undefined);
    await shutdownProviders(logger);
    terminalManager.killAll();
    if (sherpaTts && typeof (sherpaTts as any).free === "function") {
      (sherpaTts as any).free();
    }
    sherpaOnline?.free();
    sherpaOffline?.free();
    await relayTransport?.stop().catch(() => undefined);
    await wsServer.close();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    // Clean up socket files
    if (listenTarget.type === "socket" && existsSync(listenTarget.path)) {
      unlinkSync(listenTarget.path);
    }
    // Release PID lock
    await releasePidLock(config.paseoHome);
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
