import { DaemonConnectionError } from "@getpaseo/client/internal/daemon-client";

interface CallerLookupClient {
  fetchAgent(options: { agentId: string }): Promise<{ agent: { id: string } } | null>;
}

// PASEO_AGENT_ID belongs to the daemon that launched this shell. Commands
// targeting another daemon (--host or --home) have no caller on that daemon.
export async function resolveCallerAgentId(
  client: CallerLookupClient,
  env: { PASEO_AGENT_ID?: string } = process.env,
): Promise<string | undefined> {
  const agentId = env.PASEO_AGENT_ID?.trim();
  if (!agentId) return undefined;
  const caller = await client.fetchAgent({ agentId }).catch((error: unknown) => {
    // A missing agent is a daemon answer; a lost or timed-out connection is not.
    if (error instanceof DaemonConnectionError) throw error;
    return null;
  });
  return caller?.agent.id === agentId ? agentId : undefined;
}
