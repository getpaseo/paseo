import { describe, expect, it } from "vitest";

import { TerminalInputSchema } from "./messages.js";

describe("terminal resize messages", () => {
  it.each(["claim", "update"] as const)("accepts the optional %s intent", (intent) => {
    const result = TerminalInputSchema.safeParse({
      type: "terminal_input",
      terminalId: "terminal-1",
      message: { type: "resize", rows: 24, cols: 80, intent },
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        message: { type: "resize", rows: 24, cols: 80, intent },
      },
    });
  });

  it("accepts legacy resize messages without an intent", () => {
    const result = TerminalInputSchema.safeParse({
      type: "terminal_input",
      terminalId: "terminal-1",
      message: { type: "resize", rows: 24, cols: 80 },
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        message: { type: "resize", rows: 24, cols: 80 },
      },
    });
  });

  it.each(["claim", "update"] as const)("accepts palette messages with %s intent", (intent) => {
    const defaultColors = {
      foreground: "#1a1a1e",
      background: "#ffffff",
      cursor: "#1a1a1e",
    };
    const result = TerminalInputSchema.safeParse({
      type: "terminal_input",
      terminalId: "terminal-1",
      message: { type: "palette", defaultColors, intent },
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        message: { type: "palette", defaultColors, intent },
      },
    });
  });

  it("rejects palette messages with invalid hex colors", () => {
    const result = TerminalInputSchema.safeParse({
      type: "terminal_input",
      terminalId: "terminal-1",
      message: {
        type: "palette",
        defaultColors: { foreground: "white", background: "#ffffff" },
        intent: "claim",
      },
    });

    expect(result.success).toBe(false);
  });
});
