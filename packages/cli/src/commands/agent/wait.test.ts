import { beforeEach, describe, expect, it, vi } from "vitest";

const daemonTarget = { kind: "endpoint" as const, host: "example.test:12345" };

const waitForFinish = vi.fn();
const close = vi.fn(async () => undefined);

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => ({ waitForFinish, close })),
  getDaemonHost: vi.fn(() => "ws://127.0.0.1:6767"),
}));

import { runWaitCommand } from "./wait.js";

const agentId = "11111111-1111-4111-8111-111111111111";

describe("runWaitCommand", () => {
  beforeEach(() => {
    waitForFinish.mockReset();
    close.mockClear();
  });

  it("reports an identifier the daemon could not resolve as a missing agent", async () => {
    waitForFinish.mockResolvedValue({
      status: "error",
      final: null,
      error: "Agent not found: does-not-exist",
      lastMessage: null,
    });

    await expect(
      runWaitCommand("does-not-exist", { daemonTarget }, {} as never),
    ).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
      message: "Agent not found: does-not-exist",
      details: "Use `paseo ls` to list available agents",
    });
    expect(close).toHaveBeenCalled();
  });

  it("still reports an agent that finished in error as a result", async () => {
    waitForFinish.mockResolvedValue({
      status: "error",
      final: { id: agentId, lastError: "The provider returned 500" },
      error: "The provider returned 500",
      lastMessage: null,
    });

    const result = await runWaitCommand("11111111", { daemonTarget }, {} as never);

    expect(result.data).toEqual({
      agentId,
      status: "error",
      message: "The provider returned 500",
    });
  });
});
