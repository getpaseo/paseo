/**
 * Pure resolver for the extra slots in the working indicator: a live token count and a stalled
 * notice. Kept free of React and of any clock read so the whole decision table is assertable —
 * the caller supplies `idleMs`, this file never measures it.
 */

import { formatDuration } from "@/utils/time";

function resolveStallThresholdMs(): number {
  // Metro inlines `EXPO_PUBLIC_*` at bundle time, so this is a build-time constant and no
  // runtime backdoor ships. It exists solely because a 2-minute threshold is otherwise
  // unreachable in an e2e spec.
  const override = Number.parseInt(process.env.EXPO_PUBLIC_PASEO_STALL_THRESHOLD_MS ?? "", 10);
  return Number.isFinite(override) && override > 0 ? override : 120_000;
}

export const WORKING_INDICATOR_STALL_THRESHOLD_MS = resolveStallThresholdMs();

/**
 * The two slots are independent, not a choice between them: a stalled turn still shows its
 * count, because "how much output is at stake if I interrupt now" is exactly the question the
 * stall notice prompts. Either may be absent; both absent means the row renders nothing extra.
 */
export interface WorkingIndicatorActivity {
  /** Output the running turn has produced, when the provider reports a positive count. */
  outputTokens?: number;
  /** Observed silence, only when it qualifies as a stall. */
  stalledIdleMs?: number;
}

export function resolveWorkingIndicatorActivity(input: {
  /**
   * Milliseconds of observed silence, or undefined when it cannot be known — which is also how
   * the caller reports a daemon too old to measure idleness at all.
   */
  idleMs: number | undefined;
  activeTurnOutputTokens: number | undefined;
  hasPendingPermission: boolean;
  isConnected: boolean;
  /** Whether the agent directory is currently believed to be up to date for this host. */
  isDirectoryFresh: boolean;
  stallThresholdMs?: number;
}): WorkingIndicatorActivity {
  // `> 0`, not `!== undefined`: rendering "0 tokens" is noise, not information.
  const outputTokens =
    input.activeTurnOutputTokens !== undefined && input.activeTurnOutputTokens > 0
      ? input.activeTurnOutputTokens
      : undefined;

  // Every gate below suppresses only the stall notice; the count is never in doubt.
  //
  // A turn blocked on the user is not stalled. `onStreamPermissionRequested` leaves the agent
  // `running`, and the permission kinds cover tool prompts, question cards and plan approvals
  // alike, so this one check suppresses all three.
  if (input.hasPendingPermission) return { outputTokens };
  // Disconnected means we stopped receiving, not that the agent stopped producing.
  if (!input.isConnected) return { outputTokens };
  // Connected is not freshness: the replica cache restores `running` plus an old activity
  // value, so a cached agent would read as stalled between reconnect and rehydration. This has
  // to track every refetch, not just the first one — a socket that drops and resumes after a
  // phone sleeps re-enters exactly the same stale-replica window it did on cold start.
  if (!input.isDirectoryFresh) return { outputTokens };
  if (input.idleMs === undefined) return { outputTokens };

  const threshold = input.stallThresholdMs ?? WORKING_INDICATOR_STALL_THRESHOLD_MS;
  if (input.idleMs < threshold) return { outputTokens };
  return { outputTokens, stalledIdleMs: input.idleMs };
}

/**
 * Formats the stalled duration for display, reusing `formatDuration` so no second duration
 * formatter enters the codebase — it is the same function that renders the elapsed timer one
 * slot to the left.
 *
 * Floored to the minute once past a minute, so the label reads "4m" rather than "4m 37s" and
 * "1h 14m" rather than "74m". Below a minute it passes through unfloored: the shipped
 * threshold is two minutes so that branch is unreachable in production, but the e2e override
 * lowers the threshold and "no output for 0s" would be nonsense.
 */
export function formatStallDuration(idleMs: number): string {
  return idleMs >= 60_000
    ? formatDuration(Math.floor(idleMs / 60_000) * 60_000)
    : formatDuration(idleMs);
}

/**
 * How stale a snapshot may be when observation begins and still be extrapolated forward.
 *
 * Exists only to absorb ordering: on a cold open the agent record lands from the directory
 * fetch a moment *before* the footer mounts, so the gap is a few hundred milliseconds of render
 * scheduling rather than a real blind spot. Anything larger is a genuine blind spot.
 */
const UNOBSERVED_SNAPSHOT_GRACE_MS = 15_000;

/**
 * Combines the daemon's idle duration with the client's own observation of stream traffic.
 *
 * Two deltas, each measured entirely within one clock: the daemon measured `activeTurnIdleMs`
 * on its own clock at payload-build time, and the client adds only its own time since receipt.
 * No cross-clock comparison exists here, so skew between daemon and phone cannot affect it.
 *
 * The daemon's duration is extrapolated forward from receipt, which is only sound while the
 * client is receiving this agent's stream — that is what makes "nothing has happened since"
 * something it knows rather than something it assumes. `activeTurnIdleMs` refreshes only when
 * the daemon emits state, and timeline events do not, so a healthy agent deep in a long tool
 * call can easily carry a ten-minute-old snapshot. Extrapolating that across a window nobody was
 * watching would report ten minutes of silence for an agent that never stopped working, so when
 * the snapshot predates the observation window the daemon's value is replaced — not merely
 * capped — by the window itself: silence this client watched first-hand. That substitute starts
 * at zero and grows, so a real stall on a stale record still surfaces, late rather than wrong.
 *
 * Replaced rather than capped, because the window is zero-length at mount. Capping with it would
 * mean no stall could ever render for a full threshold after opening an agent — including the
 * case this whole mechanism exists for, a second client opening an agent that has genuinely been
 * silent for ten minutes.
 *
 * The last stream event the client actually saw shortens whichever of the two applies. Every
 * candidate can only ever shorten a claimed stall, so the calculation fails safe throughout.
 */
export function resolveIdleMs(input: {
  activeTurnIdleMs: number | undefined;
  activeTurnIdleReceivedAt: Date | undefined;
  lastStreamActivityAtMs: number | undefined;
  /** When this client began receiving the agent's stream. */
  observationStartedAtMs: number;
  nowMs: number;
}): number {
  const observedMs = Math.max(0, input.nowMs - input.observationStartedAtMs);
  let baselineMs = observedMs;
  if (input.activeTurnIdleMs !== undefined && input.activeTurnIdleReceivedAt !== undefined) {
    const receivedAtMs = input.activeTurnIdleReceivedAt.getTime();
    const unobservedGapMs = input.observationStartedAtMs - receivedAtMs;
    if (unobservedGapMs <= UNOBSERVED_SNAPSHOT_GRACE_MS) {
      baselineMs = input.activeTurnIdleMs + Math.max(0, input.nowMs - receivedAtMs);
    }
  }
  if (input.lastStreamActivityAtMs === undefined) return baselineMs;
  return Math.min(baselineMs, Math.max(0, input.nowMs - input.lastStreamActivityAtMs));
}
