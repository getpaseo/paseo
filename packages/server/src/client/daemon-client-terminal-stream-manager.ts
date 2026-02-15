export type TerminalStreamChunk = {
  streamId: number;
  offset: number;
  endOffset: number;
  replay: boolean;
  data: Uint8Array;
};

type TerminalChunkHandler = (chunk: TerminalStreamChunk) => void;

type BufferedTerminalStreamQueue = {
  chunks: TerminalStreamChunk[];
  bytes: number;
};

type TerminalStreamAck = {
  streamId: number;
  offset: number;
};

export type TerminalStreamManagerConfig = {
  sendAck: (ack: TerminalStreamAck) => void;
  maxBufferedChunks?: number;
  maxBufferedBytes?: number;
};

const DEFAULT_MAX_BUFFERED_CHUNKS = 2048;
const DEFAULT_MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

export class TerminalStreamManager {
  private readonly handlers: Map<number, Set<TerminalChunkHandler>> = new Map();
  private readonly bufferedChunks: Map<number, BufferedTerminalStreamQueue> = new Map();
  private readonly ackOffsets: Map<number, number> = new Map();
  private readonly maxBufferedChunks: number;
  private readonly maxBufferedBytes: number;

  constructor(private readonly config: TerminalStreamManagerConfig) {
    this.maxBufferedChunks =
      config.maxBufferedChunks ?? DEFAULT_MAX_BUFFERED_CHUNKS;
    this.maxBufferedBytes =
      config.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  }

  clearAll(): void {
    this.handlers.clear();
    this.bufferedChunks.clear();
    this.ackOffsets.clear();
  }

  clearStream(input: { streamId: number }): void {
    this.handlers.delete(input.streamId);
    this.bufferedChunks.delete(input.streamId);
    this.ackOffsets.delete(input.streamId);
  }

  subscribe(input: {
    streamId: number;
    handler: TerminalChunkHandler;
  }): () => void {
    const { streamId, handler } = input;
    if (!this.handlers.has(streamId)) {
      this.handlers.set(streamId, new Set());
    }

    const streamHandlers = this.handlers.get(streamId)!;
    streamHandlers.add(handler);
    this.flushBufferedChunks({ streamId, handler });

    return () => {
      streamHandlers.delete(handler);
      if (streamHandlers.size === 0) {
        this.handlers.delete(streamId);
      }
    };
  }

  receiveChunk(input: { chunk: TerminalStreamChunk }): void {
    const { chunk } = input;
    const streamHandlers = this.handlers.get(chunk.streamId);
    if (!streamHandlers || streamHandlers.size === 0) {
      this.bufferChunk({ chunk });
      // Ack buffered chunks immediately to keep the daemon-side stream window
      // moving even before a UI subscriber is attached.
      this.maybeAckChunk({
        streamId: chunk.streamId,
        endOffset: chunk.endOffset,
      });
      return;
    }

    let delivered = false;
    for (const handler of streamHandlers) {
      try {
        handler(chunk);
        delivered = true;
      } catch {
        // no-op
      }
    }
    if (delivered) {
      this.maybeAckChunk({
        streamId: chunk.streamId,
        endOffset: chunk.endOffset,
      });
    }
  }

  noteAck(input: TerminalStreamAck): void {
    const normalizedOffset = Math.max(0, Math.floor(input.offset));
    const previousAck = this.ackOffsets.get(input.streamId) ?? -1;
    if (normalizedOffset > previousAck) {
      this.ackOffsets.set(input.streamId, normalizedOffset);
    }
  }

  private flushBufferedChunks(input: {
    streamId: number;
    handler: TerminalChunkHandler;
  }): void {
    const buffered = this.bufferedChunks.get(input.streamId);
    if (!buffered || buffered.chunks.length === 0) {
      return;
    }

    for (const chunk of buffered.chunks) {
      try {
        input.handler(chunk);
        this.maybeAckChunk({
          streamId: input.streamId,
          endOffset: chunk.endOffset,
        });
      } catch {
        // no-op
      }
    }
    this.bufferedChunks.delete(input.streamId);
  }

  private bufferChunk(input: { chunk: TerminalStreamChunk }): void {
    const queue = this.bufferedChunks.get(input.chunk.streamId) ?? {
      chunks: [],
      bytes: 0,
    };

    queue.chunks.push(input.chunk);
    queue.bytes += input.chunk.data.byteLength;

    while (
      queue.chunks.length > this.maxBufferedChunks ||
      queue.bytes > this.maxBufferedBytes
    ) {
      const removed = queue.chunks.shift();
      if (!removed) {
        break;
      }
      queue.bytes -= removed.data.byteLength;
      if (queue.bytes < 0) {
        queue.bytes = 0;
      }
    }

    this.bufferedChunks.set(input.chunk.streamId, queue);
  }

  private maybeAckChunk(input: { streamId: number; endOffset: number }): void {
    if (!Number.isFinite(input.endOffset) || input.endOffset < 0) {
      return;
    }

    const normalizedEndOffset = Math.floor(input.endOffset);
    const previousAck = this.ackOffsets.get(input.streamId) ?? -1;
    if (normalizedEndOffset <= previousAck) {
      return;
    }

    this.ackOffsets.set(input.streamId, normalizedEndOffset);
    try {
      this.config.sendAck({
        streamId: input.streamId,
        offset: normalizedEndOffset,
      });
    } catch {
      // no-op
    }
  }
}
