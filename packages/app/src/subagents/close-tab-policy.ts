import type { Agent } from "@/stores/session-store";

export type CloseAgentTabPolicy =
  | { kind: "archive-on-close"; confirmArchive: boolean }
  | { kind: "layout-only" };

type CloseTabAgent = Pick<
  Agent,
  "parentAgentId" | "status" | "backgroundWork" | "runningProviderSubagents"
>;

export function resolveCloseAgentTabPolicy(
  agent: CloseTabAgent | null | undefined,
): CloseAgentTabPolicy {
  if (agent?.parentAgentId) {
    return { kind: "layout-only" };
  }

  return { kind: "archive-on-close", confirmArchive: agent ? hasRunningWork(agent) : false };
}

// Archiving stops the agent's process, which also stops work it left running after its turn
// ended: background subagents and background shells.
function hasRunningWork(agent: CloseTabAgent): boolean {
  return (
    agent.status === "running" ||
    (agent.backgroundWork?.count ?? 0) > 0 ||
    (agent.runningProviderSubagents?.count ?? 0) > 0
  );
}
