import type { AgentTimelineItem } from "../../agent-sdk-types.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
} from "../../agent-timeline-store-types.js";
import type { ConversationRewindCut } from "../../agent-sdk-types.js";
import type { ProjectedTimelineRow, TimelineRetirement } from "../../timeline-projection.js";
import type { ProviderSubagentDescriptor } from "../../provider-subagents/store.js";

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
  /** Rewinds applied since the history was created. */
  retirementCount: number;
  /** The rewind in progress, or one whose provider outcome is not settled yet. */
  rewind: TimelineRewindIntent | null;
}

/**
 * A conversation rewind between its start and its retirement commit. It refuses new prompts and
 * other rewinds. Without `cut` the provider outcome is unknown; with it the provider applied the
 * rewind and only the local commit is outstanding.
 */
export interface TimelineRewindIntent {
  id: string;
  /** The rewound prompt's `messageId`. */
  messageId: string;
  /** The rewound prompt's anchor. */
  targetSeq: number;
  cut?: ConversationRewindCut;
}

/** An active user prompt: what a rewind addresses. */
export interface TimelinePrompt {
  seqStart: number;
  messageId: string | undefined;
  /** The provider's id for the prompt, when it differs from `messageId`. */
  providerMessageId: string | undefined;
  /** Submitted by Paseo; the provider knows it only once `providerMessageId` is attached. */
  submitted: boolean;
}

/** A provider child of an agent: its listing, stored with the child's scope. */
export interface TimelineChild {
  subagentId: string;
  /** Null until the provider describes the child; such a child is not listed. */
  descriptor: ProviderSubagentDescriptor | null;
  /** Spawned by a rewound turn. Its rows stay stored; it is no longer listed. */
  retired: boolean;
}

/** Picks the children a retirement takes with it, from the rows it retires. */
export type RetiredChildSelector = (
  retiredRows: readonly ProjectedTimelineRow[],
  children: readonly TimelineChild[],
) => readonly string[];

export interface TimelineBackendAppendResult {
  rows: AgentTimelineRow[];
  head: TimelineHead;
}

export interface TimelineBackendRetireResult {
  retirement: TimelineRetirement;
  /** The rows that left the active conversation. They stay stored. */
  retiredRows: ProjectedTimelineRow[];
  /** The children the retirement marked retired. */
  retiredChildIds: string[];
  head: TimelineHead;
}

export type MaybePromise<T> = T | Promise<T>;

/**
 * Storage for the timeline owner. Each mutating call is one atomic commit: it either applies
 * fully and returns, or throws having changed nothing. The owner serializes calls per agent, so
 * a backend never sees concurrent calls for one agent. Callers outside the timeline module never
 * see a backend.
 */
export interface AgentTimelineBackend {
  create(scope: TimelineScope, seed: TimelineSeed): MaybePromise<TimelineHead>;
  /** Deleting a root scope deletes every child scope of the agent too, retired ones included. */
  delete(scope: TimelineScope): MaybePromise<void>;
  head(scope: TimelineScope): MaybePromise<TimelineHead | null>;
  /** Allocates the next sequence numbers and folds the entries into the projection. */
  append(
    scope: TimelineScope,
    entries: readonly TimelineEntry[],
  ): MaybePromise<TimelineBackendAppendResult>;
  /** Whether a new entry would land on retired history (see `TimelineProjection.isRetired`). */
  isRetired(scope: TimelineScope, entry: TimelineEntry): MaybePromise<boolean>;
  /** Active user prompts in display order. */
  prompts(scope: TimelineScope): MaybePromise<TimelinePrompt[]>;
  setRewind(scope: TimelineScope, rewind: TimelineRewindIntent | null): MaybePromise<TimelineHead>;
  /**
   * Allocates the next sequence number for a retirement of the active rows anchored at or after
   * `retireFromSeq`, marks the children `selectChildren` picks retired, and clears the rewind
   * intent, in one commit. `selectChildren` is pure.
   */
  retire(
    scope: TimelineScope,
    input: { retireFromSeq: number; selectChildren: RetiredChildSelector },
  ): MaybePromise<TimelineBackendRetireResult>;
  /** The agent's children, retired ones included, in no particular order. */
  children(agentId: string): MaybePromise<TimelineChild[]>;
  /** The child of a child scope; null when the scope does not exist. */
  child(scope: TimelineScope): MaybePromise<TimelineChild | null>;
  /** Stores a child's descriptor, creating its scope when absent. */
  setChild(scope: TimelineScope, descriptor: ProviderSubagentDescriptor): MaybePromise<void>;
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
