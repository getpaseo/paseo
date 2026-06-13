import { describe, expect, it } from "vitest";

import {
  FileTransferOpcode,
  TerminalStreamOpcode,
  TunnelCloseReason,
  TunnelStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTunnelStreamFrame,
  encodeTunnelStreamFrame,
} from "./index.js";

describe("tunnel binary frames", () => {
  const encoder = new TextEncoder();

  it("uses opcodes distinct from terminal and file-transfer families", () => {
    const others = [...Object.values(TerminalStreamOpcode), ...Object.values(FileTransferOpcode)];
    expect(others).not.toContain(TunnelStreamOpcode.Open);
    expect(others).not.toContain(TunnelStreamOpcode.Data);
    expect(others).not.toContain(TunnelStreamOpcode.Close);
  });

  it("encodes Open as opcode plus stream id prefix plus uint16 port", () => {
    const encoded = encodeTunnelStreamFrame({
      opcode: TunnelStreamOpcode.Open,
      streamId: "s-1",
      port: 5173,
    });
    const streamId = encoder.encode("s-1");

    expect(decodeTerminalStreamFrame(encoded)).toBeNull();
    expect(encoded[0]).toBe(TunnelStreamOpcode.Open);
    expect(encoded[1]).toBe(streamId.byteLength);
    expect(encoded.subarray(2, 2 + streamId.byteLength)).toEqual(streamId);
    expect(
      new DataView(encoded.buffer, encoded.byteOffset).getUint16(2 + streamId.byteLength),
    ).toBe(5173);

    expect(decodeTunnelStreamFrame(encoded)).toEqual({
      opcode: TunnelStreamOpcode.Open,
      streamId: "s-1",
      port: 5173,
    });
  });

  it("rejects out-of-range ports when encoding Open", () => {
    expect(() =>
      encodeTunnelStreamFrame({ opcode: TunnelStreamOpcode.Open, streamId: "s-1", port: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      encodeTunnelStreamFrame({ opcode: TunnelStreamOpcode.Open, streamId: "s-1", port: 70000 }),
    ).toThrow(RangeError);
  });

  it("encodes Data as opcode plus stream id prefix plus binary payload", () => {
    const payload = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const encoded = encodeTunnelStreamFrame({
      opcode: TunnelStreamOpcode.Data,
      streamId: "s-1",
      payload,
    });
    const streamId = encoder.encode("s-1");

    expect(encoded[0]).toBe(TunnelStreamOpcode.Data);
    expect(encoded[1]).toBe(streamId.byteLength);
    expect(encoded.subarray(2, 2 + streamId.byteLength)).toEqual(streamId);
    expect(encoded.subarray(2 + streamId.byteLength)).toEqual(payload);

    const decoded = decodeTunnelStreamFrame(encoded);
    expect(decoded).toEqual({ opcode: TunnelStreamOpcode.Data, streamId: "s-1", payload });
    expect(decoded?.payload).toBeInstanceOf(Uint8Array);
  });

  it("preserves an empty Data payload", () => {
    const decoded = decodeTunnelStreamFrame(
      encodeTunnelStreamFrame({ opcode: TunnelStreamOpcode.Data, streamId: "s-1" }),
    );
    expect(decoded).toEqual({
      opcode: TunnelStreamOpcode.Data,
      streamId: "s-1",
      payload: new Uint8Array(),
    });
  });

  it("encodes Close with a reason byte and round-trips it", () => {
    const encoded = encodeTunnelStreamFrame({
      opcode: TunnelStreamOpcode.Close,
      streamId: "s-9",
      reason: TunnelCloseReason.ConnectFailed,
    });
    const streamId = encoder.encode("s-9");

    expect(encoded).toEqual(
      new Uint8Array([
        TunnelStreamOpcode.Close,
        streamId.byteLength,
        ...streamId,
        TunnelCloseReason.ConnectFailed,
      ]),
    );
    expect(decodeTunnelStreamFrame(encoded)).toEqual({
      opcode: TunnelStreamOpcode.Close,
      streamId: "s-9",
      reason: TunnelCloseReason.ConnectFailed,
    });
  });

  it("defaults Close reason to Normal when the body is empty", () => {
    const streamId = encoder.encode("s-9");
    const emptyClose = new Uint8Array([TunnelStreamOpcode.Close, streamId.byteLength, ...streamId]);
    expect(decodeTunnelStreamFrame(emptyClose)).toEqual({
      opcode: TunnelStreamOpcode.Close,
      streamId: "s-9",
      reason: TunnelCloseReason.Normal,
    });
  });

  it("rejects empty stream ids when encoding", () => {
    expect(() =>
      encodeTunnelStreamFrame({ opcode: TunnelStreamOpcode.Data, streamId: "" }),
    ).toThrow(RangeError);
  });

  it("rejects malformed stream id prefixes and bad bodies", () => {
    expect(decodeTunnelStreamFrame(new Uint8Array([TunnelStreamOpcode.Data, 0]))).toBeNull();
    expect(decodeTunnelStreamFrame(new Uint8Array([TunnelStreamOpcode.Data, 6, 1]))).toBeNull();

    const streamId = encoder.encode("s-1");
    // Open with a 1-byte (not 2-byte) port body is invalid.
    expect(
      decodeTunnelStreamFrame(
        new Uint8Array([TunnelStreamOpcode.Open, streamId.byteLength, ...streamId, 9]),
      ),
    ).toBeNull();
    // Close with a >1-byte body is invalid.
    expect(
      decodeTunnelStreamFrame(
        new Uint8Array([TunnelStreamOpcode.Close, streamId.byteLength, ...streamId, 0, 0]),
      ),
    ).toBeNull();
  });
});
