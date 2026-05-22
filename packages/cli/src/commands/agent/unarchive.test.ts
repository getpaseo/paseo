import { describe, expect, it, vi, beforeEach } from "vitest";
import { runUnarchiveCommand } from "./unarchive.js";

const { close, fetchAgents, refreshAgent } = vi.hoisted(() => ({
  close: vi.fn(),
  fetchAgents: vi.fn(),
  refreshAgent: vi.fn(),
}));

vi.mock("../../utils/client.js", () => {
  return {
    connectToDaemon: vi.fn(async () => ({
      fetchAgents,
      refreshAgent,
      close,
    })),
    getDaemonHost: vi.fn(() => "localhost:6767"),
    resolveAgentId: vi.fn((idOrName: string, agents: Array<{ id: string; title?: string }>) => {
      return (
        agents.find((agent) => agent.id === idOrName)?.id ??
        agents.find((agent) => agent.id.startsWith(idOrName))?.id ??
        agents.find((agent) => agent.title === idOrName)?.id ??
        null
      );
    }),
  };
});

const archivedAgent = {
  id: "agent-123456789",
  title: "Archived Session",
  status: "idle",
  cwd: "/tmp/project",
  archivedAt: "2026-05-22T00:00:00.000Z",
};

describe("runUnarchiveCommand", () => {
  beforeEach(() => {
    fetchAgents.mockReset();
    refreshAgent.mockReset();
    close.mockReset();
    close.mockResolvedValue(undefined);
  });

  it("refreshes an archived agent resolved by prefix", async () => {
    fetchAgents.mockResolvedValueOnce({ entries: [{ agent: archivedAgent }] });
    refreshAgent.mockResolvedValueOnce({
      agentId: archivedAgent.id,
      status: "agent_refreshed",
      requestId: "request-1",
      timelineSize: 4,
    });

    const result = await runUnarchiveCommand("agent-123", {}, {} as never);

    expect(fetchAgents).toHaveBeenCalledWith({ filter: { includeArchived: true } });
    expect(refreshAgent).toHaveBeenCalledWith(archivedAgent.id);
    expect(result.data).toEqual({
      agentId: archivedAgent.id,
      status: "unarchived",
      timelineSize: 4,
    });
  });

  it("rejects agents that are not archived", async () => {
    fetchAgents.mockResolvedValueOnce({
      entries: [{ agent: { ...archivedAgent, archivedAt: null } }],
    });

    await expect(runUnarchiveCommand("Archived Session", {}, {} as never)).rejects.toMatchObject({
      code: "AGENT_NOT_ARCHIVED",
    });
    expect(refreshAgent).not.toHaveBeenCalled();
  });
});
