import { describe, expect, it } from "vitest";

import { mapOpencodeToolCall } from "./tool-call-mapper.js";

function expectMapped<T>(item: T | null): T {
  expect(item).toBeTruthy();
  if (!item) {
    throw new Error("Expected mapped tool call");
  }
  return item;
}

describe("opencode tool-call mapper", () => {
  it("maps running shell calls", () => {
    const item = expectMapped(
      mapOpencodeToolCall({
        toolName: "shell",
        callId: "opencode-call-1",
        status: "running",
        input: { command: "pwd", cwd: "/tmp/repo" },
        output: null,
      })
    );

    expect(item.status).toBe("running");
    expect(item.error).toBeNull();
    expect(item.callId).toBe("opencode-call-1");
    expect(item.detail?.type).toBe("shell");
    if (item.detail?.type === "shell") {
      expect(item.detail.command).toBe("pwd");
    }
  });

  it("maps running known tool variants with detail for early summaries", () => {
    const readItem = expectMapped(
      mapOpencodeToolCall({
        toolName: "read_file",
        callId: "opencode-running-read",
        status: "running",
        input: { file_path: "README.md" },
        output: null,
      })
    );
    expect(readItem.detail).toEqual({
      type: "read",
      filePath: "README.md",
    });

    const writeItem = expectMapped(
      mapOpencodeToolCall({
        toolName: "write_file",
        callId: "opencode-running-write",
        status: "running",
        input: { file_path: "src/new.ts" },
        output: null,
      })
    );
    expect(writeItem.detail).toEqual({
      type: "write",
      filePath: "src/new.ts",
    });

    const editItem = expectMapped(
      mapOpencodeToolCall({
        toolName: "apply_patch",
        callId: "opencode-running-edit",
        status: "running",
        input: { file_path: "src/index.ts" },
        output: null,
      })
    );
    expect(editItem.detail).toEqual({
      type: "edit",
      filePath: "src/index.ts",
    });

    const searchItem = expectMapped(
      mapOpencodeToolCall({
        toolName: "web_search",
        callId: "opencode-running-search",
        status: "running",
        input: { query: "opencode mapper" },
        output: null,
      })
    );
    expect(searchItem.detail).toEqual({
      type: "search",
      query: "opencode mapper",
    });
  });

  it("maps completed read calls", () => {
    const item = expectMapped(
      mapOpencodeToolCall({
        toolName: "read_file",
        callId: "opencode-call-2",
        status: "complete",
        input: { file_path: "README.md" },
        output: { content: "hello" },
      })
    );

    expect(item.status).toBe("completed");
    expect(item.error).toBeNull();
    expect(item.callId).toBe("opencode-call-2");
    expect(item.detail?.type).toBe("read");
    if (item.detail?.type === "read") {
      expect(item.detail.filePath).toBe("README.md");
      expect(item.detail.content).toBe("hello");
    }
  });

  it("preserves read content from array/object output variants", () => {
    const arrayContent = expectMapped(
      mapOpencodeToolCall({
        toolName: "read_file",
        callId: "opencode-read-array",
        status: "completed",
        input: { file_path: "README.md" },
        output: {
          content: [
            { type: "output_text", text: "alpha" },
            { type: "output_text", output: "beta" },
          ],
        },
      })
    );

    expect(arrayContent.detail?.type).toBe("read");
    if (arrayContent.detail?.type === "read") {
      expect(arrayContent.detail.content).toBe("alpha\nbeta");
    }

    const objectContent = expectMapped(
      mapOpencodeToolCall({
        toolName: "read_file",
        callId: "opencode-read-object",
        status: "completed",
        input: { file_path: "README.md" },
        output: {
          data: {
            content: { type: "output_text", text: "gamma" },
          },
        },
      })
    );

    expect(objectContent.detail?.type).toBe("read");
    if (objectContent.detail?.type === "read") {
      expect(objectContent.detail.content).toBe("gamma");
    }
  });

  it("maps failed calls with required error", () => {
    const item = expectMapped(
      mapOpencodeToolCall({
        toolName: "shell",
        callId: "opencode-call-3",
        status: "error",
        input: { command: "false" },
        output: null,
        error: "command failed",
      })
    );

    expect(item.status).toBe("failed");
    expect(item.error).toBe("command failed");
    expect(item.callId).toBe("opencode-call-3");
  });

  it("maps write/edit/search known variants into canonical detail", () => {
    const writeItem = expectMapped(
      mapOpencodeToolCall({
        toolName: "write_file",
        callId: "opencode-write-1",
        status: "completed",
        input: { file_path: "src/new.ts", content: "const x = 1;" },
        output: null,
      })
    );
    expect(writeItem.detail?.type).toBe("write");
    if (writeItem.detail?.type === "write") {
      expect(writeItem.detail.filePath).toBe("src/new.ts");
    }

    const editItem = expectMapped(
      mapOpencodeToolCall({
        toolName: "apply_patch",
        callId: "opencode-edit-1",
        status: "completed",
        input: { file_path: "src/index.ts", diff: "@@\\n-old\\n+new\\n" },
        output: null,
      })
    );
    expect(editItem.detail?.type).toBe("edit");
    if (editItem.detail?.type === "edit") {
      expect(editItem.detail.filePath).toBe("src/index.ts");
      expect(editItem.detail.unifiedDiff).toContain("@@");
    }

    const searchItem = expectMapped(
      mapOpencodeToolCall({
        toolName: "web_search",
        callId: "opencode-search-1",
        status: "completed",
        input: { query: "opencode mapper" },
        output: null,
      })
    );
    expect(searchItem.detail).toEqual({
      type: "search",
      query: "opencode mapper",
    });
  });

  it("maps unknown tools to unknown detail with raw payloads", () => {
    const item = expectMapped(
      mapOpencodeToolCall({
        toolName: "my_custom_tool",
        callId: "opencode-call-4",
        status: "completed",
        input: { foo: "bar" },
        output: { ok: true },
      })
    );

    expect(item.status).toBe("completed");
    expect(item.error).toBeNull();
    expect(item.detail).toEqual({
      type: "unknown",
      input: { foo: "bar" },
      output: { ok: true },
    });
  });

  it("does not apply cross-provider speak normalization in opencode mapper", () => {
    const item = expectMapped(
      mapOpencodeToolCall({
        toolName: "paseo_voice.speak",
        callId: "opencode-call-voice-1",
        status: "completed",
        input: { text: "Voice response from OpenCode." },
        output: { ok: true },
      })
    );

    expect(item.name).toBe("paseo_voice.speak");
    expect(item.detail).toEqual({
      type: "unknown",
      input: { text: "Voice response from OpenCode." },
      output: { ok: true },
    });
  });

  it("drops tool calls when callId is missing", () => {
    const item = mapOpencodeToolCall({
      toolName: "read_file",
      callId: null,
      status: "completed",
      input: { file_path: "README.md" },
      output: { content: "hello" },
    });

    expect(item).toBeNull();
  });
});
