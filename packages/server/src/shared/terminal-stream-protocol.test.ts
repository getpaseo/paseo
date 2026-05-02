import { describe, expect, it } from "vitest";

import * as terminalBinaryFrames from "./binary-frames/index.js";
import * as legacyTerminalStreamProtocol from "./terminal-stream-protocol.js";

describe("terminal stream protocol", () => {
  it("keeps the old import path compatible with terminal binary frames", () => {
    expect(legacyTerminalStreamProtocol.TerminalStreamOpcode).toBe(
      terminalBinaryFrames.TerminalStreamOpcode,
    );
    expect(legacyTerminalStreamProtocol.encodeTerminalStreamFrame).toBe(
      terminalBinaryFrames.encodeTerminalStreamFrame,
    );
    expect(legacyTerminalStreamProtocol.decodeTerminalStreamFrame).toBe(
      terminalBinaryFrames.decodeTerminalStreamFrame,
    );

    const payload = new TextEncoder().encode("hello");
    const encoded = legacyTerminalStreamProtocol.encodeTerminalStreamFrame({
      opcode: legacyTerminalStreamProtocol.TerminalStreamOpcode.Output,
      slot: 7,
      payload,
    });

    expect(encoded[0]).toBe(terminalBinaryFrames.TerminalStreamOpcode.Output);
    expect(encoded[1]).toBe(7);
    expect(Array.from(encoded.subarray(2))).toEqual(Array.from(payload));

    const decoded = terminalBinaryFrames.decodeTerminalStreamFrame(encoded);
    expect(decoded).toEqual({
      opcode: legacyTerminalStreamProtocol.TerminalStreamOpcode.Output,
      slot: 7,
      payload,
    });
  });
});
