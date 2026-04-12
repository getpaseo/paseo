import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { findExecutableSync, quoteWindowsArgument, quoteWindowsCommand } from "./executable.js";

type FindExecutableDependencies = NonNullable<Parameters<typeof findExecutableSync>[1]>;

function createFindExecutableDependencies(): FindExecutableDependencies {
  return {
    execFileSync: vi.fn(),
    existsSync: vi.fn(),
    platform: vi.fn(() => "darwin"),
  };
}

let findExecutableDependencies: FindExecutableDependencies;

beforeEach(() => {
  findExecutableDependencies = createFindExecutableDependencies();
});

describe("findExecutableSync", () => {
  test("on Windows, resolves executables using where.exe with inherited PATH", () => {
    findExecutableDependencies.platform = vi.fn(() => "win32");
    findExecutableDependencies.execFileSync.mockReturnValue(
      "C:\\Users\\boudr\\.local\\bin\\claude.exe\r\n",
    );

    expect(findExecutableSync("claude", findExecutableDependencies)).toBe(
      "C:\\Users\\boudr\\.local\\bin\\claude.exe",
    );
    expect(findExecutableDependencies.execFileSync).toHaveBeenCalledOnce();
    const call = findExecutableDependencies.execFileSync.mock.calls[0];
    expect(call?.[0]).toBe("where.exe");
    expect(call?.[1]).toEqual(["claude"]);
    expect(call?.[2]?.encoding).toBe("utf8");
    expect(call?.[2]?.windowsHide).toBe(true);
  });

  test("on Windows, preserves the first where.exe match", () => {
    findExecutableDependencies.platform = vi.fn(() => "win32");
    findExecutableDependencies.execFileSync.mockReturnValue(
      "C:\\nvm4w\\nodejs\\codex\r\nC:\\nvm4w\\nodejs\\codex.cmd\r\n",
    );

    expect(findExecutableSync("codex", findExecutableDependencies)).toBe(
      "C:\\nvm4w\\nodejs\\codex",
    );
  });

  test("on Unix, uses the last line from which output", () => {
    findExecutableDependencies.execFileSync.mockReturnValue("/usr/local/bin/codex\n");

    expect(findExecutableSync("codex", findExecutableDependencies)).toBe("/usr/local/bin/codex");
    expect(findExecutableDependencies.execFileSync).toHaveBeenCalledWith("which", ["codex"], {
      encoding: "utf8",
    });
  });

  test("warns and returns null when the final which line is not an absolute path", () => {
    findExecutableDependencies.execFileSync.mockReturnValue("codex\n");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(findExecutableSync("codex", findExecutableDependencies)).toBeNull();
    expect(warnSpy).toHaveBeenCalledOnce();

    warnSpy.mockRestore();
  });

  test("returns direct paths when they exist", () => {
    findExecutableDependencies.existsSync.mockReturnValue(true);

    expect(findExecutableSync("/usr/local/bin/codex", findExecutableDependencies)).toBe(
      "/usr/local/bin/codex",
    );
    expect(findExecutableDependencies.existsSync).toHaveBeenCalledWith("/usr/local/bin/codex");
  });
});

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
