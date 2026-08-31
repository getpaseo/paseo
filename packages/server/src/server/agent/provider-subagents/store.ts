import type { AgentProvider, AgentTimelineItem } from "../agent-sdk-types.js";
import { limitAgentTimelineItemContent } from "../agent-timeline-content.js";
import { InMemoryAgentTimelineStore } from "../agent-timeline-store.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
} from "../agent-timeline-store-types.js";
import { selectTimelineWindowByProjectedLimit } from "../timeline-projection.js";

export type ProviderSubagentStatus = "running" | "completed" | "failed" | "canceled";

export interface ProviderSubagentDescriptor {
  id: string;
  parentAgentId: string;
  provider: AgentProvider;
  title: string | null;
  description: string | null;
  status: ProviderSubagentStatus;
  createdAt: string;
  updatedAt: string;
  toolCallId: string | null;
  cwd: string | null;
  subtitle: string | null;
}

export type ProviderSubagentInputEvent =
  | {
      type: "upsert";
      id: string;
      title?: string | null;
      description?: string | null;
      /**
       * Omit to keep the stored status. A presentation-only upsert says nothing about whether the
       * child is still running, and must not revert a finished one.
       */
      status?: ProviderSubagentStatus;
      toolCallId?: string | null;
      cwd?: string | null;
      subtitle?: string | null;
      timestamp?: string;
    }
  | {
      type: "timeline";
      id: string;
      item: AgentTimelineItem;
      timestamp?: string;
    }
  | { type: "remove"; id: string };

export type ProviderSubagentStoreEvent =
  | { type: "upsert"; subagent: ProviderSubagentDescriptor }
  | {
      type: "timeline";
      parentAgentId: string;
      subagentId: string;
      provider: AgentProvider;
      row: AgentTimelineRow;
      epoch: string;
    }
  | { type: "remove"; parentAgentId: string; subagentId: string };

function storeKey(parentAgentId: string, subagentId: string): string {
  return `${parentAgentId}\0${subagentId}`;
}

/**
 * Sticky upsert semantics for a descriptor field: an omitted value preserves what is stored, an
 * explicit `null` clears it. Providers observe these fields incrementally, so a partial upsert
 * must never blank fields it says nothing about.
 */
function stickyField<T>(next: T | undefined, previous: T | null | undefined): T | null {
  return next === undefined ? (previous ?? null) : next;
}

export type ProviderSubagentTimelineStore = Pick<
  InMemoryAgentTimelineStore,
  "append" | "delete" | "fetch" | "getEpoch" | "getToolCallSeqBounds" | "has" | "initialize"
>;

const MAX_CANONICAL_PAGE_SIZE = 200;

function initialCanonicalPageSize(projectedLimit: number): number {
  if (projectedLimit === 0) {
    return MAX_CANONICAL_PAGE_SIZE;
  }
  return Math.min(MAX_CANONICAL_PAGE_SIZE, Math.max(1, projectedLimit));
}

function expansionPageSize(accumulatedRows: number): number {
  return Math.min(MAX_CANONICAL_PAGE_SIZE, Math.max(1, accumulatedRows));
}

function projectedSelectionNeedsMoreRows(input: {
  direction: NonNullable<AgentTimelineFetchOptions["direction"]>;
  limit: number;
  timeline: AgentTimelineFetchResult;
  rows: readonly AgentTimelineRow[];
  selected: ReturnType<typeof selectTimelineWindowByProjectedLimit>;
  getToolCallSeqBounds: (callId: string) => { minSeq: number; maxSeq: number } | null;
}): "older" | "newer" | null {
  const { direction, limit, timeline, rows, selected, getToolCallSeqBounds } = input;
  const firstRow = rows[0];
  const lastRow = rows.at(-1);
  if (!firstRow || !lastRow) {
    return null;
  }

  const expandToward = direction === "after" ? "newer" : "older";
  const hasMore =
    expandToward === "newer"
      ? lastRow.seq < timeline.window.maxSeq
      : firstRow.seq > timeline.window.minSeq;
  if (!hasMore) {
    return null;
  }

  if (limit === 0 || selected.projectedEntries.length < limit) {
    return expandToward;
  }

  const hasToolCallRowsBeyondPage = selected.projectedEntries.some((entry) => {
    if (entry.item.type !== "tool_call") {
      return false;
    }
    const bounds = getToolCallSeqBounds(entry.item.callId);
    if (!bounds) {
      return false;
    }
    return expandToward === "newer" ? bounds.maxSeq > lastRow.seq : bounds.minSeq < firstRow.seq;
  });
  if (hasToolCallRowsBeyondPage) {
    return expandToward;
  }

  const boundarySeq = expandToward === "newer" ? lastRow.seq : firstRow.seq;
  const canMergeAcrossBoundary = selected.projectedEntries.some(
    (entry) =>
      entry.sourceSeqRanges.some(
        (range) => boundarySeq >= range.startSeq && boundarySeq <= range.endSeq,
      ) &&
      (entry.item.type === "assistant_message" || entry.item.type === "reasoning"),
  );
  return canMergeAcrossBoundary ? expandToward : null;
}

export class ProviderSubagentStore {
  private readonly descriptors = new Map<string, ProviderSubagentDescriptor>();

  constructor(
    private readonly timelines: ProviderSubagentTimelineStore = new InMemoryAgentTimelineStore(),
  ) {}

  apply(
    parentAgentId: string,
    provider: AgentProvider,
    event: ProviderSubagentInputEvent,
  ): ProviderSubagentStoreEvent {
    const key = storeKey(parentAgentId, event.id);
    if (event.type === "remove") {
      this.descriptors.delete(key);
      this.timelines.delete(key);
      return { type: "remove", parentAgentId, subagentId: event.id };
    }

    if (event.type === "timeline") {
      if (!this.timelines.has(key)) {
        this.timelines.initialize(key);
      }
      const row = this.timelines.append(key, limitAgentTimelineItemContent(event.item), {
        timestamp: event.timestamp,
      });
      return {
        type: "timeline",
        parentAgentId,
        subagentId: event.id,
        provider,
        row,
        epoch: this.timelines.getEpoch(key),
      };
    }

    const previous = this.descriptors.get(key);
    if (!this.timelines.has(key)) {
      this.timelines.initialize(key);
    }
    const timestamp = event.timestamp ?? new Date().toISOString();
    const subagent: ProviderSubagentDescriptor = {
      id: event.id,
      parentAgentId,
      provider,
      title: stickyField(event.title, previous?.title),
      description: stickyField(event.description, previous?.description),
      status: event.status ?? previous?.status ?? "running",
      createdAt: previous?.createdAt ?? timestamp,
      updatedAt: timestamp,
      toolCallId: stickyField(event.toolCallId, previous?.toolCallId),
      cwd: stickyField(event.cwd, previous?.cwd),
      subtitle: stickyField(event.subtitle, previous?.subtitle),
    };
    this.descriptors.set(key, subagent);
    return { type: "upsert", subagent };
  }

  list(parentAgentId: string): ProviderSubagentDescriptor[] {
    return [...this.descriptors.values()]
      .filter((subagent) => subagent.parentAgentId === parentAgentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  listAll(): ProviderSubagentDescriptor[] {
    return [...this.descriptors.values()];
  }

  get(parentAgentId: string, subagentId: string): ProviderSubagentDescriptor | null {
    return this.descriptors.get(storeKey(parentAgentId, subagentId)) ?? null;
  }

  fetchTimeline(
    parentAgentId: string,
    subagentId: string,
    options?: AgentTimelineFetchOptions,
  ): AgentTimelineFetchResult {
    const direction = options?.direction ?? "tail";
    const limit = options?.limit === undefined ? 200 : Math.max(0, Math.floor(options.limit));
    const key = storeKey(parentAgentId, subagentId);
    const timeline = this.timelines.fetch(key, {
      ...options,
      limit: initialCanonicalPageSize(limit),
    });
    if (timeline.rows.length === 0) {
      return timeline;
    }
    const selectionDirection = timeline.reset ? "tail" : direction;
    let rows = timeline.rows;
    let selected = selectTimelineWindowByProjectedLimit({
      rows,
      direction: selectionDirection,
      limit,
    });
    for (;;) {
      const expandToward = projectedSelectionNeedsMoreRows({
        direction: selectionDirection,
        limit,
        timeline,
        rows,
        selected,
        getToolCallSeqBounds: (callId) => this.timelines.getToolCallSeqBounds(key, callId),
      });
      if (!expandToward) {
        break;
      }

      const boundaryRow = expandToward === "older" ? rows[0] : rows.at(-1);
      if (!boundaryRow) {
        break;
      }
      const page = this.timelines.fetch(key, {
        direction: expandToward === "older" ? "before" : "after",
        cursor: { epoch: timeline.epoch, seq: boundaryRow.seq },
        limit: expansionPageSize(rows.length),
      });
      if (page.rows.length === 0) {
        break;
      }
      rows = expandToward === "older" ? [...page.rows, ...rows] : [...rows, ...page.rows];
      selected = selectTimelineWindowByProjectedLimit({
        rows,
        direction: selectionDirection,
        limit,
      });
    }
    const firstRow = selected.selectedRows[0];
    const lastRow = selected.selectedRows[selected.selectedRows.length - 1];
    return {
      ...timeline,
      rows: selected.selectedRows,
      hasOlder: firstRow ? firstRow.seq > timeline.window.minSeq : timeline.hasOlder,
      hasNewer: lastRow ? lastRow.seq < timeline.window.maxSeq : timeline.hasNewer,
    };
  }

  deleteParent(parentAgentId: string): ProviderSubagentStoreEvent[] {
    const events: ProviderSubagentStoreEvent[] = [];
    for (const subagent of this.list(parentAgentId)) {
      const key = storeKey(parentAgentId, subagent.id);
      this.descriptors.delete(key);
      this.timelines.delete(key);
      events.push({ type: "remove", parentAgentId, subagentId: subagent.id });
    }
    return events;
  }
}
