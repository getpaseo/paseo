import { describe, expect, it } from "vitest";
import {
  ProviderHeartbeatDescriptorPayloadSchema,
  ProviderHeartbeatModeSchema,
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";

const PARENT_AGENT_ID = "00000000-0000-4000-8000-000000000001";

describe("provider heartbeat wire schemas", () => {
  it("accepts heartbeat modes", () => {
    expect(ProviderHeartbeatModeSchema.parse("recurring")).toBe("recurring");
    expect(ProviderHeartbeatModeSchema.parse("one_shot")).toBe("one_shot");
    expect(ProviderHeartbeatModeSchema.parse("dynamic")).toBe("dynamic");
  });

  it("accepts a heartbeat descriptor", () => {
    const parsed = ProviderHeartbeatDescriptorPayloadSchema.parse({
      taskId: "hb-1",
      parentAgentId: PARENT_AGENT_ID,
      provider: "claude",
      prompt: "check deploy",
      mode: "recurring",
      scheduleLabel: "every 5 minutes",
      nextHint: "2026-08-02T12:00:00.000Z",
      updatedAt: "2026-08-02T11:55:00.000Z",
    });
    expect(parsed.taskId).toBe("hb-1");
    expect(parsed.mode).toBe("recurring");
    expect(parsed.nextHint).toBe("2026-08-02T12:00:00.000Z");
  });

  it("accepts a null nextHint", () => {
    const parsed = ProviderHeartbeatDescriptorPayloadSchema.parse({
      taskId: "hb-2",
      parentAgentId: PARENT_AGENT_ID,
      provider: "claude",
      prompt: "self-paced loop",
      mode: "dynamic",
      scheduleLabel: "self-paced",
      nextHint: null,
      updatedAt: "2026-08-02T11:55:00.000Z",
    });
    expect(parsed.nextHint).toBeNull();
    expect(parsed.mode).toBe("dynamic");
  });

  it("parses list request/response and update push", () => {
    const request = SessionInboundMessageSchema.parse({
      type: "agent.provider_heartbeats.list.request",
      requestId: "r1",
      parentAgentId: PARENT_AGENT_ID,
    });
    expect(request.type).toBe("agent.provider_heartbeats.list.request");

    const response = SessionOutboundMessageSchema.parse({
      type: "agent.provider_heartbeats.list.response",
      payload: {
        requestId: "r1",
        parentAgentId: PARENT_AGENT_ID,
        heartbeats: [],
        error: null,
      },
    });
    expect(response.type).toBe("agent.provider_heartbeats.list.response");

    const update = SessionOutboundMessageSchema.parse({
      type: "agent.provider_heartbeats.update",
      payload: {
        parentAgentId: PARENT_AGENT_ID,
        heartbeats: [
          {
            taskId: "hb-1",
            parentAgentId: PARENT_AGENT_ID,
            provider: "claude",
            prompt: "check deploy",
            mode: "one_shot",
            scheduleLabel: "once at 3pm",
            nextHint: null,
            updatedAt: "2026-08-02T11:55:00.000Z",
          },
        ],
      },
    });
    expect(update.type).toBe("agent.provider_heartbeats.update");
    expect(update.payload.heartbeats).toHaveLength(1);
  });

  it("parses delete request/response", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "agent.provider_heartbeats.delete.request",
        requestId: "r2",
        parentAgentId: PARENT_AGENT_ID,
        taskId: "hb-1",
      }).type,
    ).toBe("agent.provider_heartbeats.delete.request");

    expect(
      SessionOutboundMessageSchema.parse({
        type: "agent.provider_heartbeats.delete.response",
        payload: {
          requestId: "r2",
          parentAgentId: PARENT_AGENT_ID,
          taskId: "hb-1",
          error: null,
        },
      }).type,
    ).toBe("agent.provider_heartbeats.delete.response");
  });

  it("accepts optional providerHeartbeats feature flag", () => {
    const withFlag = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "host-1",
      features: {
        providerHeartbeats: true,
      },
    });
    expect(withFlag.features?.providerHeartbeats).toBe(true);

    const withoutFlag = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "host-1",
      features: {},
    });
    expect(withoutFlag.features?.providerHeartbeats).toBeUndefined();
  });
});
