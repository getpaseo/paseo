import { describe, expect, test } from "vitest";

import {
  BrowserAutomationExecuteRequestSchema,
  BrowserAutomationExecuteResponseSchema,
} from "./rpc-schemas.js";

const BROWSER_ID = "11111111-1111-4111-8111-111111111111";
const FALLBACK_BROWSER_ID = "1777777777777-abcdef";
const BROWSER_ID_MESSAGE =
  "browserId must be a real id returned by browser_new_tab or browser_list_tabs";
const WAIT_CONDITION_MESSAGE = "browser_wait requires exactly one of text or url";

const commandParseCases = [
  {
    name: "click",
    command: { command: "click", args: { browserId: BROWSER_ID, ref: "@e1" } },
    expected: { command: "click", args: { browserId: BROWSER_ID, ref: "@e1" } },
  },
  {
    name: "fill",
    command: {
      command: "fill",
      args: { browserId: BROWSER_ID, ref: "@e1", value: "Ada" },
    },
    expected: {
      command: "fill",
      args: { browserId: BROWSER_ID, ref: "@e1", value: "Ada" },
    },
  },
  {
    name: "type",
    command: {
      command: "type",
      args: { browserId: BROWSER_ID, ref: "@e1", text: "Ada" },
    },
    expected: {
      command: "type",
      args: { browserId: BROWSER_ID, ref: "@e1", text: "Ada" },
    },
  },
  {
    name: "keypress",
    command: { command: "keypress", args: { browserId: BROWSER_ID, key: "Enter" } },
    expected: { command: "keypress", args: { browserId: BROWSER_ID, key: "Enter" } },
  },
  {
    name: "navigate",
    command: {
      command: "navigate",
      args: { browserId: BROWSER_ID, url: "https://example.com/next" },
    },
    expected: {
      command: "navigate",
      args: { browserId: BROWSER_ID, url: "https://example.com/next" },
    },
  },
  {
    name: "back",
    command: { command: "back", args: { browserId: BROWSER_ID } },
    expected: { command: "back", args: { browserId: BROWSER_ID } },
  },
  {
    name: "forward",
    command: { command: "forward", args: { browserId: BROWSER_ID } },
    expected: { command: "forward", args: { browserId: BROWSER_ID } },
  },
  {
    name: "reload",
    command: { command: "reload", args: { browserId: BROWSER_ID } },
    expected: { command: "reload", args: { browserId: BROWSER_ID } },
  },
  {
    name: "screenshot",
    command: { command: "screenshot", args: { browserId: BROWSER_ID } },
    expected: { command: "screenshot", args: { browserId: BROWSER_ID } },
  },
  {
    name: "full page screenshot",
    command: { command: "full_page_screenshot", args: { browserId: BROWSER_ID } },
    expected: { command: "full_page_screenshot", args: { browserId: BROWSER_ID } },
  },
  {
    name: "pdf",
    command: { command: "pdf", args: { browserId: BROWSER_ID } },
    expected: { command: "pdf", args: { browserId: BROWSER_ID, printBackground: true } },
  },
  {
    name: "download",
    command: {
      command: "download",
      args: { browserId: BROWSER_ID, url: "https://example.com/file.txt" },
    },
    expected: {
      command: "download",
      args: { browserId: BROWSER_ID, url: "https://example.com/file.txt" },
    },
  },
  {
    name: "upload",
    command: {
      command: "upload",
      args: { browserId: BROWSER_ID, ref: "@e1", filePaths: ["/tmp/file.txt"] },
    },
    expected: {
      command: "upload",
      args: { browserId: BROWSER_ID, ref: "@e1", filePaths: ["/tmp/file.txt"] },
    },
  },
  {
    name: "focus",
    command: { command: "focus", args: { browserId: BROWSER_ID, ref: "@e1" } },
    expected: { command: "focus", args: { browserId: BROWSER_ID, ref: "@e1" } },
  },
  {
    name: "clear",
    command: { command: "clear", args: { browserId: BROWSER_ID, ref: "@e1" } },
    expected: { command: "clear", args: { browserId: BROWSER_ID, ref: "@e1" } },
  },
  {
    name: "check",
    command: { command: "check", args: { browserId: BROWSER_ID, ref: "@e2" } },
    expected: { command: "check", args: { browserId: BROWSER_ID, ref: "@e2", checked: true } },
  },
  {
    name: "select",
    command: {
      command: "select",
      args: { browserId: BROWSER_ID, ref: "@e3", value: "us" },
    },
    expected: {
      command: "select",
      args: { browserId: BROWSER_ID, ref: "@e3", value: "us" },
    },
  },
  {
    name: "hover",
    command: { command: "hover", args: { browserId: BROWSER_ID, ref: "@e4" } },
    expected: { command: "hover", args: { browserId: BROWSER_ID, ref: "@e4" } },
  },
  {
    name: "drag",
    command: {
      command: "drag",
      args: { browserId: BROWSER_ID, sourceRef: "@e4", targetRef: "@e5" },
    },
    expected: {
      command: "drag",
      args: { browserId: BROWSER_ID, sourceRef: "@e4", targetRef: "@e5" },
    },
  },
  {
    name: "logs",
    command: { command: "logs", args: { browserId: BROWSER_ID } },
    expected: { command: "logs", args: { browserId: BROWSER_ID, maxEntries: 50 } },
  },
  {
    name: "storage",
    command: { command: "storage", args: { browserId: BROWSER_ID } },
    expected: { command: "storage", args: { browserId: BROWSER_ID } },
  },
  {
    name: "environment",
    command: {
      command: "environment",
      args: {
        browserId: BROWSER_ID,
        viewport: { width: 390, height: 844, deviceScaleFactor: 3 },
        geolocation: { latitude: 37.7749, longitude: -122.4194, accuracy: 5 },
      },
    },
    expected: {
      command: "environment",
      args: {
        browserId: BROWSER_ID,
        viewport: { width: 390, height: 844, deviceScaleFactor: 3 },
        geolocation: { latitude: 37.7749, longitude: -122.4194, accuracy: 5 },
      },
    },
  },
  {
    name: "set background",
    command: { command: "set_background", args: { browserId: BROWSER_ID, color: "red" } },
    expected: { command: "set_background", args: { browserId: BROWSER_ID, color: "red" } },
  },
] as const;

const resultParseCases = [
  {
    name: "page info",
    result: {
      command: "page_info",
      tab: {
        browserId: BROWSER_ID,
        workspaceId: "workspace-1",
        url: "https://example.com",
        title: "Example",
      },
    },
    expected: {
      command: "page_info",
      tab: {
        browserId: BROWSER_ID,
        workspaceId: "workspace-1",
        url: "https://example.com",
        title: "Example",
        isActive: false,
        isLoading: false,
      },
    },
  },
  {
    name: "snapshot",
    result: {
      command: "snapshot",
      browserId: BROWSER_ID,
      workspaceId: "workspace-1",
      url: "https://example.com/form",
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
      ],
    },
    expected: {
      command: "snapshot",
      browserId: BROWSER_ID,
      workspaceId: "workspace-1",
      url: "https://example.com/form",
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
      ],
    },
  },
  {
    name: "click",
    result: { command: "click", browserId: BROWSER_ID, ref: "@e1" },
    expected: { command: "click", browserId: BROWSER_ID, ref: "@e1" },
  },
  {
    name: "fill",
    result: { command: "fill", browserId: BROWSER_ID, ref: "@e1" },
    expected: { command: "fill", browserId: BROWSER_ID, ref: "@e1" },
  },
  {
    name: "wait",
    result: { command: "wait", browserId: BROWSER_ID, matched: "text" },
    expected: { command: "wait", browserId: BROWSER_ID, matched: "text" },
  },
  {
    name: "type",
    result: { command: "type", browserId: BROWSER_ID, ref: "@e1" },
    expected: { command: "type", browserId: BROWSER_ID, ref: "@e1" },
  },
  {
    name: "keypress",
    result: { command: "keypress", browserId: BROWSER_ID, key: "Enter" },
    expected: { command: "keypress", browserId: BROWSER_ID, key: "Enter" },
  },
  {
    name: "navigate",
    result: { command: "navigate", browserId: BROWSER_ID, url: "https://example.com/next" },
    expected: { command: "navigate", browserId: BROWSER_ID, url: "https://example.com/next" },
  },
  {
    name: "back",
    result: { command: "back", browserId: BROWSER_ID },
    expected: { command: "back", browserId: BROWSER_ID },
  },
  {
    name: "forward",
    result: { command: "forward", browserId: BROWSER_ID },
    expected: { command: "forward", browserId: BROWSER_ID },
  },
  {
    name: "reload",
    result: { command: "reload", browserId: BROWSER_ID },
    expected: { command: "reload", browserId: BROWSER_ID },
  },
  {
    name: "screenshot",
    result: {
      command: "screenshot",
      browserId: BROWSER_ID,
      mimeType: "image/png",
      dataBase64: "iVBORw0KGgo=",
      width: 100,
      height: 50,
    },
    expected: {
      command: "screenshot",
      browserId: BROWSER_ID,
      mimeType: "image/png",
      dataBase64: "iVBORw0KGgo=",
      width: 100,
      height: 50,
    },
  },
  {
    name: "full page screenshot",
    result: {
      command: "full_page_screenshot",
      browserId: BROWSER_ID,
      mimeType: "image/png",
      dataBase64: "iVBORw0KGgo=",
      width: 390,
      height: 1200,
    },
    expected: {
      command: "full_page_screenshot",
      browserId: BROWSER_ID,
      mimeType: "image/png",
      dataBase64: "iVBORw0KGgo=",
      width: 390,
      height: 1200,
    },
  },
  {
    name: "pdf",
    result: {
      command: "pdf",
      browserId: BROWSER_ID,
      mimeType: "application/pdf",
      dataBase64: "JVBERg==",
    },
    expected: {
      command: "pdf",
      browserId: BROWSER_ID,
      mimeType: "application/pdf",
      dataBase64: "JVBERg==",
    },
  },
  {
    name: "download",
    result: {
      command: "download",
      browserId: BROWSER_ID,
      url: "https://example.com/file.txt",
      filePath: "/tmp/file.txt",
      totalBytes: 5,
      state: "completed",
    },
    expected: {
      command: "download",
      browserId: BROWSER_ID,
      url: "https://example.com/file.txt",
      filePath: "/tmp/file.txt",
      totalBytes: 5,
      state: "completed",
    },
  },
  {
    name: "upload",
    result: {
      command: "upload",
      browserId: BROWSER_ID,
      ref: "@e1",
      filePaths: ["/tmp/file.txt"],
    },
    expected: {
      command: "upload",
      browserId: BROWSER_ID,
      ref: "@e1",
      filePaths: ["/tmp/file.txt"],
    },
  },
  {
    name: "focus",
    result: { command: "focus", browserId: BROWSER_ID, ref: "@e1" },
    expected: { command: "focus", browserId: BROWSER_ID, ref: "@e1" },
  },
  {
    name: "clear",
    result: { command: "clear", browserId: BROWSER_ID, ref: "@e1" },
    expected: { command: "clear", browserId: BROWSER_ID, ref: "@e1" },
  },
  {
    name: "check",
    result: { command: "check", browserId: BROWSER_ID, ref: "@e2", checked: false },
    expected: { command: "check", browserId: BROWSER_ID, ref: "@e2", checked: false },
  },
  {
    name: "select",
    result: { command: "select", browserId: BROWSER_ID, ref: "@e3", value: "us" },
    expected: { command: "select", browserId: BROWSER_ID, ref: "@e3", value: "us" },
  },
  {
    name: "hover",
    result: { command: "hover", browserId: BROWSER_ID, ref: "@e4" },
    expected: { command: "hover", browserId: BROWSER_ID, ref: "@e4" },
  },
  {
    name: "drag",
    result: { command: "drag", browserId: BROWSER_ID, sourceRef: "@e4", targetRef: "@e5" },
    expected: { command: "drag", browserId: BROWSER_ID, sourceRef: "@e4", targetRef: "@e5" },
  },
  {
    name: "logs",
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
    expected: {
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
  {
    name: "storage",
    result: {
      command: "storage",
      browserId: BROWSER_ID,
      url: "https://example.com",
      cookies: [{ name: "theme", value: "dark", domain: "example.com", httpOnly: true }],
      localStorage: [{ key: "token", value: "abc" }],
      sessionStorage: [{ key: "tab", value: "1" }],
    },
    expected: {
      command: "storage",
      browserId: BROWSER_ID,
      url: "https://example.com",
      cookies: [{ name: "theme", value: "dark", domain: "example.com", httpOnly: true }],
      localStorage: [{ key: "token", value: "abc" }],
      sessionStorage: [{ key: "tab", value: "1" }],
    },
  },
  {
    name: "environment",
    result: {
      command: "environment",
      browserId: BROWSER_ID,
      viewport: { width: 390, height: 844, deviceScaleFactor: 3 },
      geolocation: { latitude: 37.7749, longitude: -122.4194, accuracy: 5 },
    },
    expected: {
      command: "environment",
      browserId: BROWSER_ID,
      viewport: { width: 390, height: 844, deviceScaleFactor: 3 },
      geolocation: { latitude: 37.7749, longitude: -122.4194, accuracy: 5 },
    },
  },
  {
    name: "set background",
    result: { command: "set_background", browserId: BROWSER_ID, color: "red" },
    expected: { command: "set_background", browserId: BROWSER_ID, color: "red" },
  },
] as const;

describe("browser automation execute RPC schemas", () => {
  test("list tabs reads workspace from the request envelope", () => {
    const parsed = BrowserAutomationExecuteRequestSchema.parse({
      type: "browser.automation.execute.request",
      requestId: "req-list-tabs",
      workspaceId: "workspace-1",
      command: { command: "list_tabs", args: {} },
    });

    expect(parsed).toEqual({
      type: "browser.automation.execute.request",
      requestId: "req-list-tabs",
      workspaceId: "workspace-1",
      command: { command: "list_tabs", args: {} },
    });
  });

  test("new tab reads workspace from the request envelope", () => {
    const parsed = BrowserAutomationExecuteRequestSchema.parse({
      type: "browser.automation.execute.request",
      requestId: "req-new-tab",
      workspaceId: "workspace-1",
      command: { command: "new_tab", args: { url: "https://example.com" } },
    });

    expect(parsed.command).toEqual({
      command: "new_tab",
      args: { url: "https://example.com" },
    });
  });

  test("tab commands require a browser id from browser_new_tab or browser_list_tabs", () => {
    const parsed = BrowserAutomationExecuteRequestSchema.safeParse({
      type: "browser.automation.execute.request",
      requestId: "req-snapshot",
      workspaceId: "workspace-1",
      command: { command: "snapshot", args: {} },
    });

    expect(parsed).toMatchObject({
      success: false,
      error: { issues: [expect.objectContaining({ message: BROWSER_ID_MESSAGE })] },
    });
  });

  test("tab commands reject hallucinated browser ids", () => {
    const parsed = BrowserAutomationExecuteRequestSchema.safeParse({
      type: "browser.automation.execute.request",
      requestId: "req-page-info",
      workspaceId: "workspace-1",
      command: { command: "page_info", args: { browserId: "default" } },
    });

    expect(parsed).toMatchObject({
      success: false,
      error: { issues: [expect.objectContaining({ message: BROWSER_ID_MESSAGE })] },
    });
  });

  test("tab commands parse browser ids produced by the fallback generator", () => {
    const parsed = BrowserAutomationExecuteRequestSchema.parse({
      type: "browser.automation.execute.request",
      requestId: "req-page-info",
      workspaceId: "workspace-1",
      command: { command: "page_info", args: { browserId: FALLBACK_BROWSER_ID } },
    });

    expect(parsed.command).toEqual({
      command: "page_info",
      args: { browserId: FALLBACK_BROWSER_ID },
    });
  });

  test("requests reject browser id in the envelope", () => {
    const parsed = BrowserAutomationExecuteRequestSchema.safeParse({
      type: "browser.automation.execute.request",
      requestId: "req-click",
      workspaceId: "workspace-1",
      browserId: BROWSER_ID,
      command: { command: "click", args: { browserId: BROWSER_ID, ref: "@e1" } },
    });

    expect(parsed).toMatchObject({
      success: false,
      error: { issues: [expect.objectContaining({ message: 'Unrecognized key: "browserId"' })] },
    });
  });

  test("tab commands reject workspace id in command args", () => {
    const parsed = BrowserAutomationExecuteRequestSchema.safeParse({
      type: "browser.automation.execute.request",
      requestId: "req-click",
      workspaceId: "workspace-1",
      command: {
        command: "click",
        args: { workspaceId: "workspace-1", browserId: BROWSER_ID, ref: "@e1" },
      },
    });

    expect(parsed).toMatchObject({
      success: false,
      error: { issues: [expect.objectContaining({ message: 'Unrecognized key: "workspaceId"' })] },
    });
  });

  test("wait rejects calls without exactly one condition", () => {
    const parsed = BrowserAutomationExecuteRequestSchema.safeParse({
      type: "browser.automation.execute.request",
      requestId: "req-wait",
      command: { command: "wait", args: { browserId: BROWSER_ID } },
    });

    expect(parsed).toMatchObject({
      success: false,
      error: { issues: [expect.objectContaining({ message: WAIT_CONDITION_MESSAGE })] },
    });
  });

  test("wait rejects calls with both text and url conditions", () => {
    const parsed = BrowserAutomationExecuteRequestSchema.safeParse({
      type: "browser.automation.execute.request",
      requestId: "req-wait",
      command: {
        command: "wait",
        args: { browserId: BROWSER_ID, text: "Ready", url: "/ready" },
      },
    });

    expect(parsed).toMatchObject({
      success: false,
      error: { issues: [expect.objectContaining({ message: WAIT_CONDITION_MESSAGE })] },
    });
  });

  test("wait accepts one text condition", () => {
    const parsed = BrowserAutomationExecuteRequestSchema.parse({
      type: "browser.automation.execute.request",
      requestId: "req-wait",
      command: {
        command: "wait",
        args: { browserId: BROWSER_ID, text: "Ready", timeoutMs: 1000 },
      },
    });

    expect(parsed.command).toEqual({
      command: "wait",
      args: { browserId: BROWSER_ID, text: "Ready", timeoutMs: 1000 },
    });
  });

  test.each(commandParseCases)(
    "$name requests parse explicit browser ids",
    ({ command, expected }) => {
      const parsed = BrowserAutomationExecuteRequestSchema.parse({
        type: "browser.automation.execute.request",
        requestId: "req-command",
        workspaceId: "workspace-1",
        command,
      });

      expect(parsed.command).toEqual(expected);
    },
  );

  test("navigate rejects non-http URLs at the protocol boundary", () => {
    const parsed = BrowserAutomationExecuteRequestSchema.safeParse({
      type: "browser.automation.execute.request",
      requestId: "req-navigate",
      command: {
        command: "navigate",
        args: { browserId: BROWSER_ID, url: "file:///tmp/secret.txt" },
      },
    });

    expect(parsed).toMatchObject({
      success: false,
      error: { issues: [expect.objectContaining({ message: "URL must use http or https" })] },
    });
  });

  test("download rejects non-http URLs at the protocol boundary", () => {
    const parsed = BrowserAutomationExecuteRequestSchema.safeParse({
      type: "browser.automation.execute.request",
      requestId: "req-download",
      command: {
        command: "download",
        args: { browserId: BROWSER_ID, url: "file:///tmp/secret.txt" },
      },
    });

    expect(parsed).toMatchObject({
      success: false,
      error: { issues: [expect.objectContaining({ message: "URL must use http or https" })] },
    });
  });

  test("new tab responses declare the generated browser id shape", () => {
    const parsed = BrowserAutomationExecuteResponseSchema.parse({
      type: "browser.automation.execute.response",
      payload: {
        requestId: "req-new-tab",
        ok: true,
        result: {
          command: "new_tab",
          browserId: BROWSER_ID,
          workspaceId: "workspace-1",
          url: "https://example.com",
        },
      },
    });

    expect(parsed.payload).toEqual({
      requestId: "req-new-tab",
      ok: true,
      result: {
        command: "new_tab",
        browserId: BROWSER_ID,
        workspaceId: "workspace-1",
        url: "https://example.com",
      },
    });
  });

  test("responses reject hallucinated browser ids", () => {
    const parsed = BrowserAutomationExecuteResponseSchema.safeParse({
      type: "browser.automation.execute.response",
      payload: {
        requestId: "req-page-info",
        ok: true,
        result: {
          command: "page_info",
          tab: {
            browserId: "default",
            workspaceId: "workspace-1",
            url: "https://example.com",
            title: "Example",
          },
        },
      },
    });

    expect(parsed).toMatchObject({
      success: false,
      error: { issues: [expect.objectContaining({ message: BROWSER_ID_MESSAGE })] },
    });
  });

  test.each(resultParseCases)(
    "$name results parse under the response payload",
    ({ result, expected }) => {
      const parsed = BrowserAutomationExecuteResponseSchema.parse({
        type: "browser.automation.execute.response",
        payload: {
          requestId: "req-result",
          ok: true,
          result,
        },
      });

      expect(parsed.payload).toEqual({
        requestId: "req-result",
        ok: true,
        result: expected,
      });
    },
  );

  test("error responses keep stable codes, messages, and retry defaults", () => {
    const parsed = BrowserAutomationExecuteResponseSchema.parse({
      type: "browser.automation.execute.response",
      payload: {
        requestId: "req-error",
        ok: false,
        error: {
          code: "browser_no_desktop",
          message: "No desktop browser automation client is connected.",
        },
      },
    });

    expect(parsed.payload).toEqual({
      requestId: "req-error",
      ok: false,
      error: {
        code: "browser_no_desktop",
        message: "No desktop browser automation client is connected.",
        retryable: false,
      },
    });
  });
});
