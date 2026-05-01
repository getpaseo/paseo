import { TIMELINE_FETCH_PAGE_SIZE } from "@/timeline/timeline-fetch-policy";

type InitialTimelineCursor = {
  epoch: string;
  seq: number;
} | null;

export function deriveInitialTimelineRequest({
  cursor,
  hasAuthoritativeHistory,
}: {
  cursor: InitialTimelineCursor;
  hasAuthoritativeHistory: boolean;
}): {
  direction: "tail" | "after";
  cursor?: { epoch: string; seq: number };
  limit: number;
  projection: "canonical";
} {
  if (!hasAuthoritativeHistory || !cursor) {
    return {
      direction: "tail",
      limit: TIMELINE_FETCH_PAGE_SIZE,
      projection: "canonical",
    };
  }

  return {
    direction: "after",
    cursor: { epoch: cursor.epoch, seq: cursor.seq },
    limit: TIMELINE_FETCH_PAGE_SIZE,
    projection: "canonical",
  };
}
