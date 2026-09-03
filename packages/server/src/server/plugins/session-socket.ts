import { Buffer } from "node:buffer";
import { MAX_WEBSOCKET_MESSAGE_BYTES } from "@getpaseo/protocol/transport-limits";
import type { PluginProcessRequest } from "./plugin-process-protocol.js";

interface PluginProcessSender {
  send(message: PluginProcessRequest, callback?: (error: Error | null) => void): boolean;
}

type SocketEvent = "message" | "close" | "error";
type SocketListener = (...args: unknown[]) => void;

function normalizeBinaryFrame(
  data: Uint8Array<ArrayBufferLike> | ArrayBuffer,
): Uint8Array<ArrayBuffer> {
  if (data instanceof Uint8Array) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength) as Uint8Array<ArrayBuffer>;
  }
  return new Uint8Array(data) as Uint8Array<ArrayBuffer>;
}

export const MAX_PLUGIN_SESSION_FRAME_BYTES = MAX_WEBSOCKET_MESSAGE_BYTES;

function frameByteLength(data: string | Uint8Array): number {
  return typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength;
}

export class PluginSessionSocket {
  readyState = 1;
  bufferedAmount = 0;
  private readonly listeners = new Map<SocketEvent, Set<SocketListener>>();
  private readonly onceListeners = new Map<SocketEvent, Set<SocketListener>>();

  constructor(private readonly child: PluginProcessSender) {}

  send(data: string | Uint8Array | ArrayBuffer, callback?: (error?: Error) => void): void {
    if (this.readyState !== 1) {
      callback?.(new Error("Plugin session socket is closed"));
      return;
    }
    const frame = typeof data === "string" ? data : normalizeBinaryFrame(data);
    const byteLength = frameByteLength(frame);
    if (byteLength > MAX_PLUGIN_SESSION_FRAME_BYTES) {
      callback?.(
        new Error(`Plugin session frame exceeds the ${MAX_PLUGIN_SESSION_FRAME_BYTES}-byte limit`),
      );
      return;
    }
    this.bufferedAmount += byteLength;
    let completed = false;
    const complete = (error?: Error | null): void => {
      if (completed) return;
      completed = true;
      this.bufferedAmount = Math.max(0, this.bufferedAmount - byteLength);
      callback?.(error ?? undefined);
    };
    try {
      this.child.send(
        { type: "paseo_frame", data: frame, isBinary: typeof frame !== "string" },
        (error) => complete(error),
      );
    } catch (error) {
      complete(error instanceof Error ? error : new Error(String(error)));
    }
  }

  receive(data: string | Uint8Array, isBinary: boolean): void {
    if (this.readyState !== 1) return;
    if (frameByteLength(data) > MAX_PLUGIN_SESSION_FRAME_BYTES) {
      this.emit(
        "error",
        new Error(`Plugin session frame exceeds the ${MAX_PLUGIN_SESSION_FRAME_BYTES}-byte limit`),
      );
      this.peerClosed();
      return;
    }
    this.emit("message", data, isBinary);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    try {
      this.child.send({ type: "paseo_close" });
    } catch {
      // The child has already gone; local session cleanup still has to run.
    }
    this.emit("close", code, reason);
  }

  peerClosed(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }

  on(event: SocketEvent, listener: SocketListener): void {
    const listeners = this.listeners.get(event) ?? new Set<SocketListener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  once(event: "close" | "error", listener: SocketListener): void {
    const listeners = this.onceListeners.get(event) ?? new Set<SocketListener>();
    listeners.add(listener);
    this.onceListeners.set(event, listeners);
  }

  private emit(event: SocketEvent, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
    const once = this.onceListeners.get(event);
    if (!once) return;
    this.onceListeners.delete(event);
    for (const listener of once) listener(...args);
  }
}
