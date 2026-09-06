import { describe, expect, it } from "vitest";
import { SessionInboundMessageSchema, SessionOutboundMessageSchema } from "./messages.js";
import {
  VoiceCallEventMessageSchema,
  VoiceCallClientTransportMessageSchema,
  VoiceCallServerTransportMessageSchema,
  VoiceCallStartRequestSchema,
  VoiceCallStartResponseSchema,
  VoiceCallStateMessageSchema,
} from "./voice-chat.js";

describe("voice chat protocol", () => {
  it("accepts a fresh call start through the session protocol", () => {
    const message = {
      type: "voice.call.start.request",
      requestId: "request-1",
      context: { workspaceId: "workspace-1", agentId: null },
      transports: [{ kind: "webrtc", offerSdp: "offer" }],
    };

    expect(VoiceCallStartRequestSchema.parse(message)).toEqual(message);
    expect(SessionInboundMessageSchema.parse(message)).toEqual(message);
  });

  it("negotiates transport independently of the selected provider", () => {
    const message = {
      type: "voice.call.start.response",
      payload: {
        requestId: "request-1",
        accepted: true,
        callId: "call-1",
        transport: { kind: "webrtc", answerSdp: "answer" },
        error: null,
      },
    };

    expect(VoiceCallStartResponseSchema.parse(message)).toEqual(message);
    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
  });

  it("keeps server state limited to lifecycle and provider-owned input", () => {
    const message = {
      type: "voice.call.state",
      payload: {
        callId: "call-1",
        lifecycle: "active",
        input: "speech_detected",
        error: null,
      },
    };

    expect(VoiceCallStateMessageSchema.parse(message)).toEqual(message);
    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
  });

  it("carries provider-owned transport data through opaque call envelopes", () => {
    const clientMessage = {
      type: "voice.call.transport.client",
      callId: "call-1",
      data: { type: "candidate", value: "client-data" },
    };
    const serverMessage = {
      type: "voice.call.transport.server",
      payload: {
        callId: "call-1",
        data: { type: "candidate", value: "server-data" },
      },
    };

    expect(VoiceCallClientTransportMessageSchema.parse(clientMessage)).toEqual(clientMessage);
    expect(SessionInboundMessageSchema.parse(clientMessage)).toEqual(clientMessage);
    expect(VoiceCallServerTransportMessageSchema.parse(serverMessage)).toEqual(serverMessage);
    expect(SessionOutboundMessageSchema.parse(serverMessage)).toEqual(serverMessage);
  });

  it("accepts provider-neutral partial transcript events", () => {
    const message = {
      type: "voice.call.event",
      payload: {
        callId: "call-1",
        event: {
          type: "transcript",
          id: "transcript-1",
          speaker: "user",
          text: "Start an agent",
          final: false,
        },
      },
    };

    expect(VoiceCallEventMessageSchema.parse(message)).toEqual(message);
    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
  });
});
