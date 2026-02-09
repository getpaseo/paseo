import { describe, expect, it } from "vitest";

import { buildToolCallDisplayModel } from "./tool-call-display.js";

describe("shared tool-call display mapping", () => {
  it("builds summary from canonical detail", () => {
    const display = buildToolCallDisplayModel({
      name: "read_file",
      status: "running",
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

  it("does not infer summaries from unknown raw detail", () => {
    const display = buildToolCallDisplayModel({
      name: "exec_command",
      status: "running",
      error: null,
      detail: {
        type: "unknown",
        rawInput: { command: "npm test" },
        rawOutput: null,
      },
    });

    expect(display).toEqual({
      displayName: "Exec Command",
    });
  });

  it("keeps task metadata summary on unknown detail", () => {
    const display = buildToolCallDisplayModel({
      name: "task",
      status: "running",
      error: null,
      detail: {
        type: "unknown",
        rawInput: null,
        rawOutput: null,
      },
      metadata: {
        subAgentActivity: "Running tests",
      },
    });

    expect(display).toEqual({
      displayName: "Task",
      summary: "Running tests",
    });
  });

  it("provides errorText for failed calls", () => {
    const display = buildToolCallDisplayModel({
      name: "shell",
      status: "failed",
      error: { message: "boom" },
      detail: {
        type: "unknown",
        rawInput: null,
        rawOutput: null,
      },
    });

    expect(display.errorText).toBe('{\n  "message": "boom"\n}');
  });
});
