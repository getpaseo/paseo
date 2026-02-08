import { describe, expect, test } from "vitest";
import {
  stripShellWrapperPrefix,
  normalizeToolDisplayName,
  stripCwdPrefix,
  parseToolCallDisplay,
} from "./tool-call-parsers.js";

describe("stripShellWrapperPrefix", () => {
  test("strips /bin/zsh -lc cd path && prefix", () => {
    const command = "/bin/zsh -lc cd /Users/me/dev/blankpage/editor && npm run format";
    expect(stripShellWrapperPrefix(command)).toBe("npm run format");
  });

  test("strips /bin/zsh -lc \"cd path &&\" wrapper", () => {
    const command = '/bin/zsh -lc "cd /Users/me/dev/blankpage/editor && npm run format"';
    expect(stripShellWrapperPrefix(command)).toBe("npm run format");
  });

  test("strips /bin/zsh -c cd path && prefix", () => {
    const command = "/bin/zsh -c cd /path/to/project && git status";
    expect(stripShellWrapperPrefix(command)).toBe("git status");
  });

  test("strips /bin/bash -lc cd path && prefix", () => {
    const command = "/bin/bash -lc cd /home/user/project && npm test";
    expect(stripShellWrapperPrefix(command)).toBe("npm test");
  });

  test("strips /bin/sh -c cd path && prefix", () => {
    const command = "/bin/sh -c cd /tmp && ls -la";
    expect(stripShellWrapperPrefix(command)).toBe("ls -la");
  });

  test("returns command unchanged when no prefix", () => {
    const command = "npm run build";
    expect(stripShellWrapperPrefix(command)).toBe("npm run build");
  });

  test("strips shell prefix even without cd", () => {
    const command = "/bin/zsh -lc npm run build";
    expect(stripShellWrapperPrefix(command)).toBe("npm run build");
  });

  test("strips when cd path includes spaces in quotes", () => {
    const command = '/bin/zsh -lc cd "/path with spaces" && npm test';
    expect(stripShellWrapperPrefix(command)).toBe("npm test");
  });

  test("strips /bin/zsh -lc with quoted complex command", () => {
    const command =
      '/bin/zsh -lc "adb shell pm list packages | rg \'sh\\.paseo(\\.dev)?\' && adb shell cmd package resolve-activity --brief sh.paseo.dev | tail -n 1"';
    expect(stripShellWrapperPrefix(command)).toBe(
      "adb shell pm list packages | rg 'sh\\.paseo(\\.dev)?' && adb shell cmd package resolve-activity --brief sh.paseo.dev | tail -n 1"
    );
  });
});

describe("normalizeToolDisplayName", () => {
  test("normalizes plain speak name", () => {
    expect(normalizeToolDisplayName("speak")).toBe("Speak");
  });

  test("normalizes codex namespaced speak name", () => {
    expect(normalizeToolDisplayName("paseo_voice.speak")).toBe("Speak");
  });

  test("normalizes claude mcp speak name", () => {
    expect(normalizeToolDisplayName("mcp__paseo_voice__speak")).toBe("Speak");
  });

  test("keeps non-speak names unchanged", () => {
    expect(normalizeToolDisplayName("paseo__create_agent")).toBe(
      "paseo__create_agent"
    );
  });
});

describe("stripCwdPrefix", () => {
  test("strips cwd prefix from file path", () => {
    expect(stripCwdPrefix("/Users/dev/project/src/file.ts", "/Users/dev/project")).toBe("src/file.ts");
  });

  test("returns . for exact cwd match", () => {
    expect(stripCwdPrefix("/Users/dev/project", "/Users/dev/project")).toBe(".");
  });

  test("returns path unchanged when no cwd prefix", () => {
    expect(stripCwdPrefix("/other/path/file.ts", "/Users/dev/project")).toBe("/other/path/file.ts");
  });

  test("returns path unchanged when no cwd provided", () => {
    expect(stripCwdPrefix("/Users/dev/project/file.ts")).toBe("/Users/dev/project/file.ts");
  });
});

describe("parseToolCallDisplay", () => {
  describe("summary (was extractPrincipalParam)", () => {
    test("extracts and strips shell wrapper from command string", () => {
      const result = parseToolCallDisplay({
        provider: "claude",
        name: "Bash",
        input: { command: "/bin/zsh -lc cd /Users/dev/project && npm run format" },
      });
      expect(result.summary).toBe("npm run format");
    });

    test("extracts and strips shell wrapper from command array", () => {
      const result = parseToolCallDisplay({
        name: "shell",
        input: { command: ["/bin/bash", "-lc", "cd /path && git status"] },
      });
      expect(result.summary).toBe("git status");
    });

    test("extracts plain command without shell wrapper", () => {
      const result = parseToolCallDisplay({
        name: "Bash",
        input: { command: "npm run build" },
      });
      expect(result.summary).toBe("npm run build");
    });

    test("falls back to output command when shell input is missing", () => {
      const result = parseToolCallDisplay({
        name: "Bash",
        output: { type: "command", command: "pwd", output: "/tmp" },
      });
      expect(result.summary).toBe("pwd");
    });

    test("extracts file_path and strips cwd", () => {
      const result = parseToolCallDisplay({
        name: "Read",
        input: { file_path: "/Users/dev/project/src/file.ts" },
        cwd: "/Users/dev/project",
      });
      expect(result.summary).toBe("src/file.ts");
    });

    test("falls back to read output path when input is missing", () => {
      const result = parseToolCallDisplay({
        provider: "codex",
        name: "Read",
        output: {
          type: "file_read",
          filePath: "/Users/dev/project/src/file.ts",
          content: "hello",
        },
        cwd: "/Users/dev/project",
      });
      expect(result.summary).toBe("src/file.ts");
    });

    test("falls back to edit output path when input is missing", () => {
      const result = parseToolCallDisplay({
        name: "Edit",
        output: {
          type: "file_edit",
          filePath: "/Users/dev/project/src/file.ts",
          oldContent: "a",
          newContent: "b",
        },
        cwd: "/Users/dev/project",
      });
      expect(result.summary).toBe("src/file.ts");
    });

    test("extracts pattern without modification", () => {
      const result = parseToolCallDisplay({
        name: "Grep",
        input: { pattern: "*.ts" },
      });
      expect(result.summary).toBe("*.ts");
    });

    test("extracts query without modification", () => {
      const result = parseToolCallDisplay({
        name: "WebSearch",
        input: { query: "search term" },
      });
      expect(result.summary).toBe("search term");
    });

    test("extracts url without modification", () => {
      const result = parseToolCallDisplay({
        name: "WebFetch",
        input: { url: "https://example.com" },
      });
      expect(result.summary).toBe("https://example.com");
    });

    test("returns undefined summary for empty input", () => {
      const result = parseToolCallDisplay({ name: "Unknown", input: {} });
      expect(result.summary).toBeUndefined();
    });

    test("extracts description from Task tool", () => {
      const result = parseToolCallDisplay({
        name: "Task",
        input: { description: "Explore the codebase" },
      });
      expect(result.summary).toBe("Explore the codebase");
    });
  });

  describe("summary from metadata", () => {
    test("subAgentActivity in metadata takes priority for Task", () => {
      const result = parseToolCallDisplay({
        name: "Task",
        input: { description: "Explore codebase" },
        metadata: { subAgentActivity: "Read" },
      });
      expect(result.summary).toBe("Read");
    });

    test("metadata merges with input for summary parsing", () => {
      const result = parseToolCallDisplay({
        name: "Task",
        input: {},
        metadata: { subAgentActivity: "Bash" },
      });
      expect(result.summary).toBe("Bash");
    });

    test("non-Task tools keep their parsed summary even when metadata is present", () => {
      const result = parseToolCallDisplay({
        name: "Bash",
        input: { command: "pwd" },
        metadata: { subAgentActivity: "Read" },
      });
      expect(result.summary).toBe("pwd");
    });
  });

  describe("kind", () => {
    test("Read -> read", () => {
      expect(parseToolCallDisplay({ name: "Read" }).kind).toBe("read");
    });

    test("read_file -> read", () => {
      expect(parseToolCallDisplay({ name: "read_file" }).kind).toBe("read");
    });

    test("Edit -> edit", () => {
      expect(parseToolCallDisplay({ name: "Edit" }).kind).toBe("edit");
    });

    test("Write -> edit", () => {
      expect(parseToolCallDisplay({ name: "Write" }).kind).toBe("edit");
    });

    test("apply_patch -> edit", () => {
      expect(parseToolCallDisplay({ name: "apply_patch" }).kind).toBe("edit");
    });

    test("Bash -> execute", () => {
      expect(parseToolCallDisplay({ name: "Bash" }).kind).toBe("execute");
    });

    test("shell -> execute", () => {
      expect(parseToolCallDisplay({ name: "shell" }).kind).toBe("execute");
    });

    test("Grep -> search", () => {
      expect(parseToolCallDisplay({ name: "Grep" }).kind).toBe("search");
    });

    test("Glob -> search", () => {
      expect(parseToolCallDisplay({ name: "Glob" }).kind).toBe("search");
    });

    test("thinking -> thinking", () => {
      expect(parseToolCallDisplay({ name: "thinking" }).kind).toBe("thinking");
    });

    test("unknown tool -> tool", () => {
      expect(parseToolCallDisplay({ name: "MyCustomTool" }).kind).toBe("tool");
    });
  });

  describe("displayName", () => {
    test("shell -> Shell", () => {
      expect(parseToolCallDisplay({ name: "shell" }).displayName).toBe("Shell");
    });

    test("Bash -> Shell", () => {
      expect(parseToolCallDisplay({ name: "Bash" }).displayName).toBe("Shell");
    });

    test("read_file -> Read", () => {
      expect(parseToolCallDisplay({ name: "read_file" }).displayName).toBe("Read");
    });

    test("apply_patch -> Edit", () => {
      expect(parseToolCallDisplay({ name: "apply_patch" }).displayName).toBe("Edit");
    });

    test("preserves unknown tool names", () => {
      expect(parseToolCallDisplay({ name: "MyCustomTool" }).displayName).toBe("MyCustomTool");
    });

    test("normalizes speak variants", () => {
      expect(parseToolCallDisplay({ name: "paseo_voice.speak" }).displayName).toBe("Speak");
      expect(parseToolCallDisplay({ name: "mcp__paseo_voice__speak" }).displayName).toBe("Speak");
    });
  });

  describe("errorText", () => {
    test("formats string error", () => {
      const result = parseToolCallDisplay({
        name: "Bash",
        error: "something broke",
      });
      expect(result.errorText).toBe("something broke");
    });

    test("extracts content from tool_result error", () => {
      const result = parseToolCallDisplay({
        name: "Bash",
        error: { type: "tool_result", content: "Exit code 1", is_error: true },
      });
      expect(result.errorText).toBe("Exit code 1");
    });

    test("returns undefined for no error", () => {
      const result = parseToolCallDisplay({ name: "Read" });
      expect(result.errorText).toBeUndefined();
    });
  });
});
