import {
  AgentStreamEventPayloadSchema,
  AgentTimelineEntryPayloadSchema,
  AgentSnapshotPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  SendAgentMessageRequestSchema,
} from "./messages";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { validateWSOutboundMessage } from "./validation/ws-outbound.js";

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

describe("agent message queue wire contract", () => {
  it("accepts correlated enqueue and list messages with full attachment payloads", () => {
    const request = {
      type: "agent.queue.enqueue.request",
      requestId: "queue-1",
      agentId: "agent-1",
      messageId: "message-1",
      text: "Run the tests next",
      images: [{ data: "aW1hZ2U=", mimeType: "image/png" }],
      attachments: [{ type: "text", mimeType: "text/plain", text: "Test context" }],
    };
    expect(SessionInboundMessageSchema.parse(request)).toEqual(request);
    const selectedMessageRequest = {
      type: "agent.queue.list.request",
      requestId: "queue-selected",
      agentId: "agent-1",
      queuedMessageId: request.messageId,
    };
    expect(SessionInboundMessageSchema.parse(selectedMessageRequest)).toEqual(
      selectedMessageRequest,
    );
    const response = {
      type: "agent.queue.list.response",
      payload: {
        requestId: "queue-2",
        agentId: "agent-1",
        success: true,
        error: null,
        messages: [
          {
            id: request.messageId,
            text: request.text,
            images: request.images,
            attachments: request.attachments,
            createdAt: "2026-10-26T00:00:00.000Z",
          },
        ],
      },
    };
    expect(SessionOutboundMessageSchema.parse(response)).toEqual(response);
    expect(validateWSOutboundMessage({ type: "session", message: response })).toEqual({
      success: true,
      data: { type: "session", message: response },
    });
  });

  it("keeps queue snapshots lightweight while accepting legacy snapshots without a queue", () => {
    const summarySchema = AgentSnapshotPayloadSchema.pick({ queuedMessages: true });
    const summary = {
      id: "message-1",
      text: "Run the tests next",
      attachmentCount: 2,
      createdAt: "2026-10-26T00:00:00.000Z",
    };
    expect(summarySchema.parse({})).toEqual({});
    expect(
      summarySchema.parse({
        queuedMessages: [
          { ...summary, images: [{ data: "large-image", mimeType: "image/png" }], attachments: [] },
        ],
      }),
    ).toEqual({ queuedMessages: [summary] });
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
