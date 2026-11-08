import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { exportPublicKey, generateKeyPair } from "@getpaseo/relay/e2ee";
import { DaemonClient } from "./daemon-client.js";
import { defaultWebSocketFactory } from "./daemon-client-websocket-transport.js";
import {
  createEncryptedTransport,
  createWebSocketTransportFactory,
  decodeMessageData,
  describeTransportClose,
  describeTransportError,
  encodeUtf8String,
  extractRelayMessage,
} from "./daemon-client-transport.js";

describe("daemon-client transport helpers", () => {
  test("createEncryptedTransport closes handshake failures with browser-safe code", async () => {
    // An unusable daemon key fails the handshake before any frame is sent.
    const connection: { open: (() => void) | null } = { open: null };
    const close = vi.fn();

    createEncryptedTransport(
      {
        send: vi.fn(),
        close,
        onOpen: (handler) => {
          connection.open = handler;
          return () => {
            if (connection.open === handler) {
              connection.open = null;
            }
          };
        },
        onClose: () => () => {},
        onError: () => () => {},
        onMessage: () => () => {},
      },
      { daemonPublicKeyB64: "not-a-key", logger: { warn: vi.fn() } },
    );

    expect(connection.open).not.toBeNull();
    connection.open?.();

    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledWith(4001, "E2EE handshake failed");
    });
  });

  test("createWebSocketTransportFactory forwards sends when socket is open", () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const send = vi.fn();
    const close = vi.fn();

    const factory = createWebSocketTransportFactory(() => ({
      readyState: 1,
      send,
      close,
      binaryType: "blob",
      addEventListener,
      removeEventListener,
    }));

    const transport = factory({ url: "ws://example.test" });
    transport.send("hello");
    transport.close(1000, "bye");

    expect(send).toHaveBeenCalledWith("hello");
    expect(close).toHaveBeenCalledWith(1000, "bye");
  });

  test("createWebSocketTransportFactory passes WebSocket protocols to the socket factory", () => {
    const socketFactory = vi.fn(() => ({
      readyState: 1,
      send: vi.fn(),
      close: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));

    createWebSocketTransportFactory(socketFactory)({
      url: "ws://example.test",
      headers: { Authorization: "Bearer shared-secret" },
      protocols: ["paseo.bearer.shared-secret"],
    });

    expect(socketFactory).toHaveBeenCalledWith("ws://example.test", {
      headers: { Authorization: "Bearer shared-secret" },
      protocols: ["paseo.bearer.shared-secret"],
    });
  });

  test("createWebSocketTransportFactory rejects sends when socket is not open", () => {
    const factory = createWebSocketTransportFactory(() => ({
      readyState: 3,
      send: vi.fn(),
      close: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));

    const transport = factory({ url: "ws://example.test" });
    expect(() => transport.send("hello")).toThrow("WebSocket not open (readyState=3)");
  });

  test("createWebSocketTransportFactory binds and unbinds event listeners", () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const ws = {
      readyState: 1,
      send: vi.fn(),
      close: vi.fn(),
      addEventListener: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        listeners.set(event, handler);
      }),
      removeEventListener: vi.fn((event: string) => {
        listeners.delete(event);
      }),
    };

    const transport = createWebSocketTransportFactory(() => ws)({ url: "ws://example.test" });

    const onMessage = vi.fn();
    const unsubscribe = transport.onMessage(onMessage);

    const message = { data: "payload" };
    listeners.get("message")?.(message);
    expect(onMessage).toHaveBeenCalledWith("payload", false);

    unsubscribe();
    expect(ws.removeEventListener).toHaveBeenCalledWith("message", expect.any(Function));
  });

  test("createWebSocketTransportFactory suppresses close-before-open ws errors", () => {
    class MockNodeWebSocket extends EventEmitter {
      readyState = 0;
      send = vi.fn();
      close = vi.fn((code?: number, reason?: string) => {
        this.emit("error", new Error("WebSocket was closed before the connection was established"));
        this.emit("close", { code, reason });
      });
    }

    const ws = new MockNodeWebSocket();
    const transport = createWebSocketTransportFactory(() => ws)({ url: "ws://example.test" });

    expect(() => transport.close(1001, "Connection timed out")).not.toThrow();
  });

  test("describeTransportClose prefers reason, then message, then code", () => {
    expect(describeTransportClose({ reason: "peer closed" })).toBe("peer closed");
    expect(describeTransportClose({ message: "closed" })).toBe("closed");
    expect(describeTransportClose({ code: 1001 })).toBe("Transport closed (code 1001)");
    expect(describeTransportClose()).toBe("Transport closed");
  });

  test("describeTransportError returns normalized messages", () => {
    expect(describeTransportError(new Error("boom"))).toBe("boom");
    expect(describeTransportError({ message: "bad frame" })).toBe("bad frame");
    expect(describeTransportError()).toBe("Transport error");
  });

  test("extractRelayMessage preserves browser and Node WebSocket frame kind", () => {
    expect(extractRelayMessage({ data: "hello" })).toEqual({ data: "hello", isBinary: false });

    const view = new Uint8Array([1, 2, 3]);
    const binary = extractRelayMessage(view, true);
    expect(binary.isBinary).toBe(true);
    expect(Array.from(new Uint8Array(binary.data as ArrayBuffer))).toEqual([1, 2, 3]);

    const text = extractRelayMessage(view, false);
    expect(text).toEqual({ data: "\u0001\u0002\u0003", isBinary: false });
  });

  test("decodeMessageData decodes strings, array buffers, and typed arrays", () => {
    const bytes = encodeUtf8String("hello");
    expect(decodeMessageData("hello")).toBe("hello");
    expect(decodeMessageData(bytes.buffer)).toBe("hello");
    expect(decodeMessageData(bytes)).toBe("hello");
  });
});

test("native drain capability survives WebSocket and encryption wrappers", async () => {
  const { nativeWebSocketFactory } = await import("./daemon-client-websocket-transport.js");
  expect(nativeWebSocketFactory.supportsDrain).toBe(false);
  const factory = Object.assign(() => ({ readyState: 1, send() {}, close() {} }), {
    supportsDrain: false,
  });
  const base = createWebSocketTransportFactory(factory)({ url: "ws://test" });
  expect(base.supportsDrain).toBe(false);
  const encrypted = createEncryptedTransport(base, {
    daemonPublicKeyB64: "unused-key",
    logger: { warn() {} },
  });
  expect(encrypted.supportsDrain).toBe(false);
});

interface ObservedSocket {
  closeFrame: { code: number; reason: string } | null;
}

/** A daemon endpoint that accepts sockets and never answers, so every attempt times out. */
async function silentDaemon() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const sockets: ObservedSocket[] = [];
  server.on("connection", (socket: ServerSocket) => {
    const observed: ObservedSocket = { closeFrame: null };
    sockets.push(observed);
    socket.on("close", (code, reason) => {
      observed.closeFrame = { code, reason: reason.toString() };
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  return {
    url: `ws://127.0.0.1:${address.port}/ws`,
    sockets,
    openSockets: () => sockets.filter((entry) => entry.closeFrame === null),
    stop: () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) client.terminate();
        server.close(() => resolve());
      }),
  };
}

// Node's global WebSocket applies the WHATWG close rules Chromium and Electron apply:
// close() accepts only 1000 or 3000-4999 and a reason of at most 123 UTF-8 bytes.
describe("abandoned connections close their WebSocket", () => {
  test.each([
    { name: "direct", e2ee: false },
    { name: "relay E2EE", e2ee: true },
  ])(
    "$name: a timed-out attempt sends a close frame before the client reconnects",
    async ({ e2ee }) => {
      const daemon = await silentDaemon();
      const client = new DaemonClient({
        url: daemon.url,
        clientId: "cid_abandoned_close_test",
        webSocketFactory: defaultWebSocketFactory,
        connectTimeoutMs: 1_500,
        reconnect: { enabled: true, baseDelayMs: 50, maxDelayMs: 50 },
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        ...(e2ee
          ? {
              e2ee: {
                enabled: true,
                daemonPublicKeyB64: exportPublicKey(generateKeyPair().publicKey),
              },
            }
          : {}),
      });
      try {
        void client.connect().catch(() => {});
        await vi.waitFor(() => expect(daemon.sockets.length).toBeGreaterThanOrEqual(2), {
          timeout: 4_000,
        });
        const [abandoned] = daemon.sockets;
        await vi.waitFor(() => expect(abandoned?.closeFrame).not.toBeNull(), { timeout: 500 });
        expect(abandoned?.closeFrame?.reason).toBe("Connection timed out");

        // The newest attempt may still be connecting; aborting it closes without a frame.
        await client.close();
        await vi.waitFor(() => expect(daemon.openSockets()).toEqual([]), { timeout: 500 });
      } finally {
        await client.close();
        await daemon.stop();
      }
    },
    10_000,
  );

  test("a code or reason the WebSocket API rejects still closes the socket", async () => {
    const daemon = await silentDaemon();
    try {
      const transport = createWebSocketTransportFactory(defaultWebSocketFactory)({
        url: daemon.url,
      });
      await new Promise<void>((resolve) => transport.onOpen(() => resolve()));
      const reason = `Decryption failed: ${"é".repeat(100)}`;

      expect(() => transport.close(1011, reason)).not.toThrow();

      await vi.waitFor(() => expect(daemon.sockets[0]?.closeFrame).not.toBeNull(), {
        timeout: 500,
      });
      const frame = daemon.sockets[0]?.closeFrame;
      expect(frame?.code).toBe(1000);
      expect(reason.startsWith(frame?.reason ?? "")).toBe(true);
      expect(Buffer.byteLength(frame?.reason ?? "")).toBe(123);
    } finally {
      await daemon.stop();
    }
  });
});
