export type ClientAttentionState = {
  deviceType: "web" | "mobile" | null;
  focusedAgentId: string | null;
  isStale: boolean;
  appVisible: boolean;
};

export type AgentAttentionReason = "finished" | "error" | "permission";

type ComputeClientNotificationInput = {
  clientState: ClientAttentionState;
  allClientStates: ClientAttentionState[];
  agentId: string;
};

type ComputePushNotificationInput = {
  reason: AgentAttentionReason;
  allClientStates: ClientAttentionState[];
};

function hasActiveClientOnAgent(
  allClientStates: ClientAttentionState[],
  agentId: string
): boolean {
  return allClientStates.some(
    (state) => state.focusedAgentId === agentId && state.appVisible && !state.isStale
  );
}

function hasActiveWebClient(allClientStates: ClientAttentionState[]): boolean {
  return allClientStates.some((state) => state.deviceType === "web" && !state.isStale);
}

function hasOtherCompetingClient(
  clientState: ClientAttentionState,
  allClientStates: ClientAttentionState[]
): boolean {
  return allClientStates.some(
    (state) =>
      state !== clientState && (state.deviceType === "mobile" || state.deviceType === null)
  );
}

function hasActiveForegroundMobileClient(allClientStates: ClientAttentionState[]): boolean {
  return allClientStates.some(
    (state) => state.deviceType === "mobile" && state.appVisible && !state.isStale
  );
}

export function computeShouldNotifyClient({
  clientState,
  allClientStates,
  agentId,
}: ComputeClientNotificationInput): boolean {
  if (hasActiveClientOnAgent(allClientStates, agentId)) {
    return false;
  }

  if (clientState.deviceType === null) {
    return true;
  }

  if (!clientState.isStale && clientState.appVisible && clientState.focusedAgentId !== null) {
    return true;
  }

  if (!clientState.isStale) {
    return false;
  }

  if (clientState.deviceType === "mobile") {
    return !hasActiveWebClient(allClientStates);
  }

  if (clientState.deviceType === "web") {
    return !hasOtherCompetingClient(clientState, allClientStates);
  }

  return true;
}

export function computeShouldSendPush({
  reason,
  allClientStates,
}: ComputePushNotificationInput): boolean {
  if (reason === "error") {
    return false;
  }

  return !hasActiveWebClient(allClientStates) && !hasActiveForegroundMobileClient(allClientStates);
}
