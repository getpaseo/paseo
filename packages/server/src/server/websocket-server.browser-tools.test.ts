import { createServer, type Server as HTTPServer } from "node:http";
import type { AddressInfo } from "node:net";

import type {
  BrowserAutomationExecuteRequest,
  BrowserAutomationExecuteResponse,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { CLIENT_CAPS } from "@getpaseo/protocol/client-capabilities";
import type pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import { BrowserToolsBroker } from "./browser-tools/broker.js";
import { StaticBrowserToolsPolicy } from "./browser-tools/policy.js";
import type { CheckoutDiffManager } from "./checkout-diff-manager.js";
import type { FileBackedChatService } from "./chat/chat-service.js";
import type { DaemonConfigStore } from "./daemon-config-store.js";
import type { DownloadTokenStore } from "./file-download/token-store.js";
import type { LoopService } from "./loop-service.js";
import type { ScheduleService } from "./schedule/service.js";
import { createStub } from "./test-utils/class-mocks.js";
import { DaemonClient } from "./test-utils/daemon-client.js";
import { createProviderSnapshotManagerStub } from "./test-utils/session-stubs.js";
import { VoiceAssistantWebSocketServer } from "./websocket-server.js";

interface BrowserToolsDaemonHarness {
  broker: BrowserToolsBroker;
  connectDesktopBrowserClient(
    options?: ConnectDesktopBrowserClientOptions,
  ): Promise<DesktopBrowserClientHandle>;
  stop(): Promise<void>;
}

interface ConnectDesktopBrowserClientOptions {
  clientId?: string;
  capabilities?: Partial<Record<string, boolean>>;
}

interface DesktopBrowserClientHandle {
  clientId: string;
  nextBrowserRequest(): Promise<BrowserAutomationExecuteRequest>;
  respondToBrowserRequest(response: BrowserAutomationExecuteResponse): void;
  disconnect(): Promise<void>;
}

interface QueuedBrowserRequests {
  next(): Promise<BrowserAutomationExecuteRequest>;
  push(request: BrowserAutomationExecuteRequest): void;
  close(): void;
}

const harnesses: BrowserToolsDaemonHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.stop()));
});

describe("WebSocketServer browser tools wiring", () => {
  it("registers capable clients and dispatches broker requests over the real WebSocket path", async () => {
    const harness = await startBrowserToolsDaemonHarness();
    const desktop = await harness.connectDesktopBrowserClient();

    const resultPromise = harness.broker.execute({
      command: { command: "list_tabs", args: {} },
    });
    const request = await desktop.nextBrowserRequest();

    expect(request).toMatchObject({
      type: "browser.automation.execute.request",
      requestId: "req-1",
      command: { command: "list_tabs", args: {} },
    });

    desktop.respondToBrowserRequest({
      type: "browser.automation.execute.response",
      payload: {
        requestId: request.requestId,
        ok: true,
        result: { command: "list_tabs", tabs: [] },
      },
    });

    await expect(resultPromise).resolves.toEqual({
      requestId: request.requestId,
      ok: true,
      result: { command: "list_tabs", tabs: [] },
    });
  });

  it("unregisters capable clients on disconnect and clears pending browser commands", async () => {
    const harness = await startBrowserToolsDaemonHarness();
    const desktop = await harness.connectDesktopBrowserClient();

    const pendingResult = harness.broker.execute({
      command: { command: "list_tabs", args: {} },
    });
    const pendingExpectation = expect(pendingResult).resolves.toMatchObject({
      ok: false,
      error: { code: "browser_no_desktop", retryable: true },
    });
    await desktop.nextBrowserRequest();

    expect(harness.broker.getPendingRequestCount()).toBe(1);

    await desktop.disconnect();

    expect(harness.broker.getRegisteredClientCount()).toBe(0);
    expect(harness.broker.getPendingRequestCount()).toBe(0);
    await pendingExpectation;

    await expect(
      harness.broker.execute({ command: { command: "list_tabs", args: {} } }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "browser_no_desktop" },
    });
  });

  it("keeps browser automation registered when a desktop browser client resumes", async () => {
    const harness = await startBrowserToolsDaemonHarness();
    const clientId = "desktop-client-1";
    await harness.connectDesktopBrowserClient({
      clientId,
      capabilities: { [CLIENT_CAPS.desktopBrowserAutomation]: true },
    });

    const resumedDesktop = await harness.connectDesktopBrowserClient({
      clientId,
      capabilities: { [CLIENT_CAPS.desktopBrowserAutomation]: true },
    });

    const resultPromise = harness.broker.execute({
      command: { command: "click", args: { ref: "@e1" } },
    });
    const request = await resumedDesktop.nextBrowserRequest();
    resumedDesktop.respondToBrowserRequest({
      type: "browser.automation.execute.response",
      payload: {
        requestId: request.requestId,
        ok: true,
        result: { command: "click", browserId: "browser-1", ref: "@e1" },
      },
    });

    await expect(resultPromise).resolves.toMatchObject({
      ok: true,
      result: { command: "click", browserId: "browser-1", ref: "@e1" },
    });
  });
});

async function startBrowserToolsDaemonHarness(): Promise<BrowserToolsDaemonHarness> {
  const httpServer = createServer();
  const broker = createBroker();
  const wsServer = createVoiceAssistantWebSocketServer({ httpServer, broker });
  const clients = new Set<DaemonClient>();

  await listen(httpServer);
  const url = `ws://127.0.0.1:${getPort(httpServer)}/ws`;

  const harness: BrowserToolsDaemonHarness = {
    broker,
    async connectDesktopBrowserClient(options = {}) {
      const clientId = options.clientId;
      const client = new DaemonClient({
        url,
        ...(clientId ? { clientId } : {}),
        clientType: "browser",
        connectTimeoutMs: 500,
        reconnect: { enabled: false },
        capabilities: options.capabilities ?? { [CLIENT_CAPS.desktopBrowserAutomation]: true },
      });
      clients.add(client);

      const requests = createBrowserRequestQueue();
      client.on("browser.automation.execute.request", (request) => {
        requests.push(request);
      });

      await client.connect();

      return {
        clientId: clientId ?? "",
        nextBrowserRequest: () => requests.next(),
        respondToBrowserRequest: (response) =>
          client.sendBrowserAutomationExecuteResponse(response),
        async disconnect() {
          requests.close();
          clients.delete(client);
          await client.close();
          await waitFor(() => broker.getRegisteredClientCount() === 0);
        },
      };
    },
    async stop() {
      await Promise.all(Array.from(clients, (client) => client.close()));
      clients.clear();
      await wsServer.close();
      await closeHttpServer(httpServer);
    },
  };

  harnesses.push(harness);
  return harness;
}

function createBroker(): BrowserToolsBroker {
  return new BrowserToolsBroker({
    policy: new StaticBrowserToolsPolicy(true),
    defaultTimeoutMs: 500,
    createRequestId: createRequestIdSequence(),
  });
}

function createRequestIdSequence(): () => string {
  let index = 0;
  return () => {
    index += 1;
    return `req-${index}`;
  };
}

function createVoiceAssistantWebSocketServer(params: {
  httpServer: HTTPServer;
  broker: BrowserToolsBroker;
}): VoiceAssistantWebSocketServer {
  const { httpServer, broker } = params;
  const agentManager = {
    setAgentAttentionCallback: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    getMetricsSnapshot: vi.fn(() => ({
      total: 0,
      byLifecycle: {},
      withActiveForegroundTurn: 0,
      timelineStats: { totalItems: 0, maxItemsPerAgent: 0 },
    })),
  };
  const daemonConfigStore = {
    onChange: vi.fn(() => () => {}),
  };

  return new VoiceAssistantWebSocketServer(
    httpServer,
    createStub<pino.Logger>(createLogger()),
    "srv-test",
    createStub<AgentManager>(agentManager),
    createStub<AgentStorage>({}),
    createStub<DownloadTokenStore>({}),
    "/tmp/paseo-browser-tools-websocket-test",
    createStub<DaemonConfigStore>(daemonConfigStore),
    null,
    { allowedOrigins: new Set(["*"]) },
    undefined,
    undefined,
    undefined,
    undefined,
    "1.2.3-test",
    undefined,
    undefined,
    undefined,
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
    undefined,
    createProviderSnapshotManagerStub().manager,
    undefined,
    undefined,
    broker,
  );
}

function createBrowserRequestQueue(): QueuedBrowserRequests {
  const requests: BrowserAutomationExecuteRequest[] = [];
  const waiters: Array<{
    resolve: (request: BrowserAutomationExecuteRequest) => void;
    reject: (error: Error) => void;
  }> = [];
  let closed = false;

  return {
    next() {
      const request = requests.shift();
      if (request) {
        return Promise.resolve(request);
      }
      if (closed) {
        return Promise.reject(new Error("Desktop browser client disconnected"));
      }
      return new Promise<BrowserAutomationExecuteRequest>((resolve, reject) => {
        let timeout: ReturnType<typeof setTimeout>;
        const waiter = {
          resolve: (value: BrowserAutomationExecuteRequest) => {
            clearTimeout(timeout);
            resolve(value);
          },
          reject: (error: Error) => {
            clearTimeout(timeout);
            reject(error);
          },
        };
        timeout = setTimeout(() => {
          const waiterIndex = waiters.indexOf(waiter);
          if (waiterIndex !== -1) {
            waiters.splice(waiterIndex, 1);
          }
          reject(new Error("Timed out waiting for browser automation request"));
        }, 500);
        waiters.push(waiter);
      });
    },
    push(request) {
      const waiter = waiters.shift();
      if (waiter) {
        waiter.resolve(request);
        return;
      }
      requests.push(request);
    },
    close() {
      closed = true;
      for (const waiter of waiters.splice(0)) {
        waiter.reject(new Error("Desktop browser client disconnected"));
      }
    },
  };
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

function listen(server: HTTPServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function getPort(server: HTTPServer): number {
  const address = server.address();
  if (!isAddressInfo(address)) {
    throw new Error("HTTP test server did not bind to a TCP port");
  }
  return address.port;
}

function isAddressInfo(address: string | AddressInfo | null): address is AddressInfo {
  return typeof address === "object" && address !== null && typeof address.port === "number";
}

function closeHttpServer(server: HTTPServer): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 500) {
      throw new Error("Timed out waiting for browser tools WebSocket state");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
