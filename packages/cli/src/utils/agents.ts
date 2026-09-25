import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { resolveAgentId } from "./client.js";

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

function isAgentNotFound(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Agent not found");
}

/** Resolve an ID, prefix or name to any stored agent; the listing only adds partial title matches. */
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
    // An ambiguous prefix or title must not fall through to a first-match guess.
    if (!isAgentNotFound(error)) {
      throw error;
    }
  }
  const agents = await fetchAllAgents(client, { filter: { includeArchived: true } });
  const agentId = resolveAgentId(idOrName, agents);
  return agentId ? (agents.find((agent) => agent.id === agentId) ?? null) : null;
}
