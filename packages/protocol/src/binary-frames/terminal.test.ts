import { describe, expect, it } from "vitest";

import {
  TerminalStreamOpcode,
  decodeTerminalResizePayload,
  decodeTerminalSnapshotPayload,
  decodeTerminalStreamFrame,
  encodeTerminalResizePayload,
  encodeTerminalSnapshotPayload,
  encodeTerminalStreamFrame,
} from "./index.js";

describe("terminal binary frames", () => {
  it("encodes output frames as opcode plus slot plus payload", () => {
    const payload = new TextEncoder().encode("hello");
    const encoded = encodeTerminalStreamFrame({
      opcode: TerminalStreamOpcode.Output,
      slot: 7,
      payload,
    });

    expect(encoded[0]).toBe(TerminalStreamOpcode.Output);
    expect(encoded[1]).toBe(7);
    expect(Array.from(encoded.subarray(2))).toEqual(Array.from(payload));

    const decoded = decodeTerminalStreamFrame(encoded);
    expect(decoded).toEqual({
      opcode: TerminalStreamOpcode.Output,
      slot: 7,
      payload,
    });
  });

  it("round-trips resize payloads", () => {
    const payload = encodeTerminalResizePayload({
      rows: 24,
      cols: 80,
    });

    expect(decodeTerminalResizePayload(payload)).toEqual({
      rows: 24,
      cols: 80,
    });
  });

  it("round-trips snapshot payloads", () => {
    const state = {
      rows: 1,
      cols: 2,
      grid: [[{ char: "A" }, { char: "B" }]],
      scrollback: [],
      cursor: { row: 0, col: 2 },
    };

    const payload = encodeTerminalSnapshotPayload(state);
    expect(decodeTerminalSnapshotPayload(payload)).toEqual(state);
  });

  it("rejects unknown opcodes", () => {
    expect(decodeTerminalStreamFrame(new Uint8Array([0xff, 0x01, 0x02]))).toBeNull();
  });

  it("rejects frames without a slot byte", () => {
    expect(decodeTerminalStreamFrame(new Uint8Array([TerminalStreamOpcode.Output]))).toBeNull();
  });

  it("rejects malformed JSON payloads", () => {
    const malformed = new TextEncoder().encode("{");

    expect(decodeTerminalResizePayload(malformed)).toBeNull();
    expect(decodeTerminalSnapshotPayload(malformed)).toBeNull();
  });

  it("rejects invalid resize and snapshot shapes", () => {
    expect(
      decodeTerminalResizePayload(
        new TextEncoder().encode(JSON.stringify({ rows: "24", cols: 80 })),
      ),
    ).toBeNull();
    expect(
      decodeTerminalSnapshotPayload(
        new TextEncoder().encode(
          JSON.stringify({
            rows: 1,
            cols: 1,
            grid: [[{ char: "A" }]],
            scrollback: [],
          }),
        ),
      ),
    ).toBeNull();
  });

  it("rejects unknown fields in resize and snapshot payloads", () => {
    expect(
      decodeTerminalResizePayload(
        new TextEncoder().encode(JSON.stringify({ rows: 24, cols: 80, extra: true })),
      ),
    ).toBeNull();
    expect(
      decodeTerminalSnapshotPayload(
        new TextEncoder().encode(
          JSON.stringify({
            rows: 1,
            cols: 1,
            grid: [[{ char: "A", extra: true }]],
            scrollback: [],
            cursor: { row: 0, col: 1 },
          }),
        ),
      ),
    ).toBeNull();
  });
});
