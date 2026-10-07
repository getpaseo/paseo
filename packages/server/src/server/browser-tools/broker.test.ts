import { afterEach, describe, expect, test, vi } from "vitest";
import type {
  BrowserAutomationCommand,
  BrowserAutomationCommandName,
  BrowserAutomationExecuteRequest,
  BrowserAutomationExecuteResponse,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { BROWSER_AUTOMATION_COMMAND_NAMES } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { BrowserToolsBroker, type BrowserHostClient } from "./broker.js";

const BROWSER_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_BROWSER_ID = "22222222-2222-4222-8222-222222222222";

class FakeBrowserHostClient implements BrowserHostClient {
  public readonly receivedRequests: BrowserAutomationExecuteRequest[] = [];
  public readonly hostKind: string;
  public readonly supportedCommands: readonly BrowserAutomationCommandName[];

  public constructor(
    public readonly id: string,
    options: {
      hostKind?: string;
      supportedCommands?: readonly BrowserAutomationCommandName[];
    } = {},
  ) {
    this.hostKind = options.hostKind ?? "desktop app";
    this.supportedCommands = options.supportedCommands ?? [...BROWSER_AUTOMATION_COMMAND_NAMES];
  }

  public sendBrowserAutomationRequest(request: BrowserAutomationExecuteRequest): void {
    this.receivedRequests.push(request);
  }

  public resolveLatestWith(
    broker: BrowserToolsBroker,
    responsePayload: BrowserAutomationExecuteResponse["payload"],
  ): boolean {
    const latest = this.receivedRequests.at(-1);
    if (!latest) {
      throw new Error(`Host ${this.id} has not received a browser request.`);
    }
    return this.resolveRequestWith(broker, latest, responsePayload);
  }

  public resolveRequestWith(
    broker: BrowserToolsBroker,
    request: BrowserAutomationExecuteRequest,
    responsePayload: BrowserAutomationExecuteResponse["payload"],
  ): boolean {
    return broker.receiveResponse({
      type: "browser.automation.execute.response",
      payload: { ...responsePayload, requestId: request.requestId },
    });
  }
}

class FailingBrowserHostClient implements BrowserHostClient {
  public readonly id = "host-1";
  public readonly hostKind = "desktop app";
  public readonly supportedCommands = [...BROWSER_AUTOMATION_COMMAND_NAMES];

  public sendBrowserAutomationRequest(): void {
    throw new Error("websocket send failed");
  }
}

function createBroker(options: { timeoutMs?: number } = {}): BrowserToolsBroker {
  return new BrowserToolsBroker({
    defaultTimeoutMs: options.timeoutMs ?? 100,
    createRequestId: () => "req-1",
  });
}

function snapshotCommand(): BrowserAutomationCommand {
  return { command: "snapshot", args: { browserId: BROWSER_ID } };
}

describe("BrowserToolsBroker", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("no connected browser host returns a retryable browser_no_host error", async () => {
    const broker = createBroker();

    await expect(broker.execute({ command: snapshotCommand() })).resolves.toEqual({
      requestId: "req-1",
      ok: false,
      error: {
        code: "browser_no_host",
        message: "No browser automation host is connected.",
        retryable: true,
      },
    });
  });

  test("invalid browser requests return structured failures without contacting a host", async () => {
    const broker = createBroker();
    const client = new FakeBrowserHostClient("host-1");
    broker.registerClient(client);

    await expect(
      broker.execute({
        command: {
          command: "new_tab",
          args: { url: "ftp://example.com" },
        } as unknown as BrowserAutomationCommand,
      }),
    ).resolves.toEqual({
      requestId: "req-1",
      ok: false,
      error: {
        code: "browser_unknown_error",
        message: "Browser automation request is invalid: URL must use http or https.",
        retryable: false,
      },
    });
    expect(client.receivedRequests).toEqual([]);
    expect(broker.getPendingRequestCount()).toBe(0);
  });

  test("capable browser host receives request and returns response", async () => {
    const broker = createBroker();
    const client = new FakeBrowserHostClient("host-1");
    broker.registerClient(client);

    const resultPromise = broker.execute({
      command: { command: "list_tabs", args: {} },
      workspaceId: "workspace-1",
    });

    expect(client.receivedRequests).toEqual([
      {
        type: "browser.automation.execute.request",
        requestId: "req-1",
        workspaceId: "workspace-1",
        command: { command: "list_tabs", args: {} },
      },
    ]);
    expect(broker.getPendingRequestCount()).toBe(1);

    expect(
      client.resolveLatestWith(broker, {
        requestId: "req-1",
        ok: true,
        result: {
          command: "list_tabs",
          tabs: [
            {
              browserId: BROWSER_ID,
              workspaceId: "workspace-1",
              url: "https://example.com",
              title: "Example",
            },
          ],
        },
      }),
    ).toBe(true);

    await expect(resultPromise).resolves.toEqual({
      requestId: "req-1",
      ok: true,
      result: {
        command: "list_tabs",
        tabs: [
          {
            browserId: BROWSER_ID,
            workspaceId: "workspace-1",
            url: "https://example.com",
            title: "Example",
            isActive: false,
            isLoading: false,
          },
        ],
      },
    });
    expect(broker.getPendingRequestCount()).toBe(0);
  });

  test("single browser host receives snapshot requests", async () => {
    const broker = createBroker();
    const client = new FakeBrowserHostClient("host-1");
    broker.registerClient(client);

    const resultPromise = broker.execute({
      command: { command: "snapshot", args: { browserId: BROWSER_ID } },
      workspaceId: "workspace-1",
    });

    expect(client.receivedRequests).toEqual([
      {
        type: "browser.automation.execute.request",
        requestId: "req-1",
        workspaceId: "workspace-1",
        command: { command: "snapshot", args: { browserId: BROWSER_ID } },
      },
    ]);

    client.resolveLatestWith(broker, {
      requestId: "req-1",
      ok: true,
      result: {
        command: "snapshot",
        browserId: BROWSER_ID,
        workspaceId: "workspace-1",
        url: "https://example.com",
        title: "Example",
        format: "aria-yaml",
        snapshot: "- document",
        truncated: false,
        stats: { nodeCount: 1, refCount: 0, textLength: 10 },
      },
    });

    await expect(resultPromise).resolves.toEqual({
      requestId: "req-1",
      ok: true,
      result: {
        command: "snapshot",
        browserId: BROWSER_ID,
        workspaceId: "workspace-1",
        url: "https://example.com",
        title: "Example",
        format: "aria-yaml",
        snapshot: "- document",
        truncated: false,
        stats: { nodeCount: 1, refCount: 0, textLength: 10 },
      },
    });
  });

  test("new tabs target the most recently registered host and tab commands stay with that host", async () => {
    const broker = createBroker();
    const firstHost = new FakeBrowserHostClient("host-1");
    const recentHost = new FakeBrowserHostClient("host-2");
    broker.registerClient(firstHost);
    broker.registerClient(recentHost);

    const newTabPromise = broker.execute({
      command: { command: "new_tab", args: { url: "https://example.com" } },
      separateTab: true,
      workspaceId: "workspace-1",
    });

    expect(firstHost.receivedRequests).toEqual([]);
    expect(recentHost.receivedRequests).toEqual([
      {
        type: "browser.automation.execute.request",
        requestId: "req-1",
        workspaceId: "workspace-1",
        command: { command: "new_tab", args: { url: "https://example.com" } },
      },
    ]);

    recentHost.resolveLatestWith(broker, {
      requestId: "req-1",
      ok: true,
      result: {
        command: "new_tab",
        browserId: BROWSER_ID,
        workspaceId: "workspace-1",
        url: "https://example.com",
      },
    });

    await expect(newTabPromise).resolves.toMatchObject({
      ok: true,
      result: { command: "new_tab", browserId: BROWSER_ID },
    });

    const snapshotPromise = broker.execute({
      command: { command: "snapshot", args: { browserId: BROWSER_ID } },
      workspaceId: "workspace-1",
    });

    expect(firstHost.receivedRequests).toEqual([]);
    expect(recentHost.receivedRequests.at(-1)).toEqual({
      type: "browser.automation.execute.request",
      requestId: "req-1",
      workspaceId: "workspace-1",
      command: { command: "snapshot", args: { browserId: BROWSER_ID } },
    });

    recentHost.resolveLatestWith(broker, {
      requestId: "req-1",
      ok: true,
      result: {
        command: "snapshot",
        browserId: BROWSER_ID,
        workspaceId: "workspace-1",
        url: "https://example.com",
        title: "Example",
        format: "aria-yaml",
        snapshot: "- document",
        truncated: false,
        stats: { nodeCount: 1, refCount: 0, textLength: 10 },
      },
    });

    await expect(snapshotPromise).resolves.toMatchObject({
      ok: true,
      result: { command: "snapshot", browserId: BROWSER_ID },
    });
  });

  test("daemon browser host owns new tabs when it is connected", async () => {
    const broker = createBroker();
    const appHost = new FakeBrowserHostClient("desktop-app");
    const daemonHost = new FakeBrowserHostClient("daemon-playwright");
    broker.registerClient(appHost);
    broker.registerClient(daemonHost);

    const newTabPromise = broker.execute({
      command: { command: "new_tab", args: { url: "https://example.com" } },
      separateTab: true,
      workspaceId: "workspace-1",
    });

    expect(appHost.receivedRequests).toEqual([]);
    expect(daemonHost.receivedRequests).toHaveLength(1);
    daemonHost.resolveLatestWith(broker, {
      requestId: "req-1",
      ok: true,
      result: {
        command: "new_tab",
        browserId: BROWSER_ID,
        workspaceId: "workspace-1",
        url: "https://example.com",
      },
    });

    await expect(newTabPromise).resolves.toMatchObject({
      ok: true,
      result: { command: "new_tab", browserId: BROWSER_ID },
    });
  });

  test("new tab reuses an existing tab of the same application and navigates it", async () => {
    const broker = createBroker();
    const host = new FakeBrowserHostClient("host-1");
    broker.registerClient(host);

    const promise = broker.execute({
      command: {
        command: "new_tab",
        args: { url: "https://app.example/dashboard" },
      },
      workspaceId: "workspace-1",
    });
    await Promise.resolve();
    expect(host.receivedRequests.map((request) => request.command.command)).toEqual(["list_tabs"]);
    host.resolveLatestWith(broker, {
      requestId: "req-1:reuse",
      ok: true,
      result: {
        command: "list_tabs",
        tabs: [
          {
            browserId: BROWSER_ID,
            workspaceId: "workspace-1",
            url: "https://app.example/login",
            title: "Login",
            isActive: true,
            isLoading: false,
          },
        ],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.receivedRequests.map((request) => request.command.command)).toEqual([
      "list_tabs",
      "navigate",
    ]);
    host.resolveLatestWith(broker, {
      requestId: "req-2",
      ok: true,
      result: {
        command: "navigate",
        browserId: BROWSER_ID,
        url: "https://app.example/dashboard",
      },
    } as never);

    await expect(promise).resolves.toMatchObject({
      ok: true,
      result: {
        command: "new_tab",
        browserId: BROWSER_ID,
        url: "https://app.example/dashboard",
      },
    });
  });

  test("parallel new tab calls for one application open a single tab", async () => {
    const broker = createBroker();
    const host = new FakeBrowserHostClient("host-1");
    broker.registerClient(host);
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    const call = () =>
      broker.execute({
        command: { command: "new_tab", args: { url: "https://app.example/" } },
        workspaceId: "workspace-1",
      });
    const tab = {
      browserId: BROWSER_ID,
      workspaceId: "workspace-1",
      url: "https://app.example/",
      title: "App",
      isActive: true,
      isLoading: false,
    };

    const first = call();
    const second = call();
    await flush();
    expect(host.receivedRequests.map((request) => request.command.command)).toEqual(["list_tabs"]);
    host.resolveLatestWith(broker, {
      requestId: "req-1:reuse",
      ok: true,
      result: { command: "list_tabs", tabs: [] },
    });
    await flush();
    expect(host.receivedRequests.map((request) => request.command.command)).toEqual([
      "list_tabs",
      "new_tab",
    ]);
    host.resolveLatestWith(broker, {
      requestId: "req-1",
      ok: true,
      result: {
        command: "new_tab",
        browserId: BROWSER_ID,
        workspaceId: "workspace-1",
        url: tab.url,
      },
    });
    await flush();
    host.resolveLatestWith(broker, {
      requestId: "req-2:reuse",
      ok: true,
      result: { command: "list_tabs", tabs: [tab] },
    });

    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(second).resolves.toMatchObject({
      ok: true,
      result: { command: "new_tab", browserId: BROWSER_ID },
    });
    expect(
      host.receivedRequests.filter((request) => request.command.command === "new_tab"),
    ).toHaveLength(1);
  });

  test("new tab opens a fresh tab for another application or when separateTab is set", async () => {
    const broker = createBroker();
    const host = new FakeBrowserHostClient("host-1");
    broker.registerClient(host);

    const separate = broker.execute({
      command: { command: "new_tab", args: { url: "https://app.example/" } },
      separateTab: true,
      workspaceId: "workspace-1",
    });
    expect(host.receivedRequests.map((request) => request.command.command)).toEqual(["new_tab"]);
    host.resolveLatestWith(broker, {
      requestId: "req-1",
      ok: true,
      result: {
        command: "new_tab",
        browserId: BROWSER_ID,
        workspaceId: "workspace-1",
        url: "https://app.example/",
      },
    });
    await expect(separate).resolves.toMatchObject({ ok: true });
  });

  test("list tabs aggregates all hosts and seeds browser id affinity", async () => {
    const broker = createBroker();
    const firstHost = new FakeBrowserHostClient("host-1");
    const secondHost = new FakeBrowserHostClient("host-2");
    broker.registerClient(firstHost);
    broker.registerClient(secondHost);

    const listPromise = broker.execute({
      command: { command: "list_tabs", args: {} },
      workspaceId: "workspace-1",
    });

    expect(firstHost.receivedRequests).toEqual([
      {
        type: "browser.automation.execute.request",
        requestId: "req-1:host-1",
        workspaceId: "workspace-1",
        command: { command: "list_tabs", args: {} },
      },
    ]);
    expect(secondHost.receivedRequests).toEqual([
      {
        type: "browser.automation.execute.request",
        requestId: "req-1:host-2",
        workspaceId: "workspace-1",
        command: { command: "list_tabs", args: {} },
      },
    ]);

    firstHost.resolveLatestWith(broker, {
      requestId: "req-1:host-1",
      ok: true,
      result: {
        command: "list_tabs",
        tabs: [
          {
            browserId: BROWSER_ID,
            workspaceId: "workspace-1",
            url: "https://one.example",
            title: "One",
          },
        ],
      },
    });
    secondHost.resolveLatestWith(broker, {
      requestId: "req-1:host-2",
      ok: true,
      result: {
        command: "list_tabs",
        tabs: [
          {
            browserId: SECOND_BROWSER_ID,
            workspaceId: "workspace-1",
            url: "https://two.example",
            title: "Two",
          },
        ],
      },
    });

    await expect(listPromise).resolves.toEqual({
      requestId: "req-1",
      ok: true,
      result: {
        command: "list_tabs",
        tabs: [
          {
            browserId: BROWSER_ID,
            workspaceId: "workspace-1",
            url: "https://one.example",
            title: "One",
            isActive: false,
            isLoading: false,
          },
          {
            browserId: SECOND_BROWSER_ID,
            workspaceId: "workspace-1",
            url: "https://two.example",
            title: "Two",
            isActive: false,
            isLoading: false,
          },
        ],
      },
    });

    const firstSnapshot = broker.execute({
      command: { command: "snapshot", args: { browserId: BROWSER_ID } },
      workspaceId: "workspace-1",
    });
    const secondSnapshot = broker.execute({
      command: { command: "snapshot", args: { browserId: SECOND_BROWSER_ID } },
      workspaceId: "workspace-1",
      requestId: "req-2",
    });

    expect(firstHost.receivedRequests.at(-1)?.command).toEqual({
      command: "snapshot",
      args: { browserId: BROWSER_ID },
    });
    expect(secondHost.receivedRequests.at(-1)?.command).toEqual({
      command: "snapshot",
      args: { browserId: SECOND_BROWSER_ID },
    });

    firstHost.resolveLatestWith(broker, {
      requestId: "req-1",
      ok: true,
      result: {
        command: "snapshot",
        browserId: BROWSER_ID,
        workspaceId: "workspace-1",
        url: "https://one.example",
        title: "One",
        format: "aria-yaml",
        snapshot: "- document",
        truncated: false,
        stats: { nodeCount: 1, refCount: 0, textLength: 10 },
      },
    });
    secondHost.resolveLatestWith(broker, {
      requestId: "req-2",
      ok: true,
      result: {
        command: "snapshot",
        browserId: SECOND_BROWSER_ID,
        workspaceId: "workspace-1",
        url: "https://two.example",
        title: "Two",
        format: "aria-yaml",
        snapshot: "- document",
        truncated: false,
        stats: { nodeCount: 1, refCount: 0, textLength: 10 },
      },
    });

    await expect(firstSnapshot).resolves.toMatchObject({
      ok: true,
      result: { command: "snapshot", browserId: BROWSER_ID },
    });
    await expect(secondSnapshot).resolves.toMatchObject({
      ok: true,
      result: { command: "snapshot", browserId: SECOND_BROWSER_ID },
    });
  });

  test.each([
    {
      name: "scroll",
      command: {
        command: "scroll",
        args: { browserId: BROWSER_ID, deltaX: 0, deltaY: 400 },
      },
      result: {
        command: "scroll",
        browserId: BROWSER_ID,
        deltaX: 0,
        deltaY: 400,
      },
    },
    {
      name: "resize",
      command: {
        command: "resize",
        args: { browserId: BROWSER_ID, width: 1024, height: 768 },
      },
      result: {
        command: "resize",
        browserId: BROWSER_ID,
        width: 1024,
        height: 768,
      },
    },
    {
      name: "close_tab",
      command: { command: "close_tab", args: { browserId: BROWSER_ID } },
      result: { command: "close_tab", browserId: BROWSER_ID },
    },
  ] satisfies Array<{
    name: string;
    command: BrowserAutomationCommand;
    result: BrowserAutomationExecuteResponse["payload"] extends infer Payload
      ? Payload extends { ok: true }
        ? Payload["result"]
        : never
      : never;
  }>)("routes $name to the host that owns the browser id", async ({ command, result }) => {
    const broker = createBroker();
    const other = new FakeBrowserHostClient("host-1");
    const owner = new FakeBrowserHostClient("host-2");
    broker.registerClient(other);
    broker.registerClient(owner);

    const newTabPromise = broker.execute({
      command: { command: "new_tab", args: {} },
    });
    owner.resolveLatestWith(broker, {
      requestId: "req-1",
      ok: true,
      result: {
        command: "new_tab",
        browserId: BROWSER_ID,
        workspaceId: "workspace-1",
        url: "https://one.example",
      },
    });
    await newTabPromise;

    const resultPromise = broker.execute({
      command,
      requestId: "req-command",
    });

    expect(owner.receivedRequests.at(-1)).toEqual({
      type: "browser.automation.execute.request",
      requestId: "req-command",
      command,
    });
    expect(other.receivedRequests).toEqual([]);

    owner.resolveLatestWith(broker, {
      requestId: "req-command",
      ok: true,
      result,
    });

    await expect(resultPromise).resolves.toEqual({
      requestId: "req-command",
      ok: true,
      result,
    });
  });

  test("successful close_tab clears browser id host affinity", async () => {
    const broker = createBroker();
    const other = new FakeBrowserHostClient("host-1");
    const owner = new FakeBrowserHostClient("host-2");
    broker.registerClient(other);
    broker.registerClient(owner);

    const newTabPromise = broker.execute({
      command: { command: "new_tab", args: {} },
    });
    owner.resolveLatestWith(broker, {
      requestId: "req-1",
      ok: true,
      result: {
        command: "new_tab",
        browserId: BROWSER_ID,
        workspaceId: "workspace-1",
        url: "https://one.example",
      },
    });
    await newTabPromise;

    const closePromise = broker.execute({
      command: { command: "close_tab", args: { browserId: BROWSER_ID } },
      requestId: "req-close",
    });
    owner.resolveLatestWith(broker, {
      requestId: "req-close",
      ok: true,
      result: { command: "close_tab", browserId: BROWSER_ID },
    });
    await expect(closePromise).resolves.toMatchObject({
      ok: true,
      result: { command: "close_tab", browserId: BROWSER_ID },
    });

    await expect(
      broker.execute({
        command: { command: "snapshot", args: { browserId: BROWSER_ID } },
        requestId: "req-after-close",
      }),
    ).resolves.toEqual({
      requestId: "req-after-close",
      ok: false,
      error: {
        code: "browser_tab_not_found",
        message: `Browser tab ${BROWSER_ID} is not associated with a connected browser automation host. Call browser_list_tabs and use one of the returned browserId values.`,
        retryable: false,
      },
    });
    // The closed id is unknown again, so the broker looks it up before refusing.
    expect(owner.receivedRequests.map((request) => request.command.command)).toEqual([
      "new_tab",
      "close_tab",
      "list_tabs",
    ]);
    expect(other.receivedRequests.map((request) => request.command.command)).toEqual(["list_tabs"]);
  });

  test("failed list tabs aggregation does not seed browser id affinity", async () => {
    const broker = createBroker();
    const firstHost = new FakeBrowserHostClient("host-1");
    const secondHost = new FakeBrowserHostClient("host-2");
    broker.registerClient(firstHost);
    broker.registerClient(secondHost);

    const listPromise = broker.execute({
      command: { command: "list_tabs", args: {} },
      workspaceId: "workspace-1",
    });

    firstHost.resolveLatestWith(broker, {
      requestId: "req-1:host-1",
      ok: true,
      result: {
        command: "list_tabs",
        tabs: [
          {
            browserId: BROWSER_ID,
            workspaceId: "workspace-1",
            url: "https://one.example",
            title: "One",
          },
        ],
      },
    });
    secondHost.resolveLatestWith(broker, {
      requestId: "req-1:host-2",
      ok: false,
      error: {
        code: "browser_timeout",
        message: "Host did not answer list_tabs.",
        retryable: true,
      },
    });

    await expect(listPromise).resolves.toEqual({
      requestId: "req-1",
      ok: false,
      error: {
        code: "browser_timeout",
        message: "Host did not answer list_tabs.",
        retryable: true,
      },
    });

    await expect(
      broker.execute({
        command: { command: "snapshot", args: { browserId: BROWSER_ID } },
        workspaceId: "workspace-1",
      }),
    ).resolves.toEqual({
      requestId: "req-1",
      ok: false,
      error: {
        code: "browser_tab_not_found",
        message: `Browser tab ${BROWSER_ID} is not associated with a connected browser automation host. Call browser_list_tabs and use one of the returned browserId values.`,
        retryable: false,
      },
    });
    // The failed listing seeded nothing, so the snapshot's id is looked up once more.
    expect(firstHost.receivedRequests.map((request) => request.command.command)).toEqual([
      "list_tabs",
      "list_tabs",
    ]);
    expect(secondHost.receivedRequests.map((request) => request.command.command)).toEqual([
      "list_tabs",
      "list_tabs",
    ]);
  });

  test("unsupported commands are rejected before sending to the routed host", async () => {
    const broker = createBroker();
    const client = new FakeBrowserHostClient("host-1", {
      supportedCommands: ["list_tabs"],
      hostKind: "desktop app",
    });
    broker.registerClient(client);

    await expect(broker.execute({ command: snapshotCommand() })).resolves.toEqual({
      requestId: "req-1",
      ok: false,
      error: {
        code: "browser_unsupported",
        message: 'Browser automation command "snapshot" is not supported by the desktop app.',
        retryable: false,
      },
    });
    await expect(
      broker.execute({
        command: {
          command: "evaluate",
          args: { browserId: BROWSER_ID, function: "() => document.title" },
        },
      }),
    ).resolves.toEqual({
      requestId: "req-1",
      ok: false,
      error: {
        code: "browser_unsupported",
        message: 'Browser automation command "evaluate" is not supported by the desktop app.',
        retryable: false,
      },
    });
    await expect(
      broker.execute({
        command: {
          command: "scroll",
          args: { browserId: BROWSER_ID, deltaX: 0, deltaY: 400 },
        },
      }),
    ).resolves.toEqual({
      requestId: "req-1",
      ok: false,
      error: {
        code: "browser_unsupported",
        message: 'Browser automation command "scroll" is not supported by the desktop app.',
        retryable: false,
      },
    });
    expect(client.receivedRequests).toEqual([]);
  });

  test("unregistering a host strands its browser ids instead of routing them to another host", async () => {
    const broker = createBroker();
    const owner = new FakeBrowserHostClient("host-1");
    const unregisterOwner = broker.registerClient(owner);

    const newTabPromise = broker.execute({
      command: { command: "new_tab", args: {} },
      separateTab: true,
      workspaceId: "workspace-1",
    });
    owner.resolveLatestWith(broker, {
      requestId: "req-1",
      ok: true,
      result: {
        command: "new_tab",
        browserId: BROWSER_ID,
        workspaceId: "workspace-1",
        url: "https://example.com",
      },
    });
    await newTabPromise;

    unregisterOwner();
    const replacement = new FakeBrowserHostClient("host-2");
    broker.registerClient(replacement);

    await expect(
      broker.execute({
        command: { command: "snapshot", args: { browserId: BROWSER_ID } },
        workspaceId: "workspace-1",
      }),
    ).resolves.toEqual({
      requestId: "req-1",
      ok: false,
      error: {
        code: "browser_no_host",
        message: `The app hosting browser tab ${BROWSER_ID} disconnected.`,
        retryable: true,
      },
    });
    expect(replacement.receivedRequests).toEqual([]);
  });

  test("reconnecting the same host reclaims its stranded browser ids", async () => {
    const broker = createBroker();
    const owner = new FakeBrowserHostClient("host-1");
    const unregisterOwner = broker.registerClient(owner);

    const newTabPromise = broker.execute({
      command: { command: "new_tab", args: {} },
      separateTab: true,
      workspaceId: "workspace-1",
    });
    owner.resolveLatestWith(broker, {
      requestId: "req-1",
      ok: true,
      result: {
        command: "new_tab",
        browserId: BROWSER_ID,
        workspaceId: "workspace-1",
        url: "https://example.com",
      },
    });
    await newTabPromise;

    unregisterOwner();
    const reconnectedOwner = new FakeBrowserHostClient("host-1");
    broker.registerClient(reconnectedOwner);

    const snapshotPromise = broker.execute({
      command: { command: "snapshot", args: { browserId: BROWSER_ID } },
      workspaceId: "workspace-1",
    });

    expect(reconnectedOwner.receivedRequests).toEqual([
      {
        type: "browser.automation.execute.request",
        requestId: "req-1",
        workspaceId: "workspace-1",
        command: { command: "snapshot", args: { browserId: BROWSER_ID } },
      },
    ]);
    reconnectedOwner.resolveLatestWith(broker, {
      requestId: "req-1",
      ok: true,
      result: {
        command: "snapshot",
        browserId: BROWSER_ID,
        workspaceId: "workspace-1",
        url: "https://example.com",
        title: "Example",
        format: "aria-yaml",
        snapshot: "- document",
        truncated: false,
        stats: { nodeCount: 1, refCount: 0, textLength: 10 },
      },
    });

    await expect(snapshotPromise).resolves.toMatchObject({
      ok: true,
      result: { command: "snapshot", browserId: BROWSER_ID },
    });
  });

  test("timeout resolves browser_timeout and clears pending state", async () => {
    vi.useFakeTimers();
    const broker = createBroker({ timeoutMs: 50 });
    broker.registerClient(new FakeBrowserHostClient("host-1"));

    const resultPromise = broker.execute({ command: snapshotCommand() });
    expect(broker.getPendingRequestCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(50);

    await expect(resultPromise).resolves.toEqual({
      requestId: "req-1",
      ok: false,
      error: {
        code: "browser_timeout",
        message: "Browser automation timed out after 50ms.",
        retryable: true,
      },
    });
    expect(broker.getPendingRequestCount()).toBe(0);
  });

  test("disconnect resolves retryable failure and clears pending request", async () => {
    const broker = createBroker();
    const client = new FakeBrowserHostClient("host-1");
    const unregister = broker.registerClient(client);

    const resultPromise = broker.execute({ command: snapshotCommand() });
    expect(broker.getPendingRequestCount()).toBe(1);

    unregister();

    await expect(resultPromise).resolves.toEqual({
      requestId: "req-1",
      ok: false,
      error: {
        code: "browser_no_host",
        message: "The browser automation host disconnected before responding.",
        retryable: true,
      },
    });
    expect(broker.getPendingRequestCount()).toBe(0);
  });

  test("replacing a host registration resolves pending requests from the old registration", async () => {
    const broker = createBroker();
    const oldHost = new FakeBrowserHostClient("host-1");
    const newHost = new FakeBrowserHostClient("host-1");
    broker.registerClient(oldHost);

    const pendingResult = broker.execute({ command: snapshotCommand() });
    expect(oldHost.receivedRequests).toHaveLength(1);
    expect(broker.getPendingRequestCount()).toBe(1);

    broker.registerClient(newHost);

    await expect(pendingResult).resolves.toEqual({
      requestId: "req-1",
      ok: false,
      error: {
        code: "browser_no_host",
        message: "The browser automation host disconnected before responding.",
        retryable: true,
      },
    });
    expect(broker.getPendingRequestCount()).toBe(0);

    const listResult = broker.execute({
      command: { command: "list_tabs", args: {} },
    });
    expect(newHost.receivedRequests).toHaveLength(1);
    newHost.resolveLatestWith(broker, {
      requestId: "req-1",
      ok: true,
      result: { command: "list_tabs", tabs: [] },
    });

    await expect(listResult).resolves.toEqual({
      requestId: "req-1",
      ok: true,
      result: { command: "list_tabs", tabs: [] },
    });
  });

  test("browser host send failure resolves structured failure and clears pending request", async () => {
    const broker = createBroker();
    broker.registerClient(new FailingBrowserHostClient());

    await expect(broker.execute({ command: snapshotCommand() })).resolves.toEqual({
      requestId: "req-1",
      ok: false,
      error: {
        code: "browser_unknown_error",
        message: "Browser automation request failed to send: websocket send failed",
        retryable: false,
      },
    });
    expect(broker.getPendingRequestCount()).toBe(0);
  });

  test("explicit browser failure response propagates typed error", async () => {
    const broker = createBroker();
    const client = new FakeBrowserHostClient("host-1");
    broker.registerClient(client);

    const resultPromise = broker.execute({ command: snapshotCommand() });

    client.resolveLatestWith(broker, {
      requestId: "req-1",
      ok: false,
      error: {
        code: "browser_tab_not_found",
        message: `Browser tab ${BROWSER_ID} was not found.`,
        retryable: false,
      },
    });

    await expect(resultPromise).resolves.toEqual({
      requestId: "req-1",
      ok: false,
      error: {
        code: "browser_tab_not_found",
        message: `Browser tab ${BROWSER_ID} was not found.`,
        retryable: false,
      },
    });
    expect(broker.getPendingRequestCount()).toBe(0);
  });

  test("invalid browser response resolves a structured failure and clears pending state", async () => {
    const broker = createBroker();
    const client = new FakeBrowserHostClient("host-1");
    broker.registerClient(client);

    const resultPromise = broker.execute({ command: snapshotCommand() });
    expect(broker.getPendingRequestCount()).toBe(1);

    expect(
      broker.receiveResponse({
        type: "browser.automation.execute.response",
        payload: {
          requestId: "req-1",
          ok: true,
          result: { command: "future_command" },
        },
      } as unknown as BrowserAutomationExecuteResponse),
    ).toBe(true);

    await expect(resultPromise).resolves.toMatchObject({
      requestId: "req-1",
      ok: false,
      error: {
        code: "browser_unknown_error",
        retryable: false,
      },
    });
    expect(broker.getPendingRequestCount()).toBe(0);
  });

  test("a pinned host gets the command even when another host is newer", async () => {
    const broker = createBroker();
    const daemonHost = new FakeBrowserHostClient("daemon-playwright");
    const desktopHost = new FakeBrowserHostClient("desktop-1");
    broker.registerClient(daemonHost);
    broker.registerClient(desktopHost);

    const snapshot = broker.execute({
      command: snapshotCommand(),
      workspaceId: "workspace-1",
      hostId: "daemon-playwright",
    });
    expect(daemonHost.receivedRequests.map((request) => request.command.command)).toEqual([
      "snapshot",
    ]);
    expect(desktopHost.receivedRequests).toEqual([]);
    daemonHost.resolveLatestWith(broker, {
      requestId: "req-1",
      ok: false,
      error: {
        code: "browser_tab_not_found",
        message: "gone",
        retryable: false,
      },
    });
    await snapshot;
  });

  test("an id the broker never saw is found on whichever host lists it", async () => {
    const broker = createBroker();
    const daemonHost = new FakeBrowserHostClient("daemon-playwright");
    const desktopHost = new FakeBrowserHostClient("desktop-1");
    broker.registerClient(daemonHost);
    broker.registerClient(desktopHost);

    // As after a daemon restart: the tab exists again, but nothing routed it yet.
    const snapshot = broker.execute({
      command: snapshotCommand(),
      workspaceId: "workspace-1",
    });
    await Promise.resolve();
    daemonHost.resolveLatestWith(broker, {
      requestId: "req-1:discover:daemon-playwright",
      ok: true,
      result: {
        command: "list_tabs",
        tabs: [{ browserId: BROWSER_ID, url: "https://one.example", title: "One" }],
      },
    });
    desktopHost.resolveLatestWith(broker, {
      requestId: "req-1:discover:desktop-1",
      ok: true,
      result: { command: "list_tabs", tabs: [] },
    });
    await vi.waitFor(() => expect(daemonHost.receivedRequests).toHaveLength(2));
    expect(daemonHost.receivedRequests.at(-1)?.command.command).toBe("snapshot");
    expect(desktopHost.receivedRequests).toHaveLength(1);
    daemonHost.resolveLatestWith(broker, {
      requestId: "req-1",
      ok: true,
      result: {
        command: "snapshot",
        browserId: BROWSER_ID,
        format: "aria-yaml",
        snapshot: "- document",
        url: "https://one.example",
        title: "One",
        truncated: false,
        stats: { nodeCount: 1, refCount: 0, textLength: 0 },
      },
    });
    await expect(snapshot).resolves.toMatchObject({ ok: true });
  });
});
