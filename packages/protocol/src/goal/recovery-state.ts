import type { Goal, Recovery } from "./types.js";

/** Recovery statuses during which the goal waits for its recovery and takes no other reopen. */
export const LIVE_RECOVERY_STATUSES: ReadonlySet<string> = new Set([
  "deciding",
  "decided",
  "awaiting_approval",
]);

/** The recovery still deciding, being applied or waiting for approval, if any. */
export function liveRecovery(goal: Pick<Goal, "recovery">): Recovery | null {
  const recovery = goal.recovery;
  return recovery && LIVE_RECOVERY_STATUSES.has(recovery.status) ? recovery : null;
}
