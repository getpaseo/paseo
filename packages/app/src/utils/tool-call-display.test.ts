import { describe, expect, it } from "vitest";

import { buildToolCallDisplayModel, formatToolCallError } from "./tool-call-display";

describe("tool-call-display", () => {
  it("builds display model from canonical shell detail", () => {
    const display = buildToolCallDisplayModel({
      name: "shell",
      detail: {
        type: "shell",
        command: "npm test",
      },
    });

    expect(display).toEqual({
      kind: "execute",
      displayName: "Shell",
      summary: "npm test",
    });
  });

  it("builds display model from canonical read detail", () => {
    const display = buildToolCallDisplayModel({
      name: "read_file",
      detail: {
        type: "read",
        filePath: "/tmp/repo/src/index.ts",
      },
      cwd: "/tmp/repo",
    });

    expect(display).toEqual({
      kind: "read",
      displayName: "Read",
      summary: "src/index.ts",
    });
  });

  it("uses metadata summary for task tool calls", () => {
    const display = buildToolCallDisplayModel({
      name: "task",
      metadata: {
        subAgentActivity: "Running tests",
      },
    });

    expect(display).toEqual({
      kind: "agent",
      displayName: "Task",
      summary: "Running tests",
    });
  });

  it("falls back to humanized tool name for unknown tools", () => {
    const display = buildToolCallDisplayModel({
      name: "custom_tool_name",
    });

    expect(display).toEqual({
      kind: "tool",
      displayName: "Custom Tool Name",
    });
  });

  it("formats non-string errors", () => {
    expect(formatToolCallError({ message: "boom" })).toBe('{\n  "message": "boom"\n}');
  });
});
