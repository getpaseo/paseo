// Finish-watcher coverage: a closed child wakes its caller, oversized child
// responses are capped, and the watcher re-arms across finishes. Separate
// from agent-prompt.test.ts because these scenarios need a caller that
// resolves as a live agent (notify() delivers through sendPromptToAgent).
import { expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { formatSystemNotificationPrompt, setupFinishNotification } from "./agent-prompt.js";
import type { AgentManagerEvent, ManagedAgent } from "./agent-manager.js";

interface FinishWatcherScenarioOptions {
  childLastAssistantMessage?: string | null;
  callerArchivedAt?: string | null;
}

interface FinishWatcherScenario {
  startWatchingChild(): void;
  finishChild(): void;
  closeChild(): void;
  flush(): Promise<void>;
  parentPrompts: string[];
  isSubscribed(): boolean;
}

function createFinishWatcherScenario(
  options?: FinishWatcherScenarioOptions,
): FinishWatcherScenario {
  let subscriber: ((event: AgentManagerEvent) => void) | null = null;
  const parentPrompts: string[] = [];

  const childAgent: ManagedAgent = Object.create(null);
  Reflect.set(childAgent, "id", "child-agent");
  Reflect.set(childAgent, "lifecycle", "idle");
  Reflect.set(childAgent, "config", { title: "Child Agent" });

  // The caller must resolve as a live agent: notify() delivers through
  // sendPromptToAgent → ensureAgentLoaded, which throws if the caller is
  // neither live nor in storage.
  const callerAgent: ManagedAgent = Object.create(null);
  Reflect.set(callerAgent, "id", "caller-agent");
  Reflect.set(callerAgent, "lifecycle", "idle");
  Reflect.set(callerAgent, "config", { title: "Caller Agent" });

  const agentManager: AgentManager = Object.create(AgentManager.prototype);
  Reflect.set(agentManager, "getAgent", (agentId: string) => {
    if (agentId === "child-agent") {
      return childAgent;
    }
    if (agentId === "caller-agent") {
      return callerAgent;
    }
    return null;
  });
  Reflect.set(agentManager, "subscribe", (callback: (event: AgentManagerEvent) => void) => {
    subscriber = callback;
    return () => {
      subscriber = null;
    };
  });
  Reflect.set(agentManager, "getLastAssistantMessage", async () => {
    return options?.childLastAssistantMessage ?? null;
  });
  Reflect.set(agentManager, "tryRunOutOfBand", () => false);
  Reflect.set(agentManager, "hasInFlightRun", () => false);
  Reflect.set(agentManager, "streamAgent", (_agentId: string, prompt: string) => {
    parentPrompts.push(prompt);
    return (async function* noop() {})();
  });

  const agentStorage: AgentStorage = Object.create(AgentStorage.prototype);
  Reflect.set(agentStorage, "get", async (agentId: string) => {
    if (agentId === "child-agent") {
      return {
        title: "Child Agent",
        labels: { "paseo.parent-agent-id": "caller-agent" },
      };
    }
    if (agentId === "caller-agent" && options?.callerArchivedAt) {
      return { title: "Caller Agent", archivedAt: options.callerArchivedAt, labels: {} };
    }
    return null;
  });

  function emitLifecycle(lifecycle: "running" | "idle" | "closed" | "error"): void {
    childAgent.lifecycle = lifecycle;
    subscriber?.({
      type: "agent_state",
      agent: childAgent,
    });
  }

  return {
    startWatchingChild() {
      setupFinishNotification({
        agentManager,
        agentStorage,
        childAgentId: "child-agent",
        callerAgentId: "caller-agent",
        requireParentOwnership: true,
        logger: createTestLogger(),
      });
    },
    finishChild() {
      emitLifecycle("running");
      emitLifecycle("idle");
    },
    closeChild() {
      emitLifecycle("running");
      emitLifecycle("closed");
    },
    async flush() {
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    parentPrompts,
    isSubscribed() {
      return subscriber !== null;
    },
  };
}

test("closing a watched child notifies the caller it was closed", async () => {
  const scenario = createFinishWatcherScenario({ childLastAssistantMessage: null });

  scenario.startWatchingChild();
  scenario.closeChild();
  await scenario.flush();

  expect(scenario.parentPrompts).toEqual([
    formatSystemNotificationPrompt("Agent child-agent (Child Agent) was closed."),
  ]);
  expect(scenario.isSubscribed()).toBe(false);
});

test("finish notifications truncate oversized child responses", async () => {
  const head = "x".repeat(4000);
  const tail = "TAIL-MARKER".repeat(50);
  const scenario = createFinishWatcherScenario({ childLastAssistantMessage: head + tail });

  scenario.startWatchingChild();
  scenario.finishChild();
  await scenario.flush();

  expect(scenario.parentPrompts).toHaveLength(1);
  expect(scenario.parentPrompts[0]).toContain(
    `[truncated ${tail.length} chars — use get_agent_activity for the full response]`,
  );
  expect(scenario.parentPrompts[0]).not.toContain("TAIL-MARKER");
});

test("the watcher re-arms: every finish of the child notifies the caller", async () => {
  const scenario = createFinishWatcherScenario({ childLastAssistantMessage: "turn done" });

  scenario.startWatchingChild();
  scenario.finishChild();
  await scenario.flush();
  scenario.finishChild();
  await scenario.flush();

  expect(scenario.parentPrompts).toHaveLength(2);
  expect(scenario.isSubscribed()).toBe(true);
});

test("an archived caller disarms the watcher instead of leaking it", async () => {
  const scenario = createFinishWatcherScenario({
    childLastAssistantMessage: "turn done",
    callerArchivedAt: new Date().toISOString(),
  });

  scenario.startWatchingChild();
  scenario.finishChild();
  await scenario.flush();

  expect(scenario.parentPrompts).toHaveLength(0);
  expect(scenario.isSubscribed()).toBe(false);
});
