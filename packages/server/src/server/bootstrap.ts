import express from "express";
import { createServer as createHTTPServer, type IncomingMessage, type ServerResponse } from "http";
import { createReadStream, unlinkSync, existsSync } from "fs";
import { stat } from "fs/promises";
import { randomUUID } from "node:crypto";
import { hostname as getHostname } from "node:os";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "pino";
import { createBranchChangeRouteHandler } from "./script-route-branch-handler.js";

export type ListenTarget =
  | { type: "tcp"; host: string; port: number }
  | { type: "socket"; path: string }
  | { type: "pipe"; path: string };

function resolveBoundListenTarget(
  listenTarget: ListenTarget,
  httpServer: ReturnType<typeof createHTTPServer>,
): ListenTarget {
  if (listenTarget.type !== "tcp") {
    return listenTarget;
  }

  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("HTTP server did not expose a TCP address after listening");
  }

  return {
    type: "tcp",
    host: listenTarget.host,
    port: address.port,
  };
}

// Matches a Windows drive-letter path like C:\ or D:\
const WINDOWS_DRIVE_RE = /^[A-Za-z]:\\/;

export function parseListenString(listen: string): ListenTarget {
  // 1. Windows named pipes: \\.\pipe\... or pipe://...
  if (listen.startsWith("\\\\.\\pipe\\") || listen.startsWith("pipe://")) {
    return {
      type: "pipe",
      path: listen.startsWith("pipe://") ? listen.slice("pipe://".length) : listen,
    };
  }
  // 2. Explicit unix:// prefix
  if (listen.startsWith("unix://")) {
    return { type: "socket", path: listen.slice(7) };
  }
  // 3. Reject Windows absolute drive paths — they are not Unix sockets
  if (WINDOWS_DRIVE_RE.test(listen)) {
    throw new Error(`Invalid listen string (Windows path is not a valid listen target): ${listen}`);
  }
  // 4. POSIX absolute path (/ or ~) — Unix socket
  if (listen.startsWith("/") || listen.startsWith("~")) {
    return { type: "socket", path: listen };
  }
  // 5. Pure numeric — TCP port on 127.0.0.1
  const trimmed = listen.trim();
  if (/^\d+$/.test(trimmed)) {
    const port = parseInt(trimmed, 10);
    return { type: "tcp", host: "127.0.0.1", port };
  }
  // 6. host:port — TCP
  if (listen.includes(":")) {
    const [host, portStr] = listen.split(":");
    const parsedPort = parseInt(portStr, 10);
    if (!Number.isFinite(parsedPort)) {
      throw new Error(`Invalid port in listen string: ${listen}`);
    }
    return { type: "tcp", host: host || "127.0.0.1", port: parsedPort };
  }
  throw new Error(`Invalid listen string: ${listen}`);
}

function formatListenTarget(listenTarget: ListenTarget | null): string | null {
  if (!listenTarget) {
    return null;
  }
  if (listenTarget.type === "tcp") {
    return `${listenTarget.host}:${listenTarget.port}`;
  }
  return listenTarget.path;
}

import { VoiceAssistantWebSocketServer } from "./websocket-server.js";
import { createGitHubService } from "../services/github-service.js";
import { createPaseoWorktree } from "./paseo-worktree-service.js";
import { createWorktreeCoreDeps } from "./worktree-core.js";
import { DownloadTokenStore } from "./file-download/token-store.js";
import type { OpenAiSpeechProviderConfig } from "./speech/providers/openai/config.js";
import type { LocalSpeechProviderConfig } from "./speech/providers/local/config.js";
import type { RequestedSpeechProviders } from "./speech/speech-types.js";
import { createSpeechService } from "./speech/speech-runtime.js";
import { AgentManager } from "./agent/agent-manager.js";
import { AgentStorage } from "./agent/agent-storage.js";
import { attachAgentStoragePersistence } from "./persistence-hooks.js";
import { createAgentMcpServer } from "./agent/mcp-server.js";
import {
  buildProviderRegistry,
  createClientsFromRegistry,
  shutdownProviders,
} from "./agent/provider-registry.js";
import { bootstrapWorkspaceRegistries } from "./workspace-registry-bootstrap.js";
import { FileBackedProjectRegistry, FileBackedWorkspaceRegistry } from "./workspace-registry.js";
import { FileBackedChatService } from "./chat/chat-service.js";
import { CheckoutDiffManager } from "./checkout-diff-manager.js";
import { LoopService } from "./loop-service.js";
import { ScheduleService } from "./schedule/service.js";
import { DaemonConfigStore } from "./daemon-config-store.js";
import { WorkspaceGitServiceImpl } from "./workspace-git-service.js";
import { archivePersistedWorkspaceRecord } from "./workspace-archive-service.js";
import { wrapSessionMessage, type SessionOutboundMessage } from "./messages.js";
import { createTerminalManager, type TerminalManager } from "../terminal/terminal-manager.js";
import { createConnectionOfferV2, encodeOfferToFragmentUrl } from "./connection-offer.js";
import { loadOrCreateDaemonKeyPair } from "./daemon-keypair.js";
import { startRelayTransport, type RelayTransportController } from "./relay-transport.js";
import { getOrCreateServerId } from "./server-id.js";
import { resolveDaemonVersion } from "./daemon-version.js";
import type { AgentClient, AgentProvider } from "./agent/agent-sdk-types.js";
import type {
  AgentProviderRuntimeSettingsMap,
  ProviderOverride,
} from "./agent/provider-launch-config.js";
import {
  ScriptRouteStore,
  createScriptProxyMiddleware,
  createScriptProxyUpgradeHandler,
} from "./script-proxy.js";
import { ScriptHealthMonitor } from "./script-health-monitor.js";
import { createScriptStatusEmitter } from "./script-status-projection.js";
import { WorkspaceScriptRuntimeStore } from "./workspace-script-runtime-store.js";
import { isHostnameAllowed, type HostnamesConfig } from "./hostnames.js";

type AgentMcpTransportMap = Map<string, StreamableHTTPServerTransport>;

function formatHostForHttpUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function createAgentMcpBaseUrl(listenTarget: ListenTarget | null): string | null {
  if (!listenTarget || listenTarget.type !== "tcp") {
    return null;
  }
  return new URL(
    "/mcp/agents",
    `http://${formatHostForHttpUrl(listenTarget.host)}:${listenTarget.port}`,
  ).toString();
}

export type PaseoOpenAIConfig = OpenAiSpeechProviderConfig;
export type PaseoLocalSpeechConfig = LocalSpeechProviderConfig;

export interface PaseoSpeechConfig {
  providers: RequestedSpeechProviders;
  local?: PaseoLocalSpeechConfig;
}

export type DaemonLifecycleIntent =
  | {
      type: "shutdown";
      clientId: string;
      requestId: string;
    }
  | {
      type: "restart";
      clientId: string;
      requestId: string;
      reason?: string;
    };

export interface PaseoDaemonConfig {
  listen: string;
  paseoHome: string;
  corsAllowedOrigins: string[];
  allowedHosts?: HostnamesConfig;
  hostnames?: HostnamesConfig;
  mcpEnabled?: boolean;
  mcpInjectIntoAgents?: boolean;
  staticDir: string;
  mcpDebug: boolean;
  isDev?: boolean;
  agentClients: Partial<Record<AgentProvider, AgentClient>>;
  agentStoragePath: string;
  relayEnabled?: boolean;
  relayEndpoint?: string;
  relayPublicEndpoint?: string;
  appBaseUrl?: string;
  openai?: PaseoOpenAIConfig;
  speech?: PaseoSpeechConfig;
  voiceLlmProvider?: AgentProvider | null;
  voiceLlmProviderExplicit?: boolean;
  voiceLlmModel?: string | null;
  dictationFinalTimeoutMs?: number;
  downloadTokenTtlMs?: number;
  agentProviderSettings?: AgentProviderRuntimeSettingsMap;
  providerOverrides?: Record<string, ProviderOverride>;
  onLifecycleIntent?: (intent: DaemonLifecycleIntent) => void;
}

export interface PaseoDaemon {
  config: PaseoDaemonConfig;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  terminalManager: TerminalManager;
  scriptRouteStore: ScriptRouteStore;
  scriptRuntimeStore: WorkspaceScriptRuntimeStore;
  start(): Promise<void>;
  stop(): Promise<void>;
  getListenTarget(): ListenTarget | null;
}

export async function createPaseoDaemon(
  config: PaseoDaemonConfig,
  rootLogger: Logger,
): Promise<PaseoDaemon> {
  const logger = rootLogger.child({ module: "bootstrap" });
  const bootstrapStart = performance.now();
  const elapsed = () => `${(performance.now() - bootstrapStart).toFixed(0)}ms`;
  const daemonVersion = resolveDaemonVersion(import.meta.url);
  const daemonConfigStore = new DaemonConfigStore(
    config.paseoHome,
    {
      mcp: { injectIntoAgents: config.mcpInjectIntoAgents ?? true },
      providers: Object.fromEntries(
        Object.entries(config.providerOverrides ?? {}).map(([providerId, override]) => [
          providerId,
          {
            ...(override.enabled !== undefined ? { enabled: override.enabled } : {}),
            ...(override.additionalModels ? { additionalModels: override.additionalModels } : {}),
          },
        ]),
      ),
    },
    logger,
  );

  const serverId = getOrCreateServerId(config.paseoHome, { logger });
  const daemonKeyPair = await loadOrCreateDaemonKeyPair(config.paseoHome, logger);
  let relayTransport: RelayTransportController | null = null;

  const staticDir = config.staticDir;
  const downloadTokenTtlMs = config.downloadTokenTtlMs ?? 60000;

  const downloadTokenStore = new DownloadTokenStore({ ttlMs: downloadTokenTtlMs });

  const listenTarget = parseListenString(config.listen);

  const app = express();
  let boundListenTarget: ListenTarget | null = null;
  let workspaceRegistry: FileBackedWorkspaceRegistry | null = null;

  const scriptRouteStore = new ScriptRouteStore();
  const scriptRuntimeStore = new WorkspaceScriptRuntimeStore();
  const configuredHostnames = config.hostnames ?? config.allowedHosts;
  let wsServer: VoiceAssistantWebSocketServer | null = null;
  const scriptHealthMonitor = new ScriptHealthMonitor({
    routeStore: scriptRouteStore,
    onChange: createScriptStatusEmitter({
      sessions: () =>
        wsServer?.listActiveSessions().map((session) => ({
          emit: (message) => session.emitServerMessage(message),
        })) ?? [],
      routeStore: scriptRouteStore,
      runtimeStore: scriptRuntimeStore,
      daemonPort: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
      resolveWorkspaceDirectory: async (workspaceId) =>
        (await workspaceRegistry?.get(workspaceId))?.cwd ?? null,
      logger,
    }),
  });
  const handleBranchChange = createBranchChangeRouteHandler({
    routeStore: scriptRouteStore,
    onRoutesChanged: (workspaceId) => {
      scriptHealthMonitor.invalidateWorkspace(workspaceId);
    },
    logger,
  });

  // Host allowlist / DNS rebinding protection (vite-like semantics).
  // For non-TCP (unix sockets), skip host validation.
  if (listenTarget.type === "tcp") {
    app.use((req, res, next) => {
      const hostHeader = typeof req.headers.host === "string" ? req.headers.host : undefined;
      if (!isHostnameAllowed(hostHeader, configuredHostnames)) {
        res.status(403).json({ error: "Invalid Host header" });
        return;
      }
      next();
    });
  }

  // Script proxy — intercepts requests for registered *.localhost hostnames
  // and forwards them to the corresponding local script port. Placed after
  // the host allowlist (*.localhost is already allowed) but before CORS and
  // the rest of the routes so proxied requests skip unnecessary middleware.
  app.use(createScriptProxyMiddleware({ routeStore: scriptRouteStore, logger }));

  // CORS - allow same-origin + configured origins
  const allowedOrigins = new Set([
    ...config.corsAllowedOrigins,
    // Packaged desktop renderers use the custom paseo:// protocol scheme.
    "paseo://app",
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
    if (origin && (allowedOrigins.has("*") || allowedOrigins.has(origin))) {
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

  app.get("/api/status", (_req, res) => {
    res.json({
      status: "server_info",
      serverId,
      hostname: getHostname(),
      version: daemonVersion,
      listen: formatListenTarget(boundListenTarget ?? listenTarget),
    });
  });

  const handleFileDownload = async (req: express.Request, res: express.Response): Promise<void> => {
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
      res.setHeader("Content-Disposition", `attachment; filename="${safeFileName}"`);
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
  };

  app.get("/api/files/download", (req, res) => {
    void handleFileDownload(req, res);
  });

  const httpServer = createHTTPServer(app);

  // Script proxy WebSocket upgrade handler — must be registered before the
  // VoiceAssistantWebSocketServer attaches its own "upgrade" listener so that
  // script-bound upgrades are forwarded first. The handler is a no-op for
  // requests that don't match a registered script route.
  const scriptProxyUpgradeHandler = createScriptProxyUpgradeHandler({
    routeStore: scriptRouteStore,
    logger,
  });
  httpServer.on("upgrade", scriptProxyUpgradeHandler);

  const agentStorage = new AgentStorage(config.agentStoragePath, logger);
  const projectRegistry = new FileBackedProjectRegistry(
    path.join(config.paseoHome, "projects", "projects.json"),
    logger,
  );
  workspaceRegistry = new FileBackedWorkspaceRegistry(
    path.join(config.paseoHome, "projects", "workspaces.json"),
    logger,
  );
  const chatService = new FileBackedChatService({
    paseoHome: config.paseoHome,
    logger,
  });
  const terminalManager = createTerminalManager();
  const github = createGitHubService();
  const workspaceGitService = new WorkspaceGitServiceImpl({
    logger,
    paseoHome: config.paseoHome,
    deps: {
      github,
    },
  });
  const providerRegistry = buildProviderRegistry(logger, {
    runtimeSettings: config.agentProviderSettings,
    providerOverrides: config.providerOverrides,
    workspaceGitService,
    isDev: config.isDev === true,
  });
  const agentManager = new AgentManager({
    clients: {
      ...createClientsFromRegistry(providerRegistry, logger),
      ...config.agentClients,
    },
    providerDefinitions: providerRegistry,
    registry: agentStorage,
    logger,
  });

  const detachAgentStoragePersistence = attachAgentStoragePersistence(
    logger,
    agentManager,
    agentStorage,
  );
  await agentStorage.initialize();
  logger.info({ elapsed: elapsed() }, "Agent storage initialized");
  await bootstrapWorkspaceRegistries({
    paseoHome: config.paseoHome,
    agentStorage,
    projectRegistry,
    workspaceRegistry,
    workspaceGitService,
    logger,
  });
  logger.info({ elapsed: elapsed() }, "Workspace registries bootstrapped");
  await chatService.initialize();
  logger.info({ elapsed: elapsed() }, "Chat service initialized");
  const checkoutDiffManager = new CheckoutDiffManager({
    logger,
    paseoHome: config.paseoHome,
    workspaceGitService,
  });
  const loopService = new LoopService({
    paseoHome: config.paseoHome,
    logger,
    agentManager,
  });
  await loopService.initialize();
  logger.info({ elapsed: elapsed() }, "Loop service initialized");
  const scheduleService = new ScheduleService({
    paseoHome: config.paseoHome,
    logger,
    agentManager,
    agentStorage,
  });
  await scheduleService.start();
  logger.info({ elapsed: elapsed() }, "Schedule service initialized");
  logger.info({ elapsed: elapsed() }, "Loading persisted agent registry");
  const persistedRecords = await agentStorage.list();
  logger.info(
    { elapsed: elapsed() },
    `Agent registry loaded (${persistedRecords.length} record${persistedRecords.length === 1 ? "" : "s"}); agents will initialize on demand`,
  );
  logger.info(
    "Voice mode configured for agent-scoped resume flow (no dedicated voice assistant provider)",
  );
  logger.info({ elapsed: elapsed() }, "Preparing voice and MCP runtime");
  const mcpEnabled = config.mcpEnabled ?? true;
  let agentMcpBaseUrl: string | null = null;
  if (mcpEnabled) {
    const agentMcpRoute = "/mcp/agents";
    const agentMcpTransports: AgentMcpTransportMap = new Map();
    const archiveWorkspaceRecordForMcp = async (workspaceId: string) => {
      const sessions = wsServer?.listActiveSessions() ?? [];
      if (sessions.length > 0) {
        await Promise.all(
          sessions.map((session) => session.archiveWorkspaceRecordForExternalMutation(workspaceId)),
        );
        return;
      }

      await archivePersistedWorkspaceRecord({
        workspaceId,
        workspaceRegistry,
        projectRegistry,
      });
    };
    const emitWorkspaceUpdatesForMcpArchive = async (cwds: Iterable<string>) => {
      const cwdList = Array.from(cwds);
      await Promise.all(
        (wsServer?.listActiveSessions() ?? []).map((session) =>
          session.emitWorkspaceUpdatesForExternalCwds(cwdList),
        ),
      );
    };
    const emitMcpArchiveSessionMessage = (message: SessionOutboundMessage) => {
      wsServer?.broadcast(wrapSessionMessage(message));
    };

    const createAgentMcpTransport = async (callerAgentId?: string) => {
      const agentMcpServer = await createAgentMcpServer({
        agentManager,
        agentStorage,
        terminalManager,
        getDaemonTcpPort: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
        scheduleService,
        providerRegistry,
        github,
        workspaceGitService,
        archiveWorkspaceRecord: archiveWorkspaceRecordForMcp,
        emitWorkspaceUpdatesForCwds: emitWorkspaceUpdatesForMcpArchive,
        emitSessionMessage: emitMcpArchiveSessionMessage,
        createPaseoWorktree: async (input, serviceOptions) => {
          const coreDeps = createWorktreeCoreDeps(github);
          const result = await createPaseoWorktree(input, {
            ...coreDeps,
            ...(serviceOptions?.resolveDefaultBranch
              ? {
                  resolveDefaultBranch: serviceOptions.resolveDefaultBranch,
                }
              : {}),
            projectRegistry,
            workspaceRegistry,
            workspaceGitService,
          });
          await Promise.all(
            wsServer
              ?.listActiveSessions()
              .map((session) => session.warmWorkspaceGitDataForWorkspace(result.workspace)) ?? [],
          );
          return result;
        },
        paseoHome: config.paseoHome,
        callerAgentId,
        enableVoiceTools: false,
        resolveSpeakHandler: (agentId) => wsServer?.resolveVoiceSpeakHandler(agentId) ?? null,
        resolveCallerContext: (agentId) => wsServer?.resolveVoiceCallerContext(agentId) ?? null,
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

      Object.assign(transport, {
        onclose: () => {
          if (transport.sessionId) {
            agentMcpTransports.delete(transport.sessionId);
          }
        },
        onerror: (err: Error) => {
          logger.error({ err }, "Agent MCP transport error");
        },
      });

      await agentMcpServer.connect(transport);
      return transport;
    };

    const runAgentMcpRequest = async (
      req: express.Request,
      res: express.Response,
    ): Promise<void> => {
      if (config.mcpDebug) {
        logger.debug(
          {
            method: req.method,
            url: req.originalUrl,
            sessionId: req.header("mcp-session-id"),
            authorization: req.header("authorization"),
            body: req.body,
          },
          "Agent MCP request",
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
          let callerAgentId: string | undefined;
          if (typeof callerAgentIdRaw === "string") {
            callerAgentId = callerAgentIdRaw;
          } else if (Array.isArray(callerAgentIdRaw) && typeof callerAgentIdRaw[0] === "string") {
            callerAgentId = callerAgentIdRaw[0];
          }
          transport = await createAgentMcpTransport(callerAgentId);
        }

        await transport.handleRequest(
          req as unknown as IncomingMessage,
          res as unknown as ServerResponse,
          req.body,
        );
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

    const handleAgentMcpRequest: express.RequestHandler = (req, res) => {
      void runAgentMcpRequest(req, res);
    };

    app.post(agentMcpRoute, handleAgentMcpRequest);
    app.get(agentMcpRoute, handleAgentMcpRequest);
    app.delete(agentMcpRoute, handleAgentMcpRequest);
    logger.info({ route: agentMcpRoute }, "Agent MCP server mounted on main app");
  } else {
    logger.info("Agent MCP HTTP endpoint disabled");
  }

  const speechService = createSpeechService({
    logger,
    openaiConfig: config.openai,
    speechConfig: config.speech,
  });
  logger.info({ elapsed: elapsed() }, "Speech service created");

  logger.info({ elapsed: elapsed() }, "Bootstrap complete, ready to start listening");

  const start = async () => {
    // Start main HTTP server
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        httpServer.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        httpServer.off("error", onError);
        const logAndResolve = async () => {
          boundListenTarget = resolveBoundListenTarget(listenTarget, httpServer);
          const mcpBaseUrl = mcpEnabled ? createAgentMcpBaseUrl(boundListenTarget) : null;
          agentMcpBaseUrl = config.mcpInjectIntoAgents === false ? null : mcpBaseUrl;
          agentManager.setMcpBaseUrl(agentMcpBaseUrl);
          daemonConfigStore.onFieldChange("mcp.injectIntoAgents", (value) => {
            agentManager.setMcpBaseUrl(value ? mcpBaseUrl : null);
          });
          const relayEnabled = config.relayEnabled ?? true;
          const relayEndpoint = config.relayEndpoint ?? "relay.paseo.sh:443";
          const relayPublicEndpoint = config.relayPublicEndpoint ?? relayEndpoint;
          const appBaseUrl = config.appBaseUrl ?? "https://app.paseo.sh";

          if (boundListenTarget.type === "tcp") {
            logger.info(
              {
                host: boundListenTarget.host,
                port: boundListenTarget.port,
                elapsed: elapsed(),
              },
              `Server listening on http://${boundListenTarget.host}:${boundListenTarget.port}`,
            );
          } else {
            logger.info(
              { path: boundListenTarget.path, elapsed: elapsed() },
              `Server listening on ${boundListenTarget.path}`,
            );
          }

          wsServer = new VoiceAssistantWebSocketServer(
            httpServer,
            logger,
            serverId,
            agentManager,
            agentStorage,
            downloadTokenStore,
            config.paseoHome,
            daemonConfigStore,
            mcpBaseUrl,
            { allowedOrigins, hostnames: configuredHostnames },
            speechService,
            terminalManager,
            {
              finalTimeoutMs: config.dictationFinalTimeoutMs,
            },
            config.agentProviderSettings,
            config.providerOverrides,
            config.isDev === true,
            daemonVersion,
            (intent) => {
              try {
                config.onLifecycleIntent?.(intent);
              } catch (error) {
                logger.error({ err: error, intent }, "Failed to handle daemon lifecycle intent");
              }
            },
            projectRegistry,
            workspaceRegistry,
            chatService,
            loopService,
            scheduleService,
            checkoutDiffManager,
            scriptRouteStore,
            scriptRuntimeStore,
            handleBranchChange,
            () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
            () => (boundListenTarget?.type === "tcp" ? boundListenTarget.host : null),
            (hostname) => scriptHealthMonitor.getHealthForHostname(hostname),
            workspaceGitService,
            github,
          );

          if (typeof process.send === "function" && process.env.PASEO_SUPERVISED === "1") {
            process.send({
              type: "paseo:ready",
              listen:
                boundListenTarget.type === "tcp"
                  ? `${boundListenTarget.host}:${boundListenTarget.port}`
                  : boundListenTarget.path,
            });
          }

          if (relayEnabled) {
            const offer = await createConnectionOfferV2({
              serverId,
              daemonPublicKeyB64: daemonKeyPair.publicKeyB64,
              relay: { endpoint: relayPublicEndpoint },
            });

            encodeOfferToFragmentUrl({ offer, appBaseUrl });

            relayTransport?.stop().catch(() => undefined);
            relayTransport = startRelayTransport({
              logger,
              attachSocket: (ws, metadata) => {
                if (!wsServer) {
                  throw new Error("WebSocket server not initialized");
                }
                return wsServer.attachExternalSocket(ws, metadata);
              },
              relayEndpoint,
              serverId,
              daemonKeyPair: daemonKeyPair.keyPair,
            });
          }
        };

        logAndResolve().then(resolve, reject);
      };
      httpServer.once("error", onError);
      httpServer.once("listening", onListening);

      if (listenTarget.type === "tcp") {
        httpServer.listen(listenTarget.port, listenTarget.host);
      } else {
        if (listenTarget.type === "socket" && existsSync(listenTarget.path)) {
          unlinkSync(listenTarget.path);
        }
        httpServer.listen(listenTarget.path);
      }
    });

    // Start speech service after listening so synchronous Sherpa native
    // model loading doesn't block the server from accepting connections.
    speechService.start();
    scriptHealthMonitor.start();
  };

  const stop = async () => {
    scriptHealthMonitor.stop();
    await closeAllAgents(logger, agentManager);
    await agentManager.flush().catch(() => undefined);
    detachAgentStoragePersistence();
    await agentStorage.flush().catch(() => undefined);
    await shutdownProviders(logger, {
      runtimeSettings: config.agentProviderSettings,
      providerOverrides: config.providerOverrides,
    });
    terminalManager.killAll();
    speechService.stop();
    await scheduleService.stop().catch(() => undefined);
    await relayTransport?.stop().catch(() => undefined);
    if (wsServer) {
      await wsServer.close();
    }
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    // Clean up socket files
    if (listenTarget.type === "socket" && existsSync(listenTarget.path)) {
      unlinkSync(listenTarget.path);
    }
  };

  return {
    config,
    agentManager,
    agentStorage,
    terminalManager,
    scriptRouteStore,
    scriptRuntimeStore,
    start,
    stop,
    getListenTarget: () => boundListenTarget,
  };
}

async function closeAllAgents(logger: Logger, agentManager: AgentManager): Promise<void> {
  const agents = agentManager.listAgents();
  await Promise.all(
    agents.map(async (agent) => {
      try {
        await agentManager.closeAgent(agent.id);
      } catch (err) {
        logger.error({ err, agentId: agent.id }, "Failed to close agent");
      }
    }),
  );
}
