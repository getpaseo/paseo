import { describe, expect, it } from "vitest";

import {
  decodeBinaryFrame,
  encodeFileTransferFrame,
  encodeTerminalStreamFrame,
  FileTransferOpcode,
  TerminalStreamOpcode,
  encodeTunnelFrame,
  TunnelOpcode,
  type TunnelFrame,
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

  it.each<TunnelFrame>([
    {
      opcode: TunnelOpcode.Open,
      subscriptionId: "s",
      streamId: "t",
      target: { atyp: 3, address: "localhost", port: 80 },
    },
    { opcode: TunnelOpcode.Connected, subscriptionId: "s", streamId: "t" },
    { opcode: TunnelOpcode.Data, subscriptionId: "s", streamId: "t", payload: new Uint8Array([1]) },
    { opcode: TunnelOpcode.Close, subscriptionId: "s", streamId: "t", reason: 0 },
    { opcode: TunnelOpcode.WindowUpdate, subscriptionId: "s", streamId: "t", credit: 1 },
  ])("routes tunnel opcode $opcode", (frame) => {
    expect(decodeBinaryFrame(encodeTunnelFrame(frame))).toEqual({ kind: "tunnel", frame });
  });

  it.each([0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x2f])(
    "rejects malformed or reserved tunnel opcode %i",
    (opcode) => {
      expect(decodeBinaryFrame(new Uint8Array([opcode, 0]))).toBeNull();
    },
  );

  it("rejects unknown binary opcodes", () => {
    expect(decodeBinaryFrame(new Uint8Array([0xff, 0]))).toBeNull();
  });
});
