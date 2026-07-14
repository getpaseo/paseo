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
}

export type ProviderSubagentInputEvent =
  | {
      type: "upsert";
      id: string;
      title?: string | null;
      description?: string | null;
      status: ProviderSubagentStatus;
      toolCallId?: string | null;
      cwd?: string | null;
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

export class ProviderSubagentStore {
  private readonly descriptors = new Map<string, ProviderSubagentDescriptor>();
  private readonly timelines = new InMemoryAgentTimelineStore();

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
      title: event.title === undefined ? (previous?.title ?? null) : event.title,
      description:
        event.description === undefined ? (previous?.description ?? null) : event.description,
      status: event.status,
      createdAt: previous?.createdAt ?? timestamp,
      updatedAt: timestamp,
      toolCallId:
        event.toolCallId === undefined ? (previous?.toolCallId ?? null) : event.toolCallId,
      cwd: event.cwd === undefined ? (previous?.cwd ?? null) : event.cwd,
    };
    this.descriptors.set(key, subagent);
    return { type: "upsert", subagent };
  }

  list(parentAgentId: string): ProviderSubagentDescriptor[] {
    return [...this.descriptors.values()]
      .filter((subagent) => subagent.parentAgentId === parentAgentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
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
    const timeline = this.timelines.fetch(storeKey(parentAgentId, subagentId), {
      ...options,
      limit: 0,
    });
    if (limit === 0 || timeline.rows.length === 0) {
      return timeline;
    }
    const selected = selectTimelineWindowByProjectedLimit({
      rows: timeline.rows,
      direction: timeline.reset ? "tail" : direction,
      limit,
    });
    const firstRow = selected.selectedRows[0];
    const lastRow = selected.selectedRows[selected.selectedRows.length - 1];
    return {
      ...timeline,
      rows: selected.selectedRows,
      hasOlder:
        timeline.hasOlder || (firstRow !== undefined && firstRow.seq > timeline.window.minSeq),
      hasNewer:
        timeline.hasNewer || (lastRow !== undefined && lastRow.seq < timeline.window.maxSeq),
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
