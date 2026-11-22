import {
  AgentStreamEventPayloadSchema,
  AgentTimelineEntryPayloadSchema,
  SendAgentMessageRequestSchema,
  SendAgentMessageResponseMessageSchema,
  SendAgentMessageSchema,
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
});

describe("agent sender active-turn behaviors", () => {
  it("accepts queue on a send request and reports the applied behavior in the response", () => {
    expect(
      SendAgentMessageRequestSchema.parse({
        type: "send_agent_message_request",
        requestId: "request-3",
        agentId: "agent-1",
        text: "Report when you are done",
        sourceAgentId: "parent",
        activeTurnBehavior: "queue",
      }).activeTurnBehavior,
    ).toBe("queue");
    expect(
      SendAgentMessageResponseMessageSchema.parse({
        type: "send_agent_message_response",
        payload: {
          requestId: "request-3",
          agentId: "agent-1",
          accepted: true,
          deliveryStatus: "queued",
          activeTurnBehavior: "queue",
          guidance: "Queued.",
          error: null,
        },
      }).payload,
    ).toMatchObject({ activeTurnBehavior: "queue", guidance: "Queued." });
  });

  it("keeps a person's send_agent_message to interrupt and steer", () => {
    expect(
      SendAgentMessageSchema.safeParse({
        type: "send_agent_message",
        agentId: "agent-1",
        text: "hello",
        activeTurnBehavior: "queue",
      }).success,
    ).toBe(false);
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
});
