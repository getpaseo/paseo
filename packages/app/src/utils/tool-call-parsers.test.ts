import { describe, test, expect } from "vitest";
import {
  extractKeyValuePairs,
  parseToolCallDisplay,
  type ToolCallDisplay,
} from "./tool-call-parsers";

describe("tool-call-parsers - real runtime shapes", () => {
  // Real data captured from Claude agent test: "shows the command inside pending tool calls"
  // Run: npx vitest run claude-agent.test.ts -t "shows the command"

  test("bash tool call - input shape", () => {
    // REAL shape from Claude SDK timeline event (status: pending/completed)
    const bashInput = {
      command: "pwd",
      description: "Print working directory",
    };

    const pairs = extractKeyValuePairs(bashInput);
    expect(pairs).toContainEqual({ key: "command", value: "pwd" });
    expect(pairs).toContainEqual({ key: "description", value: "Print working directory" });
  });

  test("bash tool call - output shape (completed)", () => {
    // REAL shape from Claude SDK timeline event (status: completed)
    // NOTE: output already has type: "command" discriminator!
    const bashOutput = {
      type: "command",
      command: "pwd",
      output: "/private/var/folders/xl/kkk9drfd3ms_t8x7rmy4z6900000gn/T/claude-agent-e2e-9tnmUm",
    };

    const pairs = extractKeyValuePairs(bashOutput);
    expect(pairs).toContainEqual({ key: "type", value: "command" });
    expect(pairs).toContainEqual({ key: "command", value: "pwd" });
    expect(pairs).toContainEqual({ key: "output", value: expect.stringContaining("claude-agent") });
  });
});

describe("parseToolCallDisplay", () => {
  test("parses completed bash tool call into shell type", () => {
    const input = { command: "pwd", description: "Print working directory" };
    const result = { type: "command", command: "pwd", output: "/some/path" };

    const display: ToolCallDisplay = parseToolCallDisplay(input, result);
    expect(display.type).toBe("shell");
    if (display.type === "shell") {
      expect(display.command).toBe("pwd");
      expect(display.output).toBe("/some/path");
    }
  });

  test("parses pending bash tool call into shell type with empty output", () => {
    // When tool is pending, we have input but no result yet
    const input = { command: "pwd", description: "Print working directory" };
    const result = undefined;

    const display: ToolCallDisplay = parseToolCallDisplay(input, result);
    expect(display.type).toBe("shell");
    if (display.type === "shell") {
      expect(display.command).toBe("pwd");
      expect(display.output).toBe("");
    }
  });

  test("handles command as array", () => {
    const input = { command: ["git", "status"] };
    const result = { type: "command", output: "On branch main" };

    const display: ToolCallDisplay = parseToolCallDisplay(input, result);
    expect(display.type).toBe("shell");
    if (display.type === "shell") {
      expect(display.command).toBe("git status");
      expect(display.output).toBe("On branch main");
    }
  });

  test("parses non-command tool call into generic type", () => {
    const input = { file_path: "/some/file.txt" };
    const result = { content: "file contents here", lineCount: 42 };

    const display: ToolCallDisplay = parseToolCallDisplay(input, result);
    expect(display.type).toBe("generic");
    if (display.type === "generic") {
      expect(display.input).toContainEqual({ key: "file_path", value: "/some/file.txt" });
      expect(display.output).toContainEqual({ key: "content", value: "file contents here" });
      expect(display.output).toContainEqual({ key: "lineCount", value: "42" });
    }
  });

  test("handles file_write output as generic", () => {
    const input = { file_path: "/some/file.txt", content: "new content" };
    const result = { type: "file_write", filePath: "/some/file.txt" };

    const display: ToolCallDisplay = parseToolCallDisplay(input, result);
    expect(display.type).toBe("generic");
  });

  test("handles undefined input and result gracefully", () => {
    const display: ToolCallDisplay = parseToolCallDisplay(undefined, undefined);
    expect(display.type).toBe("generic");
    if (display.type === "generic") {
      expect(display.input).toEqual([]);
      expect(display.output).toEqual([]);
    }
  });

  test("parses edit tool call into edit type with old_string/new_string", () => {
    const input = {
      file_path: "/some/file.txt",
      old_string: "const foo = 1;",
      new_string: "const foo = 2;",
    };
    const result = {
      type: "file_edit",
      filePath: "/some/file.txt",
    };

    const display: ToolCallDisplay = parseToolCallDisplay(input, result);
    expect(display.type).toBe("edit");
    if (display.type === "edit") {
      expect(display.filePath).toBe("/some/file.txt");
      expect(display.oldString).toBe("const foo = 1;");
      expect(display.newString).toBe("const foo = 2;");
    }
  });

  test("parses edit tool call with old_str/new_str variants", () => {
    const input = {
      file_path: "/some/file.txt",
      old_str: "line 1",
      new_str: "line 2",
    };
    const result = undefined;

    const display: ToolCallDisplay = parseToolCallDisplay(input, result);
    expect(display.type).toBe("edit");
    if (display.type === "edit") {
      expect(display.filePath).toBe("/some/file.txt");
      expect(display.oldString).toBe("line 1");
      expect(display.newString).toBe("line 2");
    }
  });

  test("parses pending edit tool call (no result yet)", () => {
    const input = {
      file_path: "/some/file.txt",
      old_string: "old content",
      new_string: "new content",
    };

    const display: ToolCallDisplay = parseToolCallDisplay(input, undefined);
    expect(display.type).toBe("edit");
    if (display.type === "edit") {
      expect(display.filePath).toBe("/some/file.txt");
      expect(display.oldString).toBe("old content");
      expect(display.newString).toBe("new content");
    }
  });
});
