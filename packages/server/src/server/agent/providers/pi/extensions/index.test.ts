import { describe, expect, test } from "vitest";
import { createPiExtensionHost } from "./index.js";
import { PiHistoryMapper } from "../history-mapper.js";
import { parseToolArgs, parseToolResult } from "../tool-call-mapper.js";

describe("Pi extension host", () => {
  test("claims a tool, declines an unrelated one, and maps history like live events", () => {
    const host = createPiExtensionHost();
    const args = { agent: "scout", task: "Inspect files" };
    const result = parseToolResult({ content: [{ type: "text", text: "Found two files" }] });
    const live = host.mapToolCall({
      callId: "call-1",
      toolName: "subagent",
      args,
      status: "completed",
      result,
    });
    expect(live).toEqual(
      expect.objectContaining({
        detail: {
          type: "sub_agent",
          subAgentType: "scout",
          description: "Inspect files",
          log: "Found two files",
        },
      }),
    );
    expect(
      host.mapToolCall({
        callId: "call-2",
        toolName: "unrelated",
        args: {},
        status: "completed",
        result,
      }),
    ).toBeUndefined();

    const mapper = new PiHistoryMapper("pi");
    const events = mapper.mapMessages([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "subagent", arguments: args }],
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "subagent",
        content: [{ type: "text", text: "Found two files" }],
      },
    ]);
    const completed = events.find(
      (event) =>
        event.type === "timeline" &&
        event.item.type === "tool_call" &&
        event.item.status === "completed",
    );
    expect(
      completed?.type === "timeline" && completed.item.type === "tool_call"
        ? completed.item.detail
        : null,
    ).toEqual(live?.detail);
    expect(parseToolArgs("subagent", args).toolName).toBe("subagent");
  });
});
