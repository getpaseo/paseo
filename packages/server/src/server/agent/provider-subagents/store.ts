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

/**
 * Applies provider child events to the parent's timeline, which stores each child's descriptor,
 * history and retirement next to the parent's own history.
 */
export class ProviderSubagentStore {
  constructor(private readonly timeline: AgentTimeline) {}

  /** Resolves null when the event belongs to a retired child; nothing is recorded. */
  async apply(
    parentAgentId: string,
    provider: AgentProvider,
    event: ProviderSubagentInputEvent,
  ): Promise<ProviderSubagentStoreEvent | null> {
    const scope = childScope(parentAgentId, event.id);
    if (event.type === "remove") {
      if (!(await this.timeline.removeChild(scope))) return null;
      return { type: "remove", parentAgentId, subagentId: event.id };
    }

    if (event.type === "timeline") {
      const commits = await this.timeline.recordChildEntries(scope, [
        { item: event.item, timestamp: event.timestamp },
      ]);
      if (!commits) return null;
      const [{ row, epoch }] = commits;
      return {
        type: "timeline",
        parentAgentId,
        subagentId: event.id,
        provider,
        row,
        epoch,
      };
    }

    const subagent = await this.timeline.recordChild(scope, (previous) => {
      const timestamp = event.timestamp ?? new Date().toISOString();
      return {
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
    });
    return subagent ? { type: "upsert", subagent } : null;
  }

  /**
   * Applies the child events of a provider history read. Children the parent already holds,
   * listed or retired, are skipped: like the parent's, their owned history is never changed.
   */
  async applyHistory(
    parentAgentId: string,
    events: readonly { provider: AgentProvider; event: ProviderSubagentInputEvent }[],
  ): Promise<ProviderSubagentStoreEvent[]> {
    const held = new Set(
      (await this.timeline.listChildren(parentAgentId)).map((child) => child.subagentId),
    );
    const updates: ProviderSubagentStoreEvent[] = [];
    for (const { provider, event } of events) {
      if (held.has(event.id)) continue;
      const update = await this.apply(parentAgentId, provider, event);
      if (update) updates.push(update);
    }
    return updates;
  }

  /** The parent's listed children, oldest first. Retired children are not listed. */
  async list(parentAgentId: string): Promise<ProviderSubagentDescriptor[]> {
    return (await this.timeline.listChildren(parentAgentId))
      .flatMap((child) => (!child.retired && child.descriptor ? [child.descriptor] : []))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async get(parentAgentId: string, subagentId: string): Promise<ProviderSubagentDescriptor | null> {
    return (await this.list(parentAgentId)).find((child) => child.id === subagentId) ?? null;
  }

  fetchTimeline(
    parentAgentId: string,
    subagentId: string,
    options?: AgentTimelineFetchOptions,
  ): Promise<AgentTimelineFetchResult> {
    return this.timeline.fetch(childScope(parentAgentId, subagentId), options);
  }

  /** Deletes the parent's history and every child's, retired children included. */
  async deleteParent(parentAgentId: string): Promise<ProviderSubagentStoreEvent[]> {
    const listed = await this.list(parentAgentId);
    await this.timeline.delete({ agentId: parentAgentId });
    return listed.map((child) => ({ type: "remove", parentAgentId, subagentId: child.id }));
  }
}
