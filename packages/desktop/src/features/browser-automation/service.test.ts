import { resolve as resolvePath } from "node:path";

import { describe, expect, test, vi } from "vitest";
import type {
  BrowserAutomationCommand,
  BrowserAutomationConsoleLogEntry,
  BrowserAutomationCookieEntry,
  BrowserAutomationExecuteRequest,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { BrowserSnapshotEngine } from "./snapshot-engine.js";
import type { BrowserRegistry, TabContents, TabImage } from "./service.js";
import { executeAutomationCommand } from "./service.js";

const BROWSER_A = "11111111-1111-4111-8111-111111111111";
const BROWSER_B = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_A = "workspace-a";
const WORKSPACE_B = "workspace-b";

class FakeImage implements TabImage {
  public constructor(
    private readonly bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]),
    private readonly size = { width: 640, height: 480 },
  ) {}

  public toPNG(): Uint8Array {
    return this.bytes;
  }

  public getSize(): { width: number; height: number } {
    return this.size;
  }
}

class FakeTab implements TabContents {
  public readonly loadedUrls: string[] = [];
  public readonly scripts: string[] = [];
  public readonly actions: string[] = [];
  public readonly capturedViewports: Array<{ stayHidden?: boolean }> = [];
  public readonly debugCommands: Array<{ command: string; params?: Record<string, unknown> }> = [];
  public readonly pdfOptions: Record<string, unknown>[] = [];
  public readonly downloads: Array<{ url: string; fileName?: string }> = [];

  public destroyed = false;
  public bodyText = "";
  public snapshotElements: unknown[] = [];
  public actionScriptResult: unknown = true;
  public networkEntries: unknown[] = [];
  public storageState: unknown = { localStorage: [], sessionStorage: [] };
  public viewport = { width: 1024, height: 768, deviceScaleFactor: 2 };
  public consoleMessages: BrowserAutomationConsoleLogEntry[] = [];
  public cookies: BrowserAutomationCookieEntry[] = [];
  public captureNeverPaints = false;
  public pdfBytes = new Uint8Array([37, 80, 68, 70]);
  public downloadResult = {
    filePath: "/workspace/downloads/file.txt",
    totalBytes: 42,
    state: "completed",
  };
  public layoutMetrics = {
    cssLayoutViewport: { clientWidth: 390, clientHeight: 844 },
    cssContentSize: { width: 390, height: 1200 },
  };
  public fullPageScreenshotData = "fullPagePng";
  public documentNodeId = 1;
  public queriedNodeId = 2;
  public backgroundThrottlingAllowed = true;

  public constructor(
    public readonly id: number,
    private readonly initialUrl: string,
    private readonly title: string,
  ) {}

  public getURL(): string {
    return this.loadedUrls.at(-1) ?? this.initialUrl;
  }

  public getTitle(): string {
    return this.title;
  }

  public canGoBack(): boolean {
    return true;
  }

  public canGoForward(): boolean {
    return false;
  }

  public isLoading(): boolean {
    return false;
  }

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public async executeJavaScript(code: string): Promise<unknown> {
    this.scripts.push(code);
    if (code.includes("document.body.innerText")) {
      return this.bodyText;
    }
    if (code.includes("CANDIDATE_SELECTOR")) {
      return JSON.stringify(this.snapshotElements);
    }
    if (code.includes("performance.getEntriesByType")) {
      return JSON.stringify(this.networkEntries);
    }
    if (code.includes("localStorage") && code.includes("sessionStorage")) {
      return JSON.stringify(this.storageState);
    }
    if (code.includes("window.innerWidth")) {
      return JSON.stringify(this.viewport);
    }
    return this.actionScriptResult;
  }

  public async loadURL(url: string): Promise<void> {
    this.loadedUrls.push(url);
  }

  public goBack(): void {
    this.actions.push("back");
  }

  public goForward(): void {
    this.actions.push("forward");
  }

  public reload(): void {
    this.actions.push("reload");
  }

  public async capturePage(options?: { stayHidden?: boolean }): Promise<TabImage> {
    this.capturedViewports.push(options ?? {});
    this.actions.push("capture");
    if (this.captureNeverPaints) {
      return new Promise<never>(() => {});
    }
    return new FakeImage();
  }

  public invalidate(): void {
    this.actions.push("invalidate");
  }

  public isBackgroundThrottlingAllowed(): boolean {
    return this.backgroundThrottlingAllowed;
  }

  public setBackgroundThrottling(allowed: boolean): void {
    this.backgroundThrottlingAllowed = allowed;
    this.actions.push(`background:${allowed}`);
  }

  public getConsoleMessages(): BrowserAutomationConsoleLogEntry[] {
    return this.consoleMessages;
  }

  public async getCookies(_url: string): Promise<BrowserAutomationCookieEntry[]> {
    return this.cookies;
  }

  public async sendDebugCommand(
    command: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    this.debugCommands.push({ command, ...(params ? { params } : {}) });
    if (command === "Page.getLayoutMetrics") {
      return this.layoutMetrics;
    }
    if (command === "Page.captureScreenshot") {
      return { data: this.fullPageScreenshotData };
    }
    if (command === "DOM.getDocument") {
      return { root: { nodeId: this.documentNodeId } };
    }
    if (command === "DOM.querySelector") {
      return { nodeId: this.queriedNodeId };
    }
    return {};
  }

  public async printToPDF(options?: Record<string, unknown>): Promise<Uint8Array> {
    this.pdfOptions.push(options ?? {});
    return this.pdfBytes;
  }

  public async downloadURL(input: { url: string; fileName?: string }): Promise<{
    filePath: string;
    totalBytes?: number;
    state: string;
  }> {
    this.downloads.push(input);
    return this.downloadResult;
  }
}

class FakeRegistry implements BrowserRegistry {
  private readonly tabs = new Map<string, { workspaceId: string; tab: FakeTab }>();
  private readonly activeBrowserIdsByWorkspace = new Map<string, string>();

  public register(browserId: string, workspaceId: string, tab: FakeTab): void {
    this.tabs.set(browserId, { workspaceId, tab });
  }

  public setActiveBrowser(workspaceId: string, browserId: string): void {
    this.activeBrowserIdsByWorkspace.set(workspaceId, browserId);
  }

  public listRegisteredBrowserIds(): string[] {
    return Array.from(this.tabs.keys());
  }

  public listRegisteredBrowserIdsForWorkspace(workspaceId: string): string[] {
    return Array.from(this.tabs.entries())
      .filter((entry) => entry[1].workspaceId === workspaceId)
      .map((entry) => entry[0]);
  }

  public getTabContents(browserId: string): TabContents | null {
    return this.tabs.get(browserId)?.tab ?? null;
  }

  public getBrowserWorkspaceId(browserId: string): string | null {
    return this.tabs.get(browserId)?.workspaceId ?? null;
  }

  public getWorkspaceActiveBrowserId(workspaceId: string): string | null {
    return this.activeBrowserIdsByWorkspace.get(workspaceId) ?? null;
  }
}

class BrowserAutomationHarness {
  public readonly registry = new FakeRegistry();
  public readonly snapshotEngine = new BrowserSnapshotEngine();
  public readonly tab = new FakeTab(1, "https://a.test/form", "Fixture");

  public constructor() {
    this.registry.register(BROWSER_A, WORKSPACE_A, this.tab);
    this.registry.setActiveBrowser(WORKSPACE_A, BROWSER_A);
  }

  public async execute(
    command: BrowserAutomationCommand,
    input: { requestId?: string; workspaceId?: string; cwd?: string } = {},
  ) {
    return executeAutomationCommand(automationRequest(command, input), this.registry, {
      snapshotEngine: this.snapshotEngine,
    });
  }

  public async snapshot() {
    return this.execute({
      command: "snapshot",
      args: { browserId: BROWSER_A },
    });
  }
}

function automationRequest(
  command: BrowserAutomationCommand,
  input: { requestId?: string; workspaceId?: string; cwd?: string } = {},
): BrowserAutomationExecuteRequest {
  const workspaceFields: { workspaceId?: string } = {};
  if (input.workspaceId === undefined) {
    workspaceFields.workspaceId = WORKSPACE_A;
  } else if (input.workspaceId) {
    workspaceFields.workspaceId = input.workspaceId;
  }
  return {
    type: "browser.automation.execute.request",
    requestId: input.requestId ?? `req-${command.command}`,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...workspaceFields,
    command,
  };
}

function formElements() {
  return [
    {
      role: "textbox",
      tagName: "input",
      text: "Name",
      selector: "#name",
      attributes: { id: "name", type: "text" },
    },
    {
      role: "checkbox",
      tagName: "input",
      text: "Agree",
      selector: "#agree",
      attributes: { id: "agree", type: "checkbox" },
    },
    {
      role: "combobox",
      tagName: "select",
      text: "Country",
      selector: "#country",
      attributes: { id: "country" },
    },
    {
      role: "button",
      tagName: "button",
      text: "Source",
      selector: "#source",
      attributes: { id: "source" },
    },
    {
      role: "button",
      tagName: "button",
      text: "Target",
      selector: "#target",
      attributes: { id: "target" },
    },
  ];
}

function containsScript(tab: FakeTab, ...parts: string[]): boolean {
  return tab.scripts.some((script) => parts.every((part) => script.includes(part)));
}

function requireSnapshotRefs(result: Awaited<ReturnType<BrowserAutomationHarness["snapshot"]>>) {
  expect(result).toEqual({
    requestId: "req-snapshot",
    ok: true,
    result: {
      command: "snapshot",
      browserId: BROWSER_A,
      workspaceId: WORKSPACE_A,
      url: "https://a.test/form",
      title: "Fixture",
      elements: [
        {
          ref: "@e1",
          role: "textbox",
          tagName: "input",
          text: "Name",
          selector: "#name",
          attributes: { id: "name", type: "text" },
        },
        {
          ref: "@e2",
          role: "checkbox",
          tagName: "input",
          text: "Agree",
          selector: "#agree",
          attributes: { id: "agree", type: "checkbox" },
        },
        {
          ref: "@e3",
          role: "combobox",
          tagName: "select",
          text: "Country",
          selector: "#country",
          attributes: { id: "country" },
        },
        {
          ref: "@e4",
          role: "button",
          tagName: "button",
          text: "Source",
          selector: "#source",
          attributes: { id: "source" },
        },
        {
          ref: "@e5",
          role: "button",
          tagName: "button",
          text: "Target",
          selector: "#target",
          attributes: { id: "target" },
        },
      ],
    },
  });
}

describe("executeAutomationCommand", () => {
  test("list tabs without a workspace reports every live registered tab", () => {
    const registry = new FakeRegistry();
    registry.register(BROWSER_A, WORKSPACE_A, new FakeTab(1, "https://a.test", "A"));
    registry.register(BROWSER_B, WORKSPACE_B, new FakeTab(2, "https://b.test", "B"));

    const result = executeAutomationCommand(
      automationRequest(
        { command: "list_tabs", args: {} },
        { requestId: "req-list", workspaceId: "" },
      ),
      registry,
    );

    expect(result).toEqual({
      requestId: "req-list",
      ok: true,
      result: {
        command: "list_tabs",
        tabs: [
          {
            browserId: BROWSER_A,
            workspaceId: WORKSPACE_A,
            url: "https://a.test",
            title: "A",
            isActive: false,
            isLoading: false,
            canGoBack: true,
            canGoForward: false,
          },
          {
            browserId: BROWSER_B,
            workspaceId: WORKSPACE_B,
            url: "https://b.test",
            title: "B",
            isActive: false,
            isLoading: false,
            canGoBack: true,
            canGoForward: false,
          },
        ],
      },
    });
  });

  test("list tabs filters destroyed tabs out of the visible tab list", () => {
    const liveTab = new FakeTab(1, "https://a.test", "A");
    const destroyedTab = new FakeTab(2, "https://dead.test", "Dead");
    destroyedTab.destroyed = true;
    const registry = new FakeRegistry();
    registry.register(BROWSER_A, WORKSPACE_A, liveTab);
    registry.register(BROWSER_B, WORKSPACE_A, destroyedTab);
    registry.setActiveBrowser(WORKSPACE_A, BROWSER_A);

    const result = executeAutomationCommand(
      automationRequest({ command: "list_tabs", args: {} }, { requestId: "req-live" }),
      registry,
    );

    expect(result).toEqual({
      requestId: "req-live",
      ok: true,
      result: {
        command: "list_tabs",
        tabs: [
          {
            browserId: BROWSER_A,
            workspaceId: WORKSPACE_A,
            url: "https://a.test",
            title: "A",
            isActive: true,
            isLoading: false,
            canGoBack: true,
            canGoForward: false,
          },
        ],
      },
    });
  });

  test("list tabs returns an empty list when the workspace has no registered tabs", () => {
    const result = executeAutomationCommand(
      automationRequest({ command: "list_tabs", args: {} }, { requestId: "req-empty" }),
      new FakeRegistry(),
    );

    expect(result).toEqual({
      requestId: "req-empty",
      ok: true,
      result: { command: "list_tabs", tabs: [] },
    });
  });

  test("page info reads the explicit browser id from command args", () => {
    const browser = new BrowserAutomationHarness();

    const result = executeAutomationCommand(
      automationRequest(
        { command: "page_info", args: { browserId: BROWSER_A } },
        { requestId: "req-page" },
      ),
      browser.registry,
    );

    expect(result).toEqual({
      requestId: "req-page",
      ok: true,
      result: {
        command: "page_info",
        tab: {
          browserId: BROWSER_A,
          workspaceId: WORKSPACE_A,
          url: "https://a.test/form",
          title: "Fixture",
          isActive: true,
          isLoading: false,
          canGoBack: true,
          canGoForward: false,
        },
      },
    });
  });

  test("page info returns tab not found for an id in another workspace", () => {
    const registry = new FakeRegistry();
    registry.register(BROWSER_A, WORKSPACE_B, new FakeTab(1, "https://a.test", "A"));

    const result = executeAutomationCommand(
      automationRequest(
        { command: "page_info", args: { browserId: BROWSER_A } },
        { requestId: "req-page" },
      ),
      registry,
    );

    expect(result).toEqual({
      requestId: "req-page",
      ok: false,
      error: {
        code: "browser_tab_not_found",
        message: `No browser tab found for ID: ${BROWSER_A}`,
        retryable: false,
      },
    });
  });

  test("page info returns tab closed for a destroyed explicit tab", () => {
    const tab = new FakeTab(1, "https://a.test", "A");
    tab.destroyed = true;
    const registry = new FakeRegistry();
    registry.register(BROWSER_A, WORKSPACE_A, tab);

    const result = executeAutomationCommand(
      automationRequest(
        { command: "page_info", args: { browserId: BROWSER_A } },
        { requestId: "req-page" },
      ),
      registry,
    );

    expect(result).toEqual({
      requestId: "req-page",
      ok: false,
      error: {
        code: "browser_tab_closed",
        message: `Browser tab ${BROWSER_A} has been closed`,
        retryable: false,
      },
    });
  });

  test("snapshot and click use refs from the same explicit tab", async () => {
    const browser = new BrowserAutomationHarness();
    browser.tab.snapshotElements = [
      {
        role: "button",
        tagName: "button",
        text: "Submit",
        selector: "#submit",
        attributes: { id: "submit" },
      },
    ];

    const snapshot = await browser.snapshot();
    const click = await browser.execute({
      command: "click",
      args: { browserId: BROWSER_A, ref: "@e1" },
    });

    expect(snapshot).toEqual({
      requestId: "req-snapshot",
      ok: true,
      result: {
        command: "snapshot",
        browserId: BROWSER_A,
        workspaceId: WORKSPACE_A,
        url: "https://a.test/form",
        title: "Fixture",
        elements: [
          {
            ref: "@e1",
            role: "button",
            tagName: "button",
            text: "Submit",
            selector: "#submit",
            attributes: { id: "submit" },
          },
        ],
      },
    });
    expect(click).toEqual({
      requestId: "req-click",
      ok: true,
      result: { command: "click", browserId: BROWSER_A, ref: "@e1" },
    });
    expect(containsScript(browser.tab, "#submit", ".click()")).toBe(true);
  });

  test("set background writes the requested color into the explicit page", async () => {
    const browser = new BrowserAutomationHarness();

    const result = await browser.execute({
      command: "set_background",
      args: { browserId: BROWSER_A, color: "red" },
    });

    expect(result).toEqual({
      requestId: "req-set_background",
      ok: true,
      result: { command: "set_background", browserId: BROWSER_A, color: "red" },
    });
    expect(containsScript(browser.tab, "document.body.style.background", "red")).toBe(true);
  });

  test.each([
    {
      name: "fill updates a ref from the latest snapshot",
      command: { command: "fill", args: { browserId: BROWSER_A, ref: "@e1", value: "Ada" } },
      result: { command: "fill", browserId: BROWSER_A, ref: "@e1" },
      scriptParts: ["#name", "Ada"],
    },
    {
      name: "focus focuses a ref from the latest snapshot",
      command: { command: "focus", args: { browserId: BROWSER_A, ref: "@e1" } },
      result: { command: "focus", browserId: BROWSER_A, ref: "@e1" },
      scriptParts: ["#name", "focus"],
    },
    {
      name: "clear clears a ref from the latest snapshot",
      command: { command: "clear", args: { browserId: BROWSER_A, ref: "@e1" } },
      result: { command: "clear", browserId: BROWSER_A, ref: "@e1" },
      scriptParts: ["#name", "deleteContent"],
    },
    {
      name: "check sets the requested checked state on a ref",
      command: { command: "check", args: { browserId: BROWSER_A, ref: "@e2", checked: false } },
      result: { command: "check", browserId: BROWSER_A, ref: "@e2", checked: false },
      scriptParts: ["#agree", "nextChecked = false"],
    },
    {
      name: "select sets the requested value on a ref",
      command: { command: "select", args: { browserId: BROWSER_A, ref: "@e3", value: "us" } },
      result: { command: "select", browserId: BROWSER_A, ref: "@e3", value: "us" },
      scriptParts: ["#country", "us"],
    },
    {
      name: "hover dispatches hover events to a ref",
      command: { command: "hover", args: { browserId: BROWSER_A, ref: "@e4" } },
      result: { command: "hover", browserId: BROWSER_A, ref: "@e4" },
      scriptParts: ["#source", "mouseover"],
    },
    {
      name: "drag dispatches drag events between refs",
      command: {
        command: "drag",
        args: { browserId: BROWSER_A, sourceRef: "@e4", targetRef: "@e5" },
      },
      result: { command: "drag", browserId: BROWSER_A, sourceRef: "@e4", targetRef: "@e5" },
      scriptParts: ["#source", "#target", "dragstart"],
    },
  ] as const)("$name", async ({ command, result, scriptParts }) => {
    const browser = new BrowserAutomationHarness();
    browser.tab.snapshotElements = formElements();

    requireSnapshotRefs(await browser.snapshot());
    const action = await browser.execute(command);

    expect(action).toEqual({
      requestId: `req-${command.command}`,
      ok: true,
      result,
    });
    expect(containsScript(browser.tab, ...scriptParts)).toBe(true);
  });

  test("refs become stale after navigation changes the tab URL", async () => {
    const browser = new BrowserAutomationHarness();
    browser.tab.snapshotElements = formElements();

    requireSnapshotRefs(await browser.snapshot());
    await browser.execute({
      command: "navigate",
      args: { browserId: BROWSER_A, url: "https://a.test/next" },
    });
    const click = await browser.execute({
      command: "click",
      args: { browserId: BROWSER_A, ref: "@e1" },
    });

    expect(click).toEqual({
      requestId: "req-click",
      ok: false,
      error: {
        code: "browser_stale_ref",
        message: "Browser element reference @e1 is stale. Take a new snapshot and try again.",
        retryable: false,
      },
    });
  });

  test("refs become stale when the same URL no longer contains the element", async () => {
    const browser = new BrowserAutomationHarness();
    browser.tab.snapshotElements = formElements();

    requireSnapshotRefs(await browser.snapshot());
    browser.tab.actionScriptResult = false;
    const fill = await browser.execute({
      command: "fill",
      args: { browserId: BROWSER_A, ref: "@e1", value: "Ada" },
    });

    expect(fill).toEqual({
      requestId: "req-fill",
      ok: false,
      error: {
        code: "browser_stale_ref",
        message: "Browser element reference @e1 is stale. Take a new snapshot and try again.",
        retryable: false,
      },
    });
  });

  test("wait resolves when the explicit tab contains the requested text", async () => {
    const browser = new BrowserAutomationHarness();
    browser.tab.bodyText = "Ready";

    const result = await browser.execute({
      command: "wait",
      args: { browserId: BROWSER_A, text: "Ready", timeoutMs: 100 },
    });

    expect(result).toEqual({
      requestId: "req-wait",
      ok: true,
      result: { command: "wait", browserId: BROWSER_A, matched: "text" },
    });
  });

  test("wait returns a retryable timeout when text never appears", async () => {
    const browser = new BrowserAutomationHarness();
    browser.tab.bodyText = "Still loading";

    const result = await browser.execute({
      command: "wait",
      args: { browserId: BROWSER_A, text: "Ready", timeoutMs: 1 },
    });

    expect(result).toEqual({
      requestId: "req-wait",
      ok: false,
      error: {
        code: "browser_timeout",
        message: "Timed out waiting for browser text: Ready",
        retryable: true,
      },
    });
  });

  test.each([
    {
      name: "type writes text into a ref",
      command: { command: "type", args: { browserId: BROWSER_A, ref: "@e1", text: "Ada" } },
      result: { command: "type", browserId: BROWSER_A, ref: "@e1" },
      scriptParts: ["#name", "Ada"],
      needsSnapshot: true,
    },
    {
      name: "keypress dispatches a key to the focused element when ref is omitted",
      command: { command: "keypress", args: { browserId: BROWSER_A, key: "Enter" } },
      result: { command: "keypress", browserId: BROWSER_A, key: "Enter" },
      scriptParts: ["document.activeElement", "Enter"],
      needsSnapshot: false,
    },
  ] as const)("$name", async ({ command, result, scriptParts, needsSnapshot }) => {
    const browser = new BrowserAutomationHarness();
    browser.tab.snapshotElements = formElements();
    if (needsSnapshot) {
      requireSnapshotRefs(await browser.snapshot());
    }

    const action = await browser.execute(command);

    expect(action).toEqual({
      requestId: `req-${command.command}`,
      ok: true,
      result,
    });
    expect(containsScript(browser.tab, ...scriptParts)).toBe(true);
  });

  test("navigate loads the requested HTTP URL in the explicit tab", async () => {
    const browser = new BrowserAutomationHarness();

    const result = await browser.execute({
      command: "navigate",
      args: { browserId: BROWSER_A, url: "https://example.com/next" },
    });

    expect(result).toEqual({
      requestId: "req-navigate",
      ok: true,
      result: { command: "navigate", browserId: BROWSER_A, url: "https://example.com/next" },
    });
    expect(browser.tab.loadedUrls).toEqual(["https://example.com/next"]);
  });

  test("navigate denies non-http URLs before loading the explicit tab", async () => {
    const browser = new BrowserAutomationHarness();

    const result = await browser.execute({
      command: "navigate",
      args: { browserId: BROWSER_A, url: "file:///tmp/secret.txt" },
    });

    expect(result).toEqual({
      requestId: "req-navigate",
      ok: false,
      error: {
        code: "browser_denied",
        message: "Browser navigation only supports http and https URLs.",
        retryable: false,
      },
    });
    expect(browser.tab.loadedUrls).toEqual([]);
  });

  test("navigation actions dispatch to the explicit tab", () => {
    const browser = new BrowserAutomationHarness();

    const back = executeAutomationCommand(
      automationRequest(
        { command: "back", args: { browserId: BROWSER_A } },
        { requestId: "req-back" },
      ),
      browser.registry,
    );
    const forward = executeAutomationCommand(
      automationRequest(
        { command: "forward", args: { browserId: BROWSER_A } },
        { requestId: "req-forward" },
      ),
      browser.registry,
    );
    const reload = executeAutomationCommand(
      automationRequest(
        { command: "reload", args: { browserId: BROWSER_A } },
        { requestId: "req-reload" },
      ),
      browser.registry,
    );

    expect(back).toEqual({
      requestId: "req-back",
      ok: true,
      result: { command: "back", browserId: BROWSER_A },
    });
    expect(forward).toEqual({
      requestId: "req-forward",
      ok: true,
      result: { command: "forward", browserId: BROWSER_A },
    });
    expect(reload).toEqual({
      requestId: "req-reload",
      ok: true,
      result: { command: "reload", browserId: BROWSER_A },
    });
    expect(browser.tab.actions).toEqual(["back", "forward", "reload"]);
  });

  test("logs returns bounded console messages and network entries from the explicit tab", async () => {
    const browser = new BrowserAutomationHarness();
    browser.tab.consoleMessages = [
      { level: "debug", message: "boot", timestamp: 1 },
      { level: "info", message: "ready", source: "console", line: 3, timestamp: 2 },
    ];
    browser.tab.networkEntries = [
      { url: "https://a.test/ignored", startTime: 1, duration: 2 },
      {
        url: "https://a.test/app.js",
        method: "GET",
        status: 200,
        type: "script",
        startTime: 3,
        duration: 4,
        transferSize: 123,
      },
    ];

    const result = await browser.execute({
      command: "logs",
      args: { browserId: BROWSER_A, maxEntries: 1 },
    });

    expect(result).toEqual({
      requestId: "req-logs",
      ok: true,
      result: {
        command: "logs",
        browserId: BROWSER_A,
        console: [{ level: "info", message: "ready", source: "console", line: 3, timestamp: 2 }],
        network: [
          {
            url: "https://a.test/app.js",
            method: "GET",
            status: 200,
            type: "script",
            startTime: 3,
            duration: 4,
            transferSize: 123,
          },
        ],
      },
    });
  });

  test("storage reads cookies and web storage from the explicit tab", async () => {
    const browser = new BrowserAutomationHarness();
    browser.tab.cookies = [
      { name: "theme", value: "dark", domain: "a.test", path: "/", secure: true },
    ];
    browser.tab.storageState = {
      localStorage: [{ key: "token", value: "abc" }],
      sessionStorage: [{ key: "tab", value: "1" }],
    };

    const result = await browser.execute({
      command: "storage",
      args: { browserId: BROWSER_A },
    });

    expect(result).toEqual({
      requestId: "req-storage",
      ok: true,
      result: {
        command: "storage",
        browserId: BROWSER_A,
        url: "https://a.test/form",
        cookies: [{ name: "theme", value: "dark", domain: "a.test", path: "/", secure: true }],
        localStorage: [{ key: "token", value: "abc" }],
        sessionStorage: [{ key: "tab", value: "1" }],
      },
    });
  });

  test("environment applies viewport and geolocation before reporting the current viewport", async () => {
    const browser = new BrowserAutomationHarness();
    browser.tab.viewport = { width: 390, height: 844, deviceScaleFactor: 3 };

    const result = await browser.execute({
      command: "environment",
      args: {
        browserId: BROWSER_A,
        viewport: { width: 390, height: 844, deviceScaleFactor: 3 },
        geolocation: { latitude: 37.7749, longitude: -122.4194, accuracy: 5 },
      },
    });

    expect(result).toEqual({
      requestId: "req-environment",
      ok: true,
      result: {
        command: "environment",
        browserId: BROWSER_A,
        viewport: { width: 390, height: 844, deviceScaleFactor: 3 },
        geolocation: { latitude: 37.7749, longitude: -122.4194, accuracy: 5 },
      },
    });
    expect(browser.tab.debugCommands).toEqual([
      {
        command: "Emulation.setDeviceMetricsOverride",
        params: { width: 390, height: 844, deviceScaleFactor: 3, mobile: false },
      },
      {
        command: "Emulation.setGeolocationOverride",
        params: { latitude: 37.7749, longitude: -122.4194, accuracy: 5 },
      },
    ]);
    expect(containsScript(browser.tab, "navigator", "geolocation")).toBe(true);
  });

  test("screenshot serializes the painted viewport and restores throttling", async () => {
    const browser = new BrowserAutomationHarness();

    const result = await browser.execute({
      command: "screenshot",
      args: { browserId: BROWSER_A },
    });

    expect(result).toEqual({
      requestId: "req-screenshot",
      ok: true,
      result: {
        command: "screenshot",
        browserId: BROWSER_A,
        mimeType: "image/png",
        dataBase64: "iVBORwECAw==",
        width: 640,
        height: 480,
      },
    });
    expect(browser.tab.capturedViewports).toEqual([{ stayHidden: false }]);
    expect(browser.tab.actions).toEqual([
      "background:false",
      "invalidate",
      "capture",
      "background:true",
    ]);
  });

  test("screenshot returns no-frame when the viewport never paints", async () => {
    vi.useFakeTimers();
    try {
      const browser = new BrowserAutomationHarness();
      browser.tab.captureNeverPaints = true;

      const resultPromise = browser.execute({
        command: "screenshot",
        args: { browserId: BROWSER_A },
      });
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(resultPromise).resolves.toEqual({
        requestId: "req-screenshot",
        ok: false,
        error: {
          code: "screenshot_no_frame",
          message:
            "The browser tab has no painted frame. Focus the tab in the app, then try again.",
          retryable: false,
        },
      });
      expect(browser.tab.actions).toEqual([
        "background:false",
        "invalidate",
        "capture",
        "background:true",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("full page screenshot captures the page content area through CDP", async () => {
    const browser = new BrowserAutomationHarness();

    const result = await browser.execute({
      command: "full_page_screenshot",
      args: { browserId: BROWSER_A },
    });

    expect(result).toEqual({
      requestId: "req-full_page_screenshot",
      ok: true,
      result: {
        command: "full_page_screenshot",
        browserId: BROWSER_A,
        mimeType: "image/png",
        dataBase64: "fullPagePng",
        width: 390,
        height: 1200,
      },
    });
    expect(browser.tab.debugCommands).toEqual([
      { command: "Page.getLayoutMetrics" },
      {
        command: "Page.captureScreenshot",
        params: {
          format: "png",
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: 390, height: 1200, scale: 1 },
        },
      },
    ]);
  });

  test("pdf exports the explicit tab with requested print options", async () => {
    const browser = new BrowserAutomationHarness();

    const result = await browser.execute({
      command: "pdf",
      args: { browserId: BROWSER_A, landscape: true, printBackground: false },
    });

    expect(result).toEqual({
      requestId: "req-pdf",
      ok: true,
      result: {
        command: "pdf",
        browserId: BROWSER_A,
        mimeType: "application/pdf",
        dataBase64: "JVBERg==",
      },
    });
    expect(browser.tab.pdfOptions).toEqual([{ printBackground: false, landscape: true }]);
  });

  test("download saves the requested HTTP URL through the explicit tab", async () => {
    const browser = new BrowserAutomationHarness();

    const result = await browser.execute({
      command: "download",
      args: {
        browserId: BROWSER_A,
        url: "https://a.test/file.txt",
        fileName: "file.txt",
      },
    });

    expect(result).toEqual({
      requestId: "req-download",
      ok: true,
      result: {
        command: "download",
        browserId: BROWSER_A,
        url: "https://a.test/file.txt",
        filePath: "/workspace/downloads/file.txt",
        totalBytes: 42,
        state: "completed",
      },
    });
    expect(browser.tab.downloads).toEqual([
      { url: "https://a.test/file.txt", fileName: "file.txt" },
    ]);
  });

  test("upload resolves workspace files before setting them on the file input", async () => {
    const browser = new BrowserAutomationHarness();
    browser.tab.snapshotElements = [
      {
        role: "textbox",
        tagName: "input",
        text: "",
        selector: "#file",
        attributes: { id: "file", type: "file" },
      },
    ];
    const workspaceRoot = resolvePath("/workspace/project");

    await browser.snapshot();
    const result = await browser.execute(
      {
        command: "upload",
        args: { browserId: BROWSER_A, ref: "@e1", filePaths: ["uploads/a.txt"] },
      },
      { cwd: workspaceRoot },
    );

    expect(result).toEqual({
      requestId: "req-upload",
      ok: true,
      result: {
        command: "upload",
        browserId: BROWSER_A,
        ref: "@e1",
        filePaths: [resolvePath(workspaceRoot, "uploads/a.txt")],
      },
    });
    expect(browser.tab.debugCommands).toEqual([
      { command: "DOM.getDocument", params: { depth: -1, pierce: true } },
      { command: "DOM.querySelector", params: { nodeId: 1, selector: "#file" } },
      {
        command: "DOM.setFileInputFiles",
        params: { nodeId: 2, files: [resolvePath(workspaceRoot, "uploads/a.txt")] },
      },
    ]);
  });

  test("upload denies paths outside the agent workspace", async () => {
    const browser = new BrowserAutomationHarness();
    browser.tab.snapshotElements = [
      {
        role: "textbox",
        tagName: "input",
        text: "",
        selector: "#file",
        attributes: { id: "file", type: "file" },
      },
    ];
    const workspaceRoot = resolvePath("/workspace/project");

    await browser.snapshot();
    const result = await browser.execute(
      {
        command: "upload",
        args: { browserId: BROWSER_A, ref: "@e1", filePaths: ["../secret.txt"] },
      },
      { cwd: workspaceRoot },
    );

    expect(result).toEqual({
      requestId: "req-upload",
      ok: false,
      error: {
        code: "browser_unsupported",
        message: "browser_upload only accepts files inside the agent workspace.",
        retryable: false,
      },
    });
    expect(browser.tab.debugCommands).toEqual([
      { command: "DOM.getDocument", params: { depth: -1, pierce: true } },
      { command: "DOM.querySelector", params: { nodeId: 1, selector: "#file" } },
    ]);
  });

  test("upload reports missing cwd before setting files on the file input", async () => {
    const browser = new BrowserAutomationHarness();
    browser.tab.snapshotElements = [
      {
        role: "textbox",
        tagName: "input",
        text: "",
        selector: "#file",
        attributes: { id: "file", type: "file" },
      },
    ];

    await browser.snapshot();
    const result = await browser.execute({
      command: "upload",
      args: { browserId: BROWSER_A, ref: "@e1", filePaths: ["uploads/a.txt"] },
    });

    expect(result).toEqual({
      requestId: "req-upload",
      ok: false,
      error: {
        code: "browser_unsupported",
        message: "browser_upload requires request cwd",
        retryable: false,
      },
    });
    expect(browser.tab.debugCommands).toEqual([
      { command: "DOM.getDocument", params: { depth: -1, pierce: true } },
      { command: "DOM.querySelector", params: { nodeId: 1, selector: "#file" } },
    ]);
  });
});
