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

import { WebSocketServer } from "./websocket-server.js";
import { DownloadTokenStore } from "./file-download/token-store.js";
import { AgentManager } from "./agent/agent-manager.js";
import { AgentStorage } from "./agent/agent-storage.js";
import { attachAgentStoragePersistence } from "./persistence-hooks.js";
import { createAgentMcpServer } from "./agent/mcp-server.js";
import { createAllClients, shutdownProviders } from "./agent/provider-registry.js";
import { createTerminalManager, type TerminalManager } from "../terminal/terminal-manager.js";
import {
  createConnectionOfferV2,
  encodeOfferToFragmentUrl,
} from "./connection-offer.js";
import { loadOrCreateDaemonKeyPair } from "./daemon-keypair.js";
import { startRelayTransport, type RelayTransportController } from "./relay-transport.js";
import { getOrCreateServerId } from "./server-id.js";
import { resolveDaemonVersion } from "./daemon-version.js";
import type {
  AgentClient,
  AgentProvider,
} from "./agent/agent-sdk-types.js";
import type { AgentProviderRuntimeSettingsMap } from "./agent/provider-launch-config.js";
import { acquirePidLock, releasePidLock } from "./pid-lock.js";
import { isHostAllowed, type AllowedHostsConfig } from "./allowed-hosts.js";
type AgentMcpTransportMap = Map<string, StreamableHTTPServerTransport>;

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

export type JunctionDaemonConfig = {
  listen: string;
  junctionHome: string;
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
  downloadTokenTtlMs?: number;
  agentProviderSettings?: AgentProviderRuntimeSettingsMap;
  onLifecycleIntent?: (intent: DaemonLifecycleIntent) => void;
  pidLock?: {
    mode?: "self" | "external";
    ownerPid?: number;
  };
};

export interface JunctionDaemon {
  config: JunctionDaemonConfig;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  terminalManager: TerminalManager;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function createJunctionDaemon(
  config: JunctionDaemonConfig,
  rootLogger: Logger
): Promise<JunctionDaemon> {
  const logger = rootLogger.child({ module: "bootstrap" });
  const daemonVersion = resolveDaemonVersion(import.meta.url);
  const pidLockMode = config.pidLock?.mode ?? "self";
  const pidLockOwnerPid = config.pidLock?.ownerPid;
  const ownsPidLock = pidLockMode === "self";

  // Acquire PID lock before expensive bootstrap work so duplicate starts fail immediately.
  if (ownsPidLock) {
    await acquirePidLock(config.junctionHome, config.listen, {
      ownerPid: pidLockOwnerPid,
    });
  }

  try {
    const serverId = getOrCreateServerId(config.junctionHome, { logger });
    const daemonKeyPair = await loadOrCreateDaemonKeyPair(config.junctionHome, logger);
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
    // For TCP, add localhost variants (daemon port + common dev server ports)
    ...(listenTarget.type === "tcp"
      ? [
          `http://${listenTarget.host}:${listenTarget.port}`,
          `http://localhost:${listenTarget.port}`,
          `http://127.0.0.1:${listenTarget.port}`,
          // Vite dev server (may use fallback ports when 5173 is occupied)
          ...Array.from({ length: 11 }, (_, i) => `http://localhost:${5173 + i}`),
          ...Array.from({ length: 11 }, (_, i) => `http://127.0.0.1:${5173 + i}`),
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
      ...createAllClients(logger, {
        runtimeSettings: config.agentProviderSettings,
      }),
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
  let wsServer: WebSocketServer | null = null;

  // Create in-memory transport for Session's Agent MCP client
  const createInMemoryAgentMcpTransport = async (): Promise<InMemoryTransport> => {
    const agentMcpServer = await createAgentMcpServer({
      agentManager,
      agentStorage,
      terminalManager,
      junctionHome: config.junctionHome,
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
        terminalManager,
        junctionHome: config.junctionHome,
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

  wsServer = new WebSocketServer(
    httpServer,
    logger,
    serverId,
    agentManager,
    agentStorage,
    downloadTokenStore,
    config.junctionHome,
    createInMemoryAgentMcpTransport,
    { allowedOrigins, allowedHosts: config.allowedHosts },
    terminalManager,
    config.agentProviderSettings,
    daemonVersion,
    (intent) => {
      try {
        config.onLifecycleIntent?.(intent);
      } catch (error) {
        logger.error({ err: error, intent }, "Failed to handle daemon lifecycle intent");
      }
    }
  );

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
          if (listenTarget.type === "tcp") {
            logger.info(
              { host: listenTarget.host, port: listenTarget.port },
              `Server listening on http://${listenTarget.host}:${listenTarget.port}`
            );

            const relayEnabled = config.relayEnabled ?? true;
            const relayEndpoint = config.relayEndpoint ?? "relay.junction.sh:443";
            const relayPublicEndpoint = config.relayPublicEndpoint ?? relayEndpoint;
            const appBaseUrl = config.appBaseUrl ?? "https://app.junction.sh";

            if (relayEnabled) {
              const offer = await createConnectionOfferV2({
                serverId,
                daemonPublicKeyB64: daemonKeyPair.publicKeyB64,
                relay: { endpoint: relayPublicEndpoint },
              });

              const url = encodeOfferToFragmentUrl({ offer, appBaseUrl });
              logger.info({ url }, "pairing_offer");
            }

            if (relayEnabled) {
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
      await shutdownProviders(logger, {
        runtimeSettings: config.agentProviderSettings,
      });
      terminalManager.killAll();
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
      // Release PID lock
      if (ownsPidLock) {
        await releasePidLock(config.junctionHome, config.listen, {
          ownerPid: pidLockOwnerPid,
        });
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
  } catch (err) {
    if (ownsPidLock) {
      await releasePidLock(config.junctionHome, config.listen, {
        ownerPid: pidLockOwnerPid,
      }).catch(() => undefined);
    }
    throw err;
  }
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
