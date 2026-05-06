import { randomUUID } from "node:crypto";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
} from "./agent-timeline-store-types.js";

export interface SeedAgentTimelineOptions {
  items?: readonly AgentTimelineItem[];
  rows?: readonly AgentTimelineRow[];
  epoch?: string;
  nextSeq?: number;
  timestamp?: string;
}

interface AgentTimelineState {
  epoch: string;
  rows: AgentTimelineRow[];
  nextSeq: number;
}

const DEFAULT_TIMELINE_FETCH_LIMIT = 200;

function cloneRow(row: AgentTimelineRow): AgentTimelineRow {
  return { ...row };
}

function normalizeTimelineMessageId(messageId: string | undefined): string | undefined {
  if (typeof messageId !== "string") {
    return undefined;
  }
  const normalized = messageId.trim();
  return normalized.length > 0 ? normalized : undefined;
}

interface FetchContext {
  state: AgentTimelineState;
  direction: NonNullable<AgentTimelineFetchOptions["direction"]>;
  limit: number;
  selectAll: boolean;
  cursor: AgentTimelineFetchOptions["cursor"];
  minSeq: number;
  maxSeq: number;
  window: { minSeq: number; maxSeq: number; nextSeq: number };
}

function fetchTail(ctx: FetchContext): AgentTimelineFetchResult {
  const { state, direction, limit, selectAll, minSeq, window } = ctx;
  const selected =
    selectAll || limit >= state.rows.length
      ? state.rows
      : state.rows.slice(state.rows.length - limit);
  return {
    epoch: state.epoch,
    direction,
    reset: false,
    staleCursor: false,
    gap: false,
    window,
    hasOlder: selected.length > 0 && selected[0].seq > minSeq,
    hasNewer: false,
    rows: selected.map(cloneRow),
  };
}

function fetchAfter(ctx: FetchContext): AgentTimelineFetchResult {
  const { state, direction, limit, selectAll, cursor, minSeq, maxSeq, window } = ctx;
  const baseSeq = cursor?.seq ?? 0;
  const startIdx = state.rows.findIndex((row) => row.seq > baseSeq);
  if (startIdx < 0) {
    return {
      epoch: state.epoch,
      direction,
      reset: false,
      staleCursor: false,
      gap: false,
      window,
      hasOlder: baseSeq >= minSeq,
      hasNewer: false,
      rows: [],
    };
  }

  const selected = selectAll
    ? state.rows.slice(startIdx)
    : state.rows.slice(startIdx, startIdx + limit);
  const lastSelected = selected[selected.length - 1];
  return {
    epoch: state.epoch,
    direction,
    reset: false,
    staleCursor: false,
    gap: false,
    window,
    hasOlder: selected[0].seq > minSeq,
    hasNewer: lastSelected !== null && lastSelected !== undefined && lastSelected.seq < maxSeq,
    rows: selected.map(cloneRow),
  };
}

function fetchBefore(ctx: FetchContext): AgentTimelineFetchResult {
  const { state, direction, limit, selectAll, cursor, minSeq, window } = ctx;
  const beforeSeq = cursor?.seq ?? state.nextSeq;
  const endExclusive = state.rows.findIndex((row) => row.seq >= beforeSeq);
  const boundedRows = endExclusive < 0 ? state.rows : state.rows.slice(0, endExclusive);
  const selected =
    selectAll || limit >= boundedRows.length
      ? boundedRows
      : boundedRows.slice(boundedRows.length - limit);
  return {
    epoch: state.epoch,
    direction,
    reset: false,
    staleCursor: false,
    gap: false,
    window,
    hasOlder: selected.length > 0 && selected[0].seq > minSeq,
    hasNewer: endExclusive >= 0,
    rows: selected.map(cloneRow),
  };
}

function fetchReset(
  ctx: FetchContext,
  flags: { staleCursor: boolean; gap: boolean },
): AgentTimelineFetchResult {
  const { state, direction, limit, selectAll, minSeq, window } = ctx;
  const rows =
    selectAll || limit >= state.rows.length
      ? state.rows.map(cloneRow)
      : state.rows.slice(state.rows.length - limit).map(cloneRow);
  return {
    epoch: state.epoch,
    direction,
    reset: true,
    staleCursor: flags.staleCursor,
    gap: flags.gap,
    window,
    hasOlder: rows.length > 0 && rows[0].seq > minSeq,
    hasNewer: false,
    rows,
  };
}

export class InMemoryAgentTimelineStore {
  private readonly states = new Map<string, AgentTimelineState>();

  has(agentId: string): boolean {
    return this.states.has(agentId);
  }

  initialize(agentId: string, options?: SeedAgentTimelineOptions): void {
    const timestamp = options?.timestamp ?? new Date().toISOString();
    const rows = options?.rows?.length
      ? options.rows.map(cloneRow)
      : this.buildRowsFromItems(options?.items ?? [], options?.nextSeq ?? 1, timestamp);
    const nextSeq = options?.nextSeq ?? (rows.length ? rows[rows.length - 1].seq + 1 : 1);
    this.states.set(agentId, {
      epoch: options?.epoch ?? randomUUID(),
      rows,
      nextSeq,
    });
  }

  delete(agentId: string): void {
    this.states.delete(agentId);
  }

  getItems(agentId: string): AgentTimelineItem[] {
    return this.requireState(agentId).rows.map((row) => row.item);
  }

  getRows(agentId: string): AgentTimelineRow[] {
    return this.requireState(agentId).rows.map(cloneRow);
  }

  getEpoch(agentId: string): string {
    return this.requireState(agentId).epoch;
  }

  fetch(agentId: string, options?: AgentTimelineFetchOptions): AgentTimelineFetchResult {
    const state = this.requireState(agentId);
    const direction = options?.direction ?? "tail";
    const requestedLimit = options?.limit;
    const limit =
      requestedLimit === undefined
        ? DEFAULT_TIMELINE_FETCH_LIMIT
        : Math.max(0, Math.floor(requestedLimit));
    const cursor = options?.cursor;
    const minSeq = state.rows.length ? state.rows[0].seq : 0;
    const maxSeq = state.rows.length ? state.rows[state.rows.length - 1].seq : 0;
    const selectAll = limit === 0;

    const window = {
      minSeq,
      maxSeq,
      nextSeq: state.nextSeq,
    };

    const ctx: FetchContext = {
      state,
      direction,
      limit,
      selectAll,
      cursor,
      minSeq,
      maxSeq,
      window,
    };

    if (cursor && typeof cursor.epoch === "string" && cursor.epoch !== state.epoch) {
      return fetchReset(ctx, { staleCursor: true, gap: false });
    }

    if (direction === "after" && cursor && state.rows.length > 0 && cursor.seq < minSeq - 1) {
      return fetchReset(ctx, { staleCursor: false, gap: true });
    }

    if (state.rows.length === 0) {
      return {
        epoch: state.epoch,
        direction,
        reset: false,
        staleCursor: false,
        gap: false,
        window,
        hasOlder: false,
        hasNewer: false,
        rows: [],
      };
    }

    if (direction === "tail") {
      return fetchTail(ctx);
    }
    if (direction === "after") {
      return fetchAfter(ctx);
    }
    return fetchBefore(ctx);
  }

  append(
    agentId: string,
    item: AgentTimelineItem,
    options?: { timestamp?: string },
  ): AgentTimelineRow {
    const state = this.requireState(agentId);
    const row: AgentTimelineRow = {
      seq: state.nextSeq,
      timestamp: options?.timestamp ?? new Date().toISOString(),
      item,
    };
    state.nextSeq += 1;
    state.rows.push(row);
    return cloneRow(row);
  }

  getLastItem(agentId: string): AgentTimelineItem | null {
    const state = this.requireState(agentId);
    return state.rows[state.rows.length - 1]?.item ?? null;
  }

  getLastAssistantMessage(agentId: string): string | null {
    const rows = this.requireState(agentId).rows;
    const chunks: string[] = [];
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const item = rows[i].item;
      if (item.type !== "assistant_message") {
        if (chunks.length > 0) {
          break;
        }
        continue;
      }
      chunks.push(item.text);
    }

    if (chunks.length === 0) {
      return null;
    }

    return chunks.toReversed().join("");
  }

  getCanonicalUserMessagesById(agentId: string): Map<string, string> {
    const entries = this.requireState(agentId).rows.flatMap<[string, string]>((row) => {
      if (row.item.type !== "user_message") {
        return [];
      }
      const messageId = normalizeTimelineMessageId(row.item.messageId);
      if (!messageId) {
        return [];
      }
      return [[messageId, row.item.text]];
    });
    return new Map(entries);
  }

  hasCommittedUserMessage(agentId: string, options: { messageId: string; text: string }): boolean {
    const messageId = normalizeTimelineMessageId(options.messageId);
    if (!messageId) {
      return false;
    }

    return this.requireState(agentId).rows.some((row) => {
      if (row.item.type !== "user_message") {
        return false;
      }
      const rowMessageId = normalizeTimelineMessageId(row.item.messageId);
      return rowMessageId === messageId && row.item.text === options.text;
    });
  }

  private requireState(agentId: string): AgentTimelineState {
    const state = this.states.get(agentId);
    if (!state) {
      throw new Error(`Unknown agent '${agentId}'`);
    }
    return state;
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
