import { TerminalStreamOpcode } from "@getpaseo/protocol/binary-frames/index";
import { describe, expect, test } from "vitest";

import { TerminalStreamRouter, type TerminalStreamEvent } from "./terminal-stream-router.js";

describe("terminal-stream-router", () => {
  test("routes restore frames as restore events", () => {
    const router = new TerminalStreamRouter();
    const events: TerminalStreamEvent[] = [];
    const payload = new TextEncoder().encode("restored screen");

    router.attach("subscription-1", "term-1", 7, (event) => events.push(event));
    router.handleFrame({
      opcode: TerminalStreamOpcode.Restore,
      slot: 7,
      payload,
    });

    expect(events).toEqual([
      {
        terminalId: "term-1",
        subscriptionId: "subscription-1",
        type: "restore",
        data: payload,
      },
    ]);
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
