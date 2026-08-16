import type { AgentTimelineRow, AgentTimelineStore } from "./agent-timeline-store-types.js";

export interface DurableTimelineTimers {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

export interface DurableTimelineRetryOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
}

const DEFAULT_RETRY_MAX_DELAY_MS = 5_000;

interface PendingAgentRows {
  rows: AgentTimelineRow[];
  timer: ReturnType<typeof setTimeout> | null;
  flushing: Promise<void> | null;
  retryAttempt: number;
}

/** Keeps each agent's durable transcript contiguous while coalescing live writes. */
export class DurableTimelineBuffer {
  private readonly pending = new Map<string, PendingAgentRows>();

  constructor(
    private readonly store: AgentTimelineStore,
    private readonly delayMs: number,
    private readonly timers: DurableTimelineTimers,
    private readonly onError: (agentId: string, error: unknown) => void,
    private readonly retryOptions: DurableTimelineRetryOptions = {},
  ) {}

  enqueue(agentId: string, row: AgentTimelineRow): void {
    const state = this.stateFor(agentId);
    state.rows.push(row);
    this.schedule(agentId, state, this.delayMs);
  }

  async flush(agentId: string): Promise<void> {
    const state = this.pending.get(agentId);
    if (!state) return;
    if (state.timer !== null) {
      this.timers.clearTimeout(state.timer);
      state.timer = null;
    }
    if (state.flushing) {
      await state.flushing;
      return this.flush(agentId);
    }
    if (state.rows.length === 0) {
      this.pending.delete(agentId);
      return;
    }
    const batch = [...state.rows];
    state.flushing = this.store.bulkInsert(agentId, batch);
    try {
      await state.flushing;
      state.rows.splice(0, batch.length);
      state.retryAttempt = 0;
    } catch (error) {
      this.scheduleRetry(agentId, state);
      throw error;
    } finally {
      state.flushing = null;
      if (state.rows.length === 0 && state.timer === null) {
        this.pending.delete(agentId);
      } else if (state.rows.length > 0 && state.timer === null) {
        this.schedule(agentId, state, this.delayMs);
      }
    }
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.pending.keys()].map((agentId) => this.flush(agentId)));
  }

  async discard(agentId: string): Promise<void> {
    const state = this.pending.get(agentId);
    if (!state) return;
    if (state.timer !== null) this.timers.clearTimeout(state.timer);
    state.timer = null;
    state.rows.length = 0;
    await state.flushing?.catch(() => undefined);
    this.pending.delete(agentId);
  }

  private stateFor(agentId: string): PendingAgentRows {
    let state = this.pending.get(agentId);
    if (!state) {
      state = { rows: [], timer: null, flushing: null, retryAttempt: 0 };
      this.pending.set(agentId, state);
    }
    return state;
  }

  private schedule(agentId: string, state: PendingAgentRows, delayMs: number): void {
    if (state.timer !== null || state.rows.length === 0) return;
    state.timer = this.timers.setTimeout(() => {
      state.timer = null;
      void this.flush(agentId).catch((error) => this.onError(agentId, error));
    }, delayMs);
    this.unref(state.timer);
  }

  private scheduleRetry(agentId: string, state: PendingAgentRows): void {
    const baseDelayMs = this.retryOptions.baseDelayMs ?? this.delayMs;
    const maxDelayMs = this.retryOptions.maxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
    const delayMs = Math.min(baseDelayMs * 2 ** state.retryAttempt, maxDelayMs);
    state.retryAttempt += 1;
    this.schedule(agentId, state, delayMs);
  }

  private unref(timer: ReturnType<typeof setTimeout>): void {
    const candidate = timer as unknown as { unref?: () => void };
    candidate.unref?.();
  }
}
