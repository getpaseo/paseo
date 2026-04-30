import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vitest";
import {
  createEncryptedTransport,
  createWebSocketTransportFactory,
  decodeMessageData,
  describeTransportClose,
  describeTransportError,
  encodeUtf8String,
  extractRelayMessageData,
} from "./daemon-client-transport.js";

const createClientChannelMock = vi.hoisted(() => vi.fn());

vi.mock("@getpaseo/relay/e2ee", () => ({
  createClientChannel: createClientChannelMock,
}));

describe("daemon-client transport helpers", () => {
  test("createEncryptedTransport closes handshake failures with browser-safe code", async () => {
    createClientChannelMock.mockReset();
    createClientChannelMock.mockRejectedValueOnce(new Error("handshake failed"));

    let openHandler: (() => void) | null = null;
    const close = vi.fn();

    createEncryptedTransport(
      {
        send: vi.fn(),
        close,
        onOpen: (handler) => {
          openHandler = handler;
          return () => {
            if (openHandler === handler) {
              openHandler = null;
            }
          };
        },
        onClose: () => () => {},
        onError: () => () => {},
        onMessage: () => () => {},
      },
      "daemon-public-key",
      { warn: vi.fn() },
    );

    expect(openHandler).not.toBeNull();
    openHandler?.();

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
    expect(onMessage).toHaveBeenCalledWith(message);

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

  test("extractRelayMessageData returns strings and array buffers", () => {
    expect(extractRelayMessageData({ data: "hello" })).toBe("hello");

    const view = new Uint8Array([1, 2, 3]);
    const extracted = extractRelayMessageData({ data: view });
    expect(extracted).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(new Uint8Array(extracted as ArrayBuffer))).toEqual([1, 2, 3]);
  });

  test("decodeMessageData decodes strings, array buffers, and typed arrays", () => {
    const bytes = encodeUtf8String("hello");
    expect(decodeMessageData("hello")).toBe("hello");
    expect(decodeMessageData(bytes.buffer)).toBe("hello");
    expect(decodeMessageData(bytes)).toBe("hello");
  });
});
