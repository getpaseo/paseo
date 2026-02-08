import { describe, expect, it } from "vitest";

import { mapOpencodeToolCall } from "./tool-call-mapper.js";

describe("opencode tool-call mapper", () => {
  it("maps running shell calls", () => {
    const item = mapOpencodeToolCall({
      toolName: "shell",
      callId: "opencode-call-1",
      status: "running",
      input: { command: "pwd", cwd: "/tmp/repo" },
      output: null,
    });

    expect(item.status).toBe("running");
    expect(item.error).toBeNull();
    expect(item.callId).toBe("opencode-call-1");
    expect(item.detail?.type).toBe("shell");
    if (item.detail?.type === "shell") {
      expect(item.detail.command).toBe("pwd");
    }
  });

  it("maps completed read calls", () => {
    const item = mapOpencodeToolCall({
      toolName: "read_file",
      callId: "opencode-call-2",
      status: "complete",
      input: { file_path: "README.md" },
      output: { content: "hello" },
    });

    expect(item.status).toBe("completed");
    expect(item.error).toBeNull();
    expect(item.callId).toBe("opencode-call-2");
    expect(item.detail?.type).toBe("read");
    if (item.detail?.type === "read") {
      expect(item.detail.filePath).toBe("README.md");
      expect(item.detail.content).toBe("hello");
    }
  });

  it("maps failed calls with required error", () => {
    const item = mapOpencodeToolCall({
      toolName: "shell",
      callId: "opencode-call-3",
      status: "error",
      input: { command: "false" },
      output: null,
      error: "command failed",
    });

    expect(item.status).toBe("failed");
    expect(item.error).toBe("command failed");
    expect(item.callId).toBe("opencode-call-3");
  });

  it("keeps unknown tools canonical without detail", () => {
    const item = mapOpencodeToolCall({
      toolName: "my_custom_tool",
      callId: "opencode-call-4",
      status: "completed",
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
