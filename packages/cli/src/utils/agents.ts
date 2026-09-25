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

// Only the daemon's plain miss names the input itself; any other error resolved to some agent.
function isPlainMiss(error: unknown, idOrName: string): boolean {
  return error instanceof Error && error.message === `Agent not found: ${idOrName.trim()}`;
}

// Each tier must match exactly one agent; several is an error, never a first-match guess.
function matchUnique(
  idOrName: string,
  agents: AgentSnapshotPayload[],
): AgentSnapshotPayload | null {
  const query = idOrName.toLowerCase();
  const tiers: Array<(agent: AgentSnapshotPayload) => boolean> = [
    (agent) => agent.id.toLowerCase().startsWith(query),
    (agent) => agent.title?.toLowerCase() === query,
    (agent) => agent.title?.toLowerCase().includes(query) ?? false,
  ];
  for (const matches of tiers) {
    const found = agents.filter(matches);
    if (found.length > 1) {
      throw new Error(
        `Agent identifier "${idOrName}" is ambiguous (${found
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

/** Resolve an ID, prefix or name to a stored agent; the listing adds only case-insensitive matches. */
export async function resolveAgent(
  client: AgentsClient,
  idOrName: string,
): Promise<AgentSnapshotPayload | null> {
  try {
    const fetched = await client.fetchAgent({ agentId: idOrName });
    if (fetched) {
      return fetched.agent;
    }
  } catch (error) {
    // An ambiguity or a match on a hidden agent must not become a guess among visible ones.
    if (!isPlainMiss(error, idOrName)) {
      throw error;
    }
  }
  const agents = await fetchAllAgents(client, { filter: { includeArchived: true } });
  return matchUnique(idOrName.trim(), agents);
}
