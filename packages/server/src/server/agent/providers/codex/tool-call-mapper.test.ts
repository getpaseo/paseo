import { describe, expect, it } from "vitest";

import {
  mapCodexRolloutToolCall,
  mapCodexToolCallFromThreadItem,
} from "./tool-call-mapper.js";

function expectMapped<T>(item: T | null): T {
  expect(item).toBeTruthy();
  if (!item) {
    throw new Error("Expected mapped tool call");
  }
  return item;
}

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

  it("unwraps shell wrapper arrays for commandExecution", () => {
    const item = mapCodexToolCallFromThreadItem({
      type: "commandExecution",
      id: "codex-call-wrapper-array",
      status: "running",
      command: ["/bin/zsh", "-lc", "echo hello"],
      cwd: "/tmp/repo",
    });

    expect(item?.detail).toEqual({
      type: "shell",
      command: "echo hello",
      cwd: "/tmp/repo",
    });
  });

  it("unwraps shell wrapper strings for commandExecution", () => {
    const item = mapCodexToolCallFromThreadItem({
      type: "commandExecution",
      id: "codex-call-wrapper-string",
      status: "running",
      command: '/bin/zsh -lc "echo hello"',
      cwd: "/tmp/repo",
    });

    expect(item?.detail).toEqual({
      type: "shell",
      command: "echo hello",
      cwd: "/tmp/repo",
    });
  });

  it("keeps only command output body when commandExecution output is wrapped in shell envelope", () => {
    const item = mapCodexToolCallFromThreadItem({
      type: "commandExecution",
      id: "codex-call-envelope-output",
      status: "completed",
      command: "echo hello",
      cwd: "/tmp/repo",
      aggregatedOutput:
        "Chunk ID: e87d40\nWall time: 0.0521 seconds\nProcess exited with code 0\nOriginal token count: 192\nOutput:\n214  export type AgentPermissionRequestKind = \"tool\";",
      exitCode: 0,
    });

    expect(item?.detail?.type).toBe("shell");
    if (item?.detail?.type === "shell") {
      expect(item.detail.output).toBe(
        "214  export type AgentPermissionRequestKind = \"tool\";"
      );
      expect(item.detail.output).not.toContain("Chunk ID:");
      expect(item.detail.output).not.toContain("Wall time:");
      expect(item.detail.output).not.toContain("Process exited with code");
      expect(item.detail.output).not.toContain("Original token count:");
      expect(item.detail.output).not.toContain("Output:");
    }
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

  it("maps fileChange content fallback into editable text when unified diff is absent", () => {
    const item = mapCodexToolCallFromThreadItem(
      {
        type: "fileChange",
        id: "codex-content-1",
        status: "completed",
        changes: [{ path: "/tmp/repo/src/content-only.ts", kind: "modify", content: "line one\nline two\n" }],
      },
      { cwd: "/tmp/repo" }
    );

    expect(item).toBeTruthy();
    expect(item?.detail?.type).toBe("edit");
    if (item?.detail?.type === "edit") {
      expect(item.detail.filePath).toBe("src/content-only.ts");
      expect(item.detail.newString).toContain("line one");
      expect(item.detail.unifiedDiff).toBeUndefined();
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
    const item = expectMapped(
      mapCodexRolloutToolCall({
        callId: "codex-call-4",
        name: "my_custom_tool",
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
    expect(item.callId).toBe("codex-call-4");
  });

  it("maps apply_patch rollout calls with raw patch input into edit detail", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: /tmp/repo/src/index.ts",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n");
    const item = expectMapped(
      mapCodexRolloutToolCall({
        callId: "codex-call-apply",
        name: "apply_patch",
        input: patch,
        output: '{"output":"Success. Updated the following files:\\nM src/index.ts\\n"}',
        cwd: "/tmp/repo",
      })
    );

    expect(item.status).toBe("completed");
    expect(item.error).toBeNull();
    expect(item.detail.type).toBe("edit");
    if (item.detail.type === "edit") {
      expect(item.detail.filePath).toBe("src/index.ts");
      expect(item.detail.unifiedDiff).toContain("diff --git");
      expect(item.detail.unifiedDiff).toContain("@@");
      expect(item.detail.unifiedDiff).toContain("-old");
      expect(item.detail.unifiedDiff).toContain("+new");
      expect(item.detail.unifiedDiff).not.toContain("*** Begin Patch");
      expect(item.detail.newString).toBeUndefined();
    }
  });

  it("maps apply_patch object content payloads into unified diff detail", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: /tmp/repo/src/object.ts",
      "@@",
      "-before",
      "+after",
      "*** End Patch",
    ].join("\n");

    const item = expectMapped(
      mapCodexRolloutToolCall({
        callId: "codex-call-apply-object",
        name: "apply_patch",
        input: {
          path: "/tmp/repo/src/object.ts",
          content: patch,
        },
        output: null,
        cwd: "/tmp/repo",
      })
    );

    expect(item.detail.type).toBe("edit");
    if (item.detail.type === "edit") {
      expect(item.detail.filePath).toBe("src/object.ts");
      expect(item.detail.unifiedDiff).toContain("diff --git");
      expect(item.detail.unifiedDiff).toContain("@@");
      expect(item.detail.unifiedDiff).toContain("-before");
      expect(item.detail.unifiedDiff).toContain("+after");
      expect(item.detail.unifiedDiff).not.toContain("*** Begin Patch");
      expect(item.detail.newString).toBeUndefined();
    }
  });

  it("maps fileChange content that contains codex patch envelopes as unified diffs", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: /tmp/repo/src/from-file-change.ts",
      "@@",
      "-alpha",
      "+beta",
      "*** End Patch",
    ].join("\n");

    const item = mapCodexToolCallFromThreadItem(
      {
        type: "fileChange",
        id: "codex-file-change-patch-content",
        status: "completed",
        changes: [{ path: "/tmp/repo/src/from-file-change.ts", kind: "modify", content: patch }],
      },
      { cwd: "/tmp/repo" }
    );

    expect(item?.detail?.type).toBe("edit");
    if (item?.detail?.type === "edit") {
      expect(item.detail.filePath).toBe("src/from-file-change.ts");
      expect(item.detail.unifiedDiff).toContain("-alpha");
      expect(item.detail.unifiedDiff).toContain("+beta");
      expect(item.detail.unifiedDiff).not.toContain("*** Begin Patch");
      expect(item.detail.newString).toBeUndefined();
    }
  });

  it("maps fileChange patch alias fields into edit unified diff detail", () => {
    const item = mapCodexToolCallFromThreadItem(
      {
        type: "fileChange",
        id: "codex-file-change-patch-alias",
        status: "completed",
        changes: [
          {
            path: "/tmp/repo/src/from-patch-alias.ts",
            kind: "modify",
            patch: "@@\n-oldAlias\n+newAlias\n",
          },
        ],
      },
      { cwd: "/tmp/repo" }
    );

    expect(item?.detail?.type).toBe("edit");
    if (item?.detail?.type === "edit") {
      expect(item.detail.filePath).toBe("src/from-patch-alias.ts");
      expect(item.detail.unifiedDiff).toContain("-oldAlias");
      expect(item.detail.unifiedDiff).toContain("+newAlias");
      expect(item.detail.newString).toBeUndefined();
    }
  });

  it("maps fileChange unifiedDiff alias fields into edit unified diff detail", () => {
    const item = mapCodexToolCallFromThreadItem(
      {
        type: "fileChange",
        id: "codex-file-change-unified-diff-alias",
        status: "completed",
        changes: [
          {
            path: "/tmp/repo/src/from-unified-diff-alias.ts",
            kind: "modify",
            unified_diff: "@@\n-beforeAlias\n+afterAlias\n",
          },
        ],
      },
      { cwd: "/tmp/repo" }
    );

    expect(item?.detail?.type).toBe("edit");
    if (item?.detail?.type === "edit") {
      expect(item.detail.filePath).toBe("src/from-unified-diff-alias.ts");
      expect(item.detail.unifiedDiff).toContain("-beforeAlias");
      expect(item.detail.unifiedDiff).toContain("+afterAlias");
      expect(item.detail.newString).toBeUndefined();
    }
  });

  it("maps path-only fileChange payloads to unknown detail instead of empty edit detail", () => {
    const item = mapCodexToolCallFromThreadItem(
      {
        type: "fileChange",
        id: "codex-file-change-path-only",
        status: "completed",
        changes: [{ path: "/tmp/repo/src/path-only.ts", kind: "modify" }],
      },
      { cwd: "/tmp/repo" }
    );

    expect(item?.detail.type).toBe("unknown");
    if (item?.detail.type === "unknown") {
      expect(item.detail.input).toEqual({
        files: [{ path: "src/path-only.ts", kind: "modify" }],
      });
    }
  });

  it("maps path-only apply_patch rollout payloads to unknown detail instead of empty edit detail", () => {
    const item = expectMapped(
      mapCodexRolloutToolCall({
        callId: "codex-call-apply-path-only",
        name: "apply_patch",
        input: { path: "/tmp/repo/src/path-only-rollout.ts" },
        output: { files: [{ path: "/tmp/repo/src/path-only-rollout.ts", kind: "modify" }] },
        cwd: "/tmp/repo",
      })
    );

    expect(item.detail.type).toBe("unknown");
    if (item.detail.type === "unknown") {
      expect(item.detail.input).toEqual({ path: "/tmp/repo/src/path-only-rollout.ts" });
    }
  });

  it("normalizes namespaced speak mcp calls and extracts spoken text", () => {
    const item = mapCodexToolCallFromThreadItem({
      type: "mcpToolCall",
      id: "codex-speak-thread-1",
      status: "completed",
      server: "paseo_voice",
      tool: "speak",
      arguments: { text: "Voice response from Codex." },
      result: { ok: true },
    });

    expect(item).toBeTruthy();
    expect(item?.name).toBe("speak");
    expect(item?.detail).toEqual({
      type: "unknown",
      input: "Voice response from Codex.",
      output: null,
    });
  });

  it("normalizes exact codex speak rollout names and extracts spoken text", () => {
    const item = expectMapped(
      mapCodexRolloutToolCall({
        callId: "codex-speak-rollout-1",
        name: "mcp__paseo_voice__speak",
        input: { text: "Rollout speech text." },
        output: { ok: true },
      })
    );

    expect(item.name).toBe("speak");
    expect(item.detail).toEqual({
      type: "unknown",
      input: "Rollout speech text.",
      output: null,
    });
  });

  it("drops rollout tool calls when callId is missing", () => {
    const item = mapCodexRolloutToolCall({
      callId: null,
      name: "read_file",
      input: { path: "/tmp/repo/README.md" },
      output: { content: "hello" },
    });

    expect(item).toBeNull();
  });

  it("drops thread mcp tool calls when id is missing", () => {
    const item = mapCodexToolCallFromThreadItem({
      type: "mcpToolCall",
      status: "completed",
      tool: "read_file",
      arguments: { path: "/tmp/repo/README.md" },
      result: { content: "hello" },
    });

    expect(item).toBeNull();
  });
});
