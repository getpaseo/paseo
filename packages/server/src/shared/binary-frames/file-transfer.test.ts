import { describe, expect, it } from "vitest";

import {
  FileTransferOpcode,
  TerminalStreamOpcode,
  decodeFileTransferFrame,
  decodeTerminalStreamFrame,
  encodeFileTransferFrame,
} from "./index.js";

describe("file transfer binary frames", () => {
  const encoder = new TextEncoder();

  it("uses non-terminal opcodes", () => {
    expect(Object.values(TerminalStreamOpcode)).not.toContain(FileTransferOpcode.FileBegin);
    expect(Object.values(TerminalStreamOpcode)).not.toContain(FileTransferOpcode.FileChunk);
    expect(Object.values(TerminalStreamOpcode)).not.toContain(FileTransferOpcode.FileEnd);
  });

  it("encodes FileBegin as opcode plus request id prefix plus JSON metadata", () => {
    const encoded = encodeFileTransferFrame({
      opcode: FileTransferOpcode.FileBegin,
      requestId: "req-1",
      metadata: {
        mime: "image/png",
        size: 6,
        encoding: "binary",
        modifiedAt: "2026-05-02T00:00:00.000Z",
      },
    });
    const requestId = encoder.encode("req-1");
    const metadata = encoder.encode(
      JSON.stringify({
        mime: "image/png",
        size: 6,
        encoding: "binary",
        modifiedAt: "2026-05-02T00:00:00.000Z",
      }),
    );

    expect(decodeTerminalStreamFrame(encoded)).toBeNull();
    expect(encoded[0]).toBe(FileTransferOpcode.FileBegin);
    expect(encoded[1]).toBe(requestId.byteLength);
    expect(encoded.subarray(2, 2 + requestId.byteLength)).toEqual(requestId);
    expect(
      new DataView(encoded.buffer, encoded.byteOffset).getUint16(2 + requestId.byteLength),
    ).toBe(metadata.byteLength);
    expect(encoded.subarray(4 + requestId.byteLength)).toEqual(metadata);

    expect(decodeFileTransferFrame(encoded)).toEqual({
      opcode: FileTransferOpcode.FileBegin,
      requestId: "req-1",
      metadata: {
        mime: "image/png",
        size: 6,
        encoding: "binary",
        modifiedAt: "2026-05-02T00:00:00.000Z",
      },
      payload: new Uint8Array(),
    });
  });

  it("encodes FileChunk as opcode plus request id prefix plus binary payload", () => {
    const payload = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const encoded = encodeFileTransferFrame({
      opcode: FileTransferOpcode.FileChunk,
      requestId: "req-1",
      payload,
    });
    const requestId = encoder.encode("req-1");

    expect(encoded[0]).toBe(FileTransferOpcode.FileChunk);
    expect(encoded[1]).toBe(requestId.byteLength);
    expect(encoded.subarray(2, 2 + requestId.byteLength)).toEqual(requestId);
    expect(encoded.subarray(2 + requestId.byteLength)).toEqual(payload);
    const decoded = decodeFileTransferFrame(encoded);

    expect(decoded).toEqual({
      opcode: FileTransferOpcode.FileChunk,
      requestId: "req-1",
      payload,
    });
    expect(decoded?.payload).toBeInstanceOf(Uint8Array);
    expect(decoded?.payload).toEqual(payload);
  });

  it("encodes FileEnd as opcode plus request id prefix only", () => {
    const encoded = encodeFileTransferFrame({
      opcode: FileTransferOpcode.FileEnd,
      requestId: "req-1",
    });
    const requestId = encoder.encode("req-1");

    expect(encoded).toEqual(
      new Uint8Array([FileTransferOpcode.FileEnd, requestId.byteLength, ...requestId]),
    );

    expect(decodeFileTransferFrame(encoded)).toEqual({
      opcode: FileTransferOpcode.FileEnd,
      requestId: "req-1",
      payload: new Uint8Array(),
    });
  });

  it("rejects malformed metadata and unknown metadata fields", () => {
    expect(
      decodeFileTransferFrame(
        encodeFileTransferFrame({
          opcode: FileTransferOpcode.FileBegin,
          requestId: "req-1",
          metadata: {
            mime: "image/png",
            size: -1,
            encoding: "binary",
            modifiedAt: "2026-05-02T00:00:00.000Z",
          },
        }),
      ),
    ).toBeNull();

    const json = encoder.encode(
      JSON.stringify({
        mime: "image/png",
        size: 1,
        encoding: "binary",
        modifiedAt: "2026-05-02T00:00:00.000Z",
        extra: true,
      }),
    );
    const requestId = encoder.encode("req-1");
    const encoded = new Uint8Array(4 + requestId.byteLength + json.byteLength);
    encoded[0] = FileTransferOpcode.FileBegin;
    encoded[1] = requestId.byteLength;
    encoded.set(requestId, 2);
    new DataView(encoded.buffer).setUint16(2 + requestId.byteLength, json.byteLength);
    encoded.set(json, 4 + requestId.byteLength);

    expect(decodeFileTransferFrame(encoded)).toBeNull();
  });

  it("rejects malformed request id prefixes and frame tails", () => {
    expect(decodeFileTransferFrame(new Uint8Array([FileTransferOpcode.FileEnd, 0]))).toBeNull();
    expect(decodeFileTransferFrame(new Uint8Array([FileTransferOpcode.FileEnd, 6, 1]))).toBeNull();

    const requestId = encoder.encode("req-1");
    const encoded = new Uint8Array([
      FileTransferOpcode.FileEnd,
      requestId.byteLength,
      ...requestId,
      1,
    ]);
    expect(decodeFileTransferFrame(encoded)).toBeNull();
  });
});
