import { hostname } from "node:os";
import { describe, expect, test } from "vitest";

import { BrowserToolsBroker } from "./broker.js";
import {
  CdpCommandError,
  CdpConnectError,
  CdpConnectionClosedError,
  type CdpCommand,
  type CdpConnection,
  type CdpEvent,
  type CdpResult,
} from "./cdp-connection.js";
import {
  startConfiguredHeadlessBrowserHost,
  type HeadlessBrowserHost,
  type HeadlessBrowserHostLogger,
  type HeadlessBrowserHostSink,
} from "./headless-host.js";
import type { BrowserScreencastFrame } from "@getpaseo/protocol/binary-frames/screencast";

const HOST_CLIENT_ID = "headless-under-test";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Long enough that neither the reconnect nor the still-page fallback fires
// inside a test; both are cleared by stop().
const NEVER_MS = 3_600_000;

type FakeCdpResponder = (command: CdpCommand) => CdpResult;

/**
 * A CDP endpoint that answers from a table instead of a browser. It records
 * every command in order, so a test asserts the protocol the host speaks.
 */
class FakeCdpEndpoint implements CdpConnection {
  public readonly sent: CdpCommand[] = [];
  private readonly responders: Map<string, FakeCdpResponder>;
  private readonly eventListeners = new Set<(event: CdpEvent) => void>();
  private readonly closeListeners = new Set<() => void>();
  private closed = false;

  public constructor(responders: Record<string, FakeCdpResponder>) {
    this.responders = new Map(Object.entries(responders));
  }

  public send(command: CdpCommand): Promise<CdpResult> {
    this.sent.push(command);
    if (this.closed) {
      return Promise.reject(new CdpConnectionClosedError(command.method));
    }
    const responder = this.responders.get(command.method);
    if (!responder) {
      return Promise.reject(
        new CdpCommandError(command.method, -32601, `'${command.method}' wasn't found`),
      );
    }
    return Promise.resolve(responder(command));
  }

  public onEvent(listener: (event: CdpEvent) => void): void {
    this.eventListeners.add(listener);
  }

  public onClose(listener: () => void): void {
    this.closeListeners.add(listener);
  }

  public close(): void {
    this.drop();
  }

  /** The browser process went away underneath the daemon. */
  public drop(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const listener of Array.from(this.closeListeners)) {
      listener();
    }
  }

  public emit(event: CdpEvent): void {
    for (const listener of Array.from(this.eventListeners)) {
      listener(event);
    }
  }

  public commandsFor(method: string): CdpCommand[] {
    return this.sent.filter((command) => command.method === method);
  }
}

interface RecordedSink extends HeadlessBrowserHostSink {
  frames: { frame: BrowserScreencastFrame; sourceClientId: string }[];
  announcements: number;
}

function createSink(): RecordedSink {
  const sink: RecordedSink = {
    frames: [],
    announcements: 0,
    handleScreencastFrame(params) {
      sink.frames.push(params);
    },
    announceTabsChanged() {
      sink.announcements += 1;
    },
  };
  return sink;
}

const silentLogger: HeadlessBrowserHostLogger = {
  info: () => {},
  warn: () => {},
};

/** Two pages plus a target the mirror must ignore. */
function browserWithTwoPages(): FakeCdpEndpoint {
  return new FakeCdpEndpoint({
    "Target.getTargets": () => ({
      targetInfos: [
        { targetId: "target-a", type: "page", url: "https://a.test/", title: "Page A" },
        { targetId: "worker", type: "service_worker", url: "https://a.test/sw.js", title: "sw" },
        { targetId: "target-b", type: "page", url: "https://b.test/", title: "Page B" },
      ],
    }),
    "Target.attachToTarget": (command) => ({
      sessionId: `session-${String(command.params?.targetId)}`,
    }),
    "Page.getNavigationHistory": (command) =>
      command.sessionId === "session-target-a"
        ? { currentIndex: 1, entries: [{ id: 1 }, { id: 2 }] }
        : { currentIndex: 0, entries: [{ id: 7 }] },
    "Input.dispatchMouseEvent": () => ({}),
    "Input.dispatchKeyEvent": () => ({}),
    "Page.startScreencast": () => ({}),
    "Page.stopScreencast": () => ({}),
    "Page.screencastFrameAck": () => ({}),
  });
}

interface StartedHost {
  broker: BrowserToolsBroker;
  host: HeadlessBrowserHost | null;
  sink: RecordedSink;
  connectCalls: string[];
}

async function startHost(params: {
  endpoint: string | undefined;
  endpointConnection?: FakeCdpEndpoint;
}): Promise<StartedHost> {
  const broker = new BrowserToolsBroker({});
  const sink = createSink();
  const connectCalls: string[] = [];
  const host = startConfiguredHeadlessBrowserHost({
    endpoint: params.endpoint,
    broker,
    sink,
    logger: silentLogger,
    clientId: HOST_CLIENT_ID,
    reconnectDelayMs: NEVER_MS,
    firstFrameDelayMs: NEVER_MS,
    connect: async (endpoint) => {
      connectCalls.push(endpoint);
      if (!params.endpointConnection) {
        throw new CdpConnectError(endpoint, "no browser in this test");
      }
      return params.endpointConnection;
    },
  });
  await flush();
  return { broker, host, sink, connectCalls };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function listTabs(broker: BrowserToolsBroker, requestId: string) {
  return broker.execute({ requestId, command: { command: "list_tabs", args: {} } });
}

/** The browser ids are minted per attach, so a test asks the host for them. */
async function openTabIds(broker: BrowserToolsBroker): Promise<string[]> {
  const payload = await listTabs(broker, "tabs");
  if (!payload.ok || payload.result.command !== "list_tabs") {
    throw new Error(`list_tabs failed: ${JSON.stringify(payload)}`);
  }
  return payload.result.tabs.map((tab) => tab.browserId);
}

describe("headless browser host tab announcements", () => {
  test("tells viewers to refresh when the guest navigates itself", async () => {
    const connection = browserWithTwoPages();
    const { broker, sink } = await startHost({
      endpoint: "http://localhost:9222",
      endpointConnection: connection,
    });
    await openTabIds(broker);
    // Chrome withholds this event unless discovery was turned on at attach.
    expect(connection.commandsFor("Target.setDiscoverTargets")).toHaveLength(1);
    const before = sink.announcements;

    connection.emit({
      method: "Target.targetInfoChanged",
      params: { targetInfo: { targetId: "target-a", type: "page", url: "https://a.test/next" } },
      sessionId: undefined,
    });

    // Without this the tab strip keeps the title the page had when it opened.
    expect(sink.announcements).toBe(before + 1);
  });

  test("ignores a target the mirror never adopted", async () => {
    const connection = browserWithTwoPages();
    const { broker, sink } = await startHost({
      endpoint: "http://localhost:9222",
      endpointConnection: connection,
    });
    await openTabIds(broker);
    const before = sink.announcements;

    connection.emit({
      method: "Target.targetInfoChanged",
      params: {
        targetInfo: { targetId: "worker", type: "service_worker", url: "https://a.test/sw.js" },
      },
      sessionId: undefined,
    });

    expect(sink.announcements).toBe(before);
  });
});

describe("headless browser host registration", () => {
  test("registers no host and never dials when no endpoint is configured", async () => {
    const { broker, host, connectCalls } = await startHost({ endpoint: undefined });

    expect(host).toBeNull();
    expect(connectCalls).toEqual([]);
    expect(broker.getRegisteredClientCount()).toBe(0);
    expect(broker.getMirrorCapableClientCount()).toBe(0);
  });

  test("registers a mirror-capable host once the endpoint answers", async () => {
    const endpoint = browserWithTwoPages();
    const { broker, host, sink, connectCalls } = await startHost({
      endpoint: "ws://127.0.0.1:9222",
      endpointConnection: endpoint,
    });

    expect(connectCalls).toEqual(["ws://127.0.0.1:9222"]);
    expect(broker.getRegisteredClientCount()).toBe(1);
    expect(broker.getMirrorCapableClientCount()).toBe(1);
    expect(sink.announcements).toBe(1);

    host?.stop();
  });

  test("unregisters the host when the CDP connection drops", async () => {
    const endpoint = browserWithTwoPages();
    const { broker, host, sink } = await startHost({
      endpoint: "ws://127.0.0.1:9222",
      endpointConnection: endpoint,
    });
    expect(broker.getRegisteredClientCount()).toBe(1);

    endpoint.drop();
    await flush();

    expect(broker.getRegisteredClientCount()).toBe(0);
    expect(broker.getMirrorCapableClientCount()).toBe(0);
    expect(sink.announcements).toBe(2);
    expect(await listTabs(broker, "after-drop")).toEqual({
      requestId: "after-drop",
      ok: false,
      error: {
        code: "browser_no_host",
        message: "No browser automation host is connected.",
        retryable: true,
      },
    });

    host?.stop();
  });
});

describe("headless browser host list_tabs", () => {
  test("maps page targets to tabs and reports their navigation history", async () => {
    const endpoint = browserWithTwoPages();
    const { broker, host } = await startHost({
      endpoint: "ws://127.0.0.1:9222",
      endpointConnection: endpoint,
    });

    expect(await listTabs(broker, "tabs")).toEqual({
      requestId: "tabs",
      ok: true,
      result: {
        command: "list_tabs",
        tabs: [
          {
            browserId: expect.stringMatching(UUID_PATTERN),
            hostId: HOST_CLIENT_ID,
            hostLabel: hostname(),
            url: "https://a.test/",
            title: "Page A",
            isActive: false,
            isLoading: false,
            canGoBack: true,
            canGoForward: false,
          },
          {
            browserId: expect.stringMatching(UUID_PATTERN),
            hostId: HOST_CLIENT_ID,
            hostLabel: hostname(),
            url: "https://b.test/",
            title: "Page B",
            isActive: false,
            isLoading: false,
            canGoBack: false,
            canGoForward: false,
          },
        ],
      },
    });
    expect(endpoint.commandsFor("Target.attachToTarget")).toEqual([
      { method: "Target.attachToTarget", params: { targetId: "target-a", flatten: true } },
      { method: "Target.attachToTarget", params: { targetId: "target-b", flatten: true } },
    ]);

    host?.stop();
  });

  test("keeps browser ids stable across listings so a mirrored tab survives a refresh", async () => {
    const endpoint = browserWithTwoPages();
    const { broker, host } = await startHost({
      endpoint: "ws://127.0.0.1:9222",
      endpointConnection: endpoint,
    });

    const first = await openTabIds(broker);
    const second = await openTabIds(broker);

    expect(second).toEqual(first);
    expect(endpoint.commandsFor("Target.attachToTarget")).toHaveLength(2);

    host?.stop();
  });
});

describe("headless browser host input_at", () => {
  test("turns a click into a move, press and release on the tab's session", async () => {
    const endpoint = browserWithTwoPages();
    const { broker, host } = await startHost({
      endpoint: "ws://127.0.0.1:9222",
      endpointConnection: endpoint,
    });
    const [browserId] = await openTabIds(broker);

    const payload = await broker.execute({
      requestId: "click",
      command: {
        command: "input_at",
        args: {
          browserId,
          event: { kind: "click", x: 12, y: 34, button: "left", clickCount: 1, modifiers: [] },
        },
      },
    });

    expect(payload).toEqual({
      requestId: "click",
      ok: true,
      result: { command: "input_at", browserId },
    });
    expect(endpoint.commandsFor("Input.dispatchMouseEvent")).toEqual([
      {
        method: "Input.dispatchMouseEvent",
        sessionId: "session-target-a",
        params: { type: "mouseMoved", x: 12, y: 34, button: "none", modifiers: 0 },
      },
      {
        method: "Input.dispatchMouseEvent",
        sessionId: "session-target-a",
        params: {
          type: "mousePressed",
          x: 12,
          y: 34,
          button: "left",
          buttons: 1,
          clickCount: 1,
          modifiers: 0,
        },
      },
      {
        method: "Input.dispatchMouseEvent",
        sessionId: "session-target-a",
        params: {
          type: "mouseReleased",
          x: 12,
          y: 34,
          button: "left",
          buttons: 0,
          clickCount: 1,
          modifiers: 0,
        },
      },
    ]);

    host?.stop();
  });

  test("sends a held pointer phase as a press that stays down", async () => {
    const endpoint = browserWithTwoPages();
    const { broker, host } = await startHost({
      endpoint: "ws://127.0.0.1:9222",
      endpointConnection: endpoint,
    });
    const [browserId] = await openTabIds(broker);

    await broker.execute({
      requestId: "pointer",
      command: {
        command: "input_at",
        args: {
          browserId,
          event: {
            kind: "pointer",
            phase: "down",
            x: 5,
            y: 6,
            button: "left",
            clickCount: 1,
            modifiers: ["Shift"],
          },
        },
      },
    });

    expect(endpoint.commandsFor("Input.dispatchMouseEvent")).toEqual([
      {
        method: "Input.dispatchMouseEvent",
        sessionId: "session-target-a",
        params: {
          type: "mousePressed",
          x: 5,
          y: 6,
          button: "left",
          buttons: 1,
          clickCount: 1,
          modifiers: 8,
        },
      },
    ]);

    host?.stop();
  });

  test("types Enter as one key press carrying the newline character", async () => {
    const endpoint = browserWithTwoPages();
    const { broker, host } = await startHost({
      endpoint: "ws://127.0.0.1:9222",
      endpointConnection: endpoint,
    });
    const [, secondBrowserId] = await openTabIds(broker);

    await broker.execute({
      requestId: "key",
      command: {
        command: "input_at",
        args: {
          browserId: secondBrowserId,
          event: { kind: "key", key: "Enter", modifiers: [] },
        },
      },
    });

    expect(endpoint.commandsFor("Input.dispatchKeyEvent")).toEqual([
      {
        method: "Input.dispatchKeyEvent",
        sessionId: "session-target-b",
        params: {
          type: "keyDown",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          modifiers: 0,
          text: "\r",
        },
      },
      {
        method: "Input.dispatchKeyEvent",
        sessionId: "session-target-b",
        params: {
          type: "keyUp",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          modifiers: 0,
        },
      },
    ]);

    host?.stop();
  });
});

describe("headless browser host screencast", () => {
  test("arms the capture, acknowledges each frame and forwards it on the daemon's slot", async () => {
    const endpoint = browserWithTwoPages();
    const { broker, host, sink } = await startHost({
      endpoint: "ws://127.0.0.1:9222",
      endpointConnection: endpoint,
    });
    const [browserId] = await openTabIds(broker);

    const started = await broker.execute({
      requestId: "start",
      command: {
        command: "screencast_start",
        args: {
          browserId,
          slot: 3,
          quality: 90,
          maxWidth: 1280,
          maxHeight: 800,
          everyNthFrame: 1,
        },
      },
    });

    expect(started).toEqual({
      requestId: "start",
      ok: true,
      result: { command: "screencast_start", browserId, slot: 3 },
    });
    expect(endpoint.commandsFor("Page.startScreencast")).toEqual([
      {
        method: "Page.startScreencast",
        sessionId: "session-target-a",
        params: {
          format: "jpeg",
          quality: 90,
          maxWidth: 1280,
          maxHeight: 800,
          everyNthFrame: 1,
        },
      },
    ]);

    endpoint.emit({
      method: "Page.screencastFrame",
      sessionId: "session-target-a",
      params: {
        sessionId: 42,
        data: Buffer.from("first-jpeg").toString("base64"),
        metadata: { deviceWidth: 1194, deviceHeight: 800 },
      },
    });

    expect(endpoint.commandsFor("Page.screencastFrameAck")).toEqual([
      {
        method: "Page.screencastFrameAck",
        sessionId: "session-target-a",
        params: { sessionId: 42 },
      },
    ]);
    expect(sink.frames).toEqual([
      {
        frame: {
          opcode: 0x20,
          slot: 3,
          metadata: { deviceWidth: 1194, deviceHeight: 800 },
          payload: Buffer.from("first-jpeg"),
        },
        sourceClientId: HOST_CLIENT_ID,
      },
    ]);

    host?.stop();
  });

  test("drops frames from a tab whose capture the daemon already stopped", async () => {
    const endpoint = browserWithTwoPages();
    const { broker, host, sink } = await startHost({
      endpoint: "ws://127.0.0.1:9222",
      endpointConnection: endpoint,
    });
    const [browserId] = await openTabIds(broker);
    await broker.execute({
      requestId: "start",
      command: {
        command: "screencast_start",
        args: {
          browserId,
          slot: 1,
          quality: 90,
          maxWidth: 1280,
          maxHeight: 800,
          everyNthFrame: 1,
        },
      },
    });

    const stopped = await broker.execute({
      requestId: "stop",
      command: { command: "screencast_stop", args: { browserId } },
    });
    endpoint.emit({
      method: "Page.screencastFrame",
      sessionId: "session-target-a",
      params: {
        sessionId: 7,
        data: Buffer.from("late-jpeg").toString("base64"),
        metadata: { deviceWidth: 800, deviceHeight: 600 },
      },
    });

    expect(stopped).toEqual({
      requestId: "stop",
      ok: true,
      result: { command: "screencast_stop", browserId },
    });
    expect(endpoint.commandsFor("Page.stopScreencast")).toEqual([
      { method: "Page.stopScreencast", sessionId: "session-target-a" },
    ]);
    expect(endpoint.commandsFor("Page.screencastFrameAck")).toEqual([]);
    expect(sink.frames).toEqual([]);

    host?.stop();
  });
});
