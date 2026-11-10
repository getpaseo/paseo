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

export class GitProcessScheduler {
  private readonly startThrottled;
  private readonly queues: Record<GitProcessPriority, Array<() => void>> = {
    high: [],
    normal: [],
    background: [],
  };
  private admitted = 0;
  private running = 0;
  private waiting = 0;
  private drainScheduled = false;

  constructor(readonly policy: GitProcessPolicy) {
    const throttle = pThrottle({
      limit: policy.maxProcessesPerSecond,
      interval: 1_000,
      strict: true,
    });
    this.startThrottled = throttle((start: () => Promise<void>) => start());
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
      const admit = () => {
        void this.startThrottled(() => this.execute(start, resolve, reject)).catch((error) => {
          this.waiting = Math.max(0, this.waiting - 1);
          this.admitted = Math.max(0, this.admitted - 1);
          reject(error);
          this.scheduleDrain();
        });
      };
      this.queues[options?.priority ?? "normal"].push(admit);
      if (this.admitted === 0 && !this.drainScheduled) {
        this.drainOne();
      } else {
        this.scheduleDrain();
      }
    });
  }

  private scheduleDrain(): void {
    if (this.drainScheduled || this.admitted >= this.policy.maxProcessConcurrency) {
      return;
    }
    if (!this.hasQueuedWork()) {
      return;
    }
    this.drainScheduled = true;
    scheduleImmediate(() => this.drainOne());
  }

  private hasQueuedWork(): boolean {
    return (
      this.queues.high.length > 0 ||
      this.queues.normal.length > 0 ||
      this.queues.background.length > 0
    );
  }

  private drainOne(): void {
    this.drainScheduled = false;
    if (this.admitted >= this.policy.maxProcessConcurrency) {
      return;
    }
    const admit =
      this.queues.high.shift() ?? this.queues.normal.shift() ?? this.queues.background.shift();
    if (!admit) {
      return;
    }
    this.admitted += 1;
    admit();
    // Spawning can be synchronous and expensive on a throttled host. Let timers,
    // sockets, and child exits run before admitting another Git process.
    this.scheduleDrain();
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
