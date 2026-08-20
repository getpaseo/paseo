import { Buffer } from "node:buffer";
import type { PluginProcessRequest } from "./plugin-process-protocol.js";

interface PluginProcessSender {
  send(message: PluginProcessRequest, callback?: (error: Error | null) => void): boolean;
}

type SocketEvent = "message" | "close" | "error";
type SocketListener = (...args: unknown[]) => void;

function normalizeBinaryFrame(data: Uint8Array | ArrayBuffer): Uint8Array {
  if (data instanceof Uint8Array) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new Uint8Array(data);
}

function frameByteLength(data: string | Uint8Array): number {
  return typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
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
    this.bufferedAmount += byteLength;
    try {
      this.child.send(
        { type: "paseo_frame", data: frame, isBinary: typeof frame !== "string" },
        (error) => {
          this.bufferedAmount = Math.max(0, this.bufferedAmount - byteLength);
          callback?.(error ?? undefined);
        },
      );
    } catch (error) {
      this.bufferedAmount = Math.max(0, this.bufferedAmount - byteLength);
      callback?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  receive(data: string | Uint8Array, isBinary: boolean): void {
    if (this.readyState !== 1) return;
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
