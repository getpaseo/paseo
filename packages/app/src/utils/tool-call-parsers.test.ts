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

    const display: ToolCallDisplay = parseToolCallDisplay("Bash", input, result);
    expect(display.type).toBe("shell");
    expect(display.toolName).toBe("Shell");
    if (display.type === "shell") {
      expect(display.command).toBe("pwd");
      expect(display.output).toBe("/some/path");
    }
  });

  test("parses pending bash tool call into shell type with empty output", () => {
    // When tool is pending, we have input but no result yet
    const input = { command: "pwd", description: "Print working directory" };
    const result = undefined;

    const display: ToolCallDisplay = parseToolCallDisplay("Bash", input, result);
    expect(display.type).toBe("shell");
    expect(display.toolName).toBe("Shell");
    if (display.type === "shell") {
      expect(display.command).toBe("pwd");
      expect(display.output).toBe("");
    }
  });

  test("strips shell + cd wrapper from command (Codex exec_command style)", () => {
    const input = {
      command:
        '/bin/zsh -lc "cd /Users/moboudra/dev/paseo && nl -ba packages/app/src/utils/tool-call-parsers.test.ts | sed -n \'150,260p\'"',
    };

    const display: ToolCallDisplay = parseToolCallDisplay("shell", input, undefined);
    expect(display.type).toBe("shell");
    if (display.type === "shell") {
      expect(display.command).toBe(
        "nl -ba packages/app/src/utils/tool-call-parsers.test.ts | sed -n '150,260p'"
      );
    }
  });

  test("handles command as array", () => {
    const input = { command: ["git", "status"] };
    const result = { type: "command", output: "On branch main" };

    const display: ToolCallDisplay = parseToolCallDisplay("shell", input, result);
    expect(display.type).toBe("shell");
    expect(display.toolName).toBe("Shell");
    if (display.type === "shell") {
      expect(display.command).toBe("git status");
      expect(display.output).toBe("On branch main");
    }
  });

  test("normalizes tool names - shell to Shell", () => {
    const input = { command: "pwd" };
    const display = parseToolCallDisplay("shell", input, undefined);
    expect(display.toolName).toBe("Shell");
  });

  test("normalizes tool names - Bash to Shell", () => {
    const input = { command: "pwd" };
    const display = parseToolCallDisplay("Bash", input, undefined);
    expect(display.toolName).toBe("Shell");
  });

  test("normalizes tool names - read_file to Read", () => {
    const input = { file_path: "/some/file.txt" };
    const display = parseToolCallDisplay("read_file", input, undefined);
    expect(display.toolName).toBe("Read");
  });

  test("preserves unknown tool names", () => {
    const input = { some_arg: "value" };
    const display = parseToolCallDisplay("MyCustomTool", input, undefined);
    expect(display.toolName).toBe("MyCustomTool");
  });

  test("parses non-command tool call into generic type", () => {
    const input = { file_path: "/some/file.txt" };
    const result = { content: "file contents here", lineCount: 42 };

    const display: ToolCallDisplay = parseToolCallDisplay("SomeTool", input, result);
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

    const display: ToolCallDisplay = parseToolCallDisplay("Write", input, result);
    expect(display.type).toBe("generic");
  });

  test("handles undefined input and result gracefully", () => {
    const display: ToolCallDisplay = parseToolCallDisplay("unknown", undefined, undefined);
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

    const display: ToolCallDisplay = parseToolCallDisplay("Edit", input, result);
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

    const display: ToolCallDisplay = parseToolCallDisplay("Edit", input, result);
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

    const display: ToolCallDisplay = parseToolCallDisplay("Edit", input, undefined);
    expect(display.type).toBe("edit");
    if (display.type === "edit") {
      expect(display.filePath).toBe("/some/file.txt");
      expect(display.oldString).toBe("old content");
      expect(display.newString).toBe("new content");
    }
  });
});

describe("parseToolCallDisplay - apply_patch (Codex)", () => {
  test("parses apply_patch into edit type with unified diff", () => {
    const input = {
      files: [
        {
          path: "/Users/moboudra/dev/blankpage/editor/.tasks/578561c8.md",
          kind: "update",
        },
      ],
    };
    const result = {
      files: [
        {
          path: "/Users/moboudra/dev/blankpage/editor/.tasks/578561c8.md",
          patch: "@@ -15,3 +15,2 @@\n-This task defines the **design philosophy**\n+This task defines the **updated philosophy**",
          kind: "update",
        },
      ],
      message: "Success. Updated the following files:\nM .tasks/578561c8.md",
      success: true,
    };

    const display = parseToolCallDisplay("apply_patch", input, result);
    expect(display.type).toBe("edit");
    expect(display.toolName).toBe("Edit");
    if (display.type === "edit") {
      expect(display.filePath).toBe("/Users/moboudra/dev/blankpage/editor/.tasks/578561c8.md");
      expect(display.unifiedDiff).toBe("@@ -15,3 +15,2 @@\n-This task defines the **design philosophy**\n+This task defines the **updated philosophy**");
      expect(display.oldString).toBe("");
      expect(display.newString).toBe("");
    }
  });

  test("parses apply_patch with kind object (type/move_path) into edit type", () => {
    const input = {
      files: [
        {
          path: "/Users/moboudra/-paseo/worktrees/paseo/naive-zebra/packages/server/src/server/daemon-keypair.ts",
          kind: { type: "update", move_path: null },
        },
      ],
    };
    const result = {
      files: [
        {
          path: "/Users/moboudra/-paseo/worktrees/paseo/naive-zebra/packages/server/src/server/daemon-keypair.ts",
          patch: "@@ -1,1 +1,1 @@\n-foo\n+bar",
          kind: { type: "update", move_path: null },
        },
      ],
      success: true,
    };

    const display = parseToolCallDisplay("apply_patch", input, result);
    expect(display.type).toBe("edit");
    expect(display.toolName).toBe("Edit");
    if (display.type === "edit") {
      expect(display.filePath).toBe(
        "/Users/moboudra/-paseo/worktrees/paseo/naive-zebra/packages/server/src/server/daemon-keypair.ts"
      );
      expect(display.unifiedDiff).toBe("@@ -1,1 +1,1 @@\n-foo\n+bar");
    }
  });

  test("prefers move_path for display but still finds patch by original path", () => {
    const input = {
      files: [
        {
          path: "/some/old-path.txt",
          kind: { type: "update", move_path: "/some/new-path.txt" },
        },
      ],
    };
    const result = {
      files: [
        {
          path: "/some/old-path.txt",
          patch: "@@ -1,1 +1,1 @@\n-old\n+new",
          kind: { type: "update", move_path: "/some/new-path.txt" },
        },
      ],
      success: true,
    };

    const display = parseToolCallDisplay("apply_patch", input, result);
    expect(display.type).toBe("edit");
    if (display.type === "edit") {
      expect(display.filePath).toBe("/some/new-path.txt");
      expect(display.unifiedDiff).toBe("@@ -1,1 +1,1 @@\n-old\n+new");
    }
  });

  test("parses pending apply_patch (no result yet)", () => {
    const input = {
      files: [
        {
          path: "/some/file.txt",
          kind: "create",
        },
      ],
    };

    const display = parseToolCallDisplay("apply_patch", input, undefined);
    expect(display.type).toBe("edit");
    expect(display.toolName).toBe("Edit");
    if (display.type === "edit") {
      expect(display.filePath).toBe("/some/file.txt");
      expect(display.unifiedDiff).toBeUndefined();
    }
  });

  test("handles apply_patch with multiple files (uses first file)", () => {
    const input = {
      files: [
        { path: "/first/file.txt", kind: "update" },
        { path: "/second/file.txt", kind: "create" },
      ],
    };
    const result = {
      files: [
        { path: "/first/file.txt", patch: "@@ -1 +1 @@\n-old\n+new", kind: "update" },
        { path: "/second/file.txt", patch: "@@ -0,0 +1 @@\n+content", kind: "create" },
      ],
      success: true,
    };

    const display = parseToolCallDisplay("apply_patch", input, result);
    expect(display.type).toBe("edit");
    if (display.type === "edit") {
      expect(display.filePath).toBe("/first/file.txt");
      expect(display.unifiedDiff).toBe("@@ -1 +1 @@\n-old\n+new");
    }
  });
});

describe("parseToolCallDisplay - read_file (Codex)", () => {
  test("parses Codex read_file into read type", () => {
    const input = {
      path: "/Users/moboudra/dev/blankpage/editor/.tasks/578561c8.md",
    };
    const result = {
      type: "read_file",
      path: "/Users/moboudra/dev/blankpage/editor/.tasks/578561c8.md",
      content: "260  - Source: `**bold**|`\n261  - Action: `Shift+ArrowLeft`",
    };

    const display = parseToolCallDisplay("read_file", input, result);
    expect(display.type).toBe("read");
    expect(display.toolName).toBe("Read");
    if (display.type === "read") {
      expect(display.filePath).toBe("/Users/moboudra/dev/blankpage/editor/.tasks/578561c8.md");
      expect(display.content).toBe("260  - Source: `**bold**|`\n261  - Action: `Shift+ArrowLeft`");
    }
  });

  test("Codex read_file falls through to generic when result is missing", () => {
    const input = {
      path: "/some/file.txt",
    };

    const display = parseToolCallDisplay("read_file", input, undefined);
    // Without result, it can't match the schema so falls through to generic
    expect(display.type).toBe("generic");
    expect(display.toolName).toBe("Read");
  });
});
