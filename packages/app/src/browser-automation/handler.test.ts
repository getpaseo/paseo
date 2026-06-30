import { beforeEach, describe, expect, test, vi } from "vitest";
import type { SessionInboundMessage, SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { mountBrowserAutomationHandler } from "./handler";
import type { DesktopHostBridge } from "@/desktop/host";
import { useBrowserStore } from "@/stores/browser-store";
import {
  buildWorkspaceTabPersistenceKey,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";

vi.mock("expo-router", () => ({
  router: {
    navigate: vi.fn(),
  },
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

type BrowserAutomationExecuteRequest = Extract<
  SessionOutboundMessage,
  { type: "browser.automation.execute.request" }
>;
type BrowserAutomationExecuteResponse = Extract<
  SessionInboundMessage,
  { type: "browser.automation.execute.response" }
>;

class FakeDaemonClient {
  public sentResponses: BrowserAutomationExecuteResponse[] = [];
  private handler: ((request: BrowserAutomationExecuteRequest) => void) | null = null;

  public on(
    type: "browser.automation.execute.request",
    handler: (request: BrowserAutomationExecuteRequest) => void,
  ): () => void {
    expect(type).toBe("browser.automation.execute.request");
    this.handler = handler;
    return () => {
      if (this.handler === handler) {
        this.handler = null;
      }
    };
  }

  public sendBrowserAutomationExecuteResponse(response: BrowserAutomationExecuteResponse): void {
    this.sentResponses.push(response);
  }

  public receive(nextRequest: BrowserAutomationExecuteRequest): void {
    this.handler?.(nextRequest);
  }
}

function browserAutomationRequest(): BrowserAutomationExecuteRequest {
  return {
    type: "browser.automation.execute.request",
    requestId: "req-1",
    command: { command: "list_tabs", args: {} },
  };
}

function browserNewTabRequest(): BrowserAutomationExecuteRequest {
  return {
    type: "browser.automation.execute.request",
    requestId: "req-new",
    agentId: "agent-1",
    workspaceId: "/repo",
    command: { command: "new_tab", args: { workspaceId: "/repo", url: "https://example.com" } },
  };
}

function emptyListTabsPayload(requestId = "req-new:list_tabs") {
  return {
    requestId,
    ok: true as const,
    result: {
      command: "list_tabs" as const,
      tabs: [],
    },
  };
}

function currentListTabsPayload(requestId = "req-new:list_tabs") {
  return {
    requestId,
    ok: true as const,
    result: {
      command: "list_tabs" as const,
      tabs: currentBrowserTabs(),
    },
  };
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function waitForAsyncWork(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

function currentBrowserTabs() {
  return Object.values(useBrowserStore.getState().browsersById).map((browser) => ({
    browserId: browser.browserId,
    workspaceId: "/repo",
    url: browser.url,
    title: browser.title,
    isActive: true,
    isLoading: false,
  }));
}

describe("mountBrowserAutomationHandler", () => {
  beforeEach(() => {
    useBrowserStore.setState({ browsersById: {} });
    useWorkspaceLayoutStore.setState({ layoutByWorkspace: {} });
  });

  test("creates an unfocused workspace browser tab for browser_new_tab", async () => {
    const client = new FakeDaemonClient();
    const setWorkspaceActiveBrowser = vi.fn(async () => undefined);
    const setAgentActiveBrowser = vi.fn(async () => undefined);
    const registerWorkspaceBrowser = vi.fn(async () => undefined);
    const ensureResidentBrowserWebview = vi.fn();
    const executeAutomationCommand = vi.fn(async () => currentListTabsPayload());
    const workspaceKey = buildWorkspaceTabPersistenceKey({
      serverId: "server-1",
      workspaceId: "/repo",
    });
    if (!workspaceKey) throw new Error("expected workspace key");
    const focusedTabId = useWorkspaceLayoutStore
      .getState()
      .openTabFocused(workspaceKey, { kind: "draft", draftId: "human-draft" });
    if (!focusedTabId) throw new Error("expected focused tab");
    mountBrowserAutomationHandler({
      client,
      serverId: "server-1",
      getHost: () =>
        ({
          browser: {
            executeAutomationCommand,
            registerWorkspaceBrowser,
            setWorkspaceActiveBrowser,
            setAgentActiveBrowser,
          },
        }) satisfies DesktopHostBridge,
      ensureResidentBrowserWebview,
    });

    client.receive(browserNewTabRequest());
    await flushPromises();

    const payload = client.sentResponses[0]?.payload;
    expect(payload?.ok).toBe(true);
    if (!payload?.ok) throw new Error("expected success");
    expect(payload.result.command).toBe("new_tab");
    if (payload.result.command !== "new_tab") throw new Error("expected new_tab result");
    expect(payload.result.url).toBe("https://example.com");
    expect(useWorkspaceLayoutStore.getState().getWorkspaceTabs(workspaceKey)).toContainEqual(
      expect.objectContaining({ target: { kind: "browser", browserId: payload.result.browserId } }),
    );
    const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(layout?.root.kind).toBe("pane");
    if (layout?.root.kind !== "pane") throw new Error("expected root pane");
    expect(layout.root.pane.focusedTabId).toBe(focusedTabId);
    expect(registerWorkspaceBrowser).toHaveBeenCalledWith({
      browserId: payload.result.browserId,
      workspaceId: "/repo",
    });
    expect(setAgentActiveBrowser).toHaveBeenCalledWith({
      agentId: "agent-1",
      browserId: payload.result.browserId,
    });
    expect(setWorkspaceActiveBrowser).not.toHaveBeenCalled();
    expect(ensureResidentBrowserWebview).toHaveBeenCalledWith({
      browserId: payload.result.browserId,
      url: "https://example.com",
    });
    expect(executeAutomationCommand).toHaveBeenCalledTimes(1);
  });

  test("returns browser_timeout when the resident webview does not register", async () => {
    const client = new FakeDaemonClient();
    const ensureResidentBrowserWebview = vi.fn();
    const executeAutomationCommand = vi.fn(async () => emptyListTabsPayload());
    mountBrowserAutomationHandler({
      client,
      serverId: "server-1",
      getHost: () => ({ browser: { executeAutomationCommand } }) satisfies DesktopHostBridge,
      ensureResidentBrowserWebview,
      registrationWaitTimeoutMs: 1,
      registrationPollIntervalMs: 1,
    });

    client.receive(browserNewTabRequest());
    await waitForAsyncWork();

    expect(client.sentResponses[0]?.payload).toMatchObject({
      requestId: "req-new",
      ok: false,
      error: {
        code: "browser_timeout",
        retryable: true,
      },
    });
    expect(ensureResidentBrowserWebview).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://example.com" }),
    );
    expect(client.sentResponses[0]?.payload).not.toMatchObject({
      ok: true,
      result: { command: "new_tab" },
    });
  });

  test("wraps browser_new_tab registration bridge errors in a response", async () => {
    const client = new FakeDaemonClient();
    const executeAutomationCommand = vi.fn(async () => {
      throw new Error("IPC registration check failed");
    });
    mountBrowserAutomationHandler({
      client,
      serverId: "server-1",
      getHost: () => ({ browser: { executeAutomationCommand } }) satisfies DesktopHostBridge,
    });

    client.receive(browserNewTabRequest());
    await flushPromises();

    expect(client.sentResponses[0]?.payload).toEqual({
      requestId: "req-new",
      ok: false,
      error: {
        code: "browser_unknown_error",
        message: "IPC registration check failed",
        retryable: false,
      },
    });
  });

  test("sends a success response from the desktop bridge", async () => {
    const client = new FakeDaemonClient();
    const executeAutomationCommand = vi.fn(async () => ({
      requestId: "req-1",
      ok: true as const,
      result: { command: "list_tabs" as const, tabs: [] },
    }));

    mountBrowserAutomationHandler({
      client,
      getHost: () => ({ browser: { executeAutomationCommand } }) satisfies DesktopHostBridge,
    });

    client.receive(browserAutomationRequest());
    await flushPromises();

    expect(executeAutomationCommand).toHaveBeenCalledWith(browserAutomationRequest());
    expect(client.sentResponses).toEqual([
      {
        type: "browser.automation.execute.response",
        payload: {
          requestId: "req-1",
          ok: true,
          result: { command: "list_tabs", tabs: [] },
        },
      },
    ]);
  });

  test("missing bridge sends browser_unsupported", async () => {
    const client = new FakeDaemonClient();
    mountBrowserAutomationHandler({ client, getHost: () => null });

    client.receive(browserAutomationRequest());
    await flushPromises();

    expect(client.sentResponses).toEqual([
      {
        type: "browser.automation.execute.response",
        payload: {
          requestId: "req-1",
          ok: false,
          error: {
            code: "browser_unsupported",
            message: "Desktop browser automation is not available in this app runtime.",
            retryable: false,
          },
        },
      },
    ]);
  });

  test("typed bridge errors become failure responses", async () => {
    const client = new FakeDaemonClient();
    mountBrowserAutomationHandler({
      client,
      getHost: () => ({
        browser: {
          executeAutomationCommand: async () => {
            throw {
              code: "browser_tab_not_found",
              message: "Browser tab browser-1 was not found.",
              retryable: false,
            };
          },
        },
      }),
    });

    client.receive(browserAutomationRequest());
    await flushPromises();

    expect(client.sentResponses[0]?.payload).toEqual({
      requestId: "req-1",
      ok: false,
      error: {
        code: "browser_tab_not_found",
        message: "Browser tab browser-1 was not found.",
        retryable: false,
      },
    });
  });

  test("unimplemented preload IPC reports browser_unsupported", async () => {
    const client = new FakeDaemonClient();
    mountBrowserAutomationHandler({
      client,
      getHost: () => ({
        browser: {
          executeAutomationCommand: async () => {
            throw new Error('No handler registered for "paseo:browser:execute-automation-command"');
          },
        },
      }),
    });

    client.receive(browserAutomationRequest());
    await flushPromises();

    expect(client.sentResponses[0]?.payload).toEqual({
      requestId: "req-1",
      ok: false,
      error: {
        code: "browser_unsupported",
        message: "Desktop browser automation is not implemented by this desktop build yet.",
        retryable: false,
      },
    });
  });

  test("unsubscribe stops handling requests", async () => {
    const client = new FakeDaemonClient();
    const executeAutomationCommand = vi.fn(async () => ({
      requestId: "req-1",
      ok: true as const,
      result: { command: "list_tabs" as const, tabs: [] },
    }));
    const unsubscribe = mountBrowserAutomationHandler({
      client,
      getHost: () => ({ browser: { executeAutomationCommand } }),
    });

    unsubscribe();
    client.receive(browserAutomationRequest());
    await flushPromises();

    expect(executeAutomationCommand).not.toHaveBeenCalled();
    expect(client.sentResponses).toEqual([]);
  });
});
