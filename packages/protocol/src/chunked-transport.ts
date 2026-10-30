import { MAX_WEBSOCKET_MESSAGE_BYTES } from "./websocket-message-limit.js";

type Frame = string | Uint8Array;

/** A malformed wire frame, distinct from a consumer delivery failure. */
export class ChunkedTransportProtocolError extends Error {}
// Reserved outside the application binary opcode space. Version, kind, flags follow.
const OPCODE = 0x31;
const HEADER = 4;

/** Connection-scoped ordered framing, below serialization and routing, above encryption. */
export class ChunkedTransport {
  enabled = false;
  private assembly: Uint8Array | undefined;
  private size = 0;
  private kind = 0;
  private closed = false;
  private pending: Promise<void> | undefined;
  private queuedBytes = 0;
  private activeBytes = 0;

  constructor(
    private readonly io: {
      frameBytes: number;
      supportsDrain?: boolean;
      send: (frame: Frame, waitForDrain: boolean) => void | Promise<void>;
      deliver: (frame: Frame) => void;
      onFailure?: (error: unknown) => void;
    },
  ) {
    if (io.frameBytes <= HEADER) throw new Error("Invalid transport frame budget");
  }

  /** Bytes waiting behind the active write; physical buffering owns the active frame. */
  get queuedByteLength(): number {
    return this.queuedBytes - this.activeBytes;
  }
  get isWriting(): boolean {
    return this.pending !== undefined;
  }

  send(frame: Frame, options: { waitForDrain?: boolean; byteLength?: number } = {}): Promise<void> {
    const byteLength = options.byteLength ?? frameByteLength(frame);
    if (byteLength > MAX_WEBSOCKET_MESSAGE_BYTES) throw new Error("Logical message too large");
    const chunk =
      this.enabled && this.io.supportsDrain !== false && byteLength > this.io.frameBytes;
    if (this.closed) throw new Error("Transport closed");
    const write = () => {
      if (this.closed) throw new Error("Transport closed");
      this.activeBytes = byteLength;
      // A synchronous rejection did not admit a frame. Only accepted writes can
      // fail the connection; queued admission failures still belong to their sender.
      const result = chunk
        ? this.sendChunks(
            typeof frame === "string" ? new TextEncoder().encode(frame) : frame,
            typeof frame === "string",
          )
        : this.io.send(frame, options.waitForDrain === true);
      if (!result) return;
      return result.catch((error) => {
        this.fail(error);
        throw error;
      });
    };
    if (this.queuedBytes + byteLength > MAX_WEBSOCKET_MESSAGE_BYTES) {
      const error = new Error("Logical output queue exceeded its byte limit");
      this.fail(error);
      const rejected = Promise.reject<void>(error);
      void rejected.catch(() => {});
      return rejected;
    }
    this.queuedBytes += byteLength;
    let result: void | Promise<void>;
    try {
      result = this.pending ? this.pending.then(write) : write();
    } catch (error) {
      this.queuedBytes -= byteLength;
      this.activeBytes = 0;
      throw error;
    }
    if (!result) {
      this.queuedBytes -= byteLength;
      this.activeBytes = 0;
      return Promise.resolve();
    }
    const completion = Promise.resolve(result).finally(() => {
      this.queuedBytes -= byteLength;
      this.activeBytes = 0;
    });
    const tail = completion.then(
      () => undefined,
      () => undefined,
    );
    this.pending = tail;
    void tail.then(() => {
      if (this.pending === tail) this.pending = undefined;
      return undefined;
    });
    return completion;
  }

  private sendChunks(bytes: Uint8Array, text: boolean): Promise<void> {
    const capacity = this.io.frameBytes - HEADER;
    const writeChunk = (offset: number) => {
      if (this.closed) throw new Error("Transport closed");
      const end = Math.min(bytes.byteLength, offset + capacity);
      const wire = new Uint8Array(HEADER + end - offset);
      wire.set([
        OPCODE,
        1,
        text ? 0 : 1,
        (offset === 0 ? 1 : 0) | (end === bytes.byteLength ? 2 : 0),
      ]);
      wire.set(bytes.subarray(offset, end), HEADER);
      return this.io.send(wire, true);
    };
    const first = writeChunk(0);
    return (async () => {
      await first;
      for (let offset = capacity; offset < bytes.byteLength; offset += capacity)
        await writeChunk(offset);
    })();
  }

  receive(frame: Frame): void {
    if (this.closed) return;
    let message: Frame | undefined;
    try {
      message = this.assemble(frame);
    } catch (error) {
      this.close();
      throw new ChunkedTransportProtocolError(
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
    if (message !== undefined) this.io.deliver(message);
  }

  private assemble(frame: Frame): Frame | undefined {
    if (typeof frame === "string" || frame[0] !== OPCODE) {
      if (this.assembly) throw new Error("Interrupted chunked message");
      return frame;
    }
    if (
      !this.enabled ||
      frame.length <= HEADER ||
      frame[1] !== 1 ||
      frame[2]! > 1 ||
      (frame[3]! & ~3) !== 0
    )
      throw new Error("Invalid chunk header");
    const start = (frame[3]! & 1) !== 0;
    const end = (frame[3]! & 2) !== 0;
    if (start === !!this.assembly) throw new Error("Invalid chunk sequence");
    if (start) {
      this.assembly = new Uint8Array(0);
      this.kind = frame[2]!;
      this.size = 0;
    }
    if (frame[2] !== this.kind) throw new Error("Chunk kind changed");
    this.size += frame.length - HEADER;
    if (this.size > MAX_WEBSOCKET_MESSAGE_BYTES) throw new Error("Logical message too large");
    const payload = frame.subarray(HEADER);
    if (this.assembly!.byteLength < this.size) {
      const capacity = Math.min(
        MAX_WEBSOCKET_MESSAGE_BYTES,
        Math.max(this.size, this.assembly!.byteLength * 2, 16384),
      );
      const grown = new Uint8Array(capacity);
      grown.set(this.assembly!.subarray(0, this.size - payload.byteLength));
      this.assembly = grown;
    }
    this.assembly!.set(payload, this.size - payload.byteLength);
    if (!end) return;
    const data = this.assembly!.subarray(0, this.size);
    this.assembly = undefined;
    this.size = 0;
    return this.kind === 0 ? new TextDecoder("utf-8", { fatal: true }).decode(data) : data.slice();
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    this.close();
    this.io.onFailure?.(error);
  }

  close(): void {
    this.closed = true;
    this.enabled = false;
    this.assembly = undefined;
    this.size = 0;
  }
}

function frameByteLength(frame: Frame): number {
  if (typeof frame !== "string") return frame.byteLength;
  let bytes = 0;
  for (let index = 0; index < frame.length; index++) {
    const code = frame.charCodeAt(index);
    if (code <= 0x7f) bytes++;
    else if (code <= 0x7ff) bytes += 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      frame.charCodeAt(index + 1) >= 0xdc00 &&
      frame.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}
