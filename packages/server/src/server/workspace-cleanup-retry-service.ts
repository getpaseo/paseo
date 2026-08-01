import { resolve } from "node:path";

import type { Logger } from "pino";

import type { PersistedWorkspaceRecord, WorkspaceRegistry } from "./workspace-registry.js";

const DEFAULT_IDLE_POLL_MS = 30_000;
const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_RETRY_MAX_MS = 60_000;
const DEFAULT_MAX_TARGETS_PER_CYCLE = 8;

interface WorkspaceCleanupRetryTarget {
  directoryPath: string;
  worktreeIncarnationId: string;
  workspaceIds: string[];
}

export interface WorkspaceCleanupRetryServiceOptions {
  workspaceRegistry: Pick<WorkspaceRegistry, "list" | "subscribeToMutations">;
  retryWorktreeCleanup: (targetPath: string) => Promise<void>;
  logger: Logger;
  idlePollMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  maxTargetsPerCycle?: number;
}

export class WorkspaceCleanupRetryService {
  private readonly logger: Logger;
  private readonly idlePollMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly maxTargetsPerCycle: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private activeCycle: Promise<void> | null = null;
  private unsubscribe: (() => void) | null = null;
  private started = false;
  private stopped = false;
  private consecutiveFailedCycles = 0;
  private wakeRequested = false;

  constructor(private readonly options: WorkspaceCleanupRetryServiceOptions) {
    this.logger = options.logger.child({ module: "workspace-cleanup-retry-service" });
    this.idlePollMs = options.idlePollMs ?? DEFAULT_IDLE_POLL_MS;
    this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.retryMaxMs = options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
    this.maxTargetsPerCycle = options.maxTargetsPerCycle ?? DEFAULT_MAX_TARGETS_PER_CYCLE;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.unsubscribe =
      this.options.workspaceRegistry.subscribeToMutations?.((mutation) => {
        if (mutation.workspace?.cleanupPending) {
          this.requestWake();
        }
      }) ?? null;
    await this.runCycle();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    this.wakeRequested = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.activeCycle;
  }

  private requestWake(): void {
    if (!this.started || this.stopped) return;
    if (this.activeCycle) {
      this.wakeRequested = true;
      return;
    }
    this.schedule(0);
  }

  private schedule(delayMs: number): void {
    if (!this.started || this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runCycle();
    }, delayMs);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  private async runCycle(): Promise<void> {
    if (!this.started || this.stopped || this.activeCycle) return;
    const task = this.executeCycle();
    this.activeCycle = task;
    try {
      await task;
    } finally {
      if (this.activeCycle === task) this.activeCycle = null;
      if (this.started && !this.stopped) {
        if (this.wakeRequested) {
          this.wakeRequested = false;
          this.schedule(0);
        } else {
          const delay =
            this.consecutiveFailedCycles === 0
              ? this.idlePollMs
              : Math.min(
                  this.retryMaxMs,
                  this.retryBaseMs * 2 ** (this.consecutiveFailedCycles - 1),
                );
          this.schedule(delay);
        }
      }
    }
  }

  private async executeCycle(): Promise<void> {
    let targets: WorkspaceCleanupRetryTarget[];
    try {
      targets = findWorkspaceCleanupRetryTargets(await this.options.workspaceRegistry.list());
    } catch (error) {
      this.consecutiveFailedCycles += 1;
      this.logger.warn({ err: error }, "Failed to list pending workspace cleanup");
      return;
    }

    let failed = false;
    for (const target of targets.slice(0, this.maxTargetsPerCycle)) {
      try {
        await this.options.retryWorktreeCleanup(target.directoryPath);
      } catch (error) {
        failed = true;
        this.logger.warn(
          {
            err: error,
            directoryPath: target.directoryPath,
            workspaceIds: target.workspaceIds,
            worktreeIncarnationId: target.worktreeIncarnationId,
          },
          "Pending workspace cleanup retry failed",
        );
      }
    }
    if (targets.length > this.maxTargetsPerCycle) {
      this.wakeRequested = true;
    }
    this.consecutiveFailedCycles = failed ? this.consecutiveFailedCycles + 1 : 0;
  }
}

export function findWorkspaceCleanupRetryTargets(
  workspaces: readonly PersistedWorkspaceRecord[],
): WorkspaceCleanupRetryTarget[] {
  const byDirectory = new Map<string, PersistedWorkspaceRecord[]>();
  for (const workspace of workspaces) {
    if (!workspace.archivedAt || !workspace.cleanupPending) continue;
    const directoryPath = resolve(workspace.cleanupPending.directoryPath);
    const group = byDirectory.get(directoryPath) ?? [];
    group.push(workspace);
    byDirectory.set(directoryPath, group);
  }

  const targets: WorkspaceCleanupRetryTarget[] = [];
  for (const [directoryPath, group] of byDirectory) {
    const incarnationIds = new Set(
      group.map((workspace) => workspace.cleanupPending?.worktreeIncarnationId ?? null),
    );
    if (incarnationIds.size !== 1 || incarnationIds.has(null)) continue;
    targets.push({
      directoryPath,
      worktreeIncarnationId: [...incarnationIds][0]!,
      workspaceIds: group.map((workspace) => workspace.workspaceId).sort(),
    });
  }
  return targets.sort((left, right) => left.directoryPath.localeCompare(right.directoryPath));
}
