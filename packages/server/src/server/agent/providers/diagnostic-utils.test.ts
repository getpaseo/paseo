import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  buildCommandResolutionDiagnosticRows,
  toDiagnosticErrorMessage,
} from "./diagnostic-utils.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-diagnostic-path-"));
  tempDirs.push(dir);
  return dir;
}

function writeExecutable(dir: string, name: string): string {
  const filePath = path.join(dir, name);
  writeFileSync(filePath, "#!/bin/sh\nexit 0\n");
  if (process.platform !== "win32") {
    chmodSync(filePath, 0o755);
  }
  return filePath;
}

describe("buildCommandResolutionDiagnosticRows", () => {
  test("reports daemon PATH matches for known binary names", async () => {
    const binDir = makeTempDir();
    const binaryPath = writeExecutable(binDir, "claude");

    const rows = await buildCommandResolutionDiagnosticRows(
      { command: "claude", args: [], source: "default" },
      {
        knownBinaryNames: ["claude"],
        pathValue: binDir,
      },
    );

    expect(rows).toContainEqual({ label: "Command source", value: "default" });
    expect(rows).toContainEqual({ label: "Configured command", value: "claude" });
    expect(rows).toContainEqual({
      label: "Daemon PATH",
      value: expect.stringContaining(binDir),
    });
    expect(rows).toContainEqual({
      label: "PATH matches",
      value: expect.stringContaining(binaryPath),
    });
    if (process.platform === "win32") {
      expect(rows.some((row) => row.label === "where.exe claude")).toBe(true);
      expect(rows.some((row) => row.label === "powershell Get-Command -All claude")).toBe(true);
    } else {
      expect(rows.some((row) => row.label === "which -a claude")).toBe(true);
      expect(rows.some((row) => row.label.endsWith(" -lc type -a claude"))).toBe(true);
    }
  });

  test("reports none when the daemon PATH has no matching executable", async () => {
    const binDir = makeTempDir();

    const rows = await buildCommandResolutionDiagnosticRows(
      { command: "claude", args: [], source: "default" },
      { knownBinaryNames: ["claude"], includeCommandProbes: false, pathValue: binDir },
    );

    expect(rows).toContainEqual({ label: "PATH matches", value: "none" });
  });

  test("truncates very long daemon PATH values", async () => {
    const rows = await buildCommandResolutionDiagnosticRows(
      { command: "claude", args: [], source: "default" },
      {
        knownBinaryNames: ["claude"],
        includeCommandProbes: false,
        pathValue: "x".repeat(5000),
      },
    );

    expect(rows).toContainEqual({
      label: "Daemon PATH",
      value: expect.stringContaining("(truncated)"),
    });
  });

  test("matches Windows PATHEXT executable names", async () => {
    const binDir = makeTempDir();
    const binaryPath = writeExecutable(binDir, "claude.EXE");

    const rows = await buildCommandResolutionDiagnosticRows(
      { command: "claude", args: [], source: "default" },
      {
        knownBinaryNames: ["claude"],
        includeCommandProbes: false,
        pathext: ".EXE;.CMD",
        pathValue: binDir,
        platform: "win32",
      },
    );

    expect(rows).toContainEqual({
      label: "PATH matches",
      value: expect.stringContaining(binaryPath),
    });
  });

  test("does not treat absolute configured commands as PATH binary names", async () => {
    const rows = await buildCommandResolutionDiagnosticRows(
      { command: "/Users/mn/.local/bin/claude", args: [], source: "override" },
      {
        knownBinaryNames: ["/Users/mn/.local/bin/claude"],
        includeCommandProbes: false,
      },
    );

    expect(rows).toContainEqual({ label: "PATH matches", value: "not checked" });
  });
});

describe("toDiagnosticErrorMessage", () => {
  test("returns message for plain Error", () => {
    expect(toDiagnosticErrorMessage(new Error("boom"))).toBe("boom");
  });

  test("includes stderr, stdout, code, and signal from execFile-style Error", () => {
    const error = new Error("Command failed: opencode --version") as Error & {
      stderr: string;
      stdout: string;
      code: number;
      signal: string;
    };
    error.stderr = "permission denied\n";
    error.stdout = "partial output";
    error.code = 127;
    error.signal = "SIGTERM";

    const message = toDiagnosticErrorMessage(error);
    expect(message).toContain("Command failed: opencode --version");
    expect(message).toContain("exit code: 127");
    expect(message).toContain("signal: SIGTERM");
    expect(message).toContain("stderr: permission denied");
    expect(message).toContain("stdout: partial output");
  });

  test("preserves multi-line stderr on a real Error", () => {
    const error = new Error("Command failed") as Error & { stderr: string };
    error.stderr = "line one\nline two\nline three";
    const message = toDiagnosticErrorMessage(error);
    expect(message).toContain("stderr: line one\nline two\nline three");
  });

  test("recursively formats Error cause", () => {
    const inner = new Error("inner failure") as Error & { stderr: string };
    inner.stderr = "inner stderr";
    const outer = new Error("outer failure", { cause: inner });
    const message = toDiagnosticErrorMessage(outer);
    expect(message).toContain("outer failure");
    expect(message).toContain("caused by: inner failure");
    expect(message).toContain("stderr: inner stderr");
  });

  test("serializes plain objects rather than returning {}", () => {
    expect(toDiagnosticErrorMessage({ foo: "bar" })).toBe('{"foo":"bar"}');
  });

  test("returns trimmed string when given a string", () => {
    expect(toDiagnosticErrorMessage("oops")).toBe("oops");
    expect(toDiagnosticErrorMessage("  spaced  ")).toBe("spaced");
  });

  test("returns Unknown error for null and undefined", () => {
    expect(toDiagnosticErrorMessage(null)).toBe("Unknown error");
    expect(toDiagnosticErrorMessage(undefined)).toBe("Unknown error");
  });

  test("returns Unknown error for an Error with no message and no extras", () => {
    const error = new Error("");
    expect(toDiagnosticErrorMessage(error)).toBe("Unknown error");
  });

  test("truncates very long stderr", () => {
    const long = "x".repeat(5000);
    const error = new Error("big") as Error & { stderr: string };
    error.stderr = long;
    const message = toDiagnosticErrorMessage(error);
    expect(message).toContain("…(truncated)");
    expect(message.length).toBeLessThan(long.length + 200);
  });

  test("returns Unknown error for empty plain object after serialization fallback", () => {
    expect(toDiagnosticErrorMessage({})).toBe("Unknown error");
  });
});
