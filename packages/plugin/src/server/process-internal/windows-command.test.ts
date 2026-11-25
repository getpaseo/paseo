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
  test("quotes the argument and escapes the quotes so cmd.exe sees no quoted region", () => {
    expect(quoteWindowsArgument("C:\\Program Files\\cli.js", { platform: "win32" })).toBe(
      '^"C:\\Program Files\\cli.js^"',
    );
  });

  test("escapes cmd.exe syntax, including a git --format atom", () => {
    expect(quoteWindowsArgument("a & b|(c)!<d>^", { platform: "win32" })).toBe(
      '^"a ^& b^|^(c^)^!^<d^>^^^"',
    );
    expect(
      quoteWindowsArgument("--format=%(refname)%09%(committerdate:unix)", { platform: "win32" }),
    ).toBe('^"--format=^%^(refname^)^%09^%^(committerdate:unix^)^"');
  });

  test("escapes literal quotes and the backslashes before them for the program", () => {
    expect(quoteWindowsArgument('say "hi"', { platform: "win32" })).toBe('^"say \\^"hi\\^"^"');
    expect(quoteWindowsArgument("C:\\dir\\", { platform: "win32" })).toBe('^"C:\\dir\\\\^"');
  });

  test("keeps an empty argument", () => {
    expect(quoteWindowsArgument("", { platform: "win32" })).toBe('^"^"');
  });

  test("escapes twice for a .cmd or .bat script, which reads its arguments again", () => {
    expect(quoteWindowsArgument("a & b", { platform: "win32", commandScript: true })).toBe(
      '^^^"a ^^^& b^^^"',
    );
  });

  test("returns the argument unchanged on non-Windows platforms", () => {
    expect(quoteWindowsArgument("/usr/local/bin/claude code", { platform: "darwin" })).toBe(
      "/usr/local/bin/claude code",
    );
  });
});
