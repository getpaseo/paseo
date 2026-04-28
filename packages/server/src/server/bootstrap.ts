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
import { HookService } from "./hooks/service.js";
import { CommandService } from "./commands/service.js";
import { RuleService } from "./rules/service.js";
import { listCliProviders } from "../shared/cli-provider-registry.js";
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
    // GUI MCP registry — library entries flagged with the "hubcode-gui"
    // sync target get replayed into every new Claude SDK session. Populated
    // by the app via `library/mcp/gui-sync` RPC.
    const { GuiMcpRegistry } = await import("./library/gui-mcp-registry.js");
    const guiMcpRegistry = new GuiMcpRegistry({ logger });

    // Hook service must exist before any provider/client construction so
    // Claude-based clients (used by AgentManager AND the provider registry)
    // capture a reference for in-process PostToolUse execution.
    const hookService = new HookService({ logger, hubcodeHome: config.hubcodeHome });
    await hookService
      .init()
      .catch((err) => logger.warn({ err }, "Hook service init failed; hooks will be inactive"));
    logger.info({ elapsed: elapsed() }, "Hook service initialized");

    const commandService = new CommandService({
      logger,
      hubcodeHome: config.hubcodeHome,
      resolveActiveAgents: async () => {
        // Built-in GUI target is always on; CLI providers follow daemon config.
        const active = new Set<string>(["hubcode-gui"]);
        try {
          const overrides = config.cliProviderOverrides;
          const providers = listCliProviders({ overrides });
          for (const p of providers) active.add(p.id);
        } catch (err) {
          logger.debug({ err }, "Failed to enumerate active CLI providers");
        }
        return active;
      },
    });
    await commandService
      .init()
      .catch((err) =>
        logger.warn({ err }, "Command service init failed; commands will be inactive"),
      );
    logger.info({ elapsed: elapsed() }, "Command service initialized");

    const ruleService = new RuleService({
      logger,
      hubcodeHome: config.hubcodeHome,
      resolveActiveAgents: async () => {
        const active = new Set<string>(["hubcode-gui"]);
        try {
          const overrides = config.cliProviderOverrides;
          const providers = listCliProviders({ overrides });
          for (const p of providers) active.add(p.id);
        } catch (err) {
          logger.debug({ err }, "Failed to enumerate active CLI providers for rules");
        }
        return active;
      },
    });
    await ruleService
      .init()
      .catch((err) => logger.warn({ err }, "Rule service init failed; rules will be inactive"));
    logger.info({ elapsed: elapsed() }, "Rule service initialized");

    const agentManager = new AgentManager({
      clients: {
        ...createAllClients(logger, {
          runtimeSettings: config.agentProviderSettings,
          providerOverrides: config.providerOverrides,
          hookService,
          guiMcpRegistry,
        }),
        ...config.agentClients,
      },
      registry: agentStorage,
      logger,
    });

    const providerRegistry = buildProviderRegistry(logger, {
      runtimeSettings: config.agentProviderSettings,
      providerOverrides: config.providerOverrides,
      hookService,
      guiMcpRegistry,
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

    // Recover orphan workspaces stuck in phase=indexing. If the daemon
    // crashed mid-reindex (e.g. the crg subprocess OOM-killed by the
    // kernel), the persisted state still says "indexing" and the UI shows
    // a frozen ~85% spinner forever. Reset those to error on startup so
    // the user gets a clear "interrupted" message and can retry.
    try {
      const persisted = await workspaceRegistry.list();
      for (const record of persisted) {
        if (record.indexing?.status?.phase === "indexing") {
          await indexingService
            .setStatus(record.workspaceId, {
              phase: "error",
              error:
                "Indexing was interrupted (the daemon may have crashed, often from running out of memory). Try again, and consider indexing a smaller scope if it keeps failing.",
            })
            .catch((err) => {
              logger.debug(
                { err, workspaceId: record.workspaceId },
                "Failed to reset orphan indexing status",
              );
            });
          logger.warn(
            { workspaceId: record.workspaceId },
            "Reset orphan indexing status (was stuck in phase=indexing from previous daemon)",
          );
        }
      }
    } catch (err) {
      logger.warn({ err }, "Orphan indexing recovery failed");
    }

    // fs watcher registry — one watcher per indexing-enabled workspace.
    // On a debounced change, ask crg to update its graph via MCP.
    const fsWatchers = new WorkspaceFsWatcherRegistry({ logger });

    // Hard cap for a single reindex. If crg doesn't return within this window
    // we assume it's wedged, abort (reject the Promise), and surface error.
    // Tunable via HUBCODE_CRG_REINDEX_TIMEOUT_MS; default 10 min, which covers
    // large monorepos on slow machines without letting the daemon freeze on a
    // deadlocked subprocess.
    const CRG_REINDEX_TIMEOUT_MS = Number.parseInt(
      process.env.HUBCODE_CRG_REINDEX_TIMEOUT_MS ?? "",
      10,
    );
    const reindexTimeoutMs =
      Number.isFinite(CRG_REINDEX_TIMEOUT_MS) && CRG_REINDEX_TIMEOUT_MS > 0
        ? CRG_REINDEX_TIMEOUT_MS
        : 10 * 60 * 1000;
    const reindexWarnAtMs = [60_000, 180_000, 300_000]; // 1, 3, 5 minutes

    // Hard ceiling on workspace size when using the in-process Hubcode Local
    // embedding model (`@xenova/transformers` BGE). The model and its
    // activations live in the daemon process — there's no isolation — so
    // large repos consistently OOM-kill the daemon during embed. Block the
    // reindex up front with a clear error instead of letting the daemon
    // crash mid-run. Repos this size should use a remote embedding provider
    // (OpenAI, Voyage, etc.).
    //
    // Resolution order (live-reads on every reindex so Settings tweaks take
    // effect without a daemon restart):
    //   1. user setting from DaemonConfigStore (set via Settings UI)
    //   2. HUBCODE_LOCAL_EMBED_MAX_FILES env var (dev/CI escape hatch)
    //   3. conservative default (1500) — survives most laptops with the
    //      stock 6GB Node heap
    const resolveLocalEmbedMaxFiles = (): number => {
      const userValue = daemonConfigStore.get().indexing?.localEmbedMaxFiles;
      if (typeof userValue === "number" && userValue > 0) return userValue;
      const env = Number.parseInt(process.env.HUBCODE_LOCAL_EMBED_MAX_FILES ?? "", 10);
      return Number.isFinite(env) && env > 0 ? env : 1500;
    };

    // Concurrency guard: one reindex per workspace at a time. Extra calls
    // while one is running are rejected fast — callers can retry after the
    // current one finishes, and fs-watcher re-triggers bounce harmlessly.
    // The AbortController maps so `cancelReindex` can abort a pending MCP
    // call (triggers a `notifications/cancelled` through the SDK).
    const reindexInFlight = new Map<string, AbortController>();

    const triggerReindex = async (
      workspaceId: string,
      cwd: string,
    ): Promise<{ ok: boolean; error?: string; fileCount?: number; nodeCount?: number }> => {
      const reindexLog = logger.child({ module: "reindex", workspaceId });
      if (!crgMcpClient.isConnected()) {
        reindexLog.warn("Reindex skipped — crg subprocess not connected");
        return { ok: false, error: "code-review-graph subprocess is not connected" };
      }
      if (reindexInFlight.has(workspaceId)) {
        reindexLog.info("Reindex skipped — another reindex is already in flight");
        return { ok: false, error: "Reindex already in progress for this workspace" };
      }

      // Block large repos from running through Hubcode Local before we ever
      // load the model. Local embedding can't survive batches this size and
      // takes the daemon down with it. Use the previous reindex's fileCount
      // as a size proxy. First-run repos pass (we don't know their size yet);
      // their second run will be blocked if they exceeded the limit.
      const prior = await workspaceRegistry.get(workspaceId).catch(() => null);
      const providerKind = prior?.indexing?.embeddingProvider?.kind;
      const priorFileCount = prior?.indexing?.status?.fileCount ?? 0;
      const localEmbedMaxFiles = resolveLocalEmbedMaxFiles();
      if (providerKind === "hubcode-local" && priorFileCount > localEmbedMaxFiles) {
        const message = `This workspace has ${priorFileCount} indexed files, which exceeds the Hubcode Local safety limit of ${localEmbedMaxFiles}. The local embedding model runs in the daemon process and cannot survive workspaces this large without crashing the daemon. Raise the limit in Settings → Indexing if your machine supports it, or switch to a remote embedding provider (OpenAI, Voyage, etc.).`;
        reindexLog.warn(
          { priorFileCount, limit: localEmbedMaxFiles },
          "Reindex blocked — workspace too large for Hubcode Local",
        );
        await indexingService
          .setStatus(workspaceId, { phase: "error", error: message })
          .catch((err) => reindexLog.debug({ err }, "setStatus(error) failed"));
        return { ok: false, error: message };
      }

      const abortController = new AbortController();
      reindexInFlight.set(workspaceId, abortController);

      // crg doesn't stream progress, so we emit a calibrated asymptotic
      // estimate. Rises 0 → ~85% smoothly, snaps to 100% on success (via
      // phase=ready) or stops on error. Time constant τ is sourced from the
      // previous run's fileCount (≈ 40ms per file, 5s floor / 120s cap), so
      // large repos ramp slower. It's a wishful progress bar, not truth.
      const tauMs = Math.max(5_000, Math.min(120_000, priorFileCount * 40));
      const startedAt = Date.now();
      let progressTimer: NodeJS.Timeout | null = null;
      const warnTimers: NodeJS.Timeout[] = [];
      const elapsed = () => Date.now() - startedAt;
      const tickProgress = () => {
        // Curve: 2% floor (so the bar is always visible) + 83% asymptote.
        // Even at elapsed≈0 the bar shows ~2% instead of 0, which matters
        // because fast reindexes may finish before the ticker nudges it up.
        const estimated = 2 + 83 * (1 - Math.exp(-elapsed() / tauMs));
        void indexingService
          .setStatus(workspaceId, { phase: "indexing", progress: estimated })
          .catch((err) => reindexLog.debug({ err }, "progress tick setStatus failed (non-fatal)"));
      };
      const cleanupTimers = () => {
        if (progressTimer) {
          clearInterval(progressTimer);
          progressTimer = null;
        }
        for (const t of warnTimers) clearTimeout(t);
        warnTimers.length = 0;
      };

      reindexLog.info(
        { cwd, priorFileCount, tauMs, timeoutMs: reindexTimeoutMs },
        "Reindex starting",
      );

      try {
        // Start at 2% (not 0) so fast reindexes still show visible activity.
        // Even if the MCP call finishes before the first tick, the bar has a
        // non-zero initial state.
        await indexingService.setStatus(workspaceId, { phase: "indexing", progress: 2 });
        // 300ms cadence — fast enough that small repos (indexing takes
        // <1s) get at least a few ticks, so the user sees a moving bar
        // instead of a stuck 0%. Each tick persists via setStatus (2–3 ms
        // fs write) + emits a WS event (few hundred bytes). Acceptable
        // overhead for the visibility win.
        progressTimer = setInterval(tickProgress, 300);
        // Fire first tick right away so there's a non-zero progress even
        // if the reindex finishes before the first setInterval firing.
        tickProgress();

        // Progressive "still running" warnings so we can see in logs whether
        // a reindex is just slow vs. wedged, without tailing every second.
        for (const at of reindexWarnAtMs) {
          warnTimers.push(
            setTimeout(() => {
              reindexLog.warn(
                { elapsedMs: elapsed(), connected: crgMcpClient.isConnected() },
                `Reindex still running after ${Math.round(at / 1000)}s`,
              );
            }, at),
          );
        }

        // Race the MCP call against a hard timeout. If crg hangs, reject so
        // the UI flips to error instead of showing an eternal spinner. The
        // AbortSignal also lets user-initiated cancel abort the MCP call
        // cleanly (sends `notifications/cancelled` on the wire).
        //
        // Arg name is `repo_root` in crg 2.3+ (was `repo_path` in older
        // builds). If you see a pydantic validation error mentioning the
        // other name in `rawResultPreview`, the upstream tool changed again.
        //
        // `full_rebuild: true` on the first reindex (no prior `lastIndexedAt`)
        // — crg's default incremental diff against HEAD~1 can yield zero
        // nodes on a fresh clone where the recent delta only touched non-
        // parseable files (markdown, images). A full rebuild guarantees the
        // graph is populated once; subsequent runs fall back to incremental.
        const isFirstBuild = !prior?.indexing?.status?.lastIndexedAt;
        if (isFirstBuild) {
          reindexLog.info("First build for this workspace — using full_rebuild");
        }
        const callPromise = crgMcpClient.callTool(
          "crg_build_or_update_graph",
          { repo_root: cwd, full_rebuild: isFirstBuild },
          { signal: abortController.signal, timeoutMs: reindexTimeoutMs },
        ) as Promise<{ content?: Array<{ text?: string }>; isError?: boolean } | null | undefined>;
        let timeoutHandle: NodeJS.Timeout | null = null;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reindexLog.error(
              { elapsedMs: elapsed(), timeoutMs: reindexTimeoutMs },
              "Reindex timed out — aborting",
            );
            reject(
              new Error(
                `crg_build_or_update_graph timed out after ${Math.round(reindexTimeoutMs / 1000)}s`,
              ),
            );
          }, reindexTimeoutMs);
        });

        // Watch the crg subprocess connection — if it dies mid-call (OOM,
        // segfault, kernel-killed) the SDK never resolves the in-flight
        // request. Abort fast so the UI flips to error instead of hanging at
        // ~85% forever (the asymptotic curve never reaches 100% without a
        // resolved call).
        //
        // ALSO watches the daemon's own RSS — Hubcode Local embeddings
        // (`@xenova/transformers`) load the BGE model into THIS process and
        // can balloon when embedding a large repo. The kernel will OOM-kill
        // the daemon (taking everything down) without warning. Abort the
        // reindex when we see ourselves climbing past the configured ceiling
        // so the user gets a clean error instead of a daemon crash.
        const daemonMaxRssBytes = (() => {
          // Resolution order: user setting → env var → default. Live-read so
          // Settings tweaks take effect on the next reindex.
          const userMb = daemonConfigStore.get().indexing?.daemonMaxRssMb;
          if (typeof userMb === "number" && userMb > 0) return userMb * 1024 * 1024;
          const envMb = Number.parseInt(process.env.HUBCODE_DAEMON_MAX_RSS_MB ?? "", 10);
          const mb = Number.isFinite(envMb) && envMb > 0 ? envMb : 6144;
          return mb * 1024 * 1024;
        })();
        let disconnectHandle: NodeJS.Timeout | null = null;
        const disconnectPromise = new Promise<never>((_, reject) => {
          disconnectHandle = setInterval(() => {
            if (!crgMcpClient.isConnected()) {
              reindexLog.error(
                { elapsedMs: elapsed() },
                "crg subprocess disconnected during reindex — aborting",
              );
              abortController.abort();
              reject(
                new Error(
                  "code-review-graph subprocess disconnected during indexing (likely out of memory)",
                ),
              );
              return;
            }
            const rss = process.memoryUsage.rss();
            if (rss > daemonMaxRssBytes) {
              reindexLog.error(
                {
                  elapsedMs: elapsed(),
                  rssBytes: rss,
                  rssMb: Math.round(rss / (1024 * 1024)),
                  limitMb: Math.round(daemonMaxRssBytes / (1024 * 1024)),
                },
                "daemon RSS exceeded ceiling — aborting reindex before kernel OOM",
              );
              abortController.abort();
              reject(
                new Error(
                  `Indexing aborted: daemon memory ceiling reached (${Math.round(rss / (1024 * 1024))}MB / ${Math.round(daemonMaxRssBytes / (1024 * 1024))}MB). The local embedding model is too heavy for this workspace — try a smaller scope or a remote embedding provider.`,
                ),
              );
            }
          }, 1_000);
        });

        let result: { content?: Array<{ text?: string }>; isError?: boolean } | null | undefined;
        try {
          result = await Promise.race([callPromise, timeoutPromise, disconnectPromise]);
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (disconnectHandle) clearInterval(disconnectHandle);
        }

        // MCP tool errors come back with `isError: true` — treat them as
        // thrown so the UI gets a proper error state instead of a confused
        // "ready with no counts". The text is the human-readable error.
        if (result?.isError) {
          const errText = result.content?.[0]?.text ?? "unknown crg error";
          throw new Error(`crg tool error: ${errText.slice(0, 400)}`);
        }
        // crg 2.3.2 returns a JSON dict with explicit keys
        // (`files_parsed`/`total_nodes`/`files_updated`/`total_edges`).
        // FastMCP serializes it as `content[0].text = JSON`. Fall back to a
        // prose regex for older builds that printed a human summary.
        const text = result?.content?.[0]?.text ?? "";
        let fileCount: number | undefined;
        let nodeCount: number | undefined;
        try {
          const parsed = JSON.parse(text) as {
            files_parsed?: number;
            files_updated?: number;
            total_nodes?: number;
            total_edges?: number;
          };
          if (typeof parsed.files_parsed === "number") fileCount = parsed.files_parsed;
          else if (typeof parsed.files_updated === "number") fileCount = parsed.files_updated;
          if (typeof parsed.total_nodes === "number") nodeCount = parsed.total_nodes;
        } catch {
          // Not JSON — try the prose format used by older crg versions.
          const fileMatch = text.match(/(\d+)\s+files?\b/i);
          const nodeMatch = text.match(/(\d+)\s+nodes?\b/i);
          if (fileMatch?.[1]) fileCount = Number.parseInt(fileMatch[1], 10);
          if (nodeMatch?.[1]) nodeCount = Number.parseInt(nodeMatch[1], 10);
        }
        // Auto-embed when the workspace has a real embedding provider
        // configured. crg's `build_or_update_graph` does NOT run embeddings
        // by default (only signatures/FTS/flows/communities). Without this
        // call, semantic_search_nodes returns empty and the UI shows
        // "Embeddings: 0" despite the graph being ready. Best-effort; a
        // failed embed doesn't fail the overall reindex.
        if (providerKind && providerKind !== "none") {
          try {
            await crgMcpClient.callTool(
              "crg_embed_graph",
              { repo_root: cwd },
              // Embeddings can take minutes on large repos with local models;
              // share the same hard ceiling as the build itself instead of
              // the SDK's 60s default that was timing out incomplete embeds.
              { signal: abortController.signal, timeoutMs: reindexTimeoutMs },
            );
            reindexLog.info({ providerKind }, "Embeddings computed");
          } catch (err) {
            reindexLog.warn(
              { err, providerKind },
              "Auto-embed after build failed (semantic search may be stale)",
            );
          }
        }

        // `build_or_update_graph` returns diff-oriented counts
        // (`files_updated` = files touched this run, not total). Follow up
        // with `list_graph_stats` to get the authoritative totals so the UI
        // shows the whole-graph size, not just what changed. Best-effort —
        // if stats call fails, fall back to whatever we parsed.
        try {
          const statsResult = (await crgMcpClient.callTool(
            "crg_list_graph_stats",
            { repo_root: cwd },
            { signal: abortController.signal },
          )) as { content?: Array<{ text?: string }> } | null | undefined;
          const statsText = statsResult?.content?.[0]?.text ?? "";
          if (statsText) {
            try {
              const stats = JSON.parse(statsText) as {
                files_count?: number;
                total_nodes?: number;
              };
              if (typeof stats.files_count === "number") fileCount = stats.files_count;
              if (typeof stats.total_nodes === "number") nodeCount = stats.total_nodes;
            } catch {
              // Stats call returned non-JSON — ignore, keep build counts.
            }
          }
        } catch (err) {
          reindexLog.debug({ err }, "list_graph_stats call failed — falling back to build counts");
        }

        // Incremental runs with no changes return `files_updated: 0` — preserve
        // the previous known counts so the UI doesn't flash "0 files" for a
        // no-op reindex.
        if (fileCount === 0 && priorFileCount > 0) fileCount = priorFileCount;
        if (nodeCount === 0 && prior?.indexing?.status?.nodeCount) {
          nodeCount = prior.indexing.status.nodeCount;
        }

        cleanupTimers();

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
        reindexLog.info(
          {
            elapsedMs: elapsed(),
            fileCount,
            nodeCount,
            indexBytes,
            rawResultPreview: text.slice(0, 200),
          },
          "Reindex completed",
        );
        return { ok: true, fileCount, nodeCount };
      } catch (err) {
        cleanupTimers();
        const message = err instanceof Error ? err.message : String(err);
        const wasAborted = abortController.signal.aborted;
        reindexLog[wasAborted ? "info" : "error"](
          { err, elapsedMs: elapsed(), connected: crgMcpClient.isConnected(), wasAborted },
          wasAborted ? "Reindex cancelled by user" : "Reindex failed",
        );
        await indexingService
          .setStatus(workspaceId, {
            phase: wasAborted ? "idle" : "error",
            ...(wasAborted ? {} : { error: message }),
          })
          .catch((inner) => reindexLog.warn({ err: inner }, "Failed to persist error status"));
        return { ok: false, error: wasAborted ? "Cancelled" : message };
      } finally {
        reindexInFlight.delete(workspaceId);
      }
    };

    // Wire the cancel path so `indexingService.cancelReindex(wsId)` aborts the
    // in-flight MCP call. Returns whether there was actually a reindex to
    // cancel.
    indexingService.setReindexCanceller((workspaceId) => {
      const controller = reindexInFlight.get(workspaceId);
      if (!controller) return false;
      controller.abort();
      return true;
    });
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
            if (reindexInFlight.has(info.workspaceId)) {
              // A reindex is already running — let the in-flight one finish.
              // This is intentional: the debounced watcher batches rapid file
              // changes, but a second burst mid-indexing would pile a second
              // call which serializes behind the first anyway. Logging so the
              // daemon.log shows we intentionally dropped it.
              logger.debug(
                { workspaceId: info.workspaceId, changedCount: info.changedPaths?.length ?? 0 },
                "fs-watcher: reindex already in flight, coalescing",
              );
              return;
            }
            logger.info(
              {
                workspaceId: info.workspaceId,
                changedCount: info.changedPaths?.length ?? 0,
                // Show the actual paths so we can identify what's triggering
                // a reindex loop. Truncate to first 10 to keep logs readable.
                changedPaths: (info.changedPaths ?? []).slice(0, 10),
              },
              "fs-watcher: triggering reindex",
            );
            void indexingService
              .setStatus(info.workspaceId, { phase: "indexing" })
              .then(() => triggerReindex(info.workspaceId, ws.cwd))
              .catch((err) => logger.warn({ err }, "fs-watcher reindex trigger failed"));
          },
          // Empty watchlist == user hasn't configured → use fs-watcher's
          // sensible defaults (node_modules, .git, etc.) by passing undefined.
          ws.indexing?.watchlist && ws.indexing.watchlist.length > 0
            ? ws.indexing.watchlist
            : undefined,
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
    // Only reconcile fs-watchers on phase transitions — not on every progress
    // tick (the ticker fires setStatus every 1s and used to re-list all
    // workspaces each time, costing dozens of disk reads/min per indexing
    // workspace for no benefit).
    const lastPhaseByWorkspace = new Map<string, string>();
    indexingService.onStatus((event) => {
      const prevPhase = lastPhaseByWorkspace.get(event.workspaceId);
      if (prevPhase === event.status.phase) return;
      lastPhaseByWorkspace.set(event.workspaceId, event.status.phase);
      void reconcileWatchers().catch((err) => logger.warn({ err }, "reconcileWatchers failed"));
    });
    await reconcileWatchers().catch((err) =>
      logger.warn({ err }, "Initial reconcileWatchers failed"),
    );

    // Recover from daemon restarts mid-indexing: any workspace still marked
    // `indexing` in persistent state was orphaned by the old process. Flip it
    // back to `idle` so the UI isn't stuck on a ghost spinner. The normal
    // initial-reindex pass (or user action) kicks off a fresh run.
    const recoverStalePhases = async () => {
      const records = await workspaceRegistry.list().catch(() => []);
      for (const ws of records) {
        const phase = ws.indexing?.status?.phase;
        if (phase === "indexing" || phase === "installing") {
          logger.warn(
            { workspaceId: ws.workspaceId, phase },
            "Found stale indexing phase on startup — resetting to idle",
          );
          await indexingService
            .setStatus(ws.workspaceId, { phase: "idle" })
            .catch((err) =>
              logger.warn({ err, workspaceId: ws.workspaceId }, "Failed to reset stale phase"),
            );
        }
      }
    };
    await recoverStalePhases();
    // Once the crg client connects, auto-trigger initial reindex for any
    // enabled workspace that has never been indexed (or is stale). Runs
    // sequentially so we don't slam crg with parallel build calls.
    const runInitialReindex = async () => {
      if (!crgMcpClient.isConnected()) {
        logger.debug("Initial reindex skipped — crg not connected yet");
        return;
      }
      const records = await workspaceRegistry
        .list()
        .catch((err): Awaited<ReturnType<typeof workspaceRegistry.list>> => {
          logger.warn({ err }, "Failed to list workspaces for initial reindex");
          return [];
        });
      const candidates = records.filter(
        (ws) =>
          ws.indexing?.enabled && !ws.indexing.status?.lastIndexedAt && ws.archivedAt === null,
      );
      if (candidates.length === 0) {
        logger.info("No workspaces require initial indexing");
        return;
      }
      logger.info(
        { count: candidates.length, workspaceIds: candidates.map((c) => c.workspaceId) },
        "Running initial reindex for never-indexed workspaces",
      );
      for (const ws of candidates) {
        await triggerReindex(ws.workspaceId, ws.cwd).catch((err) =>
          logger.warn({ err, workspaceId: ws.workspaceId }, "Initial reindex errored"),
        );
      }
    };
    crgMcpClient.onConnectionState((s) => {
      logger.info({ phase: s.phase, error: s.error }, "crg MCP connection state changed");
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
      // Indexing is optional. If the installed binary is broken (stale pipx
      // shim, missing venv, wrong architecture), spawn may throw — but that
      // must NOT bring down the daemon. Wrap so users without a working crg
      // still get agents/chat/etc., and can re-install from the UI.
      try {
        crgProcess.start();
        logger.info(
          { binPath: indexingDetection.codeReviewGraph.path },
          "code-review-graph subprocess started",
        );
      } catch (err) {
        logger.error(
          { err, binPath: indexingDetection.codeReviewGraph.path },
          "code-review-graph spawn failed at boot; indexing disabled until reinstall",
        );
      }
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
            resolveWorkspaceCwd: (id) => {
              if (!id) return null;
              const agent = agentManager.getAgent(id);
              return agent?.cwd ?? null;
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
              hookService,
              guiMcpRegistry,
              commandService,
              ruleService,
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
