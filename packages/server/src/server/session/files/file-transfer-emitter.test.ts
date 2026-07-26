import { describe, expect, test } from "vitest";
import {
  decodeFileTransferFrame,
  FileTransferOpcode,
} from "@getpaseo/protocol/binary-frames/index";
import { emitChunkedFileTransfer, type FileTransferSink } from "./file-transfer-emitter.js";
import type { FileExplorerFileBytes } from "../../file-explorer/service.js";

function makeFile(bytes: Uint8Array): FileExplorerFileBytes {
  return {
    path: "doc.pdf",
    kind: "binary",
    encoding: "binary",
    bytes,
    mimeType: "application/pdf",
    size: bytes.byteLength,
    modifiedAt: "2026-07-26T00:00:00.000Z",
    revision: "rev-1",
  };
}

function bytesOfLength(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = index % 256;
  }
  return bytes;
}

interface Recorder {
  sink: FileTransferSink;
  frames: Uint8Array[];
  opcodes: () => number[];
  payload: () => Uint8Array;
}

function makeRecorder(options: {
  bufferedAmounts?: (number | null)[];
  disposeAfterChunks?: number;
}): Recorder {
  const frames: Uint8Array[] = [];
  const bufferedAmounts = options.bufferedAmounts ?? [];
  let bufferedIndex = 0;
  let disposed = false;

  const sink: FileTransferSink = {
    emitBinary: (frame) => {
      frames.push(frame);
      const chunkCount = frames.filter(
        (candidate) => decodeFileTransferFrame(candidate)?.opcode === FileTransferOpcode.FileChunk,
      ).length;
      if (options.disposeAfterChunks !== undefined && chunkCount >= options.disposeAfterChunks) {
        disposed = true;
      }
    },
    getClientBufferedAmount: () => {
      if (bufferedAmounts.length === 0) return 0;
      const value = bufferedAmounts[Math.min(bufferedIndex, bufferedAmounts.length - 1)];
      bufferedIndex += 1;
      return value;
    },
    isDisposed: () => disposed,
  };

  return {
    sink,
    frames,
    opcodes: () =>
      frames.map((frame) => {
        const decoded = decodeFileTransferFrame(frame);
        if (!decoded) throw new Error("undecodable frame");
        return decoded.opcode;
      }),
    payload: () => {
      const chunks: Uint8Array[] = [];
      for (const frame of frames) {
        const decoded = decodeFileTransferFrame(frame);
        if (decoded?.opcode === FileTransferOpcode.FileChunk) chunks.push(decoded.payload);
      }
      const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return merged;
    },
  };
}

/** A clock that only moves when the transfer sleeps, so waits are deterministic. */
function makeClock() {
  let current = 0;
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
    },
  };
}

describe("emitChunkedFileTransfer", () => {
  test("splits the payload into chunk-sized frames bracketed by begin and end", async () => {
    const bytes = bytesOfLength(2500);
    const recorder = makeRecorder({});
    const clock = makeClock();

    const outcome = await emitChunkedFileTransfer({
      sink: recorder.sink,
      requestId: "req-1",
      file: makeFile(bytes),
      chunkBytes: 1000,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(outcome).toEqual({ status: "sent", chunks: 3 });
    expect(recorder.opcodes()).toEqual([
      FileTransferOpcode.FileBegin,
      FileTransferOpcode.FileChunk,
      FileTransferOpcode.FileChunk,
      FileTransferOpcode.FileChunk,
      FileTransferOpcode.FileEnd,
    ]);
    expect(recorder.payload()).toEqual(bytes);
  });

  test("carries the file mime and byte length in the begin metadata", async () => {
    const bytes = bytesOfLength(64);
    const recorder = makeRecorder({});

    await emitChunkedFileTransfer({
      sink: recorder.sink,
      requestId: "req-2",
      file: makeFile(bytes),
    });

    const begin = decodeFileTransferFrame(recorder.frames[0]);
    if (begin?.opcode !== FileTransferOpcode.FileBegin) {
      throw new Error("expected a FileBegin frame");
    }
    expect(begin.metadata.mime).toBe("application/pdf");
    expect(begin.metadata.size).toBe(64);
  });

  test("waits for a backed-up client to drain before sending the next chunk", async () => {
    const bytes = bytesOfLength(3000);
    // Over the threshold for the first two polls, then drained.
    const recorder = makeRecorder({ bufferedAmounts: [9_000_000, 9_000_000, 0] });
    const clock = makeClock();

    const outcome = await emitChunkedFileTransfer({
      sink: recorder.sink,
      requestId: "req-3",
      file: makeFile(bytes),
      chunkBytes: 1000,
      drainThresholdBytes: 4_000_000,
      drainPollMs: 10,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(outcome).toEqual({ status: "sent", chunks: 3 });
    expect(clock.now()).toBe(20);
    expect(recorder.payload()).toEqual(bytes);
  });

  test("aborts as stalled and withholds FileEnd when the client never drains", async () => {
    const recorder = makeRecorder({ bufferedAmounts: [9_000_000] });
    const clock = makeClock();

    const outcome = await emitChunkedFileTransfer({
      sink: recorder.sink,
      requestId: "req-4",
      file: makeFile(bytesOfLength(3000)),
      chunkBytes: 1000,
      drainThresholdBytes: 4_000_000,
      drainPollMs: 10,
      drainTimeoutMs: 100,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(outcome).toEqual({ status: "aborted", reason: "stalled" });
    expect(recorder.opcodes()).toEqual([FileTransferOpcode.FileBegin]);
  });

  test("stops mid-transfer when the session is disposed", async () => {
    const recorder = makeRecorder({ disposeAfterChunks: 1 });

    const outcome = await emitChunkedFileTransfer({
      sink: recorder.sink,
      requestId: "req-5",
      file: makeFile(bytesOfLength(3000)),
      chunkBytes: 1000,
    });

    expect(outcome).toEqual({ status: "aborted", reason: "disposed" });
    expect(recorder.opcodes()).toEqual([
      FileTransferOpcode.FileBegin,
      FileTransferOpcode.FileChunk,
    ]);
  });

  test("sends without pacing when the transport reports no buffered signal", async () => {
    const bytes = bytesOfLength(2000);
    const recorder = makeRecorder({ bufferedAmounts: [null] });

    const outcome = await emitChunkedFileTransfer({
      sink: recorder.sink,
      requestId: "req-6",
      file: makeFile(bytes),
      chunkBytes: 1000,
    });

    expect(outcome).toEqual({ status: "sent", chunks: 2 });
    expect(recorder.payload()).toEqual(bytes);
  });
});
