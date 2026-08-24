import { createServer, type Server as HTTPServer } from "node:http";
import type { AddressInfo } from "node:net";
import { hostname } from "node:os";

import type {
  BrowserAutomationCommandName,
  BrowserAutomationExecuteRequest,
  BrowserAutomationExecuteResponse,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { BROWSER_AUTOMATION_COMMAND_NAMES } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import type { BrowserTabsChanged } from "@getpaseo/protocol/browser-automation/client-command";
import { CLIENT_CAPS } from "@getpaseo/protocol/client-capabilities";
import type {
  BrowserScreencastEvent,
  DaemonClientTrace,
} from "@getpaseo/client/internal/daemon-client";
import type pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import { BrowserToolsBroker } from "./browser-tools/broker.js";
import type { CheckoutDiffManager } from "./checkout-diff-manager.js";
import type { DaemonConfigStore } from "./daemon-config-store.js";
import type { DownloadTokenStore } from "./file-download/token-store.js";
import type { ScheduleService } from "./schedule/service.js";
import { createStub } from "./test-utils/class-mocks.js";
import { DaemonClient } from "./test-utils/daemon-client.js";
import { createProviderSnapshotManagerStub } from "./test-utils/session-stubs.js";
import { VoiceAssistantWebSocketServer } from "./websocket-server.js";
import type { WorkspaceAutoName } from "./workspace-auto-name.js";

interface BrowserToolsDaemonHarness {
  broker: BrowserToolsBroker;
  connectBrowserHostClient(
    options?: ConnectBrowserHostClientOptions,
  ): Promise<BrowserHostClientHandle>;
  connectViewerClient(options?: ConnectViewerClientOptions): Promise<DaemonClient>;
  stop(): Promise<void>;
}

interface ConnectBrowserHostClientOptions {
  clientId?: string;
  capabilities?: Record<string, unknown>;
}

interface ConnectViewerClientOptions {
  /** An app old enough to have no `browser.tabs.changed` branch. */
  understandsBrowserMirror?: boolean;
  /** Two app windows share one client id, so their sockets share one session. */
  clientId?: string;
  trace?: DaemonClientTrace;
}

interface BrowserHostClientHandle {
  clientId: string;
  announceBrowserTabs(): void;
  nextBrowserRequest(): Promise<BrowserAutomationExecuteRequest>;
  respondToBrowserRequest(response: BrowserAutomationExecuteResponse): void;
  sendScreencastFrame(input: { slot: number; data: Uint8Array }): void;
  disconnect(): Promise<void>;
}

interface QueuedBrowserRequests {
  next(): Promise<BrowserAutomationExecuteRequest>;
  push(request: BrowserAutomationExecuteRequest): void;
  close(): void;
}

const harnesses: BrowserToolsDaemonHarness[] = [];
const BROWSER_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_BROWSER_ID = "22222222-2222-4222-8222-222222222222";

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.stop()));
});

function browserHostCapabilities(
  supportedCommands: readonly BrowserAutomationCommandName[] = BROWSER_AUTOMATION_COMMAND_NAMES,
): Record<string, unknown> {
  return {
    [CLIENT_CAPS.browserHost]: {
      supportedCommands: [...supportedCommands],
      hostKind: "desktop app",
    },
  };
}

function createWorkspaceAutoNameStub(): WorkspaceAutoName {
  return createStub<WorkspaceAutoName>({
    scheduleForWorktree: () => {},
    scheduleForDirectory: () => {},
  });
}

describe("WebSocketServer browser tools wiring", () => {
  it("registers capable clients and dispatches broker requests over the real WebSocket path", async () => {
    const harness = await startBrowserToolsDaemonHarness();
    const browserHost = await harness.connectBrowserHostClient();

    const resultPromise = harness.broker.execute({
      command: { command: "list_tabs", args: {} },
    });
    const request = await browserHost.nextBrowserRequest();

    expect(request).toMatchObject({
      type: "browser.automation.execute.request",
      requestId: "req-1",
      command: { command: "list_tabs", args: {} },
    });

    browserHost.respondToBrowserRequest({
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
    const browserHost = await harness.connectBrowserHostClient();

    const pendingResult = harness.broker.execute({
      command: { command: "list_tabs", args: {} },
    });
    const pendingExpectation = expect(pendingResult).resolves.toMatchObject({
      ok: false,
      error: { code: "browser_no_host", retryable: true },
    });
    await browserHost.nextBrowserRequest();

    expect(harness.broker.getPendingRequestCount()).toBe(1);

    await browserHost.disconnect();

    expect(harness.broker.getRegisteredClientCount()).toBe(0);
    expect(harness.broker.getPendingRequestCount()).toBe(0);
    await pendingExpectation;

    await expect(
      harness.broker.execute({ command: { command: "list_tabs", args: {} } }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "browser_no_host" },
    });
  });

  it("keeps browser automation registered when a browser host client resumes", async () => {
    const harness = await startBrowserToolsDaemonHarness();
    const clientId = "browser-host-client-1";
    await harness.connectBrowserHostClient({
      clientId,
      capabilities: browserHostCapabilities(),
    });

    const resumedBrowserHost = await harness.connectBrowserHostClient({
      clientId,
      capabilities: browserHostCapabilities(),
    });

    const resultPromise = harness.broker.execute({
      command: { command: "click", args: { browserId: BROWSER_ID, ref: "@e1" } },
    });
    const request = await resumedBrowserHost.nextBrowserRequest();
    resumedBrowserHost.respondToBrowserRequest({
      type: "browser.automation.execute.response",
      payload: {
        requestId: request.requestId,
        ok: true,
        result: { command: "click", browserId: BROWSER_ID, ref: "@e1" },
      },
    });

    await expect(resultPromise).resolves.toMatchObject({
      ok: true,
      result: { command: "click", browserId: BROWSER_ID, ref: "@e1" },
    });
  });

  it("clears pending browser commands when a browser host changes capabilities", async () => {
    const harness = await startBrowserToolsDaemonHarness();
    const clientId = "browser-host-client-1";
    const browserHost = await harness.connectBrowserHostClient({
      clientId,
      capabilities: browserHostCapabilities(),
    });

    const pendingResult = harness.broker.execute({
      command: { command: "snapshot", args: { browserId: BROWSER_ID } },
    });
    await browserHost.nextBrowserRequest();
    expect(harness.broker.getPendingRequestCount()).toBe(1);

    await harness.connectBrowserHostClient({
      clientId,
      capabilities: browserHostCapabilities(["list_tabs"]),
    });

    await expect(pendingResult).resolves.toMatchObject({
      ok: false,
      error: { code: "browser_no_host", retryable: true },
    });
    expect(harness.broker.getRegisteredClientCount()).toBe(1);
    expect(harness.broker.getPendingRequestCount()).toBe(0);
  });

  it("advertises the browser mirror feature only while a mirror-capable host is registered", async () => {
    const harness = await startBrowserToolsDaemonHarness();
    const viewer = await harness.connectViewerClient();

    expect(viewer.getLastServerInfoMessage()?.features?.browserMirror).toBeUndefined();

    const browserHost = await harness.connectBrowserHostClient({ clientId: "browser-host-1" });
    await waitFor(() => viewer.getLastServerInfoMessage()?.features?.browserMirror === true);

    await browserHost.disconnect();
    await waitFor(() => viewer.getLastServerInfoMessage()?.features?.browserMirror === undefined);
  });

  it("does not advertise the mirror for a host without the screencast and input commands", async () => {
    const harness = await startBrowserToolsDaemonHarness();
    const viewer = await harness.connectViewerClient();

    await harness.connectBrowserHostClient({
      clientId: "automation-only-host",
      capabilities: browserHostCapabilities(["list_tabs", "navigate", "click", "evaluate"]),
    });
    await waitFor(() => harness.broker.getRegisteredClientCount() === 1);

    expect(harness.broker.getMirrorCapableClientCount()).toBe(0);
    expect(viewer.getLastServerInfoMessage()?.features?.browserMirror).toBeUndefined();
  });

  it("runs a client browser command across every host and stamps host identity on tabs", async () => {
    const harness = await startBrowserToolsDaemonHarness();
    const firstHost = await harness.connectBrowserHostClient({ clientId: "browser-host-1" });
    const secondHost = await harness.connectBrowserHostClient({ clientId: "browser-host-2" });
    const viewer = await harness.connectViewerClient();

    const commandPromise = viewer.runBrowserCommand({
      command: { command: "list_tabs", args: {} },
      workspaceId: "workspace-1",
    });

    await respondWithTab(firstHost, { browserId: BROWSER_ID, url: "https://one.example" });
    await respondWithTab(secondHost, { browserId: SECOND_BROWSER_ID, url: "https://two.example" });

    await expect(commandPromise).resolves.toMatchObject({
      ok: true,
      result: {
        command: "list_tabs",
        tabs: [
          { browserId: BROWSER_ID, hostId: "browser-host-1", hostLabel: hostname() },
          { browserId: SECOND_BROWSER_ID, hostId: "browser-host-2", hostLabel: hostname() },
        ],
      },
    });
  });

  it("broadcasts the browser tab set to viewers when a host announces a change", async () => {
    const harness = await startBrowserToolsDaemonHarness();
    const browserHost = await harness.connectBrowserHostClient({ clientId: "browser-host-1" });
    const viewer = await harness.connectViewerClient();

    const pushes: BrowserTabsChanged[] = [];
    viewer.on("browser.tabs.changed", (message) => {
      pushes.push(message);
    });

    browserHost.announceBrowserTabs();
    await respondWithTab(browserHost, { browserId: BROWSER_ID, url: "https://one.example" });
    await waitFor(() => pushes.length === 1);

    expect(pushes[0]).toMatchObject({
      type: "browser.tabs.changed",
      payload: {
        tabs: [{ browserId: BROWSER_ID, hostId: "browser-host-1", hostLabel: hostname() }],
      },
    });
  });

  it("keeps the tab push away from a client that never claimed to understand it", async () => {
    const harness = await startBrowserToolsDaemonHarness();
    const browserHost = await harness.connectBrowserHostClient({ clientId: "browser-host-1" });
    const legacyViewer = await harness.connectViewerClient({ understandsBrowserMirror: false });
    const currentViewer = await harness.connectViewerClient();

    const legacyPushes: BrowserTabsChanged[] = [];
    legacyViewer.on("browser.tabs.changed", (message) => {
      legacyPushes.push(message);
    });
    const currentPushes: BrowserTabsChanged[] = [];
    currentViewer.on("browser.tabs.changed", (message) => {
      currentPushes.push(message);
    });

    browserHost.announceBrowserTabs();
    await respondWithTab(browserHost, { browserId: BROWSER_ID, url: "https://one.example" });
    await waitFor(() => currentPushes.length === 1);

    expect(legacyPushes).toEqual([]);
  });

  it("lists tabs from the hosts that can while one host cannot list them at all", async () => {
    const harness = await startBrowserToolsDaemonHarness();
    await harness.connectBrowserHostClient({
      clientId: "incapable-host",
      capabilities: browserHostCapabilities(["input_at", "screencast_start", "screencast_stop"]),
    });
    const capableHost = await harness.connectBrowserHostClient({ clientId: "capable-host" });
    const viewer = await harness.connectViewerClient();

    const commandPromise = viewer.runBrowserCommand({
      command: { command: "list_tabs", args: {} },
      workspaceId: "workspace-1",
    });
    await respondWithTab(capableHost, { browserId: BROWSER_ID, url: "https://one.example" });

    await expect(commandPromise).resolves.toMatchObject({
      ok: true,
      result: {
        command: "list_tabs",
        tabs: [{ browserId: BROWSER_ID, hostId: "capable-host" }],
      },
    });
  });

  it("returns the broker failure payload untouched when no host can run the command", async () => {
    const harness = await startBrowserToolsDaemonHarness();
    const viewer = await harness.connectViewerClient();

    await expect(
      viewer.runBrowserCommand({ command: { command: "list_tabs", args: {} } }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "browser_no_host", retryable: true },
    });
  });

  it("mirrors screencast frames from the host to a subscribed viewer", async () => {
    const harness = await startBrowserToolsDaemonHarness();
    const browserHost = await harness.connectBrowserHostClient({ clientId: "browser-host-1" });
    const viewer = await harness.connectViewerClient();

    const frames: BrowserScreencastEvent[] = [];
    viewer.onBrowserScreencastFrame((event) => {
      frames.push(event);
    });

    const subscribePromise = viewer.subscribeBrowserScreencast(BROWSER_ID);
    const startRequest = await browserHost.nextBrowserRequest();
    expect(startRequest.command).toMatchObject({
      command: "screencast_start",
      args: { browserId: BROWSER_ID, slot: 0 },
    });
    browserHost.respondToBrowserRequest({
      type: "browser.automation.execute.response",
      payload: {
        requestId: startRequest.requestId,
        ok: true,
        result: { command: "screencast_start", browserId: BROWSER_ID, slot: 0 },
      },
    });
    await expect(subscribePromise).resolves.toMatchObject({ browserId: BROWSER_ID, slot: 0 });

    browserHost.sendScreencastFrame({ slot: 0, data: new TextEncoder().encode("jpeg-bytes") });
    await waitFor(() => frames.length === 1);

    expect(frames[0]).toMatchObject({
      browserId: BROWSER_ID,
      metadata: { deviceWidth: 1280, deviceHeight: 800 },
    });
    expect(new TextDecoder().decode(frames[0].data)).toBe("jpeg-bytes");

    viewer.unsubscribeBrowserScreencast(BROWSER_ID);
    const stopRequest = await browserHost.nextBrowserRequest();
    expect(stopRequest.command).toEqual({
      command: "screencast_stop",
      args: { browserId: BROWSER_ID },
    });
  });

  it("ignores a tab announcement from a client that is not a browser host", async () => {
    const harness = await startBrowserToolsDaemonHarness();
    const browserHost = await harness.connectBrowserHostClient({ clientId: "browser-host-1" });
    const viewer = await harness.connectViewerClient();

    viewer.announceBrowserTabs();

    // A viewer has no tab set to announce, so the daemon must not run the
    // `list_tabs` fan-out every connected host and client pays for.
    await expect(browserHost.nextBrowserRequest()).rejects.toThrow(
      "Timed out waiting for browser automation request",
    );
  });

  it("drops screencast frames from a client that does not host the stream", async () => {
    const harness = await startBrowserToolsDaemonHarness();
    const owningHost = await harness.connectBrowserHostClient({ clientId: "owning-host" });
    const otherHost = await harness.connectBrowserHostClient({ clientId: "other-host" });
    const viewer = await harness.connectViewerClient();

    const tabsPromise = viewer.runBrowserCommand({ command: { command: "list_tabs", args: {} } });
    await respondWithTab(owningHost, { browserId: BROWSER_ID, url: "https://one.example" });
    await respondWithNoTabs(otherHost);
    await tabsPromise;

    const frames: BrowserScreencastEvent[] = [];
    viewer.onBrowserScreencastFrame((event) => {
      frames.push(event);
    });
    await startScreencast({ viewer, host: owningHost, browserId: BROWSER_ID });

    otherHost.sendScreencastFrame({ slot: 0, data: new TextEncoder().encode("forged") });
    owningHost.sendScreencastFrame({ slot: 0, data: new TextEncoder().encode("genuine") });
    await waitFor(() => frames.length > 0);
    // The forged frame went first, so anything it would have displaced has landed.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(frames.map((frame) => new TextDecoder().decode(frame.data))).toEqual(["genuine"]);
  });

  it("republishes the tab list when a host disconnects", async () => {
    const harness = await startBrowserToolsDaemonHarness();
    const firstHost = await harness.connectBrowserHostClient({ clientId: "browser-host-1" });
    const secondHost = await harness.connectBrowserHostClient({ clientId: "browser-host-2" });
    const viewer = await harness.connectViewerClient();

    const pushes: BrowserTabsChanged[] = [];
    viewer.on("browser.tabs.changed", (message) => {
      pushes.push(message);
    });

    await secondHost.disconnect();
    await respondWithTab(firstHost, { browserId: BROWSER_ID, url: "https://one.example" });
    await waitFor(() => pushes.length === 1);

    // Without this the viewer keeps listing the departed host's tabs, and every
    // action against them fails.
    expect(pushes[0]).toMatchObject({
      payload: { tabs: [{ browserId: BROWSER_ID, hostId: "browser-host-1" }] },
    });

    await firstHost.disconnect();
    await waitFor(() => pushes.length === 2);

    // No host is left to answer a fan-out, so the empty list is the daemon's to send.
    expect(pushes[1]).toMatchObject({ payload: { tabs: [] } });
  });

  it("keeps a sibling window's frames running when one window unsubscribes", async () => {
    const harness = await startBrowserToolsDaemonHarness();
    const browserHost = await harness.connectBrowserHostClient({ clientId: "browser-host-1" });
    const clientId = "app-client-1";
    const firstWindow = await harness.connectViewerClient({ clientId });
    const secondWindow = await harness.connectViewerClient({ clientId });

    const secondWindowFrames: BrowserScreencastEvent[] = [];
    secondWindow.onBrowserScreencastFrame((event) => {
      secondWindowFrames.push(event);
    });
    await startScreencast({ viewer: firstWindow, host: browserHost, browserId: BROWSER_ID });
    await expect(secondWindow.subscribeBrowserScreencast(BROWSER_ID)).resolves.toMatchObject({
      browserId: BROWSER_ID,
      slot: 0,
    });

    firstWindow.unsubscribeBrowserScreencast(BROWSER_ID);

    // The second window is still watching, so the capture has to stay armed.
    await expect(browserHost.nextBrowserRequest()).rejects.toThrow(
      "Timed out waiting for browser automation request",
    );
    browserHost.sendScreencastFrame({ slot: 0, data: new TextEncoder().encode("jpeg-bytes") });
    await waitFor(() => secondWindowFrames.length === 1);

    expect(new TextDecoder().decode(secondWindowFrames[0].data)).toBe("jpeg-bytes");
  });

  it("keeps frames off a window that never subscribed", async () => {
    const harness = await startBrowserToolsDaemonHarness();
    const browserHost = await harness.connectBrowserHostClient({ clientId: "browser-host-1" });
    const clientId = "app-client-1";
    const watching = await harness.connectViewerClient({ clientId });
    const pushes = createScreencastPushCounter();
    await harness.connectViewerClient({ clientId, trace: pushes.trace });

    const frames: BrowserScreencastEvent[] = [];
    watching.onBrowserScreencastFrame((event) => {
      frames.push(event);
    });
    await startScreencast({ viewer: watching, host: browserHost, browserId: BROWSER_ID });

    browserHost.sendScreencastFrame({ slot: 0, data: new TextEncoder().encode("jpeg-bytes") });
    await waitFor(() => frames.length === 1);
    // The frame reached the subscribed window, so anything sent alongside it has landed.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(pushes.count()).toBe(0);
  });

  it("refuses a screencast subscribe for a browser outside the requested workspace", async () => {
    const harness = await startBrowserToolsDaemonHarness();
    const browserHost = await harness.connectBrowserHostClient({ clientId: "browser-host-1" });
    const viewer = await harness.connectViewerClient();

    const tabsPromise = viewer.runBrowserCommand({
      command: { command: "list_tabs", args: {} },
      workspaceId: "workspace-1",
    });
    await respondWithTab(browserHost, {
      browserId: BROWSER_ID,
      url: "https://one.example",
      workspaceId: "workspace-1",
    });
    await tabsPromise;

    await expect(
      viewer.subscribeBrowserScreencast(BROWSER_ID, { workspaceId: "workspace-2" }),
    ).resolves.toMatchObject({
      browserId: BROWSER_ID,
      error: `Browser tab ${BROWSER_ID} is not in workspace workspace-2.`,
    });
    await expect(browserHost.nextBrowserRequest()).rejects.toThrow(
      "Timed out waiting for browser automation request",
    );
  });
});

async function respondWithTab(
  host: BrowserHostClientHandle,
  tab: { browserId: string; url: string; workspaceId?: string },
): Promise<void> {
  const request = await host.nextBrowserRequest();
  host.respondToBrowserRequest({
    type: "browser.automation.execute.response",
    payload: {
      requestId: request.requestId,
      ok: true,
      result: {
        command: "list_tabs",
        tabs: [
          {
            browserId: tab.browserId,
            url: tab.url,
            title: tab.url,
            ...(tab.workspaceId ? { workspaceId: tab.workspaceId } : {}),
          },
        ],
      },
    },
  });
}

async function respondWithNoTabs(host: BrowserHostClientHandle): Promise<void> {
  const request = await host.nextBrowserRequest();
  host.respondToBrowserRequest({
    type: "browser.automation.execute.response",
    payload: { requestId: request.requestId, ok: true, result: { command: "list_tabs", tabs: [] } },
  });
}

interface ScreencastPushCounter {
  trace: DaemonClientTrace;
  /** Frames the daemon pushed down this socket, counted before the client routes them. */
  count: () => number;
}

function createScreencastPushCounter(): ScreencastPushCounter {
  let count = 0;
  return {
    trace: {
      isEnabled: () => true,
      beginSection: (name, args) => {
        if (name === "paseo.ws.message.inbound" && args?.messageType === "browser_screencast") {
          count += 1;
        }
      },
      endSection: () => {},
    },
    count: () => count,
  };
}

async function startScreencast(params: {
  viewer: DaemonClient;
  host: BrowserHostClientHandle;
  browserId: string;
}): Promise<void> {
  const subscribePromise = params.viewer.subscribeBrowserScreencast(params.browserId);
  const startRequest = await params.host.nextBrowserRequest();
  params.host.respondToBrowserRequest({
    type: "browser.automation.execute.response",
    payload: {
      requestId: startRequest.requestId,
      ok: true,
      result: { command: "screencast_start", browserId: params.browserId, slot: 0 },
    },
  });
  await expect(subscribePromise).resolves.toMatchObject({ browserId: params.browserId, slot: 0 });
}

async function startBrowserToolsDaemonHarness(): Promise<BrowserToolsDaemonHarness> {
  const httpServer = createServer();
  const broker = createBroker();
  const wsServer = createVoiceAssistantWebSocketServer({ httpServer, broker });
  const clients = new Set<DaemonClient>();

  await listen(httpServer);
  const url = `ws://127.0.0.1:${getPort(httpServer)}/ws`;

  const harness: BrowserToolsDaemonHarness = {
    broker,
    async connectBrowserHostClient(options = {}) {
      const clientId = options.clientId;
      const client = new DaemonClient({
        url,
        ...(clientId ? { clientId } : {}),
        clientType: "browser",
        connectTimeoutMs: 500,
        reconnect: { enabled: false },
        capabilities: options.capabilities ?? browserHostCapabilities(),
      });
      clients.add(client);

      const requests = createBrowserRequestQueue();
      client.on("browser.automation.execute.request", (request) => {
        requests.push(request);
      });

      await client.connect();

      return {
        clientId: clientId ?? "",
        announceBrowserTabs: () => client.announceBrowserTabs(),
        nextBrowserRequest: () => requests.next(),
        respondToBrowserRequest: (response) =>
          client.sendBrowserAutomationExecuteResponse(response),
        sendScreencastFrame: (input) =>
          client.sendBrowserScreencastFrame({
            slot: input.slot,
            metadata: { deviceWidth: 1280, deviceHeight: 800 },
            data: input.data,
          }),
        async disconnect() {
          const remaining = Math.max(0, broker.getRegisteredClientCount() - 1);
          requests.close();
          clients.delete(client);
          await client.close();
          await waitFor(() => broker.getRegisteredClientCount() === remaining);
        },
      };
    },
    async connectViewerClient(options = {}) {
      const understandsBrowserMirror = options.understandsBrowserMirror ?? true;
      const client = new DaemonClient({
        url,
        clientType: "browser",
        connectTimeoutMs: 500,
        reconnect: { enabled: false },
        ...(options.clientId ? { clientId: options.clientId } : {}),
        ...(options.trace ? { trace: options.trace } : {}),
        ...(understandsBrowserMirror
          ? { capabilities: { [CLIENT_CAPS.browserMirror]: true } }
          : {}),
      });
      clients.add(client);
      await client.connect();
      return client;
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
    setAgentAttentionCallback() {},
    subscribe: () => () => {},
    getMetricsSnapshot: () => ({
      total: 0,
      byLifecycle: {},
      withActiveForegroundTurn: 0,
      timelineStats: { totalItems: 0, maxItemsPerAgent: 0 },
    }),
  };
  const daemonConfigStore = {
    onApply: () => () => {},
    onChange: () => () => {},
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
    createWorkspaceAutoNameStub(),
    undefined,
    undefined,
    undefined,
    undefined,
    "1.2.3-test",
    undefined,
    undefined,
    undefined,
    createStub<ScheduleService>({}),
    createStub<CheckoutDiffManager>({
      subscribe: () => {},
      scheduleRefreshForCwd: () => {},
      getMetrics: () => ({
        checkoutDiffTargetCount: 0,
        checkoutDiffSubscriptionCount: 0,
        checkoutDiffWatcherCount: 0,
        checkoutDiffFallbackRefreshTargetCount: 0,
      }),
      dispose: () => {},
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
    child: () => logger,
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
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
