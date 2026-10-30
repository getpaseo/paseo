import { MAX_WEBSOCKET_MESSAGE_BYTES } from "./websocket-message-limit.js";

type Frame = string | Uint8Array;
// Reserved outside the application binary opcode space. Version, kind, flags follow.
const OPCODE = 0x31;
const HEADER = 4;

/** Connection-scoped ordered framing, below serialization and routing, above encryption. */
export class ChunkedTransport {
  enabled = false;
  private parts: Uint8Array[] | undefined;
  private size = 0;
  private kind = 0;
  private closed = false;
  private pending: Promise<void> | undefined;
  private queuedBytes = 0;
  private activeBytes = 0;

  constructor(
    private readonly io: {
      frameBytes: number;
      send: (frame: Frame, waitForDrain: boolean) => void | Promise<void>;
      deliver: (frame: Frame) => void;
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

  send(frame: Frame, waitForDrain = false): Promise<void> {
    const budget = this.enabled ? this.io.frameBytes : MAX_WEBSOCKET_MESSAGE_BYTES;
    let bytes: Uint8Array | undefined;
    if (typeof frame !== "string") bytes = frame;
    else if (frame.length * 3 > budget) bytes = new TextEncoder().encode(frame);
    const byteLength = bytes?.byteLength ?? (frame as string).length * 3;
    if (byteLength > MAX_WEBSOCKET_MESSAGE_BYTES) throw new Error("Logical message too large");
    const chunk = this.enabled && byteLength > this.io.frameBytes;
    if (this.closed) throw new Error("Transport closed");
    const write = () => {
      if (this.closed) throw new Error("Transport closed");
      this.activeBytes = byteLength;
      return chunk
        ? this.sendChunks(bytes!, typeof frame === "string")
        : this.io.send(frame, waitForDrain);
    };
    if (this.queuedBytes + byteLength > MAX_WEBSOCKET_MESSAGE_BYTES) {
      this.close();
      return Promise.reject(new Error("Logical output queue exceeded its byte limit"));
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
    const pending = Promise.resolve(result)
      .catch((error) => {
        this.close();
        throw error;
      })
      .finally(() => {
        this.queuedBytes -= byteLength;
        this.activeBytes = 0;
      });
    this.pending = pending;
    void pending.then(
      () => {
        if (this.pending === pending) this.pending = undefined;
        return undefined;
      },
      () => {},
    );
    return pending;
  }

  private async sendChunks(bytes: Uint8Array, text: boolean): Promise<void> {
    const capacity = this.io.frameBytes - HEADER;
    for (let offset = 0; offset < bytes.byteLength; offset += capacity) {
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
      await this.io.send(wire, true);
    }
  }

  receive(frame: Frame): void {
    if (this.closed) return;
    try {
      if (typeof frame === "string" || frame[0] !== OPCODE) {
        if (this.parts) throw new Error("Interrupted chunked message");
        this.io.deliver(frame);
        return;
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
      if (start === !!this.parts) throw new Error("Invalid chunk sequence");
      if (start) {
        this.parts = [];
        this.kind = frame[2]!;
        this.size = 0;
      }
      if (frame[2] !== this.kind) throw new Error("Chunk kind changed");
      this.size += frame.length - HEADER;
      if (this.size > MAX_WEBSOCKET_MESSAGE_BYTES) throw new Error("Logical message too large");
      this.parts!.push(frame.slice(HEADER));
      if (!end) return;
      const data = new Uint8Array(this.size);
      let offset = 0;
      for (const part of this.parts!) {
        data.set(part, offset);
        offset += part.length;
      }
      this.parts = undefined;
      this.size = 0;
      this.io.deliver(
        this.kind === 0 ? new TextDecoder("utf-8", { fatal: true }).decode(data) : data,
      );
    } catch (error) {
      this.close();
      throw error;
    }
  }

  close(): void {
    this.closed = true;
    this.enabled = false;
    this.parts = undefined;
    this.size = 0;
  }
}
