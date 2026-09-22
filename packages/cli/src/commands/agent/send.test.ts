import { describe, expect, it, vi } from "vitest";

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
    });
  });
});
