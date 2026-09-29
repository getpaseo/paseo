import { beforeEach, describe, expect, it, vi } from "vitest";

const daemonTarget = { kind: "endpoint" as const, host: "example.test:12345" };

import { runSendCommand } from "./send.js";

const sendAgentMessage = vi.fn(async () => ({ queued: false }));
const waitForFinish = vi.fn(async () => ({ status: "finished" as const, final: null }));
const close = vi.fn(async () => undefined);
const getLastServerInfoMessage = vi.fn(() => ({ features: { agentPromptQueue: true } }));

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => ({
    sendAgentMessage,
    waitForFinish,
    close,
    getLastServerInfoMessage,
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

  it("queues the message behind an active turn with --queue", async () => {
    sendAgentMessage.mockResolvedValueOnce({ queued: true });

    const result = await runSendCommand(
      "agent-1",
      "next task",
      { daemonTarget, wait: false, queue: true },
      {} as never,
    );

    expect(sendAgentMessage).toHaveBeenCalledWith("agent-1", "next task", {
      images: undefined,
      activeTurnBehavior: "queue",
    });
    expect(result.data).toEqual({
      agentId: "agent-1",
      status: "queued",
      message: "Message queued; it runs when the current turn ends",
    });
  });

  it("rejects --steer and --queue together without contacting the agent", async () => {
    await expect(
      runSendCommand(
        "agent-1",
        "next task",
        { daemonTarget, wait: false, steer: true, queue: true },
        {} as never,
      ),
    ).rejects.toMatchObject({ code: "CONFLICTING_SEND_BEHAVIOR" });

    expect(sendAgentMessage).not.toHaveBeenCalled();
  });

  it("asks to update the host when the daemon cannot queue", async () => {
    getLastServerInfoMessage.mockReturnValueOnce({ features: {} } as never);

    await expect(
      runSendCommand(
        "agent-1",
        "next task",
        { daemonTarget, wait: false, queue: true },
        {} as never,
      ),
    ).rejects.toMatchObject({ code: "DAEMON_UPDATE_REQUIRED" });

    expect(sendAgentMessage).not.toHaveBeenCalled();
  });
});
