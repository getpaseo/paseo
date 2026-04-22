import { afterEach, describe, expect, it, vi } from "vitest";

const wsModuleMock = vi.hoisted(() => {
  class MockWebSocketServer {
    readonly handlers = new Map<string, (...args: any[]) => void>();

    constructor(_options: unknown) {}

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

const pushMocks = vi.hoisted(() => ({
  getAllTokens: vi.fn(() => ["ExponentPushToken[token-1]"]),
  sendPush: vi.fn(async () => {}),
}));

vi.mock("ws", () => ({
  WebSocketServer: wsModuleMock.MockWebSocketServer,
}));

vi.mock("./session.js", () => ({
  Session: class {},
}));

vi.mock("./push/token-store.js", () => ({
  PushTokenStore: class {
    getAllTokens = pushMocks.getAllTokens;
    removeToken = vi.fn();
  },
}));

vi.mock("./push/push-service.js", () => ({
  PushService: class {
    sendPush = pushMocks.sendPush;
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

function createServer(agentManagerOverrides?: Record<string, unknown>) {
  const agentManager = {
    setAgentAttentionCallback: vi.fn(),
    getAgent: vi.fn(() => null),
    getLastAssistantMessage: vi.fn(async () => null),
    ...agentManagerOverrides,
  };
  const daemonConfigStore = {
    onChange: vi.fn(() => () => {}),
  };

  const server = new VoiceAssistantWebSocketServer(
    {} as any,
    createLogger() as any,
    "srv-test",
    agentManager as any,
    {} as any,
    {} as any,
    "/tmp/paseo-test",
    daemonConfigStore as any,
    null,
    { allowedOrigins: new Set() },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
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

  return { server, agentManager };
}

function createOpenSocket() {
  return {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
  };
}

function createSessionWithActivity(
  activity: {
    deviceType: "web" | "mobile";
    focusedAgentId: string | null;
    lastActivityAt: Date;
    appVisible: boolean;
    appVisibilityChangedAt?: Date;
  } | null,
) {
  return {
    getClientActivity: vi.fn(() => activity),
  };
}

function connectClient(
  server: VoiceAssistantWebSocketServer,
  activity: {
    deviceType: "web" | "mobile";
    focusedAgentId: string | null;
    lastActivityAt: Date;
    appVisible: boolean;
    appVisibilityChangedAt?: Date;
  } | null,
) {
  const ws = createOpenSocket();
  (server as any).sessions.set(ws, {
    session: createSessionWithActivity(activity),
    clientId: "client-test",
    appVersion: null,
    connectionLogger: createLogger(),
    sockets: new Set([ws]),
    externalDisconnectCleanupTimeout: null,
  });
  return ws;
}

function readAttentionRequiredMessage(ws: ReturnType<typeof createOpenSocket>) {
  const rawMessage = ws.send.mock.calls[0]?.[0];
  expect(typeof rawMessage).toBe("string");
  const message = JSON.parse(rawMessage as string);
  expect(message.type).toBe("session");
  expect(message.message.type).toBe("agent_stream");
  expect(message.message.payload.event.type).toBe("attention_required");
  return message.message.payload.event;
}

describe("VoiceAssistantWebSocketServer notification payloads", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uses assistant preview text for push notifications with markdown removed", async () => {
    const getLastAssistantMessage = vi.fn(
      async () => "**Done**. Updated `README.md` and [link](https://example.com).",
    );
    const { server } = createServer({
      getAgent: vi.fn(() => ({
        config: { title: null },
        cwd: "/tmp/worktree",
        pendingPermissions: new Map(),
      })),
      getLastAssistantMessage,
    });

    await (server as any).broadcastAgentAttention({
      agentId: "agent-1",
      provider: "claude",
      reason: "finished",
    });

    expect(pushMocks.sendPush).toHaveBeenCalledWith(["ExponentPushToken[token-1]"], {
      title: "Agent finished",
      body: "Done. Updated README.md and link.",
      data: {
        serverId: "srv-test",
        agentId: "agent-1",
        reason: "finished",
      },
    });
    expect(getLastAssistantMessage).toHaveBeenCalledWith("agent-1");
  });

  it("sends push notifications regardless of UI label presence", async () => {
    const getLastAssistantMessage = vi.fn(async () => "Done.");
    const { server } = createServer({
      getAgent: vi.fn(() => ({
        config: { title: null },
        cwd: "/tmp/worktree",
        labels: {},
        pendingPermissions: new Map(),
      })),
      getLastAssistantMessage,
    });

    await (server as any).broadcastAgentAttention({
      agentId: "agent-2",
      provider: "claude",
      reason: "finished",
    });

    expect(pushMocks.sendPush).toHaveBeenCalledTimes(1);
    expect(getLastAssistantMessage).toHaveBeenCalledWith("agent-2");
  });

  it("routes a hidden stale focused browser tab's notification to the present Electron web client", async () => {
    const { server } = createServer();
    const nowMs = Date.now();
    const electronWs = connectClient(server, {
      deviceType: "web",
      appVisible: false,
      focusedAgentId: "agent-Y",
      lastActivityAt: new Date(nowMs - 5_000),
    });
    const firefoxWs = connectClient(server, {
      deviceType: "web",
      appVisible: false,
      focusedAgentId: "agent-X",
      lastActivityAt: new Date(nowMs - 300_000),
    });

    await (server as any).broadcastAgentAttention({
      agentId: "agent-X",
      provider: "claude",
      reason: "finished",
    });

    expect(readAttentionRequiredMessage(electronWs).shouldNotify).toBe(true);
    expect(readAttentionRequiredMessage(firefoxWs).shouldNotify).toBe(false);
    expect(pushMocks.sendPush).not.toHaveBeenCalled();
  });

  it("pushes non-error attention when the only connected client has never sent a heartbeat", async () => {
    const { server } = createServer();
    const ws = connectClient(server, null);

    await (server as any).broadcastAgentAttention({
      agentId: "agent-no-heartbeat",
      provider: "claude",
      reason: "finished",
    });

    expect(readAttentionRequiredMessage(ws).shouldNotify).toBe(false);
    expect(pushMocks.sendPush).toHaveBeenCalledTimes(1);
  });

  it("does not push error attention when the only connected client has never sent a heartbeat", async () => {
    const { server } = createServer();
    const ws = connectClient(server, null);

    await (server as any).broadcastAgentAttention({
      agentId: "agent-no-heartbeat",
      provider: "claude",
      reason: "error",
    });

    expect(readAttentionRequiredMessage(ws).shouldNotify).toBe(false);
    expect(pushMocks.sendPush).not.toHaveBeenCalled();
  });
});
