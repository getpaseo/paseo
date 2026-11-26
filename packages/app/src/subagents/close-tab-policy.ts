import type { Agent } from "@/stores/session-store";

export type CloseAgentTabPolicy = { kind: "archive-on-close" } | { kind: "layout-only" };

export function resolveCloseAgentTabPolicy(
  agent: Pick<Agent, "parentAgentId"> | null | undefined,
): CloseAgentTabPolicy {
  if (agent?.parentAgentId) {
    return { kind: "layout-only" };
  }

  return { kind: "archive-on-close" };
}

export type CloseAgentTabConfirmation = "archive-running-agent" | "archive-agent" | null;

/**
 * Which confirm dialog closing a single agent tab needs. A running agent always asks because
 * archiving stops its work; an idle one asks only when the user opted in, since closing a root
 * agent's tab archives it.
 */
export function resolveCloseAgentTabConfirmation(
  agent: Pick<Agent, "parentAgentId" | "status"> | null | undefined,
  options: { alwaysConfirmArchive: boolean },
): CloseAgentTabConfirmation {
  if (resolveCloseAgentTabPolicy(agent).kind !== "archive-on-close") {
    return null;
  }
  if (agent?.status === "running") {
    return "archive-running-agent";
  }
  return options.alwaysConfirmArchive ? "archive-agent" : null;
}
