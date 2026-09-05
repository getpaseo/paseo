import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import type { HotTimelineRevision } from "./bounded-agent-timeline-hot-store.js";

export interface TimelineDurableSink {
  bulkInsert(agentId: string, rows: readonly AgentTimelineRow[]): Promise<void>;
  updateCommittedRow(agentId: string, row: AgentTimelineRow): Promise<void>;
}

export interface TimelineDurableAcknowledgement {
  agentId: string;
  kind: "insert" | "update";
  rows: AgentTimelineRow[];
  revisions: Array<HotTimelineRevision | undefined>;
}

export interface TimelineDurableBufferMetrics {
  agents: number;
  pendingRows: number;
  pendingBytes: number;
  writableSignals: number;
  failedAgents: number;
  discardedAgents: number;
  acknowledgementFailures: number;
}

export interface OrderedAgentTimelineDurableBufferOptions {
  maxBatchRows?: number;
  maxBatchBytes?: number;
  maxPendingRows?: number;
  maxPendingBytes?: number;
  maxRowBytes?: number;
  onDurable?: (acknowledgement: TimelineDurableAcknowledgement) => void;
}

interface PendingOperation {
  kind: "insert" | "update";
  row: AgentTimelineRow;
  revision: HotTimelineRevision | undefined;
  bytes: number;
  settled: boolean;
  ready: boolean;
  resolve(): void;
  reject(error: unknown): void;
}

export interface TimelineDurableBufferReservation {
  commit(revision?: HotTimelineRevision): Promise<void>;
  cancel(): void;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(error: unknown): void;
}

interface AgentBufferState {
  status: "healthy" | "failed" | "discarded";
  failure: unknown;
  queue: PendingOperation[];
  active: PendingOperation[];
  pendingRows: number;
  pendingBytes: number;
  running: boolean;
  scheduled: boolean;
  flushWaiter: Deferred<void> | undefined;
  idleWaiter: Deferred<void> | undefined;
  writableSignal: Deferred<void> | undefined;
}

const DEFAULT_MAX_BATCH_ROWS = 64;
const DEFAULT_MAX_BATCH_BYTES = 256 * 1024;
const DEFAULT_MAX_PENDING_ROWS = 512;
const DEFAULT_MAX_PENDING_BYTES = 2 * 1024 * 1024;
export const DEFAULT_TIMELINE_DURABLE_MAX_ROW_BYTES = 240 * 1024;

export class TimelineDurableBufferDiscardedError extends Error {
  constructor(agentId: string) {
    super(`Timeline durable buffer was discarded for agent '${agentId}'`);
    this.name = "TimelineDurableBufferDiscardedError";
  }
}

export class TimelineDurableBufferBackpressureError extends Error {
  constructor(
    agentId: string,
    readonly whenWritable: Promise<void>,
  ) {
    super(`Timeline durable buffer is full for agent '${agentId}'; retry when writable`);
    this.name = "TimelineDurableBufferBackpressureError";
  }
}

export class TimelineDurableRowTooLargeError extends Error {
  constructor(
    agentId: string,
    readonly bytes: number,
    readonly maxBytes: number,
  ) {
    super(`Timeline row for agent '${agentId}' is ${bytes} bytes; maximum is ${maxBytes}`);
    this.name = "TimelineDurableRowTooLargeError";
  }
}

/**
 * Orders disposable-cache writes per agent with bounded admitted work. A sink success is the
 * durability boundary; revision-specific acknowledgements run only afterward, so an old insert
 * completion cannot evict a newer hot update. The durable store owns evicted prefixes. Hot rows
 * may overlap durable rows and win by sequence while their exact revision remains mutable.
 *
 * Admission is fail-fast: callers receive one coalesced `whenWritable` signal before an excess
 * row is cloned or retained, and must retry that row after the signal resolves. Producers must
 * serialize that retry to preserve their authoritative sequence order.
 *
 * A sink failure fails that agent's complete queued prefix and blocks later writes until `reset`;
 * callers replay authoritative provider rows in order after resetting. `discard` rejects local
 * completions and waits for an active sink write to settle. Callers must await it before deleting
 * durable state, then call `reset` before recreating the agent, preventing post-delete resurrection.
 */
export class OrderedAgentTimelineDurableBuffer {
  private readonly states = new Map<string, AgentBufferState>();
  private readonly maxBatchRows: number;
  private readonly maxBatchBytes: number;
  private readonly maxPendingRows: number;
  private readonly maxPendingBytes: number;
  private readonly maxRowBytes: number;
  private readonly onDurable?: (acknowledgement: TimelineDurableAcknowledgement) => void;
  private acknowledgementFailures = 0;

  constructor(
    private readonly sink: TimelineDurableSink,
    options?: OrderedAgentTimelineDurableBufferOptions,
  ) {
    this.maxBatchRows = options?.maxBatchRows ?? DEFAULT_MAX_BATCH_ROWS;
    this.maxBatchBytes = options?.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES;
    this.maxPendingRows = options?.maxPendingRows ?? DEFAULT_MAX_PENDING_ROWS;
    this.maxPendingBytes = options?.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
    this.maxRowBytes =
      options?.maxRowBytes ??
      Math.min(DEFAULT_TIMELINE_DURABLE_MAX_ROW_BYTES, this.maxBatchBytes, this.maxPendingBytes);
    this.onDurable = options?.onDurable;
    validatePositiveInteger(this.maxBatchRows, "maxBatchRows");
    validatePositiveInteger(this.maxBatchBytes, "maxBatchBytes");
    validatePositiveInteger(this.maxPendingRows, "maxPendingRows");
    validatePositiveInteger(this.maxPendingBytes, "maxPendingBytes");
    validatePositiveInteger(this.maxRowBytes, "maxRowBytes");
    if (this.maxRowBytes > this.maxBatchBytes || this.maxRowBytes > this.maxPendingBytes) {
      throw new Error("maxRowBytes must not exceed maxBatchBytes or maxPendingBytes");
    }
  }

  insert(agentId: string, row: AgentTimelineRow, revision?: HotTimelineRevision): Promise<void> {
    try {
      return this.insertOrThrow(agentId, row, revision);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  update(agentId: string, row: AgentTimelineRow, revision?: HotTimelineRevision): Promise<void> {
    try {
      return this.updateOrThrow(agentId, row, revision);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  insertOrThrow(
    agentId: string,
    row: AgentTimelineRow,
    revision?: HotTimelineRevision,
  ): Promise<void> {
    return this.enqueueOrThrow(agentId, "insert", row, revision);
  }

  reserveInsertOrThrow(agentId: string, row: AgentTimelineRow): TimelineDurableBufferReservation {
    return this.reserveOrThrow(agentId, "insert", row);
  }

  reserveUpdateOrThrow(agentId: string, row: AgentTimelineRow): TimelineDurableBufferReservation {
    return this.reserveOrThrow(agentId, "update", row);
  }

  updateOrThrow(
    agentId: string,
    row: AgentTimelineRow,
    revision?: HotTimelineRevision,
  ): Promise<void> {
    return this.enqueueOrThrow(agentId, "update", row, revision);
  }

  async discard(agentId: string): Promise<void> {
    const state = this.states.get(agentId);
    if (!state) return;
    state.status = "discarded";
    const error = new TimelineDurableBufferDiscardedError(agentId);
    for (const operation of [...state.active, ...state.queue]) {
      settleRejected(operation, error);
    }
    state.pendingRows = state.active.length;
    state.pendingBytes = totalBytes(state.active);
    state.queue = [];
    this.resolveWritableSignal(state);
    this.settleFlushWaiter(state, error);
    if (state.running) await this.waitForIdleState(state);
  }

  async reset(agentId: string): Promise<void> {
    const state = this.states.get(agentId);
    if (!state) return;
    if (state.status === "healthy") {
      throw new Error(`Cannot reset a healthy timeline buffer for agent '${agentId}'`);
    }
    if (state.running) await this.waitForIdleState(state);
    this.states.delete(agentId);
  }

  flush(agentId: string): Promise<void> {
    const state = this.states.get(agentId);
    if (!state) return Promise.resolve();
    if (state.status === "failed") return Promise.reject(state.failure);
    if (state.status === "discarded") {
      return Promise.reject(new TimelineDurableBufferDiscardedError(agentId));
    }
    if (isIdle(state)) return Promise.resolve();
    state.flushWaiter ??= promiseWithResolvers<void>();
    this.schedule(agentId, state);
    return state.flushWaiter.promise;
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.states.keys()].map(async (agentId) => await this.flush(agentId)));
  }

  metrics(agentId?: string): TimelineDurableBufferMetrics {
    const result: TimelineDurableBufferMetrics = {
      agents: this.states.size,
      pendingRows: 0,
      pendingBytes: 0,
      writableSignals: 0,
      failedAgents: 0,
      discardedAgents: 0,
      // Acknowledgement failures are an aggregate process counter. Per-agent state is removed
      // once its durable queue drains, so attributing the aggregate to any queried agent would
      // make unrelated agents appear unhealthy.
      acknowledgementFailures: agentId === undefined ? this.acknowledgementFailures : 0,
    };
    const states =
      agentId === undefined
        ? this.states.values()
        : [this.states.get(agentId)].filter(
            (state): state is AgentBufferState => state !== undefined,
          );
    for (const state of states) {
      result.pendingRows += state.pendingRows;
      result.pendingBytes += state.pendingBytes;
      if (state.writableSignal) result.writableSignals += 1;
      if (state.status === "failed") result.failedAgents += 1;
      if (state.status === "discarded") result.discardedAgents += 1;
    }
    if (agentId !== undefined) result.agents = this.states.has(agentId) ? 1 : 0;
    return result;
  }

  private enqueueOrThrow(
    agentId: string,
    kind: PendingOperation["kind"],
    row: AgentTimelineRow,
    revision: HotTimelineRevision | undefined,
  ): Promise<void> {
    const reservation = this.reserveOrThrow(agentId, kind, row);
    return reservation.commit(revision!);
  }

  private reserveOrThrow(
    agentId: string,
    kind: PendingOperation["kind"],
    row: AgentTimelineRow,
  ): TimelineDurableBufferReservation {
    const bytes = encodedRowBytes(row);
    if (bytes > this.maxRowBytes) {
      throw new TimelineDurableRowTooLargeError(agentId, bytes, this.maxRowBytes);
    }
    const state = this.state(agentId);
    if (state.status === "failed") throw state.failure;
    if (state.status === "discarded") {
      throw new TimelineDurableBufferDiscardedError(agentId);
    }
    if (!this.canAdmit(state, bytes)) {
      state.writableSignal ??= promiseWithResolvers<void>();
      throw new TimelineDurableBufferBackpressureError(agentId, state.writableSignal.promise);
    }
    const deferred = promiseWithResolvers<void>();
    // Reservations may be invalidated before commit exposes their completion to a caller.
    // Observe that hidden rejection while preserving rejection for a later committed promise.
    void deferred.promise.catch(() => undefined);
    const cloned = cloneRow(row);
    const operation: PendingOperation = {
      kind,
      row: cloned,
      revision: undefined,
      bytes,
      settled: false,
      ready: false,
      resolve: () => deferred.resolve(),
      reject: deferred.reject,
    };
    state.queue.push(operation);
    state.pendingRows += 1;
    state.pendingBytes += bytes;
    let finalized = false;
    return {
      commit: (revision) => {
        if (finalized) throw new Error("Timeline durable reservation was already finalized");
        finalized = true;
        operation.revision = revision;
        operation.ready = true;
        this.schedule(agentId, state);
        return deferred.promise;
      },
      cancel: () => {
        if (finalized) return;
        finalized = true;
        const index = state.queue.indexOf(operation);
        if (index < 0) return;
        state.queue.splice(index, 1);
        state.pendingRows -= 1;
        state.pendingBytes -= bytes;
        settleResolved(operation);
        this.resolveWritableSignal(state);
        this.schedule(agentId, state);
        if (state.status === "healthy" && isIdle(state)) {
          this.settleFlushWaiter(state);
          if (this.states.get(agentId) === state) this.states.delete(agentId);
        }
      },
    };
  }

  private state(agentId: string): AgentBufferState {
    let state = this.states.get(agentId);
    if (!state) {
      state = {
        status: "healthy",
        failure: undefined,
        queue: [],
        active: [],
        pendingRows: 0,
        pendingBytes: 0,
        running: false,
        scheduled: false,
        flushWaiter: undefined,
        idleWaiter: undefined,
        writableSignal: undefined,
      };
      this.states.set(agentId, state);
    }
    return state;
  }

  private schedule(agentId: string, state: AgentBufferState): void {
    if (state.queue.length === 0 || !state.queue[0]!.ready || state.running || state.scheduled)
      return;
    state.scheduled = true;
    queueMicrotask(() => {
      state.scheduled = false;
      void this.drain(agentId, state);
    });
  }

  private async drain(agentId: string, state: AgentBufferState): Promise<void> {
    if (state.running || this.states.get(agentId) !== state || state.status !== "healthy") return;
    state.running = true;
    try {
      while (state.queue[0]?.ready && state.status === "healthy") {
        state.active = this.takeBatch(state.queue);
        try {
          await this.write(agentId, state.active);
        } catch (error) {
          if (state.status !== "healthy") {
            state.pendingRows -= state.active.length;
            state.pendingBytes -= totalBytes(state.active);
            state.active = [];
            return;
          }
          state.failure = error;
          state.status = "failed";
          for (const operation of [...state.active, ...state.queue]) {
            settleRejected(operation, error);
          }
          state.active = [];
          state.queue = [];
          state.pendingRows = 0;
          state.pendingBytes = 0;
          this.resolveWritableSignal(state);
          this.settleFlushWaiter(state, error);
          return;
        }
        if (state.status !== "healthy") {
          state.pendingRows -= state.active.length;
          state.pendingBytes -= totalBytes(state.active);
          state.active = [];
          return;
        }
        const completed = state.active;
        state.active = [];
        state.pendingRows -= completed.length;
        state.pendingBytes -= totalBytes(completed);
        this.resolveWritableSignal(state);
        try {
          this.onDurable?.({
            agentId,
            kind: completed[0]!.kind,
            rows: completed.map(({ row }) => cloneRow(row)),
            revisions: completed.map(({ revision }) => revision),
          });
          for (const operation of completed) settleResolved(operation);
        } catch (error) {
          this.acknowledgementFailures += 1;
          for (const operation of completed) settleRejected(operation, error);
        }
      }
    } finally {
      state.running = false;
      if (state.status === "healthy") {
        this.schedule(agentId, state);
        if (isIdle(state)) {
          this.settleFlushWaiter(state);
          if (this.states.get(agentId) === state) this.states.delete(agentId);
        }
      }
      if (isIdle(state)) this.settleIdleWaiter(state);
    }
  }

  private takeBatch(queue: PendingOperation[]): PendingOperation[] {
    if (queue[0]!.kind === "update") return queue.splice(0, 1);
    let count = 0;
    let bytes = 0;
    while (count < queue.length && count < this.maxBatchRows) {
      const operation = queue[count]!;
      if (operation.kind !== "insert" || !operation.ready) break;
      if (count > 0 && bytes + operation.bytes > this.maxBatchBytes) break;
      bytes += operation.bytes;
      count += 1;
    }
    return queue.splice(0, count);
  }

  private async write(agentId: string, operations: PendingOperation[]): Promise<void> {
    const first = operations[0]!;
    if (first.kind === "insert") {
      await this.sink.bulkInsert(
        agentId,
        operations.map(({ row }) => cloneRow(row)),
      );
      return;
    }
    await this.sink.updateCommittedRow(agentId, cloneRow(first.row));
  }

  private async waitForIdleState(state: AgentBufferState): Promise<void> {
    if (!state.running) return;
    state.idleWaiter ??= promiseWithResolvers<void>();
    await state.idleWaiter.promise;
  }

  private settleFlushWaiter(state: AgentBufferState, error?: unknown): void {
    const waiter = state.flushWaiter;
    state.flushWaiter = undefined;
    if (!waiter) return;
    if (error === undefined) waiter.resolve(undefined);
    else waiter.reject(error);
  }

  private settleIdleWaiter(state: AgentBufferState): void {
    const waiter = state.idleWaiter;
    state.idleWaiter = undefined;
    waiter?.resolve(undefined);
  }

  private resolveWritableSignal(state: AgentBufferState): void {
    const signal = state.writableSignal;
    state.writableSignal = undefined;
    signal?.resolve(undefined);
  }

  private canAdmit(state: AgentBufferState, bytes: number): boolean {
    return (
      state.pendingRows === 0 ||
      (state.pendingRows + 1 <= this.maxPendingRows &&
        state.pendingBytes + bytes <= this.maxPendingBytes)
    );
  }
}

function isIdle(state: AgentBufferState): boolean {
  return (
    !state.running && !state.scheduled && state.active.length === 0 && state.queue.length === 0
  );
}

function totalBytes(operations: readonly PendingOperation[]): number {
  return operations.reduce((total, operation) => total + operation.bytes, 0);
}

function encodedRowBytes(row: AgentTimelineRow): number {
  return Buffer.byteLength(JSON.stringify(row), "utf8");
}

function settleResolved(operation: PendingOperation): void {
  if (operation.settled) return;
  operation.settled = true;
  operation.resolve();
}

function settleRejected(operation: PendingOperation, error: unknown): void {
  if (operation.settled) return;
  operation.settled = true;
  operation.reject(error);
}

function cloneRow(row: AgentTimelineRow): AgentTimelineRow {
  return { ...row, item: structuredClone(row.item) };
}

function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function promiseWithResolvers<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
