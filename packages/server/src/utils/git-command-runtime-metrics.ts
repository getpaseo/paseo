export interface GitCommandDurationStats {
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface GitCommandRuntimeMetricsSnapshot {
  concurrencyLimit: number;
  active: number;
  pending: number;
  peakActive: number;
  peakPending: number;
  oldestPendingMs: number;
  submitted: number;
  started: number;
  completed: number;
  failed: number;
  timedOut: number;
  queueWaitMs: GitCommandDurationStats;
  executionMs: GitCommandDurationStats;
  operationsTop: Array<[string, number]>;
}

interface GitCommandRuntimeMetric {
  queuedAtMs: number;
  startedAtMs: number | null;
}

type Clock = () => number;

export class GitCommandRuntimeMetricsWindow {
  private readonly pendingCommands = new Set<GitCommandRuntimeMetric>();
  private active = 0;
  private peakActive = 0;
  private peakPending = 0;
  private submittedCount = 0;
  private startedCount = 0;
  private completedCount = 0;
  private failedCount = 0;
  private timedOutCount = 0;
  private readonly queueWaitSamples: number[] = [];
  private readonly executionSamples: number[] = [];
  private readonly operationCounts = new Map<string, number>();

  constructor(
    private readonly concurrencyLimit: number,
    private readonly clock: Clock = Date.now,
  ) {}

  submit(operation: string): GitCommandRuntimeMetric {
    const metric = { queuedAtMs: this.clock(), startedAtMs: null };
    this.pendingCommands.add(metric);
    this.submittedCount += 1;
    this.operationCounts.set(operation, (this.operationCounts.get(operation) ?? 0) + 1);
    return metric;
  }

  observeLimiter(active: number, pending: number): void {
    this.peakActive = Math.max(this.peakActive, active);
    this.peakPending = Math.max(this.peakPending, pending);
  }

  start(metric: GitCommandRuntimeMetric): void {
    if (!this.pendingCommands.delete(metric)) {
      return;
    }
    const now = this.clock();
    metric.startedAtMs = now;
    this.active += 1;
    this.startedCount += 1;
    this.peakActive = Math.max(this.peakActive, this.active);
    this.queueWaitSamples.push(Math.max(0, now - metric.queuedAtMs));
  }

  finish(metric: GitCommandRuntimeMetric, outcome: { success: boolean; timedOut: boolean }): void {
    if (metric.startedAtMs === null) {
      return;
    }
    const startedAtMs = metric.startedAtMs;
    metric.startedAtMs = null;
    this.active = Math.max(0, this.active - 1);
    this.completedCount += 1;
    if (!outcome.success) {
      this.failedCount += 1;
    }
    if (outcome.timedOut) {
      this.timedOutCount += 1;
    }
    this.executionSamples.push(Math.max(0, this.clock() - startedAtMs));
  }

  snapshotAndReset(
    limiter = { active: this.active, pending: this.pendingCommands.size },
  ): GitCommandRuntimeMetricsSnapshot {
    const now = this.clock();
    const oldestPendingAtMs = Math.min(
      ...Array.from(this.pendingCommands, (metric) => metric.queuedAtMs),
    );
    const snapshot: GitCommandRuntimeMetricsSnapshot = {
      concurrencyLimit: this.concurrencyLimit,
      active: limiter.active,
      pending: limiter.pending,
      peakActive: this.peakActive,
      peakPending: this.peakPending,
      oldestPendingMs:
        limiter.pending > 0 && Number.isFinite(oldestPendingAtMs)
          ? Math.max(0, now - oldestPendingAtMs)
          : 0,
      submitted: this.submittedCount,
      started: this.startedCount,
      completed: this.completedCount,
      failed: this.failedCount,
      timedOut: this.timedOutCount,
      queueWaitMs: summarizeDurations(this.queueWaitSamples),
      executionMs: summarizeDurations(this.executionSamples),
      operationsTop: [...this.operationCounts.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, 12),
    };

    this.peakActive = limiter.active;
    this.peakPending = limiter.pending;
    this.submittedCount = 0;
    this.startedCount = 0;
    this.completedCount = 0;
    this.failedCount = 0;
    this.timedOutCount = 0;
    this.queueWaitSamples.length = 0;
    this.executionSamples.length = 0;
    this.operationCounts.clear();
    return snapshot;
  }
}

function summarizeDurations(samples: number[]): GitCommandDurationStats {
  if (samples.length === 0) {
    return { count: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
  }
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    count: sorted.length,
    p50Ms: Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0),
    p95Ms: Math.round(sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0),
    maxMs: Math.round(sorted[sorted.length - 1] ?? 0),
  };
}
