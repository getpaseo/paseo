import { TerminalStreamOpcode } from "@getpaseo/protocol/binary-frames/index";
import { describe, expect, test } from "vitest";

import { TerminalStreamRouter, type TerminalStreamEvent } from "./terminal-stream-router.js";

describe("terminal-stream-router", () => {
  test("routes restore frames as restore events", () => {
    const router = new TerminalStreamRouter();
    const events: TerminalStreamEvent[] = [];
    const payload = new TextEncoder().encode("restored screen");

    router.setSlot("term-1", 7);
    router.onEvent((event) => events.push(event));
    router.handleFrame({
      opcode: TerminalStreamOpcode.Restore,
      slot: 7,
      payload,
    });

    expect(events).toEqual([
      {
        terminalId: "term-1",
        type: "restore",
        data: payload,
      },
    ]);
  });
});
