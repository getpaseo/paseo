import { limitAgentTimelineItemContent } from "../../agent-timeline-content.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
} from "../../agent-timeline-store-types.js";
import type {
  ProjectedTimelinePageOptions,
  ProjectedTimelinePageSelection,
} from "../../timeline-projection.js";

const DEFAULT_TIMELINE_FETCH_LIMIT = 200;

export interface TimelinePageHistory {
  epoch: string;
  /** 0 before any commit. */
  minSeq: number;
  nextSeq: number;
  retirementCount: number;
}

/**
 * The fetch contract every backend shares: cursor validation, gap and stale-cursor resets, and the
 * served item budget. `selectPage` is the backend's projected page selection.
 */
export function fetchTimelinePage(input: {
  history: TimelinePageHistory;
  options: AgentTimelineFetchOptions;
  selectPage: (options: ProjectedTimelinePageOptions) => ProjectedTimelinePageSelection;
}): AgentTimelineFetchResult {
  const { history, options } = input;
  const direction = options.direction ?? "tail";
  const cursor = options.cursor;
  const hasRows = history.minSeq !== 0;
  const window = {
    minSeq: history.minSeq,
    maxSeq: history.nextSeq - 1,
    nextSeq: history.nextSeq,
  };
  const staleCursor =
    cursor !== undefined &&
    (cursor.epoch !== history.epoch ||
      (cursor.retirementCount !== undefined && cursor.retirementCount !== history.retirementCount));
  const gap =
    !staleCursor &&
    direction === "after" &&
    cursor !== undefined &&
    hasRows &&
    cursor.seq < history.minSeq - 1;
  const reset = staleCursor || gap;
  const page = input.selectPage({
    bounds: window,
    direction: reset ? "tail" : direction,
    cursorSeq: cursor?.seq,
    limit: options.limit ?? DEFAULT_TIMELINE_FETCH_LIMIT,
    wholeTurns: options.wholeTurns,
  });
  return {
    epoch: history.epoch,
    direction,
    reset,
    staleCursor,
    gap,
    window,
    hasOlder: page.hasOlder,
    hasNewer: page.hasNewer,
    startSeq: page.startSeq,
    endSeq: page.endSeq,
    // Stored rows are already within budget; this bounds assistant and reasoning merges.
    rows: page.entries.map((entry) =>
      Object.assign({ seq: entry.seqEnd }, entry, {
        item: limitAgentTimelineItemContent(entry.item),
      }),
    ),
    retirements: page.retirements,
    retirementCount: history.retirementCount,
  };
}
