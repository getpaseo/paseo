import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import { memoizeOnSessionMaps } from "./memoize-on-session-maps";

export type FaviconStatus = "none" | "running" | "attention";

interface FaviconAgentSession {
  agents: ReadonlyMap<string, Agent>;
  workspaces: ReadonlyMap<string, Pick<WorkspaceDescriptor, "background">>;
}

interface FaviconAgentSource {
  sessions: Record<string, FaviconAgentSession | undefined>;
}

/**
 * The favicon is the only always-mounted consumer of the whole agent directory, so derive its
 * three states here instead of building the aggregated agent list: the list allocates a
 * projection per agent, deep-compares it and sorts every agent on the host on each update.
 */
export function deriveFaviconStatus(state: FaviconAgentSource): FaviconStatus {
  let hasAttention = false;
  let hasNeedsInput = false;
  for (const session of Object.values(state.sessions)) {
    if (!session) continue;
    for (const agent of session.agents.values()) {
      if (agent.background || agent.archivedAt) continue;
      // An agent in a background workspace is effectively background: the sidebar hides it.
      if (agent.workspaceId && session.workspaces.get(agent.workspaceId)?.background) continue;
      if (agent.status === "running") return "running";
      if (agent.requiresAttention) hasAttention = true;
      if (agent.pendingPermissions.length > 0) hasNeedsInput = true;
    }
  }
  return hasAttention || hasNeedsInput ? "attention" : "none";
}

/** A session-store selector for the favicon status that rescans only when an agent or workspace map changes. */
export function createFaviconStatusSelector(): (state: FaviconAgentSource) => FaviconStatus {
  return memoizeOnSessionMaps<FaviconAgentSession, FaviconAgentSource, FaviconStatus>(
    (session) => [session.agents, session.workspaces],
    deriveFaviconStatus,
  );
}
