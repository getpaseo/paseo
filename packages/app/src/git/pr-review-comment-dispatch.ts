import type { Agent } from "@/stores/session-store";

type AgentIdentity = Pick<Agent, "id" | "cwd">;

// Resolve which agent a "Fix with agent" dispatch should target. The decision is
// to inject into the workspace's active agent: prefer the focused agent when it
// belongs to this workspace, otherwise the first agent in the workspace. Returns
// null when the workspace has no agent — the caller disables the action.
export function resolveReviewCommentAgentId(input: {
  agents: ReadonlyMap<string, AgentIdentity> | undefined;
  focusedAgentId: string | null;
  cwd: string;
}): string | null {
  const { agents, focusedAgentId, cwd } = input;
  if (!agents) {
    return null;
  }
  if (focusedAgentId) {
    const focused = agents.get(focusedAgentId);
    if (focused && focused.cwd === cwd) {
      return focused.id;
    }
  }
  for (const agent of agents.values()) {
    if (agent.cwd === cwd) {
      return agent.id;
    }
  }
  return null;
}
