import type { Agent } from "@/stores/session-store";

export type CloseAgentTabPolicy =
  | { kind: "archive-on-close"; confirmArchive: boolean }
  | { kind: "layout-only" };

export function resolveCloseAgentTabPolicy(
  agent: Pick<Agent, "parentAgentId" | "status" | "backgroundWork"> | null | undefined,
): CloseAgentTabPolicy {
  if (agent?.parentAgentId) {
    return { kind: "layout-only" };
  }

  return { kind: "archive-on-close", confirmArchive: hasRunningWork(agent) };
}

// Archiving stops the agent's process, which also stops background work it left running after
// its turn ended, such as a background subagent or shell.
function hasRunningWork(agent: Pick<Agent, "status" | "backgroundWork"> | null | undefined) {
  return agent?.status === "running" || (agent?.backgroundWork?.count ?? 0) > 0;
}
