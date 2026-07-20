import { describe, expect, test } from "vitest";
import pino from "pino";
import {
  AgentConfigSession,
  type AgentConfigOperations,
  type AgentConfigSessionHost,
} from "./agent-config-session.js";
import type { AgentProviderNotice } from "../../agent/agent-sdk-types.js";
import type { SessionOutboundMessage } from "../../messages.js";

class FakeAgentConfigOperations implements AgentConfigOperations {
  readonly loadedAgentIds: string[] = [];
  readonly modeCalls: Array<{ agentId: string; modeId: string }> = [];
  readonly modelCalls: Array<{ agentId: string; modelId: string | null }> = [];
  readonly featureCalls: Array<{ agentId: string; featureId: string; value: unknown }> = [];
  readonly thinkingCalls: Array<{ agentId: string; thinkingOptionId: string | null }> = [];
  modeNotice: AgentProviderNotice | null = null;
  thinkingNotice: AgentProviderNotice | null = null;
  loadFailure: Error | null = null;
  failWith: Error | null = null;

  async ensureLoaded(agentId: string): Promise<void> {
    this.loadedAgentIds.push(agentId);
    if (this.loadFailure) throw this.loadFailure;
  }

  async setMode(agentId: string, modeId: string): Promise<AgentProviderNotice | null> {
    this.modeCalls.push({ agentId, modeId });
    if (this.failWith) throw this.failWith;
    return this.modeNotice;
  }

  async setModel(agentId: string, modelId: string | null): Promise<void> {
    this.modelCalls.push({ agentId, modelId });
    if (this.failWith) throw this.failWith;
  }

  async setFeature(agentId: string, featureId: string, value: unknown): Promise<void> {
    this.featureCalls.push({ agentId, featureId, value });
    if (this.failWith) throw this.failWith;
  }

  async setThinking(
    agentId: string,
    thinkingOptionId: string | null,
  ): Promise<AgentProviderNotice | null> {
    this.thinkingCalls.push({ agentId, thinkingOptionId });
    if (this.failWith) throw this.failWith;
    return this.thinkingNotice;
  }
}

function makeSubsystem() {
  const emitted: SessionOutboundMessage[] = [];
  const operations = new FakeAgentConfigOperations();
  const host: AgentConfigSessionHost = { emit: (msg) => emitted.push(msg) };
  const subsystem = new AgentConfigSession({
    host,
    operations,
    logger: pino({ level: "silent" }),
  });
  return { subsystem, emitted, operations };
}

describe("AgentConfigSession", () => {
  test("set mode: forwards the args and emits an accepted response carrying the notice", async () => {
    const { subsystem, emitted, operations } = makeSubsystem();
    operations.modeNotice = { type: "info", message: "Switched to plan mode" };

    await subsystem.handleSetAgentModeRequest({
      type: "set_agent_mode_request",
      agentId: "agent-1",
      modeId: "plan",
      requestId: "req-1",
    });

    expect(operations.modeCalls).toEqual([{ agentId: "agent-1", modeId: "plan" }]);
    expect(operations.loadedAgentIds).toEqual(["agent-1"]);
    expect(emitted).toEqual([
      {
        type: "set_agent_mode_response",
        payload: {
          requestId: "req-1",
          agentId: "agent-1",
          accepted: true,
          error: null,
          notice: { type: "info", message: "Switched to plan mode" },
        },
      },
    ]);
  });

  test("set mode: a failed mutation emits the activity_log error frame before the rejected response", async () => {
    const { subsystem, emitted, operations } = makeSubsystem();
    operations.failWith = new Error("mode boom");

    await subsystem.handleSetAgentModeRequest({
      type: "set_agent_mode_request",
      agentId: "agent-1",
      modeId: "plan",
      requestId: "req-1",
    });

    expect(emitted.map((m) => m.type)).toEqual(["activity_log", "set_agent_mode_response"]);
    expect(emitted[0]).toEqual({
      type: "activity_log",
      payload: {
        id: expect.any(String),
        timestamp: expect.any(Date),
        type: "error",
        content: "Failed to set agent mode: mode boom",
      },
    });
    expect(emitted[1]).toEqual({
      type: "set_agent_mode_response",
      payload: { requestId: "req-1", agentId: "agent-1", accepted: false, error: "mode boom" },
    });
  });

  test("set mode: a failed load rejects without mutating the collected agent", async () => {
    const { subsystem, emitted, operations } = makeSubsystem();
    operations.loadFailure = new Error("agent is archived");

    await subsystem.handleSetAgentModeRequest({
      type: "set_agent_mode_request",
      agentId: "agent-1",
      modeId: "plan",
      requestId: "req-1",
    });

    expect(operations.loadedAgentIds).toEqual(["agent-1"]);
    expect(operations.modeCalls).toEqual([]);
    expect(emitted.map((message) => message.type)).toEqual([
      "activity_log",
      "set_agent_mode_response",
    ]);
    expect(emitted[0]).toEqual({
      type: "activity_log",
      payload: {
        id: expect.any(String),
        timestamp: expect.any(Date),
        type: "error",
        content: "Failed to set agent mode: agent is archived",
      },
    });
    expect(emitted[1]).toEqual({
      type: "set_agent_mode_response",
      payload: {
        requestId: "req-1",
        agentId: "agent-1",
        accepted: false,
        error: "agent is archived",
      },
    });
  });

  test("set model: emits an accepted response with no notice", async () => {
    const { subsystem, emitted, operations } = makeSubsystem();

    await subsystem.handleSetAgentModelRequest({
      type: "set_agent_model_request",
      agentId: "agent-1",
      modelId: "claude-opus-4-8",
      requestId: "req-1",
    });

    expect(operations.modelCalls).toEqual([{ agentId: "agent-1", modelId: "claude-opus-4-8" }]);
    expect(emitted).toEqual([
      {
        type: "set_agent_model_response",
        payload: { requestId: "req-1", agentId: "agent-1", accepted: true, error: null },
      },
    ]);
  });

  test("set model: a failed mutation reports the model-specific failure text", async () => {
    const { subsystem, emitted, operations } = makeSubsystem();
    operations.failWith = new Error("model boom");

    await subsystem.handleSetAgentModelRequest({
      type: "set_agent_model_request",
      agentId: "agent-1",
      modelId: "claude-opus-4-8",
      requestId: "req-1",
    });

    expect(emitted.map((m) => m.type)).toEqual(["activity_log", "set_agent_model_response"]);
    expect(emitted[0]).toEqual({
      type: "activity_log",
      payload: {
        id: expect.any(String),
        timestamp: expect.any(Date),
        type: "error",
        content: "Failed to set agent model: model boom",
      },
    });
    expect(emitted[1]).toEqual({
      type: "set_agent_model_response",
      payload: { requestId: "req-1", agentId: "agent-1", accepted: false, error: "model boom" },
    });
  });

  test("set feature: forwards the feature value and emits an accepted response with no notice", async () => {
    const { subsystem, emitted, operations } = makeSubsystem();

    await subsystem.handleSetAgentFeatureRequest({
      type: "set_agent_feature_request",
      agentId: "agent-1",
      featureId: "web_search",
      value: true,
      requestId: "req-1",
    });

    expect(operations.featureCalls).toEqual([
      { agentId: "agent-1", featureId: "web_search", value: true },
    ]);
    expect(emitted).toEqual([
      {
        type: "set_agent_feature_response",
        payload: { requestId: "req-1", agentId: "agent-1", accepted: true, error: null },
      },
    ]);
  });

  test("set feature: a failed mutation reports the feature-specific failure text", async () => {
    const { subsystem, emitted, operations } = makeSubsystem();
    operations.failWith = new Error("feature boom");

    await subsystem.handleSetAgentFeatureRequest({
      type: "set_agent_feature_request",
      agentId: "agent-1",
      featureId: "web_search",
      value: true,
      requestId: "req-1",
    });

    expect(emitted.map((m) => m.type)).toEqual(["activity_log", "set_agent_feature_response"]);
    expect(emitted[0]).toEqual({
      type: "activity_log",
      payload: {
        id: expect.any(String),
        timestamp: expect.any(Date),
        type: "error",
        content: "Failed to set agent feature: feature boom",
      },
    });
    expect(emitted[1]).toEqual({
      type: "set_agent_feature_response",
      payload: { requestId: "req-1", agentId: "agent-1", accepted: false, error: "feature boom" },
    });
  });

  test("set thinking: forwards the args and emits an accepted response carrying the notice", async () => {
    const { subsystem, emitted, operations } = makeSubsystem();
    operations.thinkingNotice = { type: "warning", message: "Thinking budget reduced" };

    await subsystem.handleSetAgentThinkingRequest({
      type: "set_agent_thinking_request",
      agentId: "agent-1",
      thinkingOptionId: "high",
      requestId: "req-1",
    });

    expect(operations.thinkingCalls).toEqual([{ agentId: "agent-1", thinkingOptionId: "high" }]);
    expect(emitted).toEqual([
      {
        type: "set_agent_thinking_response",
        payload: {
          requestId: "req-1",
          agentId: "agent-1",
          accepted: true,
          error: null,
          notice: { type: "warning", message: "Thinking budget reduced" },
        },
      },
    ]);
  });

  test("set thinking: a failed mutation reports the thinking-specific failure text", async () => {
    const { subsystem, emitted, operations } = makeSubsystem();
    operations.failWith = new Error("thinking boom");

    await subsystem.handleSetAgentThinkingRequest({
      type: "set_agent_thinking_request",
      agentId: "agent-1",
      thinkingOptionId: "high",
      requestId: "req-1",
    });

    expect(emitted.map((m) => m.type)).toEqual(["activity_log", "set_agent_thinking_response"]);
    expect(emitted[0]).toEqual({
      type: "activity_log",
      payload: {
        id: expect.any(String),
        timestamp: expect.any(Date),
        type: "error",
        content: "Failed to set agent thinking option: thinking boom",
      },
    });
    expect(emitted[1]).toEqual({
      type: "set_agent_thinking_response",
      payload: { requestId: "req-1", agentId: "agent-1", accepted: false, error: "thinking boom" },
    });
  });
});
