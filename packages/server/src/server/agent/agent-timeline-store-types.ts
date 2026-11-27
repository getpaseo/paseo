import type { ProjectedTimelineRow, TimelineRetirement } from "./timeline-projection.js";
import type { AgentMetric, AgentProvider, AgentTimelineItem } from "./agent-sdk-types.js";

export interface AgentTimelineRow {
  seq: number;
  timestamp: string;
  item: AgentTimelineItem;
  /** The provider that wrote the row; an agent's history can span providers. */
  readonly provider?: AgentProvider;
  readonly turnId?: string;
  readonly providerMessageId?: string;
  /**
   * Daemon-internal provider-facing prompt text (e.g. including rendered attachments/handoff).
   * Used for reload reconciliation; never emitted over the wire.
   */
  readonly providerPromptText?: string;
  /** True when a submitted prompt was rejected before the provider accepted any turn; never emitted over the wire. */
  readonly rejected?: boolean;
  /** Metrics of the turn this row carries the footer for. */
  readonly turnMetrics?: AgentMetric[];
}

export interface AgentTimelineCursor {
  epoch: string;
  seq: number;
  /**
   * For a reader that cannot apply retirements: the retirement count its view reflects. The
   * cursor is stale once another retirement has happened.
   */
  retirementCount?: number;
}

export type AgentTimelineFetchDirection = "tail" | "before" | "after";

export interface AgentTimelineFetchOptions {
  wholeTurns?: boolean;
  direction?: AgentTimelineFetchDirection;
  cursor?: AgentTimelineCursor;
  /**
   * Number of projected items to return.
   * - undefined: store default
   * - 0: all rows in the selected window
   */
  limit?: number;
}

export interface AgentTimelineWindow {
  minSeq: number;
  maxSeq: number;
  nextSeq: number;
}

export interface AgentTimelineFetchResult {
  epoch: string;
  direction: AgentTimelineFetchDirection;
  reset: boolean;
  staleCursor: boolean;
  gap: boolean;
  window: AgentTimelineWindow;
  hasOlder: boolean;
  hasNewer: boolean;
  startSeq: number | null;
  endSeq: number | null;
  rows: ProjectedTimelineRow[];
  /** Retirements whose seq lies in the page's span. A client applies them before the rows. */
  retirements: TimelineRetirement[];
  /** Retirements of this history so far. */
  retirementCount: number;
  /** Seq of the latest active provider_switch marker, or 0 if never switched. */
  activeSegmentStartSeq: number;
}
