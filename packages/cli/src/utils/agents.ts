import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";

type AgentsClient = Pick<DaemonClient, "fetchAgent" | "fetchAgents">;
type FetchAgentsOptions = NonNullable<Parameters<DaemonClient["fetchAgents"]>[0]>;

const AGENTS_PAGE_LIMIT = 200;

/** Every agent matching the options, following the daemon's cursor past its first page. */
export async function fetchAllAgents(
  client: Pick<DaemonClient, "fetchAgents">,
  options: Omit<FetchAgentsOptions, "page" | "subscribe"> = {},
): Promise<AgentSnapshotPayload[]> {
  const agents: AgentSnapshotPayload[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const payload = await client.fetchAgents({
      ...options,
      page: { limit: AGENTS_PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
    });
    for (const { agent } of payload.entries) {
      if (!seen.has(agent.id)) {
        seen.add(agent.id);
        agents.push(agent);
      }
    }
    const next = payload.pageInfo?.nextCursor ?? undefined;
    if (next !== undefined && next === cursor) {
      throw new Error("Daemon returned the same agents page cursor twice");
    }
    cursor = next;
  } while (cursor);
  return agents;
}

const AGENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MISS = Symbol("miss");

// Only the daemon's plain miss names the input itself; any other error resolved to some agent.
async function askDaemon(
  client: AgentsClient,
  query: string,
): Promise<AgentSnapshotPayload | typeof MISS> {
  try {
    const fetched = await client.fetchAgent({ agentId: query });
    return fetched ? fetched.agent : MISS;
  } catch (error) {
    if (error instanceof Error && error.message === `Agent not found: ${query}`) {
      return MISS;
    }
    throw error;
  }
}

// Each title tier must match exactly one agent; several is an error, never a first-match guess.
function matchUniqueTitle(
  query: string,
  agents: AgentSnapshotPayload[],
): AgentSnapshotPayload | null {
  const lower = query.toLowerCase();
  const tiers: Array<(agent: AgentSnapshotPayload) => boolean> = [
    (agent) => agent.title?.toLowerCase() === lower,
    (agent) => agent.title?.toLowerCase().includes(lower) ?? false,
  ];
  for (const matches of tiers) {
    const found = agents.filter(matches);
    if (found.length > 1) {
      throw new Error(
        `Agent title "${query}" is ambiguous (${found
          .slice(0, 5)
          .map((agent) => agent.id.slice(0, 8))
          .join(", ")}${found.length > 5 ? ", …" : ""})`,
      );
    }
    if (found[0]) {
      return found[0];
    }
  }
  return null;
}

/**
 * Resolve an ID, prefix or name to a stored agent. The daemon rules on every ID and prefix, hidden
 * agents included; the listing adds only case-insensitive and partial title matches.
 */
export async function resolveAgent(
  client: AgentsClient,
  idOrName: string,
): Promise<AgentSnapshotPayload | null> {
  const query = idOrName.trim();
  for (const candidate of new Set([query, query.toLowerCase()])) {
    const agent = await askDaemon(client, candidate);
    if (agent !== MISS) {
      return agent;
    }
  }
  if (AGENT_ID.test(query)) {
    return null;
  }
  const agents = await fetchAllAgents(client, { filter: { includeArchived: true } });
  return matchUniqueTitle(query, agents);
}
