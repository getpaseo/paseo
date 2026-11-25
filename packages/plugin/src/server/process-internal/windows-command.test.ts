import { describe, expect, test } from "vitest";
import { quoteWindowsArgument, quoteWindowsCommand } from "./windows-command.js";

describe("quoteWindowsCommand", () => {
  test("quotes a Windows path with spaces", () => {
    expect(quoteWindowsCommand("C:\\Program Files\\Anthropic\\claude.exe", "win32")).toBe(
      '"C:\\Program Files\\Anthropic\\claude.exe"',
    );
  });

  test("keeps cmd.exe syntax in a path as text inside the quotes", () => {
    expect(quoteWindowsCommand("C:\\Program Files (x86)\\Tool & Co\\run.cmd", "win32")).toBe(
      '"C:\\Program Files (x86)\\Tool & Co\\run.cmd"',
    );
  });

  test("does not double-quote an already-quoted path", () => {
    expect(quoteWindowsCommand('"C:\\Program Files\\Anthropic\\claude.exe"', "win32")).toBe(
      '"C:\\Program Files\\Anthropic\\claude.exe"',
    );
  });

  test("returns a plain command unchanged", () => {
    expect(quoteWindowsCommand("C:\\nvm4w\\nodejs\\codex", "win32")).toBe(
      "C:\\nvm4w\\nodejs\\codex",
    );
  });

  test("returns the command unchanged on non-Windows platforms", () => {
    expect(quoteWindowsCommand("/usr/local/bin/claude code", "darwin")).toBe(
      "/usr/local/bin/claude code",
    );
  });
});

describe("quoteWindowsArgument", () => {
  const windows = { platform: "win32" } as const;
  const script = { platform: "win32", commandScript: true } as const;

  test("leaves a plain argument as given, for cmd.exe builtins and scripts that read %1", () => {
    expect(quoteWindowsArgument("hello", windows)).toBe("hello");
    expect(quoteWindowsArgument("feature/allocator-context", script)).toBe(
      "feature/allocator-context",
    );
  });

  test("escapes cmd.exe syntax in an argument without spaces", () => {
    expect(quoteWindowsArgument("feature&bugfix", windows)).toBe("feature^&bugfix");
    expect(quoteWindowsArgument("%PATH%", script)).toBe("^%PATH^%");
    expect(quoteWindowsArgument("--format=%(refname)%09", windows)).toBe(
      "--format=^%^(refname^)^%09",
    );
  });

  test("quotes whitespace and empty arguments, and keeps cmd.exe syntax inside the quotes", () => {
    expect(quoteWindowsArgument("work profile", windows)).toBe('"work profile"');
    expect(quoteWindowsArgument("a & b", script)).toBe('"a & b"');
    expect(quoteWindowsArgument("C:\\path with space\\", windows)).toBe(
      '"C:\\path with space\\\\"',
    );
    expect(quoteWindowsArgument("", script)).toBe('""');
  });

  test("quotes cmd.exe syntax for a script, which reads it again when it forwards %*", () => {
    expect(quoteWindowsArgument("feature&bugfix", script)).toBe('"feature&bugfix"');
    expect(quoteWindowsArgument("feature^bugfix", script)).toBe('"feature^bugfix"');
  });

  test("quotes =, comma and semicolon for a script, which splits its arguments at them", () => {
    for (const argument of ["--profile=restricted", "a,b", "a;b"]) {
      expect(quoteWindowsArgument(argument, script)).toBe(`"${argument}"`);
      expect(quoteWindowsArgument(argument, windows)).toBe(argument);
    }
  });

  test("escapes syntax that literal quotes leave outside a quoted region", () => {
    expect(quoteWindowsArgument('say "hi"', windows)).toBe('"say \\"hi\\""');
    expect(quoteWindowsArgument('mixed "a & b" quote', windows)).toBe('"mixed \\"a ^& b\\" quote"');
    expect(quoteWindowsArgument('mixed "a & b" quote', script)).toBe(
      '"mixed \\"a ^^^& b\\" quote"',
    );
    // One literal quote would leave cmd.exe inside a region, so the closing quote is escaped.
    expect(quoteWindowsArgument('a"b', windows)).toBe('"a\\"b^"');
    expect(quoteWindowsArgument('a"b', script)).toBe('"a\\"b^^^"');
  });

  test("returns the argument unchanged on non-Windows platforms", () => {
    expect(quoteWindowsArgument("/usr/local/bin/claude code", { platform: "darwin" })).toBe(
      "/usr/local/bin/claude code",
    );
  });
});
