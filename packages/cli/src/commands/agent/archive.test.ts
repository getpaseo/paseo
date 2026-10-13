import { beforeEach, describe, expect, it, vi } from "vitest";

const daemonTarget = { kind: "endpoint" as const, host: "example.test:12345" };
const closed = {
  id: "14780c9d-6c06-4556-91b9-5e5209a1881d",
  title: "old review",
  status: "closed",
  archivedAt: null as string | null,
};
const newer = {
  id: "22222222-2222-4222-8222-222222222222",
  title: "new",
  status: "idle",
  archivedAt: null,
};
const client = {
  // One full page of newer agents: the closed agent is not on it.
  fetchAgents: vi.fn(async () => ({
    entries: [{ agent: newer }],
    pageInfo: { nextCursor: null, hasMore: false },
  })),
  fetchAgent: vi.fn(async () => ({ agent: closed, project: null })),
  archiveAgent: vi.fn(async () => ({ archivedAt: "2026-09-25T00:00:00.000Z" })),
  close: vi.fn(async () => undefined),
};

vi.mock("../../utils/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/client.js")>()),
  connectToDaemon: vi.fn(async () => client),
}));

import { runArchiveCommand } from "./archive.js";

describe("runArchiveCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    closed.archivedAt = null;
  });

  it("archives a closed agent missing from the first listing page", async () => {
    const result = await runArchiveCommand(closed.id, { daemonTarget }, {} as never);

    expect(client.fetchAgent).toHaveBeenCalledWith({ agentId: closed.id });
    expect(client.archiveAgent).toHaveBeenCalledWith(closed.id);
    expect(result.data).toMatchObject({ agentId: closed.id, status: "archived" });
  });

  it("still refuses an agent that is already archived", async () => {
    closed.archivedAt = "2026-09-24T00:00:00.000Z";
    await expect(runArchiveCommand(closed.id, { daemonTarget }, {} as never)).rejects.toMatchObject(
      {
        code: "AGENT_ALREADY_ARCHIVED",
      },
    );
    expect(client.archiveAgent).not.toHaveBeenCalled();
  });

  it("reports AGENT_NOT_FOUND when no lookup knows the id", async () => {
    client.fetchAgent.mockRejectedValueOnce(new Error("Agent not found: nope"));
    await expect(runArchiveCommand("nope", { daemonTarget }, {} as never)).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });
    expect(client.archiveAgent).not.toHaveBeenCalled();
  });
});
