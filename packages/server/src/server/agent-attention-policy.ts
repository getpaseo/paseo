import type { AgentAttentionReason } from "../shared/agent-attention-notification.js";

export const PRESENCE_THRESHOLD_MS = 180_000;

export interface ClientPresenceState {
  lastActivityAtMs: number | null;
  focusedAgentId: string | null;
}

export interface NotificationPlan {
  inAppRecipientIndex: number | null;
  shouldPush: boolean;
}

type ComputeNotificationPlanInput = {
  allStates: ClientPresenceState[];
  agentId: string;
  reason: AgentAttentionReason;
  nowMs: number;
};

export function computeNotificationPlan({
  allStates,
  agentId,
  reason,
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

    if (state.focusedAgentId === agentId) {
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

  return { inAppRecipientIndex: null, shouldPush: reason !== "error" };
}
