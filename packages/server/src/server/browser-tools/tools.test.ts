import { describe, expect, it, vi } from "vitest";
import type { BrowserToolsBroker } from "./broker.js";
import type { BrowserToolsResponsePayload } from "./errors.js";
import { registerBrowserTools, type RegisterBrowserToolsOptions } from "./tools.js";

interface RegisteredTool {
  config: { inputSchema: Record<string, unknown>; outputSchema: unknown };
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
  }>;
}

function createHarness(options?: { brokerResponse?: BrowserToolsResponsePayload }) {
  const tools = new Map<string, RegisteredTool>();
  const execute = vi.fn(async () => {
    return (
      options?.brokerResponse ?? {
        requestId: "req-1",
        ok: true as const,
        result: {
          command: "list_tabs" as const,
          tabs: [
            {
              browserId: "browser-1",
              url: "https://example.com",
              title: "Example",
              isActive: true,
              isLoading: false,
            },
          ],
        },
      }
    );
  });
  const registerTool = vi.fn((name, config, handler) => {
    tools.set(name, {
      config,
      handler: handler as RegisteredTool["handler"],
    });
  }) as unknown as RegisterBrowserToolsOptions["registerTool"];

  registerBrowserTools({
    registerTool,
    broker: { execute } as unknown as BrowserToolsBroker,
    callerAgentId: "agent-1",
    resolveCallerAgent: () => ({ id: "agent-1", cwd: "/repo" }),
  });

  return { tools, execute };
}

function tool(harness: ReturnType<typeof createHarness>, name: string): RegisteredTool {
  const registered = harness.tools.get(name);
  if (!registered) {
    throw new Error(`Tool not registered: ${name}`);
  }
  return registered;
}

describe("registerBrowserTools", () => {
  it("registers browser_list_tabs and routes through the broker with caller workspace", async () => {
    const harness = createHarness();

    const response = await tool(harness, "browser_list_tabs").handler({});

    expect(harness.execute).toHaveBeenCalledWith({
      agentId: "agent-1",
      cwd: "/repo",
      workspaceId: "/repo",
      command: { command: "list_tabs", args: { workspaceId: "/repo" } },
    });
    expect(response.content).toEqual([
      {
        type: "text",
        text: "Found 1 Paseo browser tab. Use these browserId values exactly; do not use 'default'. You may omit browserId to use the active tab.\n- browserId=browser-1 active title=\"Example\" url=https://example.com",
      },
    ]);
    expect(response.structuredContent).toEqual({
      ok: true,
      result: {
        command: "list_tabs",
        tabs: [
          {
            browserId: "browser-1",
            url: "https://example.com",
            title: "Example",
            isActive: true,
            isLoading: false,
          },
        ],
      },
      context: { agentId: "agent-1", cwd: "/repo", workspaceId: "/repo" },
    });
  });

  it("registers browser_new_tab and returns the created tab handle", async () => {
    const harness = createHarness({
      brokerResponse: {
        requestId: "req-new-tab",
        ok: true,
        result: {
          command: "new_tab",
          browserId: "browser-new",
          workspaceId: "/repo",
          url: "https://example.com",
        },
      },
    });

    const response = await tool(harness, "browser_new_tab").handler({ url: "https://example.com" });

    expect(harness.execute).toHaveBeenCalledWith({
      agentId: "agent-1",
      cwd: "/repo",
      workspaceId: "/repo",
      command: {
        command: "new_tab",
        args: { workspaceId: "/repo", url: "https://example.com" },
      },
    });
    expect(response.content).toEqual([
      {
        type: "text",
        text: "Created browser tab browserId=browser-new url=https://example.com. Use this browserId exactly, or omit browserId to use this active tab.",
      },
    ]);
  });

  it("routes browser_page_info through the broker with explicit browserId", async () => {
    const harness = createHarness({
      brokerResponse: {
        requestId: "req-2",
        ok: true,
        result: {
          command: "page_info",
          tab: {
            browserId: "browser-2",
            url: "https://example.com/docs",
            title: "Docs",
            isActive: false,
            isLoading: false,
          },
        },
      },
    });

    const response = await tool(harness, "browser_page_info").handler({ browserId: "browser-2" });

    expect(harness.execute).toHaveBeenCalledWith({
      agentId: "agent-1",
      cwd: "/repo",
      workspaceId: "/repo",
      browserId: "browser-2",
      command: {
        command: "page_info",
        args: { workspaceId: "/repo", browserId: "browser-2" },
      },
    });
    expect(response.content).toEqual([
      { type: "text", text: "Current page browserId=browser-2: Docs — https://example.com/docs" },
    ]);
    expect(response.structuredContent).toEqual({
      ok: true,
      result: {
        command: "page_info",
        tab: {
          browserId: "browser-2",
          url: "https://example.com/docs",
          title: "Docs",
          isActive: false,
          isLoading: false,
        },
      },
      context: { agentId: "agent-1", cwd: "/repo", workspaceId: "/repo", browserId: "browser-2" },
    });
  });

  it("routes browser_snapshot through the broker with caller workspace", async () => {
    const harness = createHarness({
      brokerResponse: {
        requestId: "req-snapshot",
        ok: true,
        result: {
          command: "snapshot",
          browserId: "browser-1",
          workspaceId: "/repo",
          url: "https://example.com/form",
          title: "Fixture",
          elements: [
            {
              ref: "@e1",
              role: "textbox",
              tagName: "input",
              text: "Name",
              selector: "#name",
              attributes: { id: "name" },
            },
          ],
        },
      },
    });

    const response = await tool(harness, "browser_snapshot").handler({});

    expect(harness.execute).toHaveBeenCalledWith({
      agentId: "agent-1",
      cwd: "/repo",
      workspaceId: "/repo",
      command: { command: "snapshot", args: { workspaceId: "/repo" } },
    });
    expect(response.content).toEqual([{ type: "text", text: "Snapshot captured 1 element." }]);
    expect(response.structuredContent).toEqual({
      ok: true,
      result: {
        command: "snapshot",
        browserId: "browser-1",
        workspaceId: "/repo",
        url: "https://example.com/form",
        title: "Fixture",
        elements: [
          {
            ref: "@e1",
            role: "textbox",
            tagName: "input",
            text: "Name",
            selector: "#name",
            attributes: { id: "name" },
          },
        ],
      },
      context: { agentId: "agent-1", cwd: "/repo", workspaceId: "/repo" },
    });
  });

  it("routes browser_set_background through the broker", async () => {
    const harness = createHarness({
      brokerResponse: {
        requestId: "req-bg",
        ok: true,
        result: { command: "set_background", browserId: "browser-1", color: "red" },
      },
    });

    const response = await tool(harness, "browser_set_background").handler({ color: "red" });

    expect(harness.execute).toHaveBeenCalledWith({
      agentId: "agent-1",
      cwd: "/repo",
      workspaceId: "/repo",
      command: { command: "set_background", args: { workspaceId: "/repo", color: "red" } },
    });
    expect(response.content).toEqual([
      { type: "text", text: "Set browser page background to red." },
    ]);
  });

  it("routes browser_click through the broker with a snapshot ref", async () => {
    const harness = createHarness({
      brokerResponse: {
        requestId: "req-click",
        ok: true,
        result: { command: "click", browserId: "browser-1", ref: "@e2" },
      },
    });

    const response = await tool(harness, "browser_click").handler({ ref: "@e2" });

    expect(harness.execute).toHaveBeenCalledWith({
      agentId: "agent-1",
      cwd: "/repo",
      workspaceId: "/repo",
      command: { command: "click", args: { workspaceId: "/repo", ref: "@e2" } },
    });
    expect(response.content).toEqual([{ type: "text", text: "Clicked browser element @e2." }]);
    expect(response.structuredContent).toEqual({
      ok: true,
      result: { command: "click", browserId: "browser-1", ref: "@e2" },
      context: { agentId: "agent-1", cwd: "/repo", workspaceId: "/repo" },
    });
  });

  it("routes browser_fill through the broker with a snapshot ref and value", async () => {
    const harness = createHarness({
      brokerResponse: {
        requestId: "req-fill",
        ok: true,
        result: { command: "fill", browserId: "browser-1", ref: "@e1" },
      },
    });

    const response = await tool(harness, "browser_fill").handler({ ref: "@e1", value: "Ada" });

    expect(harness.execute).toHaveBeenCalledWith({
      agentId: "agent-1",
      cwd: "/repo",
      workspaceId: "/repo",
      command: { command: "fill", args: { workspaceId: "/repo", ref: "@e1", value: "Ada" } },
    });
    expect(response.content).toEqual([{ type: "text", text: "Filled browser element @e1." }]);
    expect(response.structuredContent).toEqual({
      ok: true,
      result: { command: "fill", browserId: "browser-1", ref: "@e1" },
      context: { agentId: "agent-1", cwd: "/repo", workspaceId: "/repo" },
    });
  });

  it("routes browser_wait through the broker with text and timeout", async () => {
    const harness = createHarness({
      brokerResponse: {
        requestId: "req-wait",
        ok: true,
        result: { command: "wait", browserId: "browser-1", matched: "text" },
      },
    });

    const response = await tool(harness, "browser_wait").handler({
      text: "Ready",
      timeoutMs: 1000,
    });

    expect(harness.execute).toHaveBeenCalledWith({
      agentId: "agent-1",
      cwd: "/repo",
      workspaceId: "/repo",
      timeoutMs: 2000,
      command: {
        command: "wait",
        args: { workspaceId: "/repo", text: "Ready", timeoutMs: 1000 },
      },
    });
    expect(response.content).toEqual([{ type: "text", text: "Browser wait matched text." }]);
    expect(response.structuredContent).toEqual({
      ok: true,
      result: { command: "wait", browserId: "browser-1", matched: "text" },
      context: { agentId: "agent-1", cwd: "/repo", workspaceId: "/repo" },
    });
  });

  it("routes browser_type through the broker", async () => {
    const harness = createHarness({
      brokerResponse: {
        requestId: "req-type",
        ok: true,
        result: { command: "type", browserId: "browser-1", ref: "@e1" },
      },
    });

    const response = await tool(harness, "browser_type").handler({ ref: "@e1", text: "Ada" });

    expect(harness.execute).toHaveBeenCalledWith({
      agentId: "agent-1",
      cwd: "/repo",
      workspaceId: "/repo",
      command: { command: "type", args: { workspaceId: "/repo", ref: "@e1", text: "Ada" } },
    });
    expect(response.content).toEqual([{ type: "text", text: "Typed into browser element @e1." }]);
  });

  it("routes browser_keypress through the broker", async () => {
    const harness = createHarness({
      brokerResponse: {
        requestId: "req-keypress",
        ok: true,
        result: { command: "keypress", browserId: "browser-1", ref: "@e1", key: "Enter" },
      },
    });

    const response = await tool(harness, "browser_keypress").handler({
      ref: "@e1",
      key: "Enter",
    });

    expect(harness.execute).toHaveBeenCalledWith({
      agentId: "agent-1",
      cwd: "/repo",
      workspaceId: "/repo",
      command: {
        command: "keypress",
        args: { workspaceId: "/repo", ref: "@e1", key: "Enter" },
      },
    });
    expect(response.content).toEqual([
      { type: "text", text: "Pressed Enter on browser element @e1." },
    ]);
  });

  it("routes browser_navigate through the broker", async () => {
    const harness = createHarness({
      brokerResponse: {
        requestId: "req-nav",
        ok: true,
        result: { command: "navigate", browserId: "browser-1", url: "https://example.com/next" },
      },
    });

    const response = await tool(harness, "browser_navigate").handler({
      url: "https://example.com/next",
    });

    expect(harness.execute).toHaveBeenCalledWith({
      agentId: "agent-1",
      cwd: "/repo",
      workspaceId: "/repo",
      command: {
        command: "navigate",
        args: { workspaceId: "/repo", url: "https://example.com/next" },
      },
    });
    expect(response.content).toEqual([
      { type: "text", text: "Navigated browser to https://example.com/next." },
    ]);
  });

  it("routes browser_back through the broker", async () => {
    const harness = createHarness({
      brokerResponse: {
        requestId: "req-back",
        ok: true,
        result: { command: "back", browserId: "browser-1" },
      },
    });

    const response = await tool(harness, "browser_back").handler({});

    expect(harness.execute).toHaveBeenCalledWith({
      agentId: "agent-1",
      cwd: "/repo",
      workspaceId: "/repo",
      command: { command: "back", args: { workspaceId: "/repo" } },
    });
    expect(response.content).toEqual([{ type: "text", text: "Browser back complete." }]);
  });

  it("routes browser_screenshot through the broker", async () => {
    const harness = createHarness({
      brokerResponse: {
        requestId: "req-shot",
        ok: true,
        result: {
          command: "screenshot",
          browserId: "browser-1",
          mimeType: "image/png",
          dataBase64: "iVBORw0KGgo=",
          width: 100,
          height: 50,
        },
      },
    });

    const response = await tool(harness, "browser_screenshot").handler({});

    expect(harness.execute).toHaveBeenCalledWith({
      agentId: "agent-1",
      cwd: "/repo",
      workspaceId: "/repo",
      command: { command: "screenshot", args: { workspaceId: "/repo" } },
    });
    expect(response.content).toEqual([
      { type: "text", text: "Captured browser screenshot (100x50)." },
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
    ]);
  });

  it("routes browser_logs through the broker", async () => {
    const harness = createHarness({
      brokerResponse: {
        requestId: "req-logs",
        ok: true,
        result: {
          command: "logs",
          browserId: "browser-1",
          console: [{ level: "info", message: "ready", timestamp: 1 }],
          network: [
            {
              url: "https://example.com/app.js",
              type: "script",
              startTime: 2,
              duration: 3,
            },
          ],
        },
      },
    });

    const response = await tool(harness, "browser_logs").handler({ maxEntries: 25 });

    expect(harness.execute).toHaveBeenCalledWith({
      agentId: "agent-1",
      cwd: "/repo",
      workspaceId: "/repo",
      command: { command: "logs", args: { workspaceId: "/repo", maxEntries: 25 } },
    });
    expect(response.content).toEqual([
      { type: "text", text: "Read 1 console log and 1 network entry." },
    ]);
  });

  it("routes browser_storage through the broker", async () => {
    const harness = createHarness({
      brokerResponse: {
        requestId: "req-storage",
        ok: true,
        result: {
          command: "storage",
          browserId: "browser-1",
          url: "https://example.com",
          cookies: [{ name: "theme", value: "dark" }],
          localStorage: [{ key: "token", value: "abc" }],
          sessionStorage: [{ key: "tab", value: "1" }],
        },
      },
    });

    const response = await tool(harness, "browser_storage").handler({});

    expect(harness.execute).toHaveBeenCalledWith({
      agentId: "agent-1",
      cwd: "/repo",
      workspaceId: "/repo",
      command: { command: "storage", args: { workspaceId: "/repo" } },
    });
    expect(response.content).toEqual([
      { type: "text", text: "Read 1 cookie, 1 localStorage entry, and 1 sessionStorage entry." },
    ]);
  });

  it("routes browser_environment through the broker", async () => {
    const harness = createHarness({
      brokerResponse: {
        requestId: "req-environment",
        ok: true,
        result: {
          command: "environment",
          browserId: "browser-1",
          viewport: { width: 390, height: 844, deviceScaleFactor: 3 },
          geolocation: { latitude: 37.7749, longitude: -122.4194, accuracy: 5 },
        },
      },
    });

    const response = await tool(harness, "browser_environment").handler({
      viewport: { width: 390, height: 844, deviceScaleFactor: 3 },
      geolocation: { latitude: 37.7749, longitude: -122.4194, accuracy: 5 },
    });

    expect(harness.execute).toHaveBeenCalledWith({
      agentId: "agent-1",
      cwd: "/repo",
      workspaceId: "/repo",
      command: {
        command: "environment",
        args: {
          workspaceId: "/repo",
          viewport: { width: 390, height: 844, deviceScaleFactor: 3 },
          geolocation: { latitude: 37.7749, longitude: -122.4194, accuracy: 5 },
        },
      },
    });
    expect(response.content).toEqual([
      { type: "text", text: "Browser environment viewport is 390x844." },
    ]);
  });

  it("routes browser_full_page_screenshot through the broker", async () => {
    const harness = createHarness({
      brokerResponse: {
        requestId: "req-full-page",
        ok: true,
        result: {
          command: "full_page_screenshot",
          browserId: "browser-1",
          mimeType: "image/png",
          dataBase64: "iVBORw0KGgo=",
          width: 390,
          height: 1200,
        },
      },
    });

    const response = await tool(harness, "browser_full_page_screenshot").handler({});

    expect(harness.execute).toHaveBeenCalledWith({
      agentId: "agent-1",
      cwd: "/repo",
      workspaceId: "/repo",
      command: { command: "full_page_screenshot", args: { workspaceId: "/repo" } },
    });
    expect(response.content).toEqual([
      { type: "text", text: "Captured full-page browser screenshot (390x1200)." },
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
    ]);
  });

  it("routes browser_pdf through the broker", async () => {
    const harness = createHarness({
      brokerResponse: {
        requestId: "req-pdf",
        ok: true,
        result: {
          command: "pdf",
          browserId: "browser-1",
          mimeType: "application/pdf",
          dataBase64: "JVBERg==",
        },
      },
    });

    const response = await tool(harness, "browser_pdf").handler({ landscape: true });

    expect(harness.execute).toHaveBeenCalledWith({
      agentId: "agent-1",
      cwd: "/repo",
      workspaceId: "/repo",
      command: {
        command: "pdf",
        args: { workspaceId: "/repo", landscape: true, printBackground: true },
      },
    });
    expect(response.content).toEqual([{ type: "text", text: "Exported browser page PDF." }]);
  });

  it("routes browser_download through the broker", async () => {
    const harness = createHarness({
      brokerResponse: {
        requestId: "req-download",
        ok: true,
        result: {
          command: "download",
          browserId: "browser-1",
          url: "https://example.com/file.txt",
          filePath: "/tmp/file.txt",
          totalBytes: 5,
          state: "completed",
        },
      },
    });

    const response = await tool(harness, "browser_download").handler({
      url: "https://example.com/file.txt",
      fileName: "file.txt",
    });

    expect(harness.execute).toHaveBeenCalledWith({
      agentId: "agent-1",
      cwd: "/repo",
      workspaceId: "/repo",
      command: {
        command: "download",
        args: { workspaceId: "/repo", url: "https://example.com/file.txt", fileName: "file.txt" },
      },
    });
    expect(response.content).toEqual([
      { type: "text", text: "Downloaded browser file to /tmp/file.txt." },
    ]);
  });

  it("routes browser_upload through the broker", async () => {
    const harness = createHarness({
      brokerResponse: {
        requestId: "req-upload",
        ok: true,
        result: {
          command: "upload",
          browserId: "browser-1",
          ref: "@e1",
          filePaths: ["/tmp/file.txt"],
        },
      },
    });

    const response = await tool(harness, "browser_upload").handler({
      ref: "@e1",
      filePaths: ["/tmp/file.txt"],
    });

    expect(harness.execute).toHaveBeenCalledWith({
      agentId: "agent-1",
      cwd: "/repo",
      workspaceId: "/repo",
      command: {
        command: "upload",
        args: { workspaceId: "/repo", ref: "@e1", filePaths: ["/tmp/file.txt"] },
      },
    });
    expect(response.content).toEqual([
      { type: "text", text: "Uploaded 1 file to browser element @e1." },
    ]);
  });

  it("routes browser form control tools through the broker", async () => {
    const focusHarness = createHarness({
      brokerResponse: {
        requestId: "req-focus",
        ok: true,
        result: { command: "focus", browserId: "browser-1", ref: "@e1" },
      },
    });
    const focusResponse = await tool(focusHarness, "browser_focus").handler({ ref: "@e1" });
    expect(focusHarness.execute).toHaveBeenCalledWith({
      agentId: "agent-1",
      cwd: "/repo",
      workspaceId: "/repo",
      command: { command: "focus", args: { workspaceId: "/repo", ref: "@e1" } },
    });
    expect(focusResponse.content).toEqual([{ type: "text", text: "Focused browser element @e1." }]);

    const checkHarness = createHarness({
      brokerResponse: {
        requestId: "req-check",
        ok: true,
        result: { command: "check", browserId: "browser-1", ref: "@e2", checked: false },
      },
    });
    const checkResponse = await tool(checkHarness, "browser_check").handler({
      ref: "@e2",
      checked: false,
    });
    expect(checkHarness.execute).toHaveBeenCalledWith({
      agentId: "agent-1",
      cwd: "/repo",
      workspaceId: "/repo",
      command: { command: "check", args: { workspaceId: "/repo", ref: "@e2", checked: false } },
    });
    expect(checkResponse.content).toEqual([
      { type: "text", text: "Unchecked browser element @e2." },
    ]);

    const selectHarness = createHarness({
      brokerResponse: {
        requestId: "req-select",
        ok: true,
        result: { command: "select", browserId: "browser-1", ref: "@e3", value: "us" },
      },
    });
    const selectResponse = await tool(selectHarness, "browser_select").handler({
      ref: "@e3",
      value: "us",
    });
    expect(selectHarness.execute).toHaveBeenCalledWith({
      agentId: "agent-1",
      cwd: "/repo",
      workspaceId: "/repo",
      command: { command: "select", args: { workspaceId: "/repo", ref: "@e3", value: "us" } },
    });
    expect(selectResponse.content).toEqual([
      { type: "text", text: "Selected us in browser element @e3." },
    ]);

    const hoverHarness = createHarness({
      brokerResponse: {
        requestId: "req-hover",
        ok: true,
        result: { command: "hover", browserId: "browser-1", ref: "@e4" },
      },
    });
    const hoverResponse = await tool(hoverHarness, "browser_hover").handler({ ref: "@e4" });
    expect(hoverHarness.execute).toHaveBeenCalledWith({
      agentId: "agent-1",
      cwd: "/repo",
      workspaceId: "/repo",
      command: { command: "hover", args: { workspaceId: "/repo", ref: "@e4" } },
    });
    expect(hoverResponse.content).toEqual([{ type: "text", text: "Hovered browser element @e4." }]);

    const dragHarness = createHarness({
      brokerResponse: {
        requestId: "req-drag",
        ok: true,
        result: { command: "drag", browserId: "browser-1", sourceRef: "@e4", targetRef: "@e5" },
      },
    });
    const dragResponse = await tool(dragHarness, "browser_drag").handler({
      sourceRef: "@e4",
      targetRef: "@e5",
    });
    expect(dragHarness.execute).toHaveBeenCalledWith({
      agentId: "agent-1",
      cwd: "/repo",
      workspaceId: "/repo",
      command: {
        command: "drag",
        args: { workspaceId: "/repo", sourceRef: "@e4", targetRef: "@e5" },
      },
    });
    expect(dragResponse.content).toEqual([
      { type: "text", text: "Dragged browser element @e4 to @e5." },
    ]);
  });

  it("returns model-actionable disabled errors with structured content", async () => {
    const harness = createHarness({
      brokerResponse: {
        requestId: "req-disabled",
        ok: false,
        error: {
          code: "browser_disabled",
          message: "Browser tools are disabled. Enable daemon.browserTools.enabled to use them.",
          retryable: false,
        },
      },
    });

    const response = await tool(harness, "browser_list_tabs").handler({});

    expect(response.content).toEqual([
      {
        type: "text",
        text: "Browser tools are disabled. Enable desktop browser tools on the host, then try again.",
      },
    ]);
    expect(response.structuredContent).toEqual({
      ok: false,
      error: {
        code: "browser_disabled",
        message: "Browser tools are disabled. Enable daemon.browserTools.enabled to use them.",
        retryable: false,
      },
      context: { agentId: "agent-1", cwd: "/repo", workspaceId: "/repo" },
    });
  });

  it("preserves typed broker errors", async () => {
    const harness = createHarness({
      brokerResponse: {
        requestId: "req-timeout",
        ok: false,
        error: {
          code: "browser_timeout",
          message: "Browser automation timed out after 15000ms.",
          retryable: true,
        },
      },
    });

    const response = await tool(harness, "browser_page_info").handler({});

    expect(response.content).toEqual([
      {
        type: "text",
        text: "The browser did not respond before the timeout. Try again or check the desktop app.",
      },
    ]);
    expect(response.structuredContent?.error).toEqual({
      code: "browser_timeout",
      message: "Browser automation timed out after 15000ms.",
      retryable: true,
    });
  });
});
