import { describe, expect, it } from "vitest";

import { deriveOpenCodeV2ToolDetail, mapOpenCodeV2ToolCall } from "./tool-call-mapper.js";

describe("mapOpenCodeV2ToolCall", () => {
  it("returns null without a call id", () => {
    expect(mapOpenCodeV2ToolCall({ toolName: "bash", callId: null, input: {} })).toBeNull();
  });

  it("maps a running shell call", () => {
    const item = mapOpenCodeV2ToolCall({
      toolName: "bash",
      callId: "tool-1",
      input: { command: "ls -la" },
      status: "running",
    });
    expect(item).toMatchObject({
      type: "tool_call",
      callId: "tool-1",
      name: "bash",
      status: "running",
      error: null,
      detail: { type: "shell", command: "ls -la" },
    });
  });

  it("maps a completed shell call with output", () => {
    const item = mapOpenCodeV2ToolCall({
      toolName: "bash",
      callId: "tool-1",
      input: { command: "echo hi" },
      output: "hi",
      status: "completed",
    });
    expect(item).toMatchObject({
      type: "tool_call",
      callId: "tool-1",
      status: "completed",
      error: null,
    });
    if (item?.detail.type === "shell") {
      expect(item.detail.output).toContain("hi");
    } else {
      throw new Error("expected shell detail");
    }
  });

  it("maps a failed call with the structured error", () => {
    const item = mapOpenCodeV2ToolCall({
      toolName: "bash",
      callId: "tool-1",
      input: { command: "false" },
      error: { type: "tool.execution", message: "boom" },
      status: "failed",
    });
    expect(item).toMatchObject({
      type: "tool_call",
      callId: "tool-1",
      status: "failed",
      error: { type: "tool.execution", message: "boom" },
    });
  });

  it("maps a read call", () => {
    const item = mapOpenCodeV2ToolCall({
      toolName: "read",
      callId: "tool-2",
      input: { filePath: "/workspace/README.md" },
      status: "completed",
    });
    expect(item).toMatchObject({
      type: "tool_call",
      callId: "tool-2",
      name: "read",
      status: "completed",
      detail: { type: "read", filePath: "/workspace/README.md" },
    });
  });

  it("maps a write call", () => {
    const item = mapOpenCodeV2ToolCall({
      toolName: "write",
      callId: "tool-3",
      input: { filePath: "/workspace/a.txt", content: "hello" },
      status: "completed",
    });
    expect(item).toMatchObject({
      type: "tool_call",
      callId: "tool-3",
      name: "write",
      status: "completed",
      detail: { type: "write", filePath: "/workspace/a.txt" },
    });
  });

  it("maps an edit call", () => {
    const item = mapOpenCodeV2ToolCall({
      toolName: "edit",
      callId: "tool-4",
      input: { filePath: "/workspace/a.txt", oldString: "a", newString: "b" },
      status: "completed",
    });
    expect(item).toMatchObject({
      type: "tool_call",
      callId: "tool-4",
      name: "edit",
      status: "completed",
      detail: { type: "edit", filePath: "/workspace/a.txt" },
    });
  });

  it("maps a grep call", () => {
    const item = mapOpenCodeV2ToolCall({
      toolName: "grep",
      callId: "tool-5",
      input: { pattern: "foo", path: "/workspace" },
      status: "completed",
    });
    expect(item).toMatchObject({
      type: "tool_call",
      callId: "tool-5",
      name: "grep",
      status: "completed",
      detail: { type: "search", query: "foo", toolName: "grep" },
    });
  });

  it("maps a webfetch call", () => {
    const item = mapOpenCodeV2ToolCall({
      toolName: "webfetch",
      callId: "tool-6",
      input: { url: "https://example.com", prompt: "Summarize" },
      status: "completed",
    });
    expect(item).toMatchObject({
      type: "tool_call",
      callId: "tool-6",
      name: "webfetch",
      status: "completed",
      detail: { type: "fetch", url: "https://example.com", prompt: "Summarize" },
    });
  });

  it("maps a subagent call to a sub_agent detail", () => {
    const item = mapOpenCodeV2ToolCall({
      toolName: "task",
      callId: "tool-7",
      input: { agent: "general", description: "Investigate" },
      output: "found the bug",
      status: "completed",
      metadata: { sessionID: "child-1" },
    });
    expect(item).toMatchObject({
      type: "tool_call",
      callId: "tool-7",
      name: "task",
      status: "completed",
      detail: {
        type: "sub_agent",
        subAgentType: "general",
        description: "Investigate",
        childSessionId: "child-1",
      },
    });
  });

  it("falls back to an unknown detail for unrecognized tools", () => {
    const item = mapOpenCodeV2ToolCall({
      toolName: "mystery_tool",
      callId: "tool-8",
      input: { whatever: 1 },
      status: "running",
    });
    expect(item).toMatchObject({
      type: "tool_call",
      callId: "tool-8",
      name: "mystery_tool",
      status: "running",
      detail: { type: "unknown" },
    });
  });

  it("derives a failed status from an error even without an explicit status", () => {
    const item = mapOpenCodeV2ToolCall({
      toolName: "bash",
      callId: "tool-9",
      input: { command: "false" },
      error: { message: "exit 1" },
    });
    expect(item).toMatchObject({
      type: "tool_call",
      callId: "tool-9",
      status: "failed",
    });
  });
});

describe("deriveOpenCodeV2ToolDetail", () => {
  it("returns an unknown detail for empty input", () => {
    expect(deriveOpenCodeV2ToolDetail("bash", null, null)).toEqual({
      type: "unknown",
      input: null,
      output: null,
    });
  });

  it("maps shell input to a shell detail", () => {
    expect(deriveOpenCodeV2ToolDetail("shell", { command: "pwd" }, null)).toMatchObject({
      type: "shell",
      command: "pwd",
    });
  });
});
