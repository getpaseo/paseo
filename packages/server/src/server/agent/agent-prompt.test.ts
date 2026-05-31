import { expect, it, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import {
  formatSystemNotificationPrompt,
  isSystemInjectedEnvelope,
  setupFinishNotification,
} from "./agent-prompt.js";
import type { AgentManagerEvent, ManagedAgent } from "./agent-manager.js";

const CHILD_AGENT_ID = "11111111-1111-4111-8111-111111111111";
const CALLER_AGENT_ID = "22222222-2222-4222-8222-222222222222";

test("isSystemInjectedEnvelope matches the envelope formatSystemNotificationPrompt produces", () => {
  expect(isSystemInjectedEnvelope(formatSystemNotificationPrompt("child finished"))).toBe(true);
  expect(isSystemInjectedEnvelope("hello world")).toBe(false);
});

it("does not notify archived callers", async () => {
  let subscriber: ((event: AgentManagerEvent) => void) | null = null;

  const childAgent: ManagedAgent = Object.create(null);
  Reflect.set(childAgent, "id", CHILD_AGENT_ID);
  Reflect.set(childAgent, "lifecycle", "idle");
  Reflect.set(childAgent, "config", { title: "Child Agent" });

  const callerAgent: ManagedAgent = Object.create(null);
  Reflect.set(callerAgent, "id", CALLER_AGENT_ID);
  Reflect.set(callerAgent, "lifecycle", "idle");
  Reflect.set(callerAgent, "config", { title: "Caller Agent" });

  const agentManager: AgentManager = Object.create(AgentManager.prototype);
  Reflect.set(
    agentManager,
    "getAgent",
    vi.fn((agentId: string) => {
      if (agentId === CHILD_AGENT_ID) {
        return childAgent;
      }
      if (agentId === CALLER_AGENT_ID) {
        return callerAgent;
      }
      return null;
    }),
  );
  Reflect.set(
    agentManager,
    "subscribe",
    vi.fn((callback: (event: AgentManagerEvent) => void) => {
      subscriber = callback;
      return () => {
        subscriber = null;
      };
    }),
  );
  const startAgentRunSpy = vi.fn(() => ({
    outOfBand: false,
    events: (async function* noop() {})(),
  }));
  Reflect.set(agentManager, "startAgentRun", startAgentRunSpy);

  const agentStorageGetSpy = vi.fn(async (agentId: string) =>
    agentId === CALLER_AGENT_ID ? { archivedAt: "2024-01-01" } : null,
  );
  const agentStorage: AgentStorage = Object.create(AgentStorage.prototype);
  Reflect.set(agentStorage, "get", agentStorageGetSpy);

  setupFinishNotification({
    agentManager,
    agentStorage,
    childAgentId: CHILD_AGENT_ID,
    callerAgentId: CALLER_AGENT_ID,
    logger: createTestLogger(),
  });

  expect(subscriber).not.toBeNull();

  childAgent.lifecycle = "running";
  subscriber?.({
    type: "agent_state",
    agent: childAgent,
  });

  childAgent.lifecycle = "idle";
  subscriber?.({
    type: "agent_state",
    agent: childAgent,
  });

  await vi.waitFor(() => {
    expect(agentStorageGetSpy).toHaveBeenCalledWith(CALLER_AGENT_ID);
  });

  expect(startAgentRunSpy).not.toHaveBeenCalled();
});

it("uses AgentManager startAgentRun for finish notifications", async () => {
  let subscriber: ((event: AgentManagerEvent) => void) | null = null;

  const childAgent: ManagedAgent = Object.create(null);
  Reflect.set(childAgent, "id", CHILD_AGENT_ID);
  Reflect.set(childAgent, "lifecycle", "idle");
  Reflect.set(childAgent, "config", { title: "Child Agent" });

  const callerAgent: ManagedAgent = Object.create(null);
  Reflect.set(callerAgent, "id", CALLER_AGENT_ID);
  Reflect.set(callerAgent, "lifecycle", "idle");
  Reflect.set(callerAgent, "config", { title: "Caller Agent" });

  const startAgentRunSpy = vi.fn(() => ({
    outOfBand: false,
    events: (async function* noop() {})(),
  }));

  const agentManager: AgentManager = Object.create(AgentManager.prototype);
  Reflect.set(
    agentManager,
    "getAgent",
    vi.fn((agentId: string) => {
      if (agentId === CHILD_AGENT_ID) {
        return childAgent;
      }
      if (agentId === CALLER_AGENT_ID) {
        return callerAgent;
      }
      return null;
    }),
  );
  Reflect.set(
    agentManager,
    "subscribe",
    vi.fn((callback: (event: AgentManagerEvent) => void) => {
      subscriber = callback;
      return () => {
        subscriber = null;
      };
    }),
  );
  Reflect.set(agentManager, "startAgentRun", startAgentRunSpy);

  const agentStorage: AgentStorage = Object.create(AgentStorage.prototype);
  Reflect.set(
    agentStorage,
    "get",
    vi.fn(async (agentId: string) =>
      agentId === CHILD_AGENT_ID ? { title: "Child Agent" } : null,
    ),
  );

  setupFinishNotification({
    agentManager,
    agentStorage,
    childAgentId: CHILD_AGENT_ID,
    callerAgentId: CALLER_AGENT_ID,
    logger: createTestLogger(),
  });

  expect(subscriber).not.toBeNull();

  childAgent.lifecycle = "running";
  subscriber?.({
    type: "agent_state",
    agent: childAgent,
  });

  childAgent.lifecycle = "idle";
  subscriber?.({
    type: "agent_state",
    agent: childAgent,
  });

  await vi.waitFor(() => {
    expect(startAgentRunSpy).toHaveBeenCalledWith(
      CALLER_AGENT_ID,
      `<paseo-system>\nAgent ${CHILD_AGENT_ID} (Child Agent) finished.\n</paseo-system>`,
      { replaceRunning: true },
    );
  });
});
