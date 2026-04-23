import express from "express";
import { createServer as createHTTPServer } from "http";
import { createReadStream, unlinkSync, existsSync } from "fs";
import { stat } from "fs/promises";
import { randomUUID } from "node:crypto";
import { hostname as getHostname } from "node:os";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "pino";

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
import { DownloadTokenStore } from "./file-download/token-store.js";
import type { OpenAiSpeechProviderConfig } from "./speech/providers/openai/config.js";
import type { LocalSpeechProviderConfig } from "./speech/providers/local/config.js";
import type { RequestedSpeechProviders } from "./speech/speech-types.js";
import { createSpeechService } from "./speech/speech-runtime.js";
import { AgentManager } from "./agent/agent-manager.js";
import { AgentStorage } from "./agent/agent-storage.js";
import { attachAgentStoragePersistence } from "./persistence-hooks.js";
import { createAgentMcpServer } from "./agent/mcp-server.js";
import { PlaywrightBrowserManager } from "./browser/playwright-browser-manager.js";
import {
  buildProviderRegistry,
  createAllClients,
  shutdownProviders,
} from "./agent/provider-registry.js";
import { bootstrapWorkspaceRegistries } from "./workspace-registry-bootstrap.js";
import { FileBackedProjectRegistry, FileBackedWorkspaceRegistry } from "./workspace-registry.js";
import { FileBackedChatService } from "./chat/chat-service.js";
import { CheckoutDiffManager } from "./checkout-diff-manager.js";
import { LoopService } from "./loop-service.js";
import { ScheduleService } from "./schedule/service.js";
import { IndexingService } from "./indexing/service.js";
import { createWorkspaceIndexingAdapter } from "./indexing/workspace-adapter.js";
import { createHubcodeLocalInference } from "./indexing/hubcode-local-inference.js";
import { CrgProcessManager } from "./indexing/process-manager.js";
import { CrgMcpClient } from "./indexing/mcp-client.js";
import { IndexingRuntime } from "./indexing/runtime.js";
import { detectIndexingTools } from "./indexing/detector.js";
import { WorkspaceFsWatcherRegistry } from "./indexing/fs-watcher.js";
import { computeCrgIndexBytes } from "./indexing/index-size.js";
import type { IndexingState } from "./indexing/types.js";
import type { WorkspaceRegistry } from "./workspace-registry.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

async function resolveIndexingStateForCwd(
  registry: WorkspaceRegistry,
  indexingService: IndexingService,
  cwd: string,
): Promise<IndexingState | null> {
  const normalized = path.resolve(cwd);
  const workspaces = await registry.list();
  const match =
    workspaces.find((ws) => path.resolve(ws.cwd) === normalized) ??
    workspaces.find((ws) => normalized.startsWith(`${path.resolve(ws.cwd)}${path.sep}`));
  if (!match) return null;
  return indexingService.getState(match.workspaceId);
}
import { DaemonConfigStore } from "./daemon-config-store.js";
import { createTerminalManager, type TerminalManager } from "../terminal/terminal-manager.js";
import { BrowserManager } from "./browser/browser-manager.js";
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
import type { CliProviderOverrides } from "../shared/cli-provider-registry.js";
import { isHostAllowed, type AllowedHostsConfig } from "./allowed-hosts.js";

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

export type HubcodeOpenAIConfig = OpenAiSpeechProviderConfig;
export type HubcodeLocalSpeechConfig = LocalSpeechProviderConfig;

export type HubcodeSpeechConfig = {
  providers: RequestedSpeechProviders;
  local?: HubcodeLocalSpeechConfig;
};

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

export type HubcodeDaemonConfig = {
  listen: string;
  hubcodeHome: string;
  corsAllowedOrigins: string[];
  allowedHosts?: AllowedHostsConfig;
  mcpEnabled?: boolean;
  mcpInjectIntoAgents?: boolean;
  staticDir: string;
  mcpDebug: boolean;
  agentClients: Partial<Record<AgentProvider, AgentClient>>;
  agentStoragePath: string;
  relayEnabled?: boolean;
  relayEndpoint?: string;
  relayPublicEndpoint?: string;
  appBaseUrl?: string;
  openai?: HubcodeOpenAIConfig;
  speech?: HubcodeSpeechConfig;
  voiceLlmProvider?: AgentProvider | null;
  voiceLlmProviderExplicit?: boolean;
  voiceLlmModel?: string | null;
  dictationFinalTimeoutMs?: number;
  downloadTokenTtlMs?: number;
  agentProviderSettings?: AgentProviderRuntimeSettingsMap;
  providerOverrides?: Record<string, ProviderOverride>;
  cliProviderOverrides?: CliProviderOverrides;
  onLifecycleIntent?: (intent: DaemonLifecycleIntent) => void;
};

export interface HubcodeDaemon {
  config: HubcodeDaemonConfig;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  terminalManager: TerminalManager;
  start(): Promise<void>;
  stop(): Promise<void>;
  getListenTarget(): ListenTarget | null;
}

export async function createHubcodeDaemon(
  config: HubcodeDaemonConfig,
  rootLogger: Logger,
): Promise<HubcodeDaemon> {
  const logger = rootLogger.child({ module: "bootstrap" });
  const bootstrapStart = performance.now();
  const elapsed = () => `${(performance.now() - bootstrapStart).toFixed(0)}ms`;
  const daemonVersion = resolveDaemonVersion(import.meta.url);
  const daemonConfigStore = new DaemonConfigStore(
    config.hubcodeHome,
    {
      mcp: { injectIntoAgents: config.mcpInjectIntoAgents ?? true },
      agents: config.cliProviderOverrides
        ? { cliProviders: config.cliProviderOverrides }
        : undefined,
    },
    logger,
  );

  try {
    const serverId = getOrCreateServerId(config.hubcodeHome, { logger });
    const daemonKeyPair = await loadOrCreateDaemonKeyPair(config.hubcodeHome, logger);
    let relayTransport: RelayTransportController | null = null;

    const staticDir = config.staticDir;
    const downloadTokenTtlMs = config.downloadTokenTtlMs ?? 60000;

    const downloadTokenStore = new DownloadTokenStore({ ttlMs: downloadTokenTtlMs });

    const listenTarget = parseListenString(config.listen);

    const app = express();
    let boundListenTarget: ListenTarget | null = null;

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
      // Packaged desktop renderers use the custom hubcode:// protocol scheme.
      "hubcode://app",
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
    });

    const httpServer = createHTTPServer(app);

    const agentStorage = new AgentStorage(config.agentStoragePath, logger);
    const projectRegistry = new FileBackedProjectRegistry(
      path.join(config.hubcodeHome, "projects", "projects.json"),
      logger,
    );
    const workspaceRegistry = new FileBackedWorkspaceRegistry(
      path.join(config.hubcodeHome, "projects", "workspaces.json"),
      logger,
    );
    const chatService = new FileBackedChatService({
      hubcodeHome: config.hubcodeHome,
      logger,
    });
    const agentManager = new AgentManager({
      clients: {
        ...createAllClients(logger, {
          runtimeSettings: config.agentProviderSettings,
          providerOverrides: config.providerOverrides,
        }),
        ...config.agentClients,
      },
      registry: agentStorage,
      logger,
    });
    const providerRegistry = buildProviderRegistry(logger, {
      runtimeSettings: config.agentProviderSettings,
      providerOverrides: config.providerOverrides,
    });

    const terminalManager = createTerminalManager();
    const browserManager = new BrowserManager({ logger });
    // `clientBrowserManager` drives the desktop app's <webview> via
    // Playwright connected to Electron's CDP endpoint (exposed by the
    // desktop's `--remote-debugging-port` switch). Tools like click /
    // fill / screenshot / evaluate go through Playwright's Page API,
    // which handles load races and screenshots natively — previously
    // we hand-rolled this over a WS IPC and hit lots of timing bugs.
    const clientBrowserManager = new PlaywrightBrowserManager({ logger });

    const detachAgentStoragePersistence = attachAgentStoragePersistence(
      logger,
      agentManager,
      agentStorage,
    );
    await agentStorage.initialize();
    logger.info({ elapsed: elapsed() }, "Agent storage initialized");
    await bootstrapWorkspaceRegistries({
      hubcodeHome: config.hubcodeHome,
      agentStorage,
      projectRegistry,
      workspaceRegistry,
      logger,
    });
    logger.info({ elapsed: elapsed() }, "Workspace registries bootstrapped");
    await chatService.initialize();
    logger.info({ elapsed: elapsed() }, "Chat service initialized");
    const checkoutDiffManager = new CheckoutDiffManager({
      logger,
      hubcodeHome: config.hubcodeHome,
    });
    const loopService = new LoopService({
      hubcodeHome: config.hubcodeHome,
      logger,
      agentManager,
    });
    await loopService.initialize();
    logger.info({ elapsed: elapsed() }, "Loop service initialized");
    const scheduleService = new ScheduleService({
      hubcodeHome: config.hubcodeHome,
      logger,
      agentManager,
      agentStorage,
    });
    await scheduleService.start();
    logger.info({ elapsed: elapsed() }, "Schedule service initialized");
    const indexingService = new IndexingService({
      adapter: createWorkspaceIndexingAdapter(workspaceRegistry),
      logger,
      hubcodeLocalInfer: createHubcodeLocalInference({ logger }),
    });
    const indexingDetection = await detectIndexingTools().catch((err) => {
      logger.warn({ err }, "Indexing tool detection failed; subprocess will not start");
      return null;
    });
    const crgProcess = new CrgProcessManager({
      logger,
      binPath: indexingDetection?.codeReviewGraph.path ?? null,
      envOverlay: () => indexingService.getCachedEmbeddingEnv(),
    });
    indexingService.attachProcessManager(crgProcess);
    const crgMcpClient = new CrgMcpClient({ logger });
    indexingService.attachMcpClient(crgMcpClient);
    const indexingRuntime = new IndexingRuntime({
      logger,
      processManager: crgProcess,
      mcpClient: crgMcpClient,
    });
    // Prime the embedding env cache from persisted workspaces before the
    // subprocess spawns, so the first start gets the right env.
    await indexingService.syncEmbeddingEnv().catch((err) => {
      logger.warn({ err }, "Initial syncEmbeddingEnv failed");
    });

    // fs watcher registry — one watcher per indexing-enabled workspace.
    // On a debounced change, ask crg to update its graph via MCP.
    const fsWatchers = new WorkspaceFsWatcherRegistry({ logger });
    const triggerReindex = async (
      workspaceId: string,
      cwd: string,
    ): Promise<{ ok: boolean; error?: string; fileCount?: number; nodeCount?: number }> => {
      if (!crgMcpClient.isConnected()) {
        return { ok: false, error: "code-review-graph subprocess is not connected" };
      }
      // crg doesn't stream progress, so we emit a calibrated asymptotic
      // estimate. Rises 0 → ~85% smoothly, snaps to 100% on success (via
      // phase=ready) or stops on error. Time constant τ is sourced from the
      // previous run's fileCount (≈ 40ms per file, 5s floor / 120s cap), so
      // large repos ramp slower. It's a wishful progress bar, not truth.
      const prior = await workspaceRegistry.get(workspaceId).catch(() => null);
      const priorFileCount = prior?.indexing?.status?.fileCount ?? 0;
      const tauMs = Math.max(5_000, Math.min(120_000, priorFileCount * 40));
      const startedAt = Date.now();
      let progressTimer: NodeJS.Timeout | null = null;
      const tickProgress = () => {
        const elapsed = Date.now() - startedAt;
        const estimated = 85 * (1 - Math.exp(-elapsed / tauMs));
        void indexingService
          .setStatus(workspaceId, { phase: "indexing", progress: estimated })
          .catch(() => undefined);
      };
      try {
        await indexingService.setStatus(workspaceId, { phase: "indexing", progress: 0 });
        // 1s cadence — each tick persists through setStatus, and more frequent
        // writes aren't justified by visible UI smoothness for a wishful bar.
        progressTimer = setInterval(tickProgress, 1000);
        const result = (await crgMcpClient.callTool("crg_build_or_update_graph", {
          repo_path: cwd,
        })) as { content?: Array<{ text?: string }> } | null | undefined;
        // Parse counts from the tool result text when present (best-effort).
        const text = result?.content?.[0]?.text ?? "";
        const fileMatch = text.match(/(\d+)\s+files?\b/i);
        const nodeMatch = text.match(/(\d+)\s+nodes?\b/i);
        const fileCount = fileMatch?.[1] ? Number.parseInt(fileMatch[1], 10) : undefined;
        const nodeCount = nodeMatch?.[1] ? Number.parseInt(nodeMatch[1], 10) : undefined;
        if (progressTimer) clearInterval(progressTimer);
        progressTimer = null;
        // Compute on-disk size of the crg index for this workspace. Best-effort
        // — undefined on any fs error so the UI falls back to "—" instead of 0.
        const indexBytes = await computeCrgIndexBytes(cwd);
        await indexingService.setStatus(workspaceId, {
          phase: "ready",
          lastIndexedAt: new Date().toISOString(),
          ...(fileCount != null ? { fileCount } : {}),
          ...(nodeCount != null ? { nodeCount } : {}),
          ...(indexBytes != null ? { indexBytes } : {}),
        });
        return { ok: true, fileCount, nodeCount };
      } catch (err) {
        if (progressTimer) clearInterval(progressTimer);
        progressTimer = null;
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ err, workspaceId }, "Reindex failed");
        await indexingService
          .setStatus(workspaceId, { phase: "error", error: message })
          .catch(() => undefined);
        return { ok: false, error: message };
      }
    };
    // Service-level trigger (UI Re-index button + on-enable auto). Looks up
    // the cwd from the registry so callers don't have to.
    indexingService.setReindexTrigger(async (workspaceId: string) => {
      const ws = await workspaceRegistry.get(workspaceId);
      if (!ws) return { ok: false, error: `Unknown workspace: ${workspaceId}` };
      return triggerReindex(workspaceId, ws.cwd);
    });
    const reconcileWatchers = async () => {
      const records = await workspaceRegistry.list();
      const seen = new Set<string>();
      for (const ws of records) {
        if (!ws.indexing?.enabled) continue;
        seen.add(ws.workspaceId);
        if (fsWatchers.has(ws.workspaceId)) continue;
        fsWatchers.set(
          ws.workspaceId,
          ws.cwd,
          (info) => {
            // Push the change event to the app before kicking off the reindex
            // so the UI can show "triggered by N files" even for fast runs.
            indexingService.emitFsTrigger({
              kind: "change",
              workspaceId: info.workspaceId,
              changedPaths: info.changedPaths ?? [],
            });
            void indexingService
              .setStatus(info.workspaceId, { phase: "indexing" })
              .then(() => triggerReindex(info.workspaceId, ws.cwd))
              .catch((err) => logger.warn({ err }, "fs-watcher reindex trigger failed"));
          },
          ws.indexing?.watchlist,
          (workspaceId, err) => {
            indexingService.emitFsTrigger({
              kind: "error",
              workspaceId,
              error: err.message,
            });
          },
        );
      }
      // Drop watchers for workspaces that are no longer enabled.
      for (const active of fsWatchers.activeWorkspaceIds()) {
        if (!seen.has(active)) fsWatchers.clear(active);
      }
    };
    indexingService.onStatus(() => {
      void reconcileWatchers().catch((err) => logger.warn({ err }, "reconcileWatchers failed"));
    });
    await reconcileWatchers().catch((err) =>
      logger.warn({ err }, "Initial reconcileWatchers failed"),
    );
    // Once the crg client connects, auto-trigger initial reindex for any
    // enabled workspace that has never been indexed (or is stale). Runs
    // sequentially so we don't slam crg with parallel build calls.
    const runInitialReindex = async () => {
      if (!crgMcpClient.isConnected()) return;
      const records = await workspaceRegistry.list().catch(() => []);
      for (const ws of records) {
        if (!ws.indexing?.enabled) continue;
        if (ws.indexing.status?.lastIndexedAt) continue;
        if (ws.archivedAt !== null) continue;
        await triggerReindex(ws.workspaceId, ws.cwd).catch(() => undefined);
      }
    };
    crgMcpClient.onConnectionState((s) => {
      if (s.phase !== "connected") return;
      void runInitialReindex();
    });

    // tools/list_changed broadcast — active agent MCP servers get notified
    // whenever the user toggles exposure so connected CLIs refresh.
    const activeMcpServers = new Set<McpServer>();
    indexingService.onToolsChanged((event) => {
      for (const server of activeMcpServers) {
        try {
          server.sendToolListChanged();
        } catch (err) {
          logger.debug({ err, event }, "sendToolListChanged on an MCP server threw");
        }
      }
    });
    if (indexingDetection?.codeReviewGraph.installed) {
      crgProcess.start();
      logger.info(
        { binPath: indexingDetection.codeReviewGraph.path },
        "code-review-graph subprocess started",
      );
    } else {
      logger.info("code-review-graph not installed; subprocess deferred until install completes");
    }
    logger.info({ elapsed: elapsed() }, "Indexing service initialized");
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
    let wsServer: VoiceAssistantWebSocketServer | null = null;

    const mcpEnabled = config.mcpEnabled ?? true;
    let agentMcpBaseUrl: string | null = null;
    if (mcpEnabled) {
      const agentMcpRoute = "/mcp/agents";
      const agentMcpTransports: AgentMcpTransportMap = new Map();

      const createAgentMcpTransport = async (callerAgentId?: string) => {
        const agentMcpServer = await createAgentMcpServer({
          agentManager,
          agentStorage,
          terminalManager,
          scheduleService,
          providerRegistry,
          hubcodeHome: config.hubcodeHome,
          callerAgentId,
          enableVoiceTools: false,
          browserManager: clientBrowserManager,
          resolveSpeakHandler: (agentId) => wsServer?.resolveVoiceSpeakHandler(agentId) ?? null,
          resolveCallerContext: (agentId) => wsServer?.resolveVoiceCallerContext(agentId) ?? null,
          indexingBridge: {
            mcpClient: crgMcpClient,
            resolveAgentId: (id) => {
              if (!id) return null;
              const agent = agentManager.getAgent(id);
              if (!agent) return null;
              return agent.provider ?? null;
            },
            resolveState: async (id) => {
              if (!id) return null;
              const agent = agentManager.getAgent(id);
              if (!agent?.cwd) return null;
              return resolveIndexingStateForCwd(workspaceRegistry, indexingService, agent.cwd);
            },
          },
          logger,
        });

        // Track for tools/list_changed broadcasts. Cleared on session close.
        activeMcpServers.add(agentMcpServer);

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
          activeMcpServers.delete(agentMcpServer);
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
            const relayEndpoint = config.relayEndpoint ?? "relay.hubcode.ai:443";
            const relayPublicEndpoint = config.relayPublicEndpoint ?? relayEndpoint;
            const appBaseUrl = config.appBaseUrl ?? "https://app.hubcode.ai";

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
              config.hubcodeHome,
              daemonConfigStore,
              mcpBaseUrl,
              { allowedOrigins, allowedHosts: config.allowedHosts },
              speechService,
              terminalManager,
              {
                finalTimeoutMs: config.dictationFinalTimeoutMs,
              },
              config.agentProviderSettings,
              config.providerOverrides,
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
              browserManager,
              clientBrowserManager,
              indexingService,
            );

            if (typeof process.send === "function" && process.env.HUBCODE_SUPERVISED === "1") {
              process.send({
                type: "hubcode:ready",
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

              const url = encodeOfferToFragmentUrl({ offer, appBaseUrl });
              logger.info({ url }, "pairing_offer");

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
    };

    const stop = async () => {
      await closeAllAgents(logger, agentManager);
      await agentManager.flush().catch(() => undefined);
      detachAgentStoragePersistence();
      await agentStorage.flush().catch(() => undefined);
      await shutdownProviders(logger, {
        runtimeSettings: config.agentProviderSettings,
        providerOverrides: config.providerOverrides,
      });
      terminalManager.killAll();
      await browserManager.dispose();
      speechService.stop();
      await scheduleService.stop().catch(() => undefined);
      try {
        fsWatchers.closeAll();
        indexingRuntime.dispose();
        await crgMcpClient.disconnect();
        crgProcess.stop();
        await indexingService.disposeEmbeddingServer();
      } catch (err) {
        logger.warn({ err }, "Failed to stop crg subprocess during shutdown");
      }
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
      start,
      stop,
      getListenTarget: () => boundListenTarget,
    };
  } catch (err) {
    throw err;
  }
}

async function closeAllAgents(logger: Logger, agentManager: AgentManager): Promise<void> {
  const agents = agentManager.listAgents();
  for (const agent of agents) {
    try {
      await agentManager.closeAgent(agent.id);
    } catch (err) {
      logger.error({ err, agentId: agent.id }, "Failed to close agent");
    }
  }
}
