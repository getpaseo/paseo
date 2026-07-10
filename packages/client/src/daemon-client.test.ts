import { afterEach, expect, expectTypeOf, test, vi } from "vitest";
import { z } from "zod";
import { DaemonClient, type DaemonTransport, type Logger } from "./daemon-client";
import { CLIENT_CAPS } from "@getpaseo/protocol/client-capabilities";
import { BROWSER_AUTOMATION_COMMAND_NAMES } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import {
  decodeFileTransferFrame,
  encodeFileTransferFrame,
  FileTransferOpcode,
} from "@getpaseo/protocol/binary-frames/index";
import {
  asUint8Array,
  decodeTerminalResizePayload,
  decodeTerminalStreamFrame,
  encodeTerminalSnapshotPayload,
  encodeTerminalStreamFrame,
  TerminalStreamOpcode,
} from "@getpaseo/protocol/terminal-stream-protocol";

expectTypeOf<"getGitDiff" extends keyof DaemonClient ? true : false>().toEqualTypeOf<false>();
expectTypeOf<
  "getHighlightedDiff" extends keyof DaemonClient ? true : false
>().toEqualTypeOf<false>();
expectTypeOf<
  "exploreFileSystem" extends keyof DaemonClient ? true : false
>().toEqualTypeOf<false>();

function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createMockTransport() {
  const sent: Array<string | Uint8Array | ArrayBuffer> = [];

  let onMessage: (data: unknown) => void = () => {};
  let onOpen: () => void = () => {};
  let onClose: (_event?: unknown) => void = () => {};
  let onError: (_event?: unknown) => void = () => {};
  let serverInfoOrdinal = 1;

  const transport: DaemonTransport = {
    send: (data) => {
      sent.push(data);
      if (typeof data !== "string") {
        return;
      }
      const frame = JSON.parse(data) as { type?: string };
      if (frame.type === "ping") {
        onMessage(JSON.stringify({ type: "pong" }));
      }
    },
    close: () => {},
    onMessage: (handler) => {
      onMessage = handler;
      return () => {};
    },
    onOpen: (handler) => {
      onOpen = handler;
      return () => {};
    },
    onClose: (handler) => {
      onClose = handler;
      return () => {};
    },
    onError: (handler) => {
      onError = handler;
      return () => {};
    },
  };

  return {
    transport,
    sent,
    triggerOpen: (options?: { preserveSent?: boolean }) => {
      onOpen();
      if (!options?.preserveSent) {
        // Ignore HELLO handshake payloads in assertions.
        sent.length = 0;
      }
      onMessage(
        JSON.stringify({
          type: "session",
          message: {
            type: "status",
            payload: {
              status: "server_info",
              serverId: `srv_test_${serverInfoOrdinal++}`,
              hostname: null,
              version: null,
            },
          },
        }),
      );
    },
    triggerClose: (event?: unknown) => onClose(event),
    triggerError: (event?: unknown) => onError(event),
    triggerMessage: (data: unknown) => onMessage(data),
  };
}

function wrapSessionMessage(message: unknown): string {
  return JSON.stringify({
    type: "session",
    message,
  });
}

function assertStr(data: string | Uint8Array | ArrayBuffer | undefined): string {
  if (typeof data !== "string") throw new Error("Expected string frame");
  return data;
}

function assertUint8Array(data: string | Uint8Array | ArrayBuffer | undefined): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new Error("Expected binary frame");
}

function parseSentFrame(
  data: string | Uint8Array | ArrayBuffer | undefined,
): Record<string, unknown> {
  return z
    .object({
      type: z.literal("session"),
      message: z.record(z.string(), z.unknown()),
    })
    .parse(JSON.parse(assertStr(data))).message;
}

function respondToScheduleRequest(
  mock: ReturnType<typeof createMockTransport>,
  request: Record<string, unknown>,
): void {
  const responseType =
    request.type === "schedule/create" ? "schedule/create/response" : "schedule/update/response";

  mock.triggerMessage(
    wrapSessionMessage({
      type: responseType,
      payload: {
        requestId: request.requestId,
        schedule: null,
        error: null,
      },
    }),
  );
}

const clients: DaemonClient[] = [];

afterEach(async () => {
  await Promise.all(clients.map((client) => client.close()));
  clients.length = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("does not infer browser automation capabilities from Electron runtime", async () => {
  vi.stubGlobal("navigator", {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Paseo/0.1.89 Chrome/146 Electron/41.2.0 Safari/537.36",
  });
  const mock = createMockTransport();
  const client = new DaemonClient({
    url: "ws://test",
    clientId: "electron_unit_test",
    transportFactory: () => mock.transport,
    reconnect: { enabled: false },
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen({ preserveSent: true });
  await connectPromise;

  const hello = z
    .object({
      type: z.literal("hello"),
      capabilities: z.record(z.unknown()),
    })
    .parse(JSON.parse(assertStr(mock.sent[0])));
  expect(hello.capabilities[CLIENT_CAPS.browserHost]).toBeUndefined();
});

test("advertises consumer-provided browser automation capabilities", async () => {
  const mock = createMockTransport();
  const client = new DaemonClient({
    url: "ws://test",
    clientId: "browser_capability_unit_test",
    transportFactory: () => mock.transport,
    reconnect: { enabled: false },
    capabilities: {
      [CLIENT_CAPS.browserHost]: {
        supportedCommands: [...BROWSER_AUTOMATION_COMMAND_NAMES],
        hostKind: "desktop app",
      },
    },
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen({ preserveSent: true });
  await connectPromise;

  const hello = z
    .object({
      type: z.literal("hello"),
      capabilities: z.record(z.unknown()),
    })
    .parse(JSON.parse(assertStr(mock.sent[0])));
  expect(hello.capabilities[CLIENT_CAPS.browserHost]).toEqual({
    supportedCommands: [...BROWSER_AUTOMATION_COMMAND_NAMES],
    hostKind: "desktop app",
  });
});

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

type PongMode = { kind: "answer"; delayMs: number } | { kind: "silent" };

class FakeDaemon {
  private onMessage: (data: unknown) => void = () => {};
  private onOpen: () => void = () => {};
  private onClose: (event?: unknown) => void = () => {};
  private onError: (event?: unknown) => void = () => {};
  private pongMode: PongMode = { kind: "answer", delayMs: 0 };
  private withheldPongs = 0;
  private pingsSentAt: number[] = [];
  private closeEvents: Array<{ code?: number; reason?: string }> = [];

  readonly transport: DaemonTransport = {
    send: (data) => {
      if (typeof data !== "string") {
        return;
      }
      const frame = JSON.parse(data) as { type?: string };
      if (frame.type !== "ping") {
        return;
      }
      this.pingsSentAt.push(performance.now());
      if (this.withheldPongs > 0) {
        this.withheldPongs -= 1;
        return;
      }
      if (this.pongMode.kind === "silent") {
        return;
      }
      if (this.pongMode.delayMs === 0) {
        this.onMessage(JSON.stringify({ type: "pong" }));
        return;
      }
      setTimeout(() => {
        this.onMessage(JSON.stringify({ type: "pong" }));
      }, this.pongMode.delayMs);
    },
    close: (code?: number, reason?: string) => {
      this.closeEvents.push({ code, reason });
    },
    onMessage: (handler) => {
      this.onMessage = handler;
      return () => {};
    },
    onOpen: (handler) => {
      this.onOpen = handler;
      return () => {};
    },
    onClose: (handler) => {
      this.onClose = handler;
      return () => {};
    },
    onError: (handler) => {
      this.onError = handler;
      return () => {};
    },
  };

  openConnection(): void {
    this.onOpen();
    this.onMessage(
      JSON.stringify({
        type: "session",
        message: {
          type: "status",
          payload: {
            status: "server_info",
            serverId: "srv_heartbeat_test",
            hostname: null,
            version: null,
          },
        },
      }),
    );
  }

  daemonAnswersPingsAfter(delay: "fast" | `${number}s`): void {
    this.pongMode = {
      kind: "answer",
      delayMs: delay === "fast" ? 0 : Number.parseFloat(delay) * 1000,
    };
  }

  daemonGoesSilent(): void {
    this.pongMode = { kind: "silent" };
  }

  daemonWithholdsNextPongThenAnswersFast(): void {
    this.withheldPongs += 1;
    this.daemonAnswersPingsAfter("fast");
  }

  daemonClosesWith(reason: string): void {
    this.onClose({ reason });
  }

  triggerError(event?: unknown): void {
    this.onError(event);
  }

  pingTimestamps(): string[] {
    return this.pingsSentAt.map((timestamp) => `${timestamp / 1000}s`);
  }

  teardownCount(): number {
    return this.closeEvents.filter((event) => event.reason === "Liveness check timed out").length;
  }

  closesFromClient(): Array<{ code?: number; reason?: string }> {
    return this.closeEvents;
  }
}

class DaemonClientSession {
  private readonly daemon = new FakeDaemon();
  private readonly client: DaemonClient;

  constructor() {
    this.client = new DaemonClient({
      url: "ws://test",
      clientId: "clsk_heartbeat_test",
      logger: noopLogger,
      reconnect: { enabled: false },
      transportFactory: () => this.daemon.transport,
    });
    clients.push(this.client);
  }

  async connect(): Promise<void> {
    const connection = this.client.connect();
    this.daemon.openConnection();
    await connection;
  }

  async advance(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
  }

  daemonAnswersPingsAfter(delay: "fast" | `${number}s`): void {
    this.daemon.daemonAnswersPingsAfter(delay);
  }

  daemonGoesSilent(): void {
    this.daemon.daemonGoesSilent();
  }

  daemonWithholdsNextPongThenAnswersFast(): void {
    this.daemon.daemonWithholdsNextPongThenAnswersFast();
  }

  daemonClosesWith(reason: string): void {
    this.daemon.daemonClosesWith(reason);
  }

  pingTimestamps(): string[] {
    return this.daemon.pingTimestamps();
  }

  state(): ReturnType<DaemonClient["getConnectionState"]> {
    return this.client.getConnectionState();
  }

  lastError(): string | null {
    return this.client.lastError;
  }

  teardownCount(): number {
    return this.daemon.teardownCount();
  }

  closesFromClient(): Array<{ code?: number; reason?: string }> {
    return this.daemon.closesFromClient();
  }

  lastLivenessRttMs(): number | null {
    return this.client.getLastLivenessRttMs();
  }

  measureLatency(input: { timeoutMs: number }): Promise<number> {
    return this.client.measureLatency(input);
  }
}

function useHeartbeatClock(): void {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"],
  });
}

test("dedupes in-flight checkout status requests per agentId", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const p1 = client.getCheckoutStatus("/tmp/project");
  const p2 = client.getCheckoutStatus("/tmp/project");

  expect(mock.sent).toHaveLength(1);

  const request = parseSentFrame(mock.sent[0]);

  const response = {
    type: "session",
    message: {
      type: "checkout_status_response",
      payload: {
        cwd: "/tmp/project",
        error: null,
        requestId: request.requestId,
        isGit: false,
        isPaseoOwnedWorktree: false,
        repoRoot: null,
        currentBranch: null,
        isDirty: null,
        baseRef: null,
        aheadBehind: null,
        aheadOfOrigin: null,
        behindOfOrigin: null,
        hasRemote: false,
        remoteUrl: null,
      },
    },
  };

  mock.triggerMessage(JSON.stringify(response));
  const [r1, r2] = await Promise.all([p1, p2]);
  expect(r1).toMatchObject({
    cwd: "/tmp/project",
    requestId: request.requestId,
    isGit: false,
  });
  expect(r2).toMatchObject({
    cwd: "/tmp/project",
    requestId: request.requestId,
    isGit: false,
  });

  // After completion, a new call should issue a new request.
  const p3 = client.getCheckoutStatus("/tmp/project");
  expect(mock.sent).toHaveLength(2);

  const request2 = parseSentFrame(mock.sent[1]);

  mock.triggerMessage(
    JSON.stringify({
      ...response,
      message: {
        ...response.message,
        payload: { ...response.message.payload, requestId: request2.requestId },
      },
    }),
  );

  await expect(p3).resolves.toMatchObject({
    cwd: "/tmp/project",
    requestId: request2.requestId,
    isGit: false,
  });
});

test("passes password as HTTP bearer header and WebSocket subprotocol", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();
  const transportFactory = vi.fn(() => mock.transport);

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    password: "shared-secret",
    logger,
    reconnect: { enabled: false },
    transportFactory,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  expect(transportFactory).toHaveBeenCalledWith({
    url: "ws://test",
    headers: { Authorization: "Bearer shared-secret" },
    protocols: ["paseo.bearer.shared-secret"],
  });
});

test("advertises client capabilities in hello", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
    capabilities: {
      browser_host: {
        supportedCommands: ["list_tabs"],
        hostKind: "desktop app",
      },
    },
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen({ preserveSent: true });
  await connectPromise;

  expect(mock.sent).toHaveLength(1);
  expect(JSON.parse(assertStr(mock.sent[0]))).toEqual({
    type: "hello",
    clientId: "clsk_unit_test",
    clientType: "cli",
    protocolVersion: 1,
    capabilities: {
      custom_mode_icons: true,
      reasoning_merge_enum: true,
      terminal_reflowable_snapshot: true,
      browser_host: {
        supportedCommands: ["list_tabs"],
        hostKind: "desktop app",
      },
    },
  });
});

test("sends new-agent run options when creating schedules", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const createPromise = client.scheduleCreate({
    requestId: "request-1",
    prompt: "Run the task",
    cadence: { type: "every", everyMs: 60_000 },
    target: {
      type: "new-agent",
      config: {
        provider: "claude",
        cwd: "/tmp/project",
        thinkingOptionId: "think-hard",
        archiveOnFinish: false,
        isolation: "worktree",
      },
    },
  });

  const request = parseSentFrame(mock.sent[0]);
  expect(request).toEqual({
    type: "schedule/create",
    requestId: "request-1",
    prompt: "Run the task",
    cadence: { type: "every", everyMs: 60_000 },
    target: {
      type: "new-agent",
      config: {
        provider: "claude",
        cwd: "/tmp/project",
        thinkingOptionId: "think-hard",
        archiveOnFinish: false,
        isolation: "worktree",
      },
    },
  });

  respondToScheduleRequest(mock, request);
  await expect(createPromise).resolves.toEqual({
    requestId: "request-1",
    schedule: null,
    error: null,
  });
});

test("sends new-agent run options when updating schedules", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const updatePromise = client.scheduleUpdate({
    id: "schedule-1",
    requestId: "request-1",
    newAgentConfig: {
      thinkingOptionId: "think-hard",
      archiveOnFinish: false,
      isolation: "worktree",
    },
  });

  const request = parseSentFrame(mock.sent[0]);
  expect(request).toEqual({
    type: "schedule/update",
    requestId: "request-1",
    scheduleId: "schedule-1",
    newAgentConfig: {
      thinkingOptionId: "think-hard",
      archiveOnFinish: false,
      isolation: "worktree",
    },
  });

  respondToScheduleRequest(mock, request);
  await expect(updatePromise).resolves.toEqual({
    requestId: "request-1",
    schedule: null,
    error: null,
  });
});

test("sends typed browser automation execute responses", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  client.sendBrowserAutomationExecuteResponse({
    type: "browser.automation.execute.response",
    payload: {
      requestId: "req-1",
      ok: true,
      result: { command: "list_tabs", tabs: [] },
    },
  });

  expect(parseSentFrame(mock.sent[0])).toEqual({
    type: "browser.automation.execute.response",
    payload: {
      requestId: "req-1",
      ok: true,
      result: { command: "list_tabs", tabs: [] },
    },
  });
});

test("does not reconnect after close when ensureConnected is called", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;
  expect(client.getConnectionState().status).toBe("connected");

  await client.close();
  expect(client.getConnectionState().status).toBe("disposed");

  client.ensureConnected();
  expect(client.getConnectionState().status).toBe("disposed");
});

test("keeps the transport connected when a session RPC ping times out", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;
  expect(client.getConnectionState().status).toBe("connected");

  await expect(client.ping({ timeoutMs: 1 })).rejects.toThrow("Timeout waiting for message");

  expect(client.getConnectionState().status).toBe("connected");
});

test("defaults session RPC waiters to sixty seconds", async () => {
  useHeartbeatClock();
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const responsePromise = client.fetchAgent({
    agentId: "agent-1",
    requestId: "req-agent-1",
  });
  let settled = false;
  void responsePromise.then(
    () => {
      settled = true;
      return undefined;
    },
    () => {
      settled = true;
      return undefined;
    },
  );

  expect(parseSentFrame(mock.sent[0])).toEqual({
    type: "fetch_agent_request",
    requestId: "req-agent-1",
    agentId: "agent-1",
  });

  await vi.advanceTimersByTimeAsync(59_999);
  expect(settled).toBe(false);

  await vi.advanceTimersByTimeAsync(1);
  await expect(responsePromise).rejects.toThrow("Timeout waiting for message (60000ms)");
});

test("honors explicit fetchAgent timeout below the session RPC default", async () => {
  useHeartbeatClock();
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const responsePromise = client.fetchAgent({
    agentId: "agent-1",
    requestId: "req-agent-1",
    timeout: 5_000,
  });
  let settled = false;
  void responsePromise.then(
    () => {
      settled = true;
      return undefined;
    },
    () => {
      settled = true;
      return undefined;
    },
  );

  expect(parseSentFrame(mock.sent[0])).toEqual({
    type: "fetch_agent_request",
    requestId: "req-agent-1",
    agentId: "agent-1",
  });

  await vi.advanceTimersByTimeAsync(4_999);
  expect(settled).toBe(false);

  await vi.advanceTimersByTimeAsync(1);
  await expect(responsePromise).rejects.toThrow("Timeout waiting for message (5000ms)");
});

test("preserves legacy fetchAgent id overload", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const responsePromise = client.fetchAgent("agent-1", "req-agent-legacy");

  expect(parseSentFrame(mock.sent[0])).toEqual({
    type: "fetch_agent_request",
    requestId: "req-agent-legacy",
    agentId: "agent-1",
  });

  mock.triggerMessage(
    wrapSessionMessage({
      type: "fetch_agent_response",
      payload: {
        requestId: "req-agent-legacy",
        agent: null,
        project: null,
        error: "legacy fetch sentinel",
      },
    }),
  );

  await expect(responsePromise).rejects.toThrow("legacy fetch sentinel");
});

test("honors explicit fetchAgentTimeline timeout below the session RPC default", async () => {
  useHeartbeatClock();
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const responsePromise = client.fetchAgentTimeline("agent-1", {
    requestId: "req-timeline-1",
    direction: "tail",
    limit: 0,
    projection: "projected",
    timeout: 2_000,
  });
  let settled = false;
  void responsePromise.then(
    () => {
      settled = true;
      return undefined;
    },
    () => {
      settled = true;
      return undefined;
    },
  );

  expect(parseSentFrame(mock.sent[0])).toEqual({
    type: "fetch_agent_timeline_request",
    requestId: "req-timeline-1",
    agentId: "agent-1",
    direction: "tail",
    limit: 0,
    projection: "projected",
  });

  await vi.advanceTimersByTimeAsync(1_999);
  expect(settled).toBe(false);

  await vi.advanceTimersByTimeAsync(1);
  await expect(responsePromise).rejects.toThrow("Timeout waiting for message (2000ms)");
});

test("honors explicit fetchAgents timeout below the session RPC default", async () => {
  useHeartbeatClock();
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const responsePromise = client.fetchAgents({
    requestId: "req-agents-1",
    scope: "active",
    timeout: 1_200,
  });
  let settled = false;
  void responsePromise.then(
    () => {
      settled = true;
      return undefined;
    },
    () => {
      settled = true;
      return undefined;
    },
  );

  expect(parseSentFrame(mock.sent[0])).toEqual({
    type: "fetch_agents_request",
    requestId: "req-agents-1",
    scope: "active",
  });

  await vi.advanceTimersByTimeAsync(1_199);
  expect(settled).toBe(false);

  await vi.advanceTimersByTimeAsync(1);
  await expect(responsePromise).rejects.toThrow("Timeout waiting for message (1200ms)");
});

test("honors explicit shutdownServer timeout below the session RPC default", async () => {
  useHeartbeatClock();
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const responsePromise = client.shutdownServer({
    requestId: "req-shutdown-1",
    timeout: 1_500,
  });
  let settled = false;
  void responsePromise.then(
    () => {
      settled = true;
      return undefined;
    },
    () => {
      settled = true;
      return undefined;
    },
  );

  expect(parseSentFrame(mock.sent[0])).toEqual({
    type: "shutdown_server_request",
    requestId: "req-shutdown-1",
  });

  await vi.advanceTimersByTimeAsync(1_499);
  expect(settled).toBe(false);

  await vi.advanceTimersByTimeAsync(1);
  await expect(responsePromise).rejects.toThrow("Timeout waiting for message (1500ms)");
});

test("honors explicit readChatMessages timeout below the session RPC default", async () => {
  useHeartbeatClock();
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const responsePromise = client.readChatMessages({
    requestId: "req-chat-read-1",
    room: "room-1",
    limit: 1,
    timeout: 2_500,
  });
  let settled = false;
  void responsePromise.then(
    () => {
      settled = true;
      return undefined;
    },
    () => {
      settled = true;
      return undefined;
    },
  );

  expect(parseSentFrame(mock.sent[0])).toEqual({
    type: "chat/read",
    requestId: "req-chat-read-1",
    room: "room-1",
    limit: 1,
  });

  await vi.advanceTimersByTimeAsync(2_499);
  expect(settled).toBe(false);

  await vi.advanceTimersByTimeAsync(1);
  await expect(responsePromise).rejects.toThrow("Timeout waiting for message (2500ms)");
});

test("honors explicit getDaemonStatus timeout below the session RPC default", async () => {
  useHeartbeatClock();
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const responsePromise = client.getDaemonStatus({
    requestId: "req-daemon-status-1",
    timeout: 1_500,
  });
  let settled = false;
  void responsePromise.then(
    () => {
      settled = true;
      return undefined;
    },
    () => {
      settled = true;
      return undefined;
    },
  );

  expect(parseSentFrame(mock.sent[0])).toEqual({
    type: "daemon.get_status.request",
    requestId: "req-daemon-status-1",
  });

  await vi.advanceTimersByTimeAsync(1_499);
  expect(settled).toBe(false);

  await vi.advanceTimersByTimeAsync(1);
  await expect(responsePromise).rejects.toThrow("Timeout waiting for message (1500ms)");
});

test("honors explicit getDaemonPairingOffer timeout below the session RPC default", async () => {
  useHeartbeatClock();
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const responsePromise = client.getDaemonPairingOffer({
    requestId: "req-pairing-offer-1",
    timeout: 1_500,
  });
  let settled = false;
  void responsePromise.then(
    () => {
      settled = true;
      return undefined;
    },
    () => {
      settled = true;
      return undefined;
    },
  );

  expect(parseSentFrame(mock.sent[0])).toEqual({
    type: "daemon.get_pairing_offer.request",
    requestId: "req-pairing-offer-1",
  });

  await vi.advanceTimersByTimeAsync(1_499);
  expect(settled).toBe(false);

  await vi.advanceTimersByTimeAsync(1);
  await expect(responsePromise).rejects.toThrow("Timeout waiting for message (1500ms)");
});

test("keeps waitForAgentUpsert initial fetch inside the requested deadline", async () => {
  useHeartbeatClock();
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const waitPromise = client.waitForAgentUpsert("agent-1", () => false, 5_000);
  let settled = false;
  void waitPromise.then(
    () => {
      settled = true;
      return undefined;
    },
    () => {
      settled = true;
      return undefined;
    },
  );

  expect(parseSentFrame(mock.sent[0])).toEqual({
    type: "fetch_agent_request",
    requestId: expect.any(String),
    agentId: "agent-1",
  });

  await vi.advanceTimersByTimeAsync(4_999);
  expect(settled).toBe(false);

  await vi.advanceTimersByTimeAsync(1);
  await expect(waitPromise).rejects.toThrow("Timed out waiting for agent agent-1");
});

test("keeps default connect timeout shorter than session RPC waiters", async () => {
  useHeartbeatClock();
  try {
    const logger = createMockLogger();
    const mock = createMockTransport();

    const client = new DaemonClient({
      url: "ws://test",
      clientId: "clsk_unit_test",
      logger,
      reconnect: { enabled: false },
      transportFactory: () => mock.transport,
    });
    clients.push(client);

    let settled = false;
    const pendingConnect = client.connect().then(
      () => {
        settled = true;
        return { ok: true as const };
      },
      (error) => {
        settled = true;
        return { ok: false as const, error };
      },
    );

    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBe(false);
    expect(client.getConnectionState().status).toBe("connecting");

    await vi.advanceTimersByTimeAsync(1);
    const result = await pendingConnect;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
      if (result.error instanceof Error) {
        expect(result.error.message).toContain("Connection timed out");
      }
    }
    expect(client.getConnectionState().status).toBe("disconnected");
  } finally {
    vi.useRealTimers();
  }
});

test("stays online through ten minutes of pongs that arrive five seconds late", async () => {
  useHeartbeatClock();
  const session = new DaemonClientSession();
  session.daemonAnswersPingsAfter("5.5s");

  await session.connect();
  await session.advance(10 * 60 * 1000);

  expect(session.state()).toEqual({ status: "connected" });
  expect(session.teardownCount()).toBe(0);
  expect(session.lastError()).toBeNull();
  expect(session.pingTimestamps().length).toBeGreaterThan(0);
  expect(session.lastLivenessRttMs()).toBe(5500);
});

test("tears down and reports a liveness timeout after the daemon goes silent for two cycles", async () => {
  useHeartbeatClock();
  const session = new DaemonClientSession();
  session.daemonGoesSilent();

  await session.connect();
  await session.advance(51_000);

  expect(session.state()).toEqual({
    status: "disconnected",
    reason: "Liveness check timed out (15000ms)",
  });
  expect(session.teardownCount()).toBe(1);
});

test("survives a single missed pong when answers resume", async () => {
  useHeartbeatClock();
  const session = new DaemonClientSession();
  session.daemonWithholdsNextPongThenAnswersFast();

  await session.connect();
  await session.advance(40_000);

  expect(session.state()).toEqual({ status: "connected" });
  expect(session.teardownCount()).toBe(0);
});

test("keeps the connection proven online from heartbeats alone when no other traffic flows", async () => {
  useHeartbeatClock();
  const session = new DaemonClientSession();
  session.daemonAnswersPingsAfter("fast");

  await session.connect();
  await session.advance(35_000);

  expect(session.state()).toEqual({ status: "connected" });
  expect(session.pingTimestamps()).toEqual(["10s", "20s", "30s"]);
});

test("starts pinging one interval after connecting and holds the cadence", async () => {
  useHeartbeatClock();
  const session = new DaemonClientSession();
  session.daemonAnswersPingsAfter("fast");

  await session.connect();
  await session.advance(9_999);
  expect(session.pingTimestamps()).toEqual([]);

  await session.advance(20_001);
  expect(session.pingTimestamps()).toEqual(["10s", "20s", "30s"]);
});

test("stops pinging once the connection is gone", async () => {
  useHeartbeatClock();
  const session = new DaemonClientSession();
  session.daemonAnswersPingsAfter("fast");

  await session.connect();
  await session.advance(10_000);
  session.daemonClosesWith("daemon shutting down");
  await session.advance(30_000);

  expect(session.pingTimestamps()).toEqual(["10s"]);
});

test("sends only one ping while a slow pong is still outstanding", async () => {
  useHeartbeatClock();
  const session = new DaemonClientSession();
  session.daemonAnswersPingsAfter("15.1s");

  await session.connect();
  await session.advance(20_000);

  expect(session.pingTimestamps()).toEqual(["10s"]);
});

test("reports the round-trip time of the last successful heartbeat", async () => {
  useHeartbeatClock();
  const session = new DaemonClientSession();
  session.daemonAnswersPingsAfter("2.3s");

  await session.connect();
  await session.advance(12_300);

  expect(session.lastLivenessRttMs()).toBe(2300);
});

test("treats a pong just under the timeout as alive and just over as a miss", async () => {
  useHeartbeatClock();
  const alive = new DaemonClientSession();
  alive.daemonAnswersPingsAfter("14.9s");

  await alive.connect();
  await alive.advance(24_900);

  expect(alive.state()).toEqual({ status: "connected" });

  const missed = new DaemonClientSession();
  missed.daemonAnswersPingsAfter("15.1s");

  await missed.connect();
  await missed.advance(25_000);

  expect(missed.state()).toEqual({ status: "connected" });
  expect(missed.lastLivenessRttMs()).toBeNull();
});

test("goes red with the daemon's reason when the connection is closed", async () => {
  useHeartbeatClock();
  const session = new DaemonClientSession();

  await session.connect();
  session.daemonClosesWith("Control unresponsive");

  expect(session.state()).toEqual({
    status: "disconnected",
    reason: "Control unresponsive",
  });
  expect(session.lastError()).toBe("Control unresponsive");
  expect(session.closesFromClient()).toEqual([]);
});

test("two candidate latency timeouts do not tear down the live connection", async () => {
  useHeartbeatClock();
  const session = new DaemonClientSession();
  session.daemonGoesSilent();

  await session.connect();
  const firstMeasurement = session.measureLatency({ timeoutMs: 1000 });
  const firstMeasurementError = firstMeasurement.then(
    () => null,
    (error) => error,
  );
  await session.advance(1000);

  await expect(firstMeasurementError).resolves.toEqual(
    expect.objectContaining({
      message: "Latency measurement timed out (1000ms)",
    }),
  );

  const secondMeasurement = session.measureLatency({ timeoutMs: 1000 });
  const secondMeasurementError = secondMeasurement.then(
    () => null,
    (error) => error,
  );
  await session.advance(1000);

  await expect(secondMeasurementError).resolves.toEqual(
    expect.objectContaining({
      message: "Latency measurement timed out (1000ms)",
    }),
  );
  expect(session.state()).toEqual({ status: "connected" });
  expect(session.teardownCount()).toBe(0);
  expect(session.pingTimestamps()).toEqual(["0s", "1s"]);
});

test("a candidate measurement that times out under a heartbeat tick does not count toward teardown", async () => {
  useHeartbeatClock();
  const session = new DaemonClientSession();
  session.daemonGoesSilent();

  await session.connect();

  // A candidate measurement is still in flight when the +10s heartbeat tick lands,
  // so the heartbeat shares the in-flight ping. Let the measurement time out.
  await session.advance(9_000);
  const measurement = session.measureLatency({ timeoutMs: 5_000 });
  const measurementError = measurement.then(
    () => null,
    (error) => error,
  );
  await session.advance(5_500);
  await expect(measurementError).resolves.toEqual(
    expect.objectContaining({ message: "Latency measurement timed out (5000ms)" }),
  );

  // The measurement timeout must not have been recorded as a liveness failure: a
  // single genuine heartbeat miss after it must still leave the connection up.
  await session.advance(25_000);

  expect(session.state()).toEqual({ status: "connected" });
  expect(session.teardownCount()).toBe(0);
});

test("listDirectory sends a list file explorer request and returns directory entries", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const responsePromise = client.listDirectory("/tmp/project", "src", "req-list");

  expect(JSON.parse(assertStr(mock.sent[0]))).toEqual({
    type: "session",
    message: {
      type: "file_explorer_request",
      cwd: "/tmp/project",
      path: "src",
      mode: "list",
      requestId: "req-list",
    },
  });

  mock.triggerMessage(
    wrapSessionMessage({
      type: "file_explorer_response",
      payload: {
        cwd: "/tmp/project",
        path: "src",
        mode: "list",
        directory: {
          path: "src",
          entries: [
            {
              name: "index.ts",
              path: "src/index.ts",
              kind: "file",
              size: 12,
              modifiedAt: "2026-05-02T00:00:00.000Z",
            },
          ],
        },
        file: null,
        error: null,
        requestId: "req-list",
      },
    }),
  );

  await expect(responsePromise).resolves.toEqual({
    path: "src",
    entries: [
      {
        name: "index.ts",
        path: "src/index.ts",
        kind: "file",
        size: 12,
        modifiedAt: "2026-05-02T00:00:00.000Z",
      },
    ],
  });
});

test("readFile hides legacy base64 behind bytes", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const responsePromise = client.readFile("/tmp/project", "logo.png", "req-file");

  expect(JSON.parse(assertStr(mock.sent[0]))).toEqual({
    type: "session",
    message: {
      type: "file_explorer_request",
      cwd: "/tmp/project",
      path: "logo.png",
      mode: "file",
      acceptBinary: true,
      requestId: "req-file",
    },
  });

  mock.triggerMessage(
    wrapSessionMessage({
      type: "file_explorer_response",
      payload: {
        cwd: "/tmp/project",
        path: "logo.png",
        mode: "file",
        directory: null,
        file: {
          path: "logo.png",
          kind: "image",
          encoding: "base64",
          content: "aGVsbG8=",
          mimeType: "image/png",
          size: 5,
          modifiedAt: "2026-05-02T00:00:00.000Z",
        },
        error: null,
        requestId: "req-file",
      },
    }),
  );

  const result = await responsePromise;
  expect(result).toMatchObject({
    mime: "image/png",
    size: 5,
    path: "logo.png",
    kind: "image",
    modifiedAt: "2026-05-02T00:00:00.000Z",
  });
  expect(new TextDecoder().decode(result.bytes)).toBe("hello");
});

test("readFile resolves from binary file frames when the daemon supports them", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const responsePromise = client.readFile("/tmp/project", "logo.png", "req-binary");

  expect(JSON.parse(assertStr(mock.sent[0]))).toEqual({
    type: "session",
    message: {
      type: "file_explorer_request",
      cwd: "/tmp/project",
      path: "logo.png",
      mode: "file",
      acceptBinary: true,
      requestId: "req-binary",
    },
  });

  mock.triggerMessage(
    encodeFileTransferFrame({
      opcode: FileTransferOpcode.FileBegin,
      requestId: "req-binary",
      metadata: {
        mime: "image/png",
        size: 5,
        encoding: "binary",
        modifiedAt: "2026-05-02T00:00:00.000Z",
      },
    }),
  );
  mock.triggerMessage(
    encodeFileTransferFrame({
      opcode: FileTransferOpcode.FileChunk,
      requestId: "req-binary",
      payload: new TextEncoder().encode("hello"),
    }),
  );
  mock.triggerMessage(
    encodeFileTransferFrame({
      opcode: FileTransferOpcode.FileEnd,
      requestId: "req-binary",
    }),
  );

  const result = await responsePromise;
  expect(result).toMatchObject({
    mime: "image/png",
    size: 5,
    path: "logo.png",
    kind: "image",
    modifiedAt: "2026-05-02T00:00:00.000Z",
  });
  expect(new TextDecoder().decode(result.bytes)).toBe("hello");
});

test("uploadFile sends metadata request and file bytes as binary chunks", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const responsePromise = client.uploadFile({
    fileName: "notes.txt",
    mimeType: "text/plain",
    bytes: new TextEncoder().encode("hello world"),
    modifiedAt: "2026-05-02T00:00:00.000Z",
    requestId: "req-upload",
    chunkSize: 5,
  });

  expect(JSON.parse(assertStr(mock.sent[0]))).toEqual({
    type: "session",
    message: {
      type: "file.upload.request",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 11,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-upload",
    },
  });
  expect(mock.sent.slice(1).map(assertUint8Array).map(decodeFileTransferFrame)).toEqual([
    {
      opcode: FileTransferOpcode.FileBegin,
      requestId: "req-upload",
      metadata: {
        mime: "text/plain",
        size: 11,
        encoding: "binary",
        modifiedAt: "2026-05-02T00:00:00.000Z",
        fileName: "notes.txt",
      },
      payload: new Uint8Array(),
    },
    {
      opcode: FileTransferOpcode.FileChunk,
      requestId: "req-upload",
      payload: new TextEncoder().encode("hello"),
    },
    {
      opcode: FileTransferOpcode.FileChunk,
      requestId: "req-upload",
      payload: new TextEncoder().encode(" worl"),
    },
    {
      opcode: FileTransferOpcode.FileChunk,
      requestId: "req-upload",
      payload: new TextEncoder().encode("d"),
    },
    {
      opcode: FileTransferOpcode.FileEnd,
      requestId: "req-upload",
      payload: new Uint8Array(),
    },
  ]);

  mock.triggerMessage(
    wrapSessionMessage({
      type: "file.upload.response",
      payload: {
        requestId: "req-upload",
        file: {
          type: "uploaded_file",
          id: "upload_req-upload",
          fileName: "notes.txt",
          mimeType: "text/plain",
          size: 11,
          path: "/tmp/paseo-uploads/upload_req-upload/notes.txt",
        },
        error: null,
      },
    }),
  );

  await expect(responsePromise).resolves.toEqual({
    requestId: "req-upload",
    file: {
      type: "uploaded_file",
      id: "upload_req-upload",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 11,
      path: "/tmp/paseo-uploads/upload_req-upload/notes.txt",
    },
    error: null,
  });
});

test("normalizes workspace_setup_progress into a workspace-scoped daemon event", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const events: Array<Parameters<Parameters<typeof client.subscribe>[0]>[0]> = [];
  client.subscribe((event) => {
    events.push(event);
  });

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  mock.triggerMessage(
    wrapSessionMessage({
      type: "workspace_setup_progress",
      payload: {
        workspaceId: "ws-feature-a",
        status: "running",
        detail: {
          type: "worktree_setup",
          worktreePath: "/tmp/project/.paseo/worktrees/feature-a",
          branchName: "feature-a",
          log: "phase-one\n",
          commands: [
            {
              index: 1,
              command: "npm install",
              cwd: "/tmp/project/.paseo/worktrees/feature-a",
              log: "phase-one\n",
              status: "running",
              exitCode: null,
            },
          ],
        },
        error: null,
      },
    }),
  );

  expect(events).toContainEqual({
    type: "workspace_setup_progress",
    workspaceId: "ws-feature-a",
    payload: {
      workspaceId: "ws-feature-a",
      status: "running",
      detail: {
        type: "worktree_setup",
        worktreePath: "/tmp/project/.paseo/worktrees/feature-a",
        branchName: "feature-a",
        log: "phase-one\n",
        commands: [
          {
            index: 1,
            command: "npm install",
            cwd: "/tmp/project/.paseo/worktrees/feature-a",
            log: "phase-one\n",
            status: "running",
            exitCode: null,
          },
        ],
      },
      error: null,
    },
  });
});

test("sends create_agent_request with string workspace ids", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const createPromise = client.createAgent({
    provider: "codex",
    cwd: "/tmp/project/.paseo/worktrees/feature-a",
    workspaceId: "ws-feature-a",
    title: "Compat agent",
    modeId: "default",
  });

  expect(mock.sent).toHaveLength(1);
  const request = parseSentFrame(mock.sent[0]);
  expect(request).toEqual(
    expect.objectContaining({
      type: "create_agent_request",
      workspaceId: "ws-feature-a",
    }),
  );

  mock.triggerMessage(
    wrapSessionMessage({
      type: "status",
      payload: {
        status: "agent_create_failed",
        requestId: request.requestId,
        error: "compat test sentinel",
      },
    }),
  );

  await expect(createPromise).rejects.toThrow("compat test sentinel");
});

test("sends worktree target and autoArchive in create_agent_request", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const createPromise = client.createAgent({
    provider: "codex",
    cwd: "/tmp/project",
    worktree: {
      mode: "branch-off",
      newBranch: "agent-lifecycle-dispatch",
      base: "main",
    },
    autoArchive: true,
  });

  expect(mock.sent).toHaveLength(1);
  const request = parseSentFrame(mock.sent[0]);
  expect(request).toEqual(
    expect.objectContaining({
      type: "create_agent_request",
      worktree: {
        mode: "branch-off",
        newBranch: "agent-lifecycle-dispatch",
        base: "main",
      },
      autoArchive: true,
    }),
  );

  mock.triggerMessage(
    wrapSessionMessage({
      type: "status",
      payload: {
        status: "agent_create_failed",
        requestId: request.requestId,
        error: "worktree auto archive sentinel",
      },
    }),
  );

  await expect(createPromise).rejects.toThrow("worktree auto archive sentinel");
});

test("sends structured attachments with create_agent_request", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const createPromise = client.createAgent({
    provider: "codex",
    cwd: "/tmp/project",
    initialPrompt: "Review this PR",
    attachments: [
      {
        type: "github_pr",
        mimeType: "application/github-pr",
        number: 123,
        title: "Fix race in worktree setup",
        url: "https://github.com/getpaseo/paseo/pull/123",
        baseRefName: "main",
        headRefName: "fix/worktree-race",
      },
    ],
  });

  expect(mock.sent).toHaveLength(1);
  const request = parseSentFrame(mock.sent[0]);
  expect(request.attachments).toEqual([
    {
      type: "github_pr",
      mimeType: "application/github-pr",
      number: 123,
      title: "Fix race in worktree setup",
      url: "https://github.com/getpaseo/paseo/pull/123",
      baseRefName: "main",
      headRefName: "fix/worktree-race",
    },
  ]);

  mock.triggerMessage(
    wrapSessionMessage({
      type: "status",
      payload: {
        status: "agent_create_failed",
        requestId: request.requestId,
        error: "attachment test sentinel",
      },
    }),
  );

  await expect(createPromise).rejects.toThrow("attachment test sentinel");
});

test("sends worktree base-ref fields in create_agent_request git options", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const createPromise = client.createAgent({
    provider: "codex",
    cwd: "/tmp/project",
    requestId: "req-agent-ref",
    git: {
      createWorktree: true,
      worktreeSlug: "review-pr-123",
      refName: "feature/worktree-base-ref",
      action: "checkout",
      githubPrNumber: 123,
    },
  });

  expect(mock.sent).toHaveLength(1);
  const request = parseSentFrame(mock.sent[0]);
  expect(request.git).toEqual({
    createWorktree: true,
    worktreeSlug: "review-pr-123",
    refName: "feature/worktree-base-ref",
    action: "checkout",
    githubPrNumber: 123,
  });

  mock.triggerMessage(
    wrapSessionMessage({
      type: "status",
      payload: {
        status: "agent_create_failed",
        requestId: request.requestId,
        error: "git ref fields sentinel",
      },
    }),
  );

  await expect(createPromise).rejects.toThrow("git ref fields sentinel");
});

test("omitting create_agent_request worktree base-ref fields preserves legacy wire shape", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const createPromise = client.createAgent({
    provider: "codex",
    cwd: "/tmp/project",
    requestId: "req-agent-legacy",
    git: {
      createWorktree: true,
      worktreeSlug: "feature-a",
    },
  });

  expect(assertStr(mock.sent[0])).toBe(
    JSON.stringify({
      type: "session",
      message: {
        type: "create_agent_request",
        config: {
          provider: "codex",
          cwd: "/tmp/project",
        },
        git: {
          createWorktree: true,
          worktreeSlug: "feature-a",
        },
        labels: {},
        requestId: "req-agent-legacy",
      },
    }),
  );

  mock.triggerMessage(
    wrapSessionMessage({
      type: "status",
      payload: {
        status: "agent_create_failed",
        requestId: "req-agent-legacy",
        error: "legacy git shape sentinel",
      },
    }),
  );

  await expect(createPromise).rejects.toThrow("legacy git shape sentinel");
});

test("sends structured first-agent context attachments with create_paseo_worktree_request", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const createPromise = client.createPaseoWorktree({
    cwd: "/tmp/project",
    worktreeSlug: "review-pr-123",
    firstAgentContext: {
      attachments: [
        {
          type: "github_pr",
          mimeType: "application/github-pr",
          number: 123,
          title: "Fix race in worktree setup",
          url: "https://github.com/getpaseo/paseo/pull/123",
        },
      ],
    },
  });

  expect(mock.sent).toHaveLength(1);
  const request = parseSentFrame(mock.sent[0]);
  const firstAgentContext = z
    .object({ attachments: z.array(z.unknown()) })
    .parse(request.firstAgentContext);
  expect(firstAgentContext.attachments).toEqual([
    {
      type: "github_pr",
      mimeType: "application/github-pr",
      number: 123,
      title: "Fix race in worktree setup",
      url: "https://github.com/getpaseo/paseo/pull/123",
    },
  ]);

  mock.triggerMessage(
    wrapSessionMessage({
      type: "create_paseo_worktree_response",
      payload: {
        requestId: request.requestId,
        workspace: null,
        error: "worktree attachment sentinel",
        setupTerminalId: null,
      },
    }),
  );

  await expect(createPromise).resolves.toEqual({
    requestId: request.requestId,
    workspace: null,
    error: "worktree attachment sentinel",
    setupTerminalId: null,
  });
});

test("sends project.add.request without creating a workspace", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const addPromise = client.addProject("/tmp/project", "req-add-project");

  expect(mock.sent).toHaveLength(1);
  expect(parseSentFrame(mock.sent[0])).toEqual({
    type: "project.add.request",
    requestId: "req-add-project",
    cwd: "/tmp/project",
  });

  mock.triggerMessage(
    wrapSessionMessage({
      type: "project.add.response",
      payload: {
        requestId: "req-add-project",
        project: {
          projectId: "/tmp/project",
          projectDisplayName: "project",
          projectCustomName: null,
          projectRootPath: "/tmp/project",
          projectKind: "git",
        },
        error: null,
      },
    }),
  );

  await expect(addPromise).resolves.toEqual({
    requestId: "req-add-project",
    project: {
      projectId: "/tmp/project",
      projectDisplayName: "project",
      projectCustomName: null,
      projectRootPath: "/tmp/project",
      projectKind: "git",
    },
    error: null,
  });
});

test("sends first-agent prompt context with workspace.create.request", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const createPromise = client.createWorkspace(
    {
      source: {
        kind: "directory",
        path: "/tmp/project",
        projectId: "local:/tmp/project",
      },
      firstAgentContext: {
        prompt: "Fix login bug",
        attachments: [],
      },
    },
    "req-local-title",
  );

  expect(mock.sent).toHaveLength(1);
  expect(parseSentFrame(mock.sent[0])).toEqual({
    type: "workspace.create.request",
    requestId: "req-local-title",
    source: {
      kind: "directory",
      path: "/tmp/project",
      projectId: "local:/tmp/project",
    },
    firstAgentContext: {
      prompt: "Fix login bug",
      attachments: [],
    },
  });

  mock.triggerMessage(
    wrapSessionMessage({
      type: "workspace.create.response",
      payload: {
        requestId: "req-local-title",
        workspace: null,
        error: "local title sentinel",
        setupTerminalId: null,
      },
    }),
  );

  await expect(createPromise).resolves.toEqual({
    requestId: "req-local-title",
    workspace: null,
    error: "local title sentinel",
    setupTerminalId: null,
  });
});

test("sends project.remove.request", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const removePromise = client.removeProject("remote:github.com/acme/app", "req-remove-project");

  expect(parseSentFrame(mock.sent[0])).toEqual({
    type: "project.remove.request",
    requestId: "req-remove-project",
    projectId: "remote:github.com/acme/app",
  });

  mock.triggerMessage(
    wrapSessionMessage({
      type: "project.remove.response",
      payload: {
        requestId: "req-remove-project",
        projectId: "remote:github.com/acme/app",
        accepted: true,
        removedWorkspaceIds: ["ws-main"],
        error: null,
      },
    }),
  );

  await expect(removePromise).resolves.toEqual({ removedWorkspaceIds: ["ws-main"] });
});

test("sends worktree base-ref fields in create_paseo_worktree_request", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const createPromise = client.createPaseoWorktree(
    {
      cwd: "/tmp/project",
      projectId: "remote:github.com/acme/project",
      worktreeSlug: "review-pr-123",
      refName: "feature/worktree-base-ref",
      action: "checkout",
      githubPrNumber: 123,
    },
    "req-worktree-ref",
  );

  expect(mock.sent).toHaveLength(1);
  const request = parseSentFrame(mock.sent[0]);
  expect(request).toEqual({
    type: "create_paseo_worktree_request",
    cwd: "/tmp/project",
    projectId: "remote:github.com/acme/project",
    worktreeSlug: "review-pr-123",
    refName: "feature/worktree-base-ref",
    action: "checkout",
    githubPrNumber: 123,
    requestId: "req-worktree-ref",
  });

  mock.triggerMessage(
    wrapSessionMessage({
      type: "create_paseo_worktree_response",
      payload: {
        requestId: request.requestId,
        workspace: null,
        error: "worktree ref fields sentinel",
        setupTerminalId: null,
      },
    }),
  );

  await expect(createPromise).resolves.toEqual({
    requestId: request.requestId,
    workspace: null,
    error: "worktree ref fields sentinel",
    setupTerminalId: null,
  });
});

test("omitting create_paseo_worktree_request worktree base-ref fields preserves legacy wire shape", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const createPromise = client.createPaseoWorktree(
    {
      cwd: "/tmp/project",
      worktreeSlug: "feature-a",
    },
    "req-worktree-legacy",
  );

  expect(assertStr(mock.sent[0])).toBe(
    JSON.stringify({
      type: "session",
      message: {
        type: "create_paseo_worktree_request",
        cwd: "/tmp/project",
        worktreeSlug: "feature-a",
        requestId: "req-worktree-legacy",
      },
    }),
  );

  mock.triggerMessage(
    wrapSessionMessage({
      type: "create_paseo_worktree_response",
      payload: {
        requestId: "req-worktree-legacy",
        workspace: null,
        error: "legacy worktree shape sentinel",
        setupTerminalId: null,
      },
    }),
  );

  await expect(createPromise).resolves.toEqual({
    requestId: "req-worktree-legacy",
    workspace: null,
    error: "legacy worktree shape sentinel",
    setupTerminalId: null,
  });
});

test("sends explicit shutdown_server_request via shutdownServer", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  expect(typeof client.shutdownServer).toBe("function");
  const promise = client.shutdownServer({ requestId: "req-shutdown-1" });

  expect(mock.sent).toHaveLength(1);
  const request = parseSentFrame(mock.sent[0]);
  expect(request).toEqual({
    type: "shutdown_server_request",
    requestId: "req-shutdown-1",
  });

  mock.triggerMessage(
    wrapSessionMessage({
      type: "status",
      payload: {
        status: "shutdown_requested",
        clientId: "clsk_unit_test",
        requestId: "req-shutdown-1",
      },
    }),
  );

  await expect(promise).resolves.toEqual({
    status: "shutdown_requested",
    clientId: "clsk_unit_test",
    requestId: "req-shutdown-1",
  });
});

test("restartServer remains restart-only and sends restart_server_request", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const promise = client.restartServer("settings_update", "req-restart-1");

  expect(mock.sent).toHaveLength(1);
  const request = parseSentFrame(mock.sent[0]);
  expect(request).toEqual({
    type: "restart_server_request",
    reason: "settings_update",
    requestId: "req-restart-1",
  });

  mock.triggerMessage(
    wrapSessionMessage({
      type: "status",
      payload: {
        status: "restart_requested",
        clientId: "clsk_unit_test",
        reason: "settings_update",
        requestId: "req-restart-1",
      },
    }),
  );

  await expect(promise).resolves.toEqual({
    status: "restart_requested",
    clientId: "clsk_unit_test",
    reason: "settings_update",
    requestId: "req-restart-1",
  });
});

test("transitions out of connecting when connect timeout elapses", async () => {
  useHeartbeatClock();
  try {
    const logger = createMockLogger();
    const mock = createMockTransport();

    const client = new DaemonClient({
      url: "ws://test",
      clientId: "clsk_unit_test",
      logger,
      reconnect: { enabled: false },
      connectTimeoutMs: 100,
      transportFactory: () => mock.transport,
    });
    clients.push(client);

    const pendingConnect = client.connect().then(
      () => ({ ok: true as const }),
      (error) => ({ ok: false as const, error }),
    );
    expect(client.getConnectionState().status).toBe("connecting");

    await vi.advanceTimersByTimeAsync(120);
    const result = await pendingConnect;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
      if (result.error instanceof Error) {
        expect(result.error.message).toContain("Connection timed out");
      }
    }
    expect(client.getConnectionState().status).toBe("disconnected");
  } finally {
    vi.useRealTimers();
  }
});

test("reconnects after relay close with replaced-by-new-connection reason", async () => {
  useHeartbeatClock();
  try {
    const logger = createMockLogger();
    const first = createMockTransport();
    const second = createMockTransport();
    const transports = [first, second];
    let transportIndex = 0;

    const client = new DaemonClient({
      url: "ws://relay.test/ws?role=client&serverId=srv_test&v=2",
      clientId: "clsk_test",
      logger,
      reconnect: {
        enabled: true,
        baseDelayMs: 5,
        maxDelayMs: 5,
      },
      transportFactory: () => {
        const next = transports[Math.min(transportIndex, transports.length - 1)];
        transportIndex += 1;
        return next.transport;
      },
    });
    clients.push(client);

    const connectPromise = client.connect();
    first.triggerOpen();
    await connectPromise;
    expect(client.getConnectionState().status).toBe("connected");

    first.triggerClose({ code: 1008, reason: "Replaced by new connection" });
    expect(client.getConnectionState().status).toBe("disconnected");

    await vi.advanceTimersByTimeAsync(10);
    expect(client.getConnectionState().status).toBe("connecting");

    second.triggerOpen();
    expect(client.getConnectionState().status).toBe("connected");
  } finally {
    vi.useRealTimers();
  }
});

test("requires non-empty clientId", () => {
  expect(() => {
    const _client = new DaemonClient({
      url: "ws://relay.test/ws?role=client&serverId=srv_test&v=2",
      clientId: "",
      reconnect: { enabled: false },
    });
    void _client;
  }).toThrow("Daemon client requires a non-empty clientId");
});

test("requires non-empty clientId for direct connections", () => {
  expect(() => {
    const _client = new DaemonClient({
      url: "ws://127.0.0.1:6767/ws",
      clientId: "   ",
      reconnect: { enabled: false },
    });
    void _client;
  }).toThrow("Daemon client requires a non-empty clientId");
});

test("logs configured runtime generation in connection transition events", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    runtimeGeneration: 7,
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const transitionPayloads = logger.debug.mock.calls.filter(
    ([, message]) => message === "DaemonClientTransition",
  );
  expect(transitionPayloads.length).toBeGreaterThan(0);
  for (const [payload] of transitionPayloads) {
    expect(
      z.object({ generation: z.number().nullable().optional() }).parse(payload).generation,
    ).toBe(7);
  }
});

test("subscribes to checkout diff updates via RPC handshake", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const promise = client.subscribeCheckoutDiff(
    "/tmp/project",
    { mode: "uncommitted" },
    { subscriptionId: "checkout-sub-1" },
  );

  expect(mock.sent).toHaveLength(1);
  const request = parseSentFrame(mock.sent[0]);
  expect(request.type).toBe("subscribe_checkout_diff_request");
  expect(request.subscriptionId).toBe("checkout-sub-1");
  expect(request.cwd).toBe("/tmp/project");
  expect(request.compare).toEqual({ mode: "uncommitted" });

  mock.triggerMessage(
    JSON.stringify({
      type: "session",
      message: {
        type: "subscribe_checkout_diff_response",
        payload: {
          subscriptionId: "checkout-sub-1",
          cwd: "/tmp/project",
          files: [],
          error: null,
          requestId: request.requestId,
        },
      },
    }),
  );

  await expect(promise).resolves.toEqual({
    subscriptionId: "checkout-sub-1",
    cwd: "/tmp/project",
    files: [],
    error: null,
    requestId: request.requestId,
  });
});

test("getCheckoutDiff uses one-shot subscription protocol", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const promise = client.getCheckoutDiff("/tmp/project", { mode: "base", baseRef: "main" });

  expect(mock.sent).toHaveLength(1);
  const subscribeRequest = parseSentFrame(mock.sent[0]);
  expect(subscribeRequest.type).toBe("subscribe_checkout_diff_request");
  expect(subscribeRequest.cwd).toBe("/tmp/project");
  expect(subscribeRequest.compare).toEqual({
    mode: "base",
    baseRef: "main",
  });

  mock.triggerMessage(
    JSON.stringify({
      type: "session",
      message: {
        type: "subscribe_checkout_diff_response",
        payload: {
          subscriptionId: subscribeRequest.subscriptionId,
          cwd: "/tmp/project",
          files: [],
          error: null,
          requestId: subscribeRequest.requestId,
        },
      },
    }),
  );

  await expect(promise).resolves.toEqual({
    cwd: "/tmp/project",
    files: [],
    error: null,
    requestId: subscribeRequest.requestId,
  });

  expect(mock.sent).toHaveLength(2);
  const unsubscribeRequest = parseSentFrame(mock.sent[1]);
  expect(unsubscribeRequest.type).toBe("unsubscribe_checkout_diff_request");
  expect(unsubscribeRequest.subscriptionId).toBe(subscribeRequest.subscriptionId);
});

test("requests branch suggestions via RPC", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const promise = client.getBranchSuggestions(
    { cwd: "/tmp/project", query: "mai", limit: 5 },
    "req-branches",
  );

  expect(mock.sent).toHaveLength(1);
  const request = parseSentFrame(mock.sent[0]);
  expect(request.type).toBe("branch_suggestions_request");
  expect(request.cwd).toBe("/tmp/project");
  expect(request.query).toBe("mai");
  expect(request.limit).toBe(5);
  expect(request.requestId).toBe("req-branches");

  mock.triggerMessage(
    JSON.stringify({
      type: "session",
      message: {
        type: "branch_suggestions_response",
        payload: {
          branches: ["main"],
          error: null,
          requestId: "req-branches",
        },
      },
    }),
  );

  await expect(promise).resolves.toEqual({
    branches: ["main"],
    error: null,
    requestId: "req-branches",
  });
});

test("reads project config via correlated RPC", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();
  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const promise = client.readProjectConfig("/repo/app", "read-project-config-1");

  expect(mock.sent).toHaveLength(1);
  const request = parseSentFrame(mock.sent[0]);
  expect(request).toEqual({
    type: "read_project_config_request",
    requestId: "read-project-config-1",
    repoRoot: "/repo/app",
  });

  mock.triggerMessage(
    wrapSessionMessage({
      type: "read_project_config_response",
      payload: {
        requestId: "read-project-config-1",
        repoRoot: "/repo/app",
        ok: true,
        config: { worktree: { setup: "npm install" } },
        revision: { mtimeMs: 10, size: 20 },
      },
    }),
  );

  await expect(promise).resolves.toEqual({
    requestId: "read-project-config-1",
    repoRoot: "/repo/app",
    ok: true,
    config: { worktree: { setup: "npm install" } },
    revision: { mtimeMs: 10, size: 20 },
  });
});

test("writes project config via correlated RPC and returns inline failures", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();
  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const promise = client.writeProjectConfig({
    requestId: "write-project-config-1",
    repoRoot: "/repo/app",
    config: { worktree: { setup: ["npm install"] } },
    expectedRevision: { mtimeMs: 10, size: 20 },
  });

  expect(mock.sent).toHaveLength(1);
  const request = parseSentFrame(mock.sent[0]);
  expect(request).toEqual({
    type: "write_project_config_request",
    requestId: "write-project-config-1",
    repoRoot: "/repo/app",
    config: { worktree: { setup: ["npm install"] } },
    expectedRevision: { mtimeMs: 10, size: 20 },
  });

  mock.triggerMessage(
    wrapSessionMessage({
      type: "write_project_config_response",
      payload: {
        requestId: "write-project-config-1",
        repoRoot: "/repo/app",
        ok: false,
        error: {
          code: "stale_project_config",
          currentRevision: { mtimeMs: 11, size: 21 },
        },
      },
    }),
  );

  await expect(promise).resolves.toEqual({
    requestId: "write-project-config-1",
    repoRoot: "/repo/app",
    ok: false,
    error: {
      code: "stale_project_config",
      currentRevision: { mtimeMs: 11, size: 21 },
    },
  });
});

test("requests directory suggestions via RPC", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const promise = client.getDirectorySuggestions(
    {
      query: "proj",
      limit: 10,
      cwd: "/tmp/project",
      includeFiles: true,
      includeDirectories: true,
      matchMode: "suffix",
    },
    "req-directories",
  );

  expect(mock.sent).toHaveLength(1);
  const request = parseSentFrame(mock.sent[0]);
  expect(request.type).toBe("directory_suggestions_request");
  expect(request.query).toBe("proj");
  expect(request.cwd).toBe("/tmp/project");
  expect(request.includeFiles).toBe(true);
  expect(request.includeDirectories).toBe(true);
  expect(request.matchMode).toBe("suffix");
  expect(request.limit).toBe(10);
  expect(request.requestId).toBe("req-directories");

  mock.triggerMessage(
    JSON.stringify({
      type: "session",
      message: {
        type: "directory_suggestions_response",
        payload: {
          directories: ["/Users/test/projects/paseo"],
          entries: [{ path: "README.md", kind: "file" }],
          error: null,
          requestId: "req-directories",
        },
      },
    }),
  );

  await expect(promise).resolves.toEqual({
    directories: ["/Users/test/projects/paseo"],
    entries: [{ path: "README.md", kind: "file" }],
    error: null,
    requestId: "req-directories",
  });
});

test("requests checkout merge from base via RPC", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const promise = client.checkoutMergeFromBase(
    "/tmp/project",
    { baseRef: "main", requireCleanTarget: true },
    "req-merge-from-base",
  );

  expect(mock.sent).toHaveLength(1);
  const request = parseSentFrame(mock.sent[0]);
  expect(request.type).toBe("checkout_merge_from_base_request");
  expect(request.cwd).toBe("/tmp/project");
  expect(request.baseRef).toBe("main");
  expect(request.requireCleanTarget).toBe(true);
  expect(request.requestId).toBe("req-merge-from-base");

  mock.triggerMessage(
    JSON.stringify({
      type: "session",
      message: {
        type: "checkout_merge_from_base_response",
        payload: {
          cwd: "/tmp/project",
          requestId: "req-merge-from-base",
          success: true,
          error: null,
        },
      },
    }),
  );

  await expect(promise).resolves.toEqual({
    cwd: "/tmp/project",
    requestId: "req-merge-from-base",
    success: true,
    error: null,
  });
});

test("requests GitHub auto-merge enable via namespaced RPC", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const promise = client.checkoutGithubSetAutoMerge(
    "/tmp/project",
    { enabled: true, method: "squash" },
    "req-enable-auto-merge",
  );

  expect(mock.sent).toHaveLength(1);
  const request = parseSentFrame(mock.sent[0]);
  expect(request.type).toBe("checkout.github.set_auto_merge.request");
  expect(request.cwd).toBe("/tmp/project");
  expect(request.enabled).toBe(true);
  expect(request.mergeMethod).toBe("squash");
  expect(request.requestId).toBe("req-enable-auto-merge");

  mock.triggerMessage(
    JSON.stringify({
      type: "session",
      message: {
        type: "checkout.github.set_auto_merge.response",
        payload: {
          cwd: "/tmp/project",
          enabled: true,
          requestId: "req-enable-auto-merge",
          success: true,
          error: null,
        },
      },
    }),
  );

  await expect(promise).resolves.toEqual({
    cwd: "/tmp/project",
    enabled: true,
    requestId: "req-enable-auto-merge",
    success: true,
    error: null,
  });
});

test("requests GitHub auto-merge disable via namespaced RPC", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const promise = client.checkoutGithubSetAutoMerge(
    "/tmp/project",
    { enabled: false },
    "req-disable-auto-merge",
  );

  expect(mock.sent).toHaveLength(1);
  const request = parseSentFrame(mock.sent[0]);
  expect(request.type).toBe("checkout.github.set_auto_merge.request");
  expect(request.cwd).toBe("/tmp/project");
  expect(request.enabled).toBe(false);
  expect(request.mergeMethod).toBeUndefined();
  expect(request.requestId).toBe("req-disable-auto-merge");

  mock.triggerMessage(
    JSON.stringify({
      type: "session",
      message: {
        type: "checkout.github.set_auto_merge.response",
        payload: {
          cwd: "/tmp/project",
          enabled: false,
          requestId: "req-disable-auto-merge",
          success: true,
          error: null,
        },
      },
    }),
  );

  await expect(promise).resolves.toEqual({
    cwd: "/tmp/project",
    enabled: false,
    requestId: "req-disable-auto-merge",
    success: true,
    error: null,
  });
});

test("requests GitHub check details via namespaced RPC", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const promise = client.checkoutGithubGetCheckDetails(
    {
      cwd: "/tmp/project",
      repoOwner: "getpaseo",
      repoName: "paseo",
      checkRunId: 12345,
      workflowRunId: 456,
    },
    "req-check-details",
  );

  expect(mock.sent).toHaveLength(1);
  const request = parseSentFrame(mock.sent[0]);
  expect(request).toMatchObject({
    type: "checkout.github.get_check_details.request",
    cwd: "/tmp/project",
    repoOwner: "getpaseo",
    repoName: "paseo",
    checkRunId: 12345,
    workflowRunId: 456,
    requestId: "req-check-details",
  });

  mock.triggerMessage(
    JSON.stringify({
      type: "session",
      message: {
        type: "checkout.github.get_check_details.response",
        payload: {
          cwd: "/tmp/project",
          requestId: "req-check-details",
          success: true,
          details: {
            checkRunId: 12345,
            workflowRunId: 456,
            name: "server-tests",
            status: "completed",
            conclusion: "failure",
            annotations: [],
            failedJobs: [],
            truncated: false,
          },
          error: null,
        },
      },
    }),
  );

  await expect(promise).resolves.toEqual({
    cwd: "/tmp/project",
    requestId: "req-check-details",
    success: true,
    details: {
      checkRunId: 12345,
      workflowRunId: 456,
      name: "server-tests",
      status: "completed",
      conclusion: "failure",
      annotations: [],
      failedJobs: [],
      truncated: false,
    },
    error: null,
  });
});

test("requests checkout pull via RPC", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const promise = client.checkoutPull("/tmp/project", "req-pull");

  expect(mock.sent).toHaveLength(1);
  const request = parseSentFrame(mock.sent[0]);
  expect(request.type).toBe("checkout_pull_request");
  expect(request.cwd).toBe("/tmp/project");
  expect(request.requestId).toBe("req-pull");

  mock.triggerMessage(
    JSON.stringify({
      type: "session",
      message: {
        type: "checkout_pull_response",
        payload: {
          cwd: "/tmp/project",
          requestId: "req-pull",
          success: true,
          error: null,
        },
      },
    }),
  );

  await expect(promise).resolves.toEqual({
    cwd: "/tmp/project",
    requestId: "req-pull",
    success: true,
    error: null,
  });
});

test("renames a branch via RPC", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const promise = client.renameBranch({
    cwd: "/tmp/project",
    branch: "feature/new-name",
    requestId: "req-rename-branch",
  });

  expect(mock.sent).toHaveLength(1);
  const request = JSON.parse(mock.sent[0]) as {
    type: "session";
    message: {
      type: "checkout.rename_branch.request";
      cwd: string;
      branch: string;
      requestId: string;
    };
  };
  expect(request.message.type).toBe("checkout.rename_branch.request");
  expect(request.message.cwd).toBe("/tmp/project");
  expect(request.message.branch).toBe("feature/new-name");
  expect(request.message.requestId).toBe("req-rename-branch");

  mock.triggerMessage(
    JSON.stringify({
      type: "session",
      message: {
        type: "checkout.rename_branch.response",
        payload: {
          requestId: "req-rename-branch",
          success: true,
          cwd: "/tmp/project",
          currentBranch: "feature/new-name",
          error: null,
        },
      },
    }),
  );

  await expect(promise).resolves.toEqual({
    requestId: "req-rename-branch",
    success: true,
    cwd: "/tmp/project",
    currentBranch: "feature/new-name",
    error: null,
  });
});

test("returns renameBranch business failures", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const promise = client.renameBranch({
    cwd: "/tmp/project",
    branch: "already-exists",
    requestId: "req-rename-branch-fail",
  });

  expect(mock.sent).toHaveLength(1);

  mock.triggerMessage(
    JSON.stringify({
      type: "session",
      message: {
        type: "checkout.rename_branch.response",
        payload: {
          requestId: "req-rename-branch-fail",
          success: false,
          cwd: "/tmp/project",
          currentBranch: null,
          error: { code: "NOT_ALLOWED", message: "Branch already exists" },
        },
      },
    }),
  );

  await expect(promise).resolves.toEqual({
    requestId: "req-rename-branch-fail",
    success: false,
    cwd: "/tmp/project",
    currentBranch: null,
    error: { code: "NOT_ALLOWED", message: "Branch already exists" },
  });
});

test("resubscribes checkout diff streams after reconnect", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const internal = client as unknown as {
    checkoutDiffSubscriptions: Map<
      string,
      { cwd: string; compare: { mode: "uncommitted" | "base"; baseRef?: string } }
    >;
  };
  internal.checkoutDiffSubscriptions.set("checkout-sub-1", {
    cwd: "/tmp/project",
    compare: { mode: "base", baseRef: "main" },
  });

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  expect(mock.sent).toHaveLength(1);
  const request = parseSentFrame(mock.sent[0]);
  expect(request.type).toBe("subscribe_checkout_diff_request");
  expect(request.subscriptionId).toBe("checkout-sub-1");
  expect(request.cwd).toBe("/tmp/project");
  expect(request.compare).toEqual({ mode: "base", baseRef: "main" });
  expect(typeof request.requestId).toBe("string");
  expect(z.string().parse(request.requestId).length).toBeGreaterThan(0);
});

test("fetches agents via RPC with filters, sort, and pagination", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const promise = client.fetchAgents({
    filter: { labels: { surface: "workspace" } },
    sort: [
      { key: "status_priority", direction: "asc" },
      { key: "created_at", direction: "desc" },
    ],
    page: { limit: 25, cursor: "cursor-1" },
    subscribe: { subscriptionId: "sub-1" },
  });

  expect(mock.sent).toHaveLength(1);
  const request = parseSentFrame(mock.sent[0]);
  expect(request.type).toBe("fetch_agents_request");
  expect(request.sort).toEqual([
    { key: "status_priority", direction: "asc" },
    { key: "created_at", direction: "desc" },
  ]);
  expect(request.page).toEqual({ limit: 25, cursor: "cursor-1" });
  expect(request.subscribe).toEqual({ subscriptionId: "sub-1" });

  mock.triggerMessage(
    JSON.stringify({
      type: "session",
      message: {
        type: "fetch_agents_response",
        payload: {
          requestId: request.requestId,
          subscriptionId: "sub-1",
          entries: [],
          pageInfo: {
            nextCursor: null,
            prevCursor: "cursor-1",
            hasMore: false,
          },
        },
      },
    }),
  );

  await expect(promise).resolves.toEqual({
    requestId: request.requestId,
    subscriptionId: "sub-1",
    entries: [],
    pageInfo: {
      nextCursor: null,
      prevCursor: "cursor-1",
      hasMore: false,
    },
  });
});

test("detaches an agent through the namespaced detach RPC", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const promise = client.detachAgent("child-agent");

  expect(mock.sent).toHaveLength(1);
  const request = parseSentFrame(mock.sent[0]);
  expect(request).toMatchObject({
    type: "agent.detach.request",
    agentId: "child-agent",
  });
  expect(typeof request.requestId).toBe("string");

  mock.triggerMessage(
    wrapSessionMessage({
      type: "agent.detach.response",
      payload: {
        requestId: request.requestId,
        agentId: "child-agent",
        accepted: true,
        error: null,
      },
    }),
  );

  await expect(promise).resolves.toBeUndefined();
});

test("sends active-scoped fetch_agents_request", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const promise = client.fetchAgents({
    scope: "active",
    page: { limit: 50 },
  });

  expect(mock.sent).toHaveLength(1);
  const request = parseSentFrame(mock.sent[0]);
  expect(request).toMatchObject({
    type: "fetch_agents_request",
    scope: "active",
  });

  mock.triggerMessage(
    JSON.stringify({
      type: "session",
      message: {
        type: "fetch_agents_response",
        payload: {
          requestId: request.requestId,
          entries: [],
          pageInfo: {
            nextCursor: null,
            prevCursor: null,
            hasMore: false,
          },
        },
      },
    }),
  );

  await expect(promise).resolves.toMatchObject({
    requestId: request.requestId,
    entries: [],
  });
});

test("fetches paginated agent history separately from active agents", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const promise = client.fetchAgentHistory({
    page: { limit: 25, cursor: "cursor-1" },
    sort: [{ key: "updated_at", direction: "desc" }],
  });

  expect(mock.sent).toHaveLength(1);
  const request = parseSentFrame(mock.sent[0]);
  expect(request.type).toBe("fetch_agent_history_request");
  expect(request.page).toEqual({ limit: 25, cursor: "cursor-1" });

  mock.triggerMessage(
    JSON.stringify({
      type: "session",
      message: {
        type: "fetch_agent_history_response",
        payload: {
          requestId: request.requestId,
          entries: [],
          pageInfo: {
            nextCursor: null,
            prevCursor: "cursor-1",
            hasMore: false,
          },
        },
      },
    }),
  );

  await expect(promise).resolves.toEqual({
    requestId: request.requestId,
    entries: [],
    pageInfo: {
      nextCursor: null,
      prevCursor: "cursor-1",
      hasMore: false,
    },
  });
});

test("fetches scoped recent provider sessions", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const promise = client.fetchRecentProviderSessions({
    cwd: "/tmp/repo",
    providers: ["my-claude"],
    since: "2026-04-30T00:00:00.000Z",
    limit: 25,
  });

  expect(mock.sent).toHaveLength(1);
  const request = JSON.parse(String(mock.sent[0])) as {
    type: "session";
    message: {
      type: "fetch_recent_provider_sessions_request";
      requestId: string;
      cwd?: string;
      providers?: string[];
      since?: string;
      limit?: number;
    };
  };
  expect(request.message).toMatchObject({
    type: "fetch_recent_provider_sessions_request",
    cwd: "/tmp/repo",
    providers: ["my-claude"],
    since: "2026-04-30T00:00:00.000Z",
    limit: 25,
  });

  mock.triggerMessage(
    JSON.stringify({
      type: "session",
      message: {
        type: "fetch_recent_provider_sessions_response",
        payload: {
          requestId: request.message.requestId,
          entries: [
            {
              providerId: "codex",
              providerLabel: "Codex",
              providerHandleId: "thread-1",
              cwd: "/tmp/repo",
              title: "Import me",
              firstPromptPreview: "first prompt",
              lastPromptPreview: "last prompt",
              lastActivityAt: "2026-04-30T12:34:56.000Z",
            },
          ],
        },
      },
    }),
  );

  await expect(promise).resolves.toEqual({
    requestId: request.message.requestId,
    entries: [
      {
        providerId: "codex",
        providerLabel: "Codex",
        providerHandleId: "thread-1",
        cwd: "/tmp/repo",
        title: "Import me",
        firstPromptPreview: "first prompt",
        lastPromptPreview: "last prompt",
        lastActivityAt: "2026-04-30T12:34:56.000Z",
      },
    ],
  });
});

test("imports an agent by provider handle id", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const promise = client.importAgent({
    providerId: "custom-codex",
    providerHandleId: "thread-1",
    cwd: "/tmp/repo",
  });

  expect(mock.sent).toHaveLength(1);
  const request = JSON.parse(String(mock.sent[0])) as {
    type: "session";
    message: {
      type: "import_agent_request";
      requestId: string;
      providerId?: string;
      providerHandleId?: string;
      sessionId?: string;
      cwd?: string;
    };
  };
  expect(request.message).toMatchObject({
    type: "import_agent_request",
    providerId: "custom-codex",
    providerHandleId: "thread-1",
    cwd: "/tmp/repo",
  });
  expect(request.message).not.toHaveProperty("sessionId");

  mock.triggerMessage(
    wrapSessionMessage({
      type: "status",
      payload: {
        status: "agent_resumed",
        requestId: request.message.requestId,
        agentId: "agent-1",
        timelineSize: 0,
        agent: {
          id: "agent-1",
          provider: "custom-codex",
          cwd: "/tmp/repo",
          model: null,
          features: [],
          thinkingOptionId: null,
          effectiveThinkingOptionId: null,
          createdAt: "2026-04-30T00:00:00.000Z",
          updatedAt: "2026-04-30T00:00:00.000Z",
          lastUserMessageAt: null,
          status: "idle",
          capabilities: {
            supportsStreaming: false,
            supportsSessionPersistence: false,
            supportsDynamicModes: false,
            supportsMcpServers: false,
            supportsReasoningStream: false,
            supportsToolInvocations: false,
          },
          currentModeId: null,
          availableModes: [],
          pendingPermissions: [],
          persistence: {
            provider: "custom-codex",
            sessionId: "thread-1",
            nativeHandle: "thread-1",
          },
          title: null,
          labels: {},
          requiresAttention: false,
          attentionReason: null,
        },
      },
    }),
  );

  await expect(promise).resolves.toMatchObject({
    id: "agent-1",
    provider: "custom-codex",
  });
});

test("uses server-provided dictation finish timeout budget", async () => {
  useHeartbeatClock();
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const finishPromise = client.finishDictationStream("dict-1", 0);
  const finishError = finishPromise.then(
    () => null,
    (error) => error,
  );

  expect(mock.sent).toHaveLength(1);
  mock.triggerMessage(
    wrapSessionMessage({
      type: "dictation_stream_finish_accepted",
      payload: {
        dictationId: "dict-1",
        timeoutMs: 100,
      },
    }),
  );

  await vi.advanceTimersByTimeAsync(5_101);
  const error = await finishError;
  expect(error).toBeInstanceOf(Error);
  if (error instanceof Error) {
    expect(error.message).toContain("Timeout waiting for dictation finalization (5100ms)");
  }

  vi.useRealTimers();
});

test("resolves dictation finish when final arrives after finish accepted", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const finishPromise = client.finishDictationStream("dict-2", 1);
  expect(mock.sent).toHaveLength(1);

  mock.triggerMessage(
    wrapSessionMessage({
      type: "dictation_stream_finish_accepted",
      payload: {
        dictationId: "dict-2",
        timeoutMs: 1000,
      },
    }),
  );
  mock.triggerMessage(
    wrapSessionMessage({
      type: "dictation_stream_final",
      payload: {
        dictationId: "dict-2",
        text: "hello",
      },
    }),
  );

  await expect(finishPromise).resolves.toEqual({
    dictationId: "dict-2",
    text: "hello",
  });
});

test("cancels waiters when send fails (no leaked timeouts)", async () => {
  useHeartbeatClock();
  const logger = createMockLogger();
  const mock = createMockTransport();
  let sendCount = 0;

  const transportFactory = () => ({
    ...mock.transport,
    send: () => {
      sendCount += 1;
      if (sendCount > 1) {
        throw new Error("boom");
      }
    },
  });

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const promise = client.getCheckoutStatus("/tmp/project");
  await expect(promise).rejects.toThrow("boom");

  // Ensure we didn't leave a waiter behind that will reject later.
  const internal = client as unknown as { waiters: Set<unknown> };
  expect(internal.waiters.size).toBe(0);

  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
});

test("lists available providers via RPC", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const promise = client.listAvailableProviders();
  expect(mock.sent).toHaveLength(1);

  const request = parseSentFrame(mock.sent[0]);
  expect(request.type).toBe("list_available_providers_request");

  mock.triggerMessage(
    JSON.stringify({
      type: "session",
      message: {
        type: "list_available_providers_response",
        payload: {
          providers: [
            { provider: "claude", available: true, error: null },
            { provider: "codex", available: false, error: "Missing binary" },
          ],
          error: null,
          fetchedAt: "2026-02-12T00:00:00.000Z",
          requestId: request.requestId,
        },
      },
    }),
  );

  await expect(promise).resolves.toEqual({
    providers: [
      { provider: "claude", available: true, error: null },
      { provider: "codex", available: false, error: "Missing binary" },
    ],
    error: null,
    fetchedAt: "2026-02-12T00:00:00.000Z",
    requestId: request.requestId,
  });
});

test("lists commands with draft config via RPC", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const promise = client.listCommands({
    agentId: "__new_agent__",
    draftConfig: {
      provider: "codex",
      cwd: "/tmp/project",
      modeId: "bypassPermissions",
      model: "gpt-5",
      thinkingOptionId: "off",
    },
  });
  expect(mock.sent).toHaveLength(1);

  const request = parseSentFrame(mock.sent[0]);
  expect(request.type).toBe("list_commands_request");
  expect(request.agentId).toBe("__new_agent__");
  expect(request.draftConfig).toEqual({
    provider: "codex",
    cwd: "/tmp/project",
    modeId: "bypassPermissions",
    model: "gpt-5",
    thinkingOptionId: "off",
  });

  mock.triggerMessage(
    JSON.stringify({
      type: "session",
      message: {
        type: "list_commands_response",
        payload: {
          agentId: "__new_agent__",
          commands: [{ name: "help", description: "Show help", argumentHint: "" }],
          error: null,
          requestId: request.requestId,
        },
      },
    }),
  );

  await expect(promise).resolves.toEqual({
    agentId: "__new_agent__",
    commands: [{ name: "help", description: "Show help", argumentHint: "" }],
    error: null,
    requestId: request.requestId,
  });
});

test("lists commands with explicit requestId via RPC", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const promise = client.listCommands({
    agentId: "agent-1",
    requestId: "req-commands",
  });
  expect(mock.sent).toHaveLength(1);

  const request = parseSentFrame(mock.sent[0]);
  expect(request.type).toBe("list_commands_request");
  expect(request.agentId).toBe("agent-1");
  expect(request.requestId).toBe("req-commands");
  expect(request.draftConfig).toBeUndefined();

  mock.triggerMessage(
    JSON.stringify({
      type: "session",
      message: {
        type: "list_commands_response",
        payload: {
          agentId: "agent-1",
          commands: [],
          error: null,
          requestId: "req-commands",
        },
      },
    }),
  );

  await expect(promise).resolves.toEqual({
    agentId: "agent-1",
    commands: [],
    error: null,
    requestId: "req-commands",
  });
});

test("preserves legacy listCommands id overload", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const promise = client.listCommands("agent-1", "req-commands-legacy");

  expect(parseSentFrame(mock.sent[0])).toEqual({
    type: "list_commands_request",
    requestId: "req-commands-legacy",
    agentId: "agent-1",
  });

  mock.triggerMessage(
    wrapSessionMessage({
      type: "list_commands_response",
      payload: {
        agentId: "agent-1",
        commands: [],
        error: null,
        requestId: "req-commands-legacy",
      },
    }),
  );

  await expect(promise).resolves.toEqual({
    agentId: "agent-1",
    commands: [],
    error: null,
    requestId: "req-commands-legacy",
  });
});

test("preserves legacy listCommands options overload", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const promise = client.listCommands("__new_agent__", {
    requestId: "req-commands-draft-legacy",
    draftConfig: {
      provider: "codex",
      cwd: "/tmp/project",
      modeId: "bypassPermissions",
      model: "gpt-5",
      thinkingOptionId: "off",
    },
  });

  expect(parseSentFrame(mock.sent[0])).toEqual({
    type: "list_commands_request",
    requestId: "req-commands-draft-legacy",
    agentId: "__new_agent__",
    draftConfig: {
      provider: "codex",
      cwd: "/tmp/project",
      modeId: "bypassPermissions",
      model: "gpt-5",
      thinkingOptionId: "off",
    },
  });

  mock.triggerMessage(
    wrapSessionMessage({
      type: "list_commands_response",
      payload: {
        agentId: "__new_agent__",
        commands: [{ name: "help", description: "Show help", argumentHint: "" }],
        error: null,
        requestId: "req-commands-draft-legacy",
      },
    }),
  );

  await expect(promise).resolves.toEqual({
    agentId: "__new_agent__",
    commands: [{ name: "help", description: "Show help", argumentHint: "" }],
    error: null,
    requestId: "req-commands-draft-legacy",
  });
});

test("emits output events for the active terminal stream", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const seen: string[] = [];
  const unsubscribe = client.onTerminalStreamEvent((event) => {
    if (event.type !== "output") {
      return;
    }
    seen.push(new TextDecoder().decode(event.data));
  });

  const subscribePromise = client.subscribeTerminal("term-1", "sub-1");
  mock.triggerMessage(
    wrapSessionMessage({
      type: "subscribe_terminal_response",
      payload: {
        terminalId: "term-1",
        slot: 11,
        error: null,
        requestId: "sub-1",
      },
    }),
  );
  await subscribePromise;

  mock.triggerMessage(
    encodeTerminalStreamFrame({
      opcode: TerminalStreamOpcode.Output,
      slot: 11,
      payload: new TextEncoder().encode("hello"),
    }),
  );

  expect(seen).toEqual(["hello"]);
  expect(mock.sent).toHaveLength(1);
  unsubscribe();
});

test("emits snapshot events for the subscribed terminal stream", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const snapshots: unknown[] = [];
  client.onTerminalStreamEvent((event) => {
    if (event.type !== "snapshot") {
      return;
    }
    snapshots.push(event.state);
  });

  const subscribePromise = client.subscribeTerminal("term-1", "sub-2");
  mock.triggerMessage(
    wrapSessionMessage({
      type: "subscribe_terminal_response",
      payload: {
        terminalId: "term-1",
        slot: 12,
        error: null,
        requestId: "sub-2",
      },
    }),
  );
  await subscribePromise;

  const state = {
    rows: 1,
    cols: 5,
    grid: [[{ char: "h" }, { char: "e" }, { char: "l" }, { char: "l" }, { char: "o" }]],
    scrollback: [],
    cursor: { row: 0, col: 5 },
  };
  mock.triggerMessage(
    encodeTerminalStreamFrame({
      opcode: TerminalStreamOpcode.Snapshot,
      slot: 12,
      payload: encodeTerminalSnapshotPayload(state),
    }),
  );

  expect(snapshots).toEqual([state]);
});

test("sends input and resize frames for the subscribed terminal slot", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const subscribePromise = client.subscribeTerminal("term-1", "sub-3");
  mock.triggerMessage(
    wrapSessionMessage({
      type: "subscribe_terminal_response",
      payload: {
        terminalId: "term-1",
        slot: 13,
        error: null,
        requestId: "sub-3",
      },
    }),
  );
  await subscribePromise;
  mock.sent.length = 0;

  client.sendTerminalInput("term-1", {
    type: "input",
    data: "echo hello\r",
  });
  client.sendTerminalInput("term-1", {
    type: "resize",
    rows: 24,
    cols: 80,
  });

  const inputFrame = decodeTerminalStreamFrame(asUint8Array(mock.sent[0])!);
  const resizeFrame = decodeTerminalStreamFrame(asUint8Array(mock.sent[1])!);

  expect(inputFrame?.opcode).toBe(TerminalStreamOpcode.Input);
  expect(inputFrame?.slot).toBe(13);
  expect(new TextDecoder().decode(inputFrame?.payload ?? new Uint8Array())).toBe("echo hello\r");
  expect(resizeFrame?.opcode).toBe(TerminalStreamOpcode.Resize);
  expect(resizeFrame?.slot).toBe(13);
  expect(decodeTerminalResizePayload(resizeFrame?.payload ?? new Uint8Array())).toEqual({
    rows: 24,
    cols: 80,
  });
});

test("routes concurrent terminal stream frames by slot", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const seen: string[] = [];
  client.onTerminalStreamEvent((event) => {
    if (event.type !== "output") {
      return;
    }
    seen.push(`${event.terminalId}:${new TextDecoder().decode(event.data)}`);
  });

  const subscribeFirstPromise = client.subscribeTerminal("term-1", "sub-multi-1");
  mock.triggerMessage(
    wrapSessionMessage({
      type: "subscribe_terminal_response",
      payload: {
        terminalId: "term-1",
        slot: 21,
        error: null,
        requestId: "sub-multi-1",
      },
    }),
  );
  await subscribeFirstPromise;

  const subscribeSecondPromise = client.subscribeTerminal("term-2", "sub-multi-2");
  mock.triggerMessage(
    wrapSessionMessage({
      type: "subscribe_terminal_response",
      payload: {
        terminalId: "term-2",
        slot: 22,
        error: null,
        requestId: "sub-multi-2",
      },
    }),
  );
  await subscribeSecondPromise;
  mock.sent.length = 0;

  mock.triggerMessage(
    encodeTerminalStreamFrame({
      opcode: TerminalStreamOpcode.Output,
      slot: 22,
      payload: new TextEncoder().encode("beta"),
    }),
  );
  mock.triggerMessage(
    encodeTerminalStreamFrame({
      opcode: TerminalStreamOpcode.Output,
      slot: 21,
      payload: new TextEncoder().encode("alpha"),
    }),
  );

  client.sendTerminalInput("term-2", {
    type: "input",
    data: "echo beta\r",
  });
  client.sendTerminalInput("term-1", {
    type: "resize",
    rows: 10,
    cols: 20,
  });

  const inputFrame = decodeTerminalStreamFrame(asUint8Array(mock.sent[0])!);
  const resizeFrame = decodeTerminalStreamFrame(asUint8Array(mock.sent[1])!);

  expect(seen).toEqual(["term-2:beta", "term-1:alpha"]);
  expect(inputFrame?.opcode).toBe(TerminalStreamOpcode.Input);
  expect(inputFrame?.slot).toBe(22);
  expect(resizeFrame?.opcode).toBe(TerminalStreamOpcode.Resize);
  expect(resizeFrame?.slot).toBe(21);
});

test("ignores terminal stream frames after terminal_stream_exit", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const seen: string[] = [];
  const unsubscribe = client.onTerminalStreamEvent((event) => {
    if (event.type !== "output") {
      return;
    }
    seen.push(new TextDecoder().decode(event.data));
  });

  const subscribePromise = client.subscribeTerminal("term-1", "sub-4");
  mock.triggerMessage(
    wrapSessionMessage({
      type: "subscribe_terminal_response",
      payload: {
        terminalId: "term-1",
        slot: 14,
        error: null,
        requestId: "sub-4",
      },
    }),
  );
  await subscribePromise;

  mock.triggerMessage(
    encodeTerminalStreamFrame({
      opcode: TerminalStreamOpcode.Output,
      slot: 14,
      payload: new TextEncoder().encode("before-exit"),
    }),
  );
  expect(seen).toEqual(["before-exit"]);

  mock.triggerMessage(
    wrapSessionMessage({
      type: "terminal_stream_exit",
      payload: {
        terminalId: "term-1",
      },
    }),
  );

  mock.triggerMessage(
    encodeTerminalStreamFrame({
      opcode: TerminalStreamOpcode.Output,
      slot: 14,
      payload: new TextEncoder().encode("after-exit"),
    }),
  );

  expect(seen).toEqual(["before-exit"]);
  unsubscribe();
});

test("parses canonical agent_stream tool_call payloads without crashing", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const received: unknown[] = [];
  const unsubscribe = client.on("agent_stream", (msg) => {
    received.push(msg);
  });

  mock.triggerMessage(
    wrapSessionMessage({
      type: "agent_stream",
      payload: {
        agentId: "agent_cli",
        timestamp: "2026-02-08T20:20:00.000Z",
        event: {
          type: "timeline",
          provider: "codex",
          item: {
            type: "tool_call",
            callId: "call_cli_stream",
            name: "shell",
            status: "running",
            detail: {
              type: "shell",
              command: "pwd",
            },
            error: null,
          },
        },
      },
    }),
  );

  unsubscribe();

  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({
    payload: {
      event: {
        item: {
          status: "running",
          error: null,
          detail: { type: "shell" },
        },
      },
    },
  });
  expect(logger.warn).not.toHaveBeenCalled();
});

test("drops legacy agent_stream tool_call payloads and logs validation warning", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const received: unknown[] = [];
  const unsubscribe = client.on("agent_stream", (msg) => {
    received.push(msg);
  });

  mock.triggerMessage(
    wrapSessionMessage({
      type: "agent_stream",
      payload: {
        agentId: "agent_cli",
        timestamp: "2026-02-08T20:20:00.000Z",
        event: {
          type: "timeline",
          provider: "codex",
          item: {
            type: "tool_call",
            callId: "call_cli_stream_legacy",
            name: "shell",
            status: "inProgress",
            detail: {
              type: "unknown",
              input: { command: "pwd" },
              output: null,
            },
          },
        },
      },
    }),
  );

  unsubscribe();

  expect(received).toHaveLength(0);
  expect(logger.warn).toHaveBeenCalled();
});

test("parses canonical fetch_agent_timeline_response payloads without crashing", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const received: unknown[] = [];
  const unsubscribe = client.on("fetch_agent_timeline_response", (msg) => {
    received.push(msg);
  });

  mock.triggerMessage(
    wrapSessionMessage({
      type: "fetch_agent_timeline_response",
      payload: {
        requestId: "req-1",
        agentId: "agent_cli",
        agent: null,
        direction: "tail",
        projection: "projected",
        epoch: "epoch-1",
        reset: false,
        staleCursor: false,
        gap: false,
        window: { minSeq: 1, maxSeq: 1, nextSeq: 2 },
        startCursor: { epoch: "epoch-1", seq: 1 },
        endCursor: { epoch: "epoch-1", seq: 1 },
        hasOlder: false,
        hasNewer: false,
        entries: [
          {
            timestamp: "2026-02-08T20:20:00.000Z",
            provider: "codex",
            seqStart: 1,
            seqEnd: 1,
            sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }],
            collapsed: [],
            item: {
              type: "tool_call",
              callId: "call_cli_snapshot",
              name: "shell",
              status: "running",
              detail: {
                type: "shell",
                command: "pwd",
              },
              error: null,
            },
          },
        ],
        error: null,
      },
    }),
  );

  unsubscribe();

  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({
    payload: {
      entries: [
        {
          item: {
            type: "tool_call",
            status: "running",
            error: null,
            detail: { type: "shell" },
          },
        },
      ],
    },
  });
  expect(logger.warn).not.toHaveBeenCalled();
});

test("drops invalid fetch_agent_timeline_response tool_call payloads and logs validation warning", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const received: unknown[] = [];
  const unsubscribe = client.on("fetch_agent_timeline_response", (msg) => {
    received.push(msg);
  });

  mock.triggerMessage(
    wrapSessionMessage({
      type: "fetch_agent_timeline_response",
      payload: {
        requestId: "req-invalid",
        agentId: "agent_cli",
        agent: null,
        direction: "tail",
        projection: "projected",
        epoch: "epoch-1",
        reset: false,
        staleCursor: false,
        gap: false,
        window: { minSeq: 1, maxSeq: 1, nextSeq: 2 },
        startCursor: { epoch: "epoch-1", seq: 1 },
        endCursor: { epoch: "epoch-1", seq: 1 },
        hasOlder: false,
        hasNewer: false,
        entries: [
          {
            timestamp: "2026-02-08T20:20:00.000Z",
            provider: "codex",
            seqStart: 1,
            seqEnd: 1,
            sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }],
            collapsed: [],
            item: {
              type: "tool_call",
              callId: "call_cli_invalid",
              name: "shell",
              status: "inProgress",
              detail: {
                type: "unknown",
                input: { command: "pwd" },
                output: null,
              },
            },
          },
        ],
        error: null,
      },
    }),
  );

  unsubscribe();

  expect(received).toHaveLength(0);
  expect(logger.warn).toHaveBeenCalled();
});

test("sends subscribe/unsubscribe terminals messages", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  client.subscribeTerminals({ cwd: "/tmp/project" });
  client.unsubscribeTerminals({ cwd: "/tmp/project" });

  expect(mock.sent).toHaveLength(2);
  expect(JSON.parse(assertStr(mock.sent[0]))).toEqual({
    type: "session",
    message: {
      type: "subscribe_terminals_request",
      cwd: "/tmp/project",
    },
  });
  expect(JSON.parse(assertStr(mock.sent[1]))).toEqual({
    type: "session",
    message: {
      type: "unsubscribe_terminals_request",
      cwd: "/tmp/project",
    },
  });
});

test("dispatches terminals_changed events to typed listeners", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const received: Array<{ cwd: string; names: string[] }> = [];
  const unsubscribe = client.on("terminals_changed", (message) => {
    received.push({
      cwd: message.payload.cwd,
      names: message.payload.terminals.map((terminal) => terminal.name),
    });
  });

  mock.triggerMessage(
    wrapSessionMessage({
      type: "terminals_changed",
      payload: {
        cwd: "/tmp/project",
        terminals: [
          {
            id: "term-1",
            name: "Dev Server",
          },
        ],
      },
    }),
  );

  unsubscribe();

  expect(received).toEqual([
    {
      cwd: "/tmp/project",
      names: ["Dev Server"],
    },
  ]);
});

test("sends provider.usage.list.request and resolves provider.usage.list.response", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const usagePromise = client.listProviderUsage({ requestId: "usage-1" });

  expect(JSON.parse(assertStr(mock.sent[0]))).toEqual({
    type: "session",
    message: {
      type: "provider.usage.list.request",
      requestId: "usage-1",
    },
  });

  mock.triggerMessage(
    wrapSessionMessage({
      type: "provider.usage.list.response",
      payload: {
        requestId: "usage-1",
        fetchedAt: "2026-06-19T00:00:00.000Z",
        providers: [
          {
            providerId: "glm",
            displayName: "GLM coding plan",
            status: "available",
            planLabel: "GLM coding plan",
            windows: [
              {
                id: "biweekly",
                label: "Biweekly",
                usedPct: 23,
                remainingPct: 77,
              },
            ],
          },
        ],
      },
    }),
  );

  await expect(usagePromise).resolves.toEqual({
    requestId: "usage-1",
    fetchedAt: "2026-06-19T00:00:00.000Z",
    providers: [
      {
        providerId: "glm",
        displayName: "GLM coding plan",
        status: "available",
        planLabel: "GLM coding plan",
        windows: [
          {
            id: "biweekly",
            label: "Biweekly",
            usedPct: 23,
            remainingPct: 77,
          },
        ],
      },
    ],
  });
});

test("sends close_items_request and resolves close_items_response", async () => {
  const logger = createMockLogger();
  const mock = createMockTransport();

  const client = new DaemonClient({
    url: "ws://test",
    clientId: "clsk_unit_test",
    logger,
    reconnect: { enabled: false },
    transportFactory: () => mock.transport,
  });
  clients.push(client);

  const connectPromise = client.connect();
  mock.triggerOpen();
  await connectPromise;

  const responsePromise = client.closeItems(
    {
      agentIds: ["agent-1"],
      terminalIds: ["term-1"],
    },
    "req-close-items",
  );

  expect(JSON.parse(assertStr(mock.sent[0]))).toEqual({
    type: "session",
    message: {
      type: "close_items_request",
      agentIds: ["agent-1"],
      terminalIds: ["term-1"],
      requestId: "req-close-items",
    },
  });

  mock.triggerMessage(
    wrapSessionMessage({
      type: "close_items_response",
      payload: {
        agents: [{ agentId: "agent-1", archivedAt: "2026-04-01T00:00:00.000Z" }],
        terminals: [{ terminalId: "term-1", success: true }],
        requestId: "req-close-items",
      },
    }),
  );

  await expect(responsePromise).resolves.toEqual({
    agents: [{ agentId: "agent-1", archivedAt: "2026-04-01T00:00:00.000Z" }],
    terminals: [{ terminalId: "term-1", success: true }],
    requestId: "req-close-items",
  });
});

test("waitForFinish with timeout=0 omits timeoutMs and has no client deadline", async () => {
  useHeartbeatClock();
  try {
    const logger = createMockLogger();
    const mock = createMockTransport();

    const client = new DaemonClient({
      url: "ws://test",
      clientId: "clsk_unit_test",
      logger,
      reconnect: { enabled: false },
      transportFactory: () => mock.transport,
    });
    clients.push(client);

    const connectPromise = client.connect();
    mock.triggerOpen();
    await connectPromise;

    const waitPromise = client.waitForFinish("agent-wait-zero-timeout", 0);

    expect(mock.sent).toHaveLength(1);
    const request = parseSentFrame(mock.sent[0]);
    expect(request.type).toBe("wait_for_finish_request");
    expect(request.agentId).toBe("agent-wait-zero-timeout");
    expect(request).not.toHaveProperty("timeoutMs");

    let settled: "pending" | "resolved" | "rejected" = "pending";
    void waitPromise.then(
      () => {
        settled = "resolved";
        return null;
      },
      () => {
        settled = "rejected";
        return null;
      },
    );

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(settled).toBe("pending");

    mock.triggerMessage(
      wrapSessionMessage({
        type: "wait_for_finish_response",
        payload: {
          requestId: request.requestId,
          status: "idle",
          final: null,
          error: null,
          lastMessage: null,
        },
      }),
    );

    await expect(waitPromise).resolves.toEqual({
      status: "idle",
      final: null,
      error: null,
      lastMessage: null,
    });
  } finally {
    vi.useRealTimers();
  }
});
