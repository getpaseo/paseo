import { beforeEach, describe, expect, test } from "vitest";
import type { SessionInboundMessage, SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { createJSONStorage, type StateStorage } from "zustand/middleware";
import { mountBrowserAutomationHandler } from "./handler";
import type { DesktopHostBridge } from "@/desktop/host";
import { useBrowserStore } from "@/stores/browser-store";
import {
  buildWorkspaceTabPersistenceKey,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";

type BrowserAutomationExecuteRequest = Extract<
  SessionOutboundMessage,
  { type: "browser.automation.execute.request" }
>;
type BrowserAutomationExecuteResponse = Extract<
  SessionInboundMessage,
  { type: "browser.automation.execute.response" }
>;
type BrowserAutomationResponsePayload = BrowserAutomationExecuteResponse["payload"];

class FakeStateStorage implements StateStorage {
  private readonly values = new Map<string, string>();

  public getItem = (key: string): string | null => this.values.get(key) ?? null;

  public setItem = (key: string, value: string): void => {
    this.values.set(key, value);
  };

  public removeItem = (key: string): void => {
    this.values.delete(key);
  };

  public clear(): void {
    this.values.clear();
  }
}

class FakeDaemonClient {
  public readonly sentResponses: BrowserAutomationExecuteResponse[] = [];
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

  public payloadAt(index: number): BrowserAutomationResponsePayload {
    const response = this.sentResponses[index];
    if (!response) {
      throw new Error(`Missing browser automation response at index ${index}`);
    }
    return response.payload;
  }
}

class FakeBrowserBridge {
  public readonly executedRequests: BrowserAutomationExecuteRequest[] = [];
  public readonly registeredWorkspaceBrowsers: Array<{ browserId: string; workspaceId: string }> =
    [];
  public readonly activeWorkspaceBrowsers: Array<{
    browserId: string | null;
    workspaceId: string;
  }> = [];
  public response: BrowserAutomationResponsePayload | null = null;
  public thrownError: unknown = null;

  public executeAutomationCommand = async (
    request: BrowserAutomationExecuteRequest,
  ): Promise<BrowserAutomationResponsePayload> => {
    this.executedRequests.push(request);
    if (this.thrownError) {
      throw this.thrownError;
    }
    return this.response ?? currentListTabsPayload(request.requestId);
  };

  public registerWorkspaceBrowser = async (input: {
    browserId: string;
    workspaceId: string;
  }): Promise<void> => {
    this.registeredWorkspaceBrowsers.push(input);
  };

  public setWorkspaceActiveBrowser = async (input: {
    browserId: string | null;
    workspaceId: string;
  }): Promise<void> => {
    this.activeWorkspaceBrowsers.push(input);
  };
}

class FakeResidentBrowser {
  public readonly ensuredWebviews: Array<{ browserId: string; url: string }> = [];

  public ensure = (input: { browserId: string; url: string }): HTMLElement | null => {
    this.ensuredWebviews.push(input);
    return null;
  };
}

class BrowserAutomationHandlerHarness {
  public readonly client = new FakeDaemonClient();
  public readonly browser = new FakeBrowserBridge();
  public readonly resident = new FakeResidentBrowser();
  private unsubscribe: (() => void) | null = null;

  public mount(
    input: {
      serverId?: string;
      host?: DesktopHostBridge | null;
      registrationWaitTimeoutMs?: number;
      registrationPollIntervalMs?: number;
    } = {},
  ): void {
    this.unsubscribe = mountBrowserAutomationHandler({
      client: this.client,
      ...(input.serverId ? { serverId: input.serverId } : {}),
      getHost: () => (input.host === undefined ? { browser: this.browser } : input.host),
      ensureResidentBrowserWebview: this.resident.ensure,
      ...(input.registrationWaitTimeoutMs !== undefined
        ? { registrationWaitTimeoutMs: input.registrationWaitTimeoutMs }
        : {}),
      ...(input.registrationPollIntervalMs !== undefined
        ? { registrationPollIntervalMs: input.registrationPollIntervalMs }
        : {}),
    });
  }

  public unmount(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  public receive(request: BrowserAutomationExecuteRequest): void {
    this.client.receive(request);
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
    workspaceId: "wks_workspace_a",
    command: {
      command: "new_tab",
      args: { url: "https://example.com" },
    },
  };
}

function emptyListTabsPayload(requestId = "req-new:list_tabs"): BrowserAutomationResponsePayload {
  return {
    requestId,
    ok: true,
    result: {
      command: "list_tabs",
      tabs: [],
    },
  };
}

function currentListTabsPayload(requestId = "req-new:list_tabs"): BrowserAutomationResponsePayload {
  return {
    requestId,
    ok: true,
    result: {
      command: "list_tabs",
      tabs: currentBrowserTabs(),
    },
  };
}

function currentBrowserTabs() {
  return Object.values(useBrowserStore.getState().browsersById).map((browser) => ({
    browserId: browser.browserId,
    workspaceId: "wks_workspace_a",
    url: browser.url,
    title: browser.title,
    isActive: true,
    isLoading: false,
  }));
}

function newTabResultFrom(payload: BrowserAutomationResponsePayload) {
  expect(payload).toMatchObject({
    requestId: "req-new",
    ok: true,
    result: { command: "new_tab", workspaceId: "wks_workspace_a", url: "https://example.com" },
  });
  if (!payload.ok || payload.result.command !== "new_tab") {
    throw new Error("Expected browser_new_tab success payload");
  }
  return payload.result;
}

function workspaceBrowserTabs(workspaceKey: string, browserId: string) {
  return useWorkspaceLayoutStore
    .getState()
    .getWorkspaceTabs(workspaceKey)
    .filter((tab) => tab.target.kind === "browser" && tab.target.browserId === browserId);
}

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function waitForRegistrationTimeout(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

const browserAutomationStorage = new FakeStateStorage();
useBrowserStore.persist.setOptions({
  storage: createJSONStorage(() => browserAutomationStorage),
});
useWorkspaceLayoutStore.persist.setOptions({
  storage: createJSONStorage(() => browserAutomationStorage),
});

describe("mountBrowserAutomationHandler", () => {
  beforeEach(() => {
    browserAutomationStorage.clear();
    useBrowserStore.setState({ browsersById: {} });
    useWorkspaceLayoutStore.setState({ layoutByWorkspace: {} });
  });

  test("browser_new_tab creates a workspace browser tab without stealing focus", async () => {
    const browser = new BrowserAutomationHandlerHarness();
    const workspaceKey = buildWorkspaceTabPersistenceKey({
      serverId: "server-1",
      workspaceId: "wks_workspace_a",
    });
    if (!workspaceKey) {
      throw new Error("Expected workspace key");
    }
    const previousFocusedTabId = useWorkspaceLayoutStore
      .getState()
      .openTabFocused(workspaceKey, { kind: "draft", draftId: "human-draft" });
    browser.mount({ serverId: "server-1" });

    browser.receive(browserNewTabRequest());
    await flushAsyncWork();

    const result = newTabResultFrom(browser.client.payloadAt(0));
    const openedTabs = workspaceBrowserTabs(workspaceKey, result.browserId);
    const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(openedTabs).toEqual([
      expect.objectContaining({
        target: { kind: "browser", browserId: result.browserId },
      }),
    ]);
    expect(layout?.root).toEqual(
      expect.objectContaining({
        kind: "pane",
        pane: expect.objectContaining({ focusedTabId: previousFocusedTabId }),
      }),
    );
    expect(openedTabs[0]?.tabId).not.toBe(previousFocusedTabId);
    expect(browser.browser.registeredWorkspaceBrowsers).toEqual([
      { browserId: result.browserId, workspaceId: "wks_workspace_a" },
    ]);
    expect(browser.browser.activeWorkspaceBrowsers).toEqual([]);
    expect(browser.resident.ensuredWebviews).toEqual([
      { browserId: result.browserId, url: "https://example.com" },
    ]);
    expect(browser.browser.executedRequests).toEqual([
      {
        type: "browser.automation.execute.request",
        requestId: "req-new:list_tabs",
        agentId: "agent-1",
        workspaceId: "wks_workspace_a",
        command: { command: "list_tabs", args: {} },
      },
    ]);
  });

  test("browser_new_tab returns a retryable timeout when the resident webview does not register", async () => {
    const browser = new BrowserAutomationHandlerHarness();
    browser.browser.response = emptyListTabsPayload();
    browser.mount({
      serverId: "server-1",
      registrationWaitTimeoutMs: 1,
      registrationPollIntervalMs: 1,
    });

    browser.receive(browserNewTabRequest());
    await waitForRegistrationTimeout();

    expect(browser.client.sentResponses).toEqual([
      {
        type: "browser.automation.execute.response",
        payload: {
          requestId: "req-new",
          ok: false,
          error: {
            code: "browser_timeout",
            message: expect.stringContaining("Timed out waiting for browser tab"),
            retryable: true,
          },
        },
      },
    ]);
    expect(browser.resident.ensuredWebviews).toEqual([
      expect.objectContaining({ url: "https://example.com" }),
    ]);
  });

  test("browser_new_tab wraps registration bridge errors in a response", async () => {
    const browser = new BrowserAutomationHandlerHarness();
    browser.browser.thrownError = new Error("IPC registration check failed");
    browser.mount({ serverId: "server-1" });

    browser.receive(browserNewTabRequest());
    await flushAsyncWork();

    expect(browser.client.sentResponses).toEqual([
      {
        type: "browser.automation.execute.response",
        payload: {
          requestId: "req-new",
          ok: false,
          error: {
            code: "browser_unknown_error",
            message: "IPC registration check failed",
            retryable: false,
          },
        },
      },
    ]);
  });

  test("non-new-tab requests send the desktop bridge response", async () => {
    const browser = new BrowserAutomationHandlerHarness();
    browser.browser.response = {
      requestId: "desktop-req",
      ok: true,
      result: { command: "list_tabs", tabs: [] },
    };
    browser.mount();
    const request = browserAutomationRequest();

    browser.receive(request);
    await flushAsyncWork();

    expect(browser.browser.executedRequests).toEqual([request]);
    expect(browser.client.sentResponses).toEqual([
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

  test("missing desktop bridge sends browser_unsupported", async () => {
    const browser = new BrowserAutomationHandlerHarness();
    browser.mount({ host: null });

    browser.receive(browserAutomationRequest());
    await flushAsyncWork();

    expect(browser.client.sentResponses).toEqual([
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
    const browser = new BrowserAutomationHandlerHarness();
    browser.browser.thrownError = {
      code: "browser_tab_not_found",
      message: "Browser tab browser-1 was not found.",
      retryable: false,
    };
    browser.mount();

    browser.receive(browserAutomationRequest());
    await flushAsyncWork();

    expect(browser.client.sentResponses).toEqual([
      {
        type: "browser.automation.execute.response",
        payload: {
          requestId: "req-1",
          ok: false,
          error: {
            code: "browser_tab_not_found",
            message: "Browser tab browser-1 was not found.",
            retryable: false,
          },
        },
      },
    ]);
  });

  test("unimplemented preload IPC reports browser_unsupported", async () => {
    const browser = new BrowserAutomationHandlerHarness();
    browser.browser.thrownError = new Error(
      'No handler registered for "paseo:browser:execute-automation-command"',
    );
    browser.mount();

    browser.receive(browserAutomationRequest());
    await flushAsyncWork();

    expect(browser.client.sentResponses).toEqual([
      {
        type: "browser.automation.execute.response",
        payload: {
          requestId: "req-1",
          ok: false,
          error: {
            code: "browser_unsupported",
            message: "Desktop browser automation is not implemented by this desktop build yet.",
            retryable: false,
          },
        },
      },
    ]);
  });

  test("unsubscribe stops handling browser automation requests", async () => {
    const browser = new BrowserAutomationHandlerHarness();
    browser.mount();

    browser.unmount();
    browser.receive(browserAutomationRequest());
    await flushAsyncWork();

    expect(browser.browser.executedRequests).toEqual([]);
    expect(browser.client.sentResponses).toEqual([]);
  });
});
