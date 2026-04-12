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
  CodexProcessBridge,
  createCodexProcessRunner,
  type CodexProcessDescriptor,
  type CodexProcessRunner,
} from "./codex-process-bridge.js";
import { createTmuxCodexSession, type TmuxCodexSession } from "./tmux-codex-session.js";

type TrackedCodexProcessSession = {
  agentId: string;
  leaderPid: number;
  session: TmuxCodexSession;
  missingScans: number;
};

const DEFAULT_SCAN_INTERVAL_MS = 2500;
const DEFAULT_MISSING_SCAN_GRACE = 2;

export interface CodexProcessBridgeServiceOptions {
  logger: Logger;
  paseoHome: string;
  agentManager: AgentManager;
  projectRegistry: ProjectRegistry;
  workspaceRegistry: WorkspaceRegistry;
  runner?: CodexProcessRunner;
  scanIntervalMs?: number;
  missingScanGrace?: number;
}

export class CodexProcessBridgeService {
  private readonly logger: Logger;
  private readonly paseoHome: string;
  private readonly agentManager: AgentManager;
  private readonly projectRegistry: ProjectRegistry;
  private readonly workspaceRegistry: WorkspaceRegistry;
  private readonly bridge: CodexProcessBridge;
  private readonly scanIntervalMs: number;
  private readonly missingScanGrace: number;
  private readonly trackedByAgentId = new Map<string, TrackedCodexProcessSession>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private syncInFlight: Promise<void> | null = null;

  constructor(options: CodexProcessBridgeServiceOptions) {
    this.logger = options.logger.child({ module: "codex-process-bridge-service" });
    this.paseoHome = options.paseoHome;
    this.agentManager = options.agentManager;
    this.projectRegistry = options.projectRegistry;
    this.workspaceRegistry = options.workspaceRegistry;
    this.bridge = new CodexProcessBridge({
      logger: this.logger,
      runner: options.runner ?? createCodexProcessRunner(),
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
    const descriptors = await this.bridge.discover();
    const seenAgentIds = new Set<string>();

    for (const descriptor of descriptors) {
      seenAgentIds.add(descriptor.agentId);
      if (
        this.trackedByAgentId.has(descriptor.agentId) ||
        this.agentManager.getAgent(descriptor.agentId)
      ) {
        const tracked = this.trackedByAgentId.get(descriptor.agentId);
        if (tracked) {
          tracked.missingScans = 0;
        }
        continue;
      }

      await this.adoptDescriptor(descriptor, {
        labels: {
          source: "external",
          bridge: "codex_process",
          tty: descriptor.tty.replace("/dev/", ""),
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

  private async adoptDescriptor(
    descriptor: CodexProcessDescriptor,
    options?: { labels?: Record<string, string> },
  ): Promise<ManagedAgent> {
    await this.ensureWorkspaceProjection(descriptor);

    const session = createTmuxCodexSession({
      sessionId: descriptor.persistenceHandle.sessionId,
      paneId: descriptor.tty,
      cwd: descriptor.cwd,
      title: descriptor.title,
      persistenceHandle: descriptor.persistenceHandle,
      externalSessionSource: "codex_process",
      runtimeExtra: {
        tty: descriptor.tty,
        title: descriptor.title,
        leaderPid: descriptor.leaderPid,
        sessionId: descriptor.sessionId,
      },
      capturePane: async () => this.bridge.capture(descriptor.logPath),
      sendKeys: async (_target, keys) => this.sendKeys(descriptor.tty, keys),
      isProcessAlive: async () => this.bridge.isAlive(descriptor.leaderPid),
    });

    const managed = await this.agentManager.adoptSession(
      session,
      descriptor.config,
      descriptor.agentId,
      {
        labels: options?.labels,
      },
    );

    this.trackedByAgentId.set(descriptor.agentId, {
      agentId: descriptor.agentId,
      leaderPid: descriptor.leaderPid,
      session,
      missingScans: 0,
    });
    return managed;
  }

  private async ensureWorkspaceProjection(descriptor: CodexProcessDescriptor): Promise<void> {
    const normalizedCwd = normalizeWorkspaceId(descriptor.cwd);
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

  private async sendKeys(tty: string, keys: string[]): Promise<void> {
    for (const key of keys) {
      const data = key === "Enter" ? "\n" : key === "C-c" ? "\u0003" : key;
      await this.bridge.sendInput(tty, data);
    }
  }
}
