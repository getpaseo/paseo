import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { findWindowsCommand, quoteWindowsCommand, windowsCommandLine } from "./windows-command.js";

const program = { commandScript: false } as const;
const script = { commandScript: true } as const;

describe("quoteWindowsCommand", () => {
  test("quotes a path with spaces and keeps cmd.exe syntax in it as text", () => {
    expect(quoteWindowsCommand("C:\\Program Files\\Anthropic\\claude.exe")).toBe(
      '"C:\\Program Files\\Anthropic\\claude.exe"',
    );
    expect(quoteWindowsCommand("C:\\Program Files (x86)\\Tool & Co\\run.cmd")).toBe(
      '"C:\\Program Files (x86)\\Tool & Co\\run.cmd"',
    );
  });

  test("leaves a plain or already quoted path as given", () => {
    expect(quoteWindowsCommand("C:\\nvm4w\\nodejs\\codex")).toBe("C:\\nvm4w\\nodejs\\codex");
    expect(quoteWindowsCommand('"C:\\Program Files\\x.exe"')).toBe('"C:\\Program Files\\x.exe"');
  });
});

describe("windowsCommandLine", () => {
  test("passes an argument without a cmd.exe metacharacter as given", () => {
    expect(windowsCommandLine("echo", ["hello", "--flag", "feature/x", "C:\\dir"], program)).toBe(
      '"echo hello --flag feature/x C:\\dir"',
    );
  });

  test("quotes and caret-escapes every other argument once, the qntm way", () => {
    expect(windowsCommandLine("node", ["feature&bugfix", "work profile", ""], program)).toBe(
      '"node ^"feature^&bugfix^" ^"work^ profile^" ^"^""',
    );
    // A caret before each `%` keeps cmd.exe from reading a variable name, inside the quotes too.
    expect(windowsCommandLine("node", ["%PATH%", "100% of %PATH%"], program)).toBe(
      '"node ^"^%PATH^%^" ^"100^%^ of^ ^%PATH^%^""',
    );
    // Backslashes before the closing quote double, as the program's argv parser expects.
    expect(windowsCommandLine("node", ["C:\\path with space\\"], program)).toBe(
      '"node ^"C:\\path^ with^ space\\\\^""',
    );
  });

  test("quotes =, comma and semicolon, where a batch script splits its arguments", () => {
    expect(windowsCommandLine("run.cmd", ["--profile=restricted", "a,b;c"], script)).toBe(
      '"run.cmd ^"--profile=restricted^" ^"a^,b^;c^""',
    );
  });

  test("escapes an argument with a quote twice for a batch script, which reads it again", () => {
    expect(windowsCommandLine("node", ['say "hi"'], program)).toBe('"node ^"say^ \\^"hi\\^"^""');
    expect(windowsCommandLine("run.cmd", ['say "hi"', "a & b"], script)).toBe(
      '"run.cmd ^^^"say^^^ \\^^^"hi\\^^^"^^^" ^"a^ ^&^ b^""',
    );
  });

  test("quotes the command path at the start of the line", () => {
    expect(windowsCommandLine("C:\\Program Files (x86)\\run.cmd", ["acp"], script)).toBe(
      '""C:\\Program Files (x86)\\run.cmd" acp"',
    );
  });

  test("refuses a line break, which ends a cmd.exe command whatever the quoting", () => {
    for (const argument of ["line one\nline two", "line one\r\n& calc"]) {
      expect(() => windowsCommandLine("run.cmd", ["--", argument], script)).toThrow(
        "cmd.exe cannot pass an argument with a line break to run.cmd",
      );
    }
  });
});

describe("findWindowsCommand", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("finds a bare name on PATH with each PATHEXT extension, whatever the env key case", async () => {
    const empty = await mkdtemp(path.join(os.tmpdir(), "windows-command-empty-"));
    const tools = await mkdtemp(path.join(os.tmpdir(), "windows-command-tools-"));
    roots.push(empty, tools);
    await writeFile(path.join(tools, "agent.CMD"), "");
    const env = { Path: `${empty};${tools}`, PathExt: ".EXE;.CMD" };
    expect(findWindowsCommand("agent", env)).toBe(path.join(tools, "agent.CMD"));
    expect(findWindowsCommand("echo", env)).toBeUndefined();
    expect(findWindowsCommand("agent.cmd", env)).toBeUndefined();
    expect(findWindowsCommand(path.join(tools, "agent"), env)).toBeUndefined();
  });
});
