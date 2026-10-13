import type { ProjectedTimelineRow } from "./timeline-projection.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";

export interface AgentTimelineRow {
  seq: number;
  timestamp: string;
  item: AgentTimelineItem;
  readonly turnId?: string;
  readonly providerMessageId?: string;
}

export interface AgentTimelineCursor {
  epoch: string;
  seq: number;
}

export type AgentTimelineFetchDirection = "tail" | "before" | "after";

export interface AgentTimelineFetchOptions {
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
}

export interface AgentTimelineTailRead {
  /** Parsed rows in file (seq) order, deduplicated per seq with the newest line winning. */
  rows: AgentTimelineRow[];
  /**
   * Whether no committed rows older than the returned range remain (within the
   * `maxSeq` filter). `false` means more rows may exist above; the caller
   * decides from its own boundary check.
   */
  atStart: boolean;
}

export interface AgentTimelineStore {
  appendCommitted(
    agentId: string,
    item: AgentTimelineItem,
    options?: { timestamp?: string; turnId?: string },
  ): Promise<AgentTimelineRow>;
  fetchCommitted(
    agentId: string,
    options?: AgentTimelineFetchOptions,
  ): Promise<AgentTimelineFetchResult>;
  getLatestCommittedSeq(agentId: string): Promise<number>;
  getCommittedRows(agentId: string): Promise<AgentTimelineRow[]>;
  /**
   * Read up to `count` committed rows from the end of the log, skipping the
   * `offset` newest eligible rows. `options.maxSeq` limits which rows are
   * eligible so callers can page below the in-memory window without
   * re-counting the rows the window already serves. Implementations must not
   * materialize rows newer than the returned range.
   */
  readTailRows(
    agentId: string,
    options: { maxSeq?: number; offset: number; count: number },
  ): Promise<AgentTimelineTailRead>;
  /**
   * When `options.maxSeq` is given, only rows with a seq at or below it are
   * considered, so callers can ask for history strictly below the in-memory
   * window without re-counting rows the window already serves.
   */
  getLastItem(agentId: string, options?: { maxSeq?: number }): Promise<AgentTimelineItem | null>;
  getLastAssistantMessage(agentId: string, options?: { maxSeq?: number }): Promise<string | null>;
  deleteAgent(agentId: string): Promise<void>;
  bulkInsert(agentId: string, rows: readonly AgentTimelineRow[]): Promise<void>;
  updateCommittedRow(agentId: string, row: AgentTimelineRow): Promise<void>;
}
