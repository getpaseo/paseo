import { describe, expect, it } from "vitest";

import {
  BrowserScreencastOpcode,
  decodeBinaryFrame,
  encodeBrowserScreencastAck,
  encodeBrowserScreencastFrame,
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

  it("routes browser screencast frames and acks by opcode", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    expect(
      decodeBinaryFrame(
        encodeBrowserScreencastFrame({
          slot: 3,
          sequence: 70_000,
          width: 1440,
          height: 900,
          payload: jpeg,
        }),
      ),
    ).toEqual({
      kind: "browser_screencast",
      frame: {
        opcode: BrowserScreencastOpcode.Frame,
        slot: 3,
        sequence: 70_000,
        width: 1440,
        height: 900,
        payload: jpeg,
      },
    });
    expect(decodeBinaryFrame(encodeBrowserScreencastAck({ slot: 3, sequence: 70_000 }))).toEqual({
      kind: "browser_screencast",
      frame: { opcode: BrowserScreencastOpcode.Ack, slot: 3, sequence: 70_000 },
    });
  });

  it("rejects truncated browser screencast frames", () => {
    const frame = encodeBrowserScreencastFrame({
      slot: 0,
      sequence: 1,
      width: 10,
      height: 10,
      payload: new Uint8Array([1]),
    });
    expect(decodeBinaryFrame(frame.subarray(0, 10))).toBeNull();
    expect(
      decodeBinaryFrame(encodeBrowserScreencastAck({ slot: 0, sequence: 1 }).subarray(0, 5)),
    ).toBeNull();
  });

  it("rejects unknown binary opcodes", () => {
    expect(decodeBinaryFrame(new Uint8Array([0xff, 0]))).toBeNull();
  });
});
