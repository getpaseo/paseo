import {
  AgentMessageReceiptGetRequestSchema,
  AgentStreamEventPayloadSchema,
  AgentTimelineEntryPayloadSchema,
  SendAgentMessageRequestSchema,
  SendAgentMessageResponseMessageSchema,
} from "./messages";
import { describe, expect, it } from "vitest";
import { z } from "zod";

describe("send_agent_message_request active-turn behavior", () => {
  it("accepts an optional steer intent while retaining interrupt compatibility", () => {
    expect(
      SendAgentMessageRequestSchema.parse({
        type: "send_agent_message_request",
        requestId: "request-1",
        agentId: "agent-1",
        text: "Follow this instruction",
        activeTurnBehavior: "steer",
      }).activeTurnBehavior,
    ).toBe("steer");

    expect(
      SendAgentMessageRequestSchema.parse({
        type: "send_agent_message_request",
        requestId: "request-2",
        agentId: "agent-1",
        text: "Keep the old behavior",
      }).activeTurnBehavior,
    ).toBeUndefined();
  });

  it("accepts an exact daemon-owned state guard and a receipt lookup", () => {
    const guarded = SendAgentMessageRequestSchema.parse({
      type: "send_agent_message_request",
      requestId: "request-guarded",
      agentId: "agent-1",
      text: "Run only from the observed idle seat",
      messageId: "message-1",
      guard: {
        expectedAgentId: "agent-1",
        expectedUpdatedAt: "2026-09-11T00:00:00.000Z",
        expectedStatus: "idle",
        expectedArchivedAt: null,
      },
    });
    expect(guarded.guard).toEqual({
      expectedAgentId: "agent-1",
      expectedUpdatedAt: "2026-09-11T00:00:00.000Z",
      expectedStatus: "idle",
      expectedArchivedAt: null,
    });
    expect(
      AgentMessageReceiptGetRequestSchema.parse({
        type: "agent.message.receipt.get.request",
        requestId: "request-receipt",
        agentId: "agent-1",
        messageId: "message-1",
      }),
    ).toMatchObject({ agentId: "agent-1", messageId: "message-1" });
  });
});

describe("canonical timeline turn ID compatibility", () => {
  it("accepts both new turn-tagged wire rows and legacy rows without IDs", () => {
    const entry = {
      provider: "codex" as const,
      item: { type: "assistant_message" as const, text: "done" },
      timestamp: "2026-01-01T00:00:00.000Z",
      seqStart: 1,
      seqEnd: 1,
      sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }],
      collapsed: [],
    };
    expect(AgentTimelineEntryPayloadSchema.parse(entry).turnId).toBeUndefined();
    expect(AgentTimelineEntryPayloadSchema.parse({ ...entry, turnId: "turn-1" }).turnId).toBe(
      "turn-1",
    );

    const timeline = {
      type: "timeline" as const,
      provider: "codex" as const,
      item: { type: "assistant_message" as const, text: "done" },
    };
    expect(AgentStreamEventPayloadSchema.parse(timeline).turnId).toBeUndefined();
    expect(AgentStreamEventPayloadSchema.parse({ ...timeline, turnId: "turn-1" }).turnId).toBe(
      "turn-1",
    );
  });
});

describe("legacy daemon send request schema compatibility", () => {
  const LegacySendAgentMessageRequestSchema = z.object({
    type: z.literal("send_agent_message_request"),
    requestId: z.string(),
    agentId: z.string(),
    text: z.string(),
    messageId: z.string().optional(),
  });

  it("ignores a new client's active-turn intent and retains legacy interrupt dispatch", () => {
    const newClientRequest = SendAgentMessageRequestSchema.parse({
      type: "send_agent_message_request",
      requestId: "request-legacy",
      agentId: "agent-1",
      text: "replace the turn",
      activeTurnBehavior: "steer",
    });
    const legacyRequest = LegacySendAgentMessageRequestSchema.parse(newClientRequest);

    expect(legacyRequest).toEqual({
      type: "send_agent_message_request",
      requestId: "request-legacy",
      agentId: "agent-1",
      text: "replace the turn",
    });
    expect("activeTurnBehavior" in legacyRequest).toBe(false);
  });

  it("lets a legacy daemon ignore the optional send guard", () => {
    const newClientRequest = SendAgentMessageRequestSchema.parse({
      type: "send_agent_message_request",
      requestId: "request-guarded-legacy",
      agentId: "agent-1",
      text: "send once",
      guard: {
        expectedAgentId: "agent-1",
        expectedUpdatedAt: "2026-09-11T00:00:00.000Z",
        expectedStatus: "idle",
        expectedArchivedAt: null,
      },
    });

    expect(LegacySendAgentMessageRequestSchema.parse(newClientRequest)).toEqual({
      type: "send_agent_message_request",
      requestId: "request-guarded-legacy",
      agentId: "agent-1",
      text: "send once",
    });
  });

  it("lets a legacy client ignore guarded-send receipt metadata", () => {
    const LegacySendAgentMessageResponseSchema = z.object({
      type: z.literal("send_agent_message_response"),
      payload: z.object({
        requestId: z.string(),
        agentId: z.string(),
        accepted: z.boolean(),
        error: z.string().nullable(),
      }),
    });
    const response = SendAgentMessageResponseMessageSchema.parse({
      type: "send_agent_message_response",
      payload: {
        requestId: "request-guarded",
        agentId: "agent-1",
        messageId: "message-1",
        accepted: true,
        replayed: false,
        guard: { matched: true, reason: null },
        error: null,
      },
    });

    expect(LegacySendAgentMessageResponseSchema.parse(response)).toEqual({
      type: "send_agent_message_response",
      payload: {
        requestId: "request-guarded",
        agentId: "agent-1",
        accepted: true,
        error: null,
      },
    });
  });
});
