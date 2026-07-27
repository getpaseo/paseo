import { beforeEach, describe, expect, it, vi } from "vitest";

import { runUnarchiveCommand } from "./unarchive.js";

const mocks = vi.hoisted(() => ({
  archivedAt: "2026-07-26T12:00:00.000Z" as string | null,
  refreshAgent: vi.fn(async (agentId: string) => ({ agentId, timelineSize: 4 })),
  close: vi.fn(async () => undefined),
}));

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => ({
    fetchAgents: vi.fn(async () => ({
      entries: [
        {
          agent: {
            id: "11111111-1111-4111-8111-111111111111",
            title: "Archived agent",
            archivedAt: mocks.archivedAt,
          },
        },
      ],
    })),
    refreshAgent: mocks.refreshAgent,
    close: mocks.close,
  })),
  getDaemonHost: vi.fn(() => "ws://127.0.0.1:6767"),
  resolveAgentId: vi.fn((id: string) => id),
}));

describe("runUnarchiveCommand", () => {
  beforeEach(() => {
    mocks.archivedAt = "2026-07-26T12:00:00.000Z";
    vi.clearAllMocks();
  });

  it("unarchives and reloads an archived agent", async () => {
    const agentId = "11111111-1111-4111-8111-111111111111";

    const result = await runUnarchiveCommand(agentId, {}, {} as never);

    expect(mocks.refreshAgent).toHaveBeenCalledWith(agentId);
    expect(result.data).toEqual({
      agentId,
      status: "unarchived",
      timelineSize: 4,
    });
  });

  it("rejects an agent that is already active", async () => {
    mocks.archivedAt = null;

    await expect(
      runUnarchiveCommand("11111111-1111-4111-8111-111111111111", {}, {} as never),
    ).rejects.toMatchObject({ code: "AGENT_NOT_ARCHIVED" });
    expect(mocks.refreshAgent).not.toHaveBeenCalled();
  });
});
