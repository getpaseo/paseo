import { describe, expect, it } from "vitest";
import { SessionInboundMessageSchema, SessionOutboundMessageSchema } from "./messages.js";
import { validateWSOutboundMessage } from "./validation/ws-outbound.js";

describe("voice mute wire compatibility", () => {
  it("continues accepting older voice messages without mute fields", () => {
    const request = { type: "set_voice_mode", enabled: true, agentId: "agent" };
    const state = { type: "voice_input_state", payload: { isSpeaking: true } };
    expect(SessionInboundMessageSchema.parse(request)).toEqual(request);
    expect(SessionOutboundMessageSchema.parse(state)).toEqual(state);
  });

  it("preserves command negotiation and the correlated mute request", () => {
    const start = {
      type: "set_voice_mode",
      enabled: true,
      voiceCommandsEnabled: true,
      isMuted: true,
    };
    const mute = { type: "voice.input.set_muted.request", requestId: "r", muted: true };
    expect(SessionInboundMessageSchema.parse(start)).toEqual(start);
    expect(SessionInboundMessageSchema.parse(mute)).toEqual(mute);
  });

  it.each([
    {
      type: "voice_input_state",
      payload: { isSpeaking: false, isMuted: true, error: "Recognition failed" },
    },
    { type: "voice_input_state", payload: { isSpeaking: false, isMuted: true } },
    {
      type: "voice.input.set_muted.response",
      payload: { requestId: "r", muted: true, error: null },
    },
    {
      type: "set_voice_mode_response",
      payload: {
        requestId: "r",
        enabled: true,
        agentId: "agent",
        accepted: true,
        error: null,
        voiceCommandsEnabled: true,
        isMuted: true,
      },
    },
  ])("preserves mute state through the generated client validator: $type", (message) => {
    const wire = { type: "session", message };
    expect(validateWSOutboundMessage(wire)).toEqual({ success: true, data: wire });
  });
});
