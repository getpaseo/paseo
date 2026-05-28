import type { Agent } from "@/stores/session-store";

export function shouldAutoOpenAgentTab(agent: Pick<Agent, "parentAgentId">): boolean {
  return !agent.parentAgentId;
}
