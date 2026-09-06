import type { VoiceLiveAgentNotification } from "@getpaseo/protocol/live-voice-routing";

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
  agentId?: string;
  terminalClaimed?: boolean;
  createdAt: number;
}

interface ObservedAgentCompletion {
  notification: VoiceLiveAgentNotification;
  observedAt: number;
}

/**
 * Routed calls that started nothing simply never produce a report, so entries
 * accumulate. The cap is a leak bound, not a functional limit: reports arrive
 * within one call, and the oldest entries are the ones least likely to still
 * matter.
 */
const MAX_TRACKED_REQUESTS = 500;

const entriesByRequestId = new Map<string, RoutedWorkEntry>();
const observedCompletionsByAgent = new Map<string, ObservedAgentCompletion>();

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

/**
 * Adds the agent identity learned from the target tool response to a request
 * that was tracked before execution. A completion can beat that response back
 * to the app, so this also returns any generic completion observed after the
 * routed request began.
 */
export function associateRoutedLiveVoiceAgent(
  requestId: string,
  agentId: string,
): ObservedAgentCompletion["notification"] | null {
  pruneExpiredEntries();
  const entry = entriesByRequestId.get(requestId);
  if (!entry) {
    return null;
  }
  entry.agentId = agentId;
  const key = agentKey(entry.targetServerId, agentId);
  const observed = observedCompletionsByAgent.get(key);
  if (!observed || observed.observedAt < entry.createdAt) {
    return null;
  }
  observedCompletionsByAgent.delete(key);
  return observed.notification;
}

export function getRoutedLiveVoiceWorkForAgent(
  targetServerId: string,
  agentId: string,
): (RoutedWorkEntry & { requestId: string }) | null {
  pruneExpiredEntries();
  let match: (RoutedWorkEntry & { requestId: string }) | null = null;
  for (const [requestId, entry] of entriesByRequestId) {
    if (entry.targetServerId !== targetServerId || entry.agentId !== agentId) {
      continue;
    }
    if (!match || entry.createdAt > match.createdAt) {
      match = { ...entry, requestId };
    }
  }
  return match;
}

/** True when this agent is already correlated or could satisfy an in-flight response. */
export function canMatchPendingRoutedLiveVoiceWork(
  targetServerId: string,
  agentId: string,
): boolean {
  pruneExpiredEntries();
  for (const entry of entriesByRequestId.values()) {
    if (
      entry.targetServerId === targetServerId &&
      (entry.agentId === agentId || entry.agentId === undefined)
    ) {
      return true;
    }
  }
  return false;
}

/** Prevents the target-specific update and the normal client event racing into two speeches. */
export function claimRoutedLiveVoiceNotification(requestId: string, reason: string): boolean {
  const entry = entriesByRequestId.get(requestId);
  if (!entry) {
    return false;
  }
  // Permission events are already deduplicated by request id on the daemon.
  // One turn can need several approvals before it completes.
  if (reason === "needs_permission") {
    return true;
  }
  if (entry.terminalClaimed) {
    return false;
  }
  entry.terminalClaimed = true;
  return true;
}

export function releaseRoutedLiveVoiceNotificationClaim(requestId: string, reason: string): void {
  const entry = entriesByRequestId.get(requestId);
  if (entry && reason !== "needs_permission") {
    entry.terminalClaimed = false;
  }
}

/**
 * Keeps a normal client-observed completion until the routed tool response
 * identifies which agent it started. Receipt time is compared with request
 * creation time so an old completion cannot satisfy a later prompt to the same
 * agent.
 */
export function rememberObservedLiveVoiceCompletion(params: {
  targetServerId: string;
  notification: ObservedAgentCompletion["notification"];
}): void {
  pruneExpiredEntries();
  observedCompletionsByAgent.set(agentKey(params.targetServerId, params.notification.agentId), {
    notification: params.notification,
    observedAt: Date.now(),
  });
  while (observedCompletionsByAgent.size > MAX_TRACKED_REQUESTS) {
    const oldest = observedCompletionsByAgent.keys().next();
    if (oldest.done) return;
    observedCompletionsByAgent.delete(oldest.value);
  }
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
  observedCompletionsByAgent.clear();
  ambientByTargetServerId.clear();
}

const MAX_ENTRY_AGE_MS = 24 * 60 * 60 * 1_000;

function pruneExpiredEntries(): void {
  const cutoff = Date.now() - MAX_ENTRY_AGE_MS;
  for (const [requestId, entry] of entriesByRequestId) {
    if (entry.createdAt < cutoff) {
      entriesByRequestId.delete(requestId);
    }
  }
  for (const [key, observed] of observedCompletionsByAgent) {
    if (observed.observedAt < cutoff) {
      observedCompletionsByAgent.delete(key);
    }
  }
}

function agentKey(serverId: string, agentId: string): string {
  return `${serverId}\u0000${agentId}`;
}
