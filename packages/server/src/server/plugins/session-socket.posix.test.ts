import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PluginProcessMessage } from "./plugin-process-protocol.js";
import { PluginSessionSocket } from "./session-socket.js";

describe("PluginSessionSocket child-process transport", () => {
  it("round-trips ordered text and binary frames through a real child process", async () => {
    const child = fork(
      fileURLToPath(new URL("./test-fixtures/plugin-session-echo.cjs", import.meta.url)),
      [],
      { serialization: "advanced", stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    const socket = new PluginSessionSocket(child);
    const received: Array<string | Uint8Array> = [];
    socket.on("message", (data) => received.push(data as string | Uint8Array));
    child.on("message", (message: PluginProcessMessage) => {
      if (message.type === "paseo_frame") socket.receive(message.data, message.isBinary);
    });

    try {
      socket.send("first");
      socket.send(new Uint8Array([1, 2, 3]));
      socket.send("last");
      await expect.poll(() => received.length).toBe(3);

      expect(received).toEqual(["first", new Uint8Array([1, 2, 3]), "last"]);
    } finally {
      child.kill();
    }
  });
});
