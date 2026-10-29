import { describe, expect, it } from "vitest";

import {
  decodeBinaryFrame,
  encodeHostRouteFrame,
  decodeHostRouteFrame,
  MAX_HOST_ROUTE_ID_BYTES,
  encodeFileTransferFrame,
  encodeTerminalStreamFrame,
  FileTransferOpcode,
  TerminalStreamOpcode,
} from "./index.js";

describe("binary frame demux", () => {
  it("routes terminal frames by opcode", () => {
    expect(
      decodeBinaryFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Input,
          slot: 7,
          payload: "ls",
        }),
      ),
    ).toEqual({
      kind: "terminal",
      frame: {
        opcode: TerminalStreamOpcode.Input,
        slot: 7,
        payload: new TextEncoder().encode("ls"),
      },
    });
  });

  it("routes file-transfer frames by opcode", () => {
    expect(
      decodeBinaryFrame(
        encodeFileTransferFrame({
          opcode: FileTransferOpcode.FileChunk,
          requestId: "req-upload",
          payload: new TextEncoder().encode("hello"),
        }),
      ),
    ).toEqual({
      kind: "file_transfer",
      frame: {
        opcode: FileTransferOpcode.FileChunk,
        requestId: "req-upload",
        payload: new TextEncoder().encode("hello"),
      },
    });
  });

  it("rejects unknown binary opcodes", () => {
    expect(decodeBinaryFrame(new Uint8Array([0xff, 0]))).toBeNull();
  });
});

describe("host route binary framing", () => {
  it("wraps terminal and file frames unchanged and leaves their direct interpretation intact", () => {
    const frames = [
      encodeTerminalStreamFrame({ opcode: TerminalStreamOpcode.Input, slot: 7, payload: "echo" }),
      encodeFileTransferFrame({
        opcode: FileTransferOpcode.FileChunk,
        requestId: "upload",
        payload: new Uint8Array([0, 255, 128, 1]),
      }),
    ];
    for (const payload of frames) {
      const wire = encodeHostRouteFrame("channel", payload);
      const decoded = decodeBinaryFrame(wire);
      expect(decoded).toEqual({ kind: "host_route", frame: { routeId: "channel", payload } });
      expect(wire.subarray(10)).toEqual(payload);
      expect(decodeBinaryFrame(decodeHostRouteFrame(wire)!.payload)).toEqual(
        decodeBinaryFrame(payload),
      );
    }
  });
  it("rejects truncated, oversized identifiers and invalid UTF-8 without throwing", () => {
    for (const bytes of [
      new Uint8Array([0x30]),
      new Uint8Array([0x30, 0, 4, 65]),
      new Uint8Array([0x30, 0, 0]),
      new Uint8Array([0x30, 1, 1]),
      new Uint8Array([0x30, 0, 1, 255]),
    ])
      expect(decodeBinaryFrame(bytes)).toBeNull();
    expect(() =>
      encodeHostRouteFrame("a".repeat(MAX_HOST_ROUTE_ID_BYTES + 1), new Uint8Array()),
    ).toThrow("Invalid host route ID");
  });
});
