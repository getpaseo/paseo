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

/**
 * Ambient reports have no routed tool call behind them, so there is no
 * requestId to match. What the app knows instead is which host it turned the
 * ambient watch on for, and which call it did that for — so the host is the key.
 *
 * One entry per target host: a host can only be watched for the one call the app
 * currently owns, and starting a new call replaces the registration.
 */
const ambientByTargetServerId = new Map<string, AmbientWatchEntry>();

interface AmbientWatchEntry {
  sourceServerId: string;
  liveSessionId: string;
}

export function trackAmbientLiveVoiceWatch(params: {
  targetServerId: string;
  sourceServerId: string;
  liveSessionId: string;
}): void {
  ambientByTargetServerId.set(params.targetServerId, {
    sourceServerId: params.sourceServerId,
    liveSessionId: params.liveSessionId,
  });
}

export function getAmbientLiveVoiceWatch(targetServerId: string): AmbientWatchEntry | null {
  return ambientByTargetServerId.get(targetServerId) ?? null;
}

export function forgetAmbientLiveVoiceWatch(targetServerId: string): void {
  ambientByTargetServerId.delete(targetServerId);
}

export function getAmbientLiveVoiceWatchHostsForCall(liveSessionId: string): string[] {
  const hosts: string[] = [];
  for (const [targetServerId, entry] of ambientByTargetServerId) {
    if (entry.liveSessionId === liveSessionId) {
      hosts.push(targetServerId);
    }
  }
  return hosts;
}

/** The call ended, so every host watching for it is watching for nothing. */
export function forgetAmbientLiveVoiceWatchesForCall(liveSessionId: string): void {
  for (const [targetServerId, entry] of ambientByTargetServerId) {
    if (entry.liveSessionId === liveSessionId) {
      ambientByTargetServerId.delete(targetServerId);
    }
  }
}

/** Test seam. */
export function resetRoutedLiveVoiceWork(): void {
  entriesByRequestId.clear();
  ambientByTargetServerId.clear();
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
