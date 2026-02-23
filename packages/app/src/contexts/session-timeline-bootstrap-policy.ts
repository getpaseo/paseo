type TimelineDirection = "tail" | "before" | "after";
type InitRequestDirection = "tail" | "after";

type TimelineCursor = {
  seq: number;
} | null;

export function deriveBootstrapTailTimelinePolicy({
  direction,
  reset,
  epoch,
  endCursor,
  isInitializing,
  hasActiveInitDeferred,
}: {
  direction: TimelineDirection;
  reset: boolean;
  epoch: string;
  endCursor: TimelineCursor;
  isInitializing: boolean;
  hasActiveInitDeferred: boolean;
}): {
  replace: boolean;
  catchUpCursor: { epoch: string; endSeq: number } | null;
} {
  if (reset) {
    return { replace: true, catchUpCursor: null };
  }

  const isBootstrapTailInit =
    direction === "tail" && isInitializing && hasActiveInitDeferred;
  if (!isBootstrapTailInit) {
    return { replace: false, catchUpCursor: null };
  }

  return {
    replace: true,
    catchUpCursor: endCursor ? { epoch, endSeq: endCursor.seq } : null,
  };
}

export function shouldResolveTimelineInit({
  hasActiveInitDeferred,
  isInitializing,
  initRequestDirection,
  responseDirection,
  reset,
}: {
  hasActiveInitDeferred: boolean;
  isInitializing: boolean;
  initRequestDirection: InitRequestDirection;
  responseDirection: TimelineDirection;
  reset: boolean;
}): boolean {
  if (!hasActiveInitDeferred || !isInitializing) {
    return false;
  }
  if (reset) {
    return true;
  }
  return responseDirection === initRequestDirection;
}
