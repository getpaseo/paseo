import type { AgentCapabilityFlags } from "@getpaseo/protocol/agent-types";
import type { SessionState } from "@/stores/session-store";

/** The agent's rewind capabilities on a host, or null while the agent is unknown. */
export function selectPluginRewindCapabilities(
  sessions: Record<string, SessionState | undefined>,
  hostId: string,
  agentId: string,
): AgentCapabilityFlags | null {
  const session = sessions[hostId];
  const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
  return agent?.capabilities ?? null;
}
