import { describe, expect, test, vi } from "vitest";

const wsModuleMock = vi.hoisted(() => {
  class MockWebSocketServer {
    static instances: MockWebSocketServer[] = [];
    readonly handlers = new Map<string, (...args: any[]) => void>();
    readonly options: Record<string, unknown>;

    constructor(options: Record<string, unknown>) {
      this.options = options;
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
  class MockSession {
    cleanup = vi.fn(async () => {});
    handleMessage = vi.fn(async () => {});
    handleBinaryFrame = vi.fn((_frame: unknown) => {});
    getClientActivity = vi.fn(() => null);
    resetPeakInflight = vi.fn(() => {});
    getRuntimeMetrics = vi.fn(() => ({
      checkoutDiffTargetCount: 0,
      checkoutDiffSubscriptionCount: 0,
      checkoutDiffWatcherCount: 0,
      checkoutDiffFallbackRefreshTargetCount: 0,
      terminalDirectorySubscriptionCount: 0,
      terminalSubscriptionCount: 0,
      inflightRequests: 0,
      peakInflightRequests: 0,
    }));
  }

  return { MockSession };
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

import { VoiceAssistantWebSocketServer } from "./websocket-server.js";

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

function createServer(allowedOrigins: Set<string> = new Set()) {
  wsModuleMock.MockWebSocketServer.instances.length = 0;

  return new VoiceAssistantWebSocketServer(
    {} as any,
    createLogger() as any,
    "srv_test",
    {
      setAgentAttentionCallback: vi.fn(),
      getAgent: vi.fn(() => null),
      getMetricsSnapshot: vi.fn(() => ({
        totalAgents: 0,
        idleAgents: 0,
        runningAgents: 0,
        pendingPermissionAgents: 0,
        erroredAgents: 0,
      })),
    } as any,
    {} as any,
    {} as any,
    "/tmp/paseo-test",
    {
      onChange: vi.fn(() => () => {}),
    } as any,
    null,
    { allowedOrigins },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    "1.2.3-test",
    undefined,
    undefined,
    undefined,
    {} as any,
    {} as any,
    {} as any,
    {
      subscribe: vi.fn(),
      scheduleRefreshForCwd: vi.fn(),
      getMetrics: vi.fn(() => ({
        checkoutDiffTargetCount: 0,
        checkoutDiffSubscriptionCount: 0,
        checkoutDiffWatcherCount: 0,
        checkoutDiffFallbackRefreshTargetCount: 0,
      })),
      dispose: vi.fn(),
    } as any,
  );
}

function getVerifyClient() {
  const server = wsModuleMock.MockWebSocketServer.instances.at(-1);
  expect(server).toBeDefined();
  const verifyClient = server?.options.verifyClient;
  expect(typeof verifyClient).toBe("function");
  return verifyClient as (
    info: { req: { headers?: Record<string, string>; socket?: { remoteAddress?: string } } },
    callback: (result: boolean, code?: number, message?: string) => void,
  ) => void;
}

describe("websocket server origin policy", () => {
  test("accepts same-host websocket origins across different ports", () => {
    createServer();
    const verifyClient = getVerifyClient();
    const callback = vi.fn();

    verifyClient(
      {
        req: {
          headers: {
            host: "192.0.2.10:6767",
            origin: "http://192.0.2.10:5173",
          },
        },
      },
      callback,
    );

    expect(callback).toHaveBeenCalledWith(true);
  });

  test("rejects different hosts that are not allowlisted", () => {
    createServer();
    const verifyClient = getVerifyClient();
    const callback = vi.fn();

    verifyClient(
      {
        req: {
          headers: {
            host: "192.0.2.10:6767",
            origin: "http://198.51.100.20:5173",
          },
        },
      },
      callback,
    );

    expect(callback).toHaveBeenCalledWith(false, 403, "Origin not allowed");
  });
});
