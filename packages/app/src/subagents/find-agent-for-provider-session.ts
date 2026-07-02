import type { useSessionStore } from "@/stores/session-store";

type SessionStoreSnapshot = ReturnType<typeof useSessionStore.getState>;

/**
 * Find the Paseo agent already bound to a provider session id — an earlier
 * import of the same subsession, matched via the agent's persistence handle.
 */
export function findAgentIdForProviderSession(
  state: SessionStoreSnapshot,
  params: { serverId: string; sessionId: string },
): string | null {
  const session = state.sessions[params.serverId];
  if (!session) {
    return null;
  }
  for (const source of [session.agents, session.agentDetails]) {
    for (const agent of source.values()) {
      if (agent.persistence?.sessionId === params.sessionId) {
        return agent.id;
      }
    }
  }
  return null;
}
