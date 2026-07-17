import { describe, expect, test } from "vitest";

import { parseToolArgs, parseToolResult } from "./tool-call-detail.js";
import { OmpAvailableCommandsUpdateEventSchema } from "./rpc-types.js";
import { mapOmpToolDetail } from "./tool-call-mapper.js";

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
