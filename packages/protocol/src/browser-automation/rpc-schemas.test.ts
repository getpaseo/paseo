import { describe, expect, test } from "vitest";

import {
  BrowserAutomationExecuteRequestSchema,
  BrowserAutomationExecuteResponseSchema,
} from "./rpc-schemas.js";

describe("browser automation execute RPC schemas", () => {
  test("rejects navigate and download commands for non-http URLs", () => {
    for (const command of ["navigate", "download"] as const) {
      expect(() =>
        BrowserAutomationExecuteRequestSchema.parse({
          type: "browser.automation.execute.request",
          requestId: `req-${command}`,
          command: {
            command,
            args: { url: "file:///tmp/secret.txt" },
          },
        }),
      ).toThrow();
    }
  });

  test("parses list tabs requests with top-level correlation and typed command args", () => {
    const parsed = BrowserAutomationExecuteRequestSchema.parse({
      type: "browser.automation.execute.request",
      requestId: "req-1",
      workspaceId: "workspace-1",
      command: {
        command: "list_tabs",
        args: { workspaceId: "workspace-1" },
      },
    });

    expect(parsed).toEqual({
      type: "browser.automation.execute.request",
      requestId: "req-1",
      workspaceId: "workspace-1",
      command: {
        command: "list_tabs",
        args: { workspaceId: "workspace-1" },
      },
    });
  });

  test("parses new tab requests and responses", () => {
    expect(
      BrowserAutomationExecuteRequestSchema.parse({
        type: "browser.automation.execute.request",
        requestId: "req-new-tab",
        workspaceId: "workspace-1",
        command: {
          command: "new_tab",
          args: { workspaceId: "workspace-1", url: "https://example.com" },
        },
      }).command,
    ).toEqual({
      command: "new_tab",
      args: { workspaceId: "workspace-1", url: "https://example.com" },
    });

    expect(
      BrowserAutomationExecuteResponseSchema.parse({
        type: "browser.automation.execute.response",
        payload: {
          requestId: "req-new-tab",
          ok: true,
          result: {
            command: "new_tab",
            browserId: "browser-1",
            workspaceId: "workspace-1",
            url: "https://example.com",
          },
        },
      }).payload,
    ).toEqual({
      requestId: "req-new-tab",
      ok: true,
      result: {
        command: "new_tab",
        browserId: "browser-1",
        workspaceId: "workspace-1",
        url: "https://example.com",
      },
    });
  });

  test("parses page info responses with result data under payload", () => {
    const parsed = BrowserAutomationExecuteResponseSchema.parse({
      type: "browser.automation.execute.response",
      payload: {
        requestId: "req-1",
        ok: true,
        result: {
          command: "page_info",
          tab: {
            browserId: "browser-1",
            workspaceId: "workspace-1",
            url: "https://example.com",
            title: "Example",
          },
        },
      },
    });

    expect(parsed.payload).toEqual({
      requestId: "req-1",
      ok: true,
      result: {
        command: "page_info",
        tab: {
          browserId: "browser-1",
          workspaceId: "workspace-1",
          url: "https://example.com",
          title: "Example",
          isActive: false,
          isLoading: false,
        },
      },
    });
  });

  test("parses snapshot requests and ref-bearing snapshot responses", () => {
    expect(
      BrowserAutomationExecuteRequestSchema.parse({
        type: "browser.automation.execute.request",
        requestId: "req-snapshot",
        workspaceId: "workspace-1",
        command: {
          command: "snapshot",
          args: { workspaceId: "workspace-1", browserId: "browser-1" },
        },
      }),
    ).toEqual({
      type: "browser.automation.execute.request",
      requestId: "req-snapshot",
      workspaceId: "workspace-1",
      command: {
        command: "snapshot",
        args: { workspaceId: "workspace-1", browserId: "browser-1" },
      },
    });

    const parsed = BrowserAutomationExecuteResponseSchema.parse({
      type: "browser.automation.execute.response",
      payload: {
        requestId: "req-snapshot",
        ok: true,
        result: {
          command: "snapshot",
          browserId: "browser-1",
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
    });

    expect(parsed.payload).toEqual({
      requestId: "req-snapshot",
      ok: true,
      result: {
        command: "snapshot",
        browserId: "browser-1",
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
    });
  });

  test("parses click and fill ref commands", () => {
    expect(
      BrowserAutomationExecuteRequestSchema.parse({
        type: "browser.automation.execute.request",
        requestId: "req-click",
        command: {
          command: "click",
          args: { workspaceId: "workspace-1", browserId: "browser-1", ref: "@e1" },
        },
      }).command,
    ).toEqual({
      command: "click",
      args: { workspaceId: "workspace-1", browserId: "browser-1", ref: "@e1" },
    });

    expect(
      BrowserAutomationExecuteRequestSchema.parse({
        type: "browser.automation.execute.request",
        requestId: "req-fill",
        command: {
          command: "fill",
          args: { workspaceId: "workspace-1", ref: "@e2", value: "Ada" },
        },
      }).command,
    ).toEqual({
      command: "fill",
      args: { workspaceId: "workspace-1", ref: "@e2", value: "Ada" },
    });

    expect(
      BrowserAutomationExecuteResponseSchema.parse({
        type: "browser.automation.execute.response",
        payload: {
          requestId: "req-fill",
          ok: true,
          result: { command: "fill", browserId: "browser-1", ref: "@e2" },
        },
      }).payload,
    ).toEqual({
      requestId: "req-fill",
      ok: true,
      result: { command: "fill", browserId: "browser-1", ref: "@e2" },
    });
  });

  test("parses wait text commands and responses", () => {
    expect(
      BrowserAutomationExecuteRequestSchema.parse({
        type: "browser.automation.execute.request",
        requestId: "req-wait",
        command: {
          command: "wait",
          args: { workspaceId: "workspace-1", text: "Ready", timeoutMs: 1000 },
        },
      }).command,
    ).toEqual({
      command: "wait",
      args: { workspaceId: "workspace-1", text: "Ready", timeoutMs: 1000 },
    });

    expect(
      BrowserAutomationExecuteResponseSchema.parse({
        type: "browser.automation.execute.response",
        payload: {
          requestId: "req-wait",
          ok: true,
          result: { command: "wait", browserId: "browser-1", matched: "text" },
        },
      }).payload,
    ).toEqual({
      requestId: "req-wait",
      ok: true,
      result: { command: "wait", browserId: "browser-1", matched: "text" },
    });
  });

  test("parses set background commands and responses", () => {
    expect(
      BrowserAutomationExecuteRequestSchema.parse({
        type: "browser.automation.execute.request",
        requestId: "req-bg",
        command: {
          command: "set_background",
          args: { workspaceId: "workspace-1", color: "red" },
        },
      }).command,
    ).toEqual({
      command: "set_background",
      args: { workspaceId: "workspace-1", color: "red" },
    });

    expect(
      BrowserAutomationExecuteResponseSchema.parse({
        type: "browser.automation.execute.response",
        payload: {
          requestId: "req-bg",
          ok: true,
          result: { command: "set_background", browserId: "browser-1", color: "red" },
        },
      }).payload,
    ).toEqual({
      requestId: "req-bg",
      ok: true,
      result: { command: "set_background", browserId: "browser-1", color: "red" },
    });
  });

  test("parses type and keypress commands", () => {
    expect(
      BrowserAutomationExecuteRequestSchema.parse({
        type: "browser.automation.execute.request",
        requestId: "req-type",
        command: { command: "type", args: { browserId: "browser-1", ref: "@e1", text: "Ada" } },
      }).command,
    ).toEqual({ command: "type", args: { browserId: "browser-1", ref: "@e1", text: "Ada" } });

    expect(
      BrowserAutomationExecuteRequestSchema.parse({
        type: "browser.automation.execute.request",
        requestId: "req-keypress",
        command: { command: "keypress", args: { browserId: "browser-1", key: "Enter" } },
      }).command,
    ).toEqual({ command: "keypress", args: { browserId: "browser-1", key: "Enter" } });
  });

  test("parses navigation commands", () => {
    expect(
      BrowserAutomationExecuteRequestSchema.parse({
        type: "browser.automation.execute.request",
        requestId: "req-nav",
        command: {
          command: "navigate",
          args: { browserId: "browser-1", url: "https://example.com/next" },
        },
      }).command,
    ).toEqual({
      command: "navigate",
      args: { browserId: "browser-1", url: "https://example.com/next" },
    });

    expect(
      BrowserAutomationExecuteResponseSchema.parse({
        type: "browser.automation.execute.response",
        payload: {
          requestId: "req-nav",
          ok: true,
          result: { command: "navigate", browserId: "browser-1", url: "https://example.com/next" },
        },
      }).payload,
    ).toEqual({
      requestId: "req-nav",
      ok: true,
      result: { command: "navigate", browserId: "browser-1", url: "https://example.com/next" },
    });
  });

  test("parses screenshot responses", () => {
    expect(
      BrowserAutomationExecuteResponseSchema.parse({
        type: "browser.automation.execute.response",
        payload: {
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
      }).payload,
    ).toEqual({
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
    });
  });

  test("parses form control commands and responses", () => {
    expect(
      BrowserAutomationExecuteRequestSchema.parse({
        type: "browser.automation.execute.request",
        requestId: "req-focus",
        command: { command: "focus", args: { browserId: "browser-1", ref: "@e1" } },
      }).command,
    ).toEqual({ command: "focus", args: { browserId: "browser-1", ref: "@e1" } });

    expect(
      BrowserAutomationExecuteRequestSchema.parse({
        type: "browser.automation.execute.request",
        requestId: "req-clear",
        command: { command: "clear", args: { browserId: "browser-1", ref: "@e1" } },
      }).command,
    ).toEqual({ command: "clear", args: { browserId: "browser-1", ref: "@e1" } });

    expect(
      BrowserAutomationExecuteRequestSchema.parse({
        type: "browser.automation.execute.request",
        requestId: "req-check",
        command: { command: "check", args: { browserId: "browser-1", ref: "@e2" } },
      }).command,
    ).toEqual({ command: "check", args: { browserId: "browser-1", ref: "@e2", checked: true } });

    expect(
      BrowserAutomationExecuteRequestSchema.parse({
        type: "browser.automation.execute.request",
        requestId: "req-select",
        command: { command: "select", args: { browserId: "browser-1", ref: "@e3", value: "us" } },
      }).command,
    ).toEqual({ command: "select", args: { browserId: "browser-1", ref: "@e3", value: "us" } });

    expect(
      BrowserAutomationExecuteRequestSchema.parse({
        type: "browser.automation.execute.request",
        requestId: "req-hover",
        command: { command: "hover", args: { browserId: "browser-1", ref: "@e4" } },
      }).command,
    ).toEqual({ command: "hover", args: { browserId: "browser-1", ref: "@e4" } });

    expect(
      BrowserAutomationExecuteRequestSchema.parse({
        type: "browser.automation.execute.request",
        requestId: "req-drag",
        command: {
          command: "drag",
          args: { browserId: "browser-1", sourceRef: "@e4", targetRef: "@e5" },
        },
      }).command,
    ).toEqual({
      command: "drag",
      args: { browserId: "browser-1", sourceRef: "@e4", targetRef: "@e5" },
    });

    expect(
      BrowserAutomationExecuteResponseSchema.parse({
        type: "browser.automation.execute.response",
        payload: {
          requestId: "req-select",
          ok: true,
          result: { command: "select", browserId: "browser-1", ref: "@e3", value: "us" },
        },
      }).payload,
    ).toEqual({
      requestId: "req-select",
      ok: true,
      result: { command: "select", browserId: "browser-1", ref: "@e3", value: "us" },
    });
  });

  test("parses browser log commands and responses", () => {
    expect(
      BrowserAutomationExecuteRequestSchema.parse({
        type: "browser.automation.execute.request",
        requestId: "req-logs",
        command: { command: "logs", args: { browserId: "browser-1" } },
      }).command,
    ).toEqual({ command: "logs", args: { browserId: "browser-1", maxEntries: 50 } });

    expect(
      BrowserAutomationExecuteResponseSchema.parse({
        type: "browser.automation.execute.response",
        payload: {
          requestId: "req-logs",
          ok: true,
          result: {
            command: "logs",
            browserId: "browser-1",
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
      }).payload,
    ).toEqual({
      requestId: "req-logs",
      ok: true,
      result: {
        command: "logs",
        browserId: "browser-1",
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
    });
  });

  test("parses browser storage commands and responses", () => {
    expect(
      BrowserAutomationExecuteRequestSchema.parse({
        type: "browser.automation.execute.request",
        requestId: "req-storage",
        command: { command: "storage", args: { browserId: "browser-1" } },
      }).command,
    ).toEqual({ command: "storage", args: { browserId: "browser-1" } });

    expect(
      BrowserAutomationExecuteResponseSchema.parse({
        type: "browser.automation.execute.response",
        payload: {
          requestId: "req-storage",
          ok: true,
          result: {
            command: "storage",
            browserId: "browser-1",
            url: "https://example.com",
            cookies: [{ name: "theme", value: "dark", domain: "example.com", httpOnly: true }],
            localStorage: [{ key: "token", value: "abc" }],
            sessionStorage: [{ key: "tab", value: "1" }],
          },
        },
      }).payload,
    ).toEqual({
      requestId: "req-storage",
      ok: true,
      result: {
        command: "storage",
        browserId: "browser-1",
        url: "https://example.com",
        cookies: [{ name: "theme", value: "dark", domain: "example.com", httpOnly: true }],
        localStorage: [{ key: "token", value: "abc" }],
        sessionStorage: [{ key: "tab", value: "1" }],
      },
    });
  });

  test("parses browser environment commands and responses", () => {
    expect(
      BrowserAutomationExecuteRequestSchema.parse({
        type: "browser.automation.execute.request",
        requestId: "req-environment",
        command: {
          command: "environment",
          args: {
            browserId: "browser-1",
            viewport: { width: 390, height: 844, deviceScaleFactor: 3 },
            geolocation: { latitude: 37.7749, longitude: -122.4194, accuracy: 5 },
          },
        },
      }).command,
    ).toEqual({
      command: "environment",
      args: {
        browserId: "browser-1",
        viewport: { width: 390, height: 844, deviceScaleFactor: 3 },
        geolocation: { latitude: 37.7749, longitude: -122.4194, accuracy: 5 },
      },
    });

    expect(
      BrowserAutomationExecuteResponseSchema.parse({
        type: "browser.automation.execute.response",
        payload: {
          requestId: "req-environment",
          ok: true,
          result: {
            command: "environment",
            browserId: "browser-1",
            viewport: { width: 390, height: 844, deviceScaleFactor: 3 },
            geolocation: { latitude: 37.7749, longitude: -122.4194, accuracy: 5 },
          },
        },
      }).payload,
    ).toEqual({
      requestId: "req-environment",
      ok: true,
      result: {
        command: "environment",
        browserId: "browser-1",
        viewport: { width: 390, height: 844, deviceScaleFactor: 3 },
        geolocation: { latitude: 37.7749, longitude: -122.4194, accuracy: 5 },
      },
    });
  });

  test("parses browser full-page screenshot and PDF commands and responses", () => {
    expect(
      BrowserAutomationExecuteRequestSchema.parse({
        type: "browser.automation.execute.request",
        requestId: "req-full-page",
        command: { command: "full_page_screenshot", args: { browserId: "browser-1" } },
      }).command,
    ).toEqual({ command: "full_page_screenshot", args: { browserId: "browser-1" } });

    expect(
      BrowserAutomationExecuteRequestSchema.parse({
        type: "browser.automation.execute.request",
        requestId: "req-pdf",
        command: { command: "pdf", args: { browserId: "browser-1" } },
      }).command,
    ).toEqual({ command: "pdf", args: { browserId: "browser-1", printBackground: true } });

    expect(
      BrowserAutomationExecuteResponseSchema.parse({
        type: "browser.automation.execute.response",
        payload: {
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
      }).payload.result,
    ).toEqual({
      command: "full_page_screenshot",
      browserId: "browser-1",
      mimeType: "image/png",
      dataBase64: "iVBORw0KGgo=",
      width: 390,
      height: 1200,
    });

    expect(
      BrowserAutomationExecuteResponseSchema.parse({
        type: "browser.automation.execute.response",
        payload: {
          requestId: "req-pdf",
          ok: true,
          result: {
            command: "pdf",
            browserId: "browser-1",
            mimeType: "application/pdf",
            dataBase64: "JVBERi0xLjQ=",
          },
        },
      }).payload.result,
    ).toEqual({
      command: "pdf",
      browserId: "browser-1",
      mimeType: "application/pdf",
      dataBase64: "JVBERi0xLjQ=",
    });
  });

  test("parses browser download and upload commands and responses", () => {
    expect(
      BrowserAutomationExecuteRequestSchema.parse({
        type: "browser.automation.execute.request",
        requestId: "req-download",
        command: {
          command: "download",
          args: { browserId: "browser-1", url: "https://example.com/file.txt" },
        },
      }).command,
    ).toEqual({
      command: "download",
      args: { browserId: "browser-1", url: "https://example.com/file.txt" },
    });

    expect(
      BrowserAutomationExecuteRequestSchema.parse({
        type: "browser.automation.execute.request",
        requestId: "req-upload",
        command: {
          command: "upload",
          args: { browserId: "browser-1", ref: "@e1", filePaths: ["/tmp/file.txt"] },
        },
      }).command,
    ).toEqual({
      command: "upload",
      args: { browserId: "browser-1", ref: "@e1", filePaths: ["/tmp/file.txt"] },
    });

    expect(
      BrowserAutomationExecuteResponseSchema.parse({
        type: "browser.automation.execute.response",
        payload: {
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
      }).payload.result,
    ).toEqual({
      command: "download",
      browserId: "browser-1",
      url: "https://example.com/file.txt",
      filePath: "/tmp/file.txt",
      totalBytes: 5,
      state: "completed",
    });

    expect(
      BrowserAutomationExecuteResponseSchema.parse({
        type: "browser.automation.execute.response",
        payload: {
          requestId: "req-upload",
          ok: true,
          result: {
            command: "upload",
            browserId: "browser-1",
            ref: "@e1",
            filePaths: ["/tmp/file.txt"],
          },
        },
      }).payload.result,
    ).toEqual({
      command: "upload",
      browserId: "browser-1",
      ref: "@e1",
      filePaths: ["/tmp/file.txt"],
    });
  });

  test("parses stable model-actionable error responses", () => {
    const parsed = BrowserAutomationExecuteResponseSchema.parse({
      type: "browser.automation.execute.response",
      payload: {
        requestId: "req-1",
        ok: false,
        error: {
          code: "browser_no_desktop",
          message: "No desktop browser automation client is connected.",
        },
      },
    });

    expect(parsed.payload).toEqual({
      requestId: "req-1",
      ok: false,
      error: {
        code: "browser_no_desktop",
        message: "No desktop browser automation client is connected.",
        retryable: false,
      },
    });
  });
});
