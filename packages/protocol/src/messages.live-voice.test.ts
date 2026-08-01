import { describe, expect, test } from "vitest";
import {
  ServerInfoStatusPayloadSchema,
  VoiceLiveStartRequestSchema,
  VoiceLiveStartResponseSchema,
  VoiceLiveStopRequestSchema,
  VoiceLiveStopResponseSchema,
  VoiceLiveUpdateSchema,
} from "./messages.js";

describe("live voice messages", () => {
  test("keeps the capability optional for older server info payloads", () => {
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "server-1",
        features: {},
      }).features?.liveVoice,
    ).toBeUndefined();
  });

  test("parses a start request with and without an explicit voice", () => {
    expect(
      VoiceLiveStartRequestSchema.parse({
        type: "voice.live.start.request",
        requestId: "request-1",
        offerSdp: "v=0\r\n",
      }).voice,
    ).toBeUndefined();
    expect(
      VoiceLiveStartRequestSchema.parse({
        type: "voice.live.start.request",
        requestId: "request-1",
        offerSdp: "v=0\r\n",
        voice: "cedar",
      }).voice,
    ).toBe("cedar");
  });

  test("parses accepted and rejected start responses", () => {
    expect(
      VoiceLiveStartResponseSchema.parse({
        type: "voice.live.start.response",
        payload: {
          requestId: "request-1",
          accepted: true,
          liveSessionId: "live-1",
          answerSdp: "v=0\r\n",
        },
      }).payload.answerSdp,
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
      parseEvent({ kind: "error", code: "codex_error", message: "boom", fatal: true }),
    ).toMatchObject({ code: "codex_error", fatal: true });
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
