import { describe, expect, it, vi } from "vitest";
import type { PluginProcessRequest } from "./plugin-process-protocol.js";
import { MAX_PLUGIN_SESSION_FRAME_BYTES, PluginSessionSocket } from "./session-socket.js";

describe("PluginSessionSocket", () => {
  it("preserves text and binary frame order across IPC", () => {
    const sent: PluginProcessRequest[] = [];
    const socket = new PluginSessionSocket({
      send(message, callback) {
        sent.push(message);
        callback?.(null);
        return true;
      },
    });

    socket.send("first");
    socket.send(new Uint8Array([1, 2, 3]));
    socket.send("last");

    expect(sent).toEqual([
      { type: "paseo_frame", data: "first", isBinary: false },
      { type: "paseo_frame", data: new Uint8Array([1, 2, 3]), isBinary: true },
      { type: "paseo_frame", data: "last", isBinary: false },
    ]);
  });

  it("settles a send callback and buffered bytes only once", () => {
    const callback = vi.fn<(error?: Error) => void>();
    const socket = new PluginSessionSocket({
      send(_message, sendCallback) {
        sendCallback?.(null);
        sendCallback?.(new Error("late callback"));
        return true;
      },
    });

    socket.send("€", callback);

    expect(callback).toHaveBeenCalledOnce();
    expect(socket.bufferedAmount).toBe(0);
  });

  it("rejects oversized UTF-8 frames before sending them to the child", () => {
    const send = vi.fn(() => true);
    const callback = vi.fn<(error?: Error) => void>();
    const socket = new PluginSessionSocket({ send });

    socket.send("é".repeat(MAX_PLUGIN_SESSION_FRAME_BYTES), callback);

    expect(send).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledOnce();
    expect(callback.mock.calls[0]?.[0]?.message).toMatch(/limit/);
    expect(socket.bufferedAmount).toBe(0);
  });

  it("reports bytes queued in child-process IPC for terminal backpressure", () => {
    const callbacks: Array<(error: Error | null) => void> = [];
    const socket = new PluginSessionSocket({
      send(_message, callback) {
        if (callback) callbacks.push(callback);
        return true;
      },
    });

    socket.send("hello");
    socket.send(new Uint8Array([1, 2, 3]));
    expect(socket.bufferedAmount).toBe(8);

    callbacks[0]?.(null);
    expect(socket.bufferedAmount).toBe(3);
    callbacks[1]?.(null);
    expect(socket.bufferedAmount).toBe(0);
  });
});
