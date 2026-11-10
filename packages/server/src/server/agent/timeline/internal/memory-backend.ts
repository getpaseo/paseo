import { randomUUID } from "node:crypto";
import { limitAgentTimelineItemContent } from "../../agent-timeline-content.js";
import type { AgentTimelineItem } from "../../agent-sdk-types.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
} from "../../agent-timeline-store-types.js";
import { TimelineProjection, type ProjectedTimelineRow } from "../../timeline-projection.js";
import type {
  AgentTimelineBackend,
  TimelineBackendAppendResult,
  TimelineEntry,
  TimelineHead,
  TimelineScope,
  TimelineSeed,
} from "./backend.js";
import { UnknownTimelineError } from "./backend.js";

interface MemoryTimelineState {
  epoch: string;
  projection: TimelineProjection;
  minSeq: number;
  nextSeq: number;
}

const DEFAULT_TIMELINE_FETCH_LIMIT = 200;

function scopeKey(scope: TimelineScope): string {
  return scope.subagentId === undefined ? scope.agentId : `${scope.agentId}\0${scope.subagentId}`;
}

function cloneRow<T extends AgentTimelineRow>(row: T): T {
  return { ...row };
}

function buildRow(entry: TimelineEntry, seq: number, timestamp: string): AgentTimelineRow {
  return {
    seq,
    timestamp: entry.timestamp ?? timestamp,
    item: entry.item,
    ...(entry.turnId ? { turnId: entry.turnId } : {}),
    ...(entry.providerMessageId ? { providerMessageId: entry.providerMessageId } : {}),
  };
}

/** Volatile backend: history lives in process memory and is lost when the daemon exits. */
export class MemoryTimelineBackend implements AgentTimelineBackend {
  private readonly states = new Map<string, MemoryTimelineState>();

  create(scope: TimelineScope, seed: TimelineSeed): TimelineHead {
    const timestamp = seed.timestamp ?? new Date().toISOString();
    const startSeq = seed.nextSeq ?? 1;
    const rows = seed.rows?.length
      ? seed.rows.map(cloneRow)
      : (seed.entries ?? []).map((entry, index) => buildRow(entry, startSeq + index, timestamp));
    const nextSeq = rows.reduce((next, row) => Math.max(next, row.seq + 1), startSeq);
    const projection = new TimelineProjection(rows);
    const state: MemoryTimelineState = {
      epoch: seed.epoch ?? randomUUID(),
      projection,
      minSeq: projection.getRows()[0]?.seqStart ?? 0,
      nextSeq,
    };
    this.states.set(scopeKey(scope), state);
    return this.describe(state);
  }

  delete(scope: TimelineScope): void {
    this.states.delete(scopeKey(scope));
  }

  head(scope: TimelineScope): TimelineHead | null {
    const state = this.states.get(scopeKey(scope));
    return state ? this.describe(state) : null;
  }

  append(scope: TimelineScope, entries: readonly TimelineEntry[]): TimelineBackendAppendResult {
    const state = this.requireState(scope);
    const timestamp = new Date().toISOString();
    const rows = entries.map((entry, index) => buildRow(entry, state.nextSeq + index, timestamp));
    for (const row of rows) {
      state.projection.append(row);
      state.nextSeq = row.seq + 1;
      if (state.minSeq === 0) state.minSeq = row.seq;
    }
    return { rows: rows.map(cloneRow), head: this.describe(state) };
  }

  attachProviderMessageId(
    scope: TimelineScope,
    clientMessageId: string,
    providerMessageId: string,
  ): AgentTimelineRow | null {
    return this.requireState(scope).projection.enrichSubmittedUserMessage(
      clientMessageId,
      providerMessageId,
    );
  }

  findSubmittedPrompt(scope: TimelineScope, clientMessageId: string): AgentTimelineRow | null {
    const row = this.requireState(scope)
      .projection.getRows()
      .find(
        (candidate) =>
          candidate.item.type === "user_message" &&
          candidate.item.clientMessageId === clientMessageId,
      );
    return row ? cloneRow(row) : null;
  }

  fetch(scope: TimelineScope, options: AgentTimelineFetchOptions): AgentTimelineFetchResult {
    const state = this.requireState(scope);
    const direction = options.direction ?? "tail";
    const cursor = options.cursor;
    const hasRows = state.minSeq !== 0;
    const window = { minSeq: state.minSeq, maxSeq: state.nextSeq - 1, nextSeq: state.nextSeq };
    const staleCursor = cursor !== undefined && cursor.epoch !== state.epoch;
    const gap =
      !staleCursor &&
      direction === "after" &&
      cursor !== undefined &&
      hasRows &&
      cursor.seq < state.minSeq - 1;
    const reset = staleCursor || gap;
    const page = state.projection.selectPage({
      bounds: window,
      direction: reset ? "tail" : direction,
      cursorSeq: cursor?.seq,
      limit: options.limit ?? DEFAULT_TIMELINE_FETCH_LIMIT,
      wholeTurns: options.wholeTurns,
    });
    return {
      epoch: state.epoch,
      direction,
      reset,
      staleCursor,
      gap,
      window,
      hasOlder: page.hasOlder,
      hasNewer: page.hasNewer,
      startSeq: page.startSeq,
      endSeq: page.endSeq,
      // Stored rows are already within budget; this bounds assistant and reasoning merges.
      rows: page.entries.map((entry) =>
        Object.assign({ seq: entry.seqEnd }, entry, {
          item: limitAgentTimelineItemContent(entry.item),
        }),
      ),
    };
  }

  readRows(scope: TimelineScope): ProjectedTimelineRow[] {
    return this.requireState(scope).projection.getRows().map(cloneRow);
  }

  lastItem(scope: TimelineScope): AgentTimelineItem | null {
    const state = this.requireState(scope);
    return state.projection.getLastItem(state.nextSeq - 1);
  }

  lastAssistantMessage(scope: TimelineScope): string | null {
    return this.requireState(scope).projection.getLastAssistantMessage();
  }

  private describe(state: MemoryTimelineState): TimelineHead {
    return { epoch: state.epoch, size: state.projection.size };
  }

  private requireState(scope: TimelineScope): MemoryTimelineState {
    const state = this.states.get(scopeKey(scope));
    if (!state) {
      throw new UnknownTimelineError(scope);
    }
    return state;
  }
}
