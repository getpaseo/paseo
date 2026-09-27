import { describe, expect, it } from "vitest";
import { readBrowserHandoffToolCall } from "./handoff";

const BROWSER_ID = "11111111-1111-4111-8111-111111111111";
const HANDOFF_ID = "22222222-2222-4222-8222-222222222222";
const INPUT = { browserId: BROWSER_ID, reason: "Sign in to example.com" };
const TEXT = `Handed browser tab ${BROWSER_ID} to the user (handoffId=${HANDOFF_ID}): "Sign in".`;

describe("readBrowserHandoffToolCall", () => {
  it("reads the handoff id however the provider wraps the MCP result", () => {
    const outputs = [
      { content: [{ type: "text", text: TEXT }], structuredContent: { handoffId: HANDOFF_ID } },
      [{ type: "text", text: TEXT }],
      TEXT,
    ];
    for (const output of outputs) {
      expect(
        readBrowserHandoffToolCall("mcp__paseo__browser_handoff", {
          type: "unknown",
          input: INPUT,
          output,
        }),
      ).toEqual({ ...INPUT, handoffId: HANDOFF_ID });
    }
  });

  it("waits for the result and ignores other tools", () => {
    expect(
      readBrowserHandoffToolCall("paseo.browser_handoff", {
        type: "unknown",
        input: INPUT,
        output: null,
      }),
    ).toEqual({ ...INPUT, handoffId: null });
    expect(
      readBrowserHandoffToolCall("paseo.browser_snapshot", {
        type: "unknown",
        input: INPUT,
        output: null,
      }),
    ).toBeNull();
  });
});
