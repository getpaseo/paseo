import { describe, expect, it, vi } from "vitest";

import { runDeleteCommand } from "./delete.js";

const agent = {
  id: "11111111-1111-4111-8111-111111111111",
  status: "running",
  archivedAt: null,
  cwd: "/tmp/project",
};
const cancelAgent = vi.fn(async () => {
  throw new Error("active run cancellation was not acknowledged");
});
const deleteAgent = vi.fn(async () => undefined);
const close = vi.fn(async () => undefined);

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => ({
    fetchAgents: vi.fn(async () => ({ entries: [{ agent }] })),
    fetchAgent: vi.fn(async () => ({ agent })),
    cancelAgent,
    deleteAgent,
    close,
  })),
  getDaemonHost: vi.fn(() => "ws://127.0.0.1:6767"),
}));

describe("runDeleteCommand", () => {
  it("force-deletes a running agent when graceful cancellation is refused", async () => {
    const result = await runDeleteCommand(agent.id, {}, {} as never);

    expect(cancelAgent).toHaveBeenCalledWith(agent.id);
    expect(deleteAgent).toHaveBeenCalledWith(agent.id);
    expect(result.data).toEqual({
      deletedCount: 1,
      agentIds: [agent.id],
    });
  });
});
