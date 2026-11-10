import type { AgentTimelineItem } from "../../agent-sdk-types.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
} from "../../agent-timeline-store-types.js";
import type { ProjectedTimelineRow } from "../../timeline-projection.js";

/** Root history uses `agentId` alone; provider-child history adds the child's id. */
export interface TimelineScope {
  agentId: string;
  subagentId?: string;
}

export interface TimelineEntry {
  item: AgentTimelineItem;
  timestamp?: string;
  turnId?: string;
  providerMessageId?: string;
}

export interface TimelineSeed {
  entries?: readonly TimelineEntry[];
  /** Already-sequenced rows, e.g. an imported session. Takes precedence over `entries`. */
  rows?: readonly AgentTimelineRow[];
  nextSeq?: number;
  epoch?: string;
  timestamp?: string;
}

export interface TimelineHead {
  epoch: string;
  /** Projected (displayed) row count. */
  size: number;
}

export interface TimelineBackendAppendResult {
  rows: AgentTimelineRow[];
  head: TimelineHead;
}

type MaybePromise<T> = T | Promise<T>;

/**
 * Storage for the timeline owner. Each mutating call is one atomic commit: it either applies
 * fully and returns, or throws having changed nothing. The owner serializes calls per agent, so
 * a backend never sees concurrent calls for one agent. Callers outside the timeline module never
 * see a backend.
 */
export interface AgentTimelineBackend {
  create(scope: TimelineScope, seed: TimelineSeed): MaybePromise<TimelineHead>;
  delete(scope: TimelineScope): MaybePromise<void>;
  head(scope: TimelineScope): MaybePromise<TimelineHead | null>;
  /** Allocates the next sequence numbers and folds the entries into the projection. */
  append(
    scope: TimelineScope,
    entries: readonly TimelineEntry[],
  ): MaybePromise<TimelineBackendAppendResult>;
  attachProviderMessageId(
    scope: TimelineScope,
    clientMessageId: string,
    providerMessageId: string,
  ): MaybePromise<AgentTimelineRow | null>;
  findSubmittedPrompt(
    scope: TimelineScope,
    clientMessageId: string,
  ): MaybePromise<AgentTimelineRow | null>;
  fetch(
    scope: TimelineScope,
    options: AgentTimelineFetchOptions,
  ): MaybePromise<AgentTimelineFetchResult>;
  readRows(scope: TimelineScope): MaybePromise<ProjectedTimelineRow[]>;
  lastItem(scope: TimelineScope): MaybePromise<AgentTimelineItem | null>;
  /** The trailing run of assistant messages joined, skipping later non-assistant rows. */
  lastAssistantMessage(scope: TimelineScope): MaybePromise<string | null>;
}

/** The scope has no history: it was never created, or it was deleted. */
export class UnknownTimelineError extends Error {
  constructor(readonly scope: TimelineScope) {
    super(
      scope.subagentId === undefined
        ? `Unknown agent '${scope.agentId}'`
        : `Unknown timeline '${scope.agentId}/${scope.subagentId}'`,
    );
    this.name = "UnknownTimelineError";
  }
}
