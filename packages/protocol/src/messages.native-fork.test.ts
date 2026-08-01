import { describe, expect, it } from "vitest";
import {
  AgentNativeForkRequestMessageSchema,
  AgentNativeForkResponseMessageSchema,
  AgentSnapshotPayloadSchema,
  ServerInfoStatusPayloadSchema,
} from "./messages.js";

describe("agent.native_fork wire", () => {
  it("parses request with tab target and message boundary", () => {
    const parsed = AgentNativeForkRequestMessageSchema.parse({
      type: "agent.native_fork.request",
      requestId: "r1",
      agentId: "agt_1",
      boundaryMessageId: "msg_assistant_1",
      target: "tab",
    });
    expect(parsed.target).toBe("tab");
    expect(parsed.boundaryMessageId).toBe("msg_assistant_1");
  });

  it("defaults target to tab", () => {
    const parsed = AgentNativeForkRequestMessageSchema.parse({
      type: "agent.native_fork.request",
      requestId: "r1",
      agentId: "agt_1",
      boundaryMessageId: "msg_1",
    });
    expect(parsed.target).toBe("tab");
  });

  it("parses accepted response", () => {
    const parsed = AgentNativeForkResponseMessageSchema.parse({
      type: "agent.native_fork.response",
      payload: {
        requestId: "r1",
        sourceAgentId: "agt_src",
        accepted: true,
        error: null,
        agentId: "agt_fork",
        workspaceId: "ws_1",
      },
    });
    expect(parsed.payload.agentId).toBe("agt_fork");
  });
});

describe("supportsNativeFork capability", () => {
  it("defaults missing supportsNativeFork to false on agent snapshot", () => {
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
    expect(parsed.capabilities.supportsNativeFork).toBe(false);
  });
});

describe("server_info.features.agentNativeFork", () => {
  it("accepts optional agentNativeFork feature", () => {
    const parsed = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "srv_1",
      features: { agentNativeFork: true },
    });
    expect(parsed.features?.agentNativeFork).toBe(true);
  });
});
