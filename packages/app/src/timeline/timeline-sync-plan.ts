import { TIMELINE_FETCH_PAGE_SIZE } from "@/timeline/timeline-fetch-policy";

export interface TimelineSyncCursor {
  epoch: string;
  seq: number;
}

export interface AgentTimelineCursorRange {
  epoch: string;
  startSeq: number;
  endSeq: number;
}

export interface ProjectedTimelineTailFetchPlan {
  direction: "tail";
  limit: number;
  projection: "projected";
}

export interface ProjectedTimelineAfterFetchPlan {
  direction: "after";
  cursor: TimelineSyncCursor;
  limit: number;
  projection: "projected";
}

export interface ProjectedTimelineBeforeFetchPlan {
  direction: "before";
  cursor: TimelineSyncCursor;
  limit: number;
  projection: "projected";
}

export type ProjectedTimelineFetchPlan =
  | ProjectedTimelineTailFetchPlan
  | ProjectedTimelineAfterFetchPlan
  | ProjectedTimelineBeforeFetchPlan;

export type ProjectedTimelineForwardFetchPlan =
  | ProjectedTimelineTailFetchPlan
  | ProjectedTimelineAfterFetchPlan;

export function planInitialAgentTimelineSync(input: {
  cursor: AgentTimelineCursorRange | undefined;
  hasAuthoritativeHistory: boolean;
}): ProjectedTimelineForwardFetchPlan {
  if (input.hasAuthoritativeHistory && input.cursor) {
    return planTimelineCatchUpAfter({ epoch: input.cursor.epoch, seq: input.cursor.endSeq });
  }

  return planTimelineTailFetch();
}

export function planResumeTimelineSync(input: {
  cursor: AgentTimelineCursorRange | undefined;
}): ProjectedTimelineForwardFetchPlan {
  if (input.cursor) {
    return planTimelineCatchUpAfter({ epoch: input.cursor.epoch, seq: input.cursor.endSeq });
  }

  return planTimelineTailFetch();
}

export function planTimelineCatchUpAfter(cursor: TimelineSyncCursor) {
  return {
    direction: "after",
    cursor,
    limit: TIMELINE_FETCH_PAGE_SIZE,
    projection: "projected",
  } as const;
}

export function planTimelineTailFetch() {
  return {
    direction: "tail",
    limit: TIMELINE_FETCH_PAGE_SIZE,
    projection: "projected",
  } as const;
}

export function planTimelineOlderFetch(cursor: TimelineSyncCursor) {
  return {
    direction: "before",
    cursor,
    limit: TIMELINE_FETCH_PAGE_SIZE,
    projection: "projected",
  } as const;
}

export function planTimelineCatchUpFollowUp(input: {
  direction: "tail" | "before" | "after";
  hasNewer: boolean;
  endCursor: TimelineSyncCursor | null;
  error: string | null;
}): ProjectedTimelineAfterFetchPlan | null {
  if (input.error || input.direction !== "after" || !input.hasNewer || !input.endCursor) {
    return null;
  }

  return planTimelineCatchUpAfter(input.endCursor);
}

export function isTimelineCatchUpComplete(input: {
  direction: "tail" | "before" | "after";
  hasNewer: boolean;
  error: string | null;
}): boolean {
  if (input.error) {
    return false;
  }

  return input.direction !== "after" || !input.hasNewer;
}
