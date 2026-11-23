import { type ChildProcess, execFileSync, fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PluginProcessMessage } from "./plugin-process-protocol.js";
import { PluginSessionSocket } from "./session-socket.js";

function forkEchoChild(): ChildProcess {
  return fork(
    fileURLToPath(new URL("./test-fixtures/plugin-session-echo.cjs", import.meta.url)),
    [],
    { serialization: "advanced", stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
}

async function waitForSpawn(child: ChildProcess): Promise<number> {
  await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
  if (child.pid === undefined) throw new Error("Child process has no pid");
  return child.pid;
}

/**
 * Blocks the event loop until the child is dead, so the parent has not yet read the
 * IPC hang-up: `child.connected` is still true and the next write fails with EPIPE.
 * A busy daemon sits in the same window between a plugin dying and Node noticing.
 */
function killAndWaitUnnoticed(child: ChildProcess, pid: number): void {
  child.kill("SIGKILL");
  execFileSync("sh", [
    "-c",
    'while kill -0 "$1" 2>/dev/null && [ "$(ps -o stat= -p "$1" | cut -c1)" != Z ]; do sleep 0.01; done',
    "sh",
    String(pid),
  ]);
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe("PluginSessionSocket child-process transport", () => {
  it("round-trips ordered text and binary frames through a real child process", async () => {
    const child = forkEchoChild();
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

  // Without an "error" listener, an error event on the child is an uncaught exception
  // that crashes the daemon. The listeners below only record what the daemon would throw.
  // Waiting for the child without running the event loop needs `sh`, `kill` and `ps`.
  it.skipIf(process.platform === "win32")(
    "closes after a frame write to a dead child fails with EPIPE",
    async () => {
      const child = forkEchoChild();
      const pid = await waitForSpawn(child);
      const childErrors: unknown[] = [];
      child.on("error", (error) => childErrors.push(error));
      const socket = new PluginSessionSocket(child);
      let closed = false;
      socket.on("close", () => {
        closed = true;
      });
      let sendError: Error | undefined;

      killAndWaitUnnoticed(child, pid);
      // The websocket server's outbound transport closes the socket when a write fails.
      socket.send("frame", (error) => {
        sendError = error;
        socket.close();
      });
      await settle();

      expect(sendError).toMatchObject({ code: "EPIPE" });
      expect(closed).toBe(true);
      expect(childErrors).toEqual([]);
    },
  );

  it("closes after the child's IPC channel has disconnected", async () => {
    const child = forkEchoChild();
    await waitForSpawn(child);
    const childErrors: unknown[] = [];
    child.on("error", (error) => childErrors.push(error));
    const socket = new PluginSessionSocket(child);
    let closed = false;
    socket.on("close", () => {
      closed = true;
    });
    const disconnected = new Promise<void>((resolve) => child.once("disconnect", () => resolve()));

    child.kill("SIGKILL");
    await disconnected;
    socket.close();
    await settle();

    expect(child.connected).toBe(false);
    expect(closed).toBe(true);
    expect(childErrors).toEqual([]);
  });
});
