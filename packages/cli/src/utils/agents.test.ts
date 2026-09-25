import { describe, expect, it, vi } from "vitest";
import { fetchAllAgents, resolveAgent } from "./agents.js";

interface Agent {
  id: string;
  title: string | null;
  status: string;
  archivedAt: string | null;
}

const agent = (id: string, title: string | null = null): Agent => ({
  id,
  title,
  status: "closed",
  archivedAt: null,
});

// A daemon holding `agents`, newest first, served in pages of `limit` the way the server pages.
function pagedClient(agents: Agent[], fetched: Agent | Error | null = null) {
  const fetchAgents = vi.fn(async (options?: { page?: { limit?: number; cursor?: string } }) => {
    const limit = options?.page?.limit ?? 200;
    const start = options?.page?.cursor ? Number(options.page.cursor) : 0;
    const entries = agents.slice(start, start + limit).map((a) => ({ agent: a }));
    const hasMore = start + limit < agents.length;
    return { entries, pageInfo: { nextCursor: hasMore ? String(start + limit) : null, hasMore } };
  });
  const fetchAgent = vi.fn(async () => {
    if (fetched instanceof Error) throw fetched;
    return fetched ? { agent: fetched, project: null } : null;
  });
  return { fetchAgents, fetchAgent } as never as Parameters<typeof resolveAgent>[0] & {
    fetchAgents: typeof fetchAgents;
    fetchAgent: typeof fetchAgent;
  };
}

const fleet = Array.from({ length: 450 }, (_, i) =>
  agent(`${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`, `agent ${i}`),
);
const oldest = fleet[449]!;

describe("fetchAllAgents", () => {
  it("follows the cursor past the first 200 agents", async () => {
    const client = pagedClient(fleet);
    const agents = await fetchAllAgents(client, { filter: { includeArchived: true } });
    expect(agents).toHaveLength(450);
    expect(client.fetchAgents).toHaveBeenCalledTimes(3);
    expect(client.fetchAgents.mock.calls[2]![0]).toEqual({
      filter: { includeArchived: true },
      page: { limit: 200, cursor: "400" },
    });
  });

  it("stops on a cursor that does not advance", async () => {
    const client = pagedClient(fleet);
    client.fetchAgents.mockImplementation(async () => ({
      entries: [{ agent: fleet[0]! }],
      pageInfo: { nextCursor: "stuck", hasMore: true },
    }));
    await expect(fetchAllAgents(client)).rejects.toThrow(/same agents page cursor/);
  });
});

describe("resolveAgent", () => {
  it("finds an agent beyond the first page through the daemon's own lookup", async () => {
    const client = pagedClient(fleet, oldest);
    await expect(resolveAgent(client, oldest.id)).resolves.toBe(oldest);
    expect(client.fetchAgent).toHaveBeenCalledWith({ agentId: oldest.id });
    expect(client.fetchAgents).not.toHaveBeenCalled();
  });

  it("falls back to every page for a partial title the daemon does not match", async () => {
    const client = pagedClient(fleet, new Error("Agent not found: GENT 449"));
    await expect(resolveAgent(client, "GENT 449")).resolves.toBe(oldest);
    expect(client.fetchAgents).toHaveBeenCalledTimes(3);
  });

  it("returns null when neither the daemon nor any page knows the agent", async () => {
    const client = pagedClient(fleet, null);
    await expect(resolveAgent(client, "no such agent")).resolves.toBeNull();
  });

  it("surfaces an ambiguous identifier instead of guessing", async () => {
    const client = pagedClient(fleet, new Error('Agent identifier "0000" is ambiguous (…)'));
    await expect(resolveAgent(client, "0000")).rejects.toThrow(/ambiguous/);
    expect(client.fetchAgents).not.toHaveBeenCalled();
  });
});
