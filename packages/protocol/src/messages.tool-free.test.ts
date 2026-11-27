import { describe, expect, it } from "vitest";
import {
  AgentSnapshotPayloadSchema,
  ProviderSnapshotEntrySchema,
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
} from "./messages";

function createRequest(toolPolicy: unknown) {
  return SessionInboundMessageSchema.safeParse({
    type: "create_agent_request",
    requestId: "req-tool-free",
    config: { provider: "claude", cwd: "/tmp/project", toolPolicy },
  });
}

describe("tool-free agents on the wire", () => {
  it("accepts a tool-free policy", () => {
    const parsed = createRequest({ preapproved: [], toolFree: true });
    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.type !== "create_agent_request") throw new Error("parse");
    expect(parsed.data.config.toolPolicy).toEqual({ preapproved: [], toolFree: true });
  });

  it("still accepts the policy older clients send", () => {
    const parsed = createRequest({ preapproved: [{ kind: "mcp", server: "hub", tool: "reply" }] });
    expect(parsed.success).toBe(true);
  });

  it.each([
    ["toolFree: false", { preapproved: [], toolFree: false }],
    ["an unknown policy key", { preapproved: [], toolFree: true, allowNetwork: true }],
  ])("rejects %s instead of stripping it", (_label, toolPolicy) => {
    expect(createRequest(toolPolicy).success).toBe(false);
  });

  it("carries the mode and support flags as optional fields", () => {
    expect(
      ProviderSnapshotEntrySchema.parse({
        provider: "claude",
        status: "ready",
        supportsToolFree: true,
      }),
    ).toMatchObject({ supportsToolFree: true });
    expect(
      ProviderSnapshotEntrySchema.parse({ provider: "codex", status: "ready" }),
    ).not.toHaveProperty("supportsToolFree");
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "srv",
        features: { toolFreeAgents: true },
      }).features,
    ).toMatchObject({ toolFreeAgents: true });
    const agent = {
      id: "a",
      provider: "claude",
      cwd: "/tmp/project",
      model: null,
      createdAt: "2026-11-21T00:00:00.000Z",
      updatedAt: "2026-11-21T00:00:00.000Z",
      lastUserMessageAt: null,
      status: "idle",
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: false,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
      },
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      title: null,
    };
    expect(AgentSnapshotPayloadSchema.parse({ ...agent, toolFree: true }).toolFree).toBe(true);
    expect(AgentSnapshotPayloadSchema.parse(agent)).not.toHaveProperty("toolFree");
    expect(AgentSnapshotPayloadSchema.safeParse({ ...agent, toolFree: false }).success).toBe(false);
  });
});
