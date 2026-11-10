import type { AgentProvider, AgentTimelineItem } from "../agent-sdk-types.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
} from "../agent-timeline-store-types.js";
import type { AgentTimeline, TimelineScope } from "../timeline/index.js";

export type ProviderSubagentStatus = "running" | "completed" | "failed" | "canceled";

export interface ProviderSubagentDescriptor {
  id: string;
  parentAgentId: string;
  /** Direct provider-subagent parent. Null identifies a child of the managed agent. */
  parentSubagentId: string | null;
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
      parentSubagentId?: string | null;
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

function childScope(parentAgentId: string, subagentId: string): TimelineScope {
  return { agentId: parentAgentId, subagentId };
}

/**
 * Sticky upsert semantics for a descriptor field: an omitted value preserves what is stored, an
 * explicit `null` clears it. Providers observe these fields incrementally, so a partial upsert
 * must never blank fields it says nothing about.
 */
function stickyField<T>(next: T | undefined, previous: T | null | undefined): T | null {
  return next === undefined ? (previous ?? null) : next;
}

export class ProviderSubagentStore {
  private readonly descriptors = new Map<string, ProviderSubagentDescriptor>();
  /** Children of rewound turns. Their history stays stored; late provider events are dropped. */
  private readonly retired = new Set<string>();

  constructor(private readonly timeline: AgentTimeline) {}

  /** Resolves null when the event belongs to a retired child; nothing is recorded. */
  async apply(
    parentAgentId: string,
    provider: AgentProvider,
    event: ProviderSubagentInputEvent,
  ): Promise<ProviderSubagentStoreEvent | null> {
    const key = storeKey(parentAgentId, event.id);
    const scope = childScope(parentAgentId, event.id);
    if (this.retired.has(key)) return null;
    if (event.type === "remove") {
      this.descriptors.delete(key);
      await this.timeline.delete(scope);
      return { type: "remove", parentAgentId, subagentId: event.id };
    }

    if (event.type === "timeline") {
      await this.timeline.open(scope);
      const {
        commits: [{ row, epoch }],
      } = await this.timeline.append(scope, [{ item: event.item, timestamp: event.timestamp }]);
      return {
        type: "timeline",
        parentAgentId,
        subagentId: event.id,
        provider,
        row,
        epoch,
      };
    }

    const previous = this.descriptors.get(key);
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
      parentSubagentId: stickyField(event.parentSubagentId, previous?.parentSubagentId),
    };
    this.descriptors.set(key, subagent);
    await this.timeline.open(scope);
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
  ): Promise<AgentTimelineFetchResult> {
    return this.timeline.fetch(childScope(parentAgentId, subagentId), options);
  }

  /**
   * Retires the children spawned by retired tool calls of the parent, and their descendants. They
   * leave the listing; their history stays stored.
   */
  retireSpawnedBy(
    parentAgentId: string,
    toolCallIds: ReadonlySet<string>,
  ): Extract<ProviderSubagentStoreEvent, { type: "remove" }>[] {
    const children = this.list(parentAgentId);
    const retiredIds = new Set(
      children
        .filter((subagent) => subagent.toolCallId !== null && toolCallIds.has(subagent.toolCallId))
        .map((subagent) => subagent.id),
    );
    let grew = retiredIds.size > 0;
    while (grew) {
      grew = false;
      for (const subagent of children) {
        if (retiredIds.has(subagent.id) || subagent.parentSubagentId === null) continue;
        if (!retiredIds.has(subagent.parentSubagentId)) continue;
        retiredIds.add(subagent.id);
        grew = true;
      }
    }
    return [...retiredIds].map((subagentId) => {
      const key = storeKey(parentAgentId, subagentId);
      this.descriptors.delete(key);
      this.retired.add(key);
      return { type: "remove", parentAgentId, subagentId };
    });
  }

  async deleteParent(parentAgentId: string): Promise<ProviderSubagentStoreEvent[]> {
    const prefix = storeKey(parentAgentId, "");
    const retired = [...this.retired]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
    for (const subagentId of retired) this.retired.delete(storeKey(parentAgentId, subagentId));
    const removed = this.list(parentAgentId).map((subagent) => subagent.id);
    for (const subagentId of removed) {
      this.descriptors.delete(storeKey(parentAgentId, subagentId));
    }
    await Promise.all(
      [...removed, ...retired].map((subagentId) =>
        this.timeline.delete(childScope(parentAgentId, subagentId)),
      ),
    );
    return removed.map((subagentId) => ({ type: "remove", parentAgentId, subagentId }));
  }
}
