import pino from "pino";
import { beforeEach, expect, test, vi } from "vitest";

const promptMocks = vi.hoisted(() => ({
  sendPromptToAgent: vi.fn(),
  waitForAgentRunStartWithTimeout: vi.fn(),
}));

vi.mock("../agent/agent-prompt.js", () => promptMocks);

import { createNativeDeliveryDispatcher } from "./delivery-dispatcher.js";

const agentManager = {} as never;
const agentStorage = {} as never;
const logger = pino({ level: "silent" });

beforeEach(() => {
  promptMocks.sendPromptToAgent.mockReset();
  promptMocks.waitForAgentRunStartWithTimeout.mockReset();
  promptMocks.waitForAgentRunStartWithTimeout.mockResolvedValue(undefined);
});

test("dispatches the exact target through the native prompt path", async () => {
  promptMocks.sendPromptToAgent.mockResolvedValue({ disposition: "turn_started" });
  const dispatch = createNativeDeliveryDispatcher({ agentManager, agentStorage, logger });

  await expect(
    dispatch({
      targetAgentId: "agent-exact",
      messageId: "message-stable",
      payload: { event: "refresh", count: 2 },
    }),
  ).resolves.toEqual({ outcome: "accepted" });

  expect(promptMocks.sendPromptToAgent).toHaveBeenCalledWith({
    agentManager,
    agentStorage,
    agentId: "agent-exact",
    prompt: '{"event":"refresh","count":2}',
    messageId: "message-stable",
    activeTurnBehavior: "interrupt",
    clearPendingPermissions: true,
    logger,
  });
  expect(promptMocks.waitForAgentRunStartWithTimeout).toHaveBeenCalledWith(
    agentManager,
    "agent-exact",
  );
});

test("does not wait for a run when native dispatch already steers or handles out of band", async () => {
  const dispatch = createNativeDeliveryDispatcher({ agentManager, agentStorage, logger });
  for (const disposition of ["steered", "out_of_band"] as const) {
    promptMocks.sendPromptToAgent.mockResolvedValueOnce({ disposition });
    await expect(
      dispatch({ targetAgentId: "agent-exact", messageId: "message", payload: "hello" }),
    ).resolves.toEqual({ outcome: "accepted" });
  }
  expect(promptMocks.waitForAgentRunStartWithTimeout).not.toHaveBeenCalled();
});

test("reports definite pre-dispatch failures without retrying", async () => {
  promptMocks.sendPromptToAgent.mockRejectedValue(new Error("Agent not found: agent-missing"));
  const dispatch = createNativeDeliveryDispatcher({ agentManager, agentStorage, logger });

  await expect(
    dispatch({ targetAgentId: "agent-missing", messageId: "message", payload: null }),
  ).resolves.toEqual({ outcome: "failed", error: "Agent not found: agent-missing" });
  expect(promptMocks.waitForAgentRunStartWithTimeout).not.toHaveBeenCalled();
});

test("reports uncertain provider failures as ambiguous", async () => {
  promptMocks.sendPromptToAgent.mockRejectedValue(new Error("provider disconnected"));
  const dispatch = createNativeDeliveryDispatcher({ agentManager, agentStorage, logger });

  await expect(
    dispatch({ targetAgentId: "agent-exact", messageId: "message", payload: "hello" }),
  ).resolves.toEqual({ outcome: "ambiguous", error: "provider disconnected" });
});

test("does not retry when run-start acknowledgement times out", async () => {
  promptMocks.sendPromptToAgent.mockResolvedValue({ disposition: "turn_started" });
  promptMocks.waitForAgentRunStartWithTimeout.mockRejectedValue(new Error("run start timeout"));
  const dispatch = createNativeDeliveryDispatcher({ agentManager, agentStorage, logger });

  await expect(
    dispatch({ targetAgentId: "agent-exact", messageId: "message", payload: "hello" }),
  ).resolves.toEqual({ outcome: "ambiguous", error: "run start timeout" });
  expect(promptMocks.sendPromptToAgent).toHaveBeenCalledTimes(1);
});
