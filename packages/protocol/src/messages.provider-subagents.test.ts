import { describe, expect, test } from "vitest";
import { SessionInboundMessageSchema, SessionOutboundMessageSchema } from "./messages.js";

describe("provider subagent protocol", () => {
  test("accepts authoritative pending input queue state on agent snapshots", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "agent_update",
      payload: {
        kind: "upsert",
        agent: {
          id: "parent-1",
          provider: "pi",
          cwd: "/workspace",
          model: null,
          createdAt: "2026-08-24T00:00:00.000Z",
          updatedAt: "2026-08-24T00:00:00.000Z",
          lastUserMessageAt: null,
          status: "running",
          activeTurn: { turnId: "turn-1", startedAt: null },
          capabilities: {
            supportsStreaming: true,
            supportsSessionPersistence: true,
            supportsDynamicModes: true,
            supportsMcpServers: false,
            supportsReasoningStream: true,
            supportsToolInvocations: true,
          },
          currentModeId: null,
          availableModes: [],
          pendingPermissions: [],
          pendingInputQueue: { steering: ["redirect"], followUp: ["afterwards"] },
          persistence: null,
          title: null,
          labels: {},
        },
      },
    });
    expect(parsed).toMatchObject({
      payload: {
        agent: {
          pendingInputQueue: { steering: ["redirect"], followUp: ["afterwards"] },
        },
      },
    });
  });

  test("accepts native active-turn follow-up admission", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "send_agent_message_request",
        requestId: "follow-up-1",
        agentId: "parent-1",
        text: "afterwards",
        activeTurnBehavior: "follow_up",
        attachments: [],
      }),
    ).toMatchObject({ activeTurnBehavior: "follow_up" });
  });

  test("accepts a scoped timeline request and structured live update", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "agent.provider_subagents.timeline.get.request",
        parentAgentId: "parent-1",
        subagentId: "child-1",
        requestId: "request-1",
      }),
    ).toMatchObject({ parentAgentId: "parent-1", subagentId: "child-1" });

    expect(
      SessionOutboundMessageSchema.parse({
        type: "agent.provider_subagents.update",
        payload: {
          kind: "timeline",
          parentAgentId: "parent-1",
          subagentId: "child-1",
          provider: "claude",
          epoch: "epoch-1",
          seq: 4,
          timestamp: "2026-07-12T10:00:00.000Z",
          item: { type: "assistant_message", text: "Found it." },
        },
      }),
    ).toMatchObject({
      payload: {
        kind: "timeline",
        parentAgentId: "parent-1",
        subagentId: "child-1",
        seq: 4,
      },
    });
  });

  test("accepts a provider child working directory while remaining compatible when absent", () => {
    const descriptor = {
      id: "child-1",
      parentAgentId: "parent-1",
      provider: "opencode",
      title: "Explore",
      description: null,
      status: "running",
      createdAt: "2026-07-12T10:00:00.000Z",
      updatedAt: "2026-07-12T10:00:00.000Z",
      toolCallId: null,
    };

    expect(
      SessionOutboundMessageSchema.parse({
        type: "agent.provider_subagents.list.response",
        payload: {
          requestId: "request-1",
          parentAgentId: "parent-1",
          subagents: [{ ...descriptor, cwd: "/workspace/child" }],
          error: null,
        },
      }),
    ).toMatchObject({ payload: { subagents: [{ cwd: "/workspace/child" }] } });

    expect(
      SessionOutboundMessageSchema.parse({
        type: "agent.provider_subagents.list.response",
        payload: {
          requestId: "request-2",
          parentAgentId: "parent-1",
          subagents: [descriptor],
          error: null,
        },
      }),
    ).toMatchObject({ payload: { subagents: [{ id: "child-1" }] } });
  });
});
