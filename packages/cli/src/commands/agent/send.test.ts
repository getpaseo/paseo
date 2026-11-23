import { describe, expect, it } from "vitest";
import { buildNoWaitResult } from "./send.js";

const agentId = "11111111-1111-4111-8111-111111111111";

describe("buildNoWaitResult", () => {
  it("reports the behavior the host applied to an agent's message", () => {
    expect(
      buildNoWaitResult(agentId, {
        deliveryStatus: "queued",
        activeTurnBehavior: "steer",
        guidance: "The agent is idle, so your message starts a turn now.",
      }),
    ).toEqual({
      agentId,
      status: "queued",
      activeTurnBehavior: "steer",
      message: "The agent is idle, so your message starts a turn now.",
    });
  });

  it("leaves the behavior out when the host does not report one", () => {
    expect(buildNoWaitResult(agentId, {})).toEqual({
      agentId,
      status: "sent",
      message: "Message sent, not waiting for completion",
    });
  });
});
