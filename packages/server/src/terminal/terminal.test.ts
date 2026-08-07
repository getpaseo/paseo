import { describe, it, expect, afterEach, vi } from "vitest";
import { isPlatform } from "../test-utils/platform.js";
import {
  buildTerminalEnvironment,
  clearTerminalShellExecutableCache,
  createTerminal,
  ensureNodePtySpawnHelperExecutableForCurrentPlatform,
  findTerminalShellBinary,
  resolveDefaultTerminalShell,
  resolveTerminalShellExecutable,
  resolveTerminalSpawnCommand,
  humanizeProcessTitle,
  normalizeProcessTitle,
  resolveZshShellIntegrationDir,
  type TerminalSession,
} from "./terminal.js";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import * as pty from "node-pty";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { setImmediate as waitForImmediate, setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";

const hasZsh = existsSync("/bin/zsh");

type TerminalRow = ReturnType<TerminalSession["getState"]>["grid"][number];

function rowToText(row: TerminalRow): string {
  return row
    .map((cell) => cell.char)
    .join("")
    .trimEnd();
}

// Extract text from a single row
function getRowText(state: ReturnType<TerminalSession["getState"]>, rowIndex: number): string {
  return rowToText(state.grid[rowIndex]);
}

// Extract all visible lines as array (trimmed, empty lines included)
function getLines(state: ReturnType<TerminalSession["getState"]>): string[] {
  return state.grid.map(rowToText);
}

// Wait for terminal state to match expected lines
async function waitForLines(
  session: TerminalSession,
  expectedLines: string[],
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const lines = getLines(session.getState());
    let matches = true;
    for (let i = 0; i < expectedLines.length; i++) {
      if (lines[i] !== expectedLines[i]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const actual = getLines(session.getState()).slice(0, expectedLines.length);
  throw new Error(
    `Timeout waiting for expected lines.\nExpected:\n${JSON.stringify(expectedLines, null, 2)}\nActual:\n${JSON.stringify(actual, null, 2)}`,
  );
}

async function waitForState(
  session: TerminalSession,
  predicate: (state: ReturnType<TerminalSession["getState"]>) => boolean,
  timeoutMs = 5000,
): Promise<ReturnType<TerminalSession["getState"]>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = session.getState();
    if (predicate(state)) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error("Timeout waiting for terminal state predicate to match");
}

async function waitForTitle(
  session: TerminalSession,
  predicate: (title: string | undefined) => boolean,
  timeoutMs = 5000,
): Promise<string | undefined> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const title = session.getTitle();
    if (predicate(title)) {
      return title;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error("Timeout waiting for terminal title predicate to match");
}

if (isPlatform("win32") && !process.env.ComSpec && !process.env.COMSPEC) {
  process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";
}

const sessions: TerminalSession[] = [];
const temporaryDirs: string[] = [];

/**
 * `kill()` only signals; the shell exits asynchronously and keeps writing on
 * the way out (zsh drops a history file and a compdump into `$ZDOTDIR`).
 * Deleting its directory before then loses the race as `ENOTEMPTY`: the
 * recursive walk empties the directory, the dying shell recreates a file in it,
 * and the final rmdir fails.
 *
 * Waiting for the exit shrinks that window but does not close it: some of those
 * writes come from processes zsh forked, which outlive the pty and answer to
 * nothing we hold. Retries alone did not close it either.
 *
 * The known post-retry `ENOTEMPTY` race is reported and tolerated because it
 * belongs to a descendant shell outliving the tested terminal. Any other
 * cleanup error still fails the test that owns the directory.
 */
async function waitForSessionExit(session: TerminalSession): Promise<void> {
  const exited = new Promise<void>((resolve) => {
    const dispose = session.onExit(() => {
      dispose();
      resolve();
    });
    session.kill();
  });
  await Promise.race([exited, delay(2_000)]);
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(sessions.map(waitForSessionExit));
  sessions.length = 0;
  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "ENOTEMPTY"
        ) {
          throw error;
        }
        console.warn(`leaving temp dir behind after ENOTEMPTY retries: ${dir}`);
      }
    }
  }
});

function trackSession(session: TerminalSession): TerminalSession {
  sessions.push(session);
  return session;
}

async function waitForScheduledTimers(expectedTimerCount: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (vi.getTimerCount() === expectedTimerCount) {
      return;
    }
    await waitForImmediate();
  }

  throw new Error(`Expected ${expectedTimerCount} scheduled timers, got ${vi.getTimerCount()}`);
}

describe("createTerminal", () => {
  it("keeps full process titles while stripping path prefixes", () => {
    expect(normalizeProcessTitle("   /usr/local/bin/npm   run   dev   ")).toBe("npm run dev");
    expect(normalizeProcessTitle("/opt/homebrew/bin/node /tmp/work/npm-cli.js run dev")).toBe(
      "node npm-cli.js run dev",
    );
    expect(normalizeProcessTitle("")).toBeUndefined();
  });

  it("humanizes interpreter-backed package manager commands", () => {
    expect(
      humanizeProcessTitle(
        "/usr/local/bin/node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js run dev",
      ),
    ).toBe("npm run dev");
    expect(
      humanizeProcessTitle("/usr/bin/env FOO=bar /opt/homebrew/bin/node /tmp/npm-cli.js test"),
    ).toBe("npm test");
  });

  it("drops common interpreter prefixes for direct scripts", () => {
    expect(humanizeProcessTitle("/usr/bin/python3 /tmp/server.py --port 3000")).toBe(
      "server.py --port 3000",
    );
    expect(humanizeProcessTitle("/bin/bash /tmp/dev.sh")).toBe("dev.sh");
  });

  // macOS-only: node-pty ships the spawn-helper prebuild only for darwin.
  it.runIf(isPlatform("darwin"))("ensures darwin prebuild spawn-helper is executable", () => {
    const packageRoot = mkdtempSync(join(tmpdir(), "terminal-node-pty-helper-"));
    temporaryDirs.push(packageRoot);
    const prebuildDir = join(packageRoot, "prebuilds", `darwin-${process.arch}`);
    mkdirSync(prebuildDir, { recursive: true });
    const helperPath = join(prebuildDir, "spawn-helper");
    writeFileSync(helperPath, "#!/bin/sh\necho helper\n");
    chmodSync(helperPath, 0o644);

    ensureNodePtySpawnHelperExecutableForCurrentPlatform({
      packageRoot,
      platform: "darwin",
      force: true,
    });

    expect(statSync(helperPath).mode & 0o111).toBe(0o111);
  });

  it("uses cmd.exe-compatible default shell on Windows", () => {
    expect(resolveDefaultTerminalShell({ platform: "win32", env: {} })).toBe(
      "C:\\Windows\\System32\\cmd.exe",
    );
    expect(
      resolveDefaultTerminalShell({
        platform: "win32",
        env: { ComSpec: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" },
      }),
    ).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  });

  it("resolves preset and custom terminal shell executables dynamically via PATH", async () => {
    const mockFinder = vi.fn(async (name: string) => {
      if (name === "pwsh.exe")
        return "C:\\Users\\user\\AppData\\Local\\Microsoft\\WinGet\\Links\\pwsh.exe";
      if (name === "powershell.exe")
        return "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
      if (name === "zsh") return "/opt/homebrew/bin/zsh";
      if (name === "nu.exe") return "C:\\Program Files\\nu\\nu.exe";
      if (name === "elvish") return "/usr/local/bin/elvish";
      return null;
    });

    await expect(
      resolveTerminalShellExecutable("default", {
        platform: "win32",
        env: {},
        findOnPath: mockFinder,
      }),
    ).resolves.toBe("C:\\Windows\\System32\\cmd.exe");

    await expect(
      resolveTerminalShellExecutable("pwsh", { platform: "win32", findOnPath: mockFinder }),
    ).resolves.toBe("C:\\Users\\user\\AppData\\Local\\Microsoft\\WinGet\\Links\\pwsh.exe");

    await expect(
      resolveTerminalShellExecutable("powershell", {
        platform: "win32",
        findOnPath: mockFinder,
      }),
    ).resolves.toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");

    await expect(
      resolveTerminalShellExecutable("zsh", { platform: "darwin", findOnPath: mockFinder }),
    ).resolves.toBe("/opt/homebrew/bin/zsh");

    await expect(
      resolveTerminalShellExecutable("nu", { platform: "win32", findOnPath: mockFinder }),
    ).resolves.toBe("C:\\Program Files\\nu\\nu.exe");

    await expect(
      resolveTerminalShellExecutable("elvish", { platform: "linux", findOnPath: mockFinder }),
    ).resolves.toBe("/usr/local/bin/elvish");

    await expect(
      resolveTerminalShellExecutable("C:\\Tools\\my-shell.exe", {
        platform: "win32",
        findOnPath: mockFinder,
      }),
    ).resolves.toBe("C:\\Tools\\my-shell.exe");
  });

  it("resolves real installed nu executable on current host", async () => {
    const resolved = await resolveTerminalShellExecutable("nu");
    expect(resolved.toLowerCase()).toContain("nu");
  });

  it("spawns real installed nu shell in createTerminal on current host", async () => {
    const session = await createTerminal({
      cwd: tmpdir(),
      workspaceId: "ws-nu-test",
      shell: "nu",
    });
    session.kill();
    expect(session.id).toBeDefined();
  });

  // Git for Windows keeps its bash off PATH, and the `bash.exe` that IS on PATH
  // is the WSL launcher. A single "bash" preset therefore always meant WSL. The
  // contract is that the two ids resolve to different binaries.
  it("keeps WSL and Git Bash distinct on Windows", async () => {
    clearTerminalShellExecutableCache();
    const finder = vi.fn(async (name: string) => {
      if (name === "wsl.exe") return "C:\\Windows\\System32\\wsl.exe";
      if (name === "bash.exe") return "C:\\Windows\\System32\\bash.exe";
      // Git Bash is never found by name; only `git` is on PATH.
      if (name === "git") return "C:\\Program Files\\Git\\cmd\\git.exe";
      return null;
    });

    const wsl = await findTerminalShellBinary("wsl", { platform: "win32", findOnPath: finder });
    const gitBash = await findTerminalShellBinary("git-bash", {
      platform: "win32",
      findOnPath: finder,
    });

    expect(wsl).toBe("C:\\Windows\\System32\\wsl.exe");
    // Derived from the git install root, not from a PATH lookup of "bash".
    expect(gitBash?.toLowerCase()).toContain("git");
    expect(gitBash?.toLowerCase()).toContain("bash.exe");
    expect(gitBash).not.toBe(wsl);
    expect(gitBash?.toLowerCase()).not.toContain("system32");
  });

  it("reports a shell that is not installed as unavailable rather than guessing", async () => {
    clearTerminalShellExecutableCache();
    const finder = vi.fn(async () => null);
    await expect(
      findTerminalShellBinary("elvish", { platform: "win32", findOnPath: finder }),
    ).resolves.toBeNull();
    await expect(
      findTerminalShellBinary("fish", { platform: "win32", findOnPath: finder }),
    ).resolves.toBeNull();
  });

  // Shell integration is keyed on the spawned binary's base name, and selecting a
  // preset resolves it to an absolute PATH hit rather than passing `$SHELL`
  // through. A resolution that changed the base name would silently drop OSC 633
  // exit codes and OSC 2 tab titles for anyone who picks zsh explicitly.
  it("keeps zsh shell integration when zsh is selected explicitly", async () => {
    clearTerminalShellExecutableCache();
    const resolved = await resolveTerminalShellExecutable("zsh", {
      platform: "darwin",
      findOnPath: async () => "/opt/homebrew/bin/zsh",
    });

    expect(basename(resolved)).toBe("zsh");
    expect(
      buildTerminalEnvironment({
        shell: resolved,
        env: {},
        zshShellIntegrationDir: resolveZshShellIntegrationDir(),
        paseoCliBinDir: null,
        paseoHookCliPath: null,
      }),
    ).toHaveProperty("ZDOTDIR");
  });

  // A shell Paseo ships no integration for still spawns; it just does not get the
  // zsh hooks. Asserted so the gate stays an opt-in rather than becoming a
  // requirement that breaks the other presets.
  it("spawns a non-zsh shell without shell-integration env", async () => {
    clearTerminalShellExecutableCache();
    const resolved = await resolveTerminalShellExecutable("nu", {
      platform: "darwin",
      findOnPath: async () => "/opt/homebrew/bin/nu",
    });

    expect(
      buildTerminalEnvironment({
        shell: resolved,
        env: {},
        zshShellIntegrationDir: resolveZshShellIntegrationDir(),
        paseoCliBinDir: null,
        paseoHookCliPath: null,
      }),
    ).not.toHaveProperty("ZDOTDIR");
  });

  // Git Bash is reachable even when `git` is absent from PATH (a Git for Windows
  // install that only registered its GUI shims), so the standard install
  // locations are checked as a fallback.
  it.runIf(isPlatform("win32"))(
    "finds Git Bash at its standard install location without git on PATH",
    async () => {
      clearTerminalShellExecutableCache();
      const resolved = await findTerminalShellBinary("git-bash", {
        platform: "win32",
        findOnPath: async () => null,
      });

      if (resolved === null) {
        // Git for Windows is not installed on this host; nothing to assert.
        return;
      }
      expect(resolved.toLowerCase()).toContain("bash.exe");
      expect(resolved.toLowerCase()).not.toContain("system32");
    },
  );

  it("memoizes resolved shell paths in memory for fast subsequent terminal launches", async () => {
    clearTerminalShellExecutableCache();
    const finder = vi.fn(async () => "/usr/local/bin/fish");
    await expect(
      resolveTerminalShellExecutable("fish", { platform: "darwin", findOnPath: finder }),
    ).resolves.toBe("/usr/local/bin/fish");
    expect(finder).toHaveBeenCalledTimes(1);
  });

  it("falls back safely to default system shell if a requested shell is missing", async () => {
    clearTerminalShellExecutableCache();
    const finder = vi.fn(async () => null);
    await expect(
      resolveTerminalShellExecutable("pwsh", {
        platform: "win32",
        env: {},
        findOnPath: finder,
      }),
    ).resolves.toBe("C:\\Windows\\System32\\cmd.exe");
  });

  it("passes profile commands through untouched on non-Windows", async () => {
    const resolveExecutable = vi.fn(async () => "/usr/local/bin/claude");
    const resolved = await resolveTerminalSpawnCommand("claude", ["--foo"], {
      platform: "linux",
      resolveExecutable,
    });

    expect(resolved).toEqual({ command: "claude", args: ["--foo"] });
    // Non-Windows must not pay the executable-resolution cost.
    expect(resolveExecutable).not.toHaveBeenCalled();
  });

  it.runIf(isPlatform("linux", "darwin"))(
    "passes an unescaped multi-line prompt through byte-for-byte on POSIX",
    async () => {
      // node-pty spawns directly via execve on POSIX (no shell), so a prompt
      // substituted into `args` is never re-parsed by anything -- it must
      // reach the target process exactly as typed, including raw newlines,
      // quotes, and shell metacharacters that would be dangerous under a
      // shell but are inert here.
      const nastyPrompt =
        'fix the bug\nwhere `git commit -m "wip"` fails\nif $HOME contains a & or | char';
      const resolveExecutable = vi.fn(async () => "/usr/local/bin/claude");

      const resolvedLinux = await resolveTerminalSpawnCommand("claude", [nastyPrompt], {
        platform: "linux",
        resolveExecutable,
      });
      const resolvedDarwin = await resolveTerminalSpawnCommand("claude", [nastyPrompt], {
        platform: "darwin",
        resolveExecutable,
      });

      expect(resolvedLinux).toEqual({ command: "claude", args: [nastyPrompt] });
      expect(resolvedDarwin).toEqual({ command: "claude", args: [nastyPrompt] });
      expect(resolveExecutable).not.toHaveBeenCalled();
    },
  );

  it("keeps the original command when it cannot be resolved on Windows", async () => {
    const resolved = await resolveTerminalSpawnCommand("claude", [], {
      platform: "win32",
      resolveExecutable: async () => null,
    });

    // Falls back to the bare command so the terminal surfaces the error itself.
    expect(resolved).toEqual({ command: "claude", args: [] });
  });

  it("routes resolved .cmd shims through cmd.exe on Windows", async () => {
    const resolved = await resolveTerminalSpawnCommand("claude", ["--foo"], {
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      resolveExecutable: async () => "C:\\npm\\claude.cmd",
    });

    // The `.cmd` branch now hands node-pty a single pre-escaped command line
    // (string) instead of an argv array, so that node-pty's own
    // MSVCRT-style array quoting never runs a second time over an already
    // cmd.exe-escaped argument. See escapeCmdExeArgument in terminal.ts.
    expect(resolved).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: '/d /s /c "C:\\npm\\claude.cmd ^^^"--foo^^^""',
    });
  });

  describe(".cmd shim argument escaping on Windows", () => {
    async function resolveCmdShimArgs(promptArg: string): Promise<string> {
      const resolved = await resolveTerminalSpawnCommand("claude", [promptArg], {
        platform: "win32",
        env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
        resolveExecutable: async () => "C:\\npm\\claude.cmd",
      });
      // A real narrow rather than a cast: the `.cmd` branch is the one case
      // that returns a pre-escaped command line instead of argv, so if that
      // contract ever changes these tests should fail loudly here rather than
      // assert against a stringified array.
      const { args } = resolved;
      if (typeof args !== "string") {
        throw new Error(`expected a cmd.exe command line, got ${JSON.stringify(args)}`);
      }
      return args;
    }

    // Each expected string is the exact cmd.exe command line the escaping
    // must produce so a real `cmd.exe /c` invocation reconstructs the
    // original prompt as a single argv element for the target process
    // (modulo the documented newline-to-space normalization below).
    it("neutralizes cmd.exe's own metacharacters instead of letting them execute", async () => {
      expect(await resolveCmdShimArgs("a & b | c")).toBe(
        '/d /s /c "C:\\npm\\claude.cmd ^^^"a^^^ ^^^&^^^ b^^^ ^^^|^^^ c^^^""',
      );
      expect(await resolveCmdShimArgs("100% done %PATH%")).toBe(
        '/d /s /c "C:\\npm\\claude.cmd ^^^"100^^^%^^^ done^^^ ^^^%PATH^^^%^^^""',
      );
      expect(await resolveCmdShimArgs("a^b")).toBe('/d /s /c "C:\\npm\\claude.cmd ^^^"a^^^^b^^^""');
    });

    it("escapes embedded double quotes and backslash runs preceding them", async () => {
      expect(await resolveCmdShimArgs('say "hello" now')).toBe(
        '/d /s /c "C:\\npm\\claude.cmd ^^^"say^^^ \\^^^"hello\\^^^"^^^ now^^^""',
      );
      expect(await resolveCmdShimArgs('C:\\path\\ "quoted"')).toBe(
        '/d /s /c "C:\\npm\\claude.cmd ^^^"C:\\path\\^^^ \\^^^"quoted\\^^^"^^^""',
      );
    });

    // cmd.exe has no way to escape a literal CR/LF inside one command line
    // -- its parser treats newlines as command separators regardless of
    // quoting -- so a raw newline is normalized to a space before escaping.
    // This is a deliberate choice, not an oversight: it avoids the prompt
    // ever splitting into a second, attacker-controlled cmd.exe command, at
    // the cost of losing the original line breaks.
    it("normalizes embedded newlines to spaces instead of letting them split the command", async () => {
      expect(await resolveCmdShimArgs("line one\nline two")).toBe(
        '/d /s /c "C:\\npm\\claude.cmd ^^^"line^^^ one^^^ line^^^ two^^^""',
      );
      expect(await resolveCmdShimArgs("line one\r\nline two")).toBe(
        '/d /s /c "C:\\npm\\claude.cmd ^^^"line^^^ one^^^ line^^^ two^^^""',
      );
    });

    it("handles a multi-line prompt combining quotes, backslashes, and every cmd.exe metacharacter", async () => {
      const prompt = 'multi\nline "quoted \\path\\" & piped | percent %VAR% ^caret';
      expect(await resolveCmdShimArgs(prompt)).toBe(
        '/d /s /c "C:\\npm\\claude.cmd ^^^"multi^^^ line^^^ \\^^^"quoted^^^ \\path\\\\\\^^^"^^^ ^^^&^^^ piped^^^ ^^^|^^^ percent^^^ ^^^%VAR^^^%^^^ ^^^^caret^^^""',
      );
    });
  });

  it("uses the resolved .exe path directly on Windows", async () => {
    const resolved = await resolveTerminalSpawnCommand("claude", ["--foo"], {
      platform: "win32",
      resolveExecutable: async () => "C:\\tools\\claude.exe",
    });

    expect(resolved).toEqual({ command: "C:\\tools\\claude.exe", args: ["--foo"] });
  });

  it.runIf(isPlatform("linux", "darwin"))(
    "spawns without shell interpretation on POSIX, so argv reaches the child byte-for-byte",
    async () => {
      // The composer substitutes {{{prompt}}} directly into `args` before this
      // ever reaches the daemon, so a raw multi-line prompt containing quotes,
      // backslashes, and shell metacharacters must arrive at the spawned
      // process exactly as typed. node-pty's POSIX backend spawns via execve
      // with no shell, so per-arg escaping is unnecessary there -- this test
      // proves that end-to-end through createTerminal (not just at the
      // resolveTerminalSpawnCommand unit level) by reading the argv the
      // spawned process actually received back out of the pty.
      const nastyPrompt =
        'line one\nline two: git commit -m "wip" && echo $HOME | grep ^x > out.txt';
      const session = trackSession(
        await createTerminal({
          workspaceId: "ws-test",
          cwd: realpathSync(tmpdir()),
          cols: 500,
          command: process.execPath,
          args: ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", nastyPrompt],
        }),
      );

      const state = await waitForState(session, (s) => getRowText(s, 0).startsWith("["));

      expect(JSON.parse(getRowText(state, 0))).toEqual([nastyPrompt]);
    },
  );

  it("creates a terminal session with an id, name, and cwd", async () => {
    const session = trackSession(
      await createTerminal({
        workspaceId: "ws-test",
        cwd: realpathSync(tmpdir()),
      }),
    );

    expect(session.id).toBeDefined();
    expect(typeof session.id).toBe("string");
    expect(session.id.length).toBeGreaterThan(0);
    expect(session.name).toBe("Terminal");
    expect(session.cwd).toBe(realpathSync(tmpdir()));
  });

  it("uses custom name when provided", async () => {
    const shell = isPlatform("win32")
      ? (process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe")
      : "/bin/sh";
    const session = trackSession(
      await createTerminal({
        workspaceId: "ws-test",
        cwd: realpathSync(tmpdir()),
        shell,
        env: { PS1: "$ " },
        name: "Dev Server",
      }),
    );

    expect(session.name).toBe("Dev Server");
  });

  it("uses default shell if not specified", async () => {
    const session = trackSession(
      await createTerminal({
        workspaceId: "ws-test",
        cwd: realpathSync(tmpdir()),
      }),
    );

    expect(session.id).toBeDefined();
  });

  it("uses default rows and cols", async () => {
    const shell = isPlatform("win32")
      ? (process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe")
      : "/bin/sh";
    const session = trackSession(
      await createTerminal({
        workspaceId: "ws-test",
        cwd: realpathSync(tmpdir()),
        shell,
        env: { PS1: "$ " },
      }),
    );

    const state = session.getState();
    expect(state.rows).toBe(24);
    expect(state.cols).toBe(80);
  });

  it("respects custom rows and cols", async () => {
    const shell = isPlatform("win32")
      ? (process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe")
      : "/bin/sh";
    const session = trackSession(
      await createTerminal({
        workspaceId: "ws-test",
        cwd: realpathSync(tmpdir()),
        shell,
        env: { PS1: "$ " },
        rows: 40,
        cols: 120,
      }),
    );

    const state = session.getState();
    expect(state.rows).toBe(40);
    expect(state.cols).toBe(120);
  });

  it("reports per-row soft-wrap flags only when wrap flags are requested", async () => {
    const session = trackSession(
      await createTerminal({
        workspaceId: "ws-test",
        cwd: realpathSync(tmpdir()),
        cols: 40,
        rows: 10,
        command: process.execPath,
        // 100 chars with no newline soft-wraps across three rows at 40 cols.
        args: ["-e", "process.stdout.write('A'.repeat(100)); setInterval(() => {}, 100000);"],
      }),
    );

    const start = Date.now();
    while (Date.now() - start < 5000) {
      if (rowToText(session.getState().grid[2]).startsWith("A")) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // Rows 0 and 1 continue onto the next row; row 2 is the end of the logical line.
    const withFlags = session.getState({ includeWrapFlags: true });
    expect(withFlags.gridWrapped?.slice(0, 3)).toEqual([true, true, false]);

    // Back-compat gate: without the capability the daemon must not attach the new
    // fields, so an old strict-schema client still parses the snapshot.
    const withoutFlags = session.getState();
    expect(withoutFlags.gridWrapped).toBeUndefined();
    expect(withoutFlags.scrollbackWrapped).toBeUndefined();
  });

  it("captures exit diagnostics from the terminal buffer", async () => {
    const session = trackSession(
      await createTerminal({
        workspaceId: "ws-test",
        cwd: realpathSync(tmpdir()),
        command: process.execPath,
        args: [
          "-e",
          "process.stdout.write('launch failed\\ncommand missing\\n'); process.exit(127);",
        ],
      }),
    );

    const exitInfo = await new Promise<NonNullable<ReturnType<TerminalSession["getExitInfo"]>>>(
      (resolve) => {
        session.onExit((info) => resolve(info));
      },
    );

    expect(exitInfo.exitCode).toBe(127);
    expect(exitInfo.signal).toBeNull();
    // lastOutputLines may be empty if the process exits before xterm processes the data write
    expect(Array.isArray(exitInfo.lastOutputLines)).toBe(true);
    expect(session.getExitInfo()).toEqual(exitInfo);
  });

  it("retains the final lines after output far exceeds the recent-output char cap", async () => {
    // Emit many small chunks whose total length is well past the 16000-char
    // recent-output cap, so the chunk-trimming path runs repeatedly. The final
    // distinctive lines must survive in the exit summary. The process is kept
    // alive (no self-exit) so we can wait until the last chunk has actually been
    // parsed by the headless terminal before killing — otherwise the exit
    // summary races the async xterm parse and reads a stale buffer.
    const session = trackSession(
      await createTerminal({
        workspaceId: "ws-test",
        cwd: realpathSync(tmpdir()),
        command: process.execPath,
        args: [
          "-e",
          "for (let i = 0; i < 3000; i++) { process.stdout.write(`line-${i}\\n`); } setInterval(() => {}, 1000);",
        ],
      }),
    );

    // Poll the parsed buffer until the final line lands, so the exit summary
    // (which reads the headless buffer) can't race the async xterm parse.
    const finalLineParsed = (): boolean => {
      const state = session.getState();
      const rowText = (row: { char: string }[]): string => row.map((cell) => cell.char).join("");
      return [...state.scrollback, ...state.grid].some((row) => rowText(row).includes("line-2999"));
    };
    const deadline = Date.now() + 10000;
    while (!finalLineParsed()) {
      if (Date.now() > deadline) {
        throw new Error("Timed out waiting for the final line to be parsed");
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const exitInfo = await new Promise<NonNullable<ReturnType<TerminalSession["getExitInfo"]>>>(
      (resolve) => {
        session.onExit((info) => resolve(info));
        session.kill();
      },
    );

    expect(exitInfo.lastOutputLines.length).toBeGreaterThan(0);
    expect(exitInfo.lastOutputLines[exitInfo.lastOutputLines.length - 1]).toBe("line-2999");
  });
});

describe.skipIf(isPlatform("win32"))("send input", () => {
  it("executes a simple echo command", async () => {
    const session = trackSession(
      await createTerminal({
        workspaceId: "ws-test",
        cwd: "/tmp",
        shell: "/bin/sh",
        env: { PS1: "$ " },
      }),
    );

    // Wait for initial prompt, then send command
    await waitForLines(session, ["$"]);

    session.send({ type: "input", data: "echo hello\r" });

    // After running "echo hello", terminal should show:
    // Line 0: "$ echo hello"
    // Line 1: "hello"
    // Line 2: "$"
    await waitForLines(session, ["$ echo hello", "hello", "$"]);

    const state = session.getState();
    expect(getRowText(state, 0)).toBe("$ echo hello");
    expect(getRowText(state, 1)).toBe("hello");
    expect(getRowText(state, 2)).toBe("$");
  });

  it("captures output from pwd in specified cwd", async () => {
    const session = trackSession(
      await createTerminal({
        workspaceId: "ws-test",
        cwd: "/tmp",
        shell: "/bin/sh",
        env: { PS1: "$ " },
      }),
    );

    await waitForLines(session, ["$"]);

    session.send({ type: "input", data: "pwd\r" });

    await waitForLines(session, ["$ pwd", "/tmp", "$"]);

    const state = session.getState();
    expect(getRowText(state, 0)).toBe("$ pwd");
    expect(getRowText(state, 1)).toBe("/tmp");
    expect(getRowText(state, 2)).toBe("$");
  });
});

describe.skipIf(isPlatform("win32"))("terminal title", () => {
  it.skipIf(!hasZsh)("restores the user's ZDOTDIR through the zsh wrapper", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "terminal-zsh-home-"));
    temporaryDirs.push(homeDir);
    const realZdotdir = join(homeDir, ".config", "zsh");
    mkdirSync(realZdotdir, { recursive: true });
    writeFileSync(join(realZdotdir, ".zshenv"), "export PASEO_TEST_REAL_ZDOTDIR=1\n");

    const session = trackSession(
      await createTerminal({
        workspaceId: "ws-test",
        cwd: homeDir,
        command: "/bin/zsh",
        args: ["-c", 'printf \'%s\\n%s\\n\' "${ZDOTDIR-}" "${PASEO_TEST_REAL_ZDOTDIR-}"'],
        env: {
          HOME: homeDir,
          ZDOTDIR: realZdotdir,
        },
      }),
    );

    const exitInfo = await new Promise<NonNullable<ReturnType<TerminalSession["getExitInfo"]>>>(
      (resolve) => {
        session.onExit((info) => resolve(info));
      },
    );

    expect(exitInfo.lastOutputLines).toEqual([realZdotdir, "1"]);
  });

  it("emits the initial title from command args to title listeners", async () => {
    const packageRoot = mkdtempSync(join(tmpdir(), "terminal-title-script-"));
    temporaryDirs.push(packageRoot);
    const scriptPath = join(packageRoot, "npm-cli.js");
    writeFileSync(scriptPath, "setTimeout(() => process.exit(0), 1000);\n");

    const session = trackSession(
      await createTerminal({
        workspaceId: "ws-test",
        cwd: packageRoot,
        command: process.execPath,
        args: [scriptPath, "run", "dev"],
      }),
    );
    const seenTitles: Array<string | undefined> = [];
    const unsubscribeTitle = session.onTitleChange((title) => {
      seenTitles.push(title);
    });

    await waitForTitle(session, (title) => title === "npm run dev");
    await waitForState(session, (state) => state.title === "npm run dev");

    expect(seenTitles).toContain("npm run dev");
    expect(session.getTitle()).toBe("npm run dev");
    expect(session.getState().title).toBe("npm run dev");

    unsubscribeTitle();
  });

  it("emits OSC title updates to title listeners", async () => {
    const session = trackSession(
      await createTerminal({
        workspaceId: "ws-test",
        cwd: "/tmp",
        shell: "/bin/sh",
        env: { PS1: "$ " },
      }),
    );
    const seenTitles: Array<string | undefined> = [];
    const unsubscribeTitle = session.onTitleChange((title) => {
      seenTitles.push(title);
    });

    await waitForLines(session, ["$"]);
    session.send({ type: "input", data: "printf '\\033]0;Build Log\\007'\r" });

    await waitForTitle(session, (title) => title === "Build Log");

    expect(seenTitles).toContain("Build Log");
    expect(session.getTitle()).toBe("Build Log");
    expect(session.getState().title).toBe("Build Log");

    unsubscribeTitle();
  });

  it("keeps preset titles instead of applying OSC title updates", async () => {
    const session = trackSession(
      await createTerminal({
        workspaceId: "ws-test",
        cwd: "/tmp",
        shell: "/bin/sh",
        env: { PS1: "$ " },
        title: "typecheck",
      }),
    );

    await waitForLines(session, ["$"]);
    session.send({ type: "input", data: "printf '\\033]0;Build Log\\007'\r" });
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(session.getTitle()).toBe("typecheck");
    expect(session.getState().title).toBe("typecheck");
  });

  it("emits command completion from VS Code OSC 633 without visible output", async () => {
    const packageRoot = mkdtempSync(join(tmpdir(), "terminal-command-finished-"));
    temporaryDirs.push(packageRoot);
    const scriptPath = join(packageRoot, "emit-command-finished.sh");
    writeFileSync(scriptPath, "#!/bin/sh\nprintf '\\033]633;D;7\\007'\n");
    chmodSync(scriptPath, 0o755);

    const session = trackSession(
      await createTerminal({
        workspaceId: "ws-test",
        cwd: packageRoot,
        shell: "/bin/sh",
        env: { PS1: "$ " },
      }),
    );
    const commandCompletions: Array<number | null> = [];
    const unsubscribeCommandFinished = session.onCommandFinished((info) => {
      commandCompletions.push(info.exitCode);
    });

    await waitForLines(session, ["$"]);
    session.send({ type: "input", data: "./emit-command-finished.sh\r" });

    await waitForState(session, () => commandCompletions.length === 1);

    expect(commandCompletions).toEqual([7]);
    expect(getLines(session.getState()).join("\n")).not.toContain("633;D;7");

    unsubscribeCommandFinished();
  });

  it("ignores malformed VS Code OSC 633 command completion payloads", async () => {
    const packageRoot = mkdtempSync(join(tmpdir(), "terminal-command-finished-malformed-"));
    temporaryDirs.push(packageRoot);
    const scriptPath = join(packageRoot, "emit-malformed-command-finished.sh");
    writeFileSync(
      scriptPath,
      "#!/bin/sh\nprintf '\\033]633;D;garbage\\007\\033]633;D;8;extra\\007\\033]633;D;3\\007'\n",
    );
    chmodSync(scriptPath, 0o755);

    const session = trackSession(
      await createTerminal({
        workspaceId: "ws-test",
        cwd: packageRoot,
        shell: "/bin/sh",
        env: { PS1: "$ " },
      }),
    );
    const commandCompletions: Array<number | null> = [];
    const unsubscribeCommandFinished = session.onCommandFinished((info) => {
      commandCompletions.push(info.exitCode);
    });

    await waitForLines(session, ["$"]);
    session.send({ type: "input", data: "./emit-malformed-command-finished.sh\r" });

    await waitForState(session, () => commandCompletions.length === 1);

    expect(commandCompletions).toEqual([3]);
    expect(getLines(session.getState()).join("\n")).not.toContain("633;D;garbage");

    unsubscribeCommandFinished();
  });

  it("debounces rapid title changes and emits only the final title", async () => {
    const session = trackSession(
      await createTerminal({
        workspaceId: "ws-test",
        cwd: "/tmp",
        shell: "/bin/sh",
        env: { PS1: "$ " },
      }),
    );
    const seenTitles: Array<string | undefined> = [];
    const seenMessages: Array<string | undefined> = [];
    const unsubscribeTitle = session.onTitleChange((title) => {
      seenTitles.push(title);
    });
    const unsubscribeMessages = session.subscribe((message) => {
      if (message.type === "titleChange") {
        seenMessages.push(message.title);
      }
    });

    await waitForLines(session, ["$"]);
    session.send({
      type: "input",
      data: "printf '\\033]0;First\\007\\033]0;Second\\007\\033]0;Final\\007'\r",
    });

    await waitForTitle(session, (title) => title === "Final");

    expect(seenTitles).toEqual(["Final"]);
    expect(seenMessages).toEqual(["Final"]);

    unsubscribeMessages();
    unsubscribeTitle();
  });

  it.skipIf(!hasZsh)("emits zsh shell integration titles for commands and prompts", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "terminal-zsh-integration-home-"));
    temporaryDirs.push(homeDir);
    const realZdotdir = join(homeDir, ".config", "zsh");
    const workingDir = join(homeDir, "dev", "faro");
    mkdirSync(realZdotdir, { recursive: true });
    mkdirSync(workingDir, { recursive: true });
    writeFileSync(join(realZdotdir, ".zshenv"), "");
    writeFileSync(join(realZdotdir, ".zshrc"), "PS1='$ '\n");

    const session = trackSession(
      await createTerminal({
        workspaceId: "ws-test",
        cwd: workingDir,
        shell: "/bin/zsh",
        env: {
          HOME: homeDir,
          ZDOTDIR: realZdotdir,
        },
      }),
    );

    await waitForLines(session, ["$"]);
    await waitForTitle(session, (title) => title === "~/dev/faro");

    session.send({ type: "input", data: "sleep 1\r" });

    await waitForTitle(session, (title) => title === "sleep 1");
    await waitForTitle(session, (title) => title === "~/dev/faro", 4000);
  });

  it.skipIf(!hasZsh)("loads the user's zsh prompt when the integration dir is packaged", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "terminal-zsh-packaged-home-"));
    temporaryDirs.push(homeDir);
    writeFileSync(join(homeDir, ".zshrc"), "PS1='PASEO_CUSTOM_PROMPT> '\n");

    const fakeAppRoot = join(homeDir, "Paseo.app", "Contents", "Resources");
    const inaccessiblePackagedIntegrationDir = join(
      fakeAppRoot,
      "app.asar",
      "node_modules",
      "@getpaseo",
      "server",
      "dist",
      "server",
      "terminal",
      "shell-integration",
      "zsh",
    );
    const unpackedIntegrationDir = join(
      fakeAppRoot,
      "app.asar.unpacked",
      "node_modules",
      "@getpaseo",
      "server",
      "dist",
      "server",
      "terminal",
      "shell-integration",
      "zsh",
    );
    mkdirSync(unpackedIntegrationDir, { recursive: true });
    cpSync(resolveZshShellIntegrationDir(), unpackedIntegrationDir, { recursive: true });
    writeFileSync(join(fakeAppRoot, "app.asar"), "asar archive placeholder");

    const env = buildTerminalEnvironment({
      shell: "/bin/zsh",
      env: {
        HOME: homeDir,
      },
      zshShellIntegrationDir: inaccessiblePackagedIntegrationDir,
    });

    const result = spawnSync("/bin/zsh", ["-i", "-c", "print -r -- ${PROMPT}"], {
      cwd: homeDir,
      env,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout.split(/\r?\n/)).toContain("PASEO_CUSTOM_PROMPT> ");
  });

  it.skipIf(!hasZsh)("emits zsh shell integration command completion", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "terminal-zsh-command-finished-home-"));
    temporaryDirs.push(homeDir);
    const realZdotdir = join(homeDir, ".config", "zsh");
    const workingDir = join(homeDir, "dev", "faro");
    mkdirSync(realZdotdir, { recursive: true });
    mkdirSync(workingDir, { recursive: true });
    writeFileSync(join(realZdotdir, ".zshenv"), "");
    writeFileSync(join(realZdotdir, ".zshrc"), "PS1='$ '\n");

    const session = trackSession(
      await createTerminal({
        workspaceId: "ws-test",
        cwd: workingDir,
        shell: "/bin/zsh",
        env: {
          HOME: homeDir,
          ZDOTDIR: realZdotdir,
        },
      }),
    );
    const commandCompletions: Array<number | null> = [];
    const unsubscribeCommandFinished = session.onCommandFinished((info) => {
      commandCompletions.push(info.exitCode);
    });

    await waitForLines(session, ["$"]);
    session.send({ type: "input", data: "false\r" });

    await waitForState(session, () => commandCompletions.includes(1));

    expect(commandCompletions).toEqual([1]);
    expect(getLines(session.getState()).join("\n")).not.toContain("633;D;1");

    unsubscribeCommandFinished();
  });

  it("clears already scheduled OSC title debounce timers when setting a user title", async () => {
    const session = trackSession(
      await createTerminal({
        workspaceId: "ws-test",
        cwd: "/tmp",
        shell: "/bin/sh",
        env: { PS1: "$ " },
      }),
    );
    const seenTitles: Array<string | undefined> = [];
    const unsubscribeTitle = session.onTitleChange((title) => {
      seenTitles.push(title);
    });

    await waitForLines(session, ["$"]);
    session.send({ type: "input", data: "printf '\\033]0;Build Log\\007'\r" });

    await waitForTitle(session, (title) => title === "Build Log");

    vi.useFakeTimers();
    session.send({ type: "input", data: "printf '\\033]0;Pending Shell Title\\007'\r" });
    await waitForScheduledTimers(1);

    session.setTitle("User terminal");
    await vi.advanceTimersByTimeAsync(250);
    vi.useRealTimers();

    expect(seenTitles).toEqual(["Build Log", "User terminal"]);
    expect(session.getTitle()).toBe("User terminal");
    expect(session.getState().title).toBe("User terminal");

    unsubscribeTitle();
  });

  it("ignores later OSC title updates after setting a user title", async () => {
    const session = trackSession(
      await createTerminal({
        workspaceId: "ws-test",
        cwd: "/tmp",
        shell: "/bin/sh",
        env: { PS1: "$ " },
      }),
    );
    const seenTitles: Array<string | undefined> = [];
    const unsubscribeTitle = session.onTitleChange((title) => {
      seenTitles.push(title);
    });

    await waitForLines(session, ["$"]);
    session.send({ type: "input", data: "printf '\\033]0;Build Log\\007'\r" });

    await waitForTitle(session, (title) => title === "Build Log");

    session.setTitle("User terminal");
    session.send({ type: "input", data: "printf '\\033]0;Later Shell Title\\007'\r" });
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(seenTitles).toEqual(["Build Log", "User terminal"]);
    expect(session.getTitle()).toBe("User terminal");
    expect(session.getState().title).toBe("User terminal");

    unsubscribeTitle();
  });

  it("trims user-set titles and treats empty titles as no-ops", async () => {
    const session = trackSession(
      await createTerminal({
        workspaceId: "ws-test",
        cwd: "/tmp",
        shell: "/bin/sh",
        env: { PS1: "$ " },
      }),
    );
    const seenTitles: Array<string | undefined> = [];
    const unsubscribeTitle = session.onTitleChange((title) => {
      seenTitles.push(title);
    });

    await waitForLines(session, ["$"]);

    session.setTitle("   ");
    session.send({ type: "input", data: "printf '\\033]0;Build Log\\007'\r" });
    await waitForTitle(session, (title) => title === "Build Log");

    session.setTitle("  User terminal  ");

    expect(seenTitles).toEqual(["Build Log", "User terminal"]);
    expect(session.getTitle()).toBe("User terminal");
    expect(session.getState().title).toBe("User terminal");

    unsubscribeTitle();
  });
});

describe.skipIf(isPlatform("win32"))("colors", () => {
  it("captures ANSI 16 color codes (mode 1)", async () => {
    const session = trackSession(
      await createTerminal({
        workspaceId: "ws-test",
        cwd: "/tmp",
        shell: "/bin/sh",
        env: { PS1: "$ ", TERM: "xterm-256color" },
      }),
    );

    await waitForLines(session, ["$"]);

    // \033[31m = ANSI red (color 1)
    session.send({ type: "input", data: "printf '\\033[31mRED\\033[0m'\r" });

    await waitForLines(session, ["$ printf '\\033[31mRED\\033[0m'", "RED$"]);

    const state = session.getState();
    const outputRow = state.grid[1];

    expect(outputRow[0].char).toBe("R");
    expect(outputRow[0].fg).toBe(1); // ANSI red = 1
    expect(outputRow[0].fgMode).toBe(1); // Mode 1 = 16 ANSI colors

    // The "$" after RED should have default color
    expect(outputRow[3].char).toBe("$");
    expect(outputRow[3].fg).toBe(undefined);
    expect(outputRow[3].fgMode).toBe(undefined);
  });

  it("captures true color RGB (mode 3)", async () => {
    const session = trackSession(
      await createTerminal({
        workspaceId: "ws-test",
        cwd: "/tmp",
        shell: "/bin/sh",
        env: { PS1: "$ ", TERM: "xterm-256color" },
      }),
    );

    await waitForLines(session, ["$"]);

    // \033[38;2;255;128;64m = true color RGB(255, 128, 64)
    session.send({ type: "input", data: "printf '\\033[38;2;255;128;64mRGB\\033[0m'\r" });

    await waitForLines(session, ["$ printf '\\033[38;2;255;128;64mRGB\\033[0m'", "RGB$"]);

    const state = session.getState();
    const outputRow = state.grid[1];

    // Check R cell
    expect(outputRow[0].char).toBe("R");
    expect(outputRow[0].fgMode).toBe(3); // Mode 3 = true color

    // The color value should be packed RGB: (255 << 16) | (128 << 8) | 64
    const expectedPacked = (255 << 16) | (128 << 8) | 64;
    expect(outputRow[0].fg).toBe(expectedPacked);
  });

  it("captures background colors", async () => {
    const session = trackSession(
      await createTerminal({
        workspaceId: "ws-test",
        cwd: "/tmp",
        shell: "/bin/sh",
        env: { PS1: "$ ", TERM: "xterm-256color" },
      }),
    );

    await waitForLines(session, ["$"]);

    // \033[41m = ANSI red background
    session.send({ type: "input", data: "printf '\\033[41mBG\\033[0m'\r" });

    await waitForLines(session, ["$ printf '\\033[41mBG\\033[0m'", "BG$"]);

    const state = session.getState();
    const outputRow = state.grid[1];

    expect(outputRow[0].char).toBe("B");
    expect(outputRow[0].bg).toBe(1); // ANSI red = 1
    expect(outputRow[0].bgMode).toBe(1); // Mode 1 = 16 ANSI colors
  });
});

describe("resize", () => {
  it("updates terminal dimensions on resize", async () => {
    const session = trackSession(
      await createTerminal({
        workspaceId: "ws-test",
        cwd: realpathSync(tmpdir()),
        rows: 24,
        cols: 80,
      }),
    );

    session.send({ type: "resize", rows: 40, cols: 120 });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const state = session.getState();
    expect(state.rows).toBe(40);
    expect(state.cols).toBe(120);
  });

  it("grid reflects new dimensions after resize", async () => {
    const session = trackSession(
      await createTerminal({
        workspaceId: "ws-test",
        cwd: realpathSync(tmpdir()),
        rows: 24,
        cols: 80,
      }),
    );

    session.send({ type: "resize", rows: 10, cols: 40 });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const state = session.getState();
    expect(state.grid.length).toBe(10);
    expect(state.grid[0].length).toBe(40);
  });

  it("exposes the current size without extracting full state", async () => {
    const session = trackSession(
      await createTerminal({
        workspaceId: "ws-test",
        cwd: realpathSync(tmpdir()),
        rows: 24,
        cols: 80,
      }),
    );

    expect(session.getSize()).toEqual({ rows: 24, cols: 80 });

    session.send({ type: "resize", rows: 10, cols: 40 });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(session.getSize()).toEqual({ rows: 10, cols: 40 });
  });
});

describe("mouse events", () => {
  it("accepts mouse events without throwing", async () => {
    const session = trackSession(
      await createTerminal({
        workspaceId: "ws-test",
        cwd: realpathSync(tmpdir()),
      }),
    );

    // Should not throw
    session.send({ type: "mouse", row: 0, col: 0, button: 0, action: "down" });
    session.send({ type: "mouse", row: 0, col: 0, button: 0, action: "up" });
  });
});

describe("terminal activity interruption", () => {
  it.each([
    ["Ctrl-C", "\x03"],
    ["Escape", "\x1b"],
  ])("clears working activity when %s is sent", async (_name, data) => {
    const session = trackSession(
      await createTerminal({
        workspaceId: "ws-test",
        cwd: realpathSync(tmpdir()),
      }),
    );
    session.setActivity("working");

    session.send({ type: "input", data });

    expect(session.getActivity()).toBeNull();
  });

  it.each([
    ["an arrow sequence", "\x1b[A"],
    ["pasted text containing Ctrl-C", "before\x03after"],
    ["ordinary input", "hello"],
  ])("keeps a working terminal active for %s", async (_name, data) => {
    const session = trackSession(
      await createTerminal({
        workspaceId: "ws-test",
        cwd: realpathSync(tmpdir()),
      }),
    );
    session.setActivity("working");

    session.send({ type: "input", data });

    expect(session.getActivity()).toMatchObject({ state: "working" });
  });
});

// The escaping tests above assert the command line we generate. This one runs
// it: a real cmd.exe launches a real .cmd shim, which echoes the argv it was
// handed. It is the only check that proves cmd.exe's tokenizer reconstructs
// the prompt instead of executing part of it, which is the failure the
// escaping exists to prevent (the CVE-2024-27980 class).
describe.runIf(isPlatform("win32"))(".cmd shim argv round-trip on Windows", () => {
  const argvMarker = "__PASEO_ARGV__";

  function writeArgvEchoShim(): { dir: string; cmdPath: string } {
    const dir = mkdtempSync(join(tmpdir(), "paseo-cmd-shim-"));
    temporaryDirs.push(dir);
    const cmdPath = join(dir, "echoargv.cmd");
    const scriptPath = join(dir, "echoargv.js");
    writeFileSync(
      scriptPath,
      `process.stdout.write(${JSON.stringify(argvMarker)} + JSON.stringify(process.argv.slice(2)) + "\\n");\n`,
    );
    writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`);
    return { dir, cmdPath };
  }

  function runCommandLine(command: string, args: string, cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const terminal = pty.spawn(command, args, { cwd, cols: 500, rows: 30 });
      let output = "";
      const dataDisposable = terminal.onData((data) => {
        output += data;
      });
      const timeout = setTimeout(() => {
        terminal.kill();
        reject(new Error("Timed out waiting for cmd.exe fixture"));
      }, 10_000);
      timeout.unref();
      terminal.onExit(({ exitCode }) => {
        clearTimeout(timeout);
        dataDisposable.dispose();
        if (exitCode !== 0) {
          reject(new Error(`cmd.exe fixture exited ${exitCode}: ${output}`));
          return;
        }
        resolve(output);
      });
    });
  }

  async function roundTrip(promptArg: string): Promise<string[]> {
    const { dir, cmdPath } = writeArgvEchoShim();
    const resolved = await resolveTerminalSpawnCommand("echoargv", [promptArg], {
      platform: "win32",
      env: process.env,
      resolveExecutable: async () => cmdPath,
    });
    if (typeof resolved.args !== "string") {
      throw new Error(`expected a cmd.exe command line, got ${JSON.stringify(resolved.args)}`);
    }
    const output = await runCommandLine(resolved.command, resolved.args, dir);
    const cleanOutput = stripVTControlCharacters(output);
    const markerIndex = cleanOutput.lastIndexOf(argvMarker);
    if (markerIndex === -1) {
      throw new Error(`expected argv marker, got ${output}`);
    }
    const argvJson = cleanOutput.slice(markerIndex + argvMarker.length).split(/\r?\n/, 1)[0];
    const argv: unknown = JSON.parse(argvJson);
    if (!Array.isArray(argv) || !argv.every((arg) => typeof arg === "string")) {
      throw new Error(`expected string argv, got ${output}`);
    }
    return argv;
  }

  it("passes cmd.exe metacharacters through as literal text", async () => {
    expect(await roundTrip("a & b | c")).toEqual(["a & b | c"]);
    expect(await roundTrip("100% done %PATH%")).toEqual(["100% done %PATH%"]);
    expect(await roundTrip("a^b")).toEqual(["a^b"]);
    expect(await roundTrip('say "hi"')).toEqual(['say "hi"']);
    expect(await roundTrip("c:\\path\\to\\thing")).toEqual(["c:\\path\\to\\thing"]);
  });

  it("does not let a metacharacter start a second command", async () => {
    expect(await roundTrip("safe & echo pwned")).toEqual(["safe & echo pwned"]);
  });

  it("normalizes newlines to spaces rather than splitting the command", async () => {
    expect(await roundTrip("first\nsecond")).toEqual(["first second"]);
  });
});
