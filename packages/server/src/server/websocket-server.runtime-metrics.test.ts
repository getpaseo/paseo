import { describe, expect, it, vi } from "vitest";
import type { Server as HTTPServer } from "http";
import type pino from "pino";
import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import type { DownloadTokenStore } from "./file-download/token-store.js";
import type { DaemonConfigStore } from "./daemon-config-store.js";
import type { FileBackedChatService } from "./chat/chat-service.js";
import type { LoopService } from "./loop-service.js";
import type { ScheduleService } from "./schedule/service.js";
import type { CheckoutDiffManager } from "./checkout-diff-manager.js";
import type { SessionOutboundMessage, WSOutboundMessage } from "./messages.js";

const wsModuleMock = vi.hoisted(() => {
  class MockWebSocketServer {
    readonly handlers = new Map<string, (...args: unknown[]) => void>();

    on(event: string, handler: (...args: unknown[]) => void) {
      this.handlers.set(event, handler);
      return this;
    }

    close() {
      // no-op
    }
  }

  return { MockWebSocketServer };
});

vi.mock("ws", () => ({
  WebSocketServer: wsModuleMock.MockWebSocketServer,
}));

import { VoiceAssistantWebSocketServer } from "./websocket-server.js";
import { wrapSessionMessage } from "./messages.js";

interface WebSocketServerInternals {
  flushRuntimeMetrics(options?: { final?: boolean }): void;
  sendToClient(ws: unknown, message: WSOutboundMessage): void;
  sendBinaryToClient(ws: unknown, frame: Uint8Array): void;
  sessions: Map<unknown, unknown>;
}

interface RuntimeMetricsLog {
  outboundMessageTypesTop: Array<[string, number]>;
  outboundSessionMessageTypesTop: Array<[string, number]>;
  outboundAgentStreamTypesTop: Array<[string, number]>;
  outboundAgentStreamAgentsTop: Array<[string, number]>;
  outboundBinaryFrameTypesTop: Array<[string, number]>;
  bufferedAmount: {
    p95: number;
    max: number;
  };
}

interface TestSocket {
  readyState: number;
  bufferedAmount: number;
  sent: Array<string | Uint8Array | ArrayBuffer>;
  afterSendBufferedAmounts: number[];
  send: (data: string | Uint8Array | ArrayBuffer) => void;
  close: () => void;
  on: () => void;
  once: () => void;
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

function createServer(logger: ReturnType<typeof createLogger>) {
  const daemonConfigStore = {
    onChange: vi.fn(() => () => {}),
  };

  return new VoiceAssistantWebSocketServer(
    {} as unknown as HTTPServer,
    logger as unknown as pino.Logger,
    "srv-test",
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
    } as unknown as AgentManager,
    {} as unknown as AgentStorage,
    {} as unknown as DownloadTokenStore,
    "/tmp/paseo-test",
    daemonConfigStore as unknown as DaemonConfigStore,
    null,
    { allowedOrigins: new Set() },
    undefined,
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
    {} as unknown as FileBackedChatService,
    {} as unknown as LoopService,
    {} as unknown as ScheduleService,
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
    } as unknown as CheckoutDiffManager,
  );
}

function createSocket(afterSendBufferedAmounts: number[]): TestSocket {
  const socket: TestSocket = {
    readyState: 1,
    bufferedAmount: 0,
    sent: [],
    afterSendBufferedAmounts,
    send: vi.fn((data) => {
      socket.sent.push(data);
      socket.bufferedAmount = afterSendBufferedAmounts.shift() ?? socket.bufferedAmount;
    }),
    close: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
  };
  return socket;
}

function flushRuntimeMetrics(server: VoiceAssistantWebSocketServer): void {
  (server as unknown as WebSocketServerInternals).flushRuntimeMetrics({ final: true });
}

function getRuntimeMetricsLog(logger: ReturnType<typeof createLogger>): RuntimeMetricsLog {
  const metricsCall = logger.info.mock.calls.find((call) => call[1] === "ws_runtime_metrics");
  expect(metricsCall).toBeDefined();
  return metricsCall![0] as RuntimeMetricsLog;
}

function sendToClient(
  server: VoiceAssistantWebSocketServer,
  socket: TestSocket,
  message: WSOutboundMessage,
) {
  (server as unknown as WebSocketServerInternals).sendToClient(socket, message);
}

function sendBinaryToClient(
  server: VoiceAssistantWebSocketServer,
  socket: TestSocket,
  frame: Uint8Array,
) {
  (server as unknown as WebSocketServerInternals).sendBinaryToClient(socket, frame);
}

function attachSessionSocket(server: VoiceAssistantWebSocketServer, socket: TestSocket): void {
  (server as unknown as WebSocketServerInternals).sessions.set(socket, {
    session: {},
    clientId: "client-1",
    appVersion: null,
    connectionLogger: createLogger(),
    sockets: new Set([socket]),
    externalDisconnectCleanupTimeout: null,
  });
}

function agentStreamMessage(params: {
  agentId: string;
  event: Extract<SessionOutboundMessage, { type: "agent_stream" }>["payload"]["event"];
}): WSOutboundMessage {
  return wrapSessionMessage({
    type: "agent_stream",
    payload: {
      agentId: params.agentId,
      event: params.event,
      timestamp: "2026-04-17T00:00:00.000Z",
    },
  });
}

describe("VoiceAssistantWebSocketServer runtime metrics", () => {
  it("records outbound message type counts in the ws runtime metrics window", () => {
    const logger = createLogger();
    const server = createServer(logger);
    const broadcastSocket = createSocket([0]);
    const directSocket = createSocket([0, 0]);
    attachSessionSocket(server, broadcastSocket);

    server.broadcast(
      agentStreamMessage({
        agentId: "agent-1",
        event: {
          type: "turn_completed",
          provider: "codex",
        },
      }),
    );
    sendToClient(
      server,
      directSocket,
      wrapSessionMessage({
        type: "status",
        payload: {
          status: "ok",
          message: "ready",
        },
      }),
    );
    sendToClient(server, directSocket, { type: "pong" });

    flushRuntimeMetrics(server);

    const metrics = getRuntimeMetricsLog(logger);
    expect(metrics.outboundMessageTypesTop).toEqual([
      ["session_message", 2],
      ["pong", 1],
    ]);
    expect(metrics.outboundSessionMessageTypesTop).toEqual([
      ["agent_stream", 1],
      ["status", 1],
    ]);
  });

  it("records agent_stream subtypes and top agents", () => {
    const logger = createLogger();
    const server = createServer(logger);
    const socket = createSocket([0, 0, 0, 0]);

    sendToClient(
      server,
      socket,
      agentStreamMessage({
        agentId: "agent-1",
        event: {
          type: "timeline",
          provider: "codex",
          item: { type: "assistant_message", text: "hello" },
        },
      }),
    );
    sendToClient(
      server,
      socket,
      agentStreamMessage({
        agentId: "agent-1",
        event: {
          type: "timeline",
          provider: "codex",
          item: { type: "reasoning", text: "thinking" },
        },
      }),
    );
    sendToClient(
      server,
      socket,
      agentStreamMessage({
        agentId: "agent-1",
        event: {
          type: "turn_completed",
          provider: "codex",
        },
      }),
    );
    sendToClient(
      server,
      socket,
      agentStreamMessage({
        agentId: "agent-2",
        event: {
          type: "timeline",
          provider: "codex",
          item: { type: "assistant_message", text: "there" },
        },
      }),
    );

    flushRuntimeMetrics(server);

    const metrics = getRuntimeMetricsLog(logger);
    expect(metrics.outboundAgentStreamTypesTop).toEqual([
      ["timeline:assistant_message", 2],
      ["timeline:reasoning", 1],
      ["turn_completed", 1],
    ]);
    expect(metrics.outboundAgentStreamAgentsTop).toEqual([
      ["agent-1", 3],
      ["agent-2", 1],
    ]);
  });

  it("records bufferedAmount p95 and max from samples taken after send", () => {
    const logger = createLogger();
    const server = createServer(logger);
    const broadcastSocket = createSocket([0]);
    const directSocket = createSocket([10, 50]);
    const binarySocket = createSocket([100]);
    attachSessionSocket(server, broadcastSocket);

    server.broadcast(
      agentStreamMessage({
        agentId: "agent-1",
        event: {
          type: "turn_completed",
          provider: "codex",
        },
      }),
    );
    sendToClient(
      server,
      directSocket,
      wrapSessionMessage({
        type: "status",
        payload: { status: "ok" },
      }),
    );
    sendToClient(server, directSocket, { type: "pong" });
    sendBinaryToClient(server, binarySocket, new Uint8Array([1, 2, 3]));

    flushRuntimeMetrics(server);

    const metrics = getRuntimeMetricsLog(logger);
    expect(metrics.bufferedAmount).toEqual({
      p95: 100,
      max: 100,
    });
  });

  it("counts binary frames without decoding", () => {
    const logger = createLogger();
    const server = createServer(logger);
    const socket = createSocket([12, 24]);
    const frame = new Proxy(Buffer.from([0xff, 0xfe, 0xfd, 0x00, 0xc0]), {
      get(_target, property) {
        throw new Error(`Binary frame payload was unexpectedly accessed via ${String(property)}`);
      },
    }) as unknown as Uint8Array;

    expect(() => sendBinaryToClient(server, socket, frame)).not.toThrow();

    flushRuntimeMetrics(server);

    const metrics = getRuntimeMetricsLog(logger);
    expect(metrics.outboundBinaryFrameTypesTop).toEqual([["binary", 1]]);
  });
});
