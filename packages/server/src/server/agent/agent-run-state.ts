import { randomUUID } from "node:crypto";

import { getAgentStreamEventTurnId, type AgentStreamEvent } from "./agent-sdk-types.js";

export interface ForegroundTurnWaiter {
  turnId: string;
  callback: (event: AgentStreamEvent) => void;
  settled: boolean;
  settledPromise: Promise<void>;
  resolveSettled: () => void;
}

type ForegroundRunStart =
  | { status: "pending" }
  | { status: "started"; turnId: string }
  | { status: "failed"; error: string; stale?: true };

export interface PendingForegroundRun {
  token: string;
  kind: "foreground";
  stagedEvents: AgentStreamEvent[];
  start: ForegroundRunStart;
  turnStartedPromise: Promise<void>;
  resolveTurnStarted: () => void;
  settled: boolean;
  settledPromise: Promise<void>;
  resolveSettled: () => void;
}

export interface AutonomousAgentRun {
  token: string;
  kind: "autonomous";
  turnId: string | null;
  started: true;
  settled: boolean;
  settledPromise: Promise<void>;
  resolveSettled: () => void;
}

export type TrackedAgentRun = PendingForegroundRun | AutonomousAgentRun;

export interface ForegroundRunAgentState {
  foregroundTurnWaiters: Set<ForegroundTurnWaiter>;
  finalizedForegroundTurnIds: Set<string>;
}

export class AgentRunState {
  private readonly runs = new Map<string, TrackedAgentRun>();

  createPendingRun(agentId: string): PendingForegroundRun {
    const pendingRun = createPendingForegroundRun();
    this.runs.set(agentId, pendingRun);
    return pendingRun;
  }

  getPendingRun(agentId: string): PendingForegroundRun | null {
    const run = this.runs.get(agentId);
    return run?.kind === "foreground" ? run : null;
  }

  settleForegroundStart(
    run: PendingForegroundRun,
    start: Exclude<ForegroundRunStart, { status: "pending" }>,
  ): void {
    run.start = start;
    if (start.status === "started") {
      run.resolveTurnStarted();
    }
  }

  /**
   * Resolves once the agent's foreground run has a turn id or has ended. A failed start
   * resolves only once its run is cleared, so callers never see a failed run still tracked.
   */
  async waitForForegroundStart(agentId: string): Promise<void> {
    const run = this.getPendingRun(agentId);
    if (run?.start.status !== "pending") {
      return;
    }
    await Promise.race([run.turnStartedPromise, run.settledPromise]);
  }

  hasPendingRun(agentId: string): boolean {
    return this.getPendingRun(agentId) !== null;
  }

  getRun(agentId: string): TrackedAgentRun | null {
    return this.runs.get(agentId) ?? null;
  }

  hasRun(agentId: string): boolean {
    return this.runs.has(agentId);
  }

  getTurnId(agentId: string): string | null {
    const run = this.runs.get(agentId);
    if (!run) return null;
    if (run.kind === "autonomous") return run.turnId;
    return run.start.status === "started" ? run.start.turnId : null;
  }

  trackAutonomousRun(agentId: string, turnId: string | null): TrackedAgentRun {
    const current = this.runs.get(agentId);
    if (current) {
      return current;
    }

    const run: AutonomousAgentRun = {
      ...createTrackedRunState(),
      kind: "autonomous",
      turnId,
      started: true,
    };
    this.runs.set(agentId, run);
    return run;
  }

  settleTerminalRun(agentId: string, turnId: string | undefined): void {
    const run = this.runs.get(agentId);
    if (!run) {
      return;
    }
    if (
      run.kind === "foreground" &&
      (run.start.status !== "started" || run.start.turnId !== turnId)
    ) {
      return;
    }
    if (
      run.kind === "autonomous" &&
      run.turnId !== null &&
      turnId !== undefined &&
      run.turnId !== turnId
    ) {
      return;
    }

    this.clearRun(agentId, run);
  }

  settleForegroundRun(agentId: string, token: string): void {
    const run = this.runs.get(agentId);
    if (run?.kind !== "foreground" || run.token !== token) {
      return;
    }

    this.clearRun(agentId, run);
  }

  clearAgentRun(agentId: string): void {
    const run = this.runs.get(agentId);
    if (run) {
      this.clearRun(agentId, run);
    }
  }

  createTurnStream(turnId: string): ForegroundTurnStream {
    return new ForegroundTurnStream(turnId);
  }

  addWaiter(agent: ForegroundRunAgentState, waiter: ForegroundTurnWaiter): void {
    agent.foregroundTurnWaiters.add(waiter);
  }

  deleteWaiter(agent: ForegroundRunAgentState, waiter: ForegroundTurnWaiter): void {
    agent.foregroundTurnWaiters.delete(waiter);
    this.settleWaiter(waiter);
  }

  settleWaiter(waiter: ForegroundTurnWaiter): void {
    if (waiter.settled) {
      return;
    }
    waiter.settled = true;
    waiter.resolveSettled();
  }

  getMatchingWaiters(
    agent: ForegroundRunAgentState,
    turnId: string | undefined,
  ): ForegroundTurnWaiter[] {
    if (turnId == null) {
      return [];
    }

    return Array.from(agent.foregroundTurnWaiters).filter(
      (waiter) => waiter.turnId === turnId && !waiter.settled,
    );
  }

  notifyWaiters(
    waiters: Iterable<ForegroundTurnWaiter>,
    event: AgentStreamEvent,
    options: { terminal: boolean },
  ): void {
    for (const waiter of waiters) {
      waiter.callback(event);
      if (options.terminal) {
        this.settleWaiter(waiter);
      }
    }
  }

  notifyAgentWaiters(
    agent: ForegroundRunAgentState,
    event: AgentStreamEvent,
    options?: { terminal?: boolean },
  ): void {
    const waiters = this.getMatchingWaiters(agent, getAgentStreamEventTurnId(event));
    this.notifyWaiters(waiters, event, { terminal: options?.terminal ?? false });
  }

  cancelWaiters(
    agent: ForegroundRunAgentState,
    createEvent: (turnId: string) => AgentStreamEvent,
  ): void {
    for (const waiter of agent.foregroundTurnWaiters) {
      waiter.callback(createEvent(waiter.turnId));
      this.settleWaiter(waiter);
    }
    agent.foregroundTurnWaiters.clear();
  }

  rememberFinalizedTurn(agent: ForegroundRunAgentState, turnId: string): void {
    agent.finalizedForegroundTurnIds.add(turnId);
    if (agent.finalizedForegroundTurnIds.size <= 50) {
      return;
    }

    const oldest = agent.finalizedForegroundTurnIds.values().next().value;
    if (oldest) {
      agent.finalizedForegroundTurnIds.delete(oldest);
    }
  }

  hasFinalizedTurn(agent: ForegroundRunAgentState, turnId: string): boolean {
    return agent.finalizedForegroundTurnIds.has(turnId);
  }

  private clearRun(agentId: string, run: TrackedAgentRun): void {
    this.runs.delete(agentId);
    settleTrackedRun(run);
  }
}

export class ForegroundTurnStream {
  private readonly queue: AgentStreamEvent[] = [];
  private queueResolve: (() => void) | null = null;

  readonly waiter: ForegroundTurnWaiter;

  constructor(turnId: string) {
    let resolveSettled!: () => void;
    const settledPromise = new Promise<void>((resolvePromise) => {
      resolveSettled = resolvePromise;
    });

    this.waiter = {
      turnId,
      settled: false,
      settledPromise,
      resolveSettled,
      callback: (event) => {
        this.queue.push(event);
        this.wake();
      },
    };
  }

  async *events(
    isTerminalEvent: (event: AgentStreamEvent) => boolean,
  ): AsyncGenerator<AgentStreamEvent> {
    let done = false;
    while (!done) {
      while (this.queue.length > 0) {
        const event = this.queue.shift()!;
        yield event;
        if (isTerminalEvent(event)) {
          done = true;
          break;
        }
      }

      if (!done && this.queue.length === 0) {
        if (this.waiter.settled) {
          break;
        }
        await new Promise<void>((resolvePromise) => {
          this.queueResolve = resolvePromise;
        });
      }
    }
  }

  private wake(): void {
    if (!this.queueResolve) {
      return;
    }

    this.queueResolve();
    this.queueResolve = null;
  }
}

function createPendingForegroundRun(): PendingForegroundRun {
  let resolveTurnStarted!: () => void;
  const turnStartedPromise = new Promise<void>((resolvePromise) => {
    resolveTurnStarted = resolvePromise;
  });
  return {
    ...createTrackedRunState(),
    kind: "foreground",
    start: { status: "pending" },
    turnStartedPromise,
    resolveTurnStarted,
    stagedEvents: [],
  };
}

function createTrackedRunState(): {
  token: string;
  settled: boolean;
  settledPromise: Promise<void>;
  resolveSettled: () => void;
} {
  let resolveSettled!: () => void;
  const settledPromise = new Promise<void>((resolvePromise) => {
    resolveSettled = resolvePromise;
  });
  return {
    token: randomUUID(),
    settled: false,
    settledPromise,
    resolveSettled,
  };
}

function settleTrackedRun(run: TrackedAgentRun): void {
  if (run.settled) {
    return;
  }

  run.settled = true;
  run.resolveSettled();
}

/**
 * Follows one sender's prompt to the foreground run that starts it. Each run created for the
 * prompt, including a stale-session retry, is bound here, so `started` settles for this
 * sender's prompt and never for another run the agent tracks.
 */
export class ForegroundPromptStart {
  readonly started: Promise<void>;
  private resolveStarted!: () => void;
  private rejectStarted!: (error: Error) => void;
  private run: PendingForegroundRun | null = null;
  private done = false;

  constructor(
    private readonly agentId: string,
    readonly admit?: () => boolean,
  ) {
    this.started = new Promise<void>((resolve, reject) => {
      this.resolveStarted = resolve;
      this.rejectStarted = reject;
    });
    // Steered and fire-and-forget dispatches never wait on the start.
    this.started.catch(() => undefined);
  }

  /** A run was created for this prompt. */
  bind(run: PendingForegroundRun): void {
    this.run = run;
    void Promise.race([run.turnStartedPromise, run.settledPromise]).then(() =>
      this.settle(run, { ended: false }),
    );
  }

  /** The prompt's dispatch is over; no further run will be created for it. */
  end(): void {
    this.settle(this.run, { ended: true });
  }

  private settle(run: PendingForegroundRun | null, { ended }: { ended: boolean }): void {
    if (this.done || run !== this.run) return;
    if (run?.start.status === "started") {
      this.done = true;
      this.resolveStarted();
      return;
    }
    // A stale-session failure is retried with a new run; wait for it unless dispatch ended.
    if (run?.start.status === "failed" && run.start.stale && !ended) return;
    this.done = true;
    this.rejectStarted(new Error(this.describeUnstarted(run)));
  }

  private describeUnstarted(run: PendingForegroundRun | null): string {
    if (run?.start.status === "failed") return run.start.error;
    if (run?.settled) {
      return `Agent ${this.agentId} run was canceled before its turn started; its prompt was not delivered`;
    }
    return `Agent ${this.agentId} run finished before starting`;
  }
}
