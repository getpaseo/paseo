import type { Logger } from "pino";

import type { PersistedWorkspaceCleanupReceipt, WorkspaceRegistry } from "./workspace-registry.js";

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 5_000;
const DEFAULT_MAX_ATTEMPTS_PER_CYCLE = 4;

export interface CleanupRetryTarget {
  workspaceId: string;
  receipt: PersistedWorkspaceCleanupReceipt;
}

export interface WorkspaceCleanupRetryServiceOptions {
  workspaceRegistry: Pick<WorkspaceRegistry, "list">;
  retryWorkspaceCleanup: (target: CleanupRetryTarget, signal: AbortSignal) => Promise<void>;
  logger: Logger;
  pollIntervalMs?: number;
  retryDelayMs?: number;
  maxAttemptsPerCycle?: number;
  now?: () => Date;
}

export class WorkspaceCleanupRetryService {
  private readonly pollIntervalMs: number;
  private readonly retryDelayMs: number;
  private readonly maxAttemptsPerCycle: number;
  private timer: NodeJS.Timeout | null = null;
  private currentCycle: Promise<void> | null = null;
  private currentAbortController: AbortController | null = null;

  constructor(private readonly options: WorkspaceCleanupRetryServiceOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.maxAttemptsPerCycle = options.maxAttemptsPerCycle ?? DEFAULT_MAX_ATTEMPTS_PER_CYCLE;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.runScheduledCycle();
    this.timer = setInterval(() => this.runScheduledCycle(), this.pollIntervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.currentAbortController?.abort();
    await this.currentCycle;
  }

  async runNow(): Promise<void> {
    if (this.currentCycle) {
      return this.currentCycle;
    }
    const abortController = new AbortController();
    this.currentAbortController = abortController;
    this.currentCycle = this.runCycle(abortController.signal).finally(() => {
      this.currentCycle = null;
      if (this.currentAbortController === abortController) {
        this.currentAbortController = null;
      }
    });
    return this.currentCycle;
  }

  private runScheduledCycle(): void {
    void this.runNow().catch((error) => {
      this.options.logger.warn({ err: error }, "Workspace cleanup retry cycle failed");
    });
  }

  private async runCycle(signal: AbortSignal): Promise<void> {
    const now = (this.options.now?.() ?? new Date()).getTime();
    const targets = selectCleanupRetryTargets(await this.options.workspaceRegistry.list())
      .filter((target) => retryIsDue(target.receipt, now, this.retryDelayMs))
      .slice(0, this.maxAttemptsPerCycle);

    for (const target of targets) {
      if (signal.aborted) return;
      try {
        await this.options.retryWorkspaceCleanup(target, signal);
      } catch (error) {
        if (signal.aborted) return;
        this.options.logger.warn(
          { err: error, workspaceId: target.workspaceId },
          "Workspace cleanup retry failed",
        );
      }
    }
  }
}

function selectCleanupRetryTargets(
  workspaces: Awaited<ReturnType<WorkspaceRegistry["list"]>>,
): CleanupRetryTarget[] {
  const byDirectory = new Map<string, CleanupRetryTarget>();
  for (const workspace of workspaces) {
    const receipt = workspace.cleanupPending;
    if (!workspace.archivedAt || !receipt) {
      continue;
    }
    const key = `${receipt.backingPath}\0${receipt.directoryIdentity ?? "missing"}`;
    const existing = byDirectory.get(key);
    if (
      !existing ||
      receipt.createdAt.localeCompare(existing.receipt.createdAt) < 0 ||
      (receipt.createdAt === existing.receipt.createdAt &&
        workspace.workspaceId.localeCompare(existing.workspaceId) < 0)
    ) {
      byDirectory.set(key, { workspaceId: workspace.workspaceId, receipt });
    }
  }
  return [...byDirectory.values()].sort(
    (left, right) =>
      left.receipt.createdAt.localeCompare(right.receipt.createdAt) ||
      left.workspaceId.localeCompare(right.workspaceId),
  );
}

function retryIsDue(
  receipt: PersistedWorkspaceCleanupReceipt,
  now: number,
  retryDelayMs: number,
): boolean {
  if (!receipt.lastAttemptAt || receipt.attemptCount === 0) {
    return true;
  }
  const lastAttemptAt = Date.parse(receipt.lastAttemptAt);
  if (!Number.isFinite(lastAttemptAt)) {
    return true;
  }
  const exponent = Math.min(Math.max(receipt.attemptCount - 1, 0), 6);
  return now - lastAttemptAt >= retryDelayMs * 2 ** exponent;
}
