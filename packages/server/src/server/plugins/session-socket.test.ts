import { describe, expect, it } from "vitest";
import type { PluginProcessRequest } from "./plugin-process-protocol.js";
import { PluginSessionSocket } from "./session-socket.js";

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
