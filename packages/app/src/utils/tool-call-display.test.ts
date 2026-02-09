import { describe, expect, it } from "vitest";

import { buildToolCallDisplayModel } from "./tool-call-display";

describe("tool-call-display", () => {
  it("builds display model from canonical shell detail", () => {
    const display = buildToolCallDisplayModel({
      name: "shell",
      status: "running",
      input: { command: "npm test" },
      output: null,
      error: null,
      detail: {
        type: "shell",
        command: "npm test",
      },
    });

    expect(display).toEqual({
      displayName: "Shell",
      summary: "npm test",
    });
  });

  it("builds display model from canonical read detail", () => {
    const display = buildToolCallDisplayModel({
      name: "read_file",
      status: "completed",
      input: { path: "/tmp/repo/src/index.ts" },
      output: { content: "hello" },
      error: null,
      detail: {
        type: "read",
        filePath: "/tmp/repo/src/index.ts",
      },
      cwd: "/tmp/repo",
    });

    expect(display).toEqual({
      displayName: "Read",
      summary: "src/index.ts",
    });
  });

  it("uses metadata summary for task tool calls", () => {
    const display = buildToolCallDisplayModel({
      name: "task",
      status: "running",
      input: null,
      output: null,
      error: null,
      metadata: {
        subAgentActivity: "Running tests",
      },
    });

    expect(display).toEqual({
      displayName: "Task",
      summary: "Running tests",
    });
  });

  it("falls back to humanized tool name for unknown tools", () => {
    const display = buildToolCallDisplayModel({
      name: "custom_tool_name",
      status: "completed",
      input: null,
      output: null,
      error: null,
    });

    expect(display).toEqual({
      displayName: "Custom Tool Name",
    });
  });

  it("does not derive command summary from raw input when detail is missing", () => {
    const display = buildToolCallDisplayModel({
      name: "exec_command",
      status: "running",
      input: { command: "npm run test" },
      output: null,
      error: null,
    });

    expect(display).toEqual({
      displayName: "Exec Command",
    });
  });

  it("returns formatted errorText from the same display pipeline", () => {
    const display = buildToolCallDisplayModel({
      name: "shell",
      status: "failed",
      input: { command: "false" },
      output: null,
      error: { message: "boom" },
    });

    expect(display.errorText).toBe('{\n  "message": "boom"\n}');
  });
});
