import { describe, expect, it } from "vitest";

import {
  mapCodexRolloutToolCall,
  mapCodexToolCallFromThreadItem,
} from "./tool-call-mapper.js";

describe("codex tool-call mapper", () => {
  it("maps commandExecution start into running canonical call", () => {
    const item = mapCodexToolCallFromThreadItem({
      type: "commandExecution",
      id: "codex-call-1",
      status: "running",
      command: "pwd",
      cwd: "/tmp/repo",
    });

    expect(item).toBeTruthy();
    expect(item?.status).toBe("running");
    expect(item?.error).toBeNull();
    expect(item?.callId).toBe("codex-call-1");
    expect(item?.name).toBe("shell");
    expect(item?.input).toEqual({ command: "pwd", cwd: "/tmp/repo" });
  });

  it("maps mcp read_file completion with detail", () => {
    const item = mapCodexToolCallFromThreadItem(
      {
        type: "mcpToolCall",
        id: "codex-call-2",
        status: "completed",
        tool: "read_file",
        arguments: { path: "/tmp/repo/README.md" },
        result: { content: "hello" },
      },
      { cwd: "/tmp/repo" }
    );

    expect(item).toBeTruthy();
    expect(item?.status).toBe("completed");
    expect(item?.error).toBeNull();
    expect(item?.callId).toBe("codex-call-2");
    expect(item?.name).toBe("read_file");
    expect(item?.detail?.type).toBe("read");
    if (item?.detail?.type === "read") {
      expect(item.detail.filePath).toBe("README.md");
      expect(item.detail.content).toBe("hello");
    }
  });

  it("maps failed tool calls with required error", () => {
    const item = mapCodexToolCallFromThreadItem({
      type: "mcpToolCall",
      id: "codex-call-3",
      status: "failed",
      server: "custom",
      tool: "run",
      arguments: { foo: "bar" },
      result: null,
      error: { message: "boom" },
    });

    expect(item).toBeTruthy();
    expect(item?.status).toBe("failed");
    expect(item?.error).toEqual({ message: "boom" });
    expect(item?.callId).toBe("codex-call-3");
  });

  it("keeps unknown tools canonical without detail", () => {
    const item = mapCodexRolloutToolCall({
      callId: "codex-call-4",
      name: "my_custom_tool",
      input: { foo: "bar" },
      output: { ok: true },
    });

    expect(item.status).toBe("completed");
    expect(item.error).toBeNull();
    expect(item.detail).toBeUndefined();
    expect(item.callId).toBe("codex-call-4");
    expect(item.input).toEqual({ foo: "bar" });
    expect(item.output).toEqual({ ok: true });
  });
});
