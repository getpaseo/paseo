import { randomUUID } from "node:crypto";
import {
  TimelineProjection,
  selectProjectedTimelinePage,
  type ProjectedTimelineRow,
} from "./timeline-projection.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
} from "./agent-timeline-store-types.js";

export const DEFAULT_TIMELINE_FETCH_LIMIT = 200;
export const DEFAULT_TIMELINE_WINDOW_MAX_BYTES = 16 * 1024 * 1024;
export const DEFAULT_TIMELINE_WINDOW_MAX_ROWS = 50_000;

/** Rows requested per readTailRows batch by the bounded tail backfill. */
export const TIMELINE_TAIL_BACKFILL_BATCH_ROWS = 256;
/**
 * Cap on the total durable rows a bounded tail backfill may scan; beyond it
 * the caller falls back to the full-history read, bounding the pathological
 * case where a page spans most of the log.
 */
export const TIMELINE_TAIL_BACKFILL_MAX_SCAN_ROWS = 20_000;

export interface InMemoryAgentTimelineStoreOptions {
  /** Upper bound on the number of canonical rows retained in the in-memory window. */
  maxWindowRows?: number;
  /** Upper bound on the total serialized row bytes retained in the in-memory window. */
  maxWindowBytes?: number;
}

/**
 * Resolve the bounded in-memory timeline window limits from the environment.
 * Both values fall back to the defaults; eviction is only meaningful when the
 * agent manager also has a durable timeline store to backfill from.
 */
export function resolveTimelineWindowLimits(
  env: NodeJS.ProcessEnv,
): InMemoryAgentTimelineStoreOptions {
  return {
    maxWindowBytes:
      parseTimelineWindowLimit(env.PASEO_TIMELINE_WINDOW_MAX_BYTES) ??
      DEFAULT_TIMELINE_WINDOW_MAX_BYTES,
    maxWindowRows:
      parseTimelineWindowLimit(env.PASEO_TIMELINE_WINDOW_MAX_ROWS) ??
      DEFAULT_TIMELINE_WINDOW_MAX_ROWS,
  };
}

function parseTimelineWindowLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid timeline window limit: '${value}'`);
  }
  return parsed;
}

export interface SeedAgentTimelineOptions {
  items?: readonly AgentTimelineItem[];
  rows?: readonly AgentTimelineRow[];
  epoch?: string;
  nextSeq?: number;
  timestamp?: string;
}

/**
 * The largest k such that every seq 1..k is present in the committed log.
 * A durable log with a gap (a write that failed before a restart) must not
 * mark the missing seqs as persisted, so callers that seed the durable
 * watermark use the contiguous prefix, not the max seq.
 */
export function contiguousCommittedPrefix(seqs: readonly number[]): number {
  if (seqs.length === 0) return 0;
  const present = new Set(seqs);
  let prefix = 0;
  while (present.has(prefix + 1)) prefix += 1;
  return prefix;
}

interface AgentTimelineState {
  epoch: string;
  projection: TimelineProjection;
  rows: AgentTimelineRow[];
  windowBytes: number;
  minSeq: number;
  nextSeq: number;
  durableWatermark: number;
  evicted: boolean;
}

function cloneRow<T extends AgentTimelineRow>(row: T): T {
  return { ...row };
}

function rowByteSize(row: AgentTimelineRow): number {
  return Buffer.byteLength(JSON.stringify(row), "utf8");
}

const EVICT_HYSTERESIS = 1.25;

export class InMemoryAgentTimelineStore {
  private readonly states = new Map<string, AgentTimelineState>();
  private readonly maxWindowRows: number | undefined;
  private readonly maxWindowBytes: number | undefined;
  private readonly bounded: boolean;

  constructor(options?: InMemoryAgentTimelineStoreOptions) {
    this.maxWindowRows = options?.maxWindowRows;
    this.maxWindowBytes = options?.maxWindowBytes;
    this.bounded = this.maxWindowRows !== undefined || this.maxWindowBytes !== undefined;
  }

  has(agentId: string): boolean {
    return this.states.has(agentId);
  }

  initialize(agentId: string, options?: SeedAgentTimelineOptions): void {
    const timestamp = options?.timestamp ?? new Date().toISOString();
    const rows = options?.rows?.length
      ? options.rows.map(cloneRow)
      : this.buildRowsFromItems(options?.items ?? [], options?.nextSeq ?? 1, timestamp);
    const nextSeq = rows.reduce((next, row) => Math.max(next, row.seq + 1), options?.nextSeq ?? 1);
    const projection = new TimelineProjection();
    let windowBytes = 0;
    for (const row of rows) {
      projection.append(row);
      windowBytes += rowByteSize(row);
    }
    this.states.set(agentId, {
      epoch: options?.epoch ?? randomUUID(),
      projection,
      rows,
      windowBytes,
      minSeq: projection.getRows()[0]?.seqStart ?? 0,
      nextSeq,
      durableWatermark: 0,
      evicted: false,
    });
    this.enforceWindowLimits(agentId);
  }

  delete(agentId: string): void {
    this.states.delete(agentId);
  }

  getItems(agentId: string): AgentTimelineItem[] {
    return this.requireState(agentId)
      .projection.getRows()
      .map((row) => row.item);
  }

  getRows(agentId: string): ProjectedTimelineRow[] {
    return this.requireState(agentId).projection.getRows().map(cloneRow);
  }

  /** Canonical rows retained in the in-memory window, oldest first. */
  getCanonicalRows(agentId: string): AgentTimelineRow[] {
    return this.requireState(agentId).rows.map(cloneRow);
  }

  /**
   * The canonical row for `seq` as the window currently holds it, with any
   * post-append enrichment (the projected providerMessageId) merged in, or
   * null when the window no longer holds the seq. A pending durable write
   * stalls the watermark below its seq, so the window always holds rows that
   * are still queued for a durable write.
   */
  getLatestRowForSeq(agentId: string, seq: number): AgentTimelineRow | null {
    const state = this.states.get(agentId);
    if (!state) return null;
    const row = state.rows.find((candidate) => candidate.seq === seq);
    if (!row) return null;
    const enriched = state.projection
      .getRows()
      .find((candidate) => candidate.seqStart === seq && candidate.seqEnd === seq);
    if (
      enriched?.providerMessageId !== undefined &&
      enriched.providerMessageId !== row.providerMessageId
    ) {
      return { ...row, providerMessageId: enriched.providerMessageId };
    }
    return cloneRow(row);
  }

  isWindowEmpty(agentId: string): boolean {
    return this.requireState(agentId).rows.length === 0;
  }

  hasEvicted(agentId: string): boolean {
    return this.requireState(agentId).evicted;
  }

  /** Seq of the oldest canonical row in the window, or 0 when the window is empty. */
  getWindowFloorSeq(agentId: string): number {
    return this.requireState(agentId).rows[0]?.seq ?? 0;
  }

  /**
   * Record the highest seq confirmed in the durable store. Eviction never
   * removes rows above this watermark, so a failed durable write cannot lose
   * data that is not durably committed.
   */
  setDurableWatermark(agentId: string, seq: number): void {
    const state = this.requireState(agentId);
    state.durableWatermark = seq;
    this.enforceWindowLimits(agentId);
  }

  getNextSeq(agentId: string): number {
    return this.requireState(agentId).nextSeq;
  }

  getSubmittedUserMessage(agentId: string, clientMessageId: string): AgentTimelineRow | null {
    const row = this.requireState(agentId)
      .projection.getRows()
      .find(
        (candidate) =>
          candidate.item.type === "user_message" &&
          candidate.item.clientMessageId === clientMessageId,
      );
    return row ? cloneRow(row) : null;
  }

  enrichSubmittedUserMessage(
    agentId: string,
    clientMessageId: string,
    providerMessageId: string,
  ): AgentTimelineRow | null {
    return this.requireState(agentId).projection.enrichSubmittedUserMessage(
      clientMessageId,
      providerMessageId,
    );
  }

  getEpoch(agentId: string): string {
    return this.requireState(agentId).epoch;
  }

  fetch(agentId: string, options?: AgentTimelineFetchOptions): AgentTimelineFetchResult {
    const state = this.requireState(agentId);
    const direction = options?.direction ?? "tail";
    const cursor = options?.cursor;
    const rows = state.projection.getRows();
    const window = { minSeq: state.minSeq, maxSeq: state.nextSeq - 1, nextSeq: state.nextSeq };
    const staleCursor = cursor !== undefined && cursor.epoch !== state.epoch;
    const windowFloor = state.rows[0]?.seq ?? 0;
    const gap =
      !staleCursor &&
      direction === "after" &&
      cursor !== undefined &&
      rows.length > 0 &&
      cursor.seq < windowFloor - 1;
    const reset = staleCursor || gap;
    // A reset serves a tail page no matter which direction was requested;
    // the evicted-hasOlder correction must follow the page, not the request.
    const pageDirection = reset ? "tail" : direction;
    // The tail page's backward cursor is anchored at the rows the window
    // actually holds. A projected entry can anchor below them (a tool
    // update whose anchor row was evicted), and a restart seed leaves the
    // window above the durable log it was seeded over. Neither anchor may
    // leak into startSeq or hasOlder, or the rows in between become
    // unreachable from the client's cursor.
    const page = selectProjectedTimelinePage({
      rows,
      bounds: pageDirection === "tail" ? { minSeq: windowFloor, maxSeq: window.maxSeq } : window,
      direction: pageDirection,
      cursorSeq: cursor?.seq,
      limit: options?.limit ?? DEFAULT_TIMELINE_FETCH_LIMIT,
    });
    return {
      epoch: state.epoch,
      direction,
      reset,
      staleCursor,
      gap,
      window,
      // A tail page larger than the retained window still has rows below it:
      // eviction this lifetime, or a restart seeded the window over the
      // durable log. A window floor above seq 1 reports both; without it the
      // client believes it holds the full history and the rows become
      // unreachable.
      hasOlder: page.hasOlder || (pageDirection === "tail" && windowFloor > 1),
      hasNewer: page.hasNewer,
      startSeq: page.startSeq,
      endSeq: page.endSeq,
      rows: page.entries.map((entry) => Object.assign({ seq: entry.seqEnd }, entry)),
    };
  }

  append(
    agentId: string,
    item: AgentTimelineItem,
    options?: { timestamp?: string; providerMessageId?: string; turnId?: string },
  ): AgentTimelineRow {
    const state = this.requireState(agentId);
    const row: AgentTimelineRow = {
      seq: state.nextSeq,
      timestamp: options?.timestamp ?? new Date().toISOString(),
      item,
      ...(options?.turnId ? { turnId: options.turnId } : {}),
      ...(options?.providerMessageId ? { providerMessageId: options.providerMessageId } : {}),
    };
    state.nextSeq += 1;
    if (state.minSeq === 0) state.minSeq = row.seq;
    state.rows.push(row);
    state.windowBytes += rowByteSize(row);
    state.projection.append(row);
    this.enforceWindowLimits(agentId);
    return cloneRow(row);
  }

  getLastItem(agentId: string): AgentTimelineItem | null {
    const state = this.requireState(agentId);
    return state.projection.getRows().find((row) => row.seqEnd === state.nextSeq - 1)?.item ?? null;
  }

  getLastAssistantMessage(agentId: string): string | null {
    const row = this.requireState(agentId)
      .projection.getRows()
      .findLast((candidate) => candidate.item.type === "assistant_message");
    return row?.item.type === "assistant_message" ? row.item.text : null;
  }

  private requireState(agentId: string): AgentTimelineState {
    const state = this.states.get(agentId);
    if (!state) {
      throw new Error(`Unknown agent '${agentId}'`);
    }
    return state;
  }

  private enforceWindowLimits(agentId: string): void {
    if (!this.bounded) return;
    const state = this.requireState(agentId);
    const overHardLimit = (bytes: number, count: number): boolean =>
      (this.maxWindowBytes !== undefined && bytes > this.maxWindowBytes) ||
      (this.maxWindowRows !== undefined && count > this.maxWindowRows);
    if (!overHardLimit(state.windowBytes, state.rows.length)) return;
    // Hysteresis: only evict once the window is well past the limit, so a busy
    // stream does not pay for a projection rebuild on every append. The window
    // oscillates between the hard limit and hard limit × EVICT_HYSTERESIS.
    const overSoftLimit =
      (this.maxWindowBytes !== undefined &&
        state.windowBytes > this.maxWindowBytes * EVICT_HYSTERESIS) ||
      (this.maxWindowRows !== undefined &&
        state.rows.length > this.maxWindowRows * EVICT_HYSTERESIS);
    if (!overSoftLimit) return;

    // Canonical rows are seq-ordered, so the evictable set (at or below the
    // watermark) is always a prefix.
    let evictedCount = 0;
    let evictedBytes = 0;
    let lastEvictedSeq = 0;
    while (
      state.rows.length - evictedCount > 1 &&
      overHardLimit(state.windowBytes - evictedBytes, state.rows.length - evictedCount)
    ) {
      const row = state.rows[evictedCount];
      if (!row || row.seq > state.durableWatermark) break;
      evictedCount += 1;
      evictedBytes += rowByteSize(row);
      lastEvictedSeq = row.seq;
    }
    if (evictedCount === 0) return;

    state.rows.splice(0, evictedCount);
    state.windowBytes -= evictedBytes;
    state.evicted = true;
    const minSeq = state.projection.evictBefore(lastEvictedSeq + 1);
    state.minSeq = minSeq ?? state.nextSeq;
  }

  private buildRowsFromItems(
    items: readonly AgentTimelineItem[],
    startSeq: number,
    timestamp: string,
  ): AgentTimelineRow[] {
    let nextSeq = startSeq;
    return items.map((item) => {
      const row: AgentTimelineRow = {
        seq: nextSeq,
        timestamp,
        item,
      };
      nextSeq += 1;
      return row;
    });
  }
}
