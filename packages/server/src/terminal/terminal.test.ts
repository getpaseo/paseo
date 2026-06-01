import { describe, it, expect, afterEach, vi } from "vitest";
import { isPlatform } from "../test-utils/platform.js";
import {
  buildTerminalEnvironment,
  createTerminal,
  ensureNodePtySpawnHelperExecutableForCurrentPlatform,
  resolveDefaultTerminalShell,
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
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setImmediate as waitForImmediate } from "node:timers/promises";

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

afterEach(async () => {
  vi.useRealTimers();
  for (const session of sessions) {
    session.kill();
  }
  sessions.length = 0;
  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
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

  it("creates a terminal session with an id, name, and cwd", async () => {
    const session = trackSession(
      await createTerminal({
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
});

describe.skipIf(isPlatform("win32"))("send input", () => {
  it("executes a simple echo command", async () => {
    const session = trackSession(
      await createTerminal({
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
        cwd: realpathSync(tmpdir()),
      }),
    );

    // Should not throw
    session.send({ type: "mouse", row: 0, col: 0, button: 0, action: "down" });
    session.send({ type: "mouse", row: 0, col: 0, button: 0, action: "up" });
  });
});
