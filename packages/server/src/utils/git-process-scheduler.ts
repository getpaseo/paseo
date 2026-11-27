import { setImmediate as scheduleImmediate } from "node:timers";
import pThrottle from "p-throttle";

export interface GitProcessPolicy {
  maxProcessesPerSecond: number;
  maxProcessConcurrency: number;
}

export const DEFAULT_GIT_PROCESS_POLICY: GitProcessPolicy = {
  maxProcessesPerSecond: 64,
  maxProcessConcurrency: 8,
};

export interface ScheduledGitProcess<T> {
  result: Promise<T>;
  exited: Promise<void>;
}

// Lanes drain in this order. "background" is for daemon-initiated fan-out
// (reconciliation, observation-driven refreshes, fetches) so it never sits in
// front of work a user is waiting for.
export type GitProcessPriority = "high" | "normal" | "background";

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function resolveGitProcessPolicy(input: {
  env: NodeJS.ProcessEnv;
  persisted?: Partial<GitProcessPolicy>;
}): GitProcessPolicy {
  return {
    maxProcessesPerSecond:
      parsePositiveInteger(input.env.PASEO_GIT_MAX_PROCESSES_PER_SECOND) ??
      input.persisted?.maxProcessesPerSecond ??
      DEFAULT_GIT_PROCESS_POLICY.maxProcessesPerSecond,
    maxProcessConcurrency:
      parsePositiveInteger(input.env.PASEO_GIT_MAX_PROCESS_CONCURRENCY) ??
      // COMPAT(gitConcurrencyEnv): renamed in v0.2.6; remove after 2027-02-02.
      parsePositiveInteger(input.env.PASEO_GIT_CONCURRENCY) ??
      input.persisted?.maxProcessConcurrency ??
      DEFAULT_GIT_PROCESS_POLICY.maxProcessConcurrency,
  };
}

// Admission reserves a process slot and a start-rate token; the job runs only
// once its token fires. The job is chosen when the token fires, not when the
// slot is reserved, so work submitted while background jobs hold every reserved
// slot still takes the next start.
export class GitProcessScheduler {
  private readonly startThrottled;
  private readonly queues: Record<GitProcessPriority, Array<() => Promise<void>>> = {
    high: [],
    normal: [],
    background: [],
  };
  private admitted = 0;
  private reservedStarts = 0;
  private running = 0;
  private waiting = 0;
  private drainScheduled = false;

  constructor(readonly policy: GitProcessPolicy) {
    const throttle = pThrottle({
      limit: policy.maxProcessesPerSecond,
      interval: 1_000,
      strict: true,
    });
    this.startThrottled = throttle(() => this.startNext());
  }

  get activeCount(): number {
    return this.running;
  }

  get pendingCount(): number {
    return this.waiting;
  }

  run<T>(
    start: () => ScheduledGitProcess<T>,
    options?: { priority?: GitProcessPriority },
  ): Promise<T> {
    this.waiting += 1;
    return new Promise<T>((resolve, reject) => {
      this.queues[options?.priority ?? "normal"].push(() => this.execute(start, resolve, reject));
      if (this.admitted === 0 && !this.drainScheduled) {
        this.drainOne();
      } else {
        this.scheduleDrain();
      }
    });
  }

  private canReserveStart(): boolean {
    return this.admitted < this.policy.maxProcessConcurrency && this.waiting > this.reservedStarts;
  }

  private scheduleDrain(): void {
    if (this.drainScheduled || !this.canReserveStart()) {
      return;
    }
    this.drainScheduled = true;
    scheduleImmediate(() => this.drainOne());
  }

  private drainOne(): void {
    this.drainScheduled = false;
    if (!this.canReserveStart()) {
      return;
    }
    this.admitted += 1;
    this.reservedStarts += 1;
    void this.startThrottled();
    // Spawning can be synchronous and expensive on a throttled host. Let timers,
    // sockets, and child exits run before admitting another Git process.
    this.scheduleDrain();
  }

  private startNext(): Promise<void> {
    this.reservedStarts -= 1;
    // Every reservation is backed by a queued job: jobs leave the queues only here.
    const next =
      this.queues.high.shift() ?? this.queues.normal.shift() ?? this.queues.background.shift();
    if (!next) {
      throw new Error("Git process start fired without a queued process");
    }
    return next();
  }

  private async execute<T>(
    start: () => ScheduledGitProcess<T>,
    resolve: (value: T | PromiseLike<T>) => void,
    reject: (reason?: unknown) => void,
  ): Promise<void> {
    this.waiting = Math.max(0, this.waiting - 1);
    this.running += 1;
    try {
      const process = start();
      void process.result.then(resolve, reject);
      await process.exited;
    } catch (error) {
      reject(error);
    } finally {
      this.running = Math.max(0, this.running - 1);
      this.admitted = Math.max(0, this.admitted - 1);
      this.scheduleDrain();
    }
  }
}
