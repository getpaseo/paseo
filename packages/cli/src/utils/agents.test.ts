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

// Mirrors Session.resolveAgentIdentifier and handleFetchAgent: every stored agent is
// matched case-sensitively, and one whose provider is hidden reports "not found" by its id.
function daemonLookup(visible: Agent[], hidden: Agent[]) {
  return (query: string): Agent => {
    const stored = [...visible, ...hidden];
    const hit = (id: string): Agent => {
      const found = visible.find((a) => a.id === id);
      if (!found) throw new Error(`Agent not found: ${id}`);
      return found;
    };
    if (stored.some((a) => a.id === query)) return hit(query);
    const prefix = stored.filter((a) => a.id.startsWith(query));
    if (prefix.length === 1) return hit(prefix[0]!.id);
    if (prefix.length > 1) throw new Error(`Agent identifier "${query}" is ambiguous (…)`);
    const titled = stored.filter((a) => a.title === query);
    if (titled.length === 1) return hit(titled[0]!.id);
    if (titled.length > 1) throw new Error(`Agent title "${query}" is ambiguous (…)`);
    throw new Error(`Agent not found: ${query}`);
  };
}

// A daemon listing `visible`, newest first, in pages of `limit`.
function daemon(visible: Agent[], hidden: Agent[] = []) {
  const lookup = daemonLookup(visible, hidden);
  const fetchAgents = vi.fn(async (options?: { page?: { limit?: number; cursor?: string } }) => {
    const limit = options?.page?.limit ?? 200;
    const start = options?.page?.cursor ? Number(options.page.cursor) : 0;
    const entries = visible.slice(start, start + limit).map((a) => ({ agent: a }));
    const hasMore = start + limit < visible.length;
    return { entries, pageInfo: { nextCursor: hasMore ? String(start + limit) : null, hasMore } };
  });
  const fetchAgent = vi.fn(async ({ agentId }: { agentId: string }) => ({
    agent: lookup(agentId),
    project: null,
  }));
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
    const client = daemon(fleet);
    const agents = await fetchAllAgents(client, { filter: { includeArchived: true } });
    expect(agents).toHaveLength(450);
    expect(client.fetchAgents).toHaveBeenCalledTimes(3);
    expect(client.fetchAgents.mock.calls[2]![0]).toEqual({
      filter: { includeArchived: true },
      page: { limit: 200, cursor: "400" },
    });
  });

  it("stops on a cursor that does not advance", async () => {
    const client = daemon(fleet);
    client.fetchAgents.mockImplementation(async () => ({
      entries: [{ agent: fleet[0]! }],
      pageInfo: { nextCursor: "stuck", hasMore: true },
    }));
    await expect(fetchAllAgents(client)).rejects.toThrow(/same agents page cursor/);
  });
});

describe("resolveAgent", () => {
  it("finds an agent beyond the first page through the daemon's own lookup", async () => {
    const client = daemon(fleet);
    await expect(resolveAgent(client, oldest.id)).resolves.toBe(oldest);
    expect(client.fetchAgents).not.toHaveBeenCalled();
  });

  it("trims the identifier before asking the daemon", async () => {
    const client = daemon(fleet);
    await expect(resolveAgent(client, `  ${oldest.id}\n`)).resolves.toBe(oldest);
    expect(client.fetchAgents).not.toHaveBeenCalled();
  });

  it("falls back to every page for a case-insensitive partial title", async () => {
    const client = daemon(fleet);
    await expect(resolveAgent(client, "GENT 449")).resolves.toBe(oldest);
    expect(client.fetchAgents).toHaveBeenCalledTimes(3);
  });

  it("prefers an exact title over partial ones", async () => {
    await expect(resolveAgent(daemon(fleet), "AGENT 44")).resolves.toBe(fleet[44]);
  });

  it("refuses a partial title shared by several agents", async () => {
    await expect(resolveAgent(daemon(fleet), "gent 44")).rejects.toThrow(/ambiguous/);
  });

  it("returns null when no agent matches", async () => {
    await expect(resolveAgent(daemon(fleet), "no such agent")).resolves.toBeNull();
  });

  it("lets the daemon rule on an uppercase prefix, hidden agents included", async () => {
    const visible = agent("ab000000-0000-4000-8000-000000000001");
    const hidden = agent("ab000000-0000-4000-8000-000000000002");
    await expect(resolveAgent(daemon([...fleet, visible], [hidden]), "AB")).rejects.toThrow(
      /ambiguous/,
    );
    await expect(resolveAgent(daemon([...fleet, visible]), "AB")).resolves.toBe(visible);
  });

  it("never trades a hidden agent's full id for a visible title", async () => {
    const hidden = agent("99999999-0000-4000-8000-000000000000");
    const decoy = agent("11111111-0000-4000-8000-000000000000", hidden.id);
    const client = daemon([...fleet, decoy], [hidden]);
    await expect(resolveAgent(client, hidden.id)).resolves.toBeNull();
    expect(client.fetchAgents).not.toHaveBeenCalled();
  });

  it("never trades a hidden agent's exact title for a visible partial one", async () => {
    const hidden = agent("99999999-0000-4000-8000-000000000000", "review");
    const partial = agent("11111111-0000-4000-8000-000000000000", "review followup");
    const client = daemon([...fleet, partial], [hidden]);
    await expect(resolveAgent(client, "review")).rejects.toThrow(hidden.id);
    expect(client.fetchAgents).not.toHaveBeenCalled();
  });

  it("returns null for an unknown full id without scanning titles", async () => {
    const id = "88888888-0000-4000-8000-000000000000";
    const client = daemon([...fleet, agent("11111111-0000-4000-8000-000000000000", `see ${id}`)]);
    await expect(resolveAgent(client, id)).resolves.toBeNull();
    expect(client.fetchAgents).not.toHaveBeenCalled();
  });

  it("rethrows a transport failure rather than falling back", async () => {
    const client = daemon(fleet);
    client.fetchAgent.mockRejectedValueOnce(new Error("Request timed out"));
    await expect(resolveAgent(client, oldest.id)).rejects.toThrow(/timed out/);
    expect(client.fetchAgents).not.toHaveBeenCalled();
  });
});
