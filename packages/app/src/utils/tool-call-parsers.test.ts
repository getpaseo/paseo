import { describe, test, expect } from "vitest";
import {
  extractKeyValuePairs,
  parseToolCallDisplay,
  type ToolCallDisplayInfo,
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
  test("parses completed bash tool call into shell detail", () => {
    const input = { command: "pwd", description: "Print working directory" };
    const output = { type: "command", command: "pwd", output: "/some/path" };

    const info: ToolCallDisplayInfo = parseToolCallDisplay({ name: "Bash", input, output });
    expect(info.detail.type).toBe("shell");
    expect(info.displayName).toBe("Shell");
    if (info.detail.type === "shell") {
      expect(info.detail.command).toBe("pwd");
      expect(info.detail.output).toBe("/some/path");
    }
  });

  test("parses pending bash tool call into shell detail with empty output", () => {
    // When tool is pending, we have input but no result yet
    const input = { command: "pwd", description: "Print working directory" };

    const info: ToolCallDisplayInfo = parseToolCallDisplay({ name: "Bash", input });
    expect(info.detail.type).toBe("shell");
    expect(info.displayName).toBe("Shell");
    if (info.detail.type === "shell") {
      expect(info.detail.command).toBe("pwd");
      expect(info.detail.output).toBe("");
    }
  });

  test("falls back to output command when shell input is missing", () => {
    const output = { type: "command", command: "pwd", output: "/some/path" };

    const info: ToolCallDisplayInfo = parseToolCallDisplay({ name: "Bash", output });
    expect(info.summary).toBe("pwd");
    expect(info.detail.type).toBe("shell");
    if (info.detail.type === "shell") {
      expect(info.detail.command).toBe("pwd");
      expect(info.detail.output).toBe("/some/path");
    }
  });

  test("falls back to read output path when input is missing", () => {
    const info: ToolCallDisplayInfo = parseToolCallDisplay({
      name: "Read",
      output: {
        type: "file_read",
        filePath: "/some/file.txt",
        content: "hello",
      },
    });
    expect(info.summary).toBe("/some/file.txt");
    expect(info.detail.type).toBe("read");
    if (info.detail.type === "read") {
      expect(info.detail.filePath).toBe("/some/file.txt");
      expect(info.detail.content).toBe("hello");
    }
  });

  test("strips shell + cd wrapper from command (Codex exec_command style)", () => {
    const input = {
      command:
        '/bin/zsh -lc "cd /Users/me/dev/paseo && nl -ba packages/app/src/utils/tool-call-parsers.test.ts | sed -n \'150,260p\'"',
    };

    const info: ToolCallDisplayInfo = parseToolCallDisplay({ name: "shell", input });
    expect(info.detail.type).toBe("shell");
    if (info.detail.type === "shell") {
      expect(info.detail.command).toBe(
        "nl -ba packages/app/src/utils/tool-call-parsers.test.ts | sed -n '150,260p'"
      );
    }
  });

  test("handles command as array", () => {
    const input = { command: ["git", "status"] };
    const output = { type: "command", output: "On branch main" };

    const info: ToolCallDisplayInfo = parseToolCallDisplay({ name: "shell", input, output });
    expect(info.detail.type).toBe("shell");
    expect(info.displayName).toBe("Shell");
    if (info.detail.type === "shell") {
      expect(info.detail.command).toBe("git status");
      expect(info.detail.output).toBe("On branch main");
    }
  });

  test("normalizes tool names - shell to Shell", () => {
    const input = { command: "pwd" };
    const info = parseToolCallDisplay({ name: "shell", input });
    expect(info.displayName).toBe("Shell");
  });

  test("normalizes tool names - Bash to Shell", () => {
    const input = { command: "pwd" };
    const info = parseToolCallDisplay({ name: "Bash", input });
    expect(info.displayName).toBe("Shell");
  });

  test("normalizes tool names - read_file to Read", () => {
    const input = { file_path: "/some/file.txt" };
    const info = parseToolCallDisplay({ name: "read_file", input });
    expect(info.displayName).toBe("Read");
  });

  test("uses stable label for Edit in frontend", () => {
    const input = { file_path: "/some/file.txt", old_string: "a", new_string: "b" };
    const first = parseToolCallDisplay({ name: "Edit", input });
    const second = parseToolCallDisplay({ name: "Edit", input });
    expect(first.displayName).toBe("Edit");
    expect(second.displayName).toBe("Edit");
  });

  test("normalizes tool names - paseo_voice.speak to Speak", () => {
    const input = { text: "hello from namespaced speak" };
    const info = parseToolCallDisplay({ name: "paseo_voice.speak", input });
    expect(info.displayName).toBe("Speak");
  });

  test("normalizes tool names - mcp__paseo_voice__speak to Speak", () => {
    const input = { text: "hello from claude mcp speak" };
    const info = parseToolCallDisplay({ name: "mcp__paseo_voice__speak", input });
    expect(info.displayName).toBe("Speak");
  });

  test("preserves unknown tool names", () => {
    const input = { some_arg: "value" };
    const info = parseToolCallDisplay({ name: "MyCustomTool", input });
    expect(info.displayName).toBe("MyCustomTool");
  });

  test("does not let Task metadata override non-Task summary", () => {
    const info = parseToolCallDisplay({
      name: "shell",
      input: { command: "pwd" },
      metadata: { subAgentActivity: "Read" },
    });
    expect(info.summary).toBe("pwd");
  });

  test("parses non-command tool call into generic detail", () => {
    const input = { file_path: "/some/file.txt" };
    const output = { content: "file contents here", lineCount: 42 };

    const info: ToolCallDisplayInfo = parseToolCallDisplay({ name: "SomeTool", input, output });
    expect(info.detail.type).toBe("generic");
    if (info.detail.type === "generic") {
      expect(info.detail.input).toContainEqual({ key: "file_path", value: "/some/file.txt" });
      expect(info.detail.output).toContainEqual({ key: "content", value: "file contents here" });
      expect(info.detail.output).toContainEqual({ key: "lineCount", value: "42" });
    }
  });

  test("handles file_write output as edit", () => {
    const input = { file_path: "/some/file.txt", content: "new content" };
    const output = { type: "file_write", filePath: "/some/file.txt" };

    const info: ToolCallDisplayInfo = parseToolCallDisplay({ name: "Write", input, output });
    expect(info.detail.type).toBe("edit");
    expect(info.summary).toBe("/some/file.txt");
    if (info.detail.type === "edit") {
      expect(info.detail.filePath).toBe("/some/file.txt");
    }
  });

  test("handles undefined input and output gracefully", () => {
    const info: ToolCallDisplayInfo = parseToolCallDisplay({ name: "unknown" });
    expect(info.detail.type).toBe("generic");
    if (info.detail.type === "generic") {
      expect(info.detail.input).toEqual([]);
      expect(info.detail.output).toEqual([]);
    }
  });

  test("parses edit tool call into edit detail with old_string/new_string", () => {
    const input = {
      file_path: "/some/file.txt",
      old_string: "const foo = 1;",
      new_string: "const foo = 2;",
    };
    const output = {
      type: "file_edit",
      filePath: "/some/file.txt",
    };

    const info: ToolCallDisplayInfo = parseToolCallDisplay({ name: "Edit", input, output });
    expect(info.detail.type).toBe("edit");
    if (info.detail.type === "edit") {
      expect(info.detail.filePath).toBe("/some/file.txt");
      expect(info.detail.oldString).toBe("const foo = 1;");
      expect(info.detail.newString).toBe("const foo = 2;");
    }
  });

  test("parses edit tool call with old_str/new_str variants", () => {
    const input = {
      file_path: "/some/file.txt",
      old_str: "line 1",
      new_str: "line 2",
    };

    const info: ToolCallDisplayInfo = parseToolCallDisplay({ name: "Edit", input });
    expect(info.detail.type).toBe("edit");
    if (info.detail.type === "edit") {
      expect(info.detail.filePath).toBe("/some/file.txt");
      expect(info.detail.oldString).toBe("line 1");
      expect(info.detail.newString).toBe("line 2");
    }
  });

  test("parses pending edit tool call (no result yet)", () => {
    const input = {
      file_path: "/some/file.txt",
      old_string: "old content",
      new_string: "new content",
    };

    const info: ToolCallDisplayInfo = parseToolCallDisplay({ name: "Edit", input });
    expect(info.detail.type).toBe("edit");
    if (info.detail.type === "edit") {
      expect(info.detail.filePath).toBe("/some/file.txt");
      expect(info.detail.oldString).toBe("old content");
      expect(info.detail.newString).toBe("new content");
    }
  });
});

describe("parseToolCallDisplay - apply_patch (Codex)", () => {
  test("parses apply_patch into edit detail with unified diff", () => {
    const input = {
      files: [
        {
          path: "/Users/me/dev/blankpage/editor/.tasks/578561c8.md",
          kind: "update",
        },
      ],
    };
    const output = {
      files: [
        {
          path: "/Users/me/dev/blankpage/editor/.tasks/578561c8.md",
          patch: "@@ -15,3 +15,2 @@\n-This task defines the **design philosophy**\n+This task defines the **updated philosophy**",
          kind: "update",
        },
      ],
      message: "Success. Updated the following files:\nM .tasks/578561c8.md",
      success: true,
    };

    const info = parseToolCallDisplay({ name: "apply_patch", input, output });
    expect(info.detail.type).toBe("edit");
    expect(info.displayName).toBe("Edit");
    if (info.detail.type === "edit") {
      expect(info.detail.filePath).toBe("/Users/me/dev/blankpage/editor/.tasks/578561c8.md");
      expect(info.detail.unifiedDiff).toBe("@@ -15,3 +15,2 @@\n-This task defines the **design philosophy**\n+This task defines the **updated philosophy**");
      expect(info.detail.oldString).toBe("");
      expect(info.detail.newString).toBe("");
    }
  });

  test("parses apply_patch with kind object (type/move_path) into edit detail", () => {
    const input = {
      files: [
        {
          path: "/Users/me/.paseo/worktrees/paseo/naive-zebra/packages/server/src/server/daemon-keypair.ts",
          kind: { type: "update", move_path: null },
        },
      ],
    };
    const output = {
      files: [
        {
          path: "/Users/me/.paseo/worktrees/paseo/naive-zebra/packages/server/src/server/daemon-keypair.ts",
          patch: "@@ -1,1 +1,1 @@\n-foo\n+bar",
          kind: { type: "update", move_path: null },
        },
      ],
      success: true,
    };

    const info = parseToolCallDisplay({ name: "apply_patch", input, output });
    expect(info.detail.type).toBe("edit");
    expect(info.displayName).toBe("Edit");
    if (info.detail.type === "edit") {
      expect(info.detail.filePath).toBe(
        "/Users/me/.paseo/worktrees/paseo/naive-zebra/packages/server/src/server/daemon-keypair.ts"
      );
      expect(info.detail.unifiedDiff).toBe("@@ -1,1 +1,1 @@\n-foo\n+bar");
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
    const output = {
      files: [
        {
          path: "/some/old-path.txt",
          patch: "@@ -1,1 +1,1 @@\n-old\n+new",
          kind: { type: "update", move_path: "/some/new-path.txt" },
        },
      ],
      success: true,
    };

    const info = parseToolCallDisplay({ name: "apply_patch", input, output });
    expect(info.detail.type).toBe("edit");
    if (info.detail.type === "edit") {
      expect(info.detail.filePath).toBe("/some/new-path.txt");
      expect(info.detail.unifiedDiff).toBe("@@ -1,1 +1,1 @@\n-old\n+new");
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

    const info = parseToolCallDisplay({ name: "apply_patch", input });
    expect(info.detail.type).toBe("edit");
    expect(info.displayName).toBe("Edit");
    if (info.detail.type === "edit") {
      expect(info.detail.filePath).toBe("/some/file.txt");
      expect(info.detail.unifiedDiff).toBeUndefined();
    }
  });

  test("handles apply_patch with multiple files (uses first file)", () => {
    const input = {
      files: [
        { path: "/first/file.txt", kind: "update" },
        { path: "/second/file.txt", kind: "create" },
      ],
    };
    const output = {
      files: [
        { path: "/first/file.txt", patch: "@@ -1 +1 @@\n-old\n+new", kind: "update" },
        { path: "/second/file.txt", patch: "@@ -0,0 +1 @@\n+content", kind: "create" },
      ],
      success: true,
    };

    const info = parseToolCallDisplay({ name: "apply_patch", input, output });
    expect(info.detail.type).toBe("edit");
    if (info.detail.type === "edit") {
      expect(info.detail.filePath).toBe("/first/file.txt");
      expect(info.detail.unifiedDiff).toBe("@@ -1 +1 @@\n-old\n+new");
    }
  });
});

describe("parseToolCallDisplay - read_file (Codex)", () => {
  test("parses Codex read_file into read detail", () => {
    const input = {
      path: "/Users/me/dev/blankpage/editor/.tasks/578561c8.md",
    };
    const output = {
      type: "read_file",
      path: "/Users/me/dev/blankpage/editor/.tasks/578561c8.md",
      content: "260  - Source: `**bold**|`\n261  - Action: `Shift+ArrowLeft`",
    };

    const info = parseToolCallDisplay({ name: "read_file", input, output });
    expect(info.detail.type).toBe("read");
    expect(info.displayName).toBe("Read");
    if (info.detail.type === "read") {
      expect(info.detail.filePath).toBe("/Users/me/dev/blankpage/editor/.tasks/578561c8.md");
      expect(info.detail.content).toBe("260  - Source: `**bold**|`\n261  - Action: `Shift+ArrowLeft`");
    }
  });

  test("Codex read_file stays read when result is missing", () => {
    const input = {
      path: "/some/file.txt",
    };

    const info = parseToolCallDisplay({ name: "read_file", input });
    expect(info.detail.type).toBe("read");
    expect(info.displayName).toBe("Read");
  });
});
