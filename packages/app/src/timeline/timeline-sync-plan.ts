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

export interface CanonicalTimelineTailFetchPlan {
  direction: "tail";
  limit: number;
  projection: "canonical";
}

export interface CanonicalTimelineAfterFetchPlan {
  direction: "after";
  cursor: TimelineSyncCursor;
  limit: number;
  projection: "canonical";
}

export interface CanonicalTimelineBeforeFetchPlan {
  direction: "before";
  cursor: TimelineSyncCursor;
  limit: number;
  projection: "canonical";
}

export type CanonicalTimelineFetchPlan =
  | CanonicalTimelineTailFetchPlan
  | CanonicalTimelineAfterFetchPlan
  | CanonicalTimelineBeforeFetchPlan;

export type CanonicalTimelineForwardFetchPlan =
  | CanonicalTimelineTailFetchPlan
  | CanonicalTimelineAfterFetchPlan;

export function planInitialAgentTimelineSync(input: {
  cursor: AgentTimelineCursorRange | undefined;
  hasAuthoritativeHistory: boolean;
}): CanonicalTimelineForwardFetchPlan {
  if (input.hasAuthoritativeHistory && input.cursor) {
    return planTimelineCatchUpAfter({ epoch: input.cursor.epoch, seq: input.cursor.endSeq });
  }

  return planTimelineTailFetch();
}

export function planResumeTimelineSync(input: {
  cursor: AgentTimelineCursorRange | undefined;
}): CanonicalTimelineForwardFetchPlan {
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
    projection: "canonical",
  } as const;
}

export function planTimelineTailFetch() {
  return {
    direction: "tail",
    limit: TIMELINE_FETCH_PAGE_SIZE,
    projection: "canonical",
  } as const;
}

export function planTimelineOlderFetch(cursor: TimelineSyncCursor) {
  return {
    direction: "before",
    cursor,
    limit: TIMELINE_FETCH_PAGE_SIZE,
    projection: "canonical",
  } as const;
}

export function planTimelineCatchUpFollowUp(input: {
  direction: "tail" | "before" | "after";
  hasNewer: boolean;
  endCursor: TimelineSyncCursor | null;
  error: string | null;
}): CanonicalTimelineAfterFetchPlan | null {
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
