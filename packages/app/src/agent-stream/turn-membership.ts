import { continuesTimelineTurn, isTimelineTurnTrigger } from "@getpaseo/protocol/timeline-turn";
import type { StreamItem } from "@/types/stream";

/**
 * Canonical turn IDs take precedence. Timelines without them retain the legacy
 * trigger boundary rule; missing IDs cannot reconstruct historical batching.
 */
export function continuesTurn(previous: StreamItem | null, next: StreamItem | null): boolean {
  if (!previous || !next) return false;
  return continuesTimelineTurn(previous.turnId, next.turnId, isTurnTrigger(next));
}

/**
 * Every canonical turn owns its response, including system-triggered runs.
 */
export function continuesResponse(previous: StreamItem | null, next: StreamItem | null): boolean {
  if (!previous || !next) return false;
  return continuesTurn(previous, next);
}

export function isTurnBoundary(previous: StreamItem | null, next: StreamItem | null): boolean {
  return previous !== null && next !== null && !continuesTurn(previous, next);
}

export function isResponseBoundary(previous: StreamItem | null, next: StreamItem | null): boolean {
  return previous !== null && next !== null && !continuesResponse(previous, next);
}

/** Whether `item` begins a new chronological turn after `previous`. */
export function startsNewTurn(item: StreamItem, previous: StreamItem | null): boolean {
  return previous === null || isTurnBoundary(previous, item);
}

export function belongsToTurn(item: StreamItem, turnId: string | null): boolean {
  return turnId !== null && item.turnId === turnId;
}

/** Inputs that start a turn when older history has no canonical turn IDs. */
export function isTurnTrigger(item: StreamItem): boolean {
  return isTimelineTurnTrigger(
    item.kind === "tool_call" && item.payload.source === "agent"
      ? { type: item.kind, ...item.payload.data }
      : { type: item.kind },
  );
}
