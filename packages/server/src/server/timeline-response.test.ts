import { expect, test } from "vitest";
import { base64EncryptedWireByteLength } from "@getpaseo/relay";
import {
  wrapSessionMessage,
  type FetchAgentTimelineResponseMessage,
} from "@getpaseo/protocol/messages";
import { boundTimelineResponse } from "./timeline-response.js";
import { MAX_RELAY_PAYLOAD_BYTES } from "./websocket/relay-payload.js";

function response(
  direction: "tail" | "before" | "after",
  text: string,
): FetchAgentTimelineResponseMessage {
  return {
    type: "fetch_agent_timeline_response",
    payload: {
      requestId: "request",
      agentId: "agent",
      agent: null,
      direction,
      projection: "projected",
      epoch: "epoch",
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 1, maxSeq: 3, nextSeq: 4 },
      startCursor: { epoch: "epoch", seq: 1 },
      endCursor: { epoch: "epoch", seq: 3 },
      hasOlder: false,
      hasNewer: false,
      error: null,
      entries: [1, 2, 3].map((seq) => ({
        provider: "codex",
        item: { type: "assistant_message", text },
        timestamp: "2026-01-01T00:00:00.000Z",
        seqStart: seq,
        seqEnd: seq,
        sourceSeqRanges: [{ startSeq: seq, endSeq: seq }],
        collapsed: [],
      })),
    },
  };
}

function selectPage(
  message: FetchAgentTimelineResponseMessage,
  limit: number,
): FetchAgentTimelineResponseMessage {
  const payload = message.payload;
  const entries =
    payload.direction === "after" ? payload.entries.slice(0, limit) : payload.entries.slice(-limit);
  return {
    ...message,
    payload: {
      ...payload,
      entries,
      startCursor: { epoch: payload.epoch, seq: entries[0].seqStart },
      endCursor: { epoch: payload.epoch, seq: entries[entries.length - 1].seqEnd },
      hasOlder: payload.direction !== "after" && entries.length < payload.entries.length,
      hasNewer: payload.direction === "after" && entries.length < payload.entries.length,
    },
  };
}

test("ordinary timeline pages preserve their cursors and flags", () => {
  const message = response("tail", "small");
  expect(boundTimelineResponse(message, (limit) => selectPage(message, limit))).toEqual(message);
});

test.each(["tail", "before", "after"] as const)(
  "%s pages stay within the encrypted relay limit",
  (direction) => {
    const message = response(direction, "x".repeat(9 * 1024 * 1024));
    const bounded = boundTimelineResponse(message, (limit) => selectPage(message, limit));
    const expectedSeqs = direction === "after" ? [1, 2] : [2, 3];

    expect(bounded.payload.entries.map((entry) => entry.seqEnd)).toEqual(expectedSeqs);
    expect(bounded.payload.startCursor).toEqual({ epoch: "epoch", seq: expectedSeqs[0] });
    expect(bounded.payload.endCursor).toEqual({ epoch: "epoch", seq: expectedSeqs[1] });
    expect(bounded.payload.hasOlder).toBe(direction !== "after");
    expect(bounded.payload.hasNewer).toBe(direction === "after");
    expect(bounded.payload.window).toEqual(message.payload.window);
    expect(
      base64EncryptedWireByteLength(Buffer.byteLength(JSON.stringify(wrapSessionMessage(bounded)))),
    ).toBeLessThanOrEqual(MAX_RELAY_PAYLOAD_BYTES);
    expect(message.payload.entries).toHaveLength(3);
  },
);

test("Unicode and JSON escaping count as wire bytes rather than characters", () => {
  const message = response("after", "\u0000日".repeat(1024 * 1024));
  const bounded = boundTimelineResponse(message, (limit) => selectPage(message, limit));
  expect(bounded.payload.entries).toHaveLength(2);
  expect(
    base64EncryptedWireByteLength(Buffer.byteLength(JSON.stringify(wrapSessionMessage(bounded)))),
  ).toBeLessThanOrEqual(MAX_RELAY_PAYLOAD_BYTES);
});

test("one oversized item fails explicitly without advancing a cursor or truncating content", () => {
  const message = response("after", "x".repeat(24 * 1024 * 1024));
  expect(() => boundTimelineResponse(message, (limit) => selectPage(message, limit))).toThrow(
    "relay payload limit",
  );
  expect(message.payload.endCursor).toEqual({ epoch: "epoch", seq: 3 });
  expect(message.payload.entries[0].item).toEqual({
    type: "assistant_message",
    text: "x".repeat(24 * 1024 * 1024),
  });
});
