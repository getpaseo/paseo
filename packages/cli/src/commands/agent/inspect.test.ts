import { Command } from "commander";
import { expect, it, vi } from "vitest";

const agentId = "11111111-1111-4111-8111-111111111111";
const fetchAgent = vi.fn();

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => ({ fetchAgent, close: async () => undefined })),
}));

import { runInspectCommand } from "./inspect.js";

it("shows the messages queued behind the running turn", async () => {
  fetchAgent.mockResolvedValue({
    agent: {
      id: agentId,
      title: "Recipient",
      provider: "claude",
      status: "running",
      archivedAt: null,
      cwd: "/work",
      createdAt: "2026-11-16T00:00:00.000Z",
      updatedAt: "2026-11-16T00:00:00.000Z",
      queuedMessages: [
        { id: "m1", preview: "one", queuedAt: "2026-11-16T00:00:01.000Z" },
        { id: "m2", preview: "two", queuedAt: "2026-11-16T00:00:02.000Z" },
      ],
    },
  });

  const result = await runInspectCommand(agentId, {}, new Command());

  expect(result.data).toContainEqual({ key: "QueuedMessages", value: "1. one, 2. two" });
  expect(result.schema.serialize?.(result.data[0]!)).toMatchObject({
    QueuedMessages: [
      { id: "m1", preview: "one", queuedAt: "2026-11-16T00:00:01.000Z" },
      { id: "m2", preview: "two", queuedAt: "2026-11-16T00:00:02.000Z" },
    ],
  });
});
