import { describe, expect, test } from "vitest";
import {
  ServerInfoStatusPayloadSchema,
  VoiceLiveStartRequestSchema,
  VoiceLiveStartResponseSchema,
  VoiceLiveStopRequestSchema,
  VoiceLiveStopResponseSchema,
  VoiceLiveUpdateSchema,
  VoiceLiveVoicesRequestSchema,
  VoiceLiveVoicesResponseSchema,
} from "./messages.js";

describe("live voice messages", () => {
  test("keeps the capability optional for older server info payloads", () => {
    const oldServer = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "server-1",
      features: {},
    });

    expect(oldServer.features?.liveVoice).toBeUndefined();
    expect(oldServer.features?.liveVoiceVoiceCatalog).toBeUndefined();
    expect(oldServer.features?.agentPaseoTools).toBeUndefined();
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "server-1",
        features: { liveVoice: true, agentPaseoTools: false },
      }).features,
    ).toMatchObject({ liveVoice: true, agentPaseoTools: false });
  });

  test("parses a start request with and without an explicit voice", () => {
    expect(
      VoiceLiveStartRequestSchema.parse({
        type: "voice.live.start.request",
        requestId: "request-1",
        negotiation: { kind: "webrtc_sdp", offerSdp: "v=0\r\n" },
      }).voice,
    ).toBeUndefined();
    expect(
      VoiceLiveStartRequestSchema.parse({
        type: "voice.live.start.request",
        requestId: "request-1",
        negotiation: { kind: "webrtc_sdp", offerSdp: "v=0\r\n" },
        voice: "cedar",
      }).voice,
    ).toBe("cedar");
  });

  test("parses a start request carrying the user's prompt configuration", () => {
    const parsed = VoiceLiveStartRequestSchema.parse({
      type: "voice.live.start.request",
      requestId: "request-1",
      negotiation: { kind: "webrtc_sdp", offerSdp: "v=0\r\n" },
      disabledPromptComponents: ["recipes", "speech-style"],
      customVoiceInstructions: "Always answer in one sentence.",
    });

    expect(parsed.disabledPromptComponents).toEqual(["recipes", "speech-style"]);
    expect(parsed.customVoiceInstructions).toBe("Always answer in one sentence.");
  });

  test("parses a start request carrying a backend model override", () => {
    const parsed = VoiceLiveStartRequestSchema.parse({
      type: "voice.live.start.request",
      requestId: "request-1",
      negotiation: { kind: "webrtc_sdp", offerSdp: "v=0\r\n" },
      backendModel: "gpt-5.6-sol",
      backendThinkingOptionId: "high",
    });

    expect(parsed.backendModel).toBe("gpt-5.6-sol");
    expect(parsed.backendThinkingOptionId).toBe("high");
  });

  test("parses accepted and rejected start responses", () => {
    expect(
      VoiceLiveStartResponseSchema.parse({
        type: "voice.live.start.response",
        payload: {
          requestId: "request-1",
          accepted: true,
          liveSessionId: "live-1",
          negotiation: { kind: "webrtc_sdp", answerSdp: "v=0\r\n" },
        },
      }).payload.negotiation?.answerSdp,
    ).toBe("v=0\r\n");
    expect(
      VoiceLiveStartResponseSchema.parse({
        type: "voice.live.start.response",
        payload: {
          requestId: "request-1",
          accepted: false,
          errorCode: "busy",
          errorMessage: "Another client already holds this call.",
        },
      }).payload.liveSessionId,
    ).toBeUndefined();
  });

  test("accepts error codes the client does not know about", () => {
    expect(
      VoiceLiveStartResponseSchema.parse({
        type: "voice.live.start.response",
        payload: {
          requestId: "request-1",
          accepted: false,
          errorCode: "a_code_from_a_newer_daemon",
        },
      }).payload.errorCode,
    ).toBe("a_code_from_a_newer_daemon");
  });

  test("parses idempotent stop request and response", () => {
    expect(
      VoiceLiveStopRequestSchema.parse({
        type: "voice.live.stop.request",
        requestId: "request-2",
        liveSessionId: "live-1",
      }).liveSessionId,
    ).toBe("live-1");
    expect(
      VoiceLiveStopResponseSchema.parse({
        type: "voice.live.stop.response",
        payload: { requestId: "request-2" },
      }).payload.requestId,
    ).toBe("request-2");
  });

  test("parses the host-provided voice catalog", () => {
    expect(
      VoiceLiveVoicesRequestSchema.parse({
        type: "voice.live.voices.request",
        requestId: "request-3",
      }).requestId,
    ).toBe("request-3");
    expect(
      VoiceLiveVoicesResponseSchema.parse({
        type: "voice.live.voices.response",
        payload: {
          requestId: "request-3",
          voices: ["cove", "a-future-voice"],
        },
      }).payload.voices,
    ).toEqual(["cove", "a-future-voice"]);
  });

  test("parses every update event kind", () => {
    const parseEvent = (event: unknown) =>
      VoiceLiveUpdateSchema.parse({
        type: "voice.live.update",
        payload: { liveSessionId: "live-1", seq: 0, event },
      }).payload.event;

    expect(parseEvent({ kind: "started" }).kind).toBe("started");
    expect(
      parseEvent({
        kind: "transcript",
        role: "assistant",
        transcriptId: "transcript-1",
        text: "hello",
      }),
    ).toMatchObject({ role: "assistant", text: "hello" });
    expect(
      parseEvent({ kind: "error", code: "provider_realtime_error", message: "boom", fatal: true }),
    ).toMatchObject({ code: "provider_realtime_error", fatal: true });
    expect(parseEvent({ kind: "closed", cause: "requested" })).toEqual({
      kind: "closed",
      cause: "requested",
    });
    expect(parseEvent({ kind: "closed", cause: "a_cause_from_a_newer_daemon" })).toMatchObject({
      cause: "a_cause_from_a_newer_daemon",
    });
  });

  test("rejects an unknown transcript role", () => {
    expect(
      VoiceLiveUpdateSchema.safeParse({
        type: "voice.live.update",
        payload: {
          liveSessionId: "live-1",
          seq: 1,
          event: { kind: "transcript", role: "system", transcriptId: "t-1", text: "hi" },
        },
      }).success,
    ).toBe(false);
  });
});
