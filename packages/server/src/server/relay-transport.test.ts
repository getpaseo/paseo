import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const wsMock = vi.hoisted(() => {
  class MockWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    static instances: MockWebSocket[] = [];

    readonly url: string;
    readonly options: unknown;
    readyState = MockWebSocket.CONNECTING;
    sent: string[] = [];
    terminateCalls = 0;
    private listeners = new Map<string, Array<(...args: any[]) => void>>();

    constructor(url: string, options?: unknown) {
      this.url = url;
      this.options = options;
      MockWebSocket.instances.push(this);
    }

    static reset() {
      MockWebSocket.instances = [];
    }

    on(event: string, listener: (...args: any[]) => void) {
      const handlers = this.listeners.get(event) ?? [];
      handlers.push(listener);
      this.listeners.set(event, handlers);
      return this;
    }

    once(event: string, listener: (...args: any[]) => void) {
      const wrapped = (...args: any[]) => {
        this.off(event, wrapped);
        listener(...args);
      };
      return this.on(event, wrapped);
    }

    close(code?: number, reason?: string) {
      this.readyState = MockWebSocket.CLOSED;
      this.emit("close", code ?? 1000, reason ?? "");
    }

    terminate() {
      this.terminateCalls += 1;
      this.readyState = MockWebSocket.CLOSED;
      this.emit("close", 1006, "");
    }

    send(data: string) {
      if (this.readyState !== MockWebSocket.OPEN) {
        throw new Error(`WebSocket not open (readyState=${this.readyState})`);
      }
      this.sent.push(data);
    }

    open() {
      this.readyState = MockWebSocket.OPEN;
      this.emit("open");
    }

    message(data: unknown) {
      this.emit("message", data);
    }

    error(err: unknown) {
      this.emit("error", err);
    }

    private off(event: string, listener: (...args: any[]) => void) {
      const handlers = this.listeners.get(event) ?? [];
      this.listeners.set(
        event,
        handlers.filter((handler) => handler !== listener)
      );
    }

    private emit(event: string, ...args: any[]) {
      const handlers = this.listeners.get(event) ?? [];
      for (const handler of [...handlers]) {
        handler(...args);
      }
    }
  }

  return { MockWebSocket };
});

vi.mock("ws", () => ({ default: wsMock.MockWebSocket }));

import { startRelayTransport } from "./relay-transport";

function createMockLogger() {
  const logger = {
    child: vi.fn(() => logger),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

function hasLogMessage(mockFn: ReturnType<typeof vi.fn>, message: string): boolean {
  return mockFn.mock.calls.some((call) => call.some((arg) => arg === message));
}

describe("relay-transport control lifecycle", () => {
  const controllers: Array<{ stop: () => Promise<void> }> = [];
  const MockWebSocket = wsMock.MockWebSocket;

  beforeEach(() => {
    MockWebSocket.reset();
  });

  afterEach(async () => {
    for (const controller of controllers) {
      await controller.stop();
    }
    controllers.length = 0;
    vi.useRealTimers();
  });

  test("logs relay_control_connected only after first valid control message", () => {
    const logger = createMockLogger();
    const controller = startRelayTransport({
      logger: logger as any,
      attachSocket: async () => {},
      relayEndpoint: "relay.paseo.sh:443",
      serverId: "srv_test",
    });
    controllers.push(controller);

    const control = MockWebSocket.instances[0];
    expect(control).toBeDefined();

    control.open();
    expect(hasLogMessage(logger.info, "relay_control_connected")).toBe(false);
    expect(control.sent.length).toBeGreaterThan(0);

    control.message(JSON.stringify({ type: "pong", ts: Date.now() }));
    expect(hasLogMessage(logger.info, "relay_control_connected")).toBe(true);
  });

  test("terminates and reconnects when control socket opens but never becomes ready", () => {
    vi.useFakeTimers();
    const logger = createMockLogger();
    const controller = startRelayTransport({
      logger: logger as any,
      attachSocket: async () => {},
      relayEndpoint: "relay.paseo.sh:443",
      serverId: "srv_test",
    });
    controllers.push(controller);

    const firstControl = MockWebSocket.instances[0];
    firstControl.open();

    vi.advanceTimersByTime(8_000);
    expect(hasLogMessage(logger.warn, "relay_control_ready_timeout_terminating")).toBe(true);
    expect(firstControl.terminateCalls).toBe(1);

    vi.advanceTimersByTime(1_000);
    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);
  });

  test("terminates stale control sockets in under one minute", () => {
    vi.useFakeTimers();
    const logger = createMockLogger();
    const controller = startRelayTransport({
      logger: logger as any,
      attachSocket: async () => {},
      relayEndpoint: "relay.paseo.sh:443",
      serverId: "srv_test",
    });
    controllers.push(controller);

    const control = MockWebSocket.instances[0];
    control.open();
    control.message(JSON.stringify({ type: "pong", ts: Date.now() }));
    logger.warn.mockClear();

    vi.advanceTimersByTime(40_000);
    expect(hasLogMessage(logger.warn, "relay_control_stale_terminating")).toBe(true);
    expect(control.terminateCalls).toBe(1);
  });

  test("passes stable relay external session metadata when attaching data socket", async () => {
    const logger = createMockLogger();
    const attachSocket = vi.fn(async () => {});
    const controller = startRelayTransport({
      logger: logger as any,
      attachSocket,
      relayEndpoint: "relay.paseo.sh:443",
      serverId: "srv_test",
    });
    controllers.push(controller);

    const control = MockWebSocket.instances[0];
    control.open();
    control.message(JSON.stringify({ type: "pong", ts: Date.now() }));
    control.message(JSON.stringify({ type: "client_connected", clientId: "clt_test" }));

    const dataSocket = MockWebSocket.instances[1];
    expect(dataSocket).toBeDefined();
    dataSocket.open();

    await Promise.resolve();

    expect(attachSocket).toHaveBeenCalledTimes(1);
    expect(attachSocket).toHaveBeenCalledWith(
      dataSocket,
      {
        transport: "relay",
        externalSessionKey: "relay:clt_test",
      }
    );
  });
});
