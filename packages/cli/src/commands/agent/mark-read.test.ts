import { beforeEach, describe, expect, it, vi } from "vitest";

const daemonTarget = { kind: "endpoint" as const, host: "example.test:12345" };

import { runMarkReadCommand } from "./mark-read.js";

const unread = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Finished agent",
  status: "idle",
  requiresAttention: true,
  attentionReason: "finished",
};
const failed = {
  id: "22222222-2222-4222-8222-222222222222",
  title: "Failed agent",
  status: "idle",
  requiresAttention: true,
  attentionReason: "error",
};
const read = {
  id: "33333333-3333-4333-8333-333333333333",
  title: "Read agent",
  status: "closed",
  requiresAttention: false,
  attentionReason: null,
};
const daemonAgents = [unread, failed, read];
const agentsPage = {
  entries: daemonAgents.map((agent) => ({ agent })),
  pageInfo: { nextCursor: null },
};

const clearAgentAttention = vi.fn(async () => undefined);
const close = vi.fn(async () => undefined);

vi.mock("../../utils/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/client.js")>()),
  connectToDaemon: vi.fn(async () => ({
    fetchAgents: vi.fn(async () => agentsPage),
    clearAgentAttention,
    close,
  })),
}));

describe("runMarkReadCommand", () => {
  beforeEach(() => {
    clearAgentAttention.mockClear();
    close.mockClear();
  });

  it("clears the attention of every agent named, by ID prefix or name, in one request", async () => {
    const result = await runMarkReadCommand(
      [unread.id.slice(0, 8), "Failed agent", unread.id],
      { daemonTarget },
      {} as never,
    );

    expect(clearAgentAttention).toHaveBeenCalledTimes(1);
    expect(clearAgentAttention).toHaveBeenCalledWith([unread.id, failed.id]);
    expect(result.data).toEqual({ markedCount: 2, agentIds: [unread.id, failed.id] });
    expect(close).toHaveBeenCalled();
  });

  it("leaves an agent that is already read alone", async () => {
    const result = await runMarkReadCommand([read.id], { daemonTarget }, {} as never);

    expect(clearAgentAttention).not.toHaveBeenCalled();
    expect(result.data).toEqual({ markedCount: 0, agentIds: [] });
  });

  it("fails on an unknown agent before asking the daemon", async () => {
    await expect(
      runMarkReadCommand([unread.id, "no-such-agent"], { daemonTarget }, {} as never),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND", message: "Agent not found: no-such-agent" });
    expect(clearAgentAttention).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it("requires an agent ID", async () => {
    await expect(runMarkReadCommand([" "], { daemonTarget }, {} as never)).rejects.toMatchObject({
      code: "MISSING_AGENT_ID",
    });
  });
});
