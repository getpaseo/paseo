import { describe, expect, it } from "vitest";
import { DEFAULT_ASSISTANT_CONFIGURATION, AssistantRequestSchema } from "./assistants.js";
import {
  SessionInboundMessageSchema,
  ServerInfoStatusPayloadSchema,
  VoiceLiveStartRequestSchema,
} from "./messages.js";
import { validateWSOutboundMessage } from "./validation/ws-outbound.js";

describe("assistant protocol", () => {
  it("keeps legacy voice start and server capabilities optional", () => {
    expect(
      VoiceLiveStartRequestSchema.parse({
        type: "voice.live.start.request",
        requestId: "old",
        negotiation: { kind: "webrtc_sdp", offerSdp: "offer" },
      }).assistantId,
    ).toBeUndefined();
    expect(
      ServerInfoStatusPayloadSchema.parse({ status: "server_info", serverId: "old", features: {} })
        .features?.assistants,
    ).toBeUndefined();
  });

  it("rejects unsafe record ids and invalid revision/checkpoint values", () => {
    expect(
      AssistantRequestSchema.safeParse({
        type: "assistant.get.request",
        requestId: "get",
        assistantId: "../../secrets",
      }).success,
    ).toBe(false);
    expect(
      AssistantRequestSchema.safeParse({
        type: "assistant.compact.request",
        requestId: "edit",
        assistantId: `ast_${"a".repeat(32)}`,
        expectedRevision: 0,
        throughSeq: -1,
        summary: "",
      }).success,
    ).toBe(false);
    expect(
      SessionInboundMessageSchema.safeParse({
        type: "assistant.template.save.request",
        requestId: "template",
        name: "Work",
        configuration: DEFAULT_ASSISTANT_CONFIGURATION,
      }).success,
    ).toBe(true);
  });

  it("validates paged history through the generated websocket validator", () => {
    const message = {
      type: "session",
      message: {
        type: "assistant.get.response",
        payload: {
          requestId: "get",
          assistant: {
            id: `ast_${"a".repeat(32)}`,
            name: "Work",
            templateId: null,
            configuration: DEFAULT_ASSISTANT_CONFIGURATION,
            revision: 1,
            createdAt: "now",
            updatedAt: "now",
            summary: "",
            summaryThroughSeq: 0,
            lastSeq: 1,
          },
          history: [
            {
              kind: "delegation",
              seq: 1,
              createdAt: "now",
              callId: "call",
              requestId: "tool",
              description: "list_agents",
              ok: false,
              errorCode: "future_code",
            },
          ],
          hasMore: false,
        },
      },
    };
    expect(validateWSOutboundMessage(message).success).toBe(true);
    expect(
      validateWSOutboundMessage({
        ...message,
        message: {
          ...message.message,
          payload: {
            ...message.message.payload,
            history: [{ ...message.message.payload.history[0], ok: "false" }],
          },
        },
      }).success,
    ).toBe(false);
  });
});
