import { describe, expect, it } from "vitest";

import { buildToolCallDisplayModel } from "./tool-call-display.js";

describe("shared tool-call display mapping", () => {
  it("builds summary from canonical detail", () => {
    const display = buildToolCallDisplayModel({
      name: "read_file",
      status: "running",
      input: { path: "/tmp/repo/src/index.ts" },
      output: null,
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

  it("does not infer summaries from raw input when detail is missing", () => {
    const display = buildToolCallDisplayModel({
      name: "exec_command",
      status: "running",
      input: { command: "npm test" },
      output: null,
      error: null,
    });

    expect(display).toEqual({
      displayName: "Exec Command",
    });
  });

  it("keeps task metadata summary without detail", () => {
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

  it("provides errorText for failed calls", () => {
    const display = buildToolCallDisplayModel({
      name: "shell",
      status: "failed",
      input: null,
      output: null,
      error: { message: "boom" },
    });

    expect(display.errorText).toBe('{\n  "message": "boom"\n}');
  });
});
