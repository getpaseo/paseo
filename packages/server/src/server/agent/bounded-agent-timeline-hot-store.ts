import type { AgentTimelineRow, AgentTimelineWindow } from "./agent-timeline-store-types.js";

export interface BoundedAgentTimelineHotStoreOptions {
  maxRows: number;
  maxBytes: number;
}

export interface HotTimelineInitializeOptions {
  epoch: string;
  window: AgentTimelineWindow;
}

export interface HotTimelineRowOptions {
  durable?: boolean;
  mutable?: boolean;
}

export interface HotTimelineSnapshot {
  epoch: string;
  logicalWindow: AgentTimelineWindow;
  retainedWindow: Pick<AgentTimelineWindow, "minSeq" | "maxSeq">;
  encodedBytes: number;
  rows: AgentTimelineRow[];
}

export interface HotTimelineRevision {
  seq: number;
  revision: number;
}

export interface HotTimelineMetrics {
  retainedRows: number;
  retainedBytes: number;
  recentRows: number;
  recentBytes: number;
  pinnedRows: number;
  pinnedBytes: number;
  pendingRows: number;
  pendingBytes: number;
}

interface HotRow {
  row: AgentTimelineRow;
  bytes: number;
  durable: boolean;
  mutable: boolean;
  revision: number;
}

interface HotState {
  epoch: string;
  logicalMinSeq: number;
  logicalMaxSeq: number;
  nextSeq: number;
  encodedBytes: number;
  rows: HotRow[];
  nextRevision: number;
}

/**
 * Bounded process-local timeline window. The durable store owns evicted prefixes; this window may
 * overlap it with acknowledged rows and may extend it with a pinned unacknowledged/mutable tail.
 * Later integration must merge by sequence, preferring the hot copy for overlapping mutable rows.
 */
export class BoundedAgentTimelineHotStore {
  private readonly states = new Map<string, HotState>();

  constructor(private readonly options: BoundedAgentTimelineHotStoreOptions) {
    validatePositiveInteger(options.maxRows, "maxRows");
    validatePositiveInteger(options.maxBytes, "maxBytes");
  }

  initialize(agentId: string, options: HotTimelineInitializeOptions): void {
    if (typeof options.epoch !== "string" || options.epoch.length === 0) {
      throw new Error("epoch must be a non-empty string");
    }
    validateWindow(options.window);
    this.states.set(agentId, {
      epoch: options.epoch,
      logicalMinSeq: options.window.minSeq,
      logicalMaxSeq: options.window.maxSeq,
      nextSeq: options.window.nextSeq,
      encodedBytes: 0,
      rows: [],
      nextRevision: 1,
    });
  }

  append(
    agentId: string,
    row: AgentTimelineRow,
    options?: HotTimelineRowOptions,
  ): HotTimelineRevision {
    const state = this.requireState(agentId);
    if (row.seq !== state.nextSeq) {
      throw new Error(`Expected timeline sequence ${state.nextSeq}, received ${row.seq}`);
    }
    const cloned = cloneRow(row);
    const entry: HotRow = {
      row: cloned,
      bytes: encodedRowBytes(cloned),
      durable: options?.durable ?? false,
      mutable: options?.mutable ?? false,
      revision: state.nextRevision,
    };
    state.nextRevision += 1;
    if (state.logicalMinSeq === 0) state.logicalMinSeq = row.seq;
    state.logicalMaxSeq = row.seq;
    state.nextSeq = row.seq + 1;
    state.rows.push(entry);
    state.encodedBytes += entry.bytes;
    this.evict(state);
    return { seq: row.seq, revision: entry.revision };
  }

  acknowledgeDurable(agentId: string, revision: HotTimelineRevision): boolean {
    const state = this.requireState(agentId);
    const entry = state.rows.find(({ row }) => row.seq === revision.seq);
    if (!entry || entry.revision !== revision.revision) return false;
    entry.durable = true;
    this.evict(state);
    return true;
  }

  update(
    agentId: string,
    row: AgentTimelineRow,
    options?: HotTimelineRowOptions,
  ): HotTimelineRevision {
    const state = this.requireState(agentId);
    const entry = state.rows.find((candidate) => candidate.row.seq === row.seq);
    if (!entry) throw new Error(`Cannot update missing hot timeline sequence ${row.seq}`);
    const cloned = cloneRow(row);
    const bytes = encodedRowBytes(cloned);
    state.encodedBytes += bytes - entry.bytes;
    entry.row = cloned;
    entry.bytes = bytes;
    entry.durable = options?.durable ?? false;
    if (options?.mutable !== undefined) entry.mutable = options.mutable;
    entry.revision = state.nextRevision;
    state.nextRevision += 1;
    this.evict(state);
    return { seq: row.seq, revision: entry.revision };
  }

  snapshot(agentId: string): HotTimelineSnapshot {
    const state = this.requireState(agentId);
    return {
      epoch: state.epoch,
      logicalWindow: {
        minSeq: state.logicalMinSeq,
        maxSeq: state.logicalMaxSeq,
        nextSeq: state.nextSeq,
      },
      retainedWindow: {
        minSeq: state.rows[0]?.row.seq ?? 0,
        maxSeq: state.rows.at(-1)?.row.seq ?? 0,
      },
      encodedBytes: state.encodedBytes,
      rows: state.rows.map(({ row }) => cloneRow(row)),
    };
  }

  metrics(agentId: string): HotTimelineMetrics {
    const state = this.requireState(agentId);
    const result: HotTimelineMetrics = {
      retainedRows: state.rows.length,
      retainedBytes: state.encodedBytes,
      recentRows: 0,
      recentBytes: 0,
      pinnedRows: 0,
      pinnedBytes: 0,
      pendingRows: 0,
      pendingBytes: 0,
    };
    for (const entry of state.rows) {
      if (entry.durable && !entry.mutable) {
        result.recentRows += 1;
        result.recentBytes += entry.bytes;
      } else {
        result.pinnedRows += 1;
        result.pinnedBytes += entry.bytes;
      }
      if (!entry.durable) {
        result.pendingRows += 1;
        result.pendingBytes += entry.bytes;
      }
    }
    return result;
  }

  has(agentId: string): boolean {
    return this.states.has(agentId);
  }

  deleteAgent(agentId: string): void {
    this.states.delete(agentId);
  }

  clear(): void {
    this.states.clear();
  }

  private evict(state: HotState): void {
    while (
      state.rows.length > 1 &&
      (state.rows.length > this.options.maxRows || state.encodedBytes > this.options.maxBytes)
    ) {
      const evictableIndex = state.rows.findIndex(
        (entry, index) => index < state.rows.length - 1 && entry.durable && !entry.mutable,
      );
      if (evictableIndex < 0) return;
      const [evicted] = state.rows.splice(evictableIndex, 1);
      state.encodedBytes -= evicted!.bytes;
    }
  }

  private requireState(agentId: string): HotState {
    const state = this.states.get(agentId);
    if (!state) throw new Error(`Timeline hot store is not initialized for agent '${agentId}'`);
    return state;
  }
}

function encodedRowBytes(row: AgentTimelineRow): number {
  return Buffer.byteLength(JSON.stringify(row), "utf8");
}

function cloneRow(row: AgentTimelineRow): AgentTimelineRow {
  return { ...row, item: structuredClone(row.item) };
}

function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function validateWindow(window: AgentTimelineWindow): void {
  if (
    !Number.isSafeInteger(window.minSeq) ||
    window.minSeq < 0 ||
    !Number.isSafeInteger(window.maxSeq) ||
    window.maxSeq < 0 ||
    !Number.isSafeInteger(window.nextSeq) ||
    window.nextSeq < 1 ||
    (window.minSeq === 0 && window.maxSeq !== 0) ||
    (window.minSeq === 0 && window.nextSeq !== 1) ||
    (window.minSeq > 0 && window.minSeq > window.maxSeq) ||
    (window.minSeq > 0 && window.nextSeq !== window.maxSeq + 1)
  ) {
    throw new Error("Invalid logical timeline window");
  }
}
