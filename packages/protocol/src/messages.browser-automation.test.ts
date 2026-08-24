import { describe, expect, test } from "vitest";

import { BROWSER_AUTOMATION_COMMAND_NAMES } from "./browser-automation/rpc-schemas.js";
import { CLIENT_CAPS } from "./client-capabilities.js";
import {
  MutableDaemonConfigPatchSchema,
  MutableDaemonConfigSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  WSHelloMessageSchema,
} from "./messages.js";

describe("browser automation protocol integration", () => {
  const browserId = "11111111-1111-4111-8111-111111111111";

  test("browser host capability parses supported commands in hello", () => {
    expect(
      WSHelloMessageSchema.parse({
        type: "hello",
        clientId: "client-1",
        clientType: "mobile",
        protocolVersion: 1,
        capabilities: {
          [CLIENT_CAPS.browserHost]: {
            supportedCommands: [...BROWSER_AUTOMATION_COMMAND_NAMES],
            hostKind: "desktop app",
          },
        },
      }).capabilities,
    ).toMatchObject({
      [CLIENT_CAPS.browserHost]: {
        supportedCommands: [...BROWSER_AUTOMATION_COMMAND_NAMES],
        hostKind: "desktop app",
      },
    });
  });

  test("browser host capability requires at least one supported command", () => {
    expect(() =>
      WSHelloMessageSchema.parse({
        type: "hello",
        clientId: "client-1",
        clientType: "mobile",
        protocolVersion: 1,
        capabilities: {
          [CLIENT_CAPS.browserHost]: {
            supportedCommands: [],
            hostKind: "desktop app",
          },
        },
      }),
    ).toThrow();

    expect(() =>
      WSHelloMessageSchema.parse({
        type: "hello",
        clientId: "client-2",
        clientType: "mobile",
        protocolVersion: 1,
        capabilities: {
          [CLIENT_CAPS.browserHost]: {},
        },
      }),
    ).toThrow();

    expect(() =>
      WSHelloMessageSchema.parse({
        type: "hello",
        clientId: "client-3",
        clientType: "mobile",
        protocolVersion: 1,
        capabilities: {
          [CLIENT_CAPS.browserHost]: {
            supportedCommands: ["future_command"],
          },
        },
      }),
    ).toThrow();
  });

  test("browser host capability ignores unknown future commands when known commands remain", () => {
    expect(
      WSHelloMessageSchema.parse({
        type: "hello",
        clientId: "client-1",
        clientType: "mobile",
        protocolVersion: 1,
        capabilities: {
          [CLIENT_CAPS.browserHost]: {
            supportedCommands: ["list_tabs", "future_command", "list_tabs"],
            hostKind: "desktop app",
          },
        },
      }).capabilities,
    ).toMatchObject({
      [CLIENT_CAPS.browserHost]: {
        supportedCommands: ["list_tabs"],
        hostKind: "desktop app",
      },
    });
  });

  test("browser host capability accepts new tool commands as supported commands", () => {
    expect(
      WSHelloMessageSchema.parse({
        type: "hello",
        clientId: "client-1",
        clientType: "mobile",
        protocolVersion: 1,
        capabilities: {
          [CLIENT_CAPS.browserHost]: {
            supportedCommands: ["evaluate", "scroll", "resize", "close_tab"],
            hostKind: "desktop app",
          },
        },
      }).capabilities,
    ).toMatchObject({
      [CLIENT_CAPS.browserHost]: {
        supportedCommands: ["evaluate", "scroll", "resize", "close_tab"],
        hostKind: "desktop app",
      },
    });
  });

  test("hello remains valid when no browser host capability is advertised", () => {
    expect(
      WSHelloMessageSchema.parse({
        type: "hello",
        clientId: "old-client",
        clientType: "mobile",
        protocolVersion: 1,
      }).capabilities,
    ).toBeUndefined();
  });

  test("daemon to browser host execute request is an outbound session message", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "browser.automation.execute.request",
      requestId: "req-1",
      command: { command: "snapshot", args: { browserId } },
    });

    expect(parsed.type).toBe("browser.automation.execute.request");
  });

  test("browser host to daemon execute response is an inbound session message", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "browser.automation.execute.response",
      payload: {
        requestId: "req-1",
        ok: true,
        result: { command: "list_tabs", tabs: [] },
      },
    });

    expect(parsed.type).toBe("browser.automation.execute.response");
  });

  test("a viewer may drive a mirrored tab", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "browser.tab.execute.request",
      requestId: "req-1",
      command: {
        command: "input_at",
        args: { browserId, event: { kind: "click", x: 10, y: 20 } },
      },
    });

    expect(parsed.type).toBe("browser.tab.execute.request");
  });

  test("a viewer cannot reach the daemon-owned screencast commands", () => {
    for (const command of [
      { command: "screencast_start", args: { browserId, slot: 0 } },
      { command: "screencast_stop", args: { browserId } },
    ]) {
      expect(() =>
        SessionInboundMessageSchema.parse({
          type: "browser.tab.execute.request",
          requestId: "req-1",
          command,
        }),
      ).toThrow();
    }
  });

  test("a viewer cannot reach the agent-only automation commands", () => {
    for (const command of [
      { command: "evaluate", args: { browserId, function: "() => document.title" } },
      { command: "upload", args: { browserId, ref: "@e1", filePaths: ["/tmp/a.png"] } },
      { command: "snapshot", args: { browserId } },
    ]) {
      expect(() =>
        SessionInboundMessageSchema.parse({
          type: "browser.tab.execute.request",
          requestId: "req-1",
          command,
        }),
      ).toThrow();
    }
  });

  test("input_at separates a complete click from a single pointer phase", () => {
    expect(() =>
      SessionInboundMessageSchema.parse({
        type: "browser.tab.execute.request",
        requestId: "req-1",
        command: {
          command: "input_at",
          args: { browserId, event: { kind: "pointer", x: 10, y: 20 } },
        },
      }),
    ).toThrow();

    const parsed = SessionInboundMessageSchema.parse({
      type: "browser.tab.execute.request",
      requestId: "req-1",
      command: {
        command: "input_at",
        args: { browserId, event: { kind: "pointer", phase: "down", x: 10, y: 20 } },
      },
    });

    expect(parsed).toMatchObject({
      command: {
        args: {
          event: { kind: "pointer", phase: "down", button: "left", clickCount: 1, modifiers: [] },
        },
      },
    });
  });

  test("mutable daemon config defaults browser tools off and accepts opt-in patches", () => {
    expect(
      MutableDaemonConfigSchema.parse({
        mcp: { injectIntoAgents: false },
      }).browserTools,
    ).toEqual({ enabled: false });

    expect(
      MutableDaemonConfigPatchSchema.parse({
        browserTools: { enabled: true },
      }).browserTools,
    ).toEqual({ enabled: true });
  });
});
