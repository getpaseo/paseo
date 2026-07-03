import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { BrowserToolsBroker, BrowserToolsExecuteInput } from "./broker.js";
import type { BrowserToolsResponsePayload } from "./errors.js";
import { registerBrowserTools, type RegisterBrowserToolsOptions } from "./tools.js";
import type {
  PaseoToolConfig,
  PaseoToolExecutionContext,
  PaseoToolResult,
} from "../agent/tools/types.js";

const BROWSER_ID = "11111111-1111-4111-8111-111111111111";
const BROWSER_ID_MESSAGE =
  "browserId must be a real id returned by browser_new_tab or browser_list_tabs";
const WAIT_CONDITION_MESSAGE = "browser_wait requires exactly one of text or url";
const HTTP_URL_MESSAGE = "URL must use http/https only";
const WORKSPACE_CONTEXT_MESSAGE =
  "This browser tool needs a workspace. Start the agent from a Paseo workspace before calling browser_new_tab or browser_list_tabs.";

interface RegisteredTool {
  config: PaseoToolConfig;
  handler: (args: unknown, context: PaseoToolExecutionContext) => Promise<PaseoToolResult>;
}

class FakeBrowserBroker {
  public readonly calls: BrowserToolsExecuteInput[] = [];

  public constructor(private response: BrowserToolsResponsePayload = listTabsPayload()) {}

  public setResponse(response: BrowserToolsResponsePayload): void {
    this.response = response;
  }

  public async execute(input: BrowserToolsExecuteInput): Promise<BrowserToolsResponsePayload> {
    this.calls.push(input);
    return this.response;
  }
}

class BrowserToolHarness {
  public readonly broker = new FakeBrowserBroker();
  private readonly tools = new Map<string, RegisteredTool>();

  public constructor(
    private readonly callerAgent: ReturnType<RegisterBrowserToolsOptions["resolveCallerAgent"]> = {
      id: "agent-1",
      cwd: "/repo",
      workspaceId: "wks_workspace_a",
    },
    private readonly callerAgentId: string | null = "agent-1",
  ) {
    registerBrowserTools({
      registerTool: (name, config, handler) => {
        this.tools.set(name, { config, handler });
      },
      broker: this.broker as Pick<BrowserToolsBroker, "execute">,
      ...(this.callerAgentId ? { callerAgentId: this.callerAgentId } : {}),
      resolveCallerAgent: () => this.callerAgent,
    });
  }

  public validate(name: string, input: unknown) {
    return schemaFor(this.get(name).config.inputSchema).safeParse(input);
  }

  public async execute(name: string, input: unknown): Promise<PaseoToolResult> {
    const parsed = schemaFor(this.get(name).config.inputSchema).parse(input);
    return this.get(name).handler(parsed, {});
  }

  public toolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  private get(name: string): RegisteredTool {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool not registered: ${name}`);
    }
    return tool;
  }
}

function schemaFor(inputSchema: PaseoToolConfig["inputSchema"]): z.ZodType {
  if (!inputSchema) {
    return z.object({}).passthrough();
  }
  if (typeof (inputSchema as { safeParse?: unknown }).safeParse === "function") {
    return inputSchema as z.ZodType;
  }
  return z.object(inputSchema as z.ZodRawShape).passthrough();
}

function listTabsPayload(): Extract<BrowserToolsResponsePayload, { ok: true }> {
  return {
    requestId: "req-list-tabs",
    ok: true,
    result: {
      command: "list_tabs",
      tabs: [
        {
          browserId: BROWSER_ID,
          url: "https://example.com",
          title: "Example",
          isActive: true,
          isLoading: false,
        },
      ],
    },
  };
}

function newTabPayload(): Extract<BrowserToolsResponsePayload, { ok: true }> {
  return {
    requestId: "req-new-tab",
    ok: true,
    result: {
      command: "new_tab",
      browserId: BROWSER_ID,
      workspaceId: "wks_workspace_a",
      url: "https://example.com",
    },
  };
}

function snapshotPayload(): Extract<BrowserToolsResponsePayload, { ok: true }> {
  return {
    requestId: "req-snapshot",
    ok: true,
    result: {
      command: "snapshot",
      browserId: BROWSER_ID,
      workspaceId: "wks_workspace_a",
      url: "https://example.com",
      title: "Example",
      elements: [],
    },
  };
}

function screenshotPayload(): Extract<BrowserToolsResponsePayload, { ok: true }> {
  return {
    requestId: "req-screenshot",
    ok: true,
    result: {
      command: "screenshot",
      browserId: BROWSER_ID,
      mimeType: "image/png",
      dataBase64: "iVBORw0KGgo=",
      width: 800,
      height: 600,
    },
  };
}

const routedToolCases = [
  {
    name: "click",
    toolName: "browser_click",
    input: { browserId: BROWSER_ID, ref: "@e2" },
    command: { command: "click", args: { browserId: BROWSER_ID, ref: "@e2" } },
    payload: {
      requestId: "req-click",
      ok: true,
      result: { command: "click", browserId: BROWSER_ID, ref: "@e2" },
    },
    content: [{ type: "text", text: "Clicked browser element @e2." }],
  },
  {
    name: "fill",
    toolName: "browser_fill",
    input: { browserId: BROWSER_ID, ref: "@e1", value: "Ada" },
    command: { command: "fill", args: { browserId: BROWSER_ID, ref: "@e1", value: "Ada" } },
    payload: {
      requestId: "req-fill",
      ok: true,
      result: { command: "fill", browserId: BROWSER_ID, ref: "@e1" },
    },
    content: [{ type: "text", text: "Filled browser element @e1." }],
  },
  {
    name: "type",
    toolName: "browser_type",
    input: { browserId: BROWSER_ID, ref: "@e1", text: "Ada" },
    command: { command: "type", args: { browserId: BROWSER_ID, ref: "@e1", text: "Ada" } },
    payload: {
      requestId: "req-type",
      ok: true,
      result: { command: "type", browserId: BROWSER_ID, ref: "@e1" },
    },
    content: [{ type: "text", text: "Typed into browser element @e1." }],
  },
  {
    name: "keypress",
    toolName: "browser_keypress",
    input: { browserId: BROWSER_ID, key: "Enter" },
    command: { command: "keypress", args: { browserId: BROWSER_ID, key: "Enter" } },
    payload: {
      requestId: "req-keypress",
      ok: true,
      result: { command: "keypress", browserId: BROWSER_ID, key: "Enter" },
    },
    content: [{ type: "text", text: "Pressed Enter in the browser." }],
  },
  {
    name: "back",
    toolName: "browser_back",
    input: { browserId: BROWSER_ID },
    command: { command: "back", args: { browserId: BROWSER_ID } },
    payload: {
      requestId: "req-back",
      ok: true,
      result: { command: "back", browserId: BROWSER_ID },
    },
    content: [{ type: "text", text: "Browser back complete." }],
  },
  {
    name: "screenshot",
    toolName: "browser_screenshot",
    input: { browserId: BROWSER_ID },
    command: { command: "screenshot", args: { browserId: BROWSER_ID, fullPage: false } },
    payload: screenshotPayload(),
    content: [
      { type: "text", text: "Captured browser screenshot (800x600)." },
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
    ],
    structuredResult: {
      command: "screenshot",
      browserId: BROWSER_ID,
      mimeType: "image/png",
      width: 800,
      height: 600,
    },
  },
  {
    name: "logs",
    toolName: "browser_logs",
    input: { browserId: BROWSER_ID },
    command: { command: "logs", args: { browserId: BROWSER_ID, maxEntries: 50 } },
    payload: {
      requestId: "req-logs",
      ok: true,
      result: {
        command: "logs",
        browserId: BROWSER_ID,
        console: [{ level: "info", message: "ready", timestamp: 10 }],
        network: [
          {
            url: "https://example.com/app.js",
            type: "script",
            startTime: 1,
            duration: 2,
          },
        ],
      },
    },
    content: [{ type: "text", text: "Read 1 console log and 1 network entry." }],
  },
  {
    name: "full page screenshot",
    toolName: "browser_screenshot",
    input: { browserId: BROWSER_ID, fullPage: true },
    command: { command: "screenshot", args: { browserId: BROWSER_ID, fullPage: true } },
    payload: {
      requestId: "req-full-page",
      ok: true,
      result: {
        command: "screenshot",
        browserId: BROWSER_ID,
        mimeType: "image/png",
        dataBase64: "iVBORw0KGgo=",
        width: 390,
        height: 1200,
      },
    },
    content: [
      { type: "text", text: "Captured browser screenshot (390x1200)." },
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
    ],
    structuredResult: {
      command: "screenshot",
      browserId: BROWSER_ID,
      mimeType: "image/png",
      width: 390,
      height: 1200,
    },
  },
  {
    name: "upload",
    toolName: "browser_upload",
    input: { browserId: BROWSER_ID, ref: "@e1", filePaths: ["/tmp/file.txt"] },
    command: {
      command: "upload",
      args: { browserId: BROWSER_ID, ref: "@e1", filePaths: ["/tmp/file.txt"] },
    },
    payload: {
      requestId: "req-upload",
      ok: true,
      result: {
        command: "upload",
        browserId: BROWSER_ID,
        ref: "@e1",
        filePaths: ["/tmp/file.txt"],
      },
    },
    content: [{ type: "text", text: "Uploaded 1 file to browser element @e1." }],
  },
  {
    name: "select",
    toolName: "browser_select",
    input: { browserId: BROWSER_ID, ref: "@e3", value: "us" },
    command: { command: "select", args: { browserId: BROWSER_ID, ref: "@e3", value: "us" } },
    payload: {
      requestId: "req-select",
      ok: true,
      result: { command: "select", browserId: BROWSER_ID, ref: "@e3", value: "us" },
    },
    content: [{ type: "text", text: "Selected us in browser element @e3." }],
  },
  {
    name: "hover",
    toolName: "browser_hover",
    input: { browserId: BROWSER_ID, ref: "@e4" },
    command: { command: "hover", args: { browserId: BROWSER_ID, ref: "@e4" } },
    payload: {
      requestId: "req-hover",
      ok: true,
      result: { command: "hover", browserId: BROWSER_ID, ref: "@e4" },
    },
    content: [{ type: "text", text: "Hovered browser element @e4." }],
  },
  {
    name: "drag",
    toolName: "browser_drag",
    input: { browserId: BROWSER_ID, sourceRef: "@e4", targetRef: "@e5" },
    command: {
      command: "drag",
      args: { browserId: BROWSER_ID, sourceRef: "@e4", targetRef: "@e5" },
    },
    payload: {
      requestId: "req-drag",
      ok: true,
      result: { command: "drag", browserId: BROWSER_ID, sourceRef: "@e4", targetRef: "@e5" },
    },
    content: [{ type: "text", text: "Dragged browser element @e4 to @e5." }],
  },
] satisfies Array<{
  name: string;
  toolName: string;
  input: Record<string, unknown>;
  command: BrowserToolsExecuteInput["command"];
  payload: Extract<BrowserToolsResponsePayload, { ok: true }>;
  content: PaseoToolResult["content"];
}>;

const brokerErrorCases = [
  {
    name: "disabled browser tools",
    toolName: "browser_list_tabs",
    input: {},
    payload: {
      requestId: "req-disabled",
      ok: false,
      error: {
        code: "browser_disabled",
        message: "Browser tools are disabled. Enable daemon.browserTools.enabled to use them.",
        retryable: false,
      },
    },
    content: [
      {
        type: "text",
        text: "Browser tools are disabled. Enable desktop browser tools on the host, then try again.",
      },
    ],
    context: { agentId: "agent-1", cwd: "/repo", workspaceId: "wks_workspace_a" },
  },
  {
    name: "typed timeout errors",
    toolName: "browser_snapshot",
    input: { browserId: BROWSER_ID },
    payload: {
      requestId: "req-timeout",
      ok: false,
      error: {
        code: "browser_timeout",
        message: "Browser automation timed out after 15000ms.",
        retryable: true,
      },
    },
    content: [
      {
        type: "text",
        text: "The browser did not respond before the timeout. Try again or check the desktop app.",
      },
    ],
    context: {
      agentId: "agent-1",
      cwd: "/repo",
      workspaceId: "wks_workspace_a",
      browserId: BROWSER_ID,
    },
  },
  {
    name: "screenshot no-frame errors",
    toolName: "browser_screenshot",
    input: { browserId: BROWSER_ID },
    payload: {
      requestId: "req-no-frame",
      ok: false,
      error: {
        code: "screenshot_no_frame",
        message: "The browser tab has no painted frame. Focus the tab in the app, then try again.",
        retryable: false,
      },
    },
    content: [
      {
        type: "text",
        text: "The browser tab has no painted frame. Focus the tab in the app, then try again.",
      },
    ],
    context: {
      agentId: "agent-1",
      cwd: "/repo",
      workspaceId: "wks_workspace_a",
      browserId: BROWSER_ID,
    },
  },
] satisfies Array<{
  name: string;
  toolName: string;
  input: Record<string, unknown>;
  payload: Extract<BrowserToolsResponsePayload, { ok: false }>;
  content: PaseoToolResult["content"];
  context: Record<string, unknown>;
}>;

describe("registerBrowserTools", () => {
  test("registers the kept browser automation tools only", () => {
    const harness = new BrowserToolHarness();

    expect(harness.toolNames()).toEqual([
      "browser_list_tabs",
      "browser_new_tab",
      "browser_snapshot",
      "browser_click",
      "browser_fill",
      "browser_wait",
      "browser_type",
      "browser_keypress",
      "browser_navigate",
      "browser_back",
      "browser_forward",
      "browser_reload",
      "browser_screenshot",
      "browser_upload",
      "browser_hover",
      "browser_select",
      "browser_drag",
      "browser_logs",
    ]);
  });

  test("list tabs sends workspace in the request envelope", async () => {
    const harness = new BrowserToolHarness();

    const response = await harness.execute("browser_list_tabs", {});

    expect(harness.broker.calls).toEqual([
      {
        agentId: "agent-1",
        cwd: "/repo",
        workspaceId: "wks_workspace_a",
        command: { command: "list_tabs", args: {} },
      },
    ]);
    expect(response.content).toEqual([
      {
        type: "text",
        text: `Found 1 Paseo browser tab. Use these browserId values for tab-scoped browser tools.\n- browserId=${BROWSER_ID} active title="Example" url=https://example.com`,
      },
    ]);
  });

  test("new tab sends workspace in the request envelope", async () => {
    const harness = new BrowserToolHarness();
    harness.broker.setResponse(newTabPayload());

    const response = await harness.execute("browser_new_tab", { url: "https://example.com" });

    expect(harness.broker.calls).toEqual([
      {
        agentId: "agent-1",
        cwd: "/repo",
        workspaceId: "wks_workspace_a",
        command: { command: "new_tab", args: { url: "https://example.com" } },
      },
    ]);
    expect(response.content).toEqual([
      {
        type: "text",
        text: `Created browser tab browserId=${BROWSER_ID} url=https://example.com. Use this browserId for tab-scoped browser tools.`,
      },
    ]);
  });

  test.each([
    {
      name: "navigate accepts localhost without a scheme as http",
      toolName: "browser_navigate",
      input: { browserId: BROWSER_ID, url: "localhost:3000" },
      expected: { browserId: BROWSER_ID, url: "http://localhost:3000" },
    },
    {
      name: "new tab accepts a domain path without a scheme as http",
      toolName: "browser_new_tab",
      input: { url: "example.com/x" },
      expected: { url: "http://example.com/x" },
    },
    {
      name: "navigate accepts a single-label host with a port as http",
      toolName: "browser_navigate",
      input: { browserId: BROWSER_ID, url: "devbox:8080" },
      expected: { browserId: BROWSER_ID, url: "http://devbox:8080" },
    },
    {
      name: "navigate accepts an IPv6 host with a port as http",
      toolName: "browser_navigate",
      input: { browserId: BROWSER_ID, url: "[::1]:5173" },
      expected: { browserId: BROWSER_ID, url: "http://[::1]:5173" },
    },
    {
      name: "navigate trims whitespace around a URL",
      toolName: "browser_navigate",
      input: { browserId: BROWSER_ID, url: "  https://example.com/x  " },
      expected: { browserId: BROWSER_ID, url: "https://example.com/x" },
    },
    {
      name: "navigate keeps https URLs unchanged",
      toolName: "browser_navigate",
      input: { browserId: BROWSER_ID, url: "https://example.com/x" },
      expected: { browserId: BROWSER_ID, url: "https://example.com/x" },
    },
  ])("$name", ({ toolName, input, expected }) => {
    const harness = new BrowserToolHarness();

    const parsed = harness.validate(toolName, input);

    expect(parsed).toEqual({ success: true, data: expected });
  });

  test.each([
    {
      name: "navigate rejects file URLs",
      toolName: "browser_navigate",
      input: { browserId: BROWSER_ID, url: "file:///tmp/index.html" },
    },
    {
      name: "new tab rejects file URLs",
      toolName: "browser_new_tab",
      input: { url: "file:///tmp/index.html" },
    },
    {
      name: "navigate rejects invalid ports",
      toolName: "browser_navigate",
      input: { browserId: BROWSER_ID, url: "devbox:99999" },
    },
    {
      name: "navigate rejects URLs with spaces",
      toolName: "browser_navigate",
      input: { browserId: BROWSER_ID, url: "dev box:8080" },
    },
  ])("$name", ({ toolName, input }) => {
    const harness = new BrowserToolHarness();

    const parsed = harness.validate(toolName, input);

    expect(parsed).toMatchObject({
      success: false,
      error: { issues: [expect.objectContaining({ message: HTTP_URL_MESSAGE })] },
    });
  });

  test("list tabs tells agents without a workspace how to proceed", async () => {
    const harness = new BrowserToolHarness({ id: "agent-1", cwd: "/repo" });

    const response = await harness.execute("browser_list_tabs", {});

    expect(harness.broker.calls).toEqual([]);
    expect(response.content).toEqual([{ type: "text", text: WORKSPACE_CONTEXT_MESSAGE }]);
    expect(response.structuredContent).toEqual({
      ok: false,
      error: {
        code: "browser_denied",
        message: WORKSPACE_CONTEXT_MESSAGE,
        retryable: false,
      },
      context: {
        agentId: "agent-1",
        cwd: "/repo",
      },
    });
  });

  test("new tab tells agents without a workspace how to proceed", async () => {
    const harness = new BrowserToolHarness({ id: "agent-1", cwd: "/repo" });

    const response = await harness.execute("browser_new_tab", {});

    expect(harness.broker.calls).toEqual([]);
    expect(response.content).toEqual([{ type: "text", text: WORKSPACE_CONTEXT_MESSAGE }]);
    expect(response.structuredContent).toEqual({
      ok: false,
      error: {
        code: "browser_denied",
        message: WORKSPACE_CONTEXT_MESSAGE,
        retryable: false,
      },
      context: {
        agentId: "agent-1",
        cwd: "/repo",
      },
    });
  });

  test("snapshot rejects calls without a browser id", () => {
    const harness = new BrowserToolHarness();

    const parsed = harness.validate("browser_snapshot", {});

    expect(parsed).toMatchObject({
      success: false,
      error: { issues: [expect.objectContaining({ message: BROWSER_ID_MESSAGE })] },
    });
  });

  test("snapshot rejects hallucinated browser ids", () => {
    const harness = new BrowserToolHarness();

    const parsed = harness.validate("browser_snapshot", { browserId: "default" });

    expect(parsed).toMatchObject({
      success: false,
      error: { issues: [expect.objectContaining({ message: BROWSER_ID_MESSAGE })] },
    });
  });

  test("snapshot sends browser id in command args only", async () => {
    const harness = new BrowserToolHarness();
    harness.broker.setResponse(snapshotPayload());

    const response = await harness.execute("browser_snapshot", { browserId: BROWSER_ID });

    expect(harness.broker.calls).toEqual([
      {
        agentId: "agent-1",
        cwd: "/repo",
        workspaceId: "wks_workspace_a",
        command: { command: "snapshot", args: { browserId: BROWSER_ID } },
      },
    ]);
    expect(response.structuredContent).toEqual({
      ok: true,
      result: {
        command: "snapshot",
        browserId: BROWSER_ID,
        workspaceId: "wks_workspace_a",
        url: "https://example.com",
        title: "Example",
        elements: [],
      },
      context: {
        agentId: "agent-1",
        cwd: "/repo",
        workspaceId: "wks_workspace_a",
        browserId: BROWSER_ID,
      },
    });
  });

  test.each(routedToolCases)(
    "$name routes browser id in command args and workspace id in the envelope",
    async ({ toolName, input, command, payload, content, structuredResult }) => {
      const harness = new BrowserToolHarness();
      harness.broker.setResponse(payload);

      const response = await harness.execute(toolName, input);

      expect(harness.broker.calls).toEqual([
        {
          agentId: "agent-1",
          cwd: "/repo",
          workspaceId: "wks_workspace_a",
          command,
        },
      ]);
      expect(response.content).toEqual(content);
      expect(response.structuredContent).toEqual({
        ok: payload.ok,
        result: structuredResult ?? payload.result,
        context: {
          agentId: "agent-1",
          cwd: "/repo",
          workspaceId: "wks_workspace_a",
          browserId: BROWSER_ID,
        },
      });
    },
  );

  test.each(brokerErrorCases)(
    "$name keep broker error summaries model-actionable",
    async ({ toolName, input, payload, content, context }) => {
      const harness = new BrowserToolHarness();
      harness.broker.setResponse(payload);

      const response = await harness.execute(toolName, input);

      expect(response.content).toEqual(content);
      expect(response.structuredContent).toEqual({
        ok: false,
        error: payload.error,
        context,
      });
    },
  );

  test("wait rejects calls without a condition", () => {
    const harness = new BrowserToolHarness();

    const parsed = harness.validate("browser_wait", { browserId: BROWSER_ID });

    expect(parsed).toMatchObject({
      success: false,
      error: { issues: [expect.objectContaining({ message: WAIT_CONDITION_MESSAGE })] },
    });
  });

  test("wait rejects empty calls", () => {
    const harness = new BrowserToolHarness();

    const parsed = harness.validate("browser_wait", {});

    expect(parsed).toMatchObject({
      success: false,
      error: { issues: [expect.objectContaining({ message: BROWSER_ID_MESSAGE })] },
    });
  });

  test("wait rejects calls with both text and url", () => {
    const harness = new BrowserToolHarness();

    const parsed = harness.validate("browser_wait", {
      browserId: BROWSER_ID,
      text: "Ready",
      url: "/ready",
    });

    expect(parsed).toMatchObject({
      success: false,
      error: { issues: [expect.objectContaining({ message: WAIT_CONDITION_MESSAGE })] },
    });
  });

  test("wait sends the text condition and extends the broker timeout", async () => {
    const harness = new BrowserToolHarness();
    harness.broker.setResponse({
      requestId: "req-wait",
      ok: true,
      result: { command: "wait", browserId: BROWSER_ID, matched: "text" },
    });

    const response = await harness.execute("browser_wait", {
      browserId: BROWSER_ID,
      text: "Ready",
      timeoutMs: 1000,
    });

    expect(harness.broker.calls).toEqual([
      {
        agentId: "agent-1",
        cwd: "/repo",
        workspaceId: "wks_workspace_a",
        timeoutMs: 2000,
        command: {
          command: "wait",
          args: { browserId: BROWSER_ID, text: "Ready", timeoutMs: 1000 },
        },
      },
    ]);
    expect(response.content).toEqual([{ type: "text", text: "Browser wait matched text." }]);
  });

  test("tab tools keep empty context when there is no caller agent", async () => {
    const harness = new BrowserToolHarness(null, null);
    harness.broker.setResponse(snapshotPayload());

    const response = await harness.execute("browser_snapshot", { browserId: BROWSER_ID });

    expect(harness.broker.calls).toEqual([
      { command: { command: "snapshot", args: { browserId: BROWSER_ID } } },
    ]);
    expect(response.structuredContent).toEqual({
      ok: true,
      result: snapshotPayload().result,
      context: { browserId: BROWSER_ID },
    });
  });
});
