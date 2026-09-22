import { beforeEach, describe, expect, it, vi } from "vitest";

const daemonTarget = { kind: "endpoint" as const, host: "example.test:12345" };

import { runSendCommand } from "./send.js";

const sendAgentMessage = vi.fn(async () => undefined);
const waitForFinish = vi.fn(async () => ({ status: "finished" as const, final: null }));
const close = vi.fn(async () => undefined);

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => ({
    sendAgentMessage,
    waitForFinish,
    close,
  })),
  getDaemonHost: vi.fn(() => "ws://127.0.0.1:6767"),
}));

describe("runSendCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("interrupts an active turn by default", async () => {
    await runSendCommand("agent-1", "keep going", { daemonTarget, wait: false }, {} as never);

    expect(sendAgentMessage).toHaveBeenCalledWith("agent-1", "keep going", {
      images: undefined,
    });
  });

  it("steers the message into an active turn with --steer", async () => {
    await runSendCommand(
      "agent-1",
      "keep going",
      { daemonTarget, wait: false, steer: true },
      {} as never,
    );

    expect(sendAgentMessage).toHaveBeenCalledWith("agent-1", "keep going", {
      images: undefined,
      activeTurnBehavior: "steer",
      steerFallback: "reject",
    });
  });

  it("fails without starting a turn when the agent cannot be steered", async () => {
    sendAgentMessage.mockRejectedValueOnce(
      new Error(
        'target is mid-turn and its provider cannot steer; wait for it to finish or resend with activeTurnBehavior "interrupt"',
      ),
    );

    await expect(
      runSendCommand(
        "agent-1",
        "keep going",
        { daemonTarget, wait: false, steer: true },
        {} as never,
      ),
    ).rejects.toMatchObject({
      code: "SEND_FAILED",
      message: expect.stringContaining("its provider cannot steer"),
    });

    expect(waitForFinish).not.toHaveBeenCalled();
  });
});
