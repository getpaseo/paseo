import { describe, expect, it } from "vitest";

import {
  mapClaudeCompletedToolCall,
  mapClaudeFailedToolCall,
  mapClaudeRunningToolCall,
} from "./tool-call-mapper.js";

describe("claude tool-call mapper", () => {
  it("maps running shell calls with canonical fields", () => {
    const item = mapClaudeRunningToolCall({
      callId: "claude-call-1",
      name: "Bash",
      input: { command: "pwd", cwd: "/tmp/repo" },
      output: null,
    });

    expect(item.type).toBe("tool_call");
    expect(item.status).toBe("running");
    expect(item.error).toBeNull();
    expect(item.callId).toBe("claude-call-1");
    expect(item.input).toEqual({ command: "pwd", cwd: "/tmp/repo" });
    expect(item.output).toBeNull();
    expect(item.detail?.type).toBe("shell");
    if (item.detail?.type === "shell") {
      expect(item.detail.command).toBe("pwd");
      expect(item.detail.cwd).toBe("/tmp/repo");
    }
  });

  it("maps completed read calls with detail enrichment", () => {
    const item = mapClaudeCompletedToolCall({
      callId: "claude-call-2",
      name: "read_file",
      input: { file_path: "README.md" },
      output: { content: "hello" },
    });

    expect(item.status).toBe("completed");
    expect(item.error).toBeNull();
    expect(item.callId).toBe("claude-call-2");
    expect(item.input).toEqual({ file_path: "README.md" });
    expect(item.output).toEqual({ content: "hello" });
    expect(item.detail?.type).toBe("read");
    if (item.detail?.type === "read") {
      expect(item.detail.filePath).toBe("README.md");
      expect(item.detail.content).toBe("hello");
    }
  });

  it("maps failed calls with required error", () => {
    const item = mapClaudeFailedToolCall({
      callId: "claude-call-3",
      name: "shell",
      input: { command: "false" },
      output: null,
      error: { message: "Command failed" },
    });

    expect(item.status).toBe("failed");
    expect(item.error).toEqual({ message: "Command failed" });
    expect(item.callId).toBe("claude-call-3");
    expect(item.input).toEqual({ command: "false" });
    expect(item.output).toBeNull();
  });

  it("keeps unknown tools canonical without detail", () => {
    const item = mapClaudeCompletedToolCall({
      callId: "claude-call-4",
      name: "my_custom_tool",
      input: { foo: "bar" },
      output: { ok: true },
    });

    expect(item.status).toBe("completed");
    expect(item.error).toBeNull();
    expect(item.detail).toBeUndefined();
    expect(item.input).toEqual({ foo: "bar" });
    expect(item.output).toEqual({ ok: true });
  });
});
