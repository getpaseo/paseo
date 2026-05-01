import { EventEmitter } from "node:events";
import type { Logger } from "pino";

import {
  defaultIndexingState,
  IndexingStateSchema,
  type IndexingState,
  type IndexingStatus,
} from "./types.js";
import { detectIndexingTools, type IndexingToolDetection } from "./detector.js";
import type { CrgProcessManager, CrgProcessState } from "./process-manager.js";
import type { CrgMcpClient } from "./mcp-client.js";
import type { CrgToolManifest } from "./tool-filter.js";
import {
  removeHubcodeMcpEntries,
  writeHubcodeMcpEntries,
  type AgentConfigOutcome,
} from "./agent-config-writer.js";
import { runCrgInstall, type InstallEvent } from "./installer.js";
import { buildEmbeddingEnv, envSnapshotEquals, type EnvSnapshot } from "./embedding-env.js";
import {
  startEmbeddingServer,
  type EmbeddingInferenceFn,
  type EmbeddingServerHandle,
} from "./embedding-server.js";

/**
 * Read/write surface for per-workspace indexing state. Phase 1 (PR1a) only
 * persists state and exposes detection — lifecycle (subprocess, fs watcher,
 * MCP proxy) lands in later PRs.
 *
 * The service reads existing state through the workspace-registry adapter
 * (so PR1a doesn't have to fork persistence) and writes back via the same
 * adapter. The adapter is injected for tests.
 */
export interface IndexingWorkspaceAdapter {
  list(): Promise<Array<{ workspaceId: string; indexing?: IndexingState }>>;
  get(workspaceId: string): Promise<{ workspaceId: string; indexing?: IndexingState } | null>;
  setIndexing(workspaceId: string, next: IndexingState | null): Promise<void>;
}

export interface IndexingServiceDeps {
  adapter: IndexingWorkspaceAdapter;
  logger: Logger;
  detect?: typeof detectIndexingTools;
  /** Lazy inference engine for the Hubcode Local embedding server. */
  hubcodeLocalInfer?: EmbeddingInferenceFn;
}

export interface IndexingStatusEvent {
  workspaceId: string;
  status: IndexingStatus;
}

export interface ToolsChangedEvent {
  workspaceId: string;
  /** Specific agent affected by the change, or null when broadcast (workspace-wide). */
  agentId: string | null;
}

export type FsTriggerEvent =
  | { kind: "change"; workspaceId: string; changedPaths: string[] }
  | { kind: "error"; workspaceId: string; error: string };

export class IndexingService {
  private readonly adapter: IndexingWorkspaceAdapter;
  private readonly logger: Logger;
  private readonly detect: typeof detectIndexingTools;
  private readonly events = new EventEmitter();
  private cachedDetection: IndexingToolDetection | null = null;
  private detectionAt = 0;
  private processManager: CrgProcessManager | null = null;
  private mcpClient: CrgMcpClient | null = null;
  private lastEmbeddingEnv: EnvSnapshot = {
    env: {},
    source: { workspaceId: null, providerKind: "unset" },
  };
  private embeddingServer: EmbeddingServerHandle | null = null;
  private readonly hubcodeLocalInfer: EmbeddingInferenceFn | null;

  constructor(deps: IndexingServiceDeps) {
    this.adapter = deps.adapter;
    this.logger = deps.logger.child({ module: "indexing-service" });
    this.detect = deps.detect ?? detectIndexingTools;
    this.hubcodeLocalInfer = deps.hubcodeLocalInfer ?? null;
  }

  /**
   * Attach a process manager. The service forwards its state transitions to
   * a dedicated event channel for the UI and keeps a reference so requests
   * can later ask to restart/stop the subprocess.
   */
  attachProcessManager(manager: CrgProcessManager): void {
    this.processManager = manager;
    manager.on("state", (state: CrgProcessState) => {
      this.events.emit("process-state", state);
    });
    // Ring buffer of the subprocess's recent stderr — surfaced in the UI via
    // `getStderrTail()` so users can see real error messages instead of a
    // generic "failed" when crg crashes or hangs. Kept to a small cap so long
    // runs don't leak memory.
    manager.on("stderr", (chunk: Buffer) => {
      this.appendStderr(chunk.toString("utf8"));
    });
  }

  private stderrBuffer = "";
  private static readonly STDERR_BUFFER_CAP = 16 * 1024; // 16 KB

  private appendStderr(chunk: string): void {
    this.stderrBuffer += chunk;
    if (this.stderrBuffer.length > IndexingService.STDERR_BUFFER_CAP) {
      this.stderrBuffer = this.stderrBuffer.slice(
        this.stderrBuffer.length - IndexingService.STDERR_BUFFER_CAP,
      );
    }
  }

  getStderrTail(): string {
    return this.stderrBuffer;
  }

  getProcessState(): CrgProcessState | null {
    return this.processManager?.getState() ?? null;
  }

  onProcessState(listener: (state: CrgProcessState) => void): () => void {
    this.events.on("process-state", listener);
    return () => {
      this.events.off("process-state", listener);
    };
  }

  async restartProcess(): Promise<void> {
    this.processManager?.restart();
  }

  async stopProcess(): Promise<void> {
    this.processManager?.stop();
  }

  async startProcess(): Promise<void> {
    this.processManager?.start();
  }

  /**
   * Optional reindex trigger plugged in by `bootstrap`. Centralizes the
   * "call crg's update_graph MCP tool + bump status" logic so any caller
   * (UI Re-index button, fs-watcher, on-enable hook) flows through one path.
   */
  private reindexTrigger:
    | ((workspaceId: string) => Promise<{ ok: boolean; error?: string }>)
    | null = null;
  private reindexCanceller: ((workspaceId: string) => boolean) | null = null;

  setReindexTrigger(fn: (workspaceId: string) => Promise<{ ok: boolean; error?: string }>): void {
    this.reindexTrigger = fn;
  }

  /**
   * Hook that lets the bootstrap layer wire its AbortController registry into
   * the service. Returns true when there was a running reindex that got
   * cancelled, false when there was nothing to cancel.
   */
  setReindexCanceller(fn: (workspaceId: string) => boolean): void {
    this.reindexCanceller = fn;
  }

  async reindex(workspaceId: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.reindexTrigger) {
      return { ok: false, error: "Reindex trigger not wired" };
    }
    return this.reindexTrigger(workspaceId);
  }

  cancelReindex(workspaceId: string): { ok: boolean; cancelled: boolean } {
    if (!this.reindexCanceller) return { ok: false, cancelled: false };
    return { ok: true, cancelled: this.reindexCanceller(workspaceId) };
  }

  /**
   * Attach the crg MCP client so the service can expose the current tool
   * manifest for UI customization. Optional — without it, `getCrgTools` just
   * returns an empty list.
   */
  attachMcpClient(client: CrgMcpClient): void {
    this.mcpClient = client;
  }

  /**
   * Namespaced tool manifest cached from the crg subprocess. Returns an
   * empty list when the MCP client is not connected yet.
   */
  getCrgTools(): CrgToolManifest[] {
    return this.mcpClient?.getCachedTools() ?? [];
  }

  /**
   * Compute the current embedding env overlay from persisted state. Callers
   * without an up-to-date adapter can use this as a direct snapshot read.
   */
  async computeEmbeddingEnv(): Promise<EnvSnapshot> {
    const records = await this.adapter.list();
    const enriched = records
      .filter((r) => r.indexing)
      .map((r) => ({ workspaceId: r.workspaceId, state: r.indexing as IndexingState }));
    return buildEmbeddingEnv(enriched);
  }

  /**
   * Synchronous accessor used by `CrgProcessManager.envOverlay`. Reads the
   * cached last-known snapshot, overlaid with loopback embedding-server
   * details when Hubcode Local is active.
   */
  getCachedEmbeddingEnv(): Record<string, string> {
    const base = { ...this.lastEmbeddingEnv.env };
    if (this.lastEmbeddingEnv.source.providerKind === "hubcode-local" && this.embeddingServer) {
      base.CRG_OPENAI_BASE_URL = this.embeddingServer.baseUrl;
      base.CRG_OPENAI_API_KEY = this.embeddingServer.apiKey;
      // Default to the bundled bge model id; users override per-workspace
      // via embeddingProvider.config.model if they pick a different one.
      if (!base.CRG_OPENAI_MODEL) base.CRG_OPENAI_MODEL = "bge-small-en-v1.5";
    }
    return base;
  }

  /**
   * Recompute the effective embedding env. If it differs from the previous
   * snapshot AND the subprocess is currently running, restart it so the new
   * env reaches the child. Also brings the Hubcode Local loopback embedding
   * server up/down to match the new provider.
   */
  async syncEmbeddingEnv(): Promise<{ changed: boolean; restarted: boolean }> {
    const next = await this.computeEmbeddingEnv();
    const previousKind = this.lastEmbeddingEnv.source.providerKind;
    const changed = !envSnapshotEquals(next, this.lastEmbeddingEnv);
    this.lastEmbeddingEnv = next;

    // Manage the loopback embedding server lifecycle.
    if (next.source.providerKind === "hubcode-local") {
      if (!this.embeddingServer && this.hubcodeLocalInfer) {
        try {
          this.embeddingServer = await startEmbeddingServer({
            logger: this.logger,
            infer: this.hubcodeLocalInfer,
          });
        } catch (err) {
          this.logger.warn({ err }, "Failed to start Hubcode Local embedding server");
        }
      } else if (!this.hubcodeLocalInfer && previousKind !== "hubcode-local") {
        this.logger.warn("Hubcode Local selected but no inference engine wired; skipping");
      }
    } else if (this.embeddingServer) {
      const handle = this.embeddingServer;
      this.embeddingServer = null;
      handle
        .close()
        .catch((err) =>
          this.logger.warn({ err }, "Failed to close Hubcode Local embedding server"),
        );
    }

    if (!changed) return { changed: false, restarted: false };
    this.logger.info(
      { source: next.source, keys: Object.keys(next.env) },
      "Embedding env changed; restarting crg subprocess",
    );
    if (this.processManager && this.processManager.isRunning()) {
      this.processManager.restart();
      return { changed: true, restarted: true };
    }
    return { changed: true, restarted: false };
  }

  /**
   * Tear down the embedding server (called from bootstrap shutdown).
   */
  async disposeEmbeddingServer(): Promise<void> {
    if (!this.embeddingServer) return;
    const handle = this.embeddingServer;
    this.embeddingServer = null;
    await handle.close().catch(() => undefined);
  }

  /**
   * Run the platform-appropriate installer for code-review-graph and stream
   * events. The caller (Session) forwards them to the client as
   * `indexing/install/event` push messages.
   */
  private installInFlight = false;
  async *runInstall(): AsyncGenerator<InstallEvent, void, void> {
    // Concurrency guard — quick double-clicks on Install (or UI retries)
    // used to spawn multiple pipx installs in series, each one restarting
    // the crg subprocess and killing the prior handshake. One install at
    // a time; subsequent ones get a clear "already running" completion.
    if (this.installInFlight) {
      yield {
        type: "completed",
        success: false,
        error: "An install is already in progress — wait for it to finish.",
      };
      return;
    }
    this.installInFlight = true;
    try {
      yield* this.runInstallInner();
    } finally {
      this.installInFlight = false;
    }
  }

  private async *runInstallInner(): AsyncGenerator<InstallEvent, void, void> {
    const detection = await this.getDetection(true);
    let lastSuccess = false;
    for await (const event of runCrgInstall({
      logger: this.logger,
      pipxAvailable: detection.pipx.installed,
      brewAvailable: await this.brewAvailable(),
      python3Available:
        detection.python3.installed && detection.python3.meetsMinimumVersion === true,
      platform: process.platform,
    })) {
      if (event.type === "completed") lastSuccess = event.success;
      yield event;
    }
    // Refresh detection snapshot so subsequent UI reads reflect the new state.
    this.cachedDetection = null;
    const fresh = await this.getDetection(true).catch(() => null);
    // If install succeeded and crg is now detected, wire the freshly-found
    // binary into the process manager and start it. Otherwise the subprocess
    // never boots (binPath was null at daemon-start time) and the user sees
    // a stuck "Ready with 0 files" because the MCP client can't connect.
    if (lastSuccess && fresh?.codeReviewGraph.installed && fresh.codeReviewGraph.path) {
      this.processManager?.setBinPath(fresh.codeReviewGraph.path);
      try {
        // Force a restart in case the manager is in "failed" phase from the
        // pre-install null-binPath attempt — `start()` would no-op there.
        this.processManager?.restart();
      } catch (err) {
        this.logger.warn(
          { err },
          "Failed to start crg subprocess after install; manual restart may be required",
        );
      }
      // Kick off reindex for every enabled workspace. Unlike the boot-time
      // `runInitialReindex` that only picks "never indexed" workspaces, a
      // post-install user just clicked Install and expects visible action on
      // workspaces they already enabled — even if they have a stale
      // lastIndexedAt from a previous daemon run. We wait for the crg MCP
      // client to actually signal "connected" (fastmcp boot takes ~4s), not
      // a hardcoded timeout — otherwise the reindex fires while the
      // subprocess is still handshaking and gets skipped with
      // "crg subprocess not connected".
      this.waitConnectedThenReindexAll(30_000).catch((err) =>
        this.logger.warn({ err }, "Post-install reindex-all failed"),
      );
    }
  }

  private async waitConnectedThenReindexAll(timeoutMs: number): Promise<void> {
    const client = this.mcpClient;
    if (!client) return;
    // Already connected — fire reindex now, no need to wait.
    if (client.getConnectionState().phase === "connected") {
      await this.reindexAllEnabled();
      return;
    }
    // Otherwise subscribe to state changes. Handle three outcomes:
    //   1. connected → reindex
    //   2. failed   → log + give up (no point waiting further)
    //   3. timeout  → log + give up (last resort)
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        unsub();
        this.logger.warn(
          { timeoutMs },
          "crg did not connect within post-install window; reindex-all skipped",
        );
        resolve();
      }, timeoutMs);
      const unsub = client.onConnectionState((s) => {
        if (s.phase === "failed") {
          clearTimeout(timer);
          unsub();
          this.logger.warn(
            { error: s.error },
            "crg entered failed state after install; reindex-all skipped",
          );
          resolve();
          return;
        }
        if (s.phase !== "connected") return;
        clearTimeout(timer);
        unsub();
        this.reindexAllEnabled()
          .catch((err) => this.logger.warn({ err }, "reindexAllEnabled failed"))
          .finally(() => resolve());
      });
    });
  }

  /**
   * Reindex every workspace that has indexing enabled. Callers: the
   * post-install hook above, and (future) a "Reindex all" action in the UI.
   * No-op for disabled workspaces; concurrent reindex of the same workspace
   * is rejected by the bootstrap trigger's in-flight guard.
   */
  async reindexAllEnabled(): Promise<void> {
    if (!this.reindexTrigger) return;
    const records = await this.adapter.list().catch(() => []);
    // Default indexing state has `enabled: true`, and workspaces without an
    // explicit `indexing` block inherit that default on the UI side. Match
    // that semantics here: treat missing-block as enabled. Otherwise a
    // workspace the user sees as ON in Settings wouldn't get reindexed,
    // which is the exact post-install scenario — the workspace may have no
    // `indexing` field persisted yet because the user never flipped the
    // toggle (install alone should trigger it implicitly).
    const targets = records
      .filter((r) => (r.indexing ?? defaultIndexingState()).enabled)
      .map((r) => r.workspaceId);
    this.logger.info({ count: targets.length }, "Reindexing all enabled workspaces");
    for (const id of targets) {
      await this.reindexTrigger(id).catch((err) =>
        this.logger.warn({ err, workspaceId: id }, "Reindex one failed"),
      );
    }
  }

  private async brewAvailable(): Promise<boolean> {
    if (process.platform !== "darwin") return false;
    // Cheap PATH probe; the detector already knows how to do this, but it only
    // tracks pipx/python3/crg. For brew we do a minimal lookup here.
    const { defaultDetectorEnv, findBinary } = await import("./detector.js");
    const env = defaultDetectorEnv();
    return (await findBinary("brew", env)) !== null;
  }

  /**
   * Sync the Hubcode MCP entry into the per-CLI agent configs:
   *
   *  - For every detected agent that is enabled (per `exposeTo`) on at
   *    least one workspace whose indexing is enabled, write the entry.
   *  - For every other agent, ensure the entry is removed.
   *
   * Returns per-agent outcomes so the UI can show which configs were
   * touched. Idempotent.
   */
  async syncAgentConfigs(input: {
    detectedAgentIds: string[];
    hubcodeMcpUrl: string;
    home?: string;
  }): Promise<AgentConfigOutcome[]> {
    const enabled = await this.listEnabled();
    const agentsToWrite = new Set<string>();
    for (const { state } of enabled) {
      for (const agentId of input.detectedAgentIds) {
        const entry = state.exposeTo[agentId];
        // Default-on: missing entry means the agent is exposed.
        if (!entry || entry.enabled !== false) {
          agentsToWrite.add(agentId);
        }
      }
    }
    const agentsToRemove = input.detectedAgentIds.filter((id) => !agentsToWrite.has(id));
    const written = await writeHubcodeMcpEntries({
      hubcodeMcpUrl: input.hubcodeMcpUrl,
      agentIds: [...agentsToWrite],
      home: input.home,
    });
    const removed = await removeHubcodeMcpEntries({
      agentIds: agentsToRemove,
      home: input.home,
    });
    return [...written, ...removed];
  }

  /**
   * Subscribe to per-workspace status changes. Returns an unsubscribe fn.
   * Sessions use this to forward `indexing/status` push events to clients.
   */
  onStatus(listener: (event: IndexingStatusEvent) => void): () => void {
    this.events.on("status", listener);
    return () => {
      this.events.off("status", listener);
    };
  }

  /**
   * Update the status of a workspace and notify subscribers. Persists the
   * new status alongside the rest of the indexing state.
   */
  async setStatus(workspaceId: string, status: IndexingStatus): Promise<IndexingState> {
    const next = await this.update(workspaceId, { status });
    this.events.emit("status", { workspaceId, status });
    return next;
  }

  /**
   * Wipe the workspace's persisted indexing state. Called when the workspace
   * itself is being unlinked from the daemon — there's no point keeping
   * orphan rows around. Idempotent: if the workspace has no record we no-op.
   */
  async deleteState(workspaceId: string): Promise<void> {
    await this.adapter.setIndexing(workspaceId, null);
    this.logger.debug({ workspaceId }, "Indexing state cleared (workspace removed)");
  }

  async getDetection(force = false): Promise<IndexingToolDetection> {
    const fresh = !this.cachedDetection || force || Date.now() - this.detectionAt > 10_000;
    if (!fresh) return this.cachedDetection as IndexingToolDetection;
    const result = await this.detect();
    this.cachedDetection = result;
    this.detectionAt = Date.now();
    return result;
  }

  async getState(workspaceId: string): Promise<IndexingState> {
    const record = await this.adapter.get(workspaceId);
    if (!record) {
      this.logger.debug({ workspaceId }, "workspace not found, returning default state");
      return defaultIndexingState();
    }
    return record.indexing ?? defaultIndexingState();
  }

  async listEnabled(): Promise<Array<{ workspaceId: string; state: IndexingState }>> {
    const records = await this.adapter.list();
    return records
      .filter((r) => r.indexing?.enabled === true)
      .map((r) => ({ workspaceId: r.workspaceId, state: r.indexing as IndexingState }));
  }

  /**
   * List EVERY workspace with its (possibly default) indexing state. The UI
   * needs this to render the per-workspace toggles before any are enabled —
   * `listEnabled` would chicken-and-egg.
   */
  async listAll(): Promise<Array<{ workspaceId: string; state: IndexingState }>> {
    const records = await this.adapter.list();
    return records.map((r) => ({
      workspaceId: r.workspaceId,
      state: r.indexing ?? defaultIndexingState(),
    }));
  }

  async setEnabled(workspaceId: string, enabled: boolean): Promise<IndexingState> {
    const current = await this.getState(workspaceId);
    const next: IndexingState = { ...current, enabled };
    await this.persist(workspaceId, next);
    return next;
  }

  /**
   * Auto-enable indexing + kick off the initial reindex for a freshly-added
   * workspace. Idempotent: only acts when the workspace has *no* persisted
   * indexing state yet (so users who explicitly disabled a workspace keep
   * that preference even if the workspace is later re-added).
   *
   * Callers: any code path that creates a new workspace record. The reindex
   * is fired and forgotten — errors are logged at info level, never thrown,
   * because failing to index should never block workspace creation.
   */
  async autoEnableForNewWorkspace(workspaceId: string): Promise<void> {
    try {
      const record = await this.adapter.get(workspaceId);
      if (!record) return;
      // Only act on truly fresh workspaces — `indexing === undefined` is
      // our marker for "never touched", whereas `{ enabled: false }` means
      // the user deliberately turned it off.
      if (record.indexing !== undefined) return;

      const initial: IndexingState = { ...defaultIndexingState(), enabled: true };
      await this.persist(workspaceId, initial);
      this.logger.info({ workspaceId }, "auto-enabled indexing for new workspace");

      // Lazy reindex: do NOT fire the indexer here. Worktrees of the same
      // repo each cost ~25s of CPU on `npm run dev`-sized projects (284 files
      // → 1.8k nodes → 17.5k edges), and most are throwaway one-task spaces
      // that never need codegraph search. We instead fire the reindex on
      // first agent creation in the workspace (see triggerReindexIfPending),
      // and via the existing `reindex` RPC the UI calls when the user opens
      // a codegraph-aware panel.
    } catch (err) {
      this.logger.debug({ err, workspaceId }, "autoEnableForNewWorkspace failed (ignored)");
    }
  }

  /**
   * Fire-and-forget reindex if the workspace has indexing enabled but no
   * `lastIndexedAt` yet. Idempotent: subsequent calls are no-ops once the
   * workspace has been indexed at least once. Called from agent-creation
   * paths so the index is ready by the time the user gives the agent a
   * codegraph-flavored prompt.
   */
  async triggerReindexIfPending(workspaceId: string): Promise<void> {
    try {
      const record = await this.adapter.get(workspaceId);
      if (!record?.indexing?.enabled) return;
      if (record.indexing.status?.phase === "ready") return;
      if (record.indexing.status?.phase === "indexing") return;
      if (record.indexing.status?.phase === "installing") return;
      if (!this.reindexTrigger) return;
      this.logger.info({ workspaceId }, "triggering lazy reindex (first agent in workspace)");
      void this.reindexTrigger(workspaceId).catch((err) =>
        this.logger.info({ err, workspaceId }, "lazy reindex failed"),
      );
    } catch (err) {
      this.logger.debug({ err, workspaceId }, "triggerReindexIfPending failed (ignored)");
    }
  }

  async setExposeTo(
    workspaceId: string,
    agentId: string,
    entry: { enabled: boolean; enabledTools?: string[] } | null,
  ): Promise<IndexingState> {
    const current = await this.getState(workspaceId);
    const exposeTo = { ...current.exposeTo };
    if (entry === null) {
      delete exposeTo[agentId];
    } else {
      exposeTo[agentId] = entry;
    }
    const next: IndexingState = { ...current, exposeTo };
    await this.persist(workspaceId, next);
    this.events.emit("tools-changed", { workspaceId, agentId });
    return next;
  }

  /**
   * Subscribe to per-agent / per-tool exposure changes. Bootstrap registers
   * a handler that broadcasts `notifications/tools/list_changed` to active
   * agent MCP servers so connected CLIs refresh their tool lists without
   * reconnecting.
   */
  onToolsChanged(listener: (event: ToolsChangedEvent) => void): () => void {
    this.events.on("tools-changed", listener);
    return () => {
      this.events.off("tools-changed", listener);
    };
  }

  /**
   * Emit a fs-watcher event. Called by the bootstrap bridge when its fs
   * watchers observe a change (or error). Kept on the service rather than
   * exposing another EventEmitter from bootstrap so the session layer only
   * needs one subscription surface for all indexing push events.
   */
  emitFsTrigger(event: FsTriggerEvent): void {
    this.events.emit("fs-trigger", event);
  }

  onFsTrigger(listener: (event: FsTriggerEvent) => void): () => void {
    this.events.on("fs-trigger", listener);
    return () => {
      this.events.off("fs-trigger", listener);
    };
  }

  async update(workspaceId: string, patch: Partial<IndexingState>): Promise<IndexingState> {
    const current = await this.getState(workspaceId);
    const next = IndexingStateSchema.parse({ ...current, ...patch });
    await this.persist(workspaceId, next);
    return next;
  }

  private async persist(workspaceId: string, next: IndexingState): Promise<void> {
    const validated = IndexingStateSchema.parse(next);
    await this.adapter.setIndexing(workspaceId, validated);
    this.logger.debug(
      { workspaceId, enabled: validated.enabled, phase: validated.status.phase },
      "indexing state persisted",
    );
    // Any state change may alter the effective embedding env; recompute and
    // restart the subprocess if it actually differs. No-op when nothing changed.
    this.syncEmbeddingEnv().catch((err) => {
      this.logger.warn({ err }, "syncEmbeddingEnv after persist failed");
    });
  }
}
