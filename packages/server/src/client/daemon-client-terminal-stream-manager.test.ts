import { describe, expect, test, vi } from "vitest";
import {
  TerminalStreamManager,
  type TerminalStreamChunk,
} from "./daemon-client-terminal-stream-manager.js";

function createChunk(input: {
  streamId: number;
  offset: number;
  data: string;
}): TerminalStreamChunk {
  const bytes = new TextEncoder().encode(input.data);
  return {
    streamId: input.streamId,
    offset: input.offset,
    endOffset: input.offset + bytes.byteLength,
    replay: false,
    data: bytes,
  };
}

describe("TerminalStreamManager", () => {
  test("buffers chunks and flushes with ack when handler subscribes", () => {
    const sendAck = vi.fn();
    const manager = new TerminalStreamManager({ sendAck });
    const seen: string[] = [];

    manager.receiveChunk({
      chunk: createChunk({ streamId: 7, offset: 4, data: "hello" }),
    });
    expect(sendAck).not.toHaveBeenCalled();

    manager.subscribe({
      streamId: 7,
      handler: (chunk) => {
        seen.push(new TextDecoder().decode(chunk.data));
      },
    });

    expect(seen).toEqual(["hello"]);
    expect(sendAck).toHaveBeenCalledTimes(1);
    expect(sendAck).toHaveBeenCalledWith({ streamId: 7, offset: 9 });
  });

  test("does not ack when every handler throws", () => {
    const sendAck = vi.fn();
    const manager = new TerminalStreamManager({ sendAck });

    manager.subscribe({
      streamId: 11,
      handler: () => {
        throw new Error("boom");
      },
    });

    manager.receiveChunk({
      chunk: createChunk({ streamId: 11, offset: 0, data: "x" }),
    });

    expect(sendAck).not.toHaveBeenCalled();
  });

  test("evicts oldest buffered chunks when max buffered chunk count is exceeded", () => {
    const sendAck = vi.fn();
    const manager = new TerminalStreamManager({
      sendAck,
      maxBufferedChunks: 2,
      maxBufferedBytes: 1024,
    });

    manager.receiveChunk({
      chunk: createChunk({ streamId: 5, offset: 0, data: "A" }),
    });
    manager.receiveChunk({
      chunk: createChunk({ streamId: 5, offset: 1, data: "B" }),
    });
    manager.receiveChunk({
      chunk: createChunk({ streamId: 5, offset: 2, data: "C" }),
    });

    const seen: string[] = [];
    manager.subscribe({
      streamId: 5,
      handler: (chunk) => {
        seen.push(new TextDecoder().decode(chunk.data));
      },
    });

    expect(seen).toEqual(["B", "C"]);
    expect(sendAck).toHaveBeenNthCalledWith(1, { streamId: 5, offset: 2 });
    expect(sendAck).toHaveBeenNthCalledWith(2, { streamId: 5, offset: 3 });
  });

  test("tracks explicit ack offsets and skips stale auto-acks", () => {
    const sendAck = vi.fn();
    const manager = new TerminalStreamManager({ sendAck });

    manager.subscribe({
      streamId: 13,
      handler: () => {
        // no-op
      },
    });
    manager.noteAck({ streamId: 13, offset: 10 });

    manager.receiveChunk({
      chunk: createChunk({ streamId: 13, offset: 0, data: "abc" }),
    });
    expect(sendAck).not.toHaveBeenCalled();

    manager.receiveChunk({
      chunk: createChunk({ streamId: 13, offset: 11, data: "z" }),
    });
    expect(sendAck).toHaveBeenCalledTimes(1);
    expect(sendAck).toHaveBeenCalledWith({ streamId: 13, offset: 12 });
  });
});
