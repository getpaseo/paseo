import net from "node:net";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TunnelCloseReason,
  TunnelStreamOpcode,
  decodeTunnelStreamFrame,
  type TunnelStreamFrame,
} from "@getpaseo/protocol/binary-frames/index";
import { TunnelForwarder } from "./tunnel-forwarder.js";

function listen(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

function closeServer(server: net.Server, sockets?: Iterable<net.Socket>): Promise<void> {
  if (sockets) {
    for (const socket of sockets) {
      socket.destroy();
    }
  }
  return new Promise((resolve) => server.close(() => resolve()));
}

interface EchoServer {
  port: number;
  close: () => Promise<void>;
}

async function startEchoServer(): Promise<EchoServer> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (chunk) => socket.write(chunk));
    socket.on("error", () => socket.destroy());
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("no port");
  }
  // Force-close live connections so close() doesn't block on them regardless of teardown order.
  return { port: address.port, close: () => closeServer(server, sockets) };
}

function decodeAll(frames: Uint8Array[]): TunnelStreamFrame[] {
  return frames
    .map((frame) => decodeTunnelStreamFrame(frame))
    .filter((frame): frame is TunnelStreamFrame => frame !== null);
}

function hasFrame(emitted: Uint8Array[], opcode: number): boolean {
  return decodeAll(emitted).some((frame) => frame.opcode === opcode);
}

function hasCloseFor(emitted: Uint8Array[], streamId: string): boolean {
  return decodeAll(emitted).some(
    (frame) => frame.opcode === TunnelStreamOpcode.Close && frame.streamId === streamId,
  );
}

function findFrame(emitted: Uint8Array[], opcode: number): TunnelStreamFrame | undefined {
  return decodeAll(emitted).find((frame) => frame.opcode === opcode);
}

describe("TunnelForwarder", () => {
  const cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
  });

  function makeForwarder(emitted: Uint8Array[]): TunnelForwarder {
    const forwarder = new TunnelForwarder({
      emitBinary: (frame) => emitted.push(frame),
      hasBinaryChannel: () => true,
      getClientBufferedAmount: () => 0,
      sessionLogger: pino({ level: "silent" }),
    });
    cleanups.push(() => forwarder.dispose());
    return forwarder;
  }

  it("forwards bytes to a loopback target and streams the response back", async () => {
    const echo = await startEchoServer();
    cleanups.push(() => echo.close());

    const emitted: Uint8Array[] = [];
    const forwarder = makeForwarder(emitted);

    forwarder.handleFrame({ opcode: TunnelStreamOpcode.Open, streamId: "s1", port: echo.port });
    forwarder.handleFrame({
      opcode: TunnelStreamOpcode.Data,
      streamId: "s1",
      payload: new TextEncoder().encode("ping"),
    });

    await vi.waitFor(() => {
      expect(hasFrame(emitted, TunnelStreamOpcode.Data)).toBe(true);
    });

    const dataFrame = findFrame(emitted, TunnelStreamOpcode.Data);
    expect(dataFrame).toBeDefined();
    if (dataFrame?.opcode === TunnelStreamOpcode.Data) {
      expect(new TextDecoder().decode(dataFrame.payload)).toBe("ping");
      expect(dataFrame.streamId).toBe("s1");
    }
  });

  it("emits a ConnectFailed close when the loopback target refuses", async () => {
    // Grab a port, then free it so the connect is refused.
    const probe = await startEchoServer();
    const deadPort = probe.port;
    await probe.close();

    const emitted: Uint8Array[] = [];
    const forwarder = makeForwarder(emitted);
    forwarder.handleFrame({ opcode: TunnelStreamOpcode.Open, streamId: "s1", port: deadPort });

    await vi.waitFor(() => {
      expect(hasFrame(emitted, TunnelStreamOpcode.Close)).toBe(true);
    });

    const closeFrame = findFrame(emitted, TunnelStreamOpcode.Close);
    expect(closeFrame).toBeDefined();
    if (closeFrame?.opcode === TunnelStreamOpcode.Close) {
      expect(closeFrame.reason).toBe(TunnelCloseReason.ConnectFailed);
    }
  });

  it("notifies the client with a Close when the upstream ends the stream", async () => {
    const server = net.createServer((socket) => socket.end());
    await listen(server);
    const address = server.address();
    const port = address && typeof address !== "string" ? address.port : 0;
    cleanups.push(() => closeServer(server));

    const emitted: Uint8Array[] = [];
    const forwarder = makeForwarder(emitted);
    forwarder.handleFrame({ opcode: TunnelStreamOpcode.Open, streamId: "s2", port });

    await vi.waitFor(() => {
      expect(hasCloseFor(emitted, "s2")).toBe(true);
    });
  });

  it("ignores frames after dispose", async () => {
    const echo = await startEchoServer();
    cleanups.push(() => echo.close());

    const emitted: Uint8Array[] = [];
    const forwarder = makeForwarder(emitted);
    forwarder.dispose();
    forwarder.handleFrame({ opcode: TunnelStreamOpcode.Open, streamId: "s1", port: echo.port });
    forwarder.handleFrame({
      opcode: TunnelStreamOpcode.Data,
      streamId: "s1",
      payload: new TextEncoder().encode("ping"),
    });

    // handleFrame's disposed guard is synchronous: no socket is dialed and
    // nothing is emitted, so this holds immediately without waiting.
    expect(emitted).toHaveLength(0);
  });
});
