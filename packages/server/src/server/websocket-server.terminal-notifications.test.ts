import { afterEach, describe, expect, it, vi } from "vitest";
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
import type {
  TerminalActivityListener,
  TerminalActivityTransitionEvent,
  TerminalManager,
} from "../terminal/terminal-manager.js";
import type { PersistedWorkspaceRecord, WorkspaceRegistry } from "./workspace-registry.js";
import { asInternals, createStub } from "./test-utils/class-mocks.js";
import { createProviderSnapshotManagerStub } from "./test-utils/session-stubs.js";
import type { PushNotificationSender, PushPayload } from "./push/notifications.js";

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

vi.mock("./session.js", () => ({
  Session: function Session() {
    return {};
  },
}));

import { VoiceAssistantWebSocketServer } from "./websocket-server.js";

class RecordingPushNotificationSender implements PushNotificationSender {
  readonly sent: PushPayload[] = [];

  async send(payload: PushPayload): Promise<void> {
    this.sent.push(payload);
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

function createTerminalManager() {
  let listener: TerminalActivityListener | null = null;

  const manager = createStub<TerminalManager>({
    subscribeTerminalActivity: vi.fn((l: TerminalActivityListener) => {
      listener = l;
      return () => {
        listener = null;
      };
    }),
  });

  function emit(event: TerminalActivityTransitionEvent): void {
    listener?.(event);
  }

  return { manager, emit };
}

function workspaceRecord(overrides?: Partial<PersistedWorkspaceRecord>): PersistedWorkspaceRecord {
  return {
    workspaceId: "ws-1",
    projectId: "project-1",
    cwd: CWD,
    kind: "directory",
    displayName: "Project",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

function createWorkspaceRegistry(records: PersistedWorkspaceRecord[]): WorkspaceRegistry {
  return createStub<WorkspaceRegistry>({
    list: vi.fn(async () => records),
  });
}

function createServer(terminalManager: TerminalManager, workspaceRegistry?: WorkspaceRegistry) {
  const pushNotifications = new RecordingPushNotificationSender();
  const agentManager = {
    setAgentAttentionCallback: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    getAgent: vi.fn(() => null),
    getLastAssistantMessage: vi.fn(async () => null),
    getMetricsSnapshot: vi.fn(() => ({
      total: 0,
      byLifecycle: {},
      withActiveForegroundTurn: 0,
      timelineStats: {
        totalItems: 0,
        maxItemsPerAgent: 0,
      },
    })),
  };
  const daemonConfigStore = {
    onChange: vi.fn(() => () => {}),
  };

  const server = new VoiceAssistantWebSocketServer(
    createStub<HTTPServer>({}),
    createStub<pino.Logger>(createLogger()),
    "srv-test",
    createStub<AgentManager>(agentManager),
    createStub<AgentStorage>({}),
    createStub<DownloadTokenStore>({}),
    "/tmp/paseo-test",
    createStub<DaemonConfigStore>(daemonConfigStore),
    null,
    { allowedOrigins: new Set() },
    undefined,
    undefined,
    terminalManager,
    undefined,
    "1.2.3-test",
    undefined,
    undefined,
    workspaceRegistry,
    createStub<FileBackedChatService>({}),
    createStub<LoopService>({}),
    createStub<ScheduleService>({}),
    createStub<CheckoutDiffManager>({
      subscribe: vi.fn(),
      scheduleRefreshForCwd: vi.fn(),
      getMetrics: vi.fn(() => ({
        checkoutDiffTargetCount: 0,
        checkoutDiffSubscriptionCount: 0,
        checkoutDiffWatcherCount: 0,
        checkoutDiffFallbackRefreshTargetCount: 0,
      })),
      dispose: vi.fn(),
    }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    pushNotifications,
    createProviderSnapshotManagerStub().manager,
  );

  return { server, pushNotifications };
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

function connectClient(server: VoiceAssistantWebSocketServer) {
  const ws = createOpenSocket();
  asInternals<{ sessions: Map<unknown, unknown> }>(server).sessions.set(ws, {
    session: {
      getClientActivity: vi.fn(() => null),
    },
    clientId: "client-test",
    appVersion: null,
    connectionLogger: createLogger(),
    sockets: new Set([ws]),
    externalDisconnectCleanupTimeout: null,
  });
  return ws;
}

function sentTerminalAttentionMessages(ws: ReturnType<typeof createOpenSocket>) {
  return ws.send.mock.calls
    .map(([rawMessage]) => {
      expect(typeof rawMessage).toBe("string");
      if (typeof rawMessage !== "string") throw new Error("Expected string WebSocket frame");
      return JSON.parse(rawMessage);
    })
    .filter(
      (message) =>
        message.type === "session" && message.message.type === "terminal_attention_required",
    )
    .map((message) => message.message.payload as TerminalAttentionPayload);
}

interface TerminalAttentionPayload {
  terminalId: string;
  cwd: string;
  workspaceId?: string;
  shouldNotify: boolean;
  reason: "finished" | "needs_input";
  title: string;
  body: string;
}

function readTerminalAttentionMessage(ws: ReturnType<typeof createOpenSocket>) {
  const terminalMessages = sentTerminalAttentionMessages(ws);
  expect(terminalMessages).toHaveLength(1);
  const [payload] = terminalMessages;
  if (!payload) throw new Error("Expected terminal attention message");
  return payload;
}

function expectNoTerminalAttentionMessage(ws: ReturnType<typeof createOpenSocket>) {
  expect(sentTerminalAttentionMessages(ws)).toHaveLength(0);
}

const CWD = "/home/user/project";

// Drain microtasks: the broadcast awaits the workspace registry before sending.
function flushAsync(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function transition(input: {
  previousState: "working" | "idle" | "attention";
  previousChangedAt: number;
  state: "working" | "idle" | "attention" | null;
  changedAt: number;
  id?: string;
  workspaceId?: string;
}): TerminalActivityTransitionEvent {
  return {
    terminalId: input.id ?? "term-1",
    name: "bash",
    cwd: CWD,
    workspaceId: input.workspaceId ?? "ws-1",
    activity: input.state ? { state: input.state, changedAt: input.changedAt } : null,
    previous: { state: input.previousState, changedAt: input.previousChangedAt },
  };
}

describe("VoiceAssistantWebSocketServer terminal attention notifications", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("broadcasts terminal_attention_required after working -> idle", async () => {
    const { manager, emit } = createTerminalManager();
    const { server } = createServer(manager);
    const ws = connectClient(server);

    emit(
      transition({
        previousState: "working",
        previousChangedAt: 1000,
        state: "idle",
        changedAt: 11001,
      }),
    );

    // Wait for async broadcast
    await flushAsync();

    const payload = readTerminalAttentionMessage(ws);
    expect(payload.terminalId).toBe("term-1");
    expect(payload.cwd).toBe(CWD);
    expect(payload.workspaceId).toBe("ws-1");
    expect(payload.reason).toBe("finished");
    expect(payload.title).toBe("Terminal finished");
    expect(payload.body).toBe("bash");
    // Client has no recent activity so it is not the in-app recipient.
    expect(payload.shouldNotify).toBe(false);
  });

  it("forwards the terminal event workspaceId into the payload", async () => {
    const { manager, emit } = createTerminalManager();
    const { server } = createServer(manager);
    const ws = connectClient(server);

    emit(
      transition({
        previousState: "working",
        previousChangedAt: 1000,
        state: "idle",
        changedAt: 11001,
        workspaceId: "ws-event",
      }),
    );

    await flushAsync();

    expect(readTerminalAttentionMessage(ws).workspaceId).toBe("ws-event");
  });

  it("keeps the event workspaceId for a subdirectory terminal cwd", async () => {
    const { manager, emit } = createTerminalManager();
    const { server } = createServer(manager);
    const ws = connectClient(server);

    emit({
      ...transition({
        previousState: "working",
        previousChangedAt: 1000,
        state: "idle",
        changedAt: 11001,
      }),
      cwd: `${CWD}/packages/app`,
    });

    await flushAsync();

    expect(readTerminalAttentionMessage(ws).workspaceId).toBe("ws-1");
  });

  it("does not derive terminal attention ownership from the workspace registry", async () => {
    const { manager, emit } = createTerminalManager();
    const { server } = createServer(
      manager,
      createWorkspaceRegistry([
        workspaceRecord({ archivedAt: "2026-02-01T00:00:00.000Z" }),
        workspaceRecord({ workspaceId: "ws-other", cwd: "/home/user/other" }),
      ]),
    );
    const ws = connectClient(server);

    emit(
      transition({
        previousState: "working",
        previousChangedAt: 1000,
        state: "idle",
        changedAt: 11001,
      }),
    );

    await flushAsync();

    expect(readTerminalAttentionMessage(ws).workspaceId).toBe("ws-1");
  });

  it("does not broadcast on working -> working (no transition to idle)", async () => {
    const { manager, emit } = createTerminalManager();
    const { server } = createServer(manager);
    const ws = connectClient(server);

    emit(
      transition({
        previousState: "working",
        previousChangedAt: 1000,
        state: "working",
        changedAt: 15000,
      }),
    );

    await flushAsync();

    expectNoTerminalAttentionMessage(ws);
  });

  it("does not broadcast on working -> unknown", async () => {
    const { manager, emit } = createTerminalManager();
    const { server } = createServer(manager);
    const ws = connectClient(server);

    emit(
      transition({
        previousState: "working",
        previousChangedAt: 1000,
        state: null,
        changedAt: 15000,
      }),
    );

    await flushAsync();

    expectNoTerminalAttentionMessage(ws);
  });

  it("broadcasts needs_input after working -> attention", async () => {
    const { manager, emit } = createTerminalManager();
    const { server } = createServer(manager);
    const ws = connectClient(server);

    emit(
      transition({
        previousState: "working",
        previousChangedAt: 1000,
        state: "attention",
        changedAt: 15000,
      }),
    );

    await flushAsync();

    const payload = readTerminalAttentionMessage(ws);
    expect(payload.reason).toBe("needs_input");
    expect(payload.title).toBe("Terminal needs input");
    expect(payload.body).toBe("bash");
  });

  it("broadcasts needs_input after idle -> attention", async () => {
    const { manager, emit } = createTerminalManager();
    const { server } = createServer(manager);
    const ws = connectClient(server);

    emit(
      transition({
        previousState: "idle",
        previousChangedAt: 1000,
        state: "attention",
        changedAt: 15000,
      }),
    );

    await flushAsync();

    const payload = readTerminalAttentionMessage(ws);
    expect(payload.reason).toBe("needs_input");
    expect(payload.title).toBe("Terminal needs input");
  });

  it("sends push notification when no clients are present", async () => {
    const { manager, emit } = createTerminalManager();
    const { pushNotifications } = createServer(
      manager,
      createWorkspaceRegistry([workspaceRecord()]),
    );
    // No connected clients

    emit(
      transition({
        previousState: "working",
        previousChangedAt: 0,
        state: "idle",
        changedAt: 15000,
      }),
    );

    await flushAsync();

    expect(pushNotifications.sent).toHaveLength(1);
    expect(pushNotifications.sent[0]?.title).toBe("Terminal finished");
    expect(pushNotifications.sent[0]?.data).toMatchObject({
      serverId: "srv-test",
      terminalId: "term-1",
      workspaceId: "ws-1",
    });
  });
});
