import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const wsModuleMock = vi.hoisted(() => {
  class MockWebSocketServer {
    static instances: MockWebSocketServer[] = [];
    readonly handlers = new Map<string, (...args: any[]) => void>();

    constructor(_options: unknown) {
      MockWebSocketServer.instances.push(this);
    }

    on(event: string, handler: (...args: any[]) => void) {
      this.handlers.set(event, handler);
      return this;
    }

    close() {
      // no-op
    }
  }

  return { MockWebSocketServer };
});

const sessionMock = vi.hoisted(() => {
  const instances: MockSession[] = [];

  class MockSession {
    cleanup = vi.fn(async () => {});
    handleMessage = vi.fn(async () => {});
    getClientActivity = vi.fn(() => null);
    readonly args: Record<string, unknown>;

    constructor(args: Record<string, unknown>) {
      this.args = args;
      instances.push(this);
    }
  }

  return { MockSession, instances };
});

vi.mock("ws", () => ({
  WebSocketServer: wsModuleMock.MockWebSocketServer,
}));

vi.mock("./session.js", () => ({
  Session: sessionMock.MockSession,
}));

vi.mock("./push/token-store.js", () => ({
  PushTokenStore: class {
    getAllTokens(): string[] {
      return [];
    }
  },
}));

vi.mock("./push/push-service.js", () => ({
  PushService: class {
    async sendPush(): Promise<void> {
      // no-op
    }
  },
}));

import {
  VoiceAssistantWebSocketServer,
  type ExternalSocketMetadata,
} from "./websocket-server";

class MockSocket {
  readyState = 1;
  sent: string[] = [];
  private listeners = new Map<string, Array<(...args: any[]) => void>>();

  on(event: "message" | "close" | "error", listener: (...args: any[]) => void): void {
    const handlers = this.listeners.get(event) ?? [];
    handlers.push(listener);
    this.listeners.set(event, handlers);
  }

  once(event: "close" | "error", listener: (...args: any[]) => void): void {
    const wrapped = (...args: any[]) => {
      this.off(event, wrapped);
      listener(...args);
    };
    this.on(event, wrapped);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.emit("close", code ?? 1000, reason ?? "");
  }

  emit(event: "message" | "close" | "error", ...args: any[]): void {
    const handlers = this.listeners.get(event) ?? [];
    for (const handler of [...handlers]) {
      handler(...args);
    }
  }

  private off(event: "close" | "error", listener: (...args: any[]) => void): void {
    const handlers = this.listeners.get(event) ?? [];
    this.listeners.set(
      event,
      handlers.filter((handler) => handler !== listener)
    );
  }
}

function createLogger() {
  const logger = {
    child: vi.fn(() => logger),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

function createServer() {
  return new VoiceAssistantWebSocketServer(
    {} as any,
    createLogger() as any,
    "srv_test",
    {
      setAgentAttentionCallback: vi.fn(),
      getAgent: vi.fn(() => null),
    } as any,
    {} as any,
    {} as any,
    "/tmp/paseo-test",
    async () => ({} as any),
    { allowedOrigins: new Set() }
  );
}

describe("relay external socket reconnect behavior", () => {
  beforeEach(() => {
    sessionMock.instances.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("keeps the same session when relay reconnects within grace window", async () => {
    const server = createServer();
    const metadata: ExternalSocketMetadata = {
      transport: "relay",
      externalSessionKey: "relay:client-1",
    };

    const socket1 = new MockSocket();
    await server.attachExternalSocket(socket1, metadata);
    expect(sessionMock.instances).toHaveLength(1);
    const session = sessionMock.instances[0]!;

    socket1.emit("close", 1006, "");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(session.cleanup).not.toHaveBeenCalled();

    const socket2 = new MockSocket();
    await server.attachExternalSocket(socket2, metadata);
    expect(sessionMock.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(session.cleanup).not.toHaveBeenCalled();

    await server.close();
  });

  test("cleans up relay session when reconnect grace expires", async () => {
    const server = createServer();
    const metadata: ExternalSocketMetadata = {
      transport: "relay",
      externalSessionKey: "relay:client-2",
    };

    const socket1 = new MockSocket();
    await server.attachExternalSocket(socket1, metadata);
    expect(sessionMock.instances).toHaveLength(1);
    const session = sessionMock.instances[0]!;

    socket1.emit("close", 1006, "");
    await vi.advanceTimersByTimeAsync(90_000);
    expect(session.cleanup).toHaveBeenCalledTimes(1);

    await server.close();
  });
});
