import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { Logger } from "pino";

import type { AgentPersistenceHandle, AgentSessionConfig } from "./agent/agent-sdk-types.js";
import type { AgentStorage, StoredAgentRecord } from "./agent/agent-storage.js";
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
  isTmuxCodexHandle,
  readTmuxCodexPaneId,
  type TmuxCodexCommandRunner,
  type TmuxCodexPaneSnapshot,
} from "./tmux-codex-bridge.js";
import { createTmuxCodexSession, type TmuxCodexSession } from "./tmux-codex-session.js";
import { loadCodexPersistedTimeline } from "./agent/providers/codex-rollout-timeline.js";

type TrackedTmuxCodexSession = {
  agentId: string;
  paneId: string;
  session: TmuxCodexSession;
  missingScans: number;
};

type PersistedTmuxPaneBinding = {
  paneId: string;
  canonical: StoredAgentRecord;
  duplicates: StoredAgentRecord[];
};

type AgentStorageLike = Pick<AgentStorage, "list" | "remove" | "upsert">;

const DEFAULT_SCAN_INTERVAL_MS = 2500;
const DEFAULT_MISSING_SCAN_GRACE = 2;
const TMUX_CODEX_SOURCE = "tmux_codex";

function parseOptionalDate(value: string | null | undefined): Date | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function readRuntimeExtra(
  record: Pick<StoredAgentRecord, "runtimeInfo">,
): Record<string, unknown> | null {
  const extra = record.runtimeInfo?.extra;
  return extra && typeof extra === "object" ? (extra as Record<string, unknown>) : null;
}

function readConfigCodexExtra(
  record: Pick<StoredAgentRecord, "config">,
): Record<string, unknown> | null {
  const extra = record.config?.extra;
  if (!extra || typeof extra !== "object") {
    return null;
  }
  const codex = (extra as Record<string, unknown>).codex;
  return codex && typeof codex === "object" ? (codex as Record<string, unknown>) : null;
}

function readStoredTmuxPaneId(record: StoredAgentRecord): string | null {
  const runtimeExtra = readRuntimeExtra(record);
  const configCodexExtra = readConfigCodexExtra(record);
  const externalSourceCandidates = [
    record.persistence?.metadata?.externalSessionSource,
    runtimeExtra?.externalSessionSource,
    configCodexExtra?.externalSessionSource,
  ];
  const hasTmuxSource = externalSourceCandidates.some(
    (value) => typeof value === "string" && value.trim() === TMUX_CODEX_SOURCE,
  );
  if (!hasTmuxSource) {
    return null;
  }

  const paneCandidates = [
    record.persistence?.metadata?.paneId,
    runtimeExtra?.paneId,
    configCodexExtra?.paneId,
    record.persistence?.sessionId,
  ];
  for (const candidate of paneCandidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const normalized = candidate.trim();
    if (normalized.startsWith("%")) {
      return normalized;
    }
  }

  return null;
}

function isGeneratedTmuxRecord(record: StoredAgentRecord): boolean {
  return record.labels.source === "tmux" && record.labels.bridge === "codex";
}

function compareStoredRecordAge(left: StoredAgentRecord, right: StoredAgentRecord): number {
  const leftCreated = parseOptionalDate(left.createdAt)?.getTime() ?? Number.MAX_SAFE_INTEGER;
  const rightCreated = parseOptionalDate(right.createdAt)?.getTime() ?? Number.MAX_SAFE_INTEGER;
  if (leftCreated !== rightCreated) {
    return leftCreated - rightCreated;
  }

  const leftUpdated = parseOptionalDate(left.updatedAt)?.getTime() ?? Number.MAX_SAFE_INTEGER;
  const rightUpdated = parseOptionalDate(right.updatedAt)?.getTime() ?? Number.MAX_SAFE_INTEGER;
  if (leftUpdated !== rightUpdated) {
    return leftUpdated - rightUpdated;
  }

  return left.id.localeCompare(right.id);
}

function normalizePreferredTitle(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function isGeneratedTmuxFallbackTitle(input: {
  title: string | null | undefined;
  paneId: string;
  cwd: string;
}): boolean {
  const normalizedTitle = normalizePreferredTitle(input.title);
  if (!normalizedTitle) {
    return false;
  }
  return normalizedTitle === `${basename(input.cwd)} [tmux:${input.paneId}]`;
}

export interface TmuxCodexBridgeServiceOptions {
  logger: Logger;
  paseoHome: string;
  agentManager: AgentManager;
  agentStorage?: AgentStorageLike;
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
  private readonly agentStorage: AgentStorageLike | null;
  private readonly projectRegistry: ProjectRegistry;
  private readonly workspaceRegistry: WorkspaceRegistry;
  private readonly runner: TmuxCodexCommandRunner;
  private readonly discoveryBridge: TmuxCodexBridge;
  private readonly scanIntervalMs: number;
  private readonly missingScanGrace: number;
  private readonly trackedByAgentId = new Map<string, TrackedTmuxCodexSession>();
  private readonly reservedPaneIds = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private syncInFlight: Promise<void> | null = null;

  constructor(options: TmuxCodexBridgeServiceOptions) {
    this.logger = options.logger.child({ module: "tmux-codex-bridge-service" });
    this.paseoHome = options.paseoHome;
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage ?? null;
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
    await this.reconcileStoredPaneDuplicates();
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

  async resumeFromPersistence(input: {
    handle: AgentPersistenceHandle;
    agentId: string;
    config: AgentSessionConfig;
    labels?: Record<string, string>;
    createdAt?: Date;
    updatedAt?: Date;
    lastUserMessageAt?: Date | null;
  }): Promise<ManagedAgent> {
    if (!isTmuxCodexHandle(input.handle)) {
      throw new Error("Not a tmux codex persistence handle");
    }

    const paneId = readTmuxCodexPaneId(input.handle);
    const snapshots = await this.discoveryBridge.discover();
    const snapshot = snapshots.find((entry) => entry.agentId === input.agentId || entry.paneId === paneId);
    if (!snapshot) {
      throw new Error(`tmux codex session not found for pane ${paneId}`);
    }

    return this.adoptSnapshot(snapshot, {
      forcedAgentId: input.agentId,
      preferredTitle: input.config.title,
      labels: input.labels,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      lastUserMessageAt: input.lastUserMessageAt,
    });
  }

  async relaunchFromPersistence(input: {
    handle: AgentPersistenceHandle;
    agentId: string;
    config: AgentSessionConfig;
    labels?: Record<string, string>;
    createdAt?: Date;
    updatedAt?: Date;
    lastUserMessageAt?: Date | null;
  }): Promise<ManagedAgent> {
    const cwd =
      (typeof input.handle.metadata?.cwd === "string" && input.handle.metadata.cwd.trim()) ||
      input.config.cwd;
    if (!cwd) {
      throw new Error("Cannot relaunch external Codex session without cwd");
    }

    const title =
      (typeof input.config.title === "string" && input.config.title.trim()) ||
      (typeof input.handle.metadata?.title === "string" && input.handle.metadata.title.trim()) ||
      (typeof input.handle.metadata?.paneTitle === "string" && input.handle.metadata.paneTitle.trim()) ||
      null;

    const codexSessionId = this.resolveRecoverableCodexSessionId(input.handle);
    const snapshot = await this.launchTmuxCodexSnapshot({
      cwd,
      title,
      codexSessionId,
    });

    try {
      await this.reconcileStoredPaneDuplicates({
        paneId: snapshot.paneId,
        preferredAgentId: input.agentId,
        fallbackAgentId: snapshot.agentId,
      });
      return this.adoptSnapshot(snapshot, {
        forcedAgentId: input.agentId,
        preferredTitle: title,
        labels: input.labels,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
        lastUserMessageAt: input.lastUserMessageAt,
      });
    } finally {
      this.reservedPaneIds.delete(snapshot.paneId);
    }
  }

  private async doSync(): Promise<void> {
    const snapshots = await this.discoveryBridge.discover();
    const persistedPaneRecords = await this.listPersistedPaneRecords();
    const seenAgentIds = new Set<string>();
    const seenPaneIds = new Set<string>();

    for (const snapshot of snapshots) {
      seenPaneIds.add(snapshot.paneId);
      if (this.reservedPaneIds.has(snapshot.paneId)) {
        continue;
      }

      const paneBinding = this.resolvePersistedPaneBinding(
        snapshot.paneId,
        persistedPaneRecords.get(snapshot.paneId) ?? [],
        {
          fallbackAgentId: snapshot.agentId,
        },
      );
      if (paneBinding) {
        await this.disposeDuplicatePaneRecords(paneBinding);
      }

      const canonicalRecord = paneBinding?.canonical ?? null;
      const canonicalAgentId = canonicalRecord?.id ?? snapshot.agentId;
      const trackedByPane = this.findTrackedEntryByPaneId(snapshot.paneId);
      if (trackedByPane) {
        if (trackedByPane.agentId === canonicalAgentId) {
          seenAgentIds.add(trackedByPane.agentId);
          trackedByPane.missingScans = 0;
          continue;
        }
        await this.disposeTrackedAgentId(trackedByPane.agentId);
      }

      seenAgentIds.add(canonicalAgentId);
      if (
        this.trackedByAgentId.has(canonicalAgentId) ||
        this.agentManager.getAgent(canonicalAgentId)
      ) {
        const tracked = this.trackedByAgentId.get(canonicalAgentId);
        if (tracked) {
          tracked.missingScans = 0;
        }
        continue;
      }

      if (canonicalRecord) {
        await this.adoptSnapshot(snapshot, {
          forcedAgentId: canonicalRecord.id,
          preferredTitle: canonicalRecord.title,
          labels: canonicalRecord.labels,
          createdAt: parseOptionalDate(canonicalRecord.createdAt) ?? undefined,
          updatedAt: parseOptionalDate(canonicalRecord.updatedAt) ?? undefined,
          lastUserMessageAt: parseOptionalDate(canonicalRecord.lastUserMessageAt),
        });
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

    await this.reconcileMissingPersistedPanes({
      persistedPaneRecords,
      seenPaneIds,
    });

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

  private async reconcileMissingPersistedPanes(input: {
    persistedPaneRecords: Map<string, StoredAgentRecord[]>;
    seenPaneIds: Set<string>;
  }): Promise<void> {
    if (!this.agentStorage) {
      return;
    }

    for (const [paneId, records] of input.persistedPaneRecords.entries()) {
      if (input.seenPaneIds.has(paneId)) {
        continue;
      }

      const binding = this.resolvePersistedPaneBinding(paneId, records);
      const canonical = binding?.canonical ?? null;
      if (!canonical) {
        continue;
      }

      if (this.agentManager.getAgent(canonical.id)) {
        await this.agentManager.closeAgent(canonical.id);
        continue;
      }

      if (canonical.lastStatus === "closed") {
        continue;
      }

      await this.agentStorage.upsert({
        ...canonical,
        lastStatus: "closed",
        updatedAt: new Date().toISOString(),
      });
    }
  }

  private async adoptSnapshot(
    snapshot: TmuxCodexPaneSnapshot,
    options?: {
      forcedAgentId?: string;
      preferredTitle?: string | null;
      labels?: Record<string, string>;
      createdAt?: Date;
      updatedAt?: Date;
      lastUserMessageAt?: Date | null;
    },
  ): Promise<ManagedAgent> {
    const agentId = options?.forcedAgentId ?? snapshot.agentId;
    const preferredTitle = normalizePreferredTitle(options?.preferredTitle);
    const effectiveTitle =
      preferredTitle && isGeneratedTmuxFallbackTitle({
        title: preferredTitle,
        paneId: snapshot.paneId,
        cwd: snapshot.cwd,
      })
        ? snapshot.title
        : preferredTitle ?? snapshot.title;
    const sessionConfig =
      effectiveTitle === snapshot.config.title
        ? snapshot.config
        : {
            ...snapshot.config,
            title: effectiveTitle,
          };
    const persistenceHandle =
      snapshot.persistenceHandle.metadata?.title === effectiveTitle
        ? snapshot.persistenceHandle
        : {
            ...snapshot.persistenceHandle,
            metadata: {
              ...(snapshot.persistenceHandle.metadata ?? {}),
              title: effectiveTitle,
            },
          };
    await this.ensureWorkspaceProjection(snapshot);

    const session = createTmuxCodexSession({
      sessionId: snapshot.persistenceHandle.sessionId,
      paneId: snapshot.paneId,
      cwd: snapshot.cwd,
      title: effectiveTitle,
      persistenceHandle,
      externalSessionSource: "tmux_codex",
      runtimeExtra: {
        paneId: snapshot.paneId,
        title: effectiveTitle,
        sessionName: snapshot.sessionName,
        windowId: snapshot.windowId,
      },
      loadTimeline: snapshot.codexSessionId
        ? async () =>
            loadCodexPersistedTimeline(snapshot.codexSessionId!, undefined, this.logger)
        : undefined,
      capturePane: async (paneId) => this.capturePane(paneId),
      sendKeys: async (paneId, keys) => this.sendKeys(paneId, keys),
      isProcessAlive: async () => this.isProcessAlive(snapshot.processPid),
    });

    const managed = await this.agentManager.adoptSession(session, sessionConfig, agentId, {
      labels: options?.labels,
      createdAt: options?.createdAt,
      updatedAt: options?.updatedAt,
      lastUserMessageAt: options?.lastUserMessageAt,
    });
    this.trackedByAgentId.set(agentId, {
      agentId,
      paneId: snapshot.paneId,
      session,
      missingScans: 0,
    });
    if (
      preferredTitle &&
      effectiveTitle !== preferredTitle &&
      isGeneratedTmuxFallbackTitle({
        title: preferredTitle,
        paneId: snapshot.paneId,
        cwd: snapshot.cwd,
      })
    ) {
      try {
        await this.agentManager.setTitle(agentId, effectiveTitle);
      } catch (error) {
        this.logger.warn(
          { err: error, agentId, paneId: snapshot.paneId, effectiveTitle },
          "Failed to update stored tmux pane title",
        );
      }
    }
    return managed;
  }

  private findTrackedEntryByPaneId(paneId: string): TrackedTmuxCodexSession | null {
    for (const entry of this.trackedByAgentId.values()) {
      if (entry.paneId === paneId) {
        return entry;
      }
    }
    return null;
  }

  private async listPersistedPaneRecords(): Promise<Map<string, StoredAgentRecord[]>> {
    if (!this.agentStorage) {
      return new Map();
    }

    const records = await this.agentStorage.list();
    const byPaneId = new Map<string, StoredAgentRecord[]>();
    for (const record of records) {
      const paneId = readStoredTmuxPaneId(record);
      if (!paneId) {
        continue;
      }
      const existing = byPaneId.get(paneId) ?? [];
      existing.push(record);
      byPaneId.set(paneId, existing);
    }
    return byPaneId;
  }

  private resolvePersistedPaneBinding(
    paneId: string,
    records: StoredAgentRecord[],
    options?: {
      preferredAgentId?: string;
      fallbackAgentId?: string;
    },
  ): PersistedTmuxPaneBinding | null {
    if (records.length === 0) {
      return null;
    }

    if (options?.preferredAgentId) {
      const preferred = records.find((record) => record.id === options.preferredAgentId);
      if (preferred) {
        return {
          paneId,
          canonical: preferred,
          duplicates: records.filter((record) => record.id !== preferred.id),
        };
      }
    }

    const nonGenerated = records.filter((record) => !isGeneratedTmuxRecord(record));
    const candidatePool = nonGenerated.length > 0 ? nonGenerated : records;
    const fallback =
      options?.fallbackAgentId != null
        ? candidatePool.find((record) => record.id === options.fallbackAgentId) ?? null
        : null;
    const canonical = fallback ?? [...candidatePool].sort(compareStoredRecordAge)[0]!;
    return {
      paneId,
      canonical,
      duplicates: records.filter((record) => record.id !== canonical.id),
    };
  }

  private async reconcileStoredPaneDuplicates(options?: {
    paneId?: string;
    preferredAgentId?: string;
    fallbackAgentId?: string;
  }): Promise<void> {
    const persistedPaneRecords = await this.listPersistedPaneRecords();
    for (const [paneId, records] of persistedPaneRecords.entries()) {
      if (options?.paneId && paneId !== options.paneId) {
        continue;
      }
      const binding = this.resolvePersistedPaneBinding(paneId, records, {
        preferredAgentId: options?.preferredAgentId,
        fallbackAgentId: options?.fallbackAgentId,
      });
      if (!binding || binding.duplicates.length === 0) {
        continue;
      }
      await this.disposeDuplicatePaneRecords(binding);
    }
  }

  private async disposeDuplicatePaneRecords(binding: PersistedTmuxPaneBinding): Promise<void> {
    for (const duplicate of binding.duplicates) {
      this.logger.info(
        {
          paneId: binding.paneId,
          duplicateAgentId: duplicate.id,
          canonicalAgentId: binding.canonical.id,
        },
        "Removing duplicate tmux pane record",
      );
      await this.disposeTrackedAgentId(duplicate.id);
      if (!this.agentStorage) {
        continue;
      }
      try {
        await this.agentStorage.remove(duplicate.id);
      } catch (error) {
        this.logger.warn(
          { err: error, paneId: binding.paneId, duplicateAgentId: duplicate.id },
          "Failed to remove duplicate tmux pane record",
        );
      }
    }
  }

  private async disposeTrackedAgentId(agentId: string): Promise<void> {
    const tracked = this.trackedByAgentId.get(agentId) ?? null;
    if (tracked) {
      this.trackedByAgentId.delete(agentId);
    }

    if (this.agentManager.getAgent(agentId)) {
      try {
        await this.agentManager.closeAgent(agentId);
      } catch (error) {
        this.logger.warn({ err: error, agentId }, "Failed to close duplicate tracked agent");
      }
      return;
    }

    if (!tracked) {
      return;
    }

    try {
      await tracked.session.close();
    } catch (error) {
      this.logger.warn({ err: error, agentId }, "Failed to close duplicate tracked session");
    }
  }

  private resolveRecoverableCodexSessionId(handle: AgentPersistenceHandle): string | null {
    const candidates = [
      handle.metadata?.codexSessionId,
      handle.metadata?.sessionId,
      handle.sessionId,
    ];

    for (const candidate of candidates) {
      if (typeof candidate !== "string") {
        continue;
      }
      const normalized = candidate.trim();
      if (!normalized || normalized.startsWith("/dev/") || normalized.startsWith("%")) {
        continue;
      }
      return normalized;
    }

    return null;
  }

  private async launchTmuxCodexSnapshot(input: {
    cwd: string;
    title: string | null;
    codexSessionId: string | null;
  }): Promise<TmuxCodexPaneSnapshot> {
    const sessionName = `paseo-${randomUUID().slice(0, 8)}`;
    const paneId = (
      await this.runner.execFile("tmux", [
        "new-session",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-s",
        sessionName,
        "-c",
        input.cwd,
        "/usr/local/bin/codex-root-wrapper",
        ...(input.codexSessionId ? ["resume", input.codexSessionId] : []),
      ])
    ).trim();

    if (!paneId) {
      throw new Error("Failed to launch tmux Codex pane");
    }
    this.reservedPaneIds.add(paneId);

    try {
      if (input.title) {
        await this.runner
          .execFile("tmux", ["select-pane", "-t", paneId, "-T", input.title])
          .catch(() => undefined);
      }

      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const snapshots = await this.discoveryBridge.discover();
        const snapshot = snapshots.find((entry) => entry.paneId === paneId);
        if (snapshot) {
          return snapshot;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      throw new Error(`Timed out waiting for relaunched tmux Codex pane ${paneId}`);
    } catch (error) {
      this.reservedPaneIds.delete(paneId);
      throw error;
    }
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
