import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  executableExists,
  findExecutable,
  quoteWindowsArgument,
  quoteWindowsCommand,
} from "./executable.js";

const originalEnv = {
  PATH: process.env.PATH,
  PATHEXT: process.env.PATHEXT,
};
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paseo-executable-test-"));
  tempDirs.push(dir);
  return dir;
}

function prependPath(...dirs: string[]): void {
  process.env.PATH = [...dirs, originalEnv.PATH].filter(Boolean).join(path.delimiter);
}

function writeExecutable(filePath: string, content: string): string {
  writeFileSync(filePath, content);
  if (process.platform !== "win32") {
    chmodSync(filePath, 0o755);
  }
  return filePath;
}

function writeInvokableFixture(dir: string, name: string): string {
  if (process.platform === "win32") {
    return writeExecutable(path.join(dir, `${name}.cmd`), "@echo off\r\necho 0.1\r\n");
  }
  return writeExecutable(path.join(dir, name), "#!/bin/sh\necho 0.1\n");
}

function writeBrokenAbsoluteFixture(dir: string): string {
  const filePath =
    process.platform === "win32" ? path.join(dir, "broken.exe") : path.join(dir, "broken");
  writeFileSync(filePath, "not executable");
  if (process.platform !== "win32") {
    chmodSync(filePath, 0o644);
  }
  return filePath;
}

function expectWindowsPathsEqual(actual: string | null, expected: string): void {
  expect(actual?.toLowerCase()).toBe(expected.toLowerCase());
}

afterEach(() => {
  process.env.PATH = originalEnv.PATH;
  process.env.PATHEXT = originalEnv.PATHEXT;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("findExecutable", () => {
  describe.skipIf(process.platform === "win32")("POSIX", () => {
    test("finds an extensionless executable and skips an earlier non-executable candidate", async () => {
      const executableDir = makeTempDir();
      const nonExecutableDir = makeTempDir();
      const executable = writeExecutable(path.join(executableDir, "foo"), "#!/bin/sh\necho 0.1\n");
      const nonExecutable = path.join(nonExecutableDir, "foo");
      writeFileSync(nonExecutable, "#!/bin/sh\necho broken\n");
      chmodSync(nonExecutable, 0o644);
      prependPath(nonExecutableDir, executableDir);

      await expect(findExecutable("foo")).resolves.toBe(executable);
    });
  });

  describe.runIf(process.platform === "win32")("Windows", () => {
    test("returns a working .cmd when an invalid .exe candidate appears first", async () => {
      const dir = makeTempDir();
      process.env.PATHEXT = [".EXE", ".CMD"].join(path.delimiter);
      const brokenExe = path.join(dir, "foo.exe");
      const cmd = writeExecutable(path.join(dir, "foo.cmd"), "@echo off\r\necho 0.1\r\n");
      writeFileSync(brokenExe, "");
      prependPath(dir);

      expectWindowsPathsEqual(await findExecutable("foo"), cmd);
    });

    test("returns null when the only candidate is a broken .exe", async () => {
      const dir = makeTempDir();
      process.env.PATHEXT = ".EXE";
      writeFileSync(path.join(dir, "foo.exe"), "");
      prependPath(dir);

      await expect(findExecutable("foo")).resolves.toBeNull();
    });

    test("returns a .cmd when it is the only candidate", async () => {
      const dir = makeTempDir();
      process.env.PATHEXT = ".CMD";
      const cmd = writeExecutable(path.join(dir, "foo.cmd"), "@echo off\r\necho 0.1\r\n");
      prependPath(dir);

      expectWindowsPathsEqual(await findExecutable("foo"), cmd);
    });
  });

  test("returns an invokable absolute path", async () => {
    const dir = makeTempDir();
    const fixture = writeInvokableFixture(dir, "absolute-ok");

    await expect(findExecutable(fixture)).resolves.toBe(fixture);
  });

  test("returns null for an absolute path that cannot spawn", async () => {
    const dir = makeTempDir();
    const fixture = writeBrokenAbsoluteFixture(dir);

    await expect(findExecutable(fixture)).resolves.toBeNull();
  });

  test("returns null when the command is not on PATH", async () => {
    const dir = makeTempDir();
    prependPath(dir);

    await expect(findExecutable("paseo-definitely-missing-command")).resolves.toBeNull();
  });
});

describe("executableExists", () => {
  test("returns the path when it already exists", () => {
    const exists = (candidate: string) => candidate === "/usr/local/bin/codex";

    expect(executableExists("/usr/local/bin/codex", exists)).toBe("/usr/local/bin/codex");
  });

  test("on Windows, falls back to .exe, .cmd, then .ps1 for extensionless paths", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    try {
      const exists = (candidate: string) => candidate === "C:\\tools\\codex.cmd";

      expect(executableExists("C:\\tools\\codex", exists)).toBe("C:\\tools\\codex.cmd");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    }
  });

  test("returns null when no matching path exists", () => {
    expect(executableExists("/missing/codex", () => false)).toBeNull();
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

  test("escapes ampersands", () => {
    setPlatform("win32");
    expect(quoteWindowsCommand("feature&bugfix")).toBe("feature^&bugfix");
  });

  test("escapes pipes", () => {
    setPlatform("win32");
    expect(quoteWindowsCommand("feature|bugfix")).toBe("feature^|bugfix");
  });

  test("doubles percent signs", () => {
    setPlatform("win32");
    expect(quoteWindowsCommand("100%")).toBe("100%%");
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
      '"C:\\Program Files\\My Tool^&Stuff\\run 100%%.cmd"',
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
