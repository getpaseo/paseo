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

  it("maps running known tool variants with detail for early summaries", () => {
    const readItem = mapClaudeRunningToolCall({
      callId: "claude-running-read",
      name: "read_file",
      input: { file_path: "README.md" },
      output: null,
    });
    expect(readItem.detail).toEqual({
      type: "read",
      filePath: "README.md",
    });

    const writeItem = mapClaudeRunningToolCall({
      callId: "claude-running-write",
      name: "write_file",
      input: { file_path: "src/new.ts" },
      output: null,
    });
    expect(writeItem.detail).toEqual({
      type: "write",
      filePath: "src/new.ts",
    });

    const editItem = mapClaudeRunningToolCall({
      callId: "claude-running-edit",
      name: "apply_patch",
      input: { file_path: "src/index.ts" },
      output: null,
    });
    expect(editItem.detail).toEqual({
      type: "edit",
      filePath: "src/index.ts",
    });

    const searchItem = mapClaudeRunningToolCall({
      callId: "claude-running-search",
      name: "web_search",
      input: { query: "tool call mapping" },
      output: null,
    });
    expect(searchItem.detail).toEqual({
      type: "search",
      query: "tool call mapping",
    });
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

  it("preserves read content from array/object output variants", () => {
    const arrayContent = mapClaudeCompletedToolCall({
      callId: "claude-read-array",
      name: "read_file",
      input: { file_path: "README.md" },
      output: {
        content: [
          { type: "output_text", text: "alpha" },
          { type: "output_text", content: "beta" },
        ],
      },
    });

    expect(arrayContent.detail?.type).toBe("read");
    if (arrayContent.detail?.type === "read") {
      expect(arrayContent.detail.content).toBe("alpha\nbeta");
    }

    const objectContent = mapClaudeCompletedToolCall({
      callId: "claude-read-object",
      name: "read_file",
      input: { file_path: "README.md" },
      output: {
        structured_content: {
          content: { type: "output_text", text: "gamma" },
        },
      },
    });

    expect(objectContent.detail?.type).toBe("read");
    if (objectContent.detail?.type === "read") {
      expect(objectContent.detail.content).toBe("gamma");
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

  it("maps write/edit/search known shapes with distinct detail types", () => {
    const writeItem = mapClaudeCompletedToolCall({
      callId: "claude-write-1",
      name: "write_file",
      input: { file_path: "src/new.ts", content: "export const x = 1;" },
      output: null,
    });
    expect(writeItem.detail?.type).toBe("write");
    if (writeItem.detail?.type === "write") {
      expect(writeItem.detail.filePath).toBe("src/new.ts");
    }

    const editItem = mapClaudeCompletedToolCall({
      callId: "claude-edit-1",
      name: "apply_patch",
      input: { file_path: "src/index.ts", patch: "@@\\n-old\\n+new\\n" },
      output: null,
    });
    expect(editItem.detail?.type).toBe("edit");
    if (editItem.detail?.type === "edit") {
      expect(editItem.detail.filePath).toBe("src/index.ts");
      expect(editItem.detail.unifiedDiff).toContain("@@");
    }

    const searchItem = mapClaudeCompletedToolCall({
      callId: "claude-search-1",
      name: "web_search",
      input: { query: "tool call mapping" },
      output: null,
    });
    expect(searchItem.detail).toEqual({
      type: "search",
      query: "tool call mapping",
    });
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
