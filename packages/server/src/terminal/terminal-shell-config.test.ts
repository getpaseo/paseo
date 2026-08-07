import { describe, expect, it } from "vitest";
import { resolveConfiguredTerminalShell } from "./terminal-shell.js";

// The stored setting is interpreted in exactly one place so the RPC, the host
// settings UI and the spawn path cannot drift. These are the shapes that place
// has to get right.
describe("resolveConfiguredTerminalShell", () => {
  it("treats an unset or default shell as the platform default", () => {
    expect(resolveConfiguredTerminalShell({})).toBeUndefined();
    expect(resolveConfiguredTerminalShell({ terminalShell: "default" })).toBeUndefined();
    expect(resolveConfiguredTerminalShell({ terminalShell: "   " })).toBeUndefined();
  });

  it("passes a preset id through", () => {
    expect(resolveConfiguredTerminalShell({ terminalShell: "nu" })).toBe("nu");
    expect(resolveConfiguredTerminalShell({ terminalShell: "git-bash" })).toBe("git-bash");
  });

  it("resolves custom to the configured path", () => {
    expect(
      resolveConfiguredTerminalShell({
        terminalShell: "custom",
        customTerminalShellPath: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      }),
    ).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
  });

  // Selecting custom without typing a path must not spawn the empty string; it
  // falls back to the platform default like any unresolvable setting.
  it("falls back to the default when custom has no path", () => {
    expect(resolveConfiguredTerminalShell({ terminalShell: "custom" })).toBeUndefined();
    expect(
      resolveConfiguredTerminalShell({ terminalShell: "custom", customTerminalShellPath: "  " }),
    ).toBeUndefined();
  });
});
