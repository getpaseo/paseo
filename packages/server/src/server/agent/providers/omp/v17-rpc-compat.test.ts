import { describe, expect, test } from "vitest";

import { parseToolArgs, parseToolResult } from "./tool-call-detail.js";
import { OmpAgentMessageSchema, OmpAvailableCommandsUpdateEventSchema } from "./rpc-types.js";
import { mapOmpToolDetail } from "./tool-call-mapper.js";
import { shouldDisplayOmpCustomMessage } from "./custom-message.js";

describe("OMP 17 RPC compatibility", () => {
  test("parses source-attributed command updates", () => {
    const event = OmpAvailableCommandsUpdateEventSchema.parse({
      type: "available_commands_update",
      commands: [{ name: "prewalk", description: "Prewalk at the next action", source: "builtin" }],
    });

    expect(event.commands).toEqual([
      { name: "prewalk", description: "Prewalk at the next action", source: "builtin" },
    ]);
  });

  test("keeps non-false custom display metadata backward compatible", () => {
    const message = OmpAgentMessageSchema.parse({
      role: "custom",
      content: "visible custom message",
      display: null,
    });

    expect(message).toMatchObject({ display: null });
    if (message.role !== "custom") {
      throw new Error("Expected a custom OMP message");
    }
    expect(shouldDisplayOmpCustomMessage(message)).toBe(true);
  });

  test("maps subscribed custom tool events without assuming built-in names", () => {
    const event = {
      type: "tool_execution_start",
      toolCallId: "hub-call",
      toolName: "hub",
      args: { op: "list" },
    };

    expect(mapOmpToolDetail(parseToolArgs(event.toolName, event.args), null)).toEqual({
      type: "unknown",
      input: { op: "list" },
      output: null,
    });
  });

  test("parses arbitrary custom tool results", () => {
    expect(
      parseToolResult({
        content: [{ type: "text", text: "No peers registered" }],
        details: { op: "list", peers: [] },
      }),
    ).toEqual({
      content: [{ type: "text", text: "No peers registered" }],
      details: { op: "list", peers: [] },
    });
  });
});
