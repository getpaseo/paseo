import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  findExecutable,
  quoteWindowsArgument,
  quoteWindowsCommand,
  resolveProviderCommandPrefix,
  applyProviderEnv,
  type ProviderRuntimeSettings,
} from "./provider-launch-config.js";

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

describe("resolveProviderCommandPrefix", () => {
  test("uses resolved default command in default mode", () => {
    const resolveDefault = vi.fn(() => "/usr/local/bin/claude");

    const resolved = resolveProviderCommandPrefix(undefined, resolveDefault);

    expect(resolveDefault).toHaveBeenCalledTimes(1);
    expect(resolved).toEqual({ command: "/usr/local/bin/claude", args: [] });
  });

  test("appends args in append mode", () => {
    const resolveDefault = vi.fn(() => "/usr/local/bin/claude");

    const resolved = resolveProviderCommandPrefix(
      {
        mode: "append",
        args: ["--chrome"],
      },
      resolveDefault,
    );

    expect(resolveDefault).toHaveBeenCalledTimes(1);
    expect(resolved).toEqual({
      command: "/usr/local/bin/claude",
      args: ["--chrome"],
    });
  });

  test("replaces command in replace mode without resolving default", () => {
    const resolveDefault = vi.fn(() => "/usr/local/bin/claude");

    const resolved = resolveProviderCommandPrefix(
      {
        mode: "replace",
        argv: ["docker", "run", "--rm", "my-wrapper"],
      },
      resolveDefault,
    );

    expect(resolveDefault).not.toHaveBeenCalled();
    expect(resolved).toEqual({
      command: "docker",
      args: ["run", "--rm", "my-wrapper"],
    });
  });
});

describe("applyProviderEnv", () => {
  test("merges provider env overrides", () => {
    const base = {
      PATH: "/usr/bin",
      HOME: "/tmp",
    };
    const runtime: ProviderRuntimeSettings = {
      env: {
        HOME: "/custom/home",
        FOO: "bar",
      },
    };

    const env = applyProviderEnv(base, runtime, {});

    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/custom/home");
    expect(env.FOO).toBe("bar");
    expect(Object.keys(env).length).toBeGreaterThanOrEqual(3);
  });

  test("shell env PATH wins over base env PATH", () => {
    const base = { PATH: "/usr/bin:/bin" };
    const shellEnv = { PATH: "/usr/local/bin:/usr/bin:/bin:/home/user/.nvm/bin" };

    const env = applyProviderEnv(base, undefined, shellEnv);

    expect(env.PATH).toBe("/usr/local/bin:/usr/bin:/bin:/home/user/.nvm/bin");
  });

  test("runtimeSettings env wins over shell env", () => {
    const base = { PATH: "/usr/bin" };
    const shellEnv = { PATH: "/usr/local/bin:/usr/bin" };
    const runtime: ProviderRuntimeSettings = { env: { PATH: "/custom/path" } };

    const env = applyProviderEnv(base, runtime, shellEnv);

    expect(env.PATH).toBe("/custom/path");
  });

  test("strips parent Claude Code session env vars", () => {
    const base = {
      PATH: "/usr/bin",
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
      CLAUDE_CODE_SSE_PORT: "11803",
      CLAUDE_AGENT_SDK_VERSION: "0.2.71",
      CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: "true",
    };

    const env = applyProviderEnv(base, undefined, {});

    expect(env.PATH).toBe("/usr/bin");
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.CLAUDE_CODE_SSE_PORT).toBeUndefined();
    expect(env.CLAUDE_AGENT_SDK_VERSION).toBeUndefined();
    expect(env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING).toBeUndefined();
  });
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
