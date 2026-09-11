import type { SleepPreventionState } from "@/stores/session-store";

/**
 * Only the session fields the sleep-prevention indicator reads. Keeping the
 * derivation pure lets it be tested without a store or a renderer.
 */
export interface SleepPreventionSessionSlice {
  sleepPrevention?: SleepPreventionState | null;
}

/**
 * Whether any connected daemon is currently holding its machine awake. This is
 * what the daemon reports, not what the client could infer from agent state: a
 * host with no usable inhibitor runs agents without holding anything, and the
 * indicator must not claim otherwise.
 */
export function selectIsPreventingSleep(
  sessions: Record<string, SleepPreventionSessionSlice>,
): boolean {
  for (const session of Object.values(sessions)) {
    if (session.sleepPrevention?.active) return true;
  }
  return false;
}

/** Agents across all hosts that are currently holding a machine awake. */
export function selectSleepPreventionAgentCount(
  sessions: Record<string, SleepPreventionSessionSlice>,
): number {
  let total = 0;
  for (const session of Object.values(sessions)) {
    if (session.sleepPrevention?.active) total += session.sleepPrevention.agentCount;
  }
  return total;
}

/**
 * Whether a host can hold its machine awake at all. False on Windows, and on a
 * Linux host with no systemd-inhibit, so the setting can say why it is disabled
 * instead of silently doing nothing. Unknown hosts are assumed capable until
 * the daemon says otherwise.
 */
export function selectIsSleepPreventionSupported(
  session: SleepPreventionSessionSlice | undefined,
): boolean {
  return session?.sleepPrevention?.supported !== false;
}
