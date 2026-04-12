import type { Logger } from "pino";

import type { AgentManager, ManagedAgent } from "./agent/agent-manager.js";
import type { ProjectRegistry, WorkspaceRegistry } from "./workspace-registry.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
} from "./workspace-registry.js";
import {
  buildProjectPlacementForCwd,
  deriveProjectKind,
  deriveProjectRootPath,
  deriveWorkspaceDisplayName,
  deriveWorkspaceId,
  deriveWorkspaceKind,
  normalizeWorkspaceId,
} from "./workspace-registry-model.js";
import {
  TmuxCodexBridge,
  createTmuxCodexCommandRunner,
  type TmuxCodexCommandRunner,
  type TmuxCodexPaneSnapshot,
} from "./tmux-codex-bridge.js";
import { createTmuxCodexSession, type TmuxCodexSession } from "./tmux-codex-session.js";

type TrackedTmuxCodexSession = {
  agentId: string;
  paneId: string;
  session: TmuxCodexSession;
  missingScans: number;
};

const DEFAULT_SCAN_INTERVAL_MS = 2500;
const DEFAULT_MISSING_SCAN_GRACE = 2;

export interface TmuxCodexBridgeServiceOptions {
  logger: Logger;
  paseoHome: string;
  agentManager: AgentManager;
  projectRegistry: ProjectRegistry;
  workspaceRegistry: WorkspaceRegistry;
  runner?: TmuxCodexCommandRunner;
  scanIntervalMs?: number;
  missingScanGrace?: number;
}

export class TmuxCodexBridgeService {
  private readonly logger: Logger;
  private readonly paseoHome: string;
  private readonly agentManager: AgentManager;
  private readonly projectRegistry: ProjectRegistry;
  private readonly workspaceRegistry: WorkspaceRegistry;
  private readonly runner: TmuxCodexCommandRunner;
  private readonly discoveryBridge: TmuxCodexBridge;
  private readonly scanIntervalMs: number;
  private readonly missingScanGrace: number;
  private readonly trackedByAgentId = new Map<string, TrackedTmuxCodexSession>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private syncInFlight: Promise<void> | null = null;

  constructor(options: TmuxCodexBridgeServiceOptions) {
    this.logger = options.logger.child({ module: "tmux-codex-bridge-service" });
    this.paseoHome = options.paseoHome;
    this.agentManager = options.agentManager;
    this.projectRegistry = options.projectRegistry;
    this.workspaceRegistry = options.workspaceRegistry;
    this.runner = options.runner ?? createTmuxCodexCommandRunner();
    this.discoveryBridge = new TmuxCodexBridge({
      logger: this.logger,
      runner: this.runner,
    });
    this.scanIntervalMs = options.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
    this.missingScanGrace = options.missingScanGrace ?? DEFAULT_MISSING_SCAN_GRACE;
  }

  async start(): Promise<void> {
    await this.syncNow();
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.syncNow();
    }, this.scanIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const tracked = Array.from(this.trackedByAgentId.values());
    this.trackedByAgentId.clear();
    await Promise.allSettled(tracked.map((entry) => entry.session.close()));
  }

  async syncNow(): Promise<void> {
    if (this.syncInFlight) {
      await this.syncInFlight;
      return;
    }

    const run = this.doSync();
    this.syncInFlight = run;
    try {
      await run;
    } finally {
      if (this.syncInFlight === run) {
        this.syncInFlight = null;
      }
    }
  }

  private async doSync(): Promise<void> {
    const snapshots = await this.discoveryBridge.discover();
    const seenAgentIds = new Set<string>();

    for (const snapshot of snapshots) {
      seenAgentIds.add(snapshot.agentId);
      if (
        this.trackedByAgentId.has(snapshot.agentId) ||
        this.agentManager.getAgent(snapshot.agentId)
      ) {
        const tracked = this.trackedByAgentId.get(snapshot.agentId);
        if (tracked) {
          tracked.missingScans = 0;
        }
        continue;
      }

      await this.adoptSnapshot(snapshot, {
        labels: {
          source: "tmux",
          bridge: "codex",
          pane: snapshot.paneId,
        },
      });
    }

    const trackedEntries = Array.from(this.trackedByAgentId.values());
    for (const tracked of trackedEntries) {
      if (seenAgentIds.has(tracked.agentId)) {
        tracked.missingScans = 0;
        continue;
      }

      tracked.missingScans += 1;
      if (tracked.missingScans < this.missingScanGrace) {
        continue;
      }

      this.trackedByAgentId.delete(tracked.agentId);
      await tracked.session.close();
      if (this.agentManager.getAgent(tracked.agentId)) {
        await this.agentManager.closeAgent(tracked.agentId);
      }
    }
  }

  private async adoptSnapshot(
    snapshot: TmuxCodexPaneSnapshot,
    options?: { labels?: Record<string, string> },
  ): Promise<ManagedAgent> {
    await this.ensureWorkspaceProjection(snapshot);

    const session = createTmuxCodexSession({
      sessionId: snapshot.persistenceHandle.sessionId,
      paneId: snapshot.paneId,
      cwd: snapshot.cwd,
      title: snapshot.title,
      persistenceHandle: snapshot.persistenceHandle,
      externalSessionSource: "tmux_codex",
      runtimeExtra: {
        paneId: snapshot.paneId,
        title: snapshot.title,
        sessionName: snapshot.sessionName,
        windowId: snapshot.windowId,
      },
      capturePane: async (paneId) => this.capturePane(paneId),
      sendKeys: async (paneId, keys) => this.sendKeys(paneId, keys),
      isProcessAlive: async () => this.isProcessAlive(snapshot.processPid),
    });

    const managed = await this.agentManager.adoptSession(
      session,
      snapshot.config,
      snapshot.agentId,
      {
        labels: options?.labels,
      },
    );
    this.trackedByAgentId.set(snapshot.agentId, {
      agentId: snapshot.agentId,
      paneId: snapshot.paneId,
      session,
      missingScans: 0,
    });
    return managed;
  }

  private async ensureWorkspaceProjection(snapshot: TmuxCodexPaneSnapshot): Promise<void> {
    const normalizedCwd = normalizeWorkspaceId(snapshot.cwd);
    const placement = await buildProjectPlacementForCwd({
      cwd: normalizedCwd,
      paseoHome: this.paseoHome,
    });
    const workspaceId = deriveWorkspaceId(normalizedCwd, placement.checkout);
    const now = new Date().toISOString();

    await this.workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId,
        projectId: placement.projectKey,
        cwd: workspaceId,
        kind: deriveWorkspaceKind(placement.checkout),
        displayName: deriveWorkspaceDisplayName({
          cwd: workspaceId,
          checkout: placement.checkout,
        }),
        createdAt: now,
        updatedAt: now,
      }),
    );

    await this.projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: placement.projectKey,
        rootPath: deriveProjectRootPath({
          cwd: workspaceId,
          checkout: placement.checkout,
        }),
        kind: deriveProjectKind(placement.checkout),
        displayName: placement.projectName,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  private async capturePane(paneId: string): Promise<string> {
    return this.runner.execFile("tmux", ["capture-pane", "-p", "-J", "-S", "-200", "-t", paneId]);
  }

  private async sendKeys(paneId: string, keys: string[]): Promise<void> {
    for (const key of keys) {
      if (key === "Enter" || key === "C-c") {
        await this.runner.execFile("tmux", ["send-keys", "-t", paneId, key]);
        continue;
      }
      await this.runner.execFile("tmux", ["send-keys", "-t", paneId, "-l", key]);
    }
  }

  private async isProcessAlive(pid: number): Promise<boolean> {
    try {
      const stdout = await this.runner.execFile("ps", ["-p", String(pid), "-o", "pid="]);
      return stdout.trim() === String(pid);
    } catch {
      return false;
    }
  }
}
