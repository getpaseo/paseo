import { EventEmitter } from "node:events";
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

const openClientSecureChannelMock = vi.hoisted(() => vi.fn());

vi.mock("@getpaseo/relay/e2ee", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@getpaseo/relay/e2ee")>()),
  openClientSecureChannel: openClientSecureChannelMock,
}));

describe("daemon-client transport helpers", () => {
  test("createEncryptedTransport closes handshake failures with browser-safe code", async () => {
    openClientSecureChannelMock.mockReset();
    openClientSecureChannelMock.mockRejectedValueOnce(new Error("handshake failed"));

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
      { daemonPublicKeyB64: "daemon-public-key", logger: { warn: vi.fn() } },
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

describe("relay E2EE transport endpoint security", () => {
  interface ChannelEvents {
    onopen?: () => void;
    onmessage?: (data: string | ArrayBuffer) => void;
    onclose?: (code: number, reason: string) => void;
    onerror?: (error: Error) => void;
  }

  function serverInfoFrame(features: Record<string, boolean>): string {
    return JSON.stringify({
      type: "session",
      message: {
        type: "status",
        payload: { status: "server_info", serverId: "srv_test", features },
      },
    });
  }

  function setup(securityMode: "legacy" | "protected", minimumMode?: "protected") {
    openClientSecureChannelMock.mockReset();
    let events: ChannelEvents = {};
    let options: Record<string, unknown> = {};
    const channel = {
      securityMode: () => securityMode,
      close: vi.fn(),
      send: vi.fn(async () => {}),
      isOpen: () => true,
      outboundWireByteLength: () => 0,
      onTransitionToOpen: () => () => {},
      onClose: () => () => {},
    };
    openClientSecureChannelMock.mockImplementation(
      async (
        _transport: unknown,
        received: { events?: ChannelEvents } & Record<string, unknown>,
      ) => {
        events = received.events ?? {};
        options = received;
        return channel;
      },
    );

    const connection: { open: (() => void) | null } = { open: null };
    const modes: string[] = [];
    const transport = createEncryptedTransport(
      {
        send: vi.fn(),
        close: vi.fn(),
        onOpen: (handler) => {
          connection.open = handler;
          return () => {};
        },
        onClose: () => () => {},
        onError: () => () => {},
        onMessage: () => () => {},
      },
      {
        daemonPublicKeyB64: "daemon-public-key",
        logger: { warn: vi.fn() },
        ...(minimumMode ? { minimumMode } : {}),
        onSecurityMode: (mode) => modes.push(mode),
      },
    );
    const delivered: unknown[] = [];
    const closes: unknown[] = [];
    const errors: unknown[] = [];
    transport.onMessage((data) => delivered.push(data));
    transport.onClose((event) => closes.push(event));
    transport.onError((event) => errors.push(event));
    return {
      channel,
      connection,
      delivered,
      closes,
      errors,
      modes,
      events: () => events,
      options: () => options,
    };
  }

  test("rejects a legacy session once a protected-capable daemon identifies itself", async () => {
    const t = setup("legacy");
    t.connection.open?.();
    await vi.waitFor(() => expect(t.events().onopen).toBeDefined());
    t.events().onopen?.();
    expect(t.modes).toEqual(["legacy"]);

    t.events().onmessage?.(serverInfoFrame({ relayProtectedSecurity: true }));

    expect(t.delivered).toEqual([]);
    expect(t.channel.close).toHaveBeenCalledWith(4002, expect.stringContaining("protected"));
    expect(t.closes).toEqual([{ code: 4002, reason: expect.stringContaining("protected") }]);
    expect(t.errors).toHaveLength(1);
  });

  test("delivers server_info from a daemon that only speaks legacy security", async () => {
    const t = setup("legacy");
    t.connection.open?.();
    await vi.waitFor(() => expect(t.events().onopen).toBeDefined());
    t.events().onopen?.();

    const frame = serverInfoFrame({ connectedHosts: true });
    t.events().onmessage?.(frame);
    t.events().onmessage?.(JSON.stringify({ type: "pong" }));

    expect(t.delivered).toEqual([frame, JSON.stringify({ type: "pong" })]);
    expect(t.channel.close).not.toHaveBeenCalled();
  });

  test("passes the minimum mode to the handshake and reports a protected result", async () => {
    const t = setup("protected", "protected");
    t.connection.open?.();
    await vi.waitFor(() => expect(t.events().onopen).toBeDefined());
    t.events().onopen?.();
    t.events().onmessage?.(serverInfoFrame({ relayProtectedSecurity: true }));

    expect(t.options().minimumMode).toBe("protected");
    expect(t.modes).toEqual(["protected"]);
    expect(t.delivered).toHaveLength(1);
    expect(t.channel.close).not.toHaveBeenCalled();
  });
});
