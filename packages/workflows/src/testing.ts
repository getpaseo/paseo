import type {
  AcceptWorkflowRunInput,
  AcceptWorkflowRunResult,
  ActiveAuthLease,
  AgentRunner,
  AgentStepRequest,
  AgentStepStartResult,
  BeginStepAttemptInput,
  Clock,
  CompleteStepAttemptInput,
  GateResolution,
  GateSink,
  IntegrationConnectionRecord,
  IntegrationConnections,
  IntegrationStorage,
  IntegrationStorageEntry,
  JsonValue,
  ListOpenGatesFilter,
  ListRunsFilter,
  OpenGateInput,
  PublishedWorkflowOutput,
  StepAttemptRecord,
  StepWaitSpec,
  SuspendedWaitRecord,
  TransitionRunInput,
  WorkflowGateRecord,
  WorkflowRunSnapshot,
  WorkflowStore,
} from "./index.js";

export interface FakeClock extends Clock {
  advance(ms: number): Date;
  set(date: Date | string | number): Date;
}

/** Deterministic clock for tests and local simulation. */
export function createFakeClock(
  initial: Date | string | number = "2026-01-01T00:00:00.000Z",
): FakeClock {
  let currentMs = new Date(initial).getTime();
  return {
    now(): Date {
      return new Date(currentMs);
    },
    advance(ms: number): Date {
      if (!Number.isFinite(ms) || ms < 0) {
        throw new Error("FakeClock.advance requires a non-negative finite ms value");
      }
      currentMs += ms;
      return new Date(currentMs);
    },
    set(date: Date | string | number): Date {
      currentMs = new Date(date).getTime();
      return new Date(currentMs);
    },
  };
}

/** In-memory scoped `IntegrationStorage` with real TTL expiry and serialized locking. */
export function createMemoryIntegrationStorage(clock?: Clock): IntegrationStorage {
  const nowMs = (): number => (clock === undefined ? Date.now() : clock.now().getTime());
  const records = new Map<string, { value: JsonValue; expiresAt?: number }>();
  const lockChains = new Map<string, Promise<void>>();

  const isExpired = (entry: { expiresAt?: number }): boolean =>
    entry.expiresAt !== undefined && nowMs() >= entry.expiresAt;

  return {
    async get<T extends JsonValue = JsonValue>(key: string): Promise<T | undefined> {
      const entry = records.get(key);
      if (entry === undefined || isExpired(entry)) {
        records.delete(key);
        return undefined;
      }
      return structuredClone(entry.value) as T;
    },
    async set(key: string, value: JsonValue, options?: { readonly ttlMs?: number }): Promise<void> {
      const expiresAt = options?.ttlMs !== undefined ? nowMs() + options.ttlMs : undefined;
      records.set(key, { value: structuredClone(value), expiresAt });
    },
    async delete(key: string): Promise<void> {
      records.delete(key);
    },
    async list(prefix = ""): Promise<readonly IntegrationStorageEntry[]> {
      const out: IntegrationStorageEntry[] = [];
      for (const [key, entry] of records.entries()) {
        if (isExpired(entry)) {
          records.delete(key);
          continue;
        }
        if (key.startsWith(prefix)) {
          out.push({ key, value: structuredClone(entry.value) });
        }
      }
      return out;
    },
    async withLock<T>(key: string, _ttlMs: number, fn: () => Promise<T>): Promise<T> {
      const prior = lockChains.get(key) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = prior.then(() => current);
      lockChains.set(key, tail);
      await prior;
      try {
        return await fn();
      } finally {
        release();
        if (lockChains.get(key) === tail) {
          lockChains.delete(key);
        }
      }
    },
  };
}

/** In-memory `IntegrationConnections` registry for tests and local daemon runs. */
export function createMemoryIntegrationConnections(
  initial: readonly IntegrationConnectionRecord[] = [],
): IntegrationConnections {
  const list = initial.map((item) => structuredClone(item));
  return {
    async get(connectionNameOrId: string): Promise<IntegrationConnectionRecord | undefined> {
      const found = list.find(
        (item) => item.id === connectionNameOrId || item.name === connectionNameOrId,
      );
      return found === undefined ? undefined : structuredClone(found);
    },
    async list(): Promise<readonly IntegrationConnectionRecord[]> {
      return list.map((item) => structuredClone(item));
    },
  };
}

export interface FakeGateSink extends GateSink {
  readonly opened: WorkflowGateRecord[];
  readonly resolved: WorkflowGateRecord[];
  readonly expired: WorkflowGateRecord[];
}

/** Records all gate lifecycle notifications without mocks. */
export function createFakeGateSink(): FakeGateSink {
  const opened: WorkflowGateRecord[] = [];
  const resolved: WorkflowGateRecord[] = [];
  const expired: WorkflowGateRecord[] = [];
  return {
    opened,
    resolved,
    expired,
    async onGateOpened(gate: WorkflowGateRecord): Promise<void> {
      opened.push(structuredClone(gate));
    },
    async onGateResolved(gate: WorkflowGateRecord): Promise<void> {
      resolved.push(structuredClone(gate));
    },
    async onGateExpired(gate: WorkflowGateRecord): Promise<void> {
      expired.push(structuredClone(gate));
    },
  };
}

export type FakeAgentHandler = (
  request: AgentStepRequest,
) => Promise<AgentStepStartResult> | AgentStepStartResult;

export interface CancelledAgentRecord {
  readonly executionId: string;
  readonly reason: string;
}

export interface FakeAgentRunner extends AgentRunner {
  readonly requests: AgentStepRequest[];
  readonly cancelled: CancelledAgentRecord[];
  setHandler(handler: FakeAgentHandler): void;
}

/** Programmable fake `AgentRunner` with full call recording and zero mocks. */
export function createFakeAgentRunner(initialHandler?: FakeAgentHandler): FakeAgentRunner {
  const requests: AgentStepRequest[] = [];
  const cancelled: CancelledAgentRecord[] = [];
  let handler: FakeAgentHandler =
    initialHandler ??
    (() => ({
      status: "completed",
      outcome: "ok",
    }));

  return {
    requests,
    cancelled,
    setHandler(next: FakeAgentHandler): void {
      handler = next;
    },
    async start(request: AgentStepRequest): Promise<AgentStepStartResult> {
      requests.push(structuredClone(request));
      return handler(request);
    },
    async cancel(executionId: string, reason: string): Promise<void> {
      cancelled.push({ executionId, reason });
    },
  };
}

interface MutableRun {
  id: string;
  workflowId: string;
  status: WorkflowRunSnapshot["status"];
  pausedFromStatus?: "running" | "waiting";
  subjectKey?: string;
  subjectData: WorkflowRunSnapshot["subjectData"];
  inputs: Record<string, JsonValue>;
  event?: WorkflowRunSnapshot["event"];
  currentState: string;
  loopCounts: Record<string, number>;
  attempts: MutableAttempt[];
  lastGate?: WorkflowRunSnapshot["lastGate"];
  terminalReason?: string;
  terminalOutputs?: WorkflowRunSnapshot["terminalOutputs"];
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}

interface MutableAttempt {
  id: string;
  runId: string;
  stepId: string;
  attempt: number;
  executionId: string;
  status: StepAttemptRecord["status"];
  outcome?: string;
  output?: StepAttemptRecord["output"];
  error?: string;
  wait?: StepWaitSpec;
  activeLeases: ActiveAuthLease[];
  startedAt: Date;
  finishedAt?: Date;
}

interface MutableGate {
  id: string;
  runId: string;
  workflowId: string;
  stepId: string;
  attemptId: string;
  title: string;
  summary?: string;
  recommended?: string;
  choices: WorkflowGateRecord["choices"];
  status: WorkflowGateRecord["status"];
  openedAt: Date;
  expiresAt?: Date;
  resolution?: GateResolution;
}

function isTerminalStatus(status: WorkflowRunSnapshot["status"]): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

function cloneRun(run: MutableRun): WorkflowRunSnapshot {
  return structuredClone(run);
}

function cloneAttempt(attempt: MutableAttempt): StepAttemptRecord {
  return structuredClone(attempt);
}

function cloneGate(gate: MutableGate): WorkflowGateRecord {
  return structuredClone(gate);
}

/**
 * Full in-memory implementation of `WorkflowStore`.
 * Suitable both for zero-mock unit/contract tests and as the foundation for local daemon execution.
 */
export function createMemoryWorkflowStore(): WorkflowStore {
  let runSeq = 0;
  let attemptSeq = 0;
  let gateSeq = 0;

  const runs = new Map<string, MutableRun>();
  const attemptsById = new Map<string, MutableAttempt>();
  const gates = new Map<string, MutableGate>();
  const outputs = new Map<string, PublishedWorkflowOutput>();

  const outputMapKey = (workflowId: string, outputKey: string): string =>
    `${workflowId}\0${outputKey}`;

  const findActiveRunForSubject = (
    workflowId: string,
    subjectKey: string,
  ): MutableRun | undefined => {
    for (const run of runs.values()) {
      if (
        run.workflowId === workflowId &&
        run.subjectKey === subjectKey &&
        !isTerminalStatus(run.status) &&
        run.status !== "queued"
      ) {
        return run;
      }
    }
    return undefined;
  };

  return {
    async acceptRun(input: AcceptWorkflowRunInput): Promise<AcceptWorkflowRunResult> {
      const existing =
        input.subjectKey === undefined
          ? undefined
          : findActiveRunForSubject(input.workflowId, input.subjectKey);

      if (existing !== undefined) {
        const policy = input.onConflict ?? "ignore";
        if (policy === "ignore") {
          return { action: "ignored", existingRun: cloneRun(existing) };
        }
        if (policy === "signal") {
          return { action: "signal", existingRun: cloneRun(existing) };
        }
        if (policy === "queue") {
          const queuedId = `run_${++runSeq}`;
          const queued: MutableRun = {
            id: queuedId,
            workflowId: input.workflowId,
            status: "queued",
            subjectKey: input.subjectKey,
            subjectData: structuredClone(input.subjectData),
            inputs: structuredClone(input.inputs) as Record<string, JsonValue>,
            event: input.event === undefined ? undefined : structuredClone(input.event),
            currentState: input.initialState,
            loopCounts: {},
            attempts: [],
            createdAt: new Date(input.now.getTime()),
            updatedAt: new Date(input.now.getTime()),
          };
          runs.set(queuedId, queued);
          return { action: "queued", run: cloneRun(queued) };
        }
        if (policy === "cancel_previous") {
          const cancelledSnapshot = cloneRun(existing);
          existing.status = "cancelled";
          existing.terminalReason = "superseded_by_new_run";
          existing.updatedAt = new Date(input.now.getTime());
          existing.completedAt = new Date(input.now.getTime());
          for (const attempt of existing.attempts) {
            if (attempt.status === "running" || attempt.status === "waiting") {
              attempt.status = "cancelled";
              attempt.wait = undefined;
              attempt.finishedAt = new Date(input.now.getTime());
            }
          }

          const nextId = `run_${++runSeq}`;
          const nextRun: MutableRun = {
            id: nextId,
            workflowId: input.workflowId,
            status: "running",
            subjectKey: input.subjectKey,
            subjectData: structuredClone(input.subjectData),
            inputs: structuredClone(input.inputs) as Record<string, JsonValue>,
            event: input.event === undefined ? undefined : structuredClone(input.event),
            currentState: input.initialState,
            loopCounts: {},
            attempts: [],
            createdAt: new Date(input.now.getTime()),
            updatedAt: new Date(input.now.getTime()),
          };
          runs.set(nextId, nextRun);
          return { action: "replaced", run: cloneRun(nextRun), cancelledRun: cancelledSnapshot };
        }
      }

      const id = `run_${++runSeq}`;
      const run: MutableRun = {
        id,
        workflowId: input.workflowId,
        status: "running",
        subjectKey: input.subjectKey,
        subjectData: structuredClone(input.subjectData),
        inputs: structuredClone(input.inputs) as Record<string, JsonValue>,
        event: input.event === undefined ? undefined : structuredClone(input.event),
        currentState: input.initialState,
        loopCounts: {},
        attempts: [],
        createdAt: new Date(input.now.getTime()),
        updatedAt: new Date(input.now.getTime()),
      };
      runs.set(id, run);
      return { action: "started", run: cloneRun(run) };
    },

    async loadRun(runId: string): Promise<WorkflowRunSnapshot | undefined> {
      const run = runs.get(runId);
      return run === undefined ? undefined : cloneRun(run);
    },

    async listRuns(filter?: ListRunsFilter): Promise<readonly WorkflowRunSnapshot[]> {
      let statuses: Set<WorkflowRunSnapshot["status"]> | undefined;
      if (filter?.status !== undefined) {
        statuses = Array.isArray(filter.status) ? new Set(filter.status) : new Set([filter.status]);
      }
      const result: WorkflowRunSnapshot[] = [];
      for (const run of runs.values()) {
        if (filter?.workflowId !== undefined && run.workflowId !== filter.workflowId) {
          continue;
        }
        if (filter?.subjectKey !== undefined && run.subjectKey !== filter.subjectKey) {
          continue;
        }
        if (statuses !== undefined && !statuses.has(run.status)) {
          continue;
        }
        result.push(cloneRun(run));
      }
      return result;
    },

    async dequeueNextRun(
      workflowId: string,
      subjectKey: string,
      now: Date,
    ): Promise<WorkflowRunSnapshot | undefined> {
      if (findActiveRunForSubject(workflowId, subjectKey) !== undefined) {
        return undefined;
      }
      for (const run of runs.values()) {
        if (
          run.workflowId === workflowId &&
          run.subjectKey === subjectKey &&
          run.status === "queued"
        ) {
          run.status = "running";
          run.updatedAt = new Date(now.getTime());
          return cloneRun(run);
        }
      }
      return undefined;
    },

    async beginStepAttempt(input: BeginStepAttemptInput): Promise<StepAttemptRecord> {
      const run = runs.get(input.runId);
      if (run === undefined) {
        throw new Error(`run "${input.runId}" not found`);
      }
      const nextCount = (run.loopCounts[input.stepId] ?? 0) + (input.incrementLoop ? 1 : 0);
      if (input.incrementLoop) {
        run.loopCounts[input.stepId] = nextCount;
      }
      const attemptId = `att_${++attemptSeq}`;
      const attempt: MutableAttempt = {
        id: attemptId,
        runId: input.runId,
        stepId: input.stepId,
        attempt: nextCount,
        executionId: `exec_${attemptSeq}`,
        status: "running",
        activeLeases: [],
        startedAt: new Date(input.now.getTime()),
      };
      run.attempts.push(attempt);
      run.updatedAt = new Date(input.now.getTime());
      attemptsById.set(attemptId, attempt);
      return cloneAttempt(attempt);
    },

    async setAttemptLeases(attemptId: string, leases: readonly ActiveAuthLease[]): Promise<void> {
      const attempt = attemptsById.get(attemptId);
      if (attempt === undefined) {
        return;
      }
      attempt.activeLeases = leases.map((lease) => ({ ...lease }));
    },

    async setAttemptExecutionId(attemptId: string, executionId: string): Promise<void> {
      const attempt = attemptsById.get(attemptId);
      if (attempt === undefined) {
        return;
      }
      attempt.executionId = executionId;
    },

    async suspendStepAttempt(attemptId: string, wait: StepWaitSpec): Promise<void> {
      const attempt = attemptsById.get(attemptId);
      if (attempt === undefined) {
        throw new Error(`attempt "${attemptId}" not found`);
      }
      attempt.status = "waiting";
      attempt.wait = structuredClone(wait);
    },

    async completeStepAttempt(input: CompleteStepAttemptInput): Promise<WorkflowRunSnapshot> {
      const run = runs.get(input.runId);
      if (run === undefined) {
        throw new Error(`run "${input.runId}" not found`);
      }
      const attempt = attemptsById.get(input.attemptId);
      if (attempt === undefined) {
        throw new Error(`attempt "${input.attemptId}" not found`);
      }
      attempt.status = input.status;
      attempt.outcome = input.outcome;
      attempt.output = input.output === undefined ? undefined : structuredClone(input.output);
      attempt.error = input.error;
      attempt.wait = undefined;
      attempt.finishedAt = new Date(input.now.getTime());
      run.updatedAt = new Date(input.now.getTime());
      return cloneRun(run);
    },

    async transitionRun(input: TransitionRunInput): Promise<WorkflowRunSnapshot> {
      const run = runs.get(input.runId);
      if (run === undefined) {
        throw new Error(`run "${input.runId}" not found`);
      }
      run.status = input.status;
      if (input.status === "paused") {
        run.pausedFromStatus = input.pausedFromStatus;
      } else {
        run.pausedFromStatus = undefined;
      }
      if (input.currentState !== undefined) {
        run.currentState = input.currentState;
      }
      if (input.lastGate !== undefined) {
        run.lastGate = { ...input.lastGate };
      }
      if (input.terminalReason !== undefined) {
        run.terminalReason = input.terminalReason;
      }
      if (input.terminalOutputs !== undefined) {
        run.terminalOutputs = structuredClone(input.terminalOutputs);
      }
      run.updatedAt = new Date(input.now.getTime());
      if (isTerminalStatus(input.status)) {
        run.completedAt = new Date(input.now.getTime());
      }
      return cloneRun(run);
    },

    async listSuspendedWaits(
      kind?: StepWaitSpec["kind"],
      options?: { readonly includePaused?: boolean },
    ): Promise<readonly SuspendedWaitRecord[]> {
      const includePaused = options?.includePaused === true;
      const result: SuspendedWaitRecord[] = [];
      for (const attempt of attemptsById.values()) {
        if (attempt.status !== "waiting" || attempt.wait === undefined) {
          continue;
        }
        if (kind !== undefined && attempt.wait.kind !== kind) {
          continue;
        }
        const run = runs.get(attempt.runId);
        if (run === undefined) {
          continue;
        }
        if (run.status !== "waiting" && !(includePaused && run.status === "paused")) {
          continue;
        }
        result.push({
          runId: attempt.runId,
          attemptId: attempt.id,
          stepId: attempt.stepId,
          wait: structuredClone(attempt.wait),
        });
      }
      return result;
    },

    async findExpiredWaits(now: Date): Promise<readonly SuspendedWaitRecord[]> {
      const nowMs = now.getTime();
      const result: SuspendedWaitRecord[] = [];
      for (const attempt of attemptsById.values()) {
        if (attempt.status !== "waiting" || attempt.wait === undefined) {
          continue;
        }
        const run = runs.get(attempt.runId);
        if (run === undefined || run.status !== "waiting") {
          continue;
        }
        const wakeAt = attempt.wait.wakeAt;
        if (wakeAt !== undefined && wakeAt.getTime() <= nowMs) {
          result.push({
            runId: attempt.runId,
            attemptId: attempt.id,
            stepId: attempt.stepId,
            wait: structuredClone(attempt.wait),
          });
        }
      }
      return result;
    },

    async publishWorkflowOutput(
      input: PublishedWorkflowOutput,
    ): Promise<readonly SuspendedWaitRecord[]> {
      outputs.set(outputMapKey(input.workflowId, input.outputKey), structuredClone(input));
      const matched: SuspendedWaitRecord[] = [];
      for (const attempt of attemptsById.values()) {
        if (attempt.status !== "waiting" || attempt.wait?.kind !== "wait_workflow") {
          continue;
        }
        if (
          attempt.wait.workflowId !== input.workflowId ||
          attempt.wait.outputKey !== input.outputKey
        ) {
          continue;
        }
        const run = runs.get(attempt.runId);
        if (run === undefined || run.status !== "waiting") {
          continue;
        }
        matched.push({
          runId: attempt.runId,
          attemptId: attempt.id,
          stepId: attempt.stepId,
          wait: structuredClone(attempt.wait),
        });
      }
      return matched;
    },

    async findWorkflowOutput(
      workflowId: string,
      outputKey: string,
    ): Promise<PublishedWorkflowOutput | undefined> {
      const found = outputs.get(outputMapKey(workflowId, outputKey));
      return found === undefined ? undefined : structuredClone(found);
    },

    async openGate(input: OpenGateInput): Promise<WorkflowGateRecord> {
      const id = `gate_${++gateSeq}`;
      const gate: MutableGate = {
        id,
        runId: input.runId,
        workflowId: input.workflowId,
        stepId: input.stepId,
        attemptId: input.attemptId,
        title: input.title,
        summary: input.summary,
        recommended: input.recommended,
        choices: structuredClone(input.choices),
        status: "open",
        openedAt: new Date(input.openedAt.getTime()),
        expiresAt: input.expiresAt === undefined ? undefined : new Date(input.expiresAt.getTime()),
      };
      gates.set(id, gate);
      return cloneGate(gate);
    },

    async getGate(gateId: string): Promise<WorkflowGateRecord | undefined> {
      const gate = gates.get(gateId);
      return gate === undefined ? undefined : cloneGate(gate);
    },

    async listOpenGates(filter?: ListOpenGatesFilter): Promise<readonly WorkflowGateRecord[]> {
      const result: WorkflowGateRecord[] = [];
      for (const gate of gates.values()) {
        if (gate.status !== "open") {
          continue;
        }
        if (filter?.workflowId !== undefined && gate.workflowId !== filter.workflowId) {
          continue;
        }
        if (filter?.runId !== undefined && gate.runId !== filter.runId) {
          continue;
        }
        result.push(cloneGate(gate));
      }
      return result;
    },

    async resolveGate(
      gateId: string,
      resolution: GateResolution,
    ): Promise<WorkflowGateRecord | undefined> {
      const gate = gates.get(gateId);
      if (gate === undefined || gate.status !== "open") {
        return undefined;
      }
      gate.status = "resolved";
      gate.resolution = {
        choice: resolution.choice,
        note: resolution.note,
        actor: resolution.actor,
        resolvedAt: new Date(resolution.resolvedAt.getTime()),
      };
      return cloneGate(gate);
    },

    async expireGate(gateId: string): Promise<WorkflowGateRecord | undefined> {
      const gate = gates.get(gateId);
      if (gate === undefined || gate.status !== "open") {
        return undefined;
      }
      gate.status = "expired";
      return cloneGate(gate);
    },

    async cancelRunGates(runId: string): Promise<readonly WorkflowGateRecord[]> {
      const cancelled: WorkflowGateRecord[] = [];
      for (const gate of gates.values()) {
        if (gate.runId === runId && gate.status === "open") {
          gate.status = "cancelled";
          cancelled.push(cloneGate(gate));
        }
      }
      return cancelled;
    },
  };
}
