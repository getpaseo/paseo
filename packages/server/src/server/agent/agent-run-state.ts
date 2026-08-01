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
  state: "awaiting_result" | "unowned_fence";
}

interface AgentGenerationState {
  run: TrackedAgentRun | null;
  invalidatedRuns: Map<string, InvalidatedPendingRun>;
  identifiedLifecycleEvents: Map<string, AgentStreamEvent[]>;
  quarantinedLifecycleEvents: AgentStreamEvent[];
}

export interface ForegroundRunAgentState {
  foregroundTurnWaiters: Set<ForegroundTurnWaiter>;
  finalizedForegroundTurnIds: Set<string>;
}

export class AgentRunState {
  private readonly agentGenerations = new Map<string, AgentGenerationState>();
  private readonly stagedEventOrder = new WeakMap<AgentStreamEvent, number>();
  private nextStagedEventOrder = 0;

  createPendingRun(agentId: string, replacement: boolean): PendingForegroundRun {
    const pendingRun = createPendingForegroundRun(replacement);
    this.getOrCreateGenerationState(agentId).run = pendingRun;
    return pendingRun;
  }

  getPendingRun(agentId: string): PendingForegroundRun | null {
    const run = this.agentGenerations.get(agentId)?.run;
    return run?.kind === "foreground" ? run : null;
  }

  hasPendingRun(agentId: string): boolean {
    return this.getPendingRun(agentId) !== null;
  }

  getRun(agentId: string): TrackedAgentRun | null {
    return this.agentGenerations.get(agentId)?.run ?? null;
  }

  isPendingRun(agentId: string, token: string): boolean {
    const run = this.agentGenerations.get(agentId)?.run;
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

    const state = this.agentGenerations.get(agentId);
    const run = state?.run;
    if (isTurnLifecycleEvent(event)) {
      return this.stagePendingLifecycleEvent(
        state ?? undefined,
        run ?? undefined,
        event,
        options.terminal,
      );
    }
    if (run?.kind !== "foreground" || run.started) {
      return false;
    }

    this.stageEvent(run.stagedEvents, event);
    return true;
  }

  bindPendingRun(agentId: string, token: string, turnId: string): AgentStreamEvent[] | null {
    const state = this.agentGenerations.get(agentId);
    const run = state?.run;
    if (!state || run?.kind !== "foreground" || run.token !== token) {
      return null;
    }

    run.started = true;
    run.turnId = turnId;
    const events = this.mergeStagedEvents(
      run.stagedEvents.splice(0),
      this.takeIdentifiedLifecycleEvents(state, turnId),
    );
    if (state.invalidatedRuns.size === 0) {
      state.quarantinedLifecycleEvents.length = 0;
      state.identifiedLifecycleEvents.clear();
    }
    return events.map((event) => attachBoundTurnIdentity(event, turnId));
  }

  hasRun(agentId: string): boolean {
    return (this.agentGenerations.get(agentId)?.run ?? null) !== null;
  }

  trackAutonomousRun(agentId: string, turnId: string | null): TrackedAgentRun {
    const state = this.getOrCreateGenerationState(agentId);
    const current = state.run;
    if (current) {
      return current;
    }

    const run: AutonomousAgentRun = {
      ...createTrackedRunState(),
      kind: "autonomous",
      turnId,
      started: true,
    };
    state.run = run;
    return run;
  }

  settleTerminalRun(agentId: string, turnId: string | undefined): void {
    const state = this.agentGenerations.get(agentId);
    const run = state?.run;
    if (!state || !run) {
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

    this.clearRun(agentId, state, run);
    // An owned terminal is ordered after earlier provider lifecycle, so rejected generations
    // can no longer emit events that need a fence.
    this.releaseUnownedFences(agentId, state);
  }

  settleForegroundRun(agentId: string, token: string): boolean {
    const state = this.agentGenerations.get(agentId);
    const run = state?.run;
    if (!state || run?.kind !== "foreground" || run.token !== token) {
      return false;
    }

    this.clearRun(agentId, state, run);
    this.clearLifecycleEventsWithoutInvalidatedRuns(agentId, state);
    return true;
  }

  invalidatePendingRun(agentId: string, token: string): boolean {
    const state = this.agentGenerations.get(agentId);
    const run = state?.run;
    if (!state || run?.kind !== "foreground" || run.token !== token || run.started) {
      return false;
    }

    state.invalidatedRuns.set(token, {
      state: "awaiting_result",
    });
    for (const event of run.stagedEvents.splice(0)) {
      if (isTurnLifecycleEvent(event)) {
        this.stageEvent(state.quarantinedLifecycleEvents, event);
      }
    }
    this.clearRun(agentId, state, run);
    return true;
  }

  takeInvalidatedPendingRunEvents(
    agentId: string,
    token: string,
    turnId: string,
  ): AgentStreamEvent[] | null {
    const state = this.agentGenerations.get(agentId);
    const invalidatedRun = state?.invalidatedRuns.get(token);
    if (!state || !invalidatedRun) {
      return null;
    }

    state.invalidatedRuns.delete(token);
    const identifiedEvents = this.takeIdentifiedLifecycleEvents(state, turnId);
    if (state.invalidatedRuns.size === 0) {
      state.quarantinedLifecycleEvents.length = 0;
      if (state.run?.kind !== "foreground" || state.run.started) {
        state.identifiedLifecycleEvents.clear();
      }
    }
    this.deleteGenerationStateIfEmpty(agentId, state);
    return identifiedEvents.map((event) => attachBoundTurnIdentity(event, turnId));
  }

  rejectInvalidatedPendingRun(agentId: string, token: string): boolean {
    const state = this.agentGenerations.get(agentId);
    const invalidatedRun = state?.invalidatedRuns.get(token);
    if (!state || !invalidatedRun) {
      return false;
    }
    if (invalidatedRun.state === "unowned_fence") {
      return true;
    }

    invalidatedRun.state = "unowned_fence";
    return true;
  }

  clearAgentRun(agentId: string): void {
    const state = this.agentGenerations.get(agentId);
    const run = state?.run;
    if (run) {
      settleTrackedRun(run);
    }
    this.agentGenerations.delete(agentId);
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

  private clearRun(agentId: string, state: AgentGenerationState, run: TrackedAgentRun): void {
    if (state.run === run) {
      state.run = null;
    }
    settleTrackedRun(run);
    this.deleteGenerationStateIfEmpty(agentId, state);
  }

  private stagePendingLifecycleEvent(
    state: AgentGenerationState | undefined,
    run: TrackedAgentRun | undefined,
    event: AgentStreamEvent,
    terminal: boolean,
  ): boolean {
    const eventTurnId = getAgentStreamEventTurnId(event);
    if (eventTurnId !== undefined) {
      return this.stagePendingIdentifiedLifecycleEvent(state, run, event, eventTurnId, terminal);
    }

    if (state && state.invalidatedRuns.size > 0) {
      this.stageEvent(state.quarantinedLifecycleEvents, event);
      return true;
    }
    if (run?.kind !== "foreground" || run.started) {
      return false;
    }

    this.stageEvent(run.stagedEvents, event);
    return true;
  }

  private stagePendingIdentifiedLifecycleEvent(
    state: AgentGenerationState | undefined,
    run: TrackedAgentRun | undefined,
    event: AgentStreamEvent,
    turnId: string,
    terminal: boolean,
  ): boolean {
    if (run?.kind === "foreground" && run.started && turnId === run.turnId) {
      return false;
    }
    if (!state) {
      return false;
    }

    this.observePendingTurnLifecycle(state, run, event, turnId, terminal);
    if (run?.kind !== "foreground" && state.invalidatedRuns.size === 0) {
      return false;
    }

    this.stageIdentifiedLifecycleEvent(state, turnId, event);
    return true;
  }

  private observePendingTurnLifecycle(
    state: AgentGenerationState,
    run: TrackedAgentRun | undefined,
    event: AgentStreamEvent,
    turnId: string,
    terminal: boolean,
  ): void {
    if (run?.kind !== "foreground" || run.started || state.invalidatedRuns.size > 0) {
      return;
    }
    if (event.type === "turn_started" && run.observedTurnId === null) {
      run.observedTurnId = turnId;
    } else if (terminal && run.observedTurnId === turnId) {
      settleTrackedRun(run);
    }
  }

  private releaseUnownedFences(agentId: string, state: AgentGenerationState): void {
    for (const [token, invalidatedRun] of state.invalidatedRuns) {
      if (invalidatedRun.state === "unowned_fence") {
        state.invalidatedRuns.delete(token);
      }
    }
    this.clearLifecycleEventsWithoutInvalidatedRuns(agentId, state);
  }

  private clearLifecycleEventsWithoutInvalidatedRuns(
    agentId: string,
    state: AgentGenerationState,
  ): void {
    if (state.invalidatedRuns.size > 0) {
      return;
    }

    state.identifiedLifecycleEvents.clear();
    state.quarantinedLifecycleEvents.length = 0;
    this.deleteGenerationStateIfEmpty(agentId, state);
  }

  private stageIdentifiedLifecycleEvent(
    state: AgentGenerationState,
    turnId: string,
    event: AgentStreamEvent,
  ): void {
    const events = state.identifiedLifecycleEvents.get(turnId) ?? [];
    this.stageEvent(events, event);
    state.identifiedLifecycleEvents.set(turnId, events);
  }

  private takeIdentifiedLifecycleEvents(
    state: AgentGenerationState,
    turnId: string,
  ): AgentStreamEvent[] {
    const events = state.identifiedLifecycleEvents.get(turnId) ?? [];
    state.identifiedLifecycleEvents.delete(turnId);
    return events;
  }

  private getOrCreateGenerationState(agentId: string): AgentGenerationState {
    const existing = this.agentGenerations.get(agentId);
    if (existing) {
      return existing;
    }

    const state: AgentGenerationState = {
      run: null,
      invalidatedRuns: new Map(),
      identifiedLifecycleEvents: new Map(),
      quarantinedLifecycleEvents: [],
    };
    this.agentGenerations.set(agentId, state);
    return state;
  }

  private deleteGenerationStateIfEmpty(agentId: string, state: AgentGenerationState): void {
    if (
      state.run === null &&
      state.invalidatedRuns.size === 0 &&
      state.identifiedLifecycleEvents.size === 0 &&
      state.quarantinedLifecycleEvents.length === 0
    ) {
      this.agentGenerations.delete(agentId);
    }
  }

  private stageEvent(events: AgentStreamEvent[], event: AgentStreamEvent): void {
    if (!this.stagedEventOrder.has(event)) {
      this.stagedEventOrder.set(event, this.nextStagedEventOrder++);
    }
    events.push(event);
  }

  private mergeStagedEvents(...eventGroups: AgentStreamEvent[][]): AgentStreamEvent[] {
    return eventGroups
      .flat()
      .sort(
        (left, right) =>
          (this.stagedEventOrder.get(left) ?? 0) - (this.stagedEventOrder.get(right) ?? 0),
      );
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

function isTurnLifecycleEvent(event: AgentStreamEvent): boolean {
  return event.type === "turn_started" || isTurnTerminalEvent(event);
}

function isTurnTerminalEvent(event: AgentStreamEvent): boolean {
  return (
    event.type === "turn_completed" ||
    event.type === "turn_failed" ||
    event.type === "turn_canceled"
  );
}

function attachBoundTurnIdentity(event: AgentStreamEvent, turnId: string): AgentStreamEvent {
  if (getAgentStreamEventTurnId(event) !== undefined) {
    return event;
  }

  switch (event.type) {
    case "turn_started":
    case "turn_completed":
    case "turn_failed":
    case "turn_canceled":
    case "usage_updated":
    case "timeline":
    case "permission_requested":
    case "permission_resolved":
      return { ...event, turnId };
    default:
      return event;
  }
}
