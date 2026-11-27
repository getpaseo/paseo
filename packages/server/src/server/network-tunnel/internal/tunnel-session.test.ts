import { EventEmitter } from "node:events";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeNetworkTunnelFrame,
  encodeNetworkTunnelFrame,
  NetworkTunnelCloseReason,
  type DecodedNetworkTunnelFrame,
  type NetworkTunnelFrame,
} from "@getpaseo/protocol/network-tunnel";
import { TunnelSession, type TunnelSocketLike } from "./tunnel-session.js";

class InMemoryTunnelSocket implements TunnelSocketLike {
  readyState = 1;
  bufferedAmount = 0;
  readonly sentText: string[] = [];
  readonly sentFrames: DecodedNetworkTunnelFrame[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  private readonly emitter = new EventEmitter();
  private readonly frameWaiters: Array<{
    predicate: (frame: DecodedNetworkTunnelFrame) => boolean;
    resolve: (frame: DecodedNetworkTunnelFrame) => void;
  }> = [];

  send(data: string | Uint8Array | ArrayBuffer, callback?: (error?: Error) => void): void {
    if (typeof data === "string") {
      this.sentText.push(data);
    } else {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
      const decoded = decodeNetworkTunnelFrame(bytes);
      this.sentFrames.push(decoded);
      for (let i = 0; i < this.frameWaiters.length; i += 1) {
        const waiter = this.frameWaiters[i]!;
        if (waiter.predicate(decoded)) {
          this.frameWaiters.splice(i, 1);
          waiter.resolve(decoded);
          break;
        }
      }
    }
    callback?.();
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closes.push({ code, reason });
    this.emitter.emit("close", code ?? 1000, reason ?? "");
  }

  terminate(): void {
    this.close(1006, "terminated");
  }

  on(event: "message" | "close" | "error", listener: (...args: unknown[]) => void): void {
    this.emitter.on(event, listener);
  }

  once(event: "close" | "error", listener: (...args: unknown[]) => void): void {
    this.emitter.once(event, listener);
  }

  receiveFrame(frame: NetworkTunnelFrame): void {
    const encoded = encodeNetworkTunnelFrame(frame);
    this.emitter.emit("message", Buffer.from(encoded), true);
  }

  waitForFrame(
    predicate: (frame: DecodedNetworkTunnelFrame) => boolean,
    timeoutMs = 5_000,
  ): Promise<DecodedNetworkTunnelFrame> {
    const existing = this.sentFrames.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Timed out waiting for tunnel frame"));
      }, timeoutMs);
      this.frameWaiters.push({
        predicate,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      });
    });
  }
}

const logger = pino({ level: "silent" });
const servers: Server[] = [];
const sessions: TunnelSession[] = [];

async function startTcpServer(onConnection: (socket: Socket) => void): Promise<{
  server: Server;
  port: number;
}> {
  const server = createServer({ allowHalfOpen: true }, onConnection);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return { server, port: (server.address() as AddressInfo).port };
}

function attachEchoOnEndHandler(socket: Socket): void {
  const chunks: Buffer[] = [];
  socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  socket.on("end", () => {
    const received = Buffer.concat(chunks).toString("utf8");
    socket.end(`echo:${received}`);
  });
}

function collectSentData(ws: InMemoryTunnelSocket): Buffer {
  return Buffer.concat(
    ws.sentFrames
      .filter((f): f is Extract<DecodedNetworkTunnelFrame, { type: "data" }> => f.type === "data")
      .map((f) => Buffer.from(f.data)),
  );
}

function waitForSentDataBytes(ws: InMemoryTunnelSocket, targetBytes: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error(`Timed out waiting for ${targetBytes} data bytes`)),
      3_000,
    );
    const check = setInterval(() => {
      if (collectSentData(ws).byteLength >= targetBytes) {
        clearInterval(check);
        clearTimeout(deadline);
        resolve();
      }
    }, 10);
  });
}

function waitForSocketClose(socket: Socket): Promise<void> {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    socket.once("close", () => resolve());
  });
}

function attachKeepOpenHandler(serverSockets: Socket[], socket: Socket): void {
  serverSockets.push(socket);
  socket.resume();
  socket.once("end", () => socket.end());
}

function attachDrainAndCollect(socket: Socket, receivedChunks: Buffer[], onDone: () => void): void {
  socket.on("data", (chunk) => receivedChunks.push(Buffer.from(chunk)));
  socket.on("end", () => {
    socket.end();
    onDone();
  });
}

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    session.close();
  }
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("TunnelSession binary TCP multiplexer", () => {
  it("sends tunnel_ready, relays bidirectional TCP data and half-close, and echoes pings", async () => {
    const { port } = await startTcpServer(attachEchoOnEndHandler);

    const ws = new InMemoryTunnelSocket();
    const session = new TunnelSession({
      ws,
      principalId: "owner",
      logger,
    });
    sessions.push(session);

    expect(ws.sentText).toHaveLength(1);
    expect(JSON.parse(ws.sentText[0]!)).toEqual({
      type: "tunnel_ready",
      maxFramePayloadBytes: 64 * 1024,
      initialStreamWindowBytes: 512 * 1024,
      initialConnectionWindowBytes: 4 * 1024 * 1024,
    });

    // Ping/Pong
    const nonce = new Uint8Array([1, 2, 3, 4]);
    ws.receiveFrame({ type: "ping", payload: nonce });
    const pong = await ws.waitForFrame((frame) => frame.type === "pong");
    expect(pong).toEqual({ type: "pong", payload: nonce, flags: 0 });

    // Open -> Data -> HalfClose -> response Data -> HalfClose
    ws.receiveFrame({ type: "open", streamId: 1, host: "127.0.0.1", port });
    const opened = await ws.waitForFrame(
      (frame) => frame.type === "opened" && frame.streamId === 1,
    );
    expect(opened.type === "opened" && opened.initialWindowBytes).toBe(512 * 1024);

    ws.receiveFrame({
      type: "data",
      streamId: 1,
      data: new TextEncoder().encode("hello half-close"),
    });
    ws.receiveFrame({ type: "half_close", streamId: 1 });

    await ws.waitForFrame((frame) => frame.type === "half_close" && frame.streamId === 1);
    expect(collectSentData(ws).toString("utf8")).toBe("echo:hello half-close");
  });

  it("enforces per-stream and connection credit windows with real TCP backpressure", async () => {
    const payloadSize = 24 * 1024;
    const expected = Buffer.alloc(payloadSize);
    for (let i = 0; i < payloadSize; i += 1) expected[i] = i % 251;

    const { port } = await startTcpServer((socket) => {
      socket.end(expected);
    });

    const ws = new InMemoryTunnelSocket();
    const session = new TunnelSession({
      ws,
      principalId: "owner",
      logger,
      maxFramePayloadBytes: 4 * 1024,
      initialStreamWindowBytes: 8 * 1024,
      initialConnectionWindowBytes: 8 * 1024,
    });
    sessions.push(session);

    ws.receiveFrame({ type: "open", streamId: 1, host: "127.0.0.1", port });
    await ws.waitForFrame((frame) => frame.type === "opened" && frame.streamId === 1);

    // Wait until the initial 8 KiB window is filled.
    await waitForSentDataBytes(ws, 8 * 1024);

    // Pause briefly to verify the daemon does NOT exceed the 8 KiB credit window.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(collectSentData(ws).byteLength).toBe(8 * 1024);
    expect(ws.sentFrames.some((f) => f.type === "half_close")).toBe(false);

    // Grant connection + stream credit to drain the rest of the 24 KiB payload.
    ws.receiveFrame({ type: "window_update", streamId: 0, creditBytes: 16 * 1024 });
    ws.receiveFrame({ type: "window_update", streamId: 1, creditBytes: 16 * 1024 });

    await ws.waitForFrame((frame) => frame.type === "half_close" && frame.streamId === 1);
    expect(Buffer.compare(collectSentData(ws), expected)).toBe(0);
  });

  it("enforces concurrent stream cap and rejects blocked SSRF destinations", async () => {
    const serverSockets: Socket[] = [];
    const { port } = await startTcpServer((socket) => attachKeepOpenHandler(serverSockets, socket));

    const ws = new InMemoryTunnelSocket();
    const session = new TunnelSession({
      ws,
      principalId: "owner",
      logger,
      maxConcurrentStreams: 2,
    });
    sessions.push(session);

    // Blocked metadata IP
    ws.receiveFrame({ type: "open", streamId: 99, host: "169.254.169.254", port: 80 });
    const denied = await ws.waitForFrame(
      (frame) => frame.type === "close" && frame.streamId === 99,
    );
    expect(denied.type === "close" && denied.reason).toBe(NetworkTunnelCloseReason.PolicyDenied);

    // Fill 2 concurrent streams
    ws.receiveFrame({ type: "open", streamId: 1, host: "127.0.0.1", port });
    ws.receiveFrame({ type: "open", streamId: 2, host: "127.0.0.1", port });
    await ws.waitForFrame((frame) => frame.type === "opened" && frame.streamId === 1);
    await ws.waitForFrame((frame) => frame.type === "opened" && frame.streamId === 2);

    // 3rd stream exceeds cap
    ws.receiveFrame({ type: "open", streamId: 3, host: "127.0.0.1", port });
    const capped = await ws.waitForFrame((frame) => frame.type === "close" && frame.streamId === 3);
    expect(capped.type === "close" && capped.reason).toBe(
      NetworkTunnelCloseReason.StreamLimitExceeded,
    );

    // Closing the tunnel WS tears down all active upstream TCP sockets cleanly
    const allClosed = Promise.all(serverSockets.map(waitForSocketClose));
    ws.close(1000, "done");
    await allClosed;
    expect(session.activeStreamCount).toBe(0);
  });

  it("replenishes stream and connection receive windows as uploaded data drains to TCP", async () => {
    const receivedChunks: Buffer[] = [];
    let resolveDone!: () => void;
    const allReceived = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const { port } = await startTcpServer((socket) => {
      attachDrainAndCollect(socket, receivedChunks, resolveDone);
    });

    const ws = new InMemoryTunnelSocket();
    const session = new TunnelSession({
      ws,
      principalId: "owner",
      logger,
      maxFramePayloadBytes: 4 * 1024,
      initialStreamWindowBytes: 8 * 1024,
      initialConnectionWindowBytes: 8 * 1024,
    });
    sessions.push(session);

    ws.receiveFrame({ type: "open", streamId: 1, host: "127.0.0.1", port });
    await ws.waitForFrame((frame) => frame.type === "opened" && frame.streamId === 1);

    // Send 4 chunks of 4 KiB each (16 KiB total > 8 KiB initial window).
    const totalPayload = Buffer.alloc(16 * 1024);
    for (let i = 0; i < totalPayload.length; i += 1) totalPayload[i] = (i * 7) & 0xff;

    ws.receiveFrame({ type: "data", streamId: 1, data: totalPayload.subarray(0, 4 * 1024) });
    ws.receiveFrame({ type: "data", streamId: 1, data: totalPayload.subarray(4 * 1024, 8 * 1024) });

    // Daemon must replenish both stream and connection windows after draining.
    const streamUpdate = await ws.waitForFrame(
      (frame) => frame.type === "window_update" && frame.streamId === 1,
    );
    const connUpdate = await ws.waitForFrame(
      (frame) => frame.type === "window_update" && frame.streamId === 0,
    );
    expect(streamUpdate.type === "window_update" && streamUpdate.creditBytes).toBeGreaterThan(0);
    expect(connUpdate.type === "window_update" && connUpdate.creditBytes).toBeGreaterThan(0);

    ws.receiveFrame({
      type: "data",
      streamId: 1,
      data: totalPayload.subarray(8 * 1024, 12 * 1024),
    });
    ws.receiveFrame({
      type: "data",
      streamId: 1,
      data: totalPayload.subarray(12 * 1024, 16 * 1024),
    });
    ws.receiveFrame({ type: "half_close", streamId: 1 });

    await allReceived;
    expect(Buffer.compare(Buffer.concat(receivedChunks), totalPayload)).toBe(0);
  });

  it("closes an idle tunnel session and tears down active TCP sockets after liveness timeout", async () => {
    const serverSockets: Socket[] = [];
    const { port } = await startTcpServer((socket) => attachKeepOpenHandler(serverSockets, socket));

    const ws = new InMemoryTunnelSocket();
    const session = new TunnelSession({
      ws,
      principalId: "owner",
      logger,
      idleTimeoutMs: 80,
      idleCheckIntervalMs: 20,
    });
    sessions.push(session);

    ws.receiveFrame({ type: "open", streamId: 1, host: "127.0.0.1", port });
    await ws.waitForFrame((frame) => frame.type === "opened" && frame.streamId === 1);
    expect(session.activeStreamCount).toBe(1);

    // Keep alive briefly with a ping; session must stay open while pings arrive.
    await new Promise((r) => setTimeout(r, 45));
    ws.receiveFrame({ type: "ping" });
    await ws.waitForFrame((frame) => frame.type === "pong");
    expect(session.isClosed).toBe(false);

    // Stop sending frames -> session closes and tears down the upstream TCP socket.
    await waitForSocketClose(serverSockets[0]!);
    expect(session.isClosed).toBe(true);
    expect(session.activeStreamCount).toBe(0);
    expect(ws.closes.at(-1)).toMatchObject({ code: 1001 });
  });
});
