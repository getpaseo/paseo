import { randomUUID } from "node:crypto";

import { getAgentStreamEventTurnId, type AgentStreamEvent } from "./agent-sdk-types.js";

export interface ForegroundTurnWaiter {
  turnId: string;
  callback: (event: AgentStreamEvent) => void;
  settled: boolean;
  settledPromise: Promise<void>;
  resolveSettled: () => void;
}

export interface PendingForegroundRun {
  token: string;
  kind: "foreground";
  replacement: boolean;
  stagedEvents: AgentStreamEvent[];
  observedTurnId: string | null;
  turnId: string | null;
  started: boolean;
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

interface InvalidatedPendingRun {
  stagedLifecycleEvents: AgentStreamEvent[];
}

export interface ForegroundRunAgentState {
  foregroundTurnWaiters: Set<ForegroundTurnWaiter>;
  finalizedForegroundTurnIds: Set<string>;
}

export class AgentRunState {
  private readonly runs = new Map<string, TrackedAgentRun>();
  private readonly invalidatedPendingRuns = new Map<string, Map<string, InvalidatedPendingRun>>();

  createPendingRun(agentId: string, replacement: boolean): PendingForegroundRun {
    const pendingRun = createPendingForegroundRun(replacement);
    this.runs.set(agentId, pendingRun);
    return pendingRun;
  }

  getPendingRun(agentId: string): PendingForegroundRun | null {
    const run = this.runs.get(agentId);
    return run?.kind === "foreground" ? run : null;
  }

  hasPendingRun(agentId: string): boolean {
    return this.getPendingRun(agentId) !== null;
  }

  getRun(agentId: string): TrackedAgentRun | null {
    return this.runs.get(agentId) ?? null;
  }

  isPendingRun(agentId: string, token: string): boolean {
    const run = this.runs.get(agentId);
    return run?.kind === "foreground" && run.token === token;
  }

  stagePendingRunEvent(
    agentId: string,
    event: AgentStreamEvent,
    options: { terminal: boolean; finalized: boolean },
  ): boolean {
    if (options.finalized) {
      return true;
    }

    const run = this.runs.get(agentId);
    const eventTurnId = getAgentStreamEventTurnId(event);
    if (run?.kind === "foreground" && run.started && eventTurnId === run.turnId) {
      return false;
    }

    const invalidatedRun = this.invalidatedPendingRuns.get(agentId)?.values().next().value;
    if (invalidatedRun && (event.type === "turn_started" || options.terminal)) {
      invalidatedRun.stagedLifecycleEvents.push(event);
      return true;
    }

    if (run?.kind !== "foreground" || run.started) {
      return false;
    }

    run.stagedEvents.push(event);
    if (event.type === "turn_started" && eventTurnId && run.observedTurnId === null) {
      run.observedTurnId = eventTurnId;
    } else if (options.terminal && eventTurnId === run.observedTurnId) {
      settleTrackedRun(run);
    }
    return true;
  }

  bindPendingRun(agentId: string, token: string, turnId: string): AgentStreamEvent[] | null {
    const run = this.runs.get(agentId);
    if (run?.kind !== "foreground" || run.token !== token) {
      return null;
    }

    run.started = true;
    run.turnId = turnId;
    return run.stagedEvents.splice(0);
  }

  hasRun(agentId: string): boolean {
    return this.runs.has(agentId);
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
    if (run.kind === "foreground" && (run.turnId === null || run.turnId !== turnId)) {
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

  settleForegroundRun(agentId: string, token: string): boolean {
    const run = this.runs.get(agentId);
    if (run?.kind !== "foreground" || run.token !== token) {
      return false;
    }

    this.clearRun(agentId, run);
    return true;
  }

  invalidatePendingRun(agentId: string, token: string): boolean {
    const run = this.runs.get(agentId);
    if (run?.kind !== "foreground" || run.token !== token || run.started) {
      return false;
    }

    this.clearRun(agentId, run);
    const invalidatedRuns = this.invalidatedPendingRuns.get(agentId) ?? new Map();
    invalidatedRuns.set(token, { stagedLifecycleEvents: [] });
    this.invalidatedPendingRuns.set(agentId, invalidatedRuns);
    return true;
  }

  takeInvalidatedPendingRunEvents(agentId: string, token: string): AgentStreamEvent[] | null {
    const invalidatedRuns = this.invalidatedPendingRuns.get(agentId);
    const invalidatedRun = invalidatedRuns?.get(token);
    if (!invalidatedRuns || !invalidatedRun) {
      return null;
    }

    invalidatedRuns.delete(token);
    if (invalidatedRuns.size === 0) {
      this.invalidatedPendingRuns.delete(agentId);
    }
    return invalidatedRun.stagedLifecycleEvents;
  }

  clearAgentRun(agentId: string): void {
    const run = this.runs.get(agentId);
    if (run) {
      this.clearRun(agentId, run);
    }
    this.invalidatedPendingRuns.delete(agentId);
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

function createPendingForegroundRun(replacement: boolean): PendingForegroundRun {
  return {
    ...createTrackedRunState(),
    kind: "foreground",
    replacement,
    observedTurnId: null,
    turnId: null,
    started: false,
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
