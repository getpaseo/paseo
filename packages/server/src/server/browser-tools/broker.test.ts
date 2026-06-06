import { afterEach, describe, expect, test, vi } from "vitest";
import type {
  BrowserAutomationCommand,
  BrowserAutomationExecuteRequest,
  BrowserAutomationExecuteResponse,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { BrowserToolsBroker, type BrowserToolsDesktopClient } from "./broker.js";
import { StaticBrowserToolsPolicy } from "./policy.js";

class FakeDesktopClient implements BrowserToolsDesktopClient {
  public readonly receivedRequests: BrowserAutomationExecuteRequest[] = [];

  public constructor(public readonly id: string) {}

  public sendBrowserAutomationRequest(request: BrowserAutomationExecuteRequest): void {
    this.receivedRequests.push(request);
  }

  public resolveLatestWith(
    broker: BrowserToolsBroker,
    responsePayload: BrowserAutomationExecuteResponse["payload"],
  ): boolean {
    return broker.receiveResponse({
      type: "browser.automation.execute.response",
      payload: responsePayload,
    });
  }
}

class FailingDesktopClient implements BrowserToolsDesktopClient {
  public readonly id = "desktop-1";

  public sendBrowserAutomationRequest(): void {
    throw new Error("websocket send failed");
  }
}

function createBroker(options: { enabled: boolean; timeoutMs?: number }): BrowserToolsBroker {
  return new BrowserToolsBroker({
    policy: new StaticBrowserToolsPolicy(options.enabled),
    defaultTimeoutMs: options.timeoutMs ?? 100,
    createRequestId: () => "req-1",
  });
}

function pageInfoCommand(): BrowserAutomationCommand {
  return { command: "page_info", args: { browserId: "browser-1" } };
}

describe("BrowserToolsBroker", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("disabled returns browser_disabled", async () => {
    const broker = createBroker({ enabled: false });

    await expect(broker.execute({ command: pageInfoCommand() })).resolves.toEqual({
      requestId: "req-1",
      ok: false,
      error: {
        code: "browser_disabled",
        message: "Browser tools are disabled. Enable daemon.browserTools.enabled to use them.",
        retryable: false,
      },
    });
  });

  test("no capable desktop returns browser_no_desktop", async () => {
    const broker = createBroker({ enabled: true });

    await expect(broker.execute({ command: pageInfoCommand() })).resolves.toEqual({
      requestId: "req-1",
      ok: false,
      error: {
        code: "browser_no_desktop",
        message: "No desktop browser automation client is connected.",
        retryable: true,
      },
    });
  });

  test("invalid browser requests return structured failures without contacting desktop", async () => {
    const broker = createBroker({ enabled: true });
    const client = new FakeDesktopClient("desktop-1");
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

  test("capable fake desktop receives request and returns response", async () => {
    const broker = createBroker({ enabled: true });
    const client = new FakeDesktopClient("desktop-1");
    broker.registerClient(client);

    const resultPromise = broker.execute({
      command: { command: "list_tabs", args: { workspaceId: "workspace-1" } },
      workspaceId: "workspace-1",
    });

    expect(client.receivedRequests).toEqual([
      {
        type: "browser.automation.execute.request",
        requestId: "req-1",
        workspaceId: "workspace-1",
        command: { command: "list_tabs", args: { workspaceId: "workspace-1" } },
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
              browserId: "browser-1",
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
            browserId: "browser-1",
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

  test("desktop receives snapshot requests", async () => {
    const broker = createBroker({ enabled: true });
    const client = new FakeDesktopClient("desktop-1");
    broker.registerClient(client);

    const resultPromise = broker.execute({
      command: { command: "snapshot", args: { workspaceId: "workspace-1" } },
      workspaceId: "workspace-1",
    });

    expect(client.receivedRequests).toEqual([
      {
        type: "browser.automation.execute.request",
        requestId: "req-1",
        workspaceId: "workspace-1",
        command: { command: "snapshot", args: { workspaceId: "workspace-1" } },
      },
    ]);

    client.resolveLatestWith(broker, {
      requestId: "req-1",
      ok: true,
      result: {
        command: "snapshot",
        browserId: "browser-1",
        workspaceId: "workspace-1",
        url: "https://example.com",
        title: "Example",
        elements: [],
      },
    });

    await expect(resultPromise).resolves.toEqual({
      requestId: "req-1",
      ok: true,
      result: {
        command: "snapshot",
        browserId: "browser-1",
        workspaceId: "workspace-1",
        url: "https://example.com",
        title: "Example",
        elements: [],
      },
    });
  });

  test("timeout resolves browser_timeout and clears pending state", async () => {
    vi.useFakeTimers();
    const broker = createBroker({ enabled: true, timeoutMs: 50 });
    broker.registerClient(new FakeDesktopClient("desktop-1"));

    const resultPromise = broker.execute({ command: pageInfoCommand() });
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
    const broker = createBroker({ enabled: true });
    const client = new FakeDesktopClient("desktop-1");
    const unregister = broker.registerClient(client);

    const resultPromise = broker.execute({ command: pageInfoCommand() });
    expect(broker.getPendingRequestCount()).toBe(1);

    unregister();

    await expect(resultPromise).resolves.toEqual({
      requestId: "req-1",
      ok: false,
      error: {
        code: "browser_no_desktop",
        message: "The desktop browser automation client disconnected before responding.",
        retryable: true,
      },
    });
    expect(broker.getPendingRequestCount()).toBe(0);
  });

  test("desktop send failure resolves structured failure and clears pending request", async () => {
    const broker = createBroker({ enabled: true });
    broker.registerClient(new FailingDesktopClient());

    await expect(broker.execute({ command: pageInfoCommand() })).resolves.toEqual({
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
    const broker = createBroker({ enabled: true });
    const client = new FakeDesktopClient("desktop-1");
    broker.registerClient(client);

    const resultPromise = broker.execute({ command: pageInfoCommand() });

    client.resolveLatestWith(broker, {
      requestId: "req-1",
      ok: false,
      error: {
        code: "browser_tab_not_found",
        message: "Browser tab browser-1 was not found.",
        retryable: false,
      },
    });

    await expect(resultPromise).resolves.toEqual({
      requestId: "req-1",
      ok: false,
      error: {
        code: "browser_tab_not_found",
        message: "Browser tab browser-1 was not found.",
        retryable: false,
      },
    });
    expect(broker.getPendingRequestCount()).toBe(0);
  });

  test("invalid browser response resolves a structured failure and clears pending state", async () => {
    const broker = createBroker({ enabled: true });
    const client = new FakeDesktopClient("desktop-1");
    broker.registerClient(client);

    const resultPromise = broker.execute({ command: pageInfoCommand() });
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
});
