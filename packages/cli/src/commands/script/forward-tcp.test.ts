import { createConnection, createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type {
  NetworkTunnel,
  NetworkTunnelStreamHandlers,
} from "@getpaseo/client/internal/daemon-client";
import { startTcpForward, type TcpForward } from "./forward-tcp.js";

const forwards: TcpForward[] = [];
afterEach(async () => {
  await Promise.all(forwards.splice(0).map((forward) => forward.close()));
});

function echoTunnel(closeAfterWrite = false) {
  const writes: Uint8Array[] = [];
  let target: { host: string; port: number } | undefined;
  let closed = 0;
  const tunnel = {
    limits: { initialWindowBytes: 4, maxDataBytes: 2, maxStreams: 16, connectTimeoutMs: 1000 },
    openStream(destination: { host: string; port: number }, handlers: NetworkTunnelStreamHandlers) {
      target = destination;
      queueMicrotask(() => handlers.onConnected());
      return {
        streamId: "test",
        write(data: Uint8Array) {
          writes.push(data);
          queueMicrotask(() => {
            handlers.onData(data);
            if (closeAfterWrite) handlers.onClose(0);
            else handlers.onCredit(data.length);
          });
        },
        consume() {},
        close() {
          closed += 1;
        },
      };
    },
  } as unknown as NetworkTunnel;
  return {
    tunnel,
    writes,
    get closed() {
      return closed;
    },
    get target() {
      return target;
    },
  };
}

async function exchange(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let result = "";
    socket.on("error", reject);
    socket.on("data", (data) => {
      result += data.toString();
      if (result.length === payload.length) {
        socket.destroy();
        resolve(result);
      }
    });
    socket.on("connect", () => socket.write(payload));
  });
}

describe("workspace TCP forwarding", () => {
  it("forwards both directions and splits writes at the negotiated frame size", async () => {
    const fake = echoTunnel();
    const forward = await startTcpForward(fake.tunnel, 4173, 0);
    forwards.push(forward);
    expect(await exchange(forward.port, "abcdef")).toBe("abcdef");
    expect(fake.target).toEqual({ host: "localhost", port: 4173 });
    expect(fake.writes.map((part) => part.length)).toEqual([2, 2, 2]);
  });

  it("releases streams after local EOF even when the upstream stays open", async () => {
    const fake = echoTunnel();
    const forward = await startTcpForward(fake.tunnel, 4173, 0);
    forwards.push(forward);
    const socket = createConnection({ host: "127.0.0.1", port: forward.port });
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("connect", () => socket.end("abcdef"));
      socket.resume();
      socket.once("close", () => resolve());
    });
    expect(Buffer.concat(fake.writes).toString()).toBe("abcdef");
    expect(fake.closed).toBe(1);
  });

  it("uses a free loopback port when the default port is occupied", async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    const busyPort = (occupied.address() as { port: number }).port;
    try {
      const forward = await startTcpForward(echoTunnel().tunnel, 4173, busyPort);
      forwards.push(forward);
      expect(forward.port).not.toBe(busyPort);
      await expect(
        startTcpForward(echoTunnel().tunnel, 4173, busyPort, false),
      ).rejects.toMatchObject({
        code: "EADDRINUSE",
      });
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });

  it("flushes the last response bytes before closing a local socket", async () => {
    const forward = await startTcpForward(echoTunnel(true).tunnel, 4173, 0);
    forwards.push(forward);
    const received = await new Promise<string>((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port: forward.port });
      let data = "";
      socket.on("error", reject);
      socket.on("data", (part) => {
        data += part.toString();
      });
      socket.on("end", () => resolve(data));
      socket.on("connect", () => socket.write("ok"));
    });
    expect(received).toBe("ok");
  });
});
