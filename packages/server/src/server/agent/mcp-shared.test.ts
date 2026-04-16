import { describe, expect, it, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { setupFinishNotification } from "./mcp-shared.js";
import type { AgentManager, AgentManagerEvent, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";

describe("setupFinishNotification", () => {
  it("does not notify archived callers", async () => {
    let subscriber: ((event: AgentManagerEvent) => void) | null = null;

    const childAgent = {
      id: "child-agent",
      lifecycle: "idle",
      config: { title: "Child Agent" },
    } as ManagedAgent;

    const agentManager = {
      getAgent: vi.fn((agentId: string) => {
        if (agentId === "child-agent") {
          return childAgent;
        }
        if (agentId === "caller-agent") {
          return {
            id: "caller-agent",
            lifecycle: "idle",
            config: { title: "Caller Agent" },
          } as ManagedAgent;
        }
        return null;
      }),
      subscribe: vi.fn((callback: (event: AgentManagerEvent) => void) => {
        subscriber = callback;
        return () => {
          subscriber = null;
        };
      }),
      hasInFlightRun: vi.fn().mockReturnValue(false),
      streamAgent: vi.fn(() => (async function* noop() {})()),
      replaceAgentRun: vi.fn(() => (async function* noop() {})()),
    } as unknown as AgentManager;

    const agentStorage = {
      get: vi.fn(async (agentId: string) =>
        agentId === "caller-agent" ? { archivedAt: "2024-01-01" } : null,
      ),
    } as unknown as AgentStorage;

    setupFinishNotification({
      agentManager,
      agentStorage,
      childAgentId: "child-agent",
      callerAgentId: "caller-agent",
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
      expect(agentStorage.get).toHaveBeenCalledWith("caller-agent");
    });

    expect((agentManager as any).streamAgent).not.toHaveBeenCalled();
    expect((agentManager as any).replaceAgentRun).not.toHaveBeenCalled();
  });
});
