import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type {
  AgentPromptInput,
  AgentPermissionResult,
  AgentRunOptions,
  AgentPermissionResponse,
  AgentStreamEvent,
} from "./agent-sdk-types.js";
import type { AgentManagerEvent } from "./agent-manager.js";
import {
  PlanningTurnFollowUpTimeoutError,
  respondToAgentPermission,
} from "./permission-response.js";

class FakePermissionAgentManager {
  permissionResult: AgentPermissionResult | void;
  activeForegroundTurnId: string | null = null;
  outOfBandHandled = false;
  permissionResponses: Array<{
    agentId: string;
    requestId: string;
    response: AgentPermissionResponse;
  }> = [];
  streamRuns: Array<{ agentId: string; prompt: AgentPromptInput; options?: AgentRunOptions }> = [];
  replacementRuns: Array<{ agentId: string; prompt: AgentPromptInput; options?: AgentRunOptions }> =
    [];
  private readonly subscribers = new Set<(event: AgentManagerEvent) => void>();

  async respondToPermission(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<AgentPermissionResult | void> {
    this.permissionResponses.push({ agentId, requestId, response });
    return this.permissionResult;
  }

  tryRunOutOfBand(): boolean {
    return this.outOfBandHandled;
  }

  getAgent() {
    if (this.activeForegroundTurnId === null) {
      return undefined;
    }
    return { activeForegroundTurnId: this.activeForegroundTurnId };
  }

  hasInFlightRun(): boolean {
    return this.activeForegroundTurnId !== null;
  }

  subscribe(callback: (event: AgentManagerEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  emitStreamEvent(agentId: string, event: AgentStreamEvent): void {
    const managerEvent: AgentManagerEvent = {
      type: "agent_stream",
      agentId,
      event,
    };
    for (const subscriber of this.subscribers) {
      subscriber(managerEvent);
    }
  }

  streamAgent(
    agentId: string,
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): AsyncGenerator<AgentStreamEvent> {
    this.streamRuns.push({ agentId, prompt, options });
    return emptyAgentStream();
  }

  async replaceAgentRun(
    agentId: string,
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): Promise<AsyncGenerator<AgentStreamEvent>> {
    this.replacementRuns.push({ agentId, prompt, options });
    return emptyAgentStream();
  }
}

async function* emptyAgentStream(): AsyncGenerator<AgentStreamEvent> {}

describe("respondToAgentPermission", () => {
  const logger = createTestLogger();

  test("starts a follow-up run returned by the provider permission response", async () => {
    const agentManager = new FakePermissionAgentManager();
    agentManager.permissionResult = { followUpPrompt: "implement the approved plan" };

    await respondToAgentPermission({
      agentManager,
      agentId: "agent-1",
      requestId: "permission-1",
      response: { behavior: "allow" },
      logger,
    });

    expect(agentManager.permissionResponses).toEqual([
      {
        agentId: "agent-1",
        requestId: "permission-1",
        response: { behavior: "allow" },
      },
    ]);
    expect(agentManager.streamRuns).toEqual([
      {
        agentId: "agent-1",
        prompt: "implement the approved plan",
      },
    ]);
    expect(agentManager.replacementRuns).toEqual([]);
  });

  test("does not start a run when the permission response has no follow-up prompt", async () => {
    const agentManager = new FakePermissionAgentManager();

    await respondToAgentPermission({
      agentManager,
      agentId: "agent-1",
      requestId: "permission-1",
      response: { behavior: "deny", message: "not now" },
      logger,
    });

    expect(agentManager.permissionResponses).toEqual([
      {
        agentId: "agent-1",
        requestId: "permission-1",
        response: { behavior: "deny", message: "not now" },
      },
    ]);
    expect(agentManager.streamRuns).toEqual([]);
    expect(agentManager.replacementRuns).toEqual([]);
  });

  test("replaces an in-flight run for follow-up prompts by default", async () => {
    const agentManager = new FakePermissionAgentManager();
    agentManager.activeForegroundTurnId = "turn-1";
    agentManager.permissionResult = { followUpPrompt: "continue after approval" };

    await respondToAgentPermission({
      agentManager,
      agentId: "agent-1",
      requestId: "permission-1",
      response: { behavior: "allow" },
      logger,
    });

    expect(agentManager.streamRuns).toEqual([]);
    expect(agentManager.replacementRuns).toEqual([
      {
        agentId: "agent-1",
        prompt: "continue after approval",
      },
    ]);
  });

  test("waits for planning turn_completed then starts without replacing when replaceRunning is false", async () => {
    const agentManager = new FakePermissionAgentManager();
    agentManager.activeForegroundTurnId = "plan-turn";
    agentManager.permissionResult = {
      followUpPrompt: "implement after CreatePlan settles",
      replaceRunning: false,
    };

    const pending = respondToAgentPermission({
      agentManager,
      agentId: "agent-1",
      requestId: "permission-1",
      response: { behavior: "allow" },
      logger,
    });

    await Promise.resolve();
    agentManager.emitStreamEvent("agent-1", {
      type: "turn_completed",
      provider: "cursor",
      turnId: "plan-turn",
    });
    await pending;

    expect(agentManager.replacementRuns).toEqual([]);
    expect(agentManager.streamRuns).toEqual([
      {
        agentId: "agent-1",
        prompt: "implement after CreatePlan settles",
      },
    ]);
  });

  test("skips follow-up when the planning turn is canceled (Stop)", async () => {
    const agentManager = new FakePermissionAgentManager();
    agentManager.activeForegroundTurnId = "plan-turn";
    agentManager.permissionResult = {
      followUpPrompt: "implement after CreatePlan settles",
      replaceRunning: false,
    };

    const pending = respondToAgentPermission({
      agentManager,
      agentId: "agent-1",
      requestId: "permission-1",
      response: { behavior: "allow" },
      logger,
    });

    await Promise.resolve();
    agentManager.emitStreamEvent("agent-1", {
      type: "turn_canceled",
      provider: "cursor",
      reason: "Interrupted",
      turnId: "plan-turn",
    });
    await pending;

    expect(agentManager.streamRuns).toEqual([]);
    expect(agentManager.replacementRuns).toEqual([]);
  });

  test("skips follow-up when replaceRunning is false and no planning turn is active", async () => {
    const agentManager = new FakePermissionAgentManager();
    agentManager.permissionResult = {
      followUpPrompt: "implement after CreatePlan settles",
      replaceRunning: false,
    };

    await respondToAgentPermission({
      agentManager,
      agentId: "agent-1",
      requestId: "permission-1",
      response: { behavior: "allow" },
      logger,
    });

    expect(agentManager.streamRuns).toEqual([]);
    expect(agentManager.replacementRuns).toEqual([]);
  });

  test("times out when replaceRunning is false and the turn never settles", async () => {
    vi.useFakeTimers();
    const agentManager = new FakePermissionAgentManager();
    agentManager.activeForegroundTurnId = "plan-turn";
    agentManager.permissionResult = {
      followUpPrompt: "never starts",
      replaceRunning: false,
    };

    const pending = respondToAgentPermission({
      agentManager,
      agentId: "agent-1",
      requestId: "permission-1",
      response: { behavior: "allow" },
      logger,
    });
    let caught: unknown;
    const pendingSettled = pending.catch((error: unknown) => {
      caught = error;
      throw error;
    });
    const expectation = expect(pendingSettled).rejects.toBeInstanceOf(
      PlanningTurnFollowUpTimeoutError,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await expectation;

    expect(caught).toMatchObject({
      agentId: "agent-1",
      turnId: "plan-turn",
      timeoutMs: 30_000,
    });
    expect(agentManager.streamRuns).toEqual([]);
    expect(agentManager.replacementRuns).toEqual([]);
    vi.useRealTimers();
  });
});
