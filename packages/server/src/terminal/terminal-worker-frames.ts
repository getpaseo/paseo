import type { Socket } from "node:net";
import { deserialize, serialize } from "node:v8";

// Frames on the terminal worker socket: a 4-byte big-endian length, then a v8-serialized
// payload (the same structured-clone semantics the old fork IPC used with
// `serialization: "advanced"`). The frame format is part of the frozen envelope: every worker
// version must keep it.
const FRAME_HEADER_BYTES = 4;
const MAX_FRAME_BYTES = 256 * 1024 * 1024;

export class TerminalWorkerFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalWorkerFrameError";
  }
}

export function encodeFrame(value: unknown): Buffer {
  const payload = serialize(value);
  if (payload.length > MAX_FRAME_BYTES) {
    throw new TerminalWorkerFrameError(
      `Terminal worker frame of ${payload.length} bytes is too large`,
    );
  }
  const header = Buffer.allocUnsafe(FRAME_HEADER_BYTES);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

export class FrameDecoder {
  private buffered: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffered = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk]);
    const messages: unknown[] = [];
    while (this.buffered.length >= FRAME_HEADER_BYTES) {
      const length = this.buffered.readUInt32BE(0);
      if (length > MAX_FRAME_BYTES) {
        throw new TerminalWorkerFrameError(`Terminal worker frame of ${length} bytes is too large`);
      }
      const end = FRAME_HEADER_BYTES + length;
      if (this.buffered.length < end) break;
      messages.push(deserialize(this.buffered.subarray(FRAME_HEADER_BYTES, end)));
      this.buffered = this.buffered.subarray(end);
    }
    return messages;
  }
}

export interface FramedSocket {
  readonly socket: Socket;
  send(message: unknown, callback?: (error: Error | null) => void): boolean;
  close(): void;
}

/**
 * Wraps a connected socket in length-prefixed frames. A malformed frame destroys the socket:
 * the peer is either not a terminal worker endpoint or is corrupt, and both end the session.
 */
export function attachFramedSocket(
  socket: Socket,
  onMessage: (message: unknown) => void,
): FramedSocket {
  const decoder = new FrameDecoder();
  socket.on("data", (chunk: Buffer) => {
    let messages: unknown[];
    try {
      messages = decoder.push(chunk);
    } catch (error) {
      socket.destroy(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    for (const message of messages) {
      if (socket.destroyed) return;
      onMessage(message);
    }
  });
  return {
    socket,
    send(message, callback) {
      if (socket.destroyed || !socket.writable) {
        callback?.(new Error("Terminal worker socket is closed"));
        return false;
      }
      let frame: Buffer;
      try {
        frame = encodeFrame(message);
      } catch (error) {
        callback?.(error instanceof Error ? error : new Error(String(error)));
        return false;
      }
      return socket.write(frame, (error) => callback?.(error ?? null));
    },
    close() {
      socket.end(() => socket.destroy());
    },
  };
}
