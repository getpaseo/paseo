import type { Agent } from "@/stores/session-store";

export type CloseAgentTabPolicy = { kind: "archive-on-close" } | { kind: "layout-only" };

export function resolveCloseAgentTabPolicy(
  agent: Pick<Agent, "parentAgentId"> | null | undefined,
): CloseAgentTabPolicy {
  // Never archive when parentage cannot be confirmed — missing agents may be
  // subagents that only live in agentDetails or have not hydrated yet.
  if (!agent) {
    return { kind: "layout-only" };
  }

  if (agent.parentAgentId) {
    return { kind: "layout-only" };
  }

  return { kind: "archive-on-close" };
}

export function resolveAgentForCloseTabPolicy(input: {
  agentId: string;
  agents: Map<string, Agent> | undefined;
  agentDetails: Map<string, Agent> | undefined;
}): Agent | null {
  const { agentId, agents, agentDetails } = input;
  return agents?.get(agentId) ?? agentDetails?.get(agentId) ?? null;
}

export function shouldArchiveAgentOnTabClose(policy: CloseAgentTabPolicy): boolean {
  return policy.kind === "archive-on-close";
}
