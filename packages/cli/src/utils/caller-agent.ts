import { DaemonConnectionError } from "@getpaseo/client/internal/daemon-client";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";

/** The agent running this shell, as its daemon knows it. */
export type CallerAgent = Pick<AgentSnapshotPayload, "id" | "cwd">;

interface CallerLookupClient {
  fetchAgent(options: { agentId: string }): Promise<{ agent: CallerAgent } | null>;
}

// PASEO_AGENT_ID belongs to the daemon that launched this shell. Commands
// targeting another daemon (--host or --home) have no caller on that daemon.
export async function resolveCallerAgent(
  client: CallerLookupClient,
  env: { PASEO_AGENT_ID?: string } = process.env,
): Promise<CallerAgent | undefined> {
  const agentId = env.PASEO_AGENT_ID?.trim();
  if (!agentId) return undefined;
  const caller = await client.fetchAgent({ agentId }).catch((error: unknown) => {
    // A missing agent is a daemon answer; a lost or timed-out connection is not.
    if (error instanceof DaemonConnectionError) throw error;
    return null;
  });
  if (caller?.agent.id !== agentId) return undefined;
  return { id: caller.agent.id, cwd: caller.agent.cwd };
}

export async function resolveCallerAgentId(
  client: CallerLookupClient,
  env: { PASEO_AGENT_ID?: string } = process.env,
): Promise<string | undefined> {
  return (await resolveCallerAgent(client, env))?.id;
}
