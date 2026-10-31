import { TerminalStreamOpcode } from "@getpaseo/protocol/binary-frames/index";
import { describe, expect, test } from "vitest";

import { TerminalStreamRouter, type TerminalStreamEvent } from "./terminal-stream-router.js";

describe("terminal-stream-router", () => {
  test("normalizes old ANSI restore into the replay lifecycle", () => {
    const router = new TerminalStreamRouter();
    const events: TerminalStreamEvent[] = [];
    const payload = new TextEncoder().encode("restored screen");

    router.attach("subscription-1", "term-1", 7, (event) => events.push(event));
    router.handleFrame({
      opcode: TerminalStreamOpcode.Restore,
      slot: 7,
      payload,
    });

    expect(events).toEqual(
      ["begin", "data", "end"].map((type) => ({
        terminalId: "term-1",
        subscriptionId: "subscription-1",
        type: "replay",
        replay: type === "data" ? { type, data: payload } : { type },
      })),
    );
  });
});

test("two registrations for one terminal retain independent slots and release", () => {
  const router = new TerminalStreamRouter();
  const a: TerminalStreamEvent[] = [];
  const b: TerminalStreamEvent[] = [];
  const releaseA = router.attach("subscription-a", "same-terminal", 1, (event) => a.push(event));
  router.attach("subscription-b", "same-terminal", 2, (event) => b.push(event));
  const payload = new TextEncoder().encode("output");
  router.handleFrame({ opcode: TerminalStreamOpcode.Output, slot: 1, payload });
  router.handleFrame({ opcode: TerminalStreamOpcode.Output, slot: 2, payload });
  expect(a).toEqual([expect.objectContaining({ subscriptionId: "subscription-a" })]);
  expect(b).toEqual([expect.objectContaining({ subscriptionId: "subscription-b" })]);
  releaseA();
  router.handleFrame({ opcode: TerminalStreamOpcode.Output, slot: 1, payload });
  router.handleFrame({ opcode: TerminalStreamOpcode.Output, slot: 2, payload });
  expect(a).toHaveLength(1);
  expect(b).toHaveLength(2);
});

test("legacy listeners share a terminal slot without releasing each other", () => {
  const router = new TerminalStreamRouter();
  const received: string[] = [];
  const release = router.attach("first", "terminal", 1, () => received.push("first"));
  router.attach("second", "terminal", 1, () => received.push("second"));
  const frame = {
    opcode: TerminalStreamOpcode.Output,
    slot: 1,
    payload: new TextEncoder().encode("bytes"),
  };
  router.handleFrame(frame);
  expect(received).toEqual(["first", "second"]);
  release();
  router.handleFrame(frame);
  expect(received).toEqual(["first", "second", "second"]);
});

test("streams chunks without joining and ignores released slots during replay", () => {
  const router = new TerminalStreamRouter();
  const events: TerminalStreamEvent[] = [];
  const release = router.attach("old", "terminal", 4, (event) => events.push(event));
  const payload = new TextEncoder().encode(
    JSON.stringify({ rows: 24, cols: 80, retainedHistoryLines: 1000 }),
  );
  router.handleFrame({ opcode: TerminalStreamOpcode.ReplayBegin, slot: 4, payload });
  const data = new TextEncoder().encode("\x1b[31m界🙂");
  router.handleFrame({
    opcode: TerminalStreamOpcode.ReplayData,
    slot: 4,
    payload: data.subarray(0, 7),
  });
  release();
  router.attach("new", "terminal", 5, (event) => events.push(event));
  router.handleFrame({
    opcode: TerminalStreamOpcode.ReplayData,
    slot: 4,
    payload: data.subarray(7),
  });
  router.handleFrame({
    opcode: TerminalStreamOpcode.ReplayEnd,
    slot: 4,
    payload: new Uint8Array(),
  });
  expect(events).toHaveLength(2);
  expect(events[1]).toMatchObject({
    subscriptionId: "old",
    type: "replay",
    replay: { type: "data", data: data.subarray(0, 7) },
  });
  router.handleFrame({ opcode: TerminalStreamOpcode.ReplayBegin, slot: 5, payload });
  router.handleFrame({ opcode: TerminalStreamOpcode.ReplayData, slot: 5, payload: data });
  router.handleFrame({
    opcode: TerminalStreamOpcode.ReplayEnd,
    slot: 5,
    payload: new Uint8Array(),
  });
  expect(events.slice(2).map((event) => event.subscriptionId)).toEqual(["new", "new", "new"]);
});
