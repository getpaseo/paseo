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
    ...agentManagerOverrides,
  };

  const server = new VoiceAssistantWebSocketServer(
    {} as any,
    createLogger() as any,
    "srv-test",
    agentManager as any,
    {} as any,
    {} as any,
    "/tmp/junction-test",
    async () => ({} as any),
    { allowedOrigins: new Set() },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    "1.2.3-test"
  );

  return { server, agentManager };
}

describe("VoiceAssistantWebSocketServer notification payloads", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uses assistant preview text for push notifications with markdown removed", () => {
    const { server } = createServer({
      getAgent: vi.fn(() => ({
        config: { title: null },
        cwd: "/tmp/worktree",
        labels: { ui: "true" },
        timeline: [
          {
            type: "assistant_message",
            text: "**Done**. Updated `README.md` and [link](https://example.com).",
          },
        ],
        pendingPermissions: new Map(),
      })),
    });

    (server as any).broadcastAgentAttention({
      agentId: "agent-1",
      provider: "claude",
      reason: "finished",
    });

    expect(pushMocks.sendPush).toHaveBeenCalledWith(
      ["ExponentPushToken[token-1]"],
      {
        title: "Agent finished",
        body: "Done. Updated README.md and link.",
        data: {
          serverId: "srv-test",
          agentId: "agent-1",
          reason: "finished",
        },
      }
    );
  });

  it("skips push notifications for non-UI agents", () => {
    const { server } = createServer({
      getAgent: vi.fn(() => ({
        config: { title: null },
        cwd: "/tmp/worktree",
        labels: {},
        timeline: [
          {
            type: "assistant_message",
            text: "Done.",
          },
        ],
        pendingPermissions: new Map(),
      })),
    });

    (server as any).broadcastAgentAttention({
      agentId: "agent-2",
      provider: "claude",
      reason: "finished",
    });

    expect(pushMocks.sendPush).not.toHaveBeenCalled();
  });
});
