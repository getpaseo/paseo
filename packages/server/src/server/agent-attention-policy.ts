import type { AgentAttentionReason } from "@getpaseo/protocol/agent-attention-notification";

export const PRESENCE_THRESHOLD_MS = 180_000;

export interface ClientPresenceState {
  deviceType?: "web" | "mobile";
  pushToken?: string | null;
  lastHeartbeatAtMs?: number;
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
  // notification entirely. Pass null when the target should not suppress notifications.
  focusTarget: AttentionFocusTarget | null;
  // Whether a push notification is allowed when no client is present.
  pushEligible: boolean;
  nowMs: number;
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
}: ComputeNotificationPlanInput): NotificationPlan {
  let mostRecentPresentIndex: number | null = null;
  let mostRecentPresentAtMs = Number.NEGATIVE_INFINITY;

  for (const [clientIndex, state] of allStates.entries()) {
    const clampedActivityAtMs =
      state.lastActivityAtMs === null ? null : Math.min(state.lastActivityAtMs, nowMs);
    const isPresent =
      clampedActivityAtMs !== null && nowMs - clampedActivityAtMs <= PRESENCE_THRESHOLD_MS;

    if (!isPresent) {
      continue;
    }

    if (state.appVisible && isFocusedOnTarget(state, focusTarget)) {
      return { inAppRecipientIndex: null, shouldPush: false };
    }

    if (clampedActivityAtMs > mostRecentPresentAtMs) {
      mostRecentPresentIndex = clientIndex;
      mostRecentPresentAtMs = clampedActivityAtMs;
    }
  }

  if (mostRecentPresentIndex !== null) {
    return { inAppRecipientIndex: mostRecentPresentIndex, shouldPush: false };
  }

  return { inAppRecipientIndex: null, shouldPush: pushEligible };
}

export function isPushEligibleAttentionReason(reason: AgentAttentionReason): boolean {
  return reason !== "error";
}

export function computeRemoteNotificationPlan(
  input: ComputeNotificationPlanInput & {
    mode: "always_push" | "smart" | "legacy";
  },
): { expoEligible: boolean; excludedExpoTokens: string[]; ntfyEligible: boolean } {
  const excludedExpoTokens: string[] = [];
  if (input.mode === "smart") {
    for (const state of input.allStates) {
      const activity = state.lastActivityAtMs;
      const heartbeat = state.lastHeartbeatAtMs;
      if (
        state.deviceType === "mobile" &&
        state.pushToken &&
        state.appVisible &&
        isFocusedOnTarget(state, input.focusTarget) &&
        activity !== null &&
        heartbeat !== undefined &&
        activity <= input.nowMs &&
        heartbeat <= input.nowMs &&
        input.nowMs - activity < 30_000 &&
        input.nowMs - heartbeat < 30_000
      ) {
        excludedExpoTokens.push(state.pushToken);
      }
    }
  }
  return {
    expoEligible:
      input.pushEligible && (input.mode !== "legacy" || computeNotificationPlan(input).shouldPush),
    excludedExpoTokens,
    ntfyEligible: input.pushEligible,
  };
}
