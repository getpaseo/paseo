import { promisify } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

async function loadExecutableModule(params?: {
  execFileImpl?: (
    command: string,
    args: string[],
    options: unknown,
    callback: ExecFileCallback,
  ) => void;
}) {
  vi.resetModules();

  const execFileMock = vi.fn(
    params?.execFileImpl ??
      ((_command: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
        callback(new Error("execFile not mocked"), "", "");
      }),
  );
  Object.assign(execFileMock, {
    [promisify.custom]: (command: string, args: string[], options: unknown) =>
      new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        execFileMock(
          command,
          args,
          options,
          (error: Error | null, stdout: string, stderr: string) => {
            if (error) {
              reject(error);
              return;
            }
            resolve({ stdout, stderr });
          },
        );
      }),
  });

  vi.doMock("node:child_process", () => ({
    execFile: execFileMock,
  }));
  const module = await import("./executable.js");
  return {
    ...module,
    execFileMock,
  };
}

describe("findExecutable", () => {
  const originalPlatform = process.platform;
  const missingBinaryName = "nonexistent-binary-xyz-12345";

  function setPlatform(value: string) {
    Object.defineProperty(process, "platform", { value, writable: true });
  }

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  test("on Windows, resolves executables using where.exe with inherited PATH", async () => {
    setPlatform("win32");
    const { execFileMock, findExecutable } = await loadExecutableModule({
      execFileImpl: (_command, _args, _options, callback) => {
        callback(null, "C:\\Users\\boudr\\.local\\bin\\claude.exe\r\n", "");
      },
    });

    await expect(findExecutable("claude")).resolves.toBe(
      "C:\\Users\\boudr\\.local\\bin\\claude.exe",
    );
    expect(execFileMock).toHaveBeenCalledOnce();
    const call = execFileMock.mock.calls[0];
    expect(call?.[0]).toBe("where.exe");
    expect(call?.[1]).toEqual(["claude"]);
    expect(call?.[2]).toMatchObject({
      encoding: "utf8",
      windowsHide: true,
    });
  });

  test("on Windows, prefers an executable match from where.exe output", async () => {
    setPlatform("win32");
    const { findExecutable } = await loadExecutableModule({
      execFileImpl: (_command, _args, _options, callback) => {
        callback(null, "C:\\nvm4w\\nodejs\\codex\r\nC:\\nvm4w\\nodejs\\codex.cmd\r\n", "");
      },
    });

    await expect(findExecutable("codex")).resolves.toBe("C:\\nvm4w\\nodejs\\codex.cmd");
  });

  test("on Windows, prefers .exe over .cmd, .ps1, and extensionless candidates", async () => {
    setPlatform("win32");
    const { findExecutable } = await loadExecutableModule({
      execFileImpl: (_command, _args, _options, callback) => {
        callback(
          null,
          [
            "C:\\nvm4w\\nodejs\\codex",
            "C:\\nvm4w\\nodejs\\codex.ps1",
            "C:\\nvm4w\\nodejs\\codex.cmd",
            "C:\\nvm4w\\nodejs\\codex.exe",
          ].join("\r\n"),
          "",
        );
      },
    });

    await expect(findExecutable("codex")).resolves.toBe("C:\\nvm4w\\nodejs\\codex.exe");
  });

  test("on Windows, returns null when where.exe output is empty", async () => {
    setPlatform("win32");
    const { findExecutable } = await loadExecutableModule({
      execFileImpl: (_command, _args, _options, callback) => {
        callback(null, "\r\n", "");
      },
    });

    await expect(findExecutable(missingBinaryName)).resolves.toBeNull();
  });

  test("on Windows, falls back to the first extensionless candidate when needed", async () => {
    setPlatform("win32");
    const { findExecutable } = await loadExecutableModule({
      execFileImpl: (_command, _args, _options, callback) => {
        callback(null, "C:\\nvm4w\\nodejs\\codex\r\n", "");
      },
    });

    await expect(findExecutable("codex")).resolves.toBe("C:\\nvm4w\\nodejs\\codex");
  });

  test("on Unix, uses the last line from which output", async () => {
    const { execFileMock, findExecutable } = await loadExecutableModule({
      execFileImpl: (_command, _args, _options, callback) => {
        callback(null, "/usr/local/bin/codex\n", "");
      },
    });

    await expect(findExecutable("codex")).resolves.toBe("/usr/local/bin/codex");
    expect(execFileMock).toHaveBeenCalledWith(
      process.platform === "win32" ? "where.exe" : "which",
      ["codex"],
      process.platform === "win32" ? { encoding: "utf8", windowsHide: true } : { encoding: "utf8" },
      expect.any(Function),
    );
  });

  test.skipIf(process.platform === "win32")(
    "warns and returns null when the final which line is not an absolute path",
    async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { findExecutable } = await loadExecutableModule({
        execFileImpl: (_command, _args, _options, callback) => {
          callback(null, "codex\n", "");
        },
      });

      await expect(findExecutable("codex")).resolves.toBeNull();
      expect(warnSpy).toHaveBeenCalledOnce();

      warnSpy.mockRestore();
    },
  );

  test("returns null when which lookup fails", async () => {
    const { findExecutable } = await loadExecutableModule({
      execFileImpl: (_command, _args, _options, callback) => {
        callback(new Error("which failed"), "", "");
      },
    });

    await expect(findExecutable(missingBinaryName)).resolves.toBeNull();
  });
});

describe("executableExists", () => {
  const originalPlatform = process.platform;

  function setPlatform(value: string) {
    Object.defineProperty(process, "platform", { value, writable: true });
  }

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  test("returns the path when it already exists", async () => {
    const { executableExists } = await loadExecutableModule();
    const exists = vi.fn((candidate: string) => candidate === "/usr/local/bin/codex");

    expect(executableExists("/usr/local/bin/codex", exists)).toBe("/usr/local/bin/codex");
  });

  test("on Windows, falls back to .exe, .cmd, then .ps1 for extensionless paths", async () => {
    setPlatform("win32");
    const { executableExists } = await loadExecutableModule();
    const exists = vi.fn((candidate: string) => candidate === "C:\\tools\\codex.cmd");

    expect(executableExists("C:\\tools\\codex", exists)).toBe("C:\\tools\\codex.cmd");
  });

  test("returns null when no matching path exists", async () => {
    const { executableExists } = await loadExecutableModule();
    const exists = vi.fn(() => false);

    expect(executableExists("/missing/codex", exists)).toBeNull();
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

  test("quotes a Windows path with spaces", async () => {
    setPlatform("win32");
    const { quoteWindowsCommand } = await loadExecutableModule();
    expect(quoteWindowsCommand("C:\\Program Files\\Anthropic\\claude.exe")).toBe(
      '"C:\\Program Files\\Anthropic\\claude.exe"',
    );
  });

  test("does not double-quote an already-quoted path", async () => {
    setPlatform("win32");
    const { quoteWindowsCommand } = await loadExecutableModule();
    expect(quoteWindowsCommand('"C:\\Program Files\\Anthropic\\claude.exe"')).toBe(
      '"C:\\Program Files\\Anthropic\\claude.exe"',
    );
  });

  test("returns the command unchanged when there are no spaces", async () => {
    setPlatform("win32");
    const { quoteWindowsCommand } = await loadExecutableModule();
    expect(quoteWindowsCommand("C:\\nvm4w\\nodejs\\codex")).toBe("C:\\nvm4w\\nodejs\\codex");
  });

  test("escapes ampersands", async () => {
    setPlatform("win32");
    const { quoteWindowsCommand } = await loadExecutableModule();
    expect(quoteWindowsCommand("feature&bugfix")).toBe("feature^&bugfix");
  });

  test("escapes pipes", async () => {
    setPlatform("win32");
    const { quoteWindowsCommand } = await loadExecutableModule();
    expect(quoteWindowsCommand("feature|bugfix")).toBe("feature^|bugfix");
  });

  test("doubles percent signs", async () => {
    setPlatform("win32");
    const { quoteWindowsCommand } = await loadExecutableModule();
    expect(quoteWindowsCommand("100%")).toBe("100%%");
  });

  test("escapes carets", async () => {
    setPlatform("win32");
    const { quoteWindowsCommand } = await loadExecutableModule();
    expect(quoteWindowsCommand("feature^bugfix")).toBe("feature^^bugfix");
  });

  test("escapes multiple metacharacters", async () => {
    setPlatform("win32");
    const { quoteWindowsCommand } = await loadExecutableModule();
    expect(quoteWindowsCommand("build&(test|deploy)!<output>")).toBe(
      "build^&^(test^|deploy^)^!^<output^>",
    );
  });

  test("quotes commands with spaces after escaping metacharacters", async () => {
    setPlatform("win32");
    const { quoteWindowsCommand } = await loadExecutableModule();
    expect(quoteWindowsCommand("C:\\Program Files\\My Tool&Stuff\\run 100%.cmd")).toBe(
      '"C:\\Program Files\\My Tool^&Stuff\\run 100%%.cmd"',
    );
  });

  test("returns the command unchanged on non-Windows platforms", async () => {
    setPlatform("darwin");
    const { quoteWindowsCommand } = await loadExecutableModule();
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

  test("quotes a Windows argument with spaces", async () => {
    setPlatform("win32");
    const { quoteWindowsArgument } = await loadExecutableModule();
    expect(quoteWindowsArgument("C:\\Program Files\\Anthropic\\cli.js")).toBe(
      '"C:\\Program Files\\Anthropic\\cli.js"',
    );
  });

  test("does not double-quote an already-quoted argument", async () => {
    setPlatform("win32");
    const { quoteWindowsArgument } = await loadExecutableModule();
    expect(quoteWindowsArgument('"C:\\Program Files\\Anthropic\\cli.js"')).toBe(
      '"C:\\Program Files\\Anthropic\\cli.js"',
    );
  });

  test("returns the argument unchanged when there are no spaces", async () => {
    setPlatform("win32");
    const { quoteWindowsArgument } = await loadExecutableModule();
    expect(quoteWindowsArgument("--version")).toBe("--version");
  });

  test("returns the argument unchanged on non-Windows platforms", async () => {
    setPlatform("darwin");
    const { quoteWindowsArgument } = await loadExecutableModule();
    expect(quoteWindowsArgument("/usr/local/bin/claude code")).toBe("/usr/local/bin/claude code");
  });
});
