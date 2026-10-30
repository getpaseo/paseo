import { describe, expect, test } from "vitest";
import { decodeFrame, encodeError, encodeRequest, encodeResponse } from "./wire.js";

describe("ZCode frame decoding", () => {
  test("keeps an event that carries an unknown field", () => {
    const frame = decodeFrame(
      JSON.stringify({
        eventId: "e1",
        sessionId: "s1",
        seq: 3,
        timestamp: 1_700_000_000_000,
        type: "message.upserted",
        payload: { content: "hello" },
        futureField: { anything: true },
      }),
    );
    expect(frame).toMatchObject({ type: "message.upserted", sessionId: "s1", seq: 3 });
    expect(frame).not.toHaveProperty("futureField");
  });

  test("ignores an event type it does not know", () => {
    const frame = decodeFrame(
      JSON.stringify({
        eventId: "e2",
        sessionId: "s1",
        seq: 4,
        timestamp: 1_700_000_000_000,
        type: "some.future.event",
        payload: {},
      }),
    );
    expect(frame).toBeUndefined();
  });

  test("returns undefined for a broken frame instead of throwing", () => {
    expect(decodeFrame("{not json")).toBeUndefined();
    expect(decodeFrame(JSON.stringify({ id: "1" }))).toBeUndefined();
  });

  test("decodes a response and a protocol error", () => {
    expect(decodeFrame(JSON.stringify({ id: "1", result: { ok: true } }))).toMatchObject({
      kind: "response",
      id: "1",
    });
    const failure = decodeFrame(
      JSON.stringify({ id: "2", error: { code: -32000, message: "boom" } }),
    );
    expect(failure).toMatchObject({ kind: "error", id: "2" });
  });

  test("recognises a request ZCode sends to the host", () => {
    const frame = decodeFrame(
      JSON.stringify({
        id: "9",
        method: "interaction/requestPermission",
        params: { requestId: "p1" },
      }),
    );
    expect(frame).toEqual({
      kind: "request",
      id: "9",
      method: "interaction/requestPermission",
      params: { requestId: "p1" },
    });
  });

  test("encodes a request without a jsonrpc field", () => {
    const line = encodeRequest("7", "session/send", { sessionId: "s1", content: "hi" });
    expect(JSON.parse(line)).toEqual({
      id: "7",
      method: "session/send",
      params: { sessionId: "s1", content: "hi" },
    });
  });

  test("encodes the answer to a reverse request", () => {
    expect(JSON.parse(encodeResponse("9", { decision: "allow" }))).toEqual({
      id: "9",
      result: { decision: "allow" },
    });
    expect(JSON.parse(encodeError("9", -32601, "Unknown method"))).toEqual({
      id: "9",
      error: { code: -32601, message: "Unknown method" },
    });
  });
});
