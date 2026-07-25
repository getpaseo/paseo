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

  drain(): void {
    this.resolveSend?.();
  }
}

test("the encrypted send queue terminates its physical transport at the hard bound", async () => {
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

  socket.send(new Uint8Array(5 * 1024 * 1024));
  expect(channel.sent).toHaveLength(1);
  expect(socket.bufferedAmount).toBeGreaterThan(5 * 1024 * 1024);

  socket.send(new Uint8Array(2 * 1024 * 1024));

  expect(channel.sent).toHaveLength(1);
  expect(terminations).toBe(1);
  expect(channel.closes).toEqual([]);
  expect(socket.readyState).toBe(3);

  channel.drain();
  await Promise.resolve();
});

test("underlying relay backpressure rejects binary before encryption and terminates physically", () => {
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

  socket.send(new Uint8Array(1));

  expect(channel.sent).toEqual([]);
  expect(channel.closes).toEqual([]);
  expect(terminations).toBe(1);
});

test("pending encryption and underlying relay backpressure share one hard bound", () => {
  const channel = new BlockingChannel();
  let transportBufferedAmount = 3 * 1024 * 1024;
  let terminations = 0;
  const socket = createEncryptedRelaySocket({
    channel,
    emitter: new EventEmitter(),
    getTransportBufferedAmount: () => transportBufferedAmount,
    terminateTransport: () => {
      terminations += 1;
    },
  });

  socket.send(new Uint8Array(3 * 1024 * 1024));
  expect(channel.sent).toHaveLength(1);

  transportBufferedAmount = 4 * 1024 * 1024;
  socket.send(new Uint8Array(1));

  expect(channel.sent).toHaveLength(1);
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
