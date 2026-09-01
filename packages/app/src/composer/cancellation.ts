export interface ComposerCancelClient {
  cancelAgent: (agentId: string, expectedTurnId?: string) => Promise<unknown> | void;
  getLastServerInfoMessage?: () => {
    features?: { exactTurnCancellation?: boolean };
  } | null;
}

export function requestComposerAgentCancellation(input: {
  client: ComposerCancelClient;
  agentId: string;
  expectedTurnId: string | null | undefined;
}): Promise<unknown> {
  const exactTurnCancellation =
    input.client.getLastServerInfoMessage?.()?.features?.exactTurnCancellation === true;
  if (exactTurnCancellation) {
    if (!input.expectedTurnId) {
      console.warn(
        "[Composer] Exact-turn cancellation unavailable: active turn identity is missing",
      );
      return Promise.reject(
        new Error("Cannot stop this agent because its active turn identity is unavailable"),
      );
    }
    return Promise.resolve(input.client.cancelAgent(input.agentId, input.expectedTurnId));
  }

  console.warn(
    "[Composer] Host does not advertise exact-turn cancellation; using legacy current-turn stop",
  );
  return Promise.resolve(input.client.cancelAgent(input.agentId));
}
