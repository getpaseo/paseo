import type { AcpToolCallSnapshot } from "@getpaseo/plugin/server/acp";
import { describe, expect, it } from "vitest";
import { fileToolTransformer } from "./file-tools.js";

const context = { sessionId: "session-1" };

// Shapes captured from `fx acp` 0.0.16.
function fxToolCall(name: string, input: AcpToolCallSnapshot["input"]): AcpToolCallSnapshot {
  return {
    id: "call_1",
    name,
    title: "Writing",
    kind: "edit",
    status: "pending",
    input,
    output: null,
    locations: [],
  };
}

function transform(toolCall: AcpToolCallSnapshot): AcpToolCallSnapshot {
  return fileToolTransformer.toolCall!(toolCall, context);
}

describe("fx file tool calls", () => {
  it("presents write_file as a write to its path", () => {
    expect(
      transform(fxToolCall("write_file", { path: "hello.txt", content: "hi\n" })).input,
    ).toEqual({ filePath: "hello.txt", newString: "hi\n" });
  });

  it("presents edit_file as a replacement in its path", () => {
    expect(
      transform(fxToolCall("edit_file", { path: "a.ts", old_string: "a", new_string: "b" })).input,
    ).toEqual({ filePath: "a.ts", oldString: "a", newString: "b" });
  });

  it("keeps the presentation when a later update reaches the same call", () => {
    const presented = transform(fxToolCall("write_file", { path: "hello.txt", content: "hi\n" }));
    expect(transform({ ...presented, status: "completed" }).input).toEqual(presented.input);
  });

  it("leaves other tools alone", () => {
    const shell = fxToolCall("shell", { path: "/tmp", command: "ls" });
    expect(transform(shell)).toEqual(shell);
  });
});
