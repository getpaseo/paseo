import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const daemonTarget = { kind: "endpoint" as const, host: "example.test:12345" };
const agentId = "11111111-1111-4111-8111-111111111111";

const sendAgentMessage = vi.fn();
const waitForFinish = vi.fn();
const close = vi.fn(async () => undefined);

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => ({ sendAgentMessage, waitForFinish, close })),
  getDaemonHost: vi.fn(() => "ws://127.0.0.1:6767"),
}));

import { addSendOptions, runSendCommand } from "./send.js";

describe("paseo send --behavior queue", () => {
  beforeEach(() => {
    sendAgentMessage.mockReset();
    waitForFinish.mockReset();
  });

  it("lists queue among the --behavior choices", () => {
    expect(addSendOptions(new Command("send")).helpInformation()).toContain(
      '"interrupt", "steer", "queue"',
    );
  });

  it("sends the queue behavior and returns the queue receipt without waiting", async () => {
    sendAgentMessage.mockResolvedValue({ disposition: "queued", queuePosition: 2, revived: false });

    const result = await runSendCommand(
      agentId,
      "after this turn",
      { daemonTarget, behavior: "queue", wait: false },
      {} as never,
    );

    expect(sendAgentMessage).toHaveBeenCalledWith(
      agentId,
      "after this turn",
      expect.objectContaining({ activeTurnBehavior: "queue" }),
    );
    expect(waitForFinish).not.toHaveBeenCalled();
    expect(result.data).toEqual({
      agentId,
      status: "queued",
      message: expect.stringContaining("position 2"),
      disposition: "queued",
      queuePosition: 2,
      revived: false,
    });
  });

  it("reports an older daemon's missing capability as a send failure", async () => {
    sendAgentMessage.mockRejectedValue(
      new Error("Update the Paseo host to queue messages until the running turn ends."),
    );

    await expect(
      runSendCommand(agentId, "later", { daemonTarget, behavior: "queue" }, {} as never),
    ).rejects.toMatchObject({
      code: "SEND_FAILED",
      message: expect.stringContaining("Update the Paseo host to queue messages"),
    });
    expect(waitForFinish).not.toHaveBeenCalled();
  });
});
