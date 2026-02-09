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
    expect(item?.detail).toEqual({
      type: "shell",
      command: "pwd",
      cwd: "/tmp/repo",
    });
  });

  it("maps running known tool variants with detail for early summaries", () => {
    const readItem = mapCodexToolCallFromThreadItem(
      {
        type: "mcpToolCall",
        id: "codex-running-read",
        status: "running",
        tool: "read_file",
        arguments: { path: "/tmp/repo/README.md" },
        result: null,
      },
      { cwd: "/tmp/repo" }
    );
    expect(readItem?.detail).toEqual({
      type: "read",
      filePath: "README.md",
    });

    const writeItem = mapCodexToolCallFromThreadItem(
      {
        type: "mcpToolCall",
        id: "codex-running-write",
        status: "running",
        tool: "write_file",
        arguments: { file_path: "/tmp/repo/src/new.ts" },
        result: null,
      },
      { cwd: "/tmp/repo" }
    );
    expect(writeItem?.detail).toEqual({
      type: "write",
      filePath: "src/new.ts",
    });

    const editItem = mapCodexToolCallFromThreadItem(
      {
        type: "mcpToolCall",
        id: "codex-running-edit",
        status: "running",
        tool: "apply_patch",
        arguments: { file_path: "/tmp/repo/src/index.ts" },
        result: null,
      },
      { cwd: "/tmp/repo" }
    );
    expect(editItem?.detail).toEqual({
      type: "edit",
      filePath: "src/index.ts",
    });

    const searchItem = mapCodexToolCallFromThreadItem({
      type: "webSearch",
      id: "codex-running-search",
      status: "running",
      query: "codex timeline",
      action: null,
    });
    expect(searchItem?.detail).toEqual({
      type: "search",
      query: "codex timeline",
    });
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

  it("retains read_file content when provider returns content array objects", () => {
    const item = mapCodexToolCallFromThreadItem(
      {
        type: "mcpToolCall",
        id: "codex-read-array",
        status: "completed",
        tool: "read_file",
        arguments: { path: "/tmp/repo/README.md" },
        result: {
          content: [{ type: "text", text: "line one" }, { type: "text", text: "line two" }],
        },
      },
      { cwd: "/tmp/repo" }
    );

    expect(item).toBeTruthy();
    expect(item?.detail?.type).toBe("read");
    if (item?.detail?.type === "read") {
      expect(item.detail.filePath).toBe("README.md");
      expect(item.detail.content).toBe("line one\nline two");
    }
  });

  it("truncates large diff payloads deterministically in canonical detail", () => {
    const hugeDiff = `@@\\n-${"a".repeat(14_000)}\\n+${"b".repeat(14_000)}\\n`;
    const item = mapCodexToolCallFromThreadItem(
      {
        type: "fileChange",
        id: "codex-diff-1",
        status: "completed",
        changes: [{ path: "/tmp/repo/src/index.ts", kind: "modify", diff: hugeDiff }],
      },
      { cwd: "/tmp/repo" }
    );

    expect(item).toBeTruthy();
    expect(item?.status).toBe("completed");
    expect(item?.detail?.type).toBe("edit");
    if (item?.detail?.type === "edit") {
      expect(item.detail.unifiedDiff).toBeDefined();
      expect(item.detail.unifiedDiff?.includes("...[truncated ")).toBe(true);
      expect((item.detail.unifiedDiff?.length ?? 0) < hugeDiff.length).toBe(true);
    }
  });

  it("maps write/edit/search known variants with distinct detail types", () => {
    const writeItem = mapCodexToolCallFromThreadItem(
      {
        type: "mcpToolCall",
        id: "codex-write-1",
        status: "completed",
        tool: "write_file",
        arguments: { file_path: "/tmp/repo/src/new.ts", content: "export {}" },
        result: null,
      },
      { cwd: "/tmp/repo" }
    );
    expect(writeItem?.detail?.type).toBe("write");
    if (writeItem?.detail?.type === "write") {
      expect(writeItem.detail.filePath).toBe("src/new.ts");
    }

    const editItem = mapCodexToolCallFromThreadItem(
      {
        type: "mcpToolCall",
        id: "codex-edit-1",
        status: "completed",
        tool: "apply_patch",
        arguments: { file_path: "/tmp/repo/src/index.ts", patch: "@@\\n-a\\n+b\\n" },
        result: null,
      },
      { cwd: "/tmp/repo" }
    );
    expect(editItem?.detail?.type).toBe("edit");
    if (editItem?.detail?.type === "edit") {
      expect(editItem.detail.filePath).toBe("src/index.ts");
    }

    const searchItem = mapCodexToolCallFromThreadItem({
      type: "webSearch",
      id: "codex-search-1",
      status: "completed",
      query: "codex timeline",
      action: { results: [] },
    });
    expect(searchItem?.detail).toEqual({
      type: "search",
      query: "codex timeline",
    });
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

  it("maps unknown tools to unknown detail with raw payloads", () => {
    const item = mapCodexRolloutToolCall({
      callId: "codex-call-4",
      name: "my_custom_tool",
      input: { foo: "bar" },
      output: { ok: true },
    });

    expect(item.status).toBe("completed");
    expect(item.error).toBeNull();
    expect(item.detail).toEqual({
      type: "unknown",
      rawInput: { foo: "bar" },
      rawOutput: { ok: true },
    });
    expect(item.callId).toBe("codex-call-4");
  });
});
