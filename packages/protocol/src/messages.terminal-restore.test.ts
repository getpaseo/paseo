import { describe, expect, test } from "vitest";

import { ServerInfoStatusPayloadSchema, SubscribeTerminalRequestSchema } from "./messages.js";

describe("terminal restore schemas", () => {
  test("accepts legacy terminal subscribe requests without restore options", () => {
    expect(
      SubscribeTerminalRequestSchema.parse({
        type: "subscribe_terminal_request",
        terminalId: "term-1",
        requestId: "req-1",
      }),
    ).toEqual({
      type: "subscribe_terminal_request",
      terminalId: "term-1",
      requestId: "req-1",
    });
  });

  test("accepts kebab-case terminal restore modes", () => {
    for (const mode of ["live", "visible-snapshot", "full-snapshot"] as const) {
      expect(
        SubscribeTerminalRequestSchema.parse({
          type: "subscribe_terminal_request",
          terminalId: "term-1",
          requestId: `req-${mode}`,
          restore: {
            mode,
            scrollbackLines: 200,
            size: { rows: 24, cols: 80 },
          },
        }).restore?.mode,
      ).toBe(mode);
    }
  });

  test("rejects camel-case terminal restore modes", () => {
    expect(() =>
      SubscribeTerminalRequestSchema.parse({
        type: "subscribe_terminal_request",
        terminalId: "term-1",
        requestId: "req-1",
        restore: {
          mode: "visibleSnapshot",
        },
      }),
    ).toThrow();
  });

  test("accepts terminal restore mode feature metadata", () => {
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "server-1",
        features: {
          "terminal-restore-modes": true,
        },
      }).features?.["terminal-restore-modes"],
    ).toBe(true);
  });
});
