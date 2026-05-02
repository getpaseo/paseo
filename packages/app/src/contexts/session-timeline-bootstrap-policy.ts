type InitialTimelineCursor = {
  epoch: string;
  seq: number;
} | null;

export function deriveInitialTimelineRequest({
  cursor,
  hasAuthoritativeHistory,
  initialTimelineLimit,
}: {
  cursor: InitialTimelineCursor;
  hasAuthoritativeHistory: boolean;
  initialTimelineLimit: number;
}): {
  direction: "tail" | "after";
  cursor?: { epoch: string; seq: number };
  limit: number;
  projection: "canonical";
} {
  if (!hasAuthoritativeHistory || !cursor) {
    return {
      direction: "tail",
      limit: initialTimelineLimit,
      projection: "canonical",
    };
  }

  return {
    direction: "after",
    cursor: { epoch: cursor.epoch, seq: cursor.seq },
    limit: 0,
    projection: "canonical",
  };
}
