import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  findExecutable,
  quoteWindowsArgument,
  quoteWindowsCommand,
} from "./executable.js";

type FindExecutableDependencies = NonNullable<Parameters<typeof findExecutable>[1]>;

function createFindExecutableDependencies(): FindExecutableDependencies {
  return {
    execFileSync: vi.fn(),
    execSync: vi.fn(),
    existsSync: vi.fn(),
    platform: vi.fn(() => "darwin"),
    shell: undefined,
  };
}

let findExecutableDependencies: FindExecutableDependencies;

beforeEach(() => {
  findExecutableDependencies = createFindExecutableDependencies();
});

describe("findExecutable", () => {
  test("on Windows, resolves executables using current machine and user PATH entries", () => {
    findExecutableDependencies.platform = vi.fn(() => "win32");
    process.env.Path = "C:\\Windows\\System32";
    findExecutableDependencies.execFileSync.mockImplementation(
      ((command: string, args?: string[]) => {
        if (command === "powershell") {
          return "C:\\Windows\\System32\r\nC:\\Users\\boudr\\.local\\bin\r\n";
        }
        if (command === "where.exe") {
          return "C:\\Users\\boudr\\.local\\bin\\claude.exe\r\n";
        }
        throw new Error(`unexpected command ${command}`);
      }) as any,
    );

    expect(findExecutable("claude", findExecutableDependencies)).toBe(
      "C:\\Users\\boudr\\.local\\bin\\claude.exe",
    );
    const powershellCall = findExecutableDependencies.execFileSync.mock.calls[0];
    expect(powershellCall?.[0]).toBe("powershell");
    expect(powershellCall?.[1]).toContain("-NoProfile");
    expect(powershellCall?.[1]).toContain("-NonInteractive");
    expect(powershellCall?.[1]).toContain(
      '$machine = [Environment]::GetEnvironmentVariable("Path", "Machine"); $user = [Environment]::GetEnvironmentVariable("Path", "User"); if ($machine) { Write-Output $machine }; if ($user) { Write-Output $user }',
    );
    const whereCall = findExecutableDependencies.execFileSync.mock.calls[1];
    expect(whereCall?.[0]).toBe("where.exe");
    expect(whereCall?.[1]).toEqual(["claude"]);
    expect(whereCall?.[2]?.encoding).toBe("utf8");
    const env = whereCall?.[2]?.env as Record<string, string | undefined>;
    expect(env.PATH).toContain("C:\\Users\\boudr\\.local\\bin");
    expect(env.Path).toContain("C:\\Users\\boudr\\.local\\bin");
  });

  test("on Windows, preserves the first where.exe match", () => {
    findExecutableDependencies.platform = vi.fn(() => "win32");
    process.env.Path = "C:\\Windows\\System32";
    findExecutableDependencies.execFileSync.mockImplementation(
      ((command: string) => {
        if (command === "powershell") {
          return "C:\\Windows\\System32\r\nC:\\nvm4w\\nodejs\r\n";
        }
        if (command === "where.exe") {
          return "C:\\nvm4w\\nodejs\\codex\r\nC:\\nvm4w\\nodejs\\codex.cmd\r\n";
        }
        throw new Error(`unexpected command ${command}`);
      }) as any,
    );

    expect(findExecutable("codex", findExecutableDependencies)).toBe("C:\\nvm4w\\nodejs\\codex");
  });

  test("uses the last line from login-shell which output", () => {
    findExecutableDependencies.shell = "/bin/zsh";
    findExecutableDependencies.execSync.mockReturnValue(
      "echo from profile\n/usr/local/bin/codex\n",
    );

    expect(findExecutable("codex", findExecutableDependencies)).toBe("/usr/local/bin/codex");
    expect(findExecutableDependencies.execSync).toHaveBeenCalledOnce();
    expect(findExecutableDependencies.execFileSync).not.toHaveBeenCalled();
  });

  test("warns and returns null when the final which line is not an absolute path", () => {
    findExecutableDependencies.shell = "/bin/zsh";
    findExecutableDependencies.execSync.mockReturnValue("profile noise\ncodex\n");
    findExecutableDependencies.execFileSync.mockReturnValue("codex\n");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(findExecutable("codex", findExecutableDependencies)).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(2);

    warnSpy.mockRestore();
  });

  test("returns direct paths when they exist", () => {
    findExecutableDependencies.existsSync.mockReturnValue(true);

    expect(findExecutable("/usr/local/bin/codex", findExecutableDependencies)).toBe(
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
