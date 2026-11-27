import { Duplex, PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import {
  decodeNetworkTunnelFrame,
  encodeNetworkTunnelFrame,
  NetworkTunnelCloseReason,
  type DecodedNetworkTunnelFrame,
  type NetworkTunnelFrame,
} from "@getpaseo/protocol/network-tunnel";
import { TunnelMuxClient } from "./tunnel-mux.js";
import type { TunnelWireConnection } from "./tunnel-transport.js";

function createFakeWire(ready?: Partial<TunnelWireConnection["ready"]>) {
  const sentFrames: DecodedNetworkTunnelFrame[] = [];
  const binaryListeners = new Set<(bytes: Uint8Array) => void>();
  const closeListeners = new Set<(error?: Error) => void>();
  let closed = false;

  const wire: TunnelWireConnection = {
    ready: {
      maxFramePayloadBytes: ready?.maxFramePayloadBytes ?? 64 * 1024,
      initialStreamWindowBytes: ready?.initialStreamWindowBytes ?? 64 * 1024,
      initialConnectionWindowBytes: ready?.initialConnectionWindowBytes ?? 256 * 1024,
    },
    sendBinary: async (bytes) => {
      if (closed) throw new Error("Wire closed");
      sentFrames.push(decodeNetworkTunnelFrame(bytes));
    },
    onBinary: (handler) => {
      binaryListeners.add(handler);
      return () => binaryListeners.delete(handler);
    },
    onClose: (handler) => {
      closeListeners.add(handler);
      return () => closeListeners.delete(handler);
    },
    close: () => {
      if (closed) return;
      closed = true;
      for (const listener of closeListeners) listener();
    },
  };

  return {
    wire,
    sentFrames,
    injectFrame: (frame: NetworkTunnelFrame) => {
      const encoded = encodeNetworkTunnelFrame(frame);
      for (const listener of binaryListeners) listener(encoded);
    },
    drop: (error?: Error) => {
      if (closed) return;
      closed = true;
      for (const listener of closeListeners) listener(error);
    },
  };
}

function createSocketPair(): { client: Duplex; server: Duplex } {
  const aToB = new PassThrough();
  const bToA = new PassThrough();

  const client = new Duplex({
    read() {},
    write(chunk, encoding, cb) {
      aToB.write(chunk, encoding, cb);
    },
    final(cb) {
      aToB.end(cb);
    },
  });
  bToA.on("data", (chunk) => client.push(chunk));
  bToA.on("end", () => client.push(null));

  const server = new Duplex({
    read() {},
    write(chunk, encoding, cb) {
      bToA.write(chunk, encoding, cb);
    },
    final(cb) {
      bToA.end(cb);
    },
  });
  aToB.on("data", (chunk) => server.push(chunk));
  aToB.on("end", () => server.push(null));

  return { client, server };
}

describe("TunnelMuxClient", () => {
  test("opens a stream, exchanges bidirectional data, respects credit windows, and handles half-close", async () => {
    const fake = createFakeWire({
      maxFramePayloadBytes: 4,
      initialStreamWindowBytes: 8,
      initialConnectionWindowBytes: 16,
    });
    const mux = new TunnelMuxClient(fake.wire);
    const { client, server } = createSocketPair();

    const openPromise = mux.openStream({
      host: "localhost",
      port: 3000,
      socket: server,
      initialData: Buffer.from("0123456789"), // 10 bytes > initialStreamWindowBytes (8)
    });

    expect(fake.sentFrames[0]).toMatchObject({
      type: "open",
      streamId: 1,
      host: "localhost",
      port: 3000,
    });

    fake.injectFrame({ type: "opened", streamId: 1, initialWindowBytes: 8 });
    const openResult = await openPromise;
    expect(openResult).toEqual({ ok: true });

    // Only 8 bytes (in two 4-byte chunks) should be sent until window update arrives!
    await Promise.resolve();
    const dataFramesBefore = fake.sentFrames.filter((f) => f.type === "data");
    const sentBefore = Buffer.concat(dataFramesBefore.map((f) => Buffer.from(f.data))).toString();
    expect(sentBefore).toBe("01234567");

    // Grant more stream credit -> remaining "89" flushes!
    fake.injectFrame({ type: "window_update", streamId: 1, creditBytes: 8 });
    await Promise.resolve();
    const dataFramesAfter = fake.sentFrames.filter((f) => f.type === "data");
    const sentAfter = Buffer.concat(dataFramesAfter.map((f) => Buffer.from(f.data))).toString();
    expect(sentAfter).toBe("0123456789");

    // Remote sends data + half_close -> client socket receives exact bytes + EOF
    const received: Buffer[] = [];
    const clientEnded = new Promise<void>((resolve) => {
      client.on("data", (chunk: Buffer) => received.push(chunk));
      client.on("end", () => resolve());
    });
    fake.injectFrame({ type: "data", streamId: 1, data: Buffer.from("HTTP/1.1 200 OK") });
    fake.injectFrame({ type: "half_close", streamId: 1 });
    await clientEnded;
    expect(Buffer.concat(received).toString()).toBe("HTTP/1.1 200 OK");

    // Client sends EOF -> mux sends HalfClose + Close (both halves closed)
    client.end();
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.sentFrames.some((f) => f.type === "half_close" && f.streamId === 1)).toBe(true);
  });

  test("returns daemon Close reason when Open is rejected", async () => {
    const fake = createFakeWire();
    const mux = new TunnelMuxClient(fake.wire);
    const { server } = createSocketPair();

    const openPromise = mux.openStream({
      host: "169.254.169.254",
      port: 80,
      socket: server,
    });
    fake.injectFrame({
      type: "close",
      streamId: 1,
      reason: NetworkTunnelCloseReason.PolicyDenied,
      message: "Blocked metadata IP",
    });

    expect(await openPromise).toEqual({
      ok: false,
      reason: NetworkTunnelCloseReason.PolicyDenied,
      message: "Blocked metadata IP",
    });
  });

  test("replies Pong to Ping frames and tears down active streams on wire drop", async () => {
    const fake = createFakeWire();
    const mux = new TunnelMuxClient(fake.wire);
    const { server } = createSocketPair();

    fake.injectFrame({ type: "ping", payload: Buffer.from("abc") });
    await Promise.resolve();
    expect(fake.sentFrames.at(-1)).toMatchObject({
      type: "pong",
      payload: new Uint8Array(Buffer.from("abc")),
    });

    const openPromise = mux.openStream({ host: "localhost", port: 8080, socket: server });
    fake.injectFrame({ type: "opened", streamId: 1, initialWindowBytes: 1024 });
    await openPromise;

    const destroyed = new Promise<void>((resolve) => server.once("close", () => resolve()));
    fake.drop(new Error("socket dropped"));
    await destroyed;
    expect(mux.isClosed()).toBe(true);
  });

  test("recovers connection receive credit when a backpressured socket is destroyed before drain without accumulating drain listeners", async () => {
    const fake = createFakeWire({
      maxFramePayloadBytes: 64,
      initialStreamWindowBytes: 256,
      initialConnectionWindowBytes: 128,
    });
    const mux = new TunnelMuxClient(fake.wire);

    const stalledSocket = new Duplex({
      highWaterMark: 1,
      read() {},
      write(_chunk, _encoding, _cb) {
        // Hold write callbacks indefinitely to trigger backpressure without draining.
      },
    });

    const openPromise = mux.openStream({
      host: "localhost",
      port: 3000,
      socket: stalledSocket,
    });
    fake.injectFrame({ type: "opened", streamId: 1, initialWindowBytes: 256 });
    expect(await openPromise).toEqual({ ok: true });

    // Send 3 backpressured chunks totaling 96 bytes (>= 64 byte connection window threshold).
    fake.injectFrame({ type: "data", streamId: 1, data: Buffer.alloc(32, 0x61) });
    fake.injectFrame({ type: "data", streamId: 1, data: Buffer.alloc(32, 0x62) });
    fake.injectFrame({ type: "data", streamId: 1, data: Buffer.alloc(32, 0x63) });

    // Only a single persistent drain listener should be attached to the socket.
    expect(stalledSocket.listenerCount("drain")).toBe(1);
    expect(fake.sentFrames.filter((f) => f.type === "window_update" && f.streamId === 0)).toEqual(
      [],
    );

    // Destroy socket before drain fires -> pendingDrainBytes must be credited back to stream 0.
    stalledSocket.destroy();
    await new Promise((r) => setTimeout(r, 10));

    expect(stalledSocket.listenerCount("drain")).toBe(0);
    expect(
      fake.sentFrames.filter((f) => f.type === "window_update" && f.streamId === 0),
    ).toMatchObject([
      {
        type: "window_update",
        streamId: 0,
        creditBytes: 96,
      },
    ]);
  });

  test("emits half_close only once even when WindowUpdate arrives afterward", async () => {
    const fake = createFakeWire({
      maxFramePayloadBytes: 16,
      initialStreamWindowBytes: 32,
      initialConnectionWindowBytes: 64,
    });
    const mux = new TunnelMuxClient(fake.wire);
    const { client, server } = createSocketPair();

    const openPromise = mux.openStream({
      host: "localhost",
      port: 3000,
      socket: server,
    });
    fake.injectFrame({ type: "opened", streamId: 1, initialWindowBytes: 16 });
    expect(await openPromise).toEqual({ ok: true });

    // Local side finishes writing (EOF) while remote side stays open.
    client.end();
    await new Promise((r) => setTimeout(r, 10));

    expect(fake.sentFrames.filter((f) => f.type === "half_close" && f.streamId === 1)).toHaveLength(
      1,
    );

    // Subsequent stream-level and connection-level WindowUpdates must not emit duplicate half_close frames.
    fake.injectFrame({ type: "window_update", streamId: 1, creditBytes: 16 });
    fake.injectFrame({ type: "window_update", streamId: 0, creditBytes: 32 });
    await new Promise((r) => setTimeout(r, 10));

    expect(fake.sentFrames.filter((f) => f.type === "half_close" && f.streamId === 1)).toHaveLength(
      1,
    );
  });

  test("sends heartbeat pings and closes a silent half-open wire after heartbeatTimeoutMs", async () => {
    const fake = createFakeWire();
    const mux = new TunnelMuxClient(fake.wire, {
      heartbeatIntervalMs: 25,
      heartbeatTimeoutMs: 65,
    });

    const closed = new Promise<Error | undefined>((resolve) => {
      mux.onClose((err) => resolve(err));
    });

    const closeErr = await closed;
    expect(mux.isClosed()).toBe(true);
    expect(fake.sentFrames.some((f) => f.type === "ping")).toBe(true);
    expect(closeErr?.message).toMatch(/heartbeat/i);
  });

  test("closes an unresponsive wire when openStream times out with zero inbound frames", async () => {
    const fake = createFakeWire();
    const mux = new TunnelMuxClient(fake.wire, {
      heartbeatIntervalMs: 0,
      heartbeatTimeoutMs: 0,
    });
    const { server } = createSocketPair();

    const result = await mux.openStream({
      host: "localhost",
      port: 3000,
      socket: server,
      timeoutMs: 30,
    });

    expect(result).toMatchObject({ ok: false, reason: NetworkTunnelCloseReason.Timeout });
    expect(mux.isClosed()).toBe(true);
  });
});
