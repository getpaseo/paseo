import { afterEach, describe, expect, test } from "vitest";
import { quoteWindowsArgument, quoteWindowsCommand } from "./windows-command.js";

describe("quoteWindowsCommand", () => {
  const originalPlatform = process.platform;

  function setPlatform(value: string) {
    Object.defineProperty(process, "platform", { value, writable: true });
  }

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  test("quotes a Windows path with spaces", () => {
    setPlatform("win32");
    expect(quoteWindowsCommand("C:\\Program Files\\Anthropic\\claude.exe")).toBe(
      '"C:\\Program Files\\Anthropic\\claude.exe"',
    );
  });

  test("does not double-quote an already-quoted path", () => {
    setPlatform("win32");
    expect(quoteWindowsCommand('"C:\\Program Files\\Anthropic\\claude.exe"')).toBe(
      '"C:\\Program Files\\Anthropic\\claude.exe"',
    );
  });

  test("returns the command unchanged when there are no spaces", () => {
    setPlatform("win32");
    expect(quoteWindowsCommand("C:\\nvm4w\\nodejs\\codex")).toBe("C:\\nvm4w\\nodejs\\codex");
  });

  test("escapes ampersands", () => {
    setPlatform("win32");
    expect(quoteWindowsCommand("feature&bugfix")).toBe("feature^&bugfix");
  });

  test("escapes pipes", () => {
    setPlatform("win32");
    expect(quoteWindowsCommand("feature|bugfix")).toBe("feature^|bugfix");
  });

  test("does not double percent signs", () => {
    setPlatform("win32");
    // cmd.exe only collapses %% → % inside batch files; on the command line
    // it stays literal, which corrupts git --format atoms etc.
    expect(quoteWindowsCommand("100%")).toBe("100%");
  });

  test("preserves git --format atoms verbatim", () => {
    setPlatform("win32");
    expect(quoteWindowsCommand("--format=%(refname)%09%(committerdate:unix)")).toBe(
      "--format=%^(refname^)%09%^(committerdate:unix^)",
    );
  });

  test("escapes carets", () => {
    setPlatform("win32");
    expect(quoteWindowsCommand("feature^bugfix")).toBe("feature^^bugfix");
  });

  test("escapes multiple metacharacters", () => {
    setPlatform("win32");
    expect(quoteWindowsCommand("build&(test|deploy)!<output>")).toBe(
      "build^&^(test^|deploy^)^!^<output^>",
    );
  });

  test("quotes commands with spaces after escaping metacharacters", () => {
    setPlatform("win32");
    expect(quoteWindowsCommand("C:\\Program Files\\My Tool&Stuff\\run 100%.cmd")).toBe(
      '"C:\\Program Files\\My Tool^&Stuff\\run 100%.cmd"',
    );
  });

  test("returns the command unchanged on non-Windows platforms", () => {
    setPlatform("darwin");
    expect(quoteWindowsCommand("/usr/local/bin/claude code")).toBe("/usr/local/bin/claude code");
  });
});

describe("quoteWindowsArgument", () => {
  const originalPlatform = process.platform;

  function setPlatform(value: string) {
    Object.defineProperty(process, "platform", { value, writable: true });
  }

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  test("quotes a Windows argument with spaces", () => {
    setPlatform("win32");
    expect(quoteWindowsArgument("C:\\Program Files\\Anthropic\\cli.js")).toBe(
      '"C:\\Program Files\\Anthropic\\cli.js"',
    );
  });

  test("does not double-quote an already-quoted argument", () => {
    setPlatform("win32");
    expect(quoteWindowsArgument('"C:\\Program Files\\Anthropic\\cli.js"')).toBe(
      '"C:\\Program Files\\Anthropic\\cli.js"',
    );
  });

  test("returns the argument unchanged when there are no spaces", () => {
    setPlatform("win32");
    expect(quoteWindowsArgument("--version")).toBe("--version");
  });

  test("returns the argument unchanged on non-Windows platforms", () => {
    setPlatform("darwin");
    expect(quoteWindowsArgument("/usr/local/bin/claude code")).toBe("/usr/local/bin/claude code");
  });
});
