import type { AgentAttentionReason } from "@getpaseo/protocol/agent-attention-notification";
import type { NotificationPolicy } from "@getpaseo/protocol/messages";

export const PRESENCE_THRESHOLD_MS = 180_000;

export interface ClientPresenceState {
  appVisible: boolean;
  lastActivityAtMs: number | null;
  focusedAgentId: string | null;
  focusedTerminalId: string | null;
}

export type AttentionFocusTarget = { kind: "agent"; id: string } | { kind: "terminal"; id: string };

export interface NotificationPlan {
  inAppRecipientIndex: number | null;
  shouldPush: boolean;
}

interface ComputeNotificationPlanInput {
  allStates: ClientPresenceState[];
  // A present, app-visible client focused on the attention target suppresses the
  // in-app banner for everyone. It only suppresses the remote push under "smart"
  // and "unwatched", not "always". Pass null when the target should not suppress
  // notifications.
  focusTarget: AttentionFocusTarget | null;
  // False for "error" reasons, in which case no mode sends a remote push.
  pushEligible: boolean;
  nowMs: number;
  // Controls when a remote push is sent to mobile devices. In-app routing is
  // unchanged in every mode. Defaults to "smart" (presence suppresses push).
  policy?: NotificationPolicy;
}

function isFocusedOnTarget(
  state: ClientPresenceState,
  target: AttentionFocusTarget | null,
): boolean {
  if (target === null) {
    return false;
  }
  if (target.kind === "agent") {
    return state.focusedAgentId === target.id;
  }
  return state.focusedTerminalId === target.id;
}

export function computeNotificationPlan({
  allStates,
  focusTarget,
  pushEligible,
  nowMs,
  policy = "smart",
}: ComputeNotificationPlanInput): NotificationPlan {
  let mostRecentPresentIndex: number | null = null;
  let mostRecentPresentAtMs = Number.NEGATIVE_INFINITY;
  let focusedOnTarget = false;

  for (const [clientIndex, state] of allStates.entries()) {
    const clampedActivityAtMs =
      state.lastActivityAtMs === null ? null : Math.min(state.lastActivityAtMs, nowMs);
    const isPresent =
      clampedActivityAtMs !== null && nowMs - clampedActivityAtMs <= PRESENCE_THRESHOLD_MS;

    if (!isPresent) {
      continue;
    }

    if (state.appVisible && isFocusedOnTarget(state, focusTarget)) {
      // A focused-visible client suppresses the in-app banner for everyone (in
      // every mode). Whether the remote push still goes out depends on the policy.
      focusedOnTarget = true;
      continue;
    }

    if (clampedActivityAtMs > mostRecentPresentAtMs) {
      mostRecentPresentIndex = clientIndex;
      mostRecentPresentAtMs = clampedActivityAtMs;
    }
  }

  return {
    inAppRecipientIndex: focusedOnTarget ? null : mostRecentPresentIndex,
    shouldPush: computeShouldPush({
      anyPresent: focusedOnTarget || mostRecentPresentIndex !== null,
      focusedOnTarget,
      pushEligible,
      policy,
    }),
  };
}

function computeShouldPush({
  anyPresent,
  focusedOnTarget,
  pushEligible,
  policy,
}: {
  anyPresent: boolean;
  focusedOnTarget: boolean;
  pushEligible: boolean;
  policy: NotificationPolicy;
}): boolean {
  if (!pushEligible) {
    return false;
  }
  switch (policy) {
    case "smart":
      // Push only when no client has been present recently (nobody around).
      return !anyPresent;
    case "unwatched":
      // Push unless someone is actively looking at the target.
      return !focusedOnTarget;
    case "always":
      return true;
    default:
      // Exhaustive guard: a future unknown mode must not silently inherit
      // "always" semantics.
      throw new Error(`Unknown notification policy: ${String(policy)}`);
  }
}

export function isPushEligibleAttentionReason(reason: AgentAttentionReason): boolean {
  return reason !== "error";
}
