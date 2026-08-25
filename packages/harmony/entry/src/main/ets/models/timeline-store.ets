/**
 * Timeline store — reactive ArkUI wrapper around timeline-core.
 *
 * Manages the timeline state for a single agent. Exposes @Observed state
 * that UI components bind to for automatic re-rendering.
 *
 * Usage:
 * ```typescript
 * const store = new TimelineStore();
 * store.loadInitialTimeline(entries);
 * // UI binds to store.tail, store.head, store.isLoading
 * ```
 */

import type {
  StreamItem,
  TimelineCursor,
  TimelineEvent,
} from './stream-types';
import {
  processTimelineResponse,
  reduceStreamUpdate,
  type TimelineResponsePayload,
  type TimelineResponseEntry,
  type ProcessTimelineOutput,
} from './timeline-core';

@Observed
export class TimelineStore {
  /** Canonical timeline items (persisted, paginated history). */
  tail: StreamItem[] = [];

  /** Live stream items (in-progress turn, not yet in tail). */
  head: StreamItem[] = [];

  /** Sequence number cursor for dedup. */
  cursor: TimelineCursor | undefined = undefined;

  /** True during an active fetch_agent_timeline RPC. */
  isLoading: boolean = false;

  /** True when the initial tail load is complete. */
  isInitialized: boolean = false;

  /** Error from the last fetch, if any. */
  lastError: string = '';

  /** True if there are older pages available. */
  hasOlder: boolean = false;

  /** True if there are newer pages available. */
  hasNewer: boolean = false;

  /** Total item count (tail + head). */
  get totalCount(): number {
    return this.tail.length + this.head.length;
  }

  /** All items concatenated (for flat-list rendering). */
  get allItems(): StreamItem[] {
    // Defensive: tail/head may be undefined during initial @ObjectLink
    // resolution before ArkUI proxies are fully wired.
    return [...(this.tail ?? []), ...(this.head ?? [])];
  }

  /** Reset to empty state. */
  reset(): void {
    this.tail = [];
    this.head = [];
    this.cursor = undefined;
    this.isLoading = false;
    this.isInitialized = false;
    this.lastError = '';
    this.hasOlder = false;
    this.hasNewer = false;
  }

  /**
   * Process a timeline response from the daemon.
   * Called after fetch_agent_timeline RPC completes.
   */
  applyResponse(payload: TimelineResponsePayload): void {
    this.isLoading = true;

    const result = processTimelineResponse({
      payload,
      currentTail: this.tail,
      currentHead: this.head,
      currentCursor: this.cursor,
    });

    this.applyResult(result);
  }

  /**
   * Apply a live stream event (from agent_stream session message).
   */
  applyLiveEvent(event: TimelineEvent): void {
    const timestamp = Date.now();

    // If we have a cursor, apply sequence gate using a synthetic seq
    // Live events from agent_stream don't carry seq numbers — they're
    // always appended to head.
    const newHead = reduceStreamUpdate(this.head, event, timestamp);
    this.head = newHead;
  }

  /**
   * Mark the store as loading (used during fetch RPC).
   */
  setLoading(loading: boolean): void {
    this.isLoading = loading;
  }

  /**
   * Set an error state.
   */
  setError(error: string): void {
    this.lastError = error;
    this.isLoading = false;
  }

  // -------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------

  private applyResult(result: ProcessTimelineOutput): void {
    this.tail = result.tail;
    this.head = result.head;
    this.cursor = result.cursor;
    this.lastError = result.error ?? '';
    this.hasMore = result.hasMore;
    this.isLoading = false;

    if (!this.isInitialized && result.cursorChanged) {
      this.isInitialized = true;
    }
  }

  private hasMore: boolean = false;
}

/**
 * Create a TimelineResponsePayload from a raw daemon response.
 *
 * In production, this comes from DaemonClient.fetchAgentTimeline().
 * This helper constructs the payload shape that timeline-core expects.
 */
export interface BuildTimelinePayloadParams {
  agentId: string;
  direction: 'tail' | 'before' | 'after';
  reset: boolean;
  epoch: string;
  startSeq: number | null;
  endSeq: number | null;
  entries: TimelineResponseEntry[];
  error: string | null;
  hasNewer: boolean;
  hasOlder: boolean;
}

export function buildTimelinePayload(params: BuildTimelinePayloadParams): TimelineResponsePayload {
  return {
    agentId: params.agentId,
    direction: params.direction,
    reset: params.reset,
    epoch: params.epoch,
    startSeq: params.startSeq,
    endSeq: params.endSeq,
    entries: params.entries,
    error: params.error,
    hasNewer: params.hasNewer,
    hasOlder: params.hasOlder,
  };
}
