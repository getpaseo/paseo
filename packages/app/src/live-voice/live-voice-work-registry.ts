/**
 * Remembers which Live Voice call each routed tool call was made for.
 *
 * A target host reports finished work back to the socket that started it and
 * says nothing about calls: it is never told which call the work belongs to, and
 * telling it would make one daemon's claim about another daemon's call
 * load-bearing. The app made both hops, so the app is the only party that can
 * put the two ends together — this map is that knowledge, and it is why a report
 * from host B can never be spoken into a call the user does not own on host A.
 */

interface RoutedWorkEntry {
  sourceServerId: string;
  targetServerId: string;
  liveSessionId: string;
  createdAt: number;
}

/**
 * Routed calls that started nothing simply never produce a report, so entries
 * accumulate. The cap is a leak bound, not a functional limit: reports arrive
 * within one call, and the oldest entries are the ones least likely to still
 * matter.
 */
const MAX_TRACKED_REQUESTS = 500;

const entriesByRequestId = new Map<string, RoutedWorkEntry>();

export function trackRoutedLiveVoiceWork(params: {
  requestId: string;
  sourceServerId: string;
  targetServerId: string;
  liveSessionId: string;
}): void {
  pruneExpiredEntries();
  entriesByRequestId.set(params.requestId, {
    sourceServerId: params.sourceServerId,
    targetServerId: params.targetServerId,
    liveSessionId: params.liveSessionId,
    createdAt: Date.now(),
  });
  while (entriesByRequestId.size > MAX_TRACKED_REQUESTS) {
    const oldest = entriesByRequestId.keys().next();
    if (oldest.done) {
      return;
    }
    entriesByRequestId.delete(oldest.value);
  }
}

/**
 * Resolves the call a report belongs to. Permission reports are non-terminal,
 * so the router forgets entries only after a terminal report or failed delivery.
 */
export function getRoutedLiveVoiceWork(requestId: string): RoutedWorkEntry | null {
  pruneExpiredEntries();
  return entriesByRequestId.get(requestId) ?? null;
}

export function forgetRoutedLiveVoiceWork(requestId: string): void {
  entriesByRequestId.delete(requestId);
}

export function forgetRoutedLiveVoiceWorkForSource(sourceServerId: string): void {
  for (const [requestId, entry] of entriesByRequestId) {
    if (entry.sourceServerId === sourceServerId) {
      entriesByRequestId.delete(requestId);
    }
  }
}

/** Test seam. */
export function resetRoutedLiveVoiceWork(): void {
  entriesByRequestId.clear();
}

const MAX_ENTRY_AGE_MS = 24 * 60 * 60 * 1_000;

function pruneExpiredEntries(): void {
  const cutoff = Date.now() - MAX_ENTRY_AGE_MS;
  for (const [requestId, entry] of entriesByRequestId) {
    if (entry.createdAt >= cutoff) {
      break;
    }
    entriesByRequestId.delete(requestId);
  }
}
