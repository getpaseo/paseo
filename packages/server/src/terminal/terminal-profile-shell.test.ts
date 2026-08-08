import { afterEach, expect, it, vi } from "vitest";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import type * as TerminalShellModule from "./terminal-shell.js";
import { isPlatform } from "../test-utils/platform.js";

// Counts calls at the module boundary: what is guarded is that the resolver is
// never consulted for a profile, not how long a lookup takes.
const resolveTerminalShellExecutable = vi.hoisted(() =>
  vi.fn(async (_shell?: string) => "/bin/sh"),
);

vi.mock("./terminal-shell.js", async (importOriginal) => {
  const actual = await importOriginal<typeof TerminalShellModule>();
  return { ...actual, resolveTerminalShellExecutable };
});

// Imported after the mock so terminal.ts binds to the stubbed resolver.
const { createTerminal } = await import("./terminal.js");

if (isPlatform("win32") && !process.env.ComSpec && !process.env.COMSPEC) {
  process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";
}

const sessions: Array<{ kill: () => void }> = [];

afterEach(() => {
  while (sessions.length > 0) {
    sessions.pop()?.kill();
  }
  resolveTerminalShellExecutable.mockClear();
});

function platformCommand(): string {
  return isPlatform("win32")
    ? (process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe")
    : "/bin/sh";
}

// A profile supplies its own binary as the PTY process, so there is no shell
// setting to interpret. Resolving one anyway would spend a PATH lookup on a
// result the spawn then discards.
it("does not resolve the shell when launching a profile command", async () => {
  const session = await createTerminal({
    cwd: realpathSync(tmpdir()),
    workspaceId: "ws-profile-no-shell",
    shell: "cmd",
    command: platformCommand(),
  });
  sessions.push(session);

  expect(resolveTerminalShellExecutable).not.toHaveBeenCalled();
});

it("resolves the shell for a plain terminal", async () => {
  resolveTerminalShellExecutable.mockResolvedValueOnce(platformCommand());

  const session = await createTerminal({
    cwd: realpathSync(tmpdir()),
    workspaceId: "ws-plain-shell",
    shell: "cmd",
  });
  sessions.push(session);

  expect(resolveTerminalShellExecutable).toHaveBeenCalledWith("cmd");
});
