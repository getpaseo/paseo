import { describe, expect, it } from "vitest";

import { mapCodexToolCallEnvelope, mapCodexToolCallFromThreadItem } from "./tool-call-mapper.js";

function expectMapped<T>(item: T | null): T {
  expect(item).not.toBeNull();
  return item as T;
}

describe("codex tool-call mapper", () => {
  it("maps commandExecution start into running canonical call", () => {
    const item = expectMapped(
      mapCodexToolCallFromThreadItem({
        type: "commandExecution",
        id: "codex-call-1",
        status: "running",
        command: "pwd",
        cwd: "/tmp/repo",
      }),
    );

    expect(item).toEqual({
      type: "tool_call",
      callId: "codex-call-1",
      name: "shell",
      status: "running",
      error: null,
      detail: {
        type: "shell",
        command: "pwd",
        cwd: "/tmp/repo",
      },
    });
  });

  it("unwraps shell wrapper arrays for commandExecution", () => {
    const item = expectMapped(
      mapCodexToolCallFromThreadItem({
        type: "commandExecution",
        id: "codex-call-wrapper-array",
        status: "running",
        command: ["/bin/zsh", "-lc", "echo hello"],
        cwd: "/tmp/repo",
      }),
    );

    expect(item.detail).toEqual({
      type: "shell",
      command: "echo hello",
      cwd: "/tmp/repo",
    });
  });

  it.each(['/bin/zsh -lc "echo hello"', '/usr/bin/zsh -lc "echo hello"'])(
    "unwraps zsh wrapper strings for commandExecution: %s",
    (command) => {
      const item = expectMapped(
        mapCodexToolCallFromThreadItem({
          type: "commandExecution",
          id: "codex-call-wrapper-string",
          status: "running",
          command,
          cwd: "/tmp/repo",
        }),
      );

      expect(item.detail).toEqual({
        type: "shell",
        command: "echo hello",
        cwd: "/tmp/repo",
      });
    },
  );

  it("unwraps pwsh wrapper strings for commandExecution on Windows", () => {
    const item = expectMapped(
      mapCodexToolCallFromThreadItem({
        type: "commandExecution",
        id: "codex-call-wrapper-pwsh-string",
        status: "running",
        command:
          '"C:\\Users\\example\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe" -NoLogo -NoProfile -Command "echo hello"',
        cwd: "C:\\repo",
      }),
    );

    expect(item.detail).toEqual({
      type: "shell",
      command: "echo hello",
      cwd: "C:\\repo",
    });
  });

  it("unwraps cmd wrapper arrays for commandExecution on Windows", () => {
    const item = expectMapped(
      mapCodexToolCallFromThreadItem({
        type: "commandExecution",
        id: "codex-call-wrapper-cmd-array",
        status: "running",
        command: ["cmd.exe", "/c", "echo hello"],
        cwd: "C:\\repo",
      }),
    );

    expect(item.detail).toEqual({
      type: "shell",
      command: "echo hello",
      cwd: "C:\\repo",
    });
  });

  it("keeps only command output body when commandExecution output is wrapped in shell envelope", () => {
    const item = expectMapped(
      mapCodexToolCallFromThreadItem({
        type: "commandExecution",
        id: "codex-call-envelope-output",
        status: "completed",
        command: "echo hello",
        cwd: "/tmp/repo",
        aggregatedOutput:
          'Chunk ID: e87d40\nWall time: 0.0521 seconds\nProcess exited with code 0\nOriginal token count: 192\nOutput:\n214  export type AgentPermissionRequestKind = "tool";',
        exitCode: 0,
      }),
    );

    expect(item.detail).toEqual({
      type: "shell",
      command: "echo hello",
      cwd: "/tmp/repo",
      output: '214  export type AgentPermissionRequestKind = "tool";',
      exitCode: 0,
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
      { cwd: "/tmp/repo" },
    );
    expect(expectMapped(readItem).detail).toEqual({
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
      { cwd: "/tmp/repo" },
    );
    expect(expectMapped(writeItem).detail).toEqual({
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
      { cwd: "/tmp/repo" },
    );
    expect(expectMapped(editItem).detail).toEqual({
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
    expect(expectMapped(searchItem).detail).toEqual({
      type: "search",
      query: "codex timeline",
      toolName: "web_search",
    });
  });

  it("maps collabAgentToolCall into canonical sub-agent detail", () => {
    const item = mapCodexToolCallFromThreadItem({
      type: "collabAgentToolCall",
      id: "call-sub-agent-1",
      tool: "spawnAgent",
      status: "completed",
      prompt: "Inspect the Codex stream path.",
      receiverThreadIds: ["child-thread-1"],
      agentsStates: {
        "child-thread-1": { status: "pendingInit", message: null },
      },
    });

    expect(item).toEqual({
      type: "tool_call",
      callId: "call-sub-agent-1",
      name: "Sub-agent",
      status: "running",
      error: null,
      detail: {
        type: "sub_agent",
        subAgentType: "Sub-agent",
        description: "Inspect the Codex stream path.",
        log: "",
        actions: [],
      },
    });
  });

  it.each([
    ["started", "running"],
    ["interacted", "running"],
    ["interrupted", "canceled"],
  ] as const)("maps subAgentActivity %s into canonical sub-agent detail", (kind, status) => {
    const item = mapCodexToolCallFromThreadItem({
      type: "subAgentActivity",
      id: `activity-${kind}`,
      kind,
      agentThreadId: "child-thread-1",
      agentPath: "/root/investigator",
    });

    expect(item).toEqual({
      type: "tool_call",
      callId: `activity-${kind}`,
      name: "Sub-agent",
      status,
      error: null,
      detail: {
        type: "sub_agent",
        subAgentType: "Sub-agent",
        description: "/root/investigator",
        log: "",
        actions: [],
      },
    });
  });

  it("preserves an empty subAgentActivity path as an empty description", () => {
    const item = mapCodexToolCallFromThreadItem({
      type: "subAgentActivity",
      id: "activity-empty-path",
      kind: "started",
      agentThreadId: "child-thread-empty-path",
      agentPath: "",
    });

    expect(item).toMatchObject({
      detail: { type: "sub_agent", description: "" },
    });
  });

  it("does not fail a collabAgentToolCall from child error state alone", () => {
    const item = mapCodexToolCallFromThreadItem({
      type: "collabAgentToolCall",
      id: "call-sub-agent-transient-child-error",
      tool: "spawnAgent",
      status: "completed",
      prompt: "Inspect the Codex stream path.",
      receiverThreadIds: ["child-thread-1"],
      agentsStates: {
        "child-thread-1": { status: "error", message: "Sub-agent failed" },
      },
    });

    expect(item).toEqual({
      type: "tool_call",
      callId: "call-sub-agent-transient-child-error",
      name: "Sub-agent",
      status: "running",
      error: null,
      detail: {
        type: "sub_agent",
        subAgentType: "Sub-agent",
        description: "Inspect the Codex stream path.",
        log: "",
        actions: [],
      },
    });
  });

  it("still fails a collabAgentToolCall from an explicitly failed child state", () => {
    const item = mapCodexToolCallFromThreadItem({
      type: "collabAgentToolCall",
      id: "call-sub-agent-child-failed",
      tool: "spawnAgent",
      status: "completed",
      prompt: "Inspect the Codex stream path.",
      receiverThreadIds: ["child-thread-1"],
      agentsStates: {
        "child-thread-1": { status: "failed", message: "Child failed" },
      },
    });

    expect(item).toEqual({
      type: "tool_call",
      callId: "call-sub-agent-child-failed",
      name: "Sub-agent",
      status: "failed",
      error: { message: "Sub-agent failed" },
      detail: {
        type: "sub_agent",
        subAgentType: "Sub-agent",
        description: "Inspect the Codex stream path.",
        log: "",
        actions: [],
      },
    });
  });

  it("maps mcp read_file completion with detail", () => {
    const item = expectMapped(
      mapCodexToolCallFromThreadItem(
        {
          type: "mcpToolCall",
          id: "codex-call-2",
          status: "completed",
          tool: "read_file",
          arguments: { path: "/tmp/repo/README.md" },
          result: { content: "hello" },
        },
        { cwd: "/tmp/repo" },
      ),
    );

    expect(item).toEqual({
      type: "tool_call",
      callId: "codex-call-2",
      name: "read_file",
      status: "completed",
      error: null,
      detail: {
        type: "read",
        filePath: "README.md",
        content: "hello",
      },
    });
  });

  it("retains read_file content when provider returns content array objects", () => {
    const item = expectMapped(
      mapCodexToolCallFromThreadItem(
        {
          type: "mcpToolCall",
          id: "codex-read-array",
          status: "completed",
          tool: "read_file",
          arguments: { path: "/tmp/repo/README.md" },
          result: {
            content: [
              { type: "text", text: "line one" },
              { type: "text", text: "line two" },
            ],
          },
        },
        { cwd: "/tmp/repo" },
      ),
    );

    expect(item.detail).toEqual({
      type: "read",
      filePath: "README.md",
      content: "line one\nline two",
    });
  });

  it("truncates large diff payloads deterministically in canonical detail", () => {
    const hugeDiff = `@@\\n-${"a".repeat(14_000)}\\n+${"b".repeat(14_000)}\\n`;
    const item = expectMapped(
      mapCodexToolCallFromThreadItem(
        {
          type: "fileChange",
          id: "codex-diff-1",
          status: "completed",
          changes: [{ path: "/tmp/repo/src/index.ts", kind: "modify", diff: hugeDiff }],
        },
        { cwd: "/tmp/repo" },
      ),
    );

    expect(item.status).toBe("completed");
    expect(item.detail.type).toBe("edit");
    expect(item.detail).toMatchInlineSnapshot(`
      {
        "filePath": "src/index.ts",
        "type": "edit",
        "unifiedDiff": "@@\\n-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
      ...[truncated 27 chars]",
      }
    `);
    expect(String(item.detail.unifiedDiff).length).toBeLessThan(hugeDiff.length);
  });

  it("maps fileChange content fallback into editable text when unified diff is absent", () => {
    const item = expectMapped(
      mapCodexToolCallFromThreadItem(
        {
          type: "fileChange",
          id: "codex-content-1",
          status: "completed",
          changes: [
            {
              path: "/tmp/repo/src/content-only.ts",
              kind: "modify",
              content: "line one\nline two\n",
            },
          ],
        },
        { cwd: "/tmp/repo" },
      ),
    );

    expect(item.detail).toEqual({
      type: "edit",
      filePath: "src/content-only.ts",
      newString: "line one\nline two\n",
    });
  });

  it("maps fileChange object-style change payloads keyed by path", () => {
    const item = expectMapped(
      mapCodexToolCallFromThreadItem(
        {
          type: "fileChange",
          id: "codex-content-object-map",
          status: "completed",
          changes: {
            "/tmp/repo/src/object-map.ts": {
              type: "modify",
              unified_diff: "@@\n-old\n+new\n",
            },
          },
        },
        { cwd: "/tmp/repo" },
      ),
    );

    expect(item.detail).toEqual({
      type: "edit",
      filePath: "src/object-map.ts",
      unifiedDiff: "@@\n-old\n+new\n",
    });
  });

  it("maps fileChange array payloads that use file_path aliases", () => {
    const item = expectMapped(
      mapCodexToolCallFromThreadItem(
        {
          type: "fileChange",
          id: "codex-content-file-path-alias",
          status: "completed",
          changes: [
            {
              file_path: "/tmp/repo/src/file-path-alias.ts",
              kind: "modify",
              patch: "@@\n-before\n+after\n",
            },
          ],
        },
        { cwd: "/tmp/repo" },
      ),
    );

    expect(item.detail).toEqual({
      type: "edit",
      filePath: "src/file-path-alias.ts",
      unifiedDiff: "@@\n-before\n+after\n",
    });
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
      { cwd: "/tmp/repo" },
    );
    expect(expectMapped(writeItem).detail).toEqual({
      type: "write",
      filePath: "src/new.ts",
      content: "export {}",
    });

    const editItem = mapCodexToolCallFromThreadItem(
      {
        type: "mcpToolCall",
        id: "codex-edit-1",
        status: "completed",
        tool: "apply_patch",
        arguments: { file_path: "/tmp/repo/src/index.ts", patch: "@@\\n-a\\n+b\\n" },
        result: null,
      },
      { cwd: "/tmp/repo" },
    );
    expect(expectMapped(editItem).detail).toEqual({
      type: "edit",
      filePath: "src/index.ts",
      unifiedDiff: "@@\\n-a\\n+b\\n",
    });

    const searchItem = mapCodexToolCallFromThreadItem({
      type: "webSearch",
      id: "codex-search-1",
      status: "completed",
      query: "codex timeline",
      action: { results: [] },
    });
    expect(expectMapped(searchItem).detail).toEqual({
      type: "search",
      query: "codex timeline",
      toolName: "web_search",
    });
  });

  it("maps failed tool calls with required error", () => {
    const item = expectMapped(
      mapCodexToolCallFromThreadItem({
        type: "mcpToolCall",
        id: "codex-call-3",
        status: "failed",
        server: "custom",
        tool: "run",
        arguments: { foo: "bar" },
        result: null,
        error: { message: "boom" },
      }),
    );

    expect(item).toEqual({
      type: "tool_call",
      callId: "codex-call-3",
      name: "custom.run",
      status: "failed",
      error: { message: "boom" },
      detail: {
        type: "unknown",
        input: { foo: "bar" },
        output: null,
      },
    });
  });

  it("maps unknown tools to unknown detail with raw payloads", () => {
    const item = expectMapped(
      mapCodexToolCallEnvelope({
        callId: "codex-call-4",
        name: "my_custom_tool",
        input: { foo: "bar" },
        output: { ok: true },
      }),
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

  it("maps apply_patch tool-call calls with raw patch input into edit detail", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: /tmp/repo/src/index.ts",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n");
    const item = expectMapped(
      mapCodexToolCallEnvelope({
        callId: "codex-call-apply",
        name: "apply_patch",
        input: patch,
        output: '{"output":"Success. Updated the following files:\\nM src/index.ts\\n"}',
        cwd: "/tmp/repo",
      }),
    );

    expect(item.status).toBe("completed");
    expect(item.error).toBeNull();
    expect(item.detail).toMatchInlineSnapshot(`
      {
        "filePath": "src/index.ts",
        "type": "edit",
        "unifiedDiff": "diff --git a//tmp/repo/src/index.ts b//tmp/repo/src/index.ts
      --- a//tmp/repo/src/index.ts
      +++ b//tmp/repo/src/index.ts
      @@
      -old
      +new",
      }
    `);
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
      mapCodexToolCallEnvelope({
        callId: "codex-call-apply-object",
        name: "apply_patch",
        input: {
          path: "/tmp/repo/src/object.ts",
          content: patch,
        },
        output: null,
        cwd: "/tmp/repo",
      }),
    );

    expect(item.detail).toMatchInlineSnapshot(`
      {
        "filePath": "src/object.ts",
        "type": "edit",
        "unifiedDiff": "diff --git a//tmp/repo/src/object.ts b//tmp/repo/src/object.ts
      --- a//tmp/repo/src/object.ts
      +++ b//tmp/repo/src/object.ts
      @@
      -before
      +after",
      }
    `);
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
      { cwd: "/tmp/repo" },
    );

    expect(expectMapped(item).detail).toMatchInlineSnapshot(`
      {
        "filePath": "src/from-file-change.ts",
        "type": "edit",
        "unifiedDiff": "diff --git a//tmp/repo/src/from-file-change.ts b//tmp/repo/src/from-file-change.ts
      --- a//tmp/repo/src/from-file-change.ts
      +++ b//tmp/repo/src/from-file-change.ts
      @@
      -alpha
      +beta",
      }
    `);
  });

  it("maps path-only fileChange payloads to unknown detail instead of empty edit detail", () => {
    const item = mapCodexToolCallFromThreadItem(
      {
        type: "fileChange",
        id: "codex-file-change-path-only",
        status: "completed",
        changes: [{ path: "/tmp/repo/src/path-only.ts", kind: "modify" }],
      },
      { cwd: "/tmp/repo" },
    );

    expect(expectMapped(item).detail).toEqual({
      type: "unknown",
      input: {
        files: [{ path: "src/path-only.ts", kind: "modify" }],
      },
      output: {
        files: [{ path: "src/path-only.ts", kind: "modify" }],
      },
    });
  });

  it("maps path-only apply_patch tool-call payloads to unknown detail instead of empty edit detail", () => {
    const item = expectMapped(
      mapCodexToolCallEnvelope({
        callId: "codex-call-apply-path-only",
        name: "apply_patch",
        input: { path: "/tmp/repo/src/path-only-tool-call.ts" },
        output: { files: [{ path: "/tmp/repo/src/path-only-tool-call.ts", kind: "modify" }] },
        cwd: "/tmp/repo",
      }),
    );

    expect(item.detail).toEqual({
      type: "unknown",
      input: { path: "/tmp/repo/src/path-only-tool-call.ts" },
      output: { files: [{ path: "/tmp/repo/src/path-only-tool-call.ts", kind: "modify" }] },
    });
  });

  it("normalizes codex paseo speak mcp calls and extracts spoken text", () => {
    const item = expectMapped(
      mapCodexToolCallFromThreadItem({
        type: "mcpToolCall",
        id: "codex-speak-thread-1",
        status: "completed",
        server: "paseo",
        tool: "speak",
        arguments: { text: "Voice response from Codex." },
        result: { ok: true },
      }),
    );

    expect(item.name).toBe("speak");
    expect(item.detail).toEqual({
      type: "unknown",
      input: "Voice response from Codex.",
      output: null,
    });
  });

  it("replaces mcp image result blocks with placeholder text in tool output", () => {
    const item = expectMapped(
      mapCodexToolCallFromThreadItem({
        type: "mcpToolCall",
        id: "codex-browser-screenshot",
        status: "completed",
        server: "paseo",
        tool: "browser_screenshot",
        arguments: { browserId: "11111111-1111-4111-8111-111111111111" },
        result: {
          content: [
            { type: "text", text: "Captured browser screenshot (1x1)." },
            { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
          ],
        },
      }),
    );

    expect(item).toEqual({
      type: "tool_call",
      callId: "codex-browser-screenshot",
      name: "paseo.browser_screenshot",
      status: "completed",
      error: null,
      detail: {
        type: "unknown",
        input: { browserId: "11111111-1111-4111-8111-111111111111" },
        output: {
          content: [
            { type: "text", text: "Captured browser screenshot (1x1)." },
            { type: "text", text: "[image]" },
          ],
        },
      },
    });
    expect(JSON.stringify(item)).not.toContain("iVBORw0KGgo=");
  });

  it("normalizes codex paseo_voice.speak mcp calls and extracts spoken text", () => {
    const item = expectMapped(
      mapCodexToolCallFromThreadItem({
        type: "mcpToolCall",
        id: "codex-speak-thread-2",
        status: "completed",
        server: "paseo_voice",
        tool: "speak",
        arguments: { text: "Voice response from Codex via paseo_voice." },
        result: { ok: true },
      }),
    );

    expect(item.name).toBe("speak");
    expect(item.detail).toEqual({
      type: "unknown",
      input: "Voice response from Codex via paseo_voice.",
      output: null,
    });
  });

  it("normalizes codex paseo speak tool-call names and extracts spoken text", () => {
    const item = expectMapped(
      mapCodexToolCallEnvelope({
        callId: "codex-speak-tool-call-1",
        name: "paseo.speak",
        input: { text: "Tool call speech text." },
        output: { ok: true },
      }),
    );

    expect(item.name).toBe("speak");
    expect(item.detail).toEqual({
      type: "unknown",
      input: "Tool call speech text.",
      output: null,
    });
  });

  it("drops tool-call tool calls when callId is missing", () => {
    const item = mapCodexToolCallEnvelope({
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

  it("maps apply_patch with Delete File directive into edit detail with removed lines", () => {
    const patch = [
      "*** Begin Patch",
      "*** Delete File: /tmp/repo/src/dead-module.ts",
      "*** End Patch",
    ].join("\n");
    const item = expectMapped(
      mapCodexToolCallEnvelope({
        callId: "codex-delete-tool-call",
        name: "apply_patch",
        input: patch,
        output:
          '{"output":"Success. Updated the following files:\\nD /tmp/repo/src/dead-module.ts\\n"}',
        cwd: "/tmp/repo",
      }),
    );

    expect(item.status).toBe("completed");
    expect(item.detail).toMatchInlineSnapshot(`
      {
        "filePath": "src/dead-module.ts",
        "type": "edit",
        "unifiedDiff": "diff --git a//tmp/repo/src/dead-module.ts b//tmp/repo/src/dead-module.ts
      --- a//tmp/repo/src/dead-module.ts
      +++ /dev/null",
      }
    `);
  });

  it("maps multi-file apply_patch with update + delete into edit detail referencing the deleted file", () => {
    // Exact data shape from real Codex tool-call: update one file, delete another
    const patch = [
      "*** Begin Patch",
      "*** Update File: /tmp/repo/src/app/index.tsx",
      "@@",
      ' import { useEffect } from "react";',
      '-import { WELCOME_ROUTE } from "@/app-support/index-startup";',
      "+",
      '+const WELCOME_ROUTE = "/welcome";',
      "*** Delete File: /tmp/repo/src/app-support/index-startup.ts",
      "*** End Patch",
    ].join("\n");

    const item = expectMapped(
      mapCodexToolCallEnvelope({
        callId: "codex-delete-multi",
        name: "apply_patch",
        input: patch,
        output: JSON.stringify({
          output:
            "Success. Updated the following files:\nM /tmp/repo/src/app/index.tsx\nD /tmp/repo/src/app-support/index-startup.ts\n",
          metadata: { exit_code: 0, duration_seconds: 0.0 },
        }),
        cwd: "/tmp/repo",
      }),
    );

    expect(item.detail).toMatchInlineSnapshot(`
      {
        "filePath": "src/app/index.tsx",
        "type": "edit",
        "unifiedDiff": "diff --git a//tmp/repo/src/app/index.tsx b//tmp/repo/src/app/index.tsx
      --- a//tmp/repo/src/app/index.tsx
      +++ b//tmp/repo/src/app/index.tsx
      @@
       import { useEffect } from "react";
      -import { WELCOME_ROUTE } from "@/app-support/index-startup";
      +
      +const WELCOME_ROUTE = "/welcome";

      diff --git a//tmp/repo/src/app-support/index-startup.ts b//tmp/repo/src/app-support/index-startup.ts
      --- a//tmp/repo/src/app-support/index-startup.ts
      +++ /dev/null",
      }
    `);
  });

  it("maps fileChange delete with content as removed lines, not added lines", () => {
    const item = mapCodexToolCallFromThreadItem(
      {
        type: "fileChange",
        id: "codex-file-delete-with-content",
        status: "completed",
        changes: [
          {
            path: "/tmp/repo/src/dead-module.ts",
            kind: "delete",
            content: 'export const FOO = "bar";\nexport function hello() {}\n',
          },
        ],
      },
      { cwd: "/tmp/repo" },
    );

    expect(expectMapped(item).detail).toMatchInlineSnapshot(`
      {
        "filePath": "src/dead-module.ts",
        "type": "edit",
        "unifiedDiff": "diff --git a/src/dead-module.ts b/src/dead-module.ts
      --- a/src/dead-module.ts
      +++ /dev/null
      @@ -1,2 +0,0 @@
      -export const FOO = "bar";
      -export function hello() {}",
      }
    `);
  });

  it("maps fileChange delete without content to edit detail with /dev/null marker", () => {
    const item = mapCodexToolCallFromThreadItem(
      {
        type: "fileChange",
        id: "codex-file-delete-no-content",
        status: "completed",
        changes: [
          {
            path: "/tmp/repo/src/dead-module.ts",
            kind: "delete",
          },
        ],
      },
      { cwd: "/tmp/repo" },
    );

    // A delete without content should still produce a meaningful detail.
    expect(expectMapped(item).detail).toMatchInlineSnapshot(`
      {
        "filePath": "src/dead-module.ts",
        "type": "edit",
        "unifiedDiff": "diff --git a/src/dead-module.ts b/src/dead-module.ts
      --- a/src/dead-module.ts
      +++ /dev/null",
      }
    `);
  });
});
