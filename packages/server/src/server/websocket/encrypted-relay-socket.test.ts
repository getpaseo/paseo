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

  setState(state: "open"): void {
    expect(state).toBe("open");
  }

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
