import { EventEmitter } from "node:events";
import { expect, test } from "vitest";
import { MAX_PHYSICAL_SOCKET_BUFFERED_BYTES } from "./physical-socket.js";
import {
  createEncryptedRelaySocket,
  type EncryptedRelayChannel,
} from "./encrypted-relay-socket.js";

class BlockingChannel implements EncryptedRelayChannel {
  readonly sent: Array<string | ArrayBuffer> = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  private resolveSend: (() => void) | null = null;

  send(data: string | ArrayBuffer): Promise<void> {
    this.sent.push(data);
    return new Promise((resolve) => {
      this.resolveSend = resolve;
    });
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
  }

  outboundWireByteLength(data: string | ArrayBuffer): number {
    const plaintextBytes =
      typeof data === "string" ? new TextEncoder().encode(data).byteLength : data.byteLength;
    return plaintextBytes + 40;
  }

  drain(): void {
    this.resolveSend?.();
  }
}

test("negotiated binary ciphertext accepts the exact hard bound and rejects one byte over", async () => {
  const channel = new BlockingChannel();
  let terminations = 0;
  let transportBufferedAmount = 0;
  const socket = createEncryptedRelaySocket({
    channel,
    emitter: new EventEmitter(),
    getTransportBufferedAmount: () => transportBufferedAmount,
    terminateTransport: () => {
      terminations += 1;
    },
  });

  socket.send(new Uint8Array(MAX_PHYSICAL_SOCKET_BUFFERED_BYTES - 40));
  expect(channel.sent).toHaveLength(1);
  transportBufferedAmount = MAX_PHYSICAL_SOCKET_BUFFERED_BYTES;
  expect(socket.bufferedAmount).toBe(MAX_PHYSICAL_SOCKET_BUFFERED_BYTES);

  const rejected = socket.send(new Uint8Array(1));
  await expect(rejected).rejects.toThrow("outbound high-water mark");

  expect(channel.sent).toHaveLength(1);
  expect(terminations).toBe(1);
  expect(channel.closes).toEqual([]);
  expect(socket.readyState).toBe(3);

  channel.drain();
  await Promise.resolve();
});

test("underlying relay backpressure rejects binary before encryption and terminates physically", async () => {
  const channel = new BlockingChannel();
  let terminations = 0;
  const socket = createEncryptedRelaySocket({
    channel,
    emitter: new EventEmitter(),
    getTransportBufferedAmount: () => MAX_PHYSICAL_SOCKET_BUFFERED_BYTES - 1,
    terminateTransport: () => {
      terminations += 1;
    },
  });

  const rejected = socket.send(new Uint8Array(1));
  await expect(rejected).rejects.toThrow("outbound high-water mark");

  expect(channel.sent).toEqual([]);
  expect(channel.closes).toEqual([]);
  expect(terminations).toBe(1);
});

test("explicit encrypted-socket termination forcibly terminates the relay transport", () => {
  const channel = new BlockingChannel();
  let terminations = 0;
  const socket = createEncryptedRelaySocket({
    channel,
    emitter: new EventEmitter(),
    getTransportBufferedAmount: () => 0,
    terminateTransport: () => {
      terminations += 1;
    },
  });

  socket.terminate();

  expect(terminations).toBe(1);
  expect(channel.closes).toEqual([]);
  expect(socket.readyState).toBe(3);
});

test("encrypted sends report physical completion through the returned promise", async () => {
  const channel = new BlockingChannel();
  const socket = createEncryptedRelaySocket({
    channel,
    emitter: new EventEmitter(),
    getTransportBufferedAmount: () => 0,
    terminateTransport: () => undefined,
  });
  let completed = false;

  const sending = socket.send(new Uint8Array([1]));
  if (!sending) throw new Error("Expected an awaitable encrypted send");
  void sending.then(() => (completed = true));
  await Promise.resolve();
  expect(completed).toBe(false);

  channel.drain();
  await sending;
  expect(completed).toBe(true);
  expect(socket.bufferedAmount).toBe(0);
});

test("encrypted sockets do not double-count bytes already buffered by the transport", () => {
  const channel = new BlockingChannel();
  let transportBufferedAmount = 0;
  const socket = createEncryptedRelaySocket({
    channel,
    emitter: new EventEmitter(),
    getTransportBufferedAmount: () => transportBufferedAmount,
    terminateTransport: () => undefined,
  });
  const payload = new Uint8Array(3 * 1024 * 1024);

  void socket.send(payload);
  transportBufferedAmount = payload.byteLength + 40;

  expect(socket.bufferedAmount).toBe(payload.byteLength + 40);
});

test("50 MiB logical text and routed binary cross encrypted relay frames in both directions", async () => {
  const { ChunkedTransport } = await import("@getpaseo/protocol/chunked-transport");
  const { openClientSecureChannel, openDaemonSecureChannel } = await import("@getpaseo/relay/e2ee");
  const { generateKeyPair, exportPublicKey, maxSecuredPlaintextByteLength } =
    await import("@getpaseo/relay");
  const { encodeHostRouteFrame, decodeHostRouteFrame } =
    await import("@getpaseo/protocol/binary-frames/index");
  type Transport = import("@getpaseo/relay/e2ee").Transport;
  const limit = 32 * 1024 * 1024;
  const wireSizes: number[] = [];
  const endpoint = (): Transport => ({
    send: () => {},
    close: () => {},
    onmessage: null,
    onclose: null,
    onerror: null,
  });
  const left = endpoint();
  const right = endpoint();
  const wire = (destination: Transport) => (data: string | ArrayBuffer) => {
    const size = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
    expect(size).toBeLessThanOrEqual(limit);
    wireSizes.push(size);
    queueMicrotask(() => destination.onmessage?.({ data, isBinary: typeof data !== "string" }));
  };
  left.send = wire(right);
  right.send = wire(left);
  const key = generateKeyPair();
  const delivered: (string | Uint8Array)[][] = [[], []];
  let receivers: InstanceType<typeof ChunkedTransport>[] = [];
  const incoming = (index: number) => (data: string | ArrayBuffer) =>
    receivers[index]!.receive(typeof data === "string" ? data : new Uint8Array(data));
  const daemonPromise = openDaemonSecureChannel(right, {
    daemonKeyPair: key,
    events: { onmessage: incoming(1) },
  });
  const client = await openClientSecureChannel(left, {
    daemonPublicKeyB64: exportPublicKey(key.publicKey),
    events: { onmessage: incoming(0) },
  });
  const daemon = await daemonPromise;
  receivers = [client, daemon].map(
    (channel, index) =>
      new ChunkedTransport({
        frameBytes: maxSecuredPlaintextByteLength(limit),
        send: (frame) => channel.send(typeof frame === "string" ? frame : frame.slice().buffer),
        deliver: (frame) => {
          delivered[index]!.push(frame);
        },
      }),
  );
  for (const receiver of receivers) receiver.enabled = true;
  const text = "x".repeat(50 * 1024 * 1024);
  wireSizes.length = 0;
  await receivers[1]!.send(text);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(delivered[0]).toEqual([text]);
  expect(wireSizes.length).toBeGreaterThan(1);
  const routed = encodeHostRouteFrame("route", new Uint8Array(50 * 1024 * 1024).fill(7));
  await receivers[0]!.send(routed);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(delivered[1]).toHaveLength(1);
  const received = decodeHostRouteFrame(delivered[1]![0] as Uint8Array)!;
  expect(received.routeId).toBe("route");
  expect(
    Buffer.from(received.payload).equals(Buffer.from(new Uint8Array(50 * 1024 * 1024).fill(7))),
  ).toBe(true);
  client.close();
  daemon.close();
}, 30_000);
