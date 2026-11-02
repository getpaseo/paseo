import { EventEmitter } from "node:events";
import { MAX_RELAY_WEBSOCKET_MESSAGE_BYTES } from "@getpaseo/protocol/websocket-message-limit";
import { describe, expect, test, vi } from "vitest";
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

  test("createEncryptedTransport sends compressed binary frames once deflatePayloads is negotiated", async () => {
    const relay =
      await vi.importActual<typeof import("@getpaseo/relay/e2ee")>("@getpaseo/relay/e2ee");
    const daemonKeyPair = relay.generateKeyPair();
    const sent: Array<string | ArrayBuffer> = [];
    const handlers: {
      open: (() => void) | null;
      message: ((data: unknown, isBinary: boolean) => void) | null;
    } = { open: null, message: null };

    const received: Array<string | ArrayBuffer> = [];
    const daemonTransport: import("@getpaseo/relay/e2ee").Transport = {
      send: (data) => {
        setTimeout(() => handlers.message?.(data, data instanceof ArrayBuffer), 0);
      },
      close: vi.fn(),
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    const daemonPromise = relay.openDaemonSecureChannel(daemonTransport, {
      daemonKeyPair,
      events: { onmessage: (data) => received.push(data) },
    });
    const transport = createEncryptedTransport(
      {
        send: (data) => {
          sent.push(data as string | ArrayBuffer);
          setTimeout(
            () =>
              daemonTransport.onmessage?.({
                data: data as string | ArrayBuffer,
                isBinary: data instanceof ArrayBuffer,
              }),
            0,
          );
        },
        close: vi.fn(),
        onOpen: (handler) => {
          handlers.open = handler;
          return () => {};
        },
        onClose: () => () => {},
        onError: () => () => {},
        onMessage: (handler) => {
          handlers.message = handler;
          return () => {};
        },
      },
      {
        daemonPublicKeyB64: relay.exportPublicKey(daemonKeyPair.publicKey),
        logger: { warn: vi.fn() },
      },
    );
    const opened = vi.fn();
    transport.onOpen(opened);
    handlers.open?.();
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(JSON.parse(sent[0] as string)).toMatchObject({
      type: "e2ee_hello",
      capabilities: { binaryCiphertext: true, deflatePayloads: true },
    });
    const daemon = await daemonPromise;
    expect(daemon.securityMode()).toBe("protected");
    await vi.waitFor(() => {
      expect(opened).toHaveBeenCalled();
    });

    const page = JSON.stringify(
      Array.from({ length: 2000 }, (_, seq) => ({ seq, type: "assistant_message", text: "ok" })),
    );
    transport.send(page);
    await vi.waitFor(() => {
      expect(sent).toHaveLength(2);
    });
    await vi.waitFor(() => expect(received).toEqual([page]));
    expect(sent[1]).toBeInstanceOf(ArrayBuffer);
    expect((sent[1] as ArrayBuffer).byteLength).toBeLessThan(page.length / 4);

    // The size check bounds the uncompressed payload, matching the receiver's inflate limit.
    expect(() => transport.send("x".repeat(MAX_RELAY_WEBSOCKET_MESSAGE_BYTES))).toThrow(
      "Message is too large to send",
    );
    expect(sent).toHaveLength(2);
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
