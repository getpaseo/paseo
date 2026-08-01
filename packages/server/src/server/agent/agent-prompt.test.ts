import { expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import {
  formatSystemNotificationPrompt,
  isSystemInjectedEnvelope,
  sendPromptToAgent,
} from "./agent-prompt.js";
import type { ManagedAgent } from "./agent-manager.js";

test("isSystemInjectedEnvelope matches the envelope formatSystemNotificationPrompt produces", () => {
  expect(isSystemInjectedEnvelope(formatSystemNotificationPrompt("child finished"))).toBe(true);
  expect(isSystemInjectedEnvelope("hello world")).toBe(false);
});

test("sendPromptToAgent forwards the client message id as run options", async () => {
  const agent: ManagedAgent = Object.create(null);
  Reflect.set(agent, "id", "agent-1");
  Reflect.set(agent, "provider", "codex");

  const streamAgentSpy = vi.fn(() => (async function* noop() {})());
  const agentManager: AgentManager = Object.create(AgentManager.prototype);
  Reflect.set(
    agentManager,
    "getAgent",
    vi.fn(() => agent),
  );
  Reflect.set(agentManager, "tryRunOutOfBand", vi.fn().mockReturnValue(false));
  Reflect.set(agentManager, "hasInFlightRun", vi.fn().mockReturnValue(false));
  Reflect.set(agentManager, "streamAgent", streamAgentSpy);

  const agentStorage: AgentStorage = Object.create(AgentStorage.prototype);
  Reflect.set(
    agentStorage,
    "get",
    vi.fn(async () => null),
  );

  await sendPromptToAgent({
    agentManager,
    agentStorage,
    agentId: "agent-1",
    prompt: "hello",
    messageId: "msg-client-1",
    runOptions: { outputSchema: { type: "object" } },
    logger: createTestLogger(),
  });

  expect(streamAgentSpy).toHaveBeenCalledWith("agent-1", "hello", {
    outputSchema: { type: "object" },
    clientMessageId: "msg-client-1",
  });
});
