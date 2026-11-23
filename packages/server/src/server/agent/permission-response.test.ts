import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type {
  AgentPromptInput,
  AgentPermissionResult,
  AgentRunOptions,
  AgentPermissionResponse,
  AgentPermissionResponseOptions,
} from "./agent-sdk-types.js";
import type { AgentStreamEvent } from "../messages.js";
import { respondToAgentPermission } from "./permission-response.js";

class FakePermissionAgentManager {
  permissionResult: AgentPermissionResult | void;
  hasRunInFlight = false;
  outOfBandHandled = false;
  permissionResponses: Array<{
    agentId: string;
    requestId: string;
    response: AgentPermissionResponse;
    options?: AgentPermissionResponseOptions;
  }> = [];
  streamRuns: Array<{ agentId: string; prompt: AgentPromptInput; options?: AgentRunOptions }> = [];
  replacementRuns: Array<{ agentId: string; prompt: AgentPromptInput; options?: AgentRunOptions }> =
    [];

  async respondToPermission(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
    options?: AgentPermissionResponseOptions,
  ): Promise<AgentPermissionResult | void> {
    this.permissionResponses.push({
      agentId,
      requestId,
      response,
      ...(options ? { options } : {}),
    });
    return this.permissionResult;
  }

  async tryRunOutOfBand(): Promise<boolean> {
    return this.outOfBandHandled;
  }

  getAgent() {
    return undefined;
  }

  async reloadStalePluginSession(): Promise<void> {}

  hasInFlightRun(): boolean {
    return this.hasRunInFlight;
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

  test("replaces an in-flight run for follow-up prompts", async () => {
    const agentManager = new FakePermissionAgentManager();
    agentManager.hasRunInFlight = true;
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

  test("forwards caller agent attribution when provided", async () => {
    const agentManager = new FakePermissionAgentManager();

    await respondToAgentPermission({
      agentManager,
      agentId: "agent-1",
      requestId: "permission-2",
      response: { behavior: "deny", message: "use read-only mode" },
      callerAgentId: "lead-agent-1",
      callerAgentTitle: "Coordinator",
      logger,
    });

    expect(agentManager.permissionResponses).toEqual([
      {
        agentId: "agent-1",
        requestId: "permission-2",
        response: { behavior: "deny", message: "use read-only mode" },
        options: { callerAgentId: "lead-agent-1", callerAgentTitle: "Coordinator" },
      },
    ]);
  });
});
