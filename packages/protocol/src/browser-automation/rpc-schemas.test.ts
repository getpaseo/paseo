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
    expected: {
      command: "click",
      args: {
        browserId: BROWSER_ID,
        ref: "@e1",
        button: "left",
        doubleClick: false,
        modifiers: [],
      },
    },
  },
  {
    name: "click options",
    command: {
      command: "click",
      args: {
        browserId: BROWSER_ID,
        ref: "@e1",
        button: "right",
        doubleClick: true,
        modifiers: ["Meta", "Shift"],
      },
    },
    expected: {
      command: "click",
      args: {
        browserId: BROWSER_ID,
        ref: "@e1",
        button: "right",
        doubleClick: true,
        modifiers: ["Meta", "Shift"],
      },
    },
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
    expected: { command: "screenshot", args: { browserId: BROWSER_ID, fullPage: false } },
  },
  {
    name: "full page screenshot",
    command: { command: "screenshot", args: { browserId: BROWSER_ID, fullPage: true } },
    expected: { command: "screenshot", args: { browserId: BROWSER_ID, fullPage: true } },
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
    name: "evaluate",
    command: {
      command: "evaluate",
      args: { browserId: BROWSER_ID, function: "() => document.title" },
    },
    expected: {
      command: "evaluate",
      args: { browserId: BROWSER_ID, function: "() => document.title" },
    },
  },
  {
    name: "evaluate with ref",
    command: {
      command: "evaluate",
      args: { browserId: BROWSER_ID, function: "(element) => element.textContent", ref: "@e1" },
    },
    expected: {
      command: "evaluate",
      args: { browserId: BROWSER_ID, function: "(element) => element.textContent", ref: "@e1" },
    },
  },
  {
    name: "scroll",
    command: {
      command: "scroll",
      args: { browserId: BROWSER_ID, deltaX: 0, deltaY: 400 },
    },
    expected: {
      command: "scroll",
      args: { browserId: BROWSER_ID, deltaX: 0, deltaY: 400 },
    },
  },
  {
    name: "scroll with ref",
    command: {
      command: "scroll",
      args: { browserId: BROWSER_ID, ref: "@e1", deltaX: 10, deltaY: -20 },
    },
    expected: {
      command: "scroll",
      args: { browserId: BROWSER_ID, ref: "@e1", deltaX: 10, deltaY: -20 },
    },
  },
  {
    name: "resize",
    command: {
      command: "resize",
      args: { browserId: BROWSER_ID, width: 1024, height: 768 },
    },
    expected: {
      command: "resize",
      args: { browserId: BROWSER_ID, width: 1024, height: 768 },
    },
  },
  {
    name: "close_tab",
    command: {
      command: "close_tab",
      args: { browserId: BROWSER_ID },
    },
    expected: {
      command: "close_tab",
      args: { browserId: BROWSER_ID },
    },
  },
] as const;

const resultParseCases = [
  {
    name: "snapshot",
    result: {
      command: "snapshot",
      browserId: BROWSER_ID,
      workspaceId: "workspace-1",
      url: "https://example.com/form",
      title: "Fixture",
      format: "aria-yaml",
      snapshot: '- document "Fixture"\n  - textbox "Name" [ref=@e1]',
      truncated: false,
      stats: { nodeCount: 2, refCount: 1, textLength: 52, iframeCount: 0, maxDepth: 1 },
    },
    expected: {
      command: "snapshot",
      browserId: BROWSER_ID,
      workspaceId: "workspace-1",
      url: "https://example.com/form",
      title: "Fixture",
      format: "aria-yaml",
      snapshot: '- document "Fixture"\n  - textbox "Name" [ref=@e1]',
      truncated: false,
      stats: { nodeCount: 2, refCount: 1, textLength: 52, iframeCount: 0, maxDepth: 1 },
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
      command: "screenshot",
      browserId: BROWSER_ID,
      mimeType: "image/png",
      dataBase64: "iVBORw0KGgo=",
      width: 390,
      height: 1200,
    },
    expected: {
      command: "screenshot",
      browserId: BROWSER_ID,
      mimeType: "image/png",
      dataBase64: "iVBORw0KGgo=",
      width: 390,
      height: 1200,
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
    name: "evaluate",
    result: {
      command: "evaluate",
      browserId: BROWSER_ID,
      resultJson: '{"title":"Fixture"}',
      truncated: false,
    },
    expected: {
      command: "evaluate",
      browserId: BROWSER_ID,
      resultJson: '{"title":"Fixture"}',
      truncated: false,
    },
  },
  {
    name: "scroll",
    result: {
      command: "scroll",
      browserId: BROWSER_ID,
      ref: "@e1",
      deltaX: 10,
      deltaY: 400,
      x: 40,
      y: 30,
    },
    expected: {
      command: "scroll",
      browserId: BROWSER_ID,
      ref: "@e1",
      deltaX: 10,
      deltaY: 400,
      x: 40,
      y: 30,
    },
  },
  {
    name: "resize",
    result: {
      command: "resize",
      browserId: BROWSER_ID,
      width: 1024,
      height: 768,
    },
    expected: {
      command: "resize",
      browserId: BROWSER_ID,
      width: 1024,
      height: 768,
    },
  },
  {
    name: "close_tab",
    result: {
      command: "close_tab",
      browserId: BROWSER_ID,
    },
    expected: {
      command: "close_tab",
      browserId: BROWSER_ID,
    },
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
      requestId: "req-snapshot",
      workspaceId: "workspace-1",
      command: { command: "snapshot", args: { browserId: "default" } },
    });

    expect(parsed).toMatchObject({
      success: false,
      error: { issues: [expect.objectContaining({ message: BROWSER_ID_MESSAGE })] },
    });
  });

  test("tab commands parse browser ids produced by the fallback generator", () => {
    const parsed = BrowserAutomationExecuteRequestSchema.parse({
      type: "browser.automation.execute.request",
      requestId: "req-snapshot",
      workspaceId: "workspace-1",
      command: { command: "snapshot", args: { browserId: FALLBACK_BROWSER_ID } },
    });

    expect(parsed.command).toEqual({
      command: "snapshot",
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
        requestId: "req-snapshot",
        ok: true,
        result: {
          command: "snapshot",
          browserId: "default",
          workspaceId: "workspace-1",
          url: "https://example.com",
          title: "Example",
          format: "aria-yaml",
          snapshot: "- document",
          truncated: false,
          stats: { nodeCount: 1, refCount: 0, textLength: 10 },
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

  test("success responses can report handled dialogs", () => {
    const parsed = BrowserAutomationExecuteResponseSchema.parse({
      type: "browser.automation.execute.response",
      payload: {
        requestId: "req-click",
        ok: true,
        result: { command: "click", browserId: BROWSER_ID, ref: "@e1" },
        dialogs: [
          {
            type: "alert",
            message: "Saved",
            action: "accepted",
            timestamp: 123,
          },
          {
            type: "prompt",
            message: "Name?",
            defaultValue: "Maya",
            action: "dismissed",
            timestamp: 124,
          },
        ],
      },
    });

    expect(parsed.payload).toEqual({
      requestId: "req-click",
      ok: true,
      result: { command: "click", browserId: BROWSER_ID, ref: "@e1" },
      dialogs: [
        {
          type: "alert",
          message: "Saved",
          action: "accepted",
          timestamp: 123,
        },
        {
          type: "prompt",
          message: "Name?",
          defaultValue: "Maya",
          action: "dismissed",
          timestamp: 124,
        },
      ],
    });
  });

  test("error responses keep stable codes, messages, and retry defaults", () => {
    const parsed = BrowserAutomationExecuteResponseSchema.parse({
      type: "browser.automation.execute.response",
      payload: {
        requestId: "req-error",
        ok: false,
        error: {
          code: "browser_no_host",
          message: "No browser automation host is connected.",
        },
      },
    });

    expect(parsed.payload).toEqual({
      requestId: "req-error",
      ok: false,
      error: {
        code: "browser_no_host",
        message: "No browser automation host is connected.",
        retryable: false,
      },
    });
  });

  test("failure responses can report handled dialogs", () => {
    const parsed = BrowserAutomationExecuteResponseSchema.parse({
      type: "browser.automation.execute.response",
      payload: {
        requestId: "req-navigate",
        ok: false,
        error: {
          code: "browser_timeout",
          message: "Timed out waiting for browser URL: /next",
        },
        dialogs: [
          {
            type: "beforeunload",
            message: "Leave site?",
            action: "dismissed",
            timestamp: 200,
          },
        ],
      },
    });

    expect(parsed.payload).toEqual({
      requestId: "req-navigate",
      ok: false,
      error: {
        code: "browser_timeout",
        message: "Timed out waiting for browser URL: /next",
        retryable: false,
      },
      dialogs: [
        {
          type: "beforeunload",
          message: "Leave site?",
          action: "dismissed",
          timestamp: 200,
        },
      ],
    });
  });
});
