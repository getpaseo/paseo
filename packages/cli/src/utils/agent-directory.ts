import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { resolveAgentId, type connectToDaemon } from "./client.js";

type DaemonClient = Awaited<ReturnType<typeof connectToDaemon>>;
type FetchAgentsOptions = NonNullable<Parameters<DaemonClient["fetchAgents"]>[0]>;

export interface AgentDirectoryClient {
  fetchAgents(options?: FetchAgentsOptions): Promise<{
    entries: { agent: AgentSnapshotPayload }[];
    pageInfo: { nextCursor: string | null };
  }>;
}

export interface AgentLookupClient extends AgentDirectoryClient {
  fetchAgent(options: { agentId: string }): Promise<{
    agent: AgentSnapshotPayload;
  } | null>;
}

const FULL_AGENT_UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** Read the complete directory without agents moving between pages as they update. */
export async function fetchAllAgents(
  client: AgentDirectoryClient,
  options: Omit<FetchAgentsOptions, "page" | "sort" | "subscribe"> = {},
): Promise<AgentSnapshotPayload[]> {
  const agents: AgentSnapshotPayload[] = [];
  let cursor: string | undefined;
  // createdAt never changes, so agents cannot move past the cursor while the pages are read.
  do {
    const payload = await client.fetchAgents({
      ...options,
      sort: [{ key: "created_at", direction: "desc" }],
      page: { limit: 200, ...(cursor ? { cursor } : {}) },
    });
    agents.push(...payload.entries.map((entry) => entry.agent));
    cursor = payload.pageInfo.nextCursor ?? undefined;
  } while (cursor);
  return agents;
}

/**
 * Resolve an agent by ID, prefix, or name from the directory, falling back to
 * `fetch_agent` for agents omitted from `fetch_agents` (for example after their
 * workspace or project was deleted).
 */
export async function resolveAgentEntry(
  client: AgentLookupClient,
  agentIdArg: string,
): Promise<AgentSnapshotPayload | null> {
  const trimmed = agentIdArg.trim();
  if (!trimmed) {
    return null;
  }

  const agents = await fetchAllAgents(client, { filter: { includeArchived: true } });
  const listedId = resolveAgentId(agentIdArg, agents);
  if (listedId) {
    const match = agents.find((entry) => entry.id === listedId);
    if (match) {
      return match;
    }
  }

  // COMPAT(fullAgentIdExact): daemons before v0.16.0 resolve a full agent ID
  // that matches no agent to an agent titled with it, so archive, detach and
  // reload accept their answer only when it is that ID. Remove after 2027-05-15.
  if (FULL_AGENT_UUID_PATTERN.test(trimmed)) {
    const agentId = trimmed.toLowerCase();
    const fetchResult = await client.fetchAgent({ agentId });
    return fetchResult?.agent.id === agentId ? fetchResult.agent : null;
  }
  const fetchResult = await client.fetchAgent({ agentId: trimmed });
  return fetchResult?.agent ?? null;
}
