import { describe, expect, it } from "vitest";
import { AgentSnapshotPayloadSchema, SendAgentMessageRequestSchema } from "./messages.js";

describe("send_agent_message steer flag", () => {
  it("defaults steer to false", () => {
    const parsed = SendAgentMessageRequestSchema.parse({
      type: "send_agent_message_request",
      requestId: "r1",
      agentId: "agt_1",
      text: "hello",
    });
    expect(parsed.steer).toBe(false);
  });

  it("accepts steer true", () => {
    const parsed = SendAgentMessageRequestSchema.parse({
      type: "send_agent_message_request",
      requestId: "r1",
      agentId: "agt_1",
      text: "redirect",
      steer: true,
    });
    expect(parsed.steer).toBe(true);
  });
});

describe("supportsSteer capability", () => {
  it("defaults missing supportsSteer to false", () => {
    const parsed = AgentSnapshotPayloadSchema.parse({
      id: "agent-123",
      provider: "claude",
      cwd: "/tmp/project",
      model: "claude-opus-4",
      thinkingOptionId: null,
      effectiveThinkingOptionId: null,
      createdAt: "2026-04-03T12:00:00.000Z",
      updatedAt: "2026-04-03T12:00:00.000Z",
      lastUserMessageAt: null,
      status: "idle",
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
      },
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      title: null,
      labels: {},
    });
    expect(parsed.capabilities.supportsSteer).toBe(false);
  });
});
