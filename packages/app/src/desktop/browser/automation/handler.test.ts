import { beforeEach, describe, expect, test, vi } from "vitest";
import type { SessionInboundMessage, SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { createJSONStorage, type StateStorage } from "zustand/middleware";
import { mountBrowserAutomationHandler } from "./handler";
import type { DesktopHostBridge } from "@/desktop/host";
import { createWorkspaceBrowser, getBrowserRecord, useBrowserStore } from "@/desktop/browser/store";
import {
  collectAllTabs,
  findPaneById,
  findPaneContainingTab,
} from "@/stores/workspace-layout-actions";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { useSessionStore } from "@/stores/session-store";
import {
  closeWorkspaceBrowser,
  reopenLastWorkspaceBrowser,
  openWorkspaceBrowser,
} from "@/workspace-tabs/browser";
import { purgeArchivedWorkspaceState } from "@/workspace/use-workspace-archive";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

vi.hoisted(async () => {
  const { indexedDB } = await import("fake-indexeddb");
  globalThis.indexedDB = indexedDB;
});

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
  public readonly unregisteredWorkspaceBrowsers: string[] = [];
  public readonly activeWorkspaceBrowsers: Array<{
    browserId: string | null;
    workspaceId: string;
  }> = [];
  public response: BrowserAutomationResponsePayload | null = null;
  public thrownError: unknown = null;
  public pendingResponse: Promise<BrowserAutomationResponsePayload> | null = null;
  public unregisterWait: Promise<void> | null = null;
  public unregisterError: unknown = null;

  public executeAutomationCommand = async (
    request: BrowserAutomationExecuteRequest,
  ): Promise<BrowserAutomationResponsePayload> => {
    this.executedRequests.push(request);
    if (this.thrownError) {
      throw this.thrownError;
    }
    return this.pendingResponse ?? this.response ?? currentListTabsPayload(request.requestId);
  };

  public unregisterWorkspaceBrowser = async (browserId: string): Promise<void> => {
    this.unregisteredWorkspaceBrowsers.push(browserId);
    await this.unregisterWait;
    if (this.unregisterError) throw this.unregisterError;
  };

  public setWorkspaceActiveBrowser = async (input: {
    browserId: string | null;
    workspaceId: string;
  }): Promise<void> => {
    this.activeWorkspaceBrowsers.push(input);
  };
}

class FakeResidentBrowser {
  public readonly ensuredWebviews: Array<{
    browserId: string;
    workspaceId: string;
    url: string;
  }> = [];

  public ensure = (input: {
    browserId: string;
    workspaceId: string;
    url: string;
  }): HTMLElement | null => {
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

function browserResizeRequest(
  browserId: string,
  input: { workspaceId?: string } = {},
): BrowserAutomationExecuteRequest {
  return {
    type: "browser.automation.execute.request",
    requestId: "req-resize",
    agentId: "agent-1",
    workspaceId: input.workspaceId ?? "wks_workspace_a",
    command: {
      command: "resize",
      args: { browserId, width: 1024, height: 768 },
    },
  };
}

function browserCloseTabRequest(browserId: string): BrowserAutomationExecuteRequest {
  return {
    type: "browser.automation.execute.request",
    requestId: "req-close-tab",
    agentId: "agent-1",
    workspaceId: "wks_workspace_a",
    command: {
      command: "close_tab",
      args: { browserId },
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

function seedWorkspace(serverId: string, workspaceId: string) {
  useSessionStore.getState().initializeSession(serverId, null);
  useSessionStore.getState().setWorkspaces(
    serverId,
    (previous) =>
      new Map([
        ...previous,
        [
          workspaceId,
          {
            id: workspaceId,
            projectId: "project-1",
            projectDisplayName: "Project",
            projectRootPath: "/repo",
            workspaceDirectory: "/repo",
            projectKind: "git",
            workspaceKind: "directory",
            name: "Workspace",
            status: "running",
            statusEnteredAt: null,
            archivingAt: null,
            diffStat: null,
            scripts: [],
          },
        ],
      ]),
  );
  return buildWorkspaceTabPersistenceKey({ serverId, workspaceId })!;
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
    useBrowserStore.setState({ browsersById: {}, lastClosedByWorkspace: {} });
    useWorkspaceLayoutStore.setState({
      layoutByWorkspace: {},
      browserPaneIdByWorkspace: {},
      sidePaneIdByWorkspace: {},
      explorerSidebarPaneIdByWorkspace: {},
      focusRestorationByWorkspace: {},
    });
    useSessionStore.setState({ sessions: {} });
    seedWorkspace("server-1", "wks_workspace_a");
  });

  test("manual close restores the last URL and viewport with a new browser id", async () => {
    const workspaceKey = seedWorkspace("server-1", "wks_workspace_a");
    const opened = openWorkspaceBrowser({
      workspaceKey,
      url: "https://example.com/last",
      intent: "reveal",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error(opened.code);
    useBrowserStore
      .getState()
      .setBrowserViewport(opened.browserId, { mode: "fixed", width: 390, height: 844 });
    await closeWorkspaceBrowser({ workspaceKey, browserId: opened.browserId, remember: true });
    const result = reopenLastWorkspaceBrowser(workspaceKey);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    expect(result.browserId).not.toBe(opened.browserId);
    expect(getBrowserRecord(result.browserId)?.url).toBe("https://example.com/last");
    expect(getBrowserRecord(result.browserId)?.viewport).toEqual({
      mode: "fixed",
      width: 390,
      height: 844,
    });
    expect(getBrowserRecord(opened.browserId)).toBeNull();
    expect(useBrowserStore.getState().lastClosedByWorkspace[workspaceKey]).toBeUndefined();
  });

  test("closed descriptors are memory only and a failed reopen keeps them", async () => {
    const workspaceKey = seedWorkspace("server-1", "wks_workspace_a");
    const opened = openWorkspaceBrowser({
      workspaceKey,
      url: "https://example.com/closed",
      intent: "reveal",
    });
    if (!opened.ok) throw new Error(opened.code);
    await closeWorkspaceBrowser({ workspaceKey, browserId: opened.browserId, remember: true });
    const persisted = browserAutomationStorage.getItem("workspace-browser-store")!;
    expect(JSON.parse(persisted).state).not.toHaveProperty("lastClosedByWorkspace");
    useSessionStore.setState({ sessions: {} });
    expect(reopenLastWorkspaceBrowser(workspaceKey)).toEqual({
      ok: false,
      code: "workspace_unavailable",
    });
    expect(Object.keys(useBrowserStore.getState().browsersById)).toHaveLength(0);
    expect(useBrowserStore.getState().lastClosedByWorkspace[workspaceKey]?.url).toBe(
      "https://example.com/closed",
    );
    useBrowserStore.setState({ lastClosedByWorkspace: {} });
    await useBrowserStore.persist.rehydrate();
    expect(useBrowserStore.getState().lastClosedByWorkspace).toEqual({});
    expect(reopenLastWorkspaceBrowser(workspaceKey)).toEqual({
      ok: false,
      code: "browser_unavailable",
    });
  });

  test("a second close is idempotent before unregister finishes and bridge errors retain local cleanup", async () => {
    const workspaceKey = seedWorkspace("server-1", "wks_workspace_a");
    const opened = openWorkspaceBrowser({ workspaceKey, intent: "background" });
    if (!opened.ok) throw new Error(opened.code);
    const bridge = new FakeBrowserBridge();
    let finish!: () => void;
    bridge.unregisterWait = new Promise((resolve) => {
      finish = resolve;
    });
    const failure = new Error("unregister failed");
    bridge.unregisterError = failure;
    const first = closeWorkspaceBrowser(
      { workspaceKey, browserId: opened.browserId, remember: true },
      bridge,
    );
    await closeWorkspaceBrowser(
      { workspaceKey, browserId: opened.browserId, remember: true },
      bridge,
    );
    expect(bridge.unregisteredWorkspaceBrowsers).toEqual([opened.browserId]);
    expect(getBrowserRecord(opened.browserId)).toBeNull();
    expect(workspaceBrowserTabs(workspaceKey, opened.browserId)).toEqual([]);
    finish();
    await expect(first).rejects.toBe(failure);
    expect(useBrowserStore.getState().lastClosedByWorkspace[workspaceKey]).toBeDefined();
  });

  test("closing during a pending registration cancels new_tab without recreating its guest", async () => {
    const browser = new BrowserAutomationHandlerHarness();
    browser.browser.pendingResponse = new Promise(() => {});
    browser.mount({ serverId: "server-1" });
    browser.receive(browserNewTabRequest());
    await flushAsyncWork();
    const browserId = Object.keys(useBrowserStore.getState().browsersById)[0];
    const workspaceKey = seedWorkspace("server-1", "wks_workspace_a");
    await closeWorkspaceBrowser({ workspaceKey, browserId, remember: false }, browser.browser);
    await flushAsyncWork();
    expect(browser.client.payloadAt(0)).toMatchObject({
      ok: false,
      error: { code: "browser_tab_closed" },
    });
    expect(browser.resident.ensuredWebviews).toHaveLength(1);
    expect(browser.browser.unregisteredWorkspaceBrowsers).toEqual([browserId]);
    expect(getBrowserRecord(browserId)).toBeNull();
    expect(useBrowserStore.getState().lastClosedByWorkspace).toEqual({});
    browser.unmount();
  });

  test("reopen reuses a compatible retained pane and falls back after it becomes mixed", async () => {
    const workspaceKey = seedWorkspace("server-1", "wks_workspace_a");
    const first = openWorkspaceBrowser({ workspaceKey, intent: "reveal" });
    if (!first.ok) throw new Error(first.code);
    const second = openWorkspaceBrowser({ workspaceKey, intent: "background" });
    if (!second.ok) throw new Error(second.code);
    const paneId = findPaneContainingTab(
      useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root,
      first.tabId,
    )!.id;
    await closeWorkspaceBrowser({ workspaceKey, browserId: first.browserId, remember: true });
    const reopened = reopenLastWorkspaceBrowser(workspaceKey);
    if (!reopened.ok) throw new Error(reopened.code);
    expect(
      findPaneContainingTab(
        useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root,
        reopened.tabId,
      )?.id,
    ).toBe(paneId);
    await closeWorkspaceBrowser({ workspaceKey, browserId: reopened.browserId, remember: true });
    useWorkspaceLayoutStore.getState().openTab({
      workspaceKey,
      target: { kind: "draft", draftId: "mixed" },
      intent: "background",
      placement: { mode: "pane", paneId },
    });
    const fallback = reopenLastWorkspaceBrowser(workspaceKey);
    if (!fallback.ok) throw new Error(fallback.code);
    expect(
      findPaneContainingTab(
        useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root,
        fallback.tabId,
      )?.id,
    ).not.toBe(paneId);
  });

  test("closing from another workspace cannot remove its browser record", async () => {
    const workspaceKey = seedWorkspace("server-1", "wks_workspace_a");
    const otherKey = seedWorkspace("server-1", "wks_workspace_b");
    const opened = openWorkspaceBrowser({ workspaceKey, intent: "background" });
    if (!opened.ok) throw new Error(opened.code);
    const bridge = new FakeBrowserBridge();
    await closeWorkspaceBrowser(
      { workspaceKey: otherKey, browserId: opened.browserId, remember: true },
      bridge,
    );
    expect(getBrowserRecord(opened.browserId)).not.toBeNull();
    expect(bridge.unregisteredWorkspaceBrowsers).toEqual([]);
    expect(useBrowserStore.getState().lastClosedByWorkspace).toEqual({});
  });

  test("purge removes hidden pages and closed memory while isolating another workspace", async () => {
    const workspaceKey = seedWorkspace("server-1", "wks_workspace_a");
    const otherKey = seedWorkspace("server-1", "wks_workspace_b");
    const first = openWorkspaceBrowser({ workspaceKey, intent: "background" });
    const second = openWorkspaceBrowser({ workspaceKey, intent: "background" });
    const other = openWorkspaceBrowser({ workspaceKey: otherKey, intent: "background" });
    if (!first.ok || !second.ok || !other.ok) throw new Error("expected opens");
    await closeWorkspaceBrowser({ workspaceKey, browserId: first.browserId, remember: true });
    useBrowserStore.setState((state) => ({
      lastClosedByWorkspace: {
        ...state.lastClosedByWorkspace,
        [otherKey]: {
          url: "https://example.com/other",
          viewport: { mode: "responsive" },
          paneId: null,
        },
      },
    }));
    const bridge = new FakeBrowserBridge();
    const bridgeError = new Error("archive unregister failed");
    bridge.unregisterError = bridgeError;
    await expect(
      purgeArchivedWorkspaceState({ serverId: "server-1", workspaceId: "wks_workspace_a" }, bridge),
    ).rejects.toBe(bridgeError);
    expect(bridge.unregisteredWorkspaceBrowsers).toEqual([second.browserId]);
    expect(useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]).toBeUndefined();
    expect(getBrowserRecord(second.browserId)).toBeNull();
    expect(useBrowserStore.getState().lastClosedByWorkspace[workspaceKey]).toBeUndefined();
    expect(getBrowserRecord(other.browserId)).not.toBeNull();
    expect(useBrowserStore.getState().lastClosedByWorkspace[otherKey]?.url).toBe(
      "https://example.com/other",
    );
    useBrowserStore.setState((state) => ({
      lastClosedByWorkspace: {
        ...state.lastClosedByWorkspace,
        [workspaceKey]: {
          url: "https://example.com/stale",
          viewport: { mode: "responsive" },
          paneId: null,
        },
      },
    }));
    useWorkspaceLayoutStore.getState().purgeWorkspace(workspaceKey);
    expect(useBrowserStore.getState().lastClosedByWorkspace[workspaceKey]).toBeUndefined();
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
    const previousFocusedTabId = useWorkspaceLayoutStore.getState().openTab({
      workspaceKey: workspaceKey,
      target: { kind: "draft", draftId: "human-draft" },
      intent: "reveal",
    });
    const before = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
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
    if (!layout) {
      throw new Error("Expected workspace layout");
    }
    expect(layout.focusedPaneId).toBe(before.focusedPaneId);
    expect(layout.root).not.toEqual(before.root);
    expect(findPaneContainingTab(layout.root, openedTabs[0].tabId)?.hidden).toBe(true);
    expect(findPaneContainingTab(layout.root, previousFocusedTabId!)?.id).toBe("main");
    expect(layout.root.kind).toBe("group");
    expect(findPaneById(layout.root, "main")).toEqual(
      expect.objectContaining({ focusedTabId: previousFocusedTabId }),
    );
    expect(openedTabs[0]?.tabId).not.toBe(previousFocusedTabId);
    expect(browser.browser.activeWorkspaceBrowsers).toEqual([]);
    expect(browser.resident.ensuredWebviews).toEqual([
      {
        browserId: result.browserId,
        workspaceId: "wks_workspace_a",
        url: "https://example.com",
      },
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
    const snapshotRequest: BrowserAutomationExecuteRequest = {
      type: "browser.automation.execute.request",
      requestId: "req-snapshot",
      workspaceId: "wks_workspace_a",
      command: { command: "snapshot", args: { browserId: result.browserId } },
    };
    browser.browser.response = {
      requestId: "req-snapshot",
      ok: true,
      result: {
        command: "snapshot",
        browserId: result.browserId,
        url: result.url,
        title: "Example",
        format: "aria-yaml",
        snapshot: "- document: Example",
        truncated: false,
        stats: { nodeCount: 1, refCount: 0, textLength: 7 },
      },
    };
    browser.receive(snapshotRequest);
    await flushAsyncWork();
    expect(browser.browser.executedRequests.at(-1)).toEqual(snapshotRequest);
    expect(browser.client.payloadAt(1)).toEqual(browser.browser.response);
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
      expect.objectContaining({
        workspaceId: "wks_workspace_a",
        url: "https://example.com",
      }),
    ]);
    expect(useBrowserStore.getState().browsersById).toEqual({});
    const key = buildWorkspaceTabPersistenceKey({
      serverId: "server-1",
      workspaceId: "wks_workspace_a",
    })!;
    expect(
      useWorkspaceLayoutStore
        .getState()
        .getWorkspaceTabs(key)
        .filter((tab) => tab.target.kind === "browser"),
    ).toEqual([]);
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
    expect(useBrowserStore.getState().browsersById).toEqual({});
    const key = buildWorkspaceTabPersistenceKey({
      serverId: "server-1",
      workspaceId: "wks_workspace_a",
    })!;
    expect(
      useWorkspaceLayoutStore
        .getState()
        .getWorkspaceTabs(key)
        .filter((tab) => tab.target.kind === "browser"),
    ).toEqual([]);
  });

  test("browser_resize updates resident webview dimensions", async () => {
    const browser = new BrowserAutomationHandlerHarness();
    browser.mount({ serverId: "server-1" });

    browser.receive(browserNewTabRequest());
    await flushAsyncWork();
    const result = newTabResultFrom(browser.client.payloadAt(0));

    browser.receive(browserResizeRequest(result.browserId));
    await flushAsyncWork();

    expect(browser.client.payloadAt(1)).toEqual({
      requestId: "req-resize",
      ok: true,
      result: {
        command: "resize",
        browserId: result.browserId,
        width: 1024,
        height: 768,
      },
    });
    expect(useBrowserStore.getState().browsersById[result.browserId]?.viewport).toEqual({
      mode: "fixed",
      width: 1024,
      height: 768,
    });
    expect(browser.browser.executedRequests).toHaveLength(1);
  });

  test("browser_resize returns not found for a tab outside the request workspace", async () => {
    const browser = new BrowserAutomationHandlerHarness();
    browser.mount({ serverId: "server-1" });

    browser.receive(browserNewTabRequest());
    await flushAsyncWork();
    const result = newTabResultFrom(browser.client.payloadAt(0));

    browser.receive(browserResizeRequest(result.browserId, { workspaceId: "wks_workspace_b" }));
    await flushAsyncWork();

    expect(browser.client.payloadAt(1)).toEqual({
      requestId: "req-resize",
      ok: false,
      error: {
        code: "browser_tab_not_found",
        message: `No browser tab found for ID: ${result.browserId}`,
        retryable: false,
      },
    });
  });

  test("browser_close_tab removes the workspace tab, browser record, resident webview, and registry entry", async () => {
    const browser = new BrowserAutomationHandlerHarness();
    const workspaceKey = buildWorkspaceTabPersistenceKey({
      serverId: "server-1",
      workspaceId: "wks_workspace_a",
    });
    if (!workspaceKey) {
      throw new Error("Expected workspace key");
    }
    browser.mount({ serverId: "server-1" });

    browser.receive(browserNewTabRequest());
    await flushAsyncWork();
    const result = newTabResultFrom(browser.client.payloadAt(0));

    browser.receive(browserCloseTabRequest(result.browserId));
    await flushAsyncWork();

    expect(browser.client.payloadAt(1)).toEqual({
      requestId: "req-close-tab",
      ok: true,
      result: { command: "close_tab", browserId: result.browserId },
    });
    expect(workspaceBrowserTabs(workspaceKey, result.browserId)).toEqual([]);
    expect(useBrowserStore.getState().browsersById[result.browserId]).toBeUndefined();
    expect(browser.browser.unregisteredWorkspaceBrowsers).toEqual([result.browserId]);
    expect(currentBrowserTabs()).toEqual([]);
    expect(useBrowserStore.getState().lastClosedByWorkspace).toEqual({});
  });

  test("browser_close_tab returns not found after the tab is gone", async () => {
    const browser = new BrowserAutomationHandlerHarness();
    browser.mount({ serverId: "server-1" });

    browser.receive(browserNewTabRequest());
    await flushAsyncWork();
    const result = newTabResultFrom(browser.client.payloadAt(0));

    browser.receive(browserCloseTabRequest(result.browserId));
    await flushAsyncWork();
    browser.receive(browserCloseTabRequest(result.browserId));
    await flushAsyncWork();

    expect(browser.client.payloadAt(2)).toEqual({
      requestId: "req-close-tab",
      ok: false,
      error: {
        code: "browser_tab_not_found",
        message: `No browser tab found for ID: ${result.browserId}`,
        retryable: false,
      },
    });
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
            message: "Browser automation is not available in this app runtime.",
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
            message: "Browser automation is not implemented by this app build yet.",
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
  test("shared opening knows unvisited workspaces and never trusts an orphan layout", () => {
    const key = seedWorkspace("server-1", "unvisited");
    expect(useWorkspaceLayoutStore.getState().layoutByWorkspace[key]).toBeUndefined();
    const opened = openWorkspaceBrowser({
      workspaceKey: key,
      intent: "reveal",
      url: "http://localhost:3000",
    });
    expect(opened).toMatchObject({ ok: true, created: true });
    useSessionStore.getState().setWorkspaces("server-1", new Map());
    const before = useWorkspaceLayoutStore.getState().layoutByWorkspace[key];
    const records = useBrowserStore.getState().browsersById;
    expect(openWorkspaceBrowser({ workspaceKey: key, intent: "reveal" })).toEqual({
      ok: false,
      code: "workspace_unavailable",
    });
    expect(useWorkspaceLayoutStore.getState().layoutByWorkspace[key]).toBe(before);
    expect(useBrowserStore.getState().browsersById).toBe(records);
  });

  test("shared opening matches opaque host/workspace keys and isolates identical IDs across hosts", () => {
    const key = seedWorkspace("host:opaque", "workspace:opaque");
    const otherKey = seedWorkspace("other:host", "workspace:opaque");
    const first = openWorkspaceBrowser({ workspaceKey: key, intent: "reveal" });
    if (!first.ok) throw new Error("Expected browser");
    expect(
      openWorkspaceBrowser({
        workspaceKey: otherKey,
        browserId: first.browserId,
        intent: "reveal",
      }),
    ).toEqual({ ok: false, code: "browser_unavailable" });
    expect(useWorkspaceLayoutStore.getState().layoutByWorkspace[otherKey]).toBeUndefined();
    expect(openWorkspaceBrowser({ workspaceKey: otherKey, intent: "reveal" })).toMatchObject({
      ok: true,
      created: true,
    });
    expect(
      useWorkspaceLayoutStore
        .getState()
        .getWorkspaceTabs(key)
        .filter((tab) => tab.target.kind === "browser"),
    ).toHaveLength(1);
    expect(
      useWorkspaceLayoutStore
        .getState()
        .getWorkspaceTabs(otherKey)
        .filter((tab) => tab.target.kind === "browser"),
    ).toHaveLength(1);
  });

  test("same URL opens independent pages and a record without a workspace tab cannot be revealed", () => {
    const key = seedWorkspace("server-1", "unvisited");
    const first = openWorkspaceBrowser({
      workspaceKey: key,
      intent: "reveal",
      url: "https://example.com",
    });
    const second = openWorkspaceBrowser({
      workspaceKey: key,
      intent: "reveal",
      url: "https://example.com",
    });
    if (!first.ok || !second.ok) throw new Error("Expected browser pages");
    expect(second.browserId).not.toBe(first.browserId);
    expect(second.tabId).not.toBe(first.tabId);
    const orphan = createWorkspaceBrowser();
    const before = useWorkspaceLayoutStore.getState().layoutByWorkspace[key];
    expect(
      openWorkspaceBrowser({ workspaceKey: key, browserId: orphan.browserId, intent: "reveal" }),
    ).toEqual({ ok: false, code: "browser_unavailable" });
    expect(useWorkspaceLayoutStore.getState().layoutByWorkspace[key]).toBe(before);
  });

  test("reveal follows a moved browser and ignores its URL or replacement state", () => {
    const key = seedWorkspace("server-1", "unvisited");
    const first = openWorkspaceBrowser({
      workspaceKey: key,
      intent: "reveal",
      url: "https://example.com",
      state: { marker: "keep" },
    });
    if (!first.ok) throw new Error("Expected browser");
    const store = useWorkspaceLayoutStore.getState();
    store.moveTabToPane(key, first.tabId, "main");
    store.hideBrowserPane(key);
    const paneCount = collectAllTabs(
      useWorkspaceLayoutStore.getState().layoutByWorkspace[key].root,
    ).length;
    expect(
      openWorkspaceBrowser({
        workspaceKey: key,
        browserId: first.browserId,
        url: "https://changed.example",
        state: { marker: "replace" },
        intent: "reveal",
      }),
    ).toEqual({ ...first, created: false });
    const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[key];
    expect(findPaneContainingTab(layout.root, first.tabId)?.id).toBe("main");
    expect(layout.focusedPaneId).toBe("main");
    expect(collectAllTabs(layout.root)).toHaveLength(paneCount + 1);
    expect(collectAllTabs(layout.root).find((tab) => tab.tabId === first.tabId)?.state).toEqual({
      marker: "keep",
    });
    expect(getBrowserRecord(first.browserId)?.url).toBe("https://example.com");
  });

  test("background opens preserve conversation selection and pending restoration without revealing the hidden browser pane", () => {
    const key = seedWorkspace("server-1", "unvisited");
    const store = useWorkspaceLayoutStore.getState();
    const conversation = store.openTab({
      workspaceKey: key,
      target: { kind: "draft", draftId: "conversation" },
      intent: "reveal",
    });
    const first = openWorkspaceBrowser({ workspaceKey: key, intent: "background" });
    if (!first.ok) throw new Error("Expected browser");
    store.unfocusPane(key);
    const before = useWorkspaceLayoutStore.getState();
    const second = openWorkspaceBrowser({
      workspaceKey: key,
      intent: "background",
      state: { marker: "background" },
    });
    if (!second.ok) throw new Error("Expected background browser");
    const after = useWorkspaceLayoutStore.getState();
    expect(after.layoutByWorkspace[key].focusedPaneId).toBe(
      before.layoutByWorkspace[key].focusedPaneId,
    );
    expect(after.focusRestorationByWorkspace).toBe(before.focusRestorationByWorkspace);
    expect(findPaneById(after.layoutByWorkspace[key].root, "main")?.focusedTabId).toBe(
      conversation,
    );
    const browserPane = findPaneContainingTab(after.layoutByWorkspace[key].root, first.tabId)!;
    expect(browserPane.hidden).toBe(true);
    expect(browserPane.focusedTabId).toBe(first.tabId);
    expect(
      collectAllTabs(after.layoutByWorkspace[key].root).find((tab) => tab.tabId === second.tabId)
        ?.state,
    ).toEqual({ marker: "background" });
    expect(
      openWorkspaceBrowser({
        workspaceKey: key,
        browserId: first.browserId,
        intent: "background",
        placement: { mode: "pane", paneId: "main" },
      }),
    ).toEqual({ ok: false, code: "placement_unavailable" });
    expect(useWorkspaceLayoutStore.getState().layoutByWorkspace[key]).toBe(
      after.layoutByWorkspace[key],
    );
    expect(
      openWorkspaceBrowser({
        workspaceKey: key,
        browserId: first.browserId,
        intent: "background",
        placement: { mode: "pane", paneId: browserPane.id },
      }),
    ).toEqual({ ...first, created: false });
    expect(
      openWorkspaceBrowser({
        workspaceKey: key,
        browserId: first.browserId,
        intent: "background",
        placement: { mode: "prefer", paneId: "main" },
      }),
    ).toEqual({ ...first, created: false });
    expect(
      findPaneContainingTab(
        useWorkspaceLayoutStore.getState().layoutByWorkspace[key].root,
        first.tabId,
      )?.hidden,
    ).toBe(true);
  });

  test("explicit unavailable or Explorer placement fails before creating a record", () => {
    const key = seedWorkspace("server-1", "unvisited");
    const store = useWorkspaceLayoutStore.getState();
    store.openTab({
      workspaceKey: key,
      target: { kind: "draft", draftId: "conversation" },
      intent: "reveal",
    });
    const before = useWorkspaceLayoutStore.getState().layoutByWorkspace[key];
    for (const paneId of ["missing", "explorer"]) {
      expect(
        openWorkspaceBrowser({
          workspaceKey: key,
          intent: "reveal",
          placement: { mode: "pane", paneId },
        }),
      ).toEqual({ ok: false, code: "placement_unavailable" });
    }
    expect(useBrowserStore.getState().browsersById).toEqual({});
    expect(useWorkspaceLayoutStore.getState().layoutByWorkspace[key]).toBe(before);
  });

  test("only a reveal creation can replace a valid launcher and failed opens remove only their new record", () => {
    const key = seedWorkspace("server-1", "unvisited");
    const store = useWorkspaceLayoutStore.getState();
    const launcherId = store.openTab({
      workspaceKey: key,
      target: { kind: "new_tab" },
      intent: "new",
    })!;
    expect(
      openWorkspaceBrowser({ workspaceKey: key, intent: "background", replaceTabId: launcherId }),
    ).toEqual({ ok: false, code: "placement_unavailable" });
    expect(
      openWorkspaceBrowser({ workspaceKey: key, intent: "reveal", replaceTabId: "missing" }),
    ).toEqual({ ok: false, code: "placement_unavailable" });
    expect(useBrowserStore.getState().browsersById).toEqual({});
    const opened = openWorkspaceBrowser({
      workspaceKey: key,
      intent: "reveal",
      replaceTabId: launcherId,
      state: { marker: "launcher" },
    });
    if (!opened.ok) throw new Error("Expected launcher replacement");
    expect(
      findPaneContainingTab(
        useWorkspaceLayoutStore.getState().layoutByWorkspace[key].root,
        opened.tabId,
      )?.id,
    ).toBe("main");
    expect(store.getWorkspaceTabs(key).find((tab) => tab.tabId === opened.tabId)?.state).toEqual({
      marker: "launcher",
    });
    expect(
      openWorkspaceBrowser({
        workspaceKey: key,
        browserId: opened.browserId,
        intent: "reveal",
        replaceTabId: opened.tabId,
      }),
    ).toEqual({ ok: false, code: "placement_unavailable" });
    const records = useBrowserStore.getState().browsersById;
    const open = vi.spyOn(useWorkspaceLayoutStore.getState(), "openTab").mockReturnValue(null);
    expect(
      openWorkspaceBrowser({
        workspaceKey: key,
        intent: "reveal",
        placement: { mode: "pane", paneId: "main" },
      }),
    ).toEqual({ ok: false, code: "placement_unavailable" });
    expect(useBrowserStore.getState().browsersById).toEqual(records);
    expect(
      openWorkspaceBrowser({ workspaceKey: key, browserId: opened.browserId, intent: "reveal" }),
    ).toEqual({ ok: false, code: "placement_unavailable" });
    expect(getBrowserRecord(opened.browserId)).not.toBeNull();
    open.mockRestore();
  });
  test("shared opening respects explicit reveal moves, prefer placement and insertion independently of parentage", () => {
    const key = seedWorkspace("server-1", "unvisited");
    const source = openWorkspaceBrowser({
      workspaceKey: key,
      intent: "reveal",
      placement: { mode: "pane", paneId: "main" },
    });
    if (!source.ok) throw new Error("Expected source page");
    const sibling = openWorkspaceBrowser({
      workspaceKey: key,
      intent: "reveal",
      placement: { mode: "pane", paneId: "main" },
    });
    if (!sibling.ok) throw new Error("Expected sibling page");
    const child = openWorkspaceBrowser({
      workspaceKey: key,
      intent: "reveal",
      placement: { mode: "pane", paneId: "main" },
      insertionPosition: { afterTabId: source.tabId },
      parentTabId: source.tabId,
    });
    if (!child.ok) throw new Error("Expected child page");
    const store = useWorkspaceLayoutStore.getState();
    expect(findPaneById(store.layoutByWorkspace[key].root, "main")?.tabIds).toEqual([
      source.tabId,
      child.tabId,
      sibling.tabId,
    ]);
    expect(store.layoutByWorkspace[key].parentTabIdByTabId?.[child.tabId]).toBe(source.tabId);
    const paneId = store.splitPaneEmpty(key, { targetPaneId: "main", position: "right" })!;
    expect(
      openWorkspaceBrowser({
        workspaceKey: key,
        browserId: source.browserId,
        intent: "reveal",
        placement: { mode: "prefer", paneId },
      }),
    ).toEqual({ ...source, created: false });
    expect(
      findPaneContainingTab(
        useWorkspaceLayoutStore.getState().layoutByWorkspace[key].root,
        source.tabId,
      )?.id,
    ).toBe("main");
    expect(
      openWorkspaceBrowser({
        workspaceKey: key,
        browserId: source.browserId,
        intent: "reveal",
        placement: { mode: "pane", paneId },
      }),
    ).toEqual({ ...source, created: false });
    expect(
      findPaneContainingTab(
        useWorkspaceLayoutStore.getState().layoutByWorkspace[key].root,
        source.tabId,
      )?.id,
    ).toBe(paneId);
  });

  test("maximum-depth placement fails without allocating an orphan browser", () => {
    const key = seedWorkspace("server-1", "unvisited");
    const store = useWorkspaceLayoutStore.getState();
    store.openTab({
      workspaceKey: key,
      target: { kind: "draft", draftId: "conversation" },
      intent: "reveal",
    });
    for (const position of ["bottom", "right", "bottom"] as const) {
      expect(store.splitPaneEmpty(key, { targetPaneId: "main", position })).not.toBeNull();
    }
    const before = useWorkspaceLayoutStore.getState();
    expect(openWorkspaceBrowser({ workspaceKey: key, intent: "reveal" })).toEqual({
      ok: false,
      code: "placement_unavailable",
    });
    expect(useWorkspaceLayoutStore.getState()).toBe(before);
    expect(useBrowserStore.getState().browsersById).toEqual({});
  });

  test("agent creation preserves the public default URL and resolves descriptor IDs to their workspace map key", async () => {
    const key = seedWorkspace("server-1", "opaque:workspace");
    useSessionStore
      .getState()
      .setWorkspaces(
        "server-1",
        (previous) =>
          new Map([
            [
              "opaque:workspace",
              { ...previous.get("opaque:workspace")!, id: "descriptor:workspace" },
            ],
          ]),
      );
    const browser = new BrowserAutomationHandlerHarness();
    browser.mount({ serverId: "server-1" });
    browser.receive({
      ...browserNewTabRequest(),
      workspaceId: "descriptor:workspace",
      command: { command: "new_tab", args: {} },
    });
    await flushAsyncWork();
    const payload = browser.client.payloadAt(0);
    expect(payload).toMatchObject({
      ok: true,
      result: {
        command: "new_tab",
        workspaceId: "descriptor:workspace",
        url: "https://example.com",
      },
    });
    if (!payload.ok || payload.result.command !== "new_tab") throw new Error("Expected new tab");
    expect(workspaceBrowserTabs(key, payload.result.browserId)).toHaveLength(1);
    expect(
      useWorkspaceLayoutStore.getState().layoutByWorkspace["server-1:descriptor:workspace"],
    ).toBeUndefined();
  });

  test("registration failure retains the bridge cause, clears the incomplete page, and preserves pending focus restoration", async () => {
    const key = seedWorkspace("server-1", "wks_workspace_a");
    const store = useWorkspaceLayoutStore.getState();
    store.openTab({
      workspaceKey: key,
      target: { kind: "draft", draftId: "conversation" },
      intent: "reveal",
    });
    store.unfocusPane(key);
    const before = useWorkspaceLayoutStore.getState();
    const browser = new BrowserAutomationHandlerHarness();
    browser.browser.response = {
      requestId: "req-new:list_tabs",
      ok: false,
      error: { code: "browser_unsupported", message: "Registration unavailable", retryable: false },
    };
    browser.mount({ serverId: "server-1" });
    browser.receive(browserNewTabRequest());
    await flushAsyncWork();
    expect(browser.client.payloadAt(0)).toEqual({
      requestId: "req-new",
      ok: false,
      error: { code: "browser_unsupported", message: "Registration unavailable", retryable: false },
    });
    expect(useBrowserStore.getState().browsersById).toEqual({});
    const after = useWorkspaceLayoutStore.getState();
    expect(after.layoutByWorkspace[key].focusedPaneId).toBe(
      before.layoutByWorkspace[key].focusedPaneId,
    );
    expect(after.focusRestorationByWorkspace[key]).toBe(before.focusRestorationByWorkspace[key]);
  });
  test("explicit background placement preserves a focused visible launcher and its selected page", () => {
    const key = seedWorkspace("server-1", "launcher-workspace");
    const store = useWorkspaceLayoutStore.getState();
    const draftId = store.openTab({
      workspaceKey: key,
      target: { kind: "draft", draftId: "temporary" },
      intent: "reveal",
    })!;
    store.closeTab(key, draftId);
    const launcher = findPaneById(
      useWorkspaceLayoutStore.getState().layoutByWorkspace[key].root,
      "main",
    )!;
    expect(collectAllTabs({ kind: "pane", pane: launcher }).map((tab) => tab.target.kind)).toEqual([
      "new_tab",
    ]);
    const launcherId = launcher.focusedTabId!;
    const before = useWorkspaceLayoutStore.getState();
    const opened = openWorkspaceBrowser({
      workspaceKey: key,
      intent: "background",
      placement: { mode: "pane", paneId: "main" },
    });
    if (!opened.ok) throw new Error("Expected background creation");
    const after = useWorkspaceLayoutStore.getState();
    const pane = findPaneById(after.layoutByWorkspace[key].root, "main")!;
    expect(after.layoutByWorkspace[key].focusedPaneId).toBe(
      before.layoutByWorkspace[key].focusedPaneId,
    );
    expect(pane.focusedTabId).toBe(launcherId);
    expect(
      collectAllTabs({ kind: "pane", pane: pane }).find((tab) => tab.tabId === launcherId)?.target,
    ).toEqual({ kind: "new_tab" });
    expect(pane.tabIds).toEqual([launcherId, opened.tabId]);
    expect(after.focusRestorationByWorkspace).toBe(before.focusRestorationByWorkspace);
    expect(after.browserPaneIdByWorkspace[key]).toBeUndefined();
  });

  test("implicit background creation skips a remembered visible launcher and reuses one hidden browser-only pane", () => {
    const key = seedWorkspace("server-1", "launcher-workspace");
    const store = useWorkspaceLayoutStore.getState();
    const visiblePaneId = store.ensureBrowserPane(key, { reveal: true })!;
    const visibleLauncher = findPaneById(
      useWorkspaceLayoutStore.getState().layoutByWorkspace[key].root,
      visiblePaneId,
    )!;
    store.focusTab(key, visibleLauncher.focusedTabId!);
    store.unfocusPane(key);
    const before = useWorkspaceLayoutStore.getState();
    const first = openWorkspaceBrowser({ workspaceKey: key, intent: "background" });
    const second = openWorkspaceBrowser({ workspaceKey: key, intent: "background" });
    if (!first.ok || !second.ok) throw new Error("Expected background pages");
    const after = useWorkspaceLayoutStore.getState();
    const layout = after.layoutByWorkspace[key];
    expect(findPaneById(layout.root, visiblePaneId)).toEqual(visibleLauncher);
    expect(layout.focusedPaneId).toBe(before.layoutByWorkspace[key].focusedPaneId);
    expect(after.focusRestorationByWorkspace).toBe(before.focusRestorationByWorkspace);
    const browserPane = findPaneContainingTab(layout.root, first.tabId)!;
    expect(browserPane.id).not.toBe(visiblePaneId);
    expect(browserPane.hidden).toBe(true);
    expect(browserPane.tabIds).toEqual([first.tabId, second.tabId]);
    expect(
      collectAllTabs({ kind: "pane", pane: browserPane }).map((tab) => tab.target.kind),
    ).toEqual(["browser", "browser"]);
    expect(browserPane.focusedTabId).toBe(first.tabId);
    expect(after.browserPaneIdByWorkspace[key]).toBe(browserPane.id);
  });

  test("implicit background creation reuses a remembered hidden launcher without revealing it", () => {
    const key = seedWorkspace("server-1", "launcher-workspace");
    const store = useWorkspaceLayoutStore.getState();
    const hiddenPaneId = store.ensureBrowserPane(key, { reveal: false })!;
    const before = useWorkspaceLayoutStore.getState();
    const first = openWorkspaceBrowser({ workspaceKey: key, intent: "background" });
    const second = openWorkspaceBrowser({ workspaceKey: key, intent: "background" });
    if (!first.ok || !second.ok) throw new Error("Expected background pages");
    const after = useWorkspaceLayoutStore.getState();
    const layout = after.layoutByWorkspace[key];
    const pane = findPaneById(layout.root, hiddenPaneId)!;
    expect(pane.hidden).toBe(true);
    expect(pane.tabIds).toEqual([first.tabId, second.tabId]);
    expect(collectAllTabs({ kind: "pane", pane: pane }).map((tab) => tab.target.kind)).toEqual([
      "browser",
      "browser",
    ]);
    expect(pane.focusedTabId).toBe(first.tabId);
    expect(layout.focusedPaneId).toBe(before.layoutByWorkspace[key].focusedPaneId);
    expect(after.focusRestorationByWorkspace).toBe(before.focusRestorationByWorkspace);
    expect(after.browserPaneIdByWorkspace[key]).toBe(hiddenPaneId);
  });
});
