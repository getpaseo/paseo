// POSIX-only: node-pty + POSIX shell assertions
/* eslint-disable max-nested-callbacks */
import { describe, it, expect, afterEach } from "vitest";
import { isPlatform } from "../test-utils/platform.js";
import {
  buildTerminalEnvironment,
  createTerminal,
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
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const hasZsh = existsSync("/bin/zsh");

if (isPlatform("win32") && !process.env.ComSpec && !process.env.COMSPEC) {
  process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";
}

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

const sessions: TerminalSession[] = [];

const temporaryDirs: string[] = [];

afterEach(async () => {
  for (const session of sessions) {
    await session.killAndWait();
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

const DA_HELPER_SCRIPT = `process.stdin.setRawMode(true);
process.stdin.resume();
let buf = "";
const timer = setTimeout(() => {
  process.stdout.write("DA_TIMEOUT\\n");
  process.exit(2);
}, 2500);
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("binary");
  const m = buf.match(/\\x1b\\[\\?[\\d;]+c/);
  if (m) {
    clearTimeout(timer);
    process.stdout.write("DA_OK:" + m[0].slice(1) + "\\n");
    process.exit(0);
  }
});
process.stdout.write("\\x1b[c");
`;

const DSR_HELPER_SCRIPT = `process.stdin.setRawMode(true);
process.stdin.resume();
const mode = process.argv[2] || "cursor";
const query = mode === "private-cursor" ? "\\x1b[?6n" : mode === "status" ? "\\x1b[5n" : "\\x1b[6n";
const pattern = mode === "private-cursor" ? /\\x1b\\[\\?(\\d+);(\\d+)R/ : mode === "status" ? /\\x1b\\[0n/ : /\\x1b\\[(\\d+);(\\d+)R/;
let buf = "";
const timer = setTimeout(() => {
  process.stdout.write("DSR_TIMEOUT\\n");
  process.exit(2);
}, 2500);
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("binary");
  const match = buf.match(pattern);
  if (!match) {
    return;
  }
  clearTimeout(timer);
  if (mode === "status") {
    process.stdout.write("DSR_OK:status\\n");
  } else {
    process.stdout.write("DSR_OK:" + match[1] + ":" + match[2] + "\\n");
  }
  process.exit(0);
});
process.stdout.write(query);
`;

function writeDaHelper(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirs.push(dir);
  const path = join(dir, "helper.cjs");
  writeFileSync(path, DA_HELPER_SCRIPT);
  return path;
}

function writeDsrHelper(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirs.push(dir);
  const path = join(dir, "helper.cjs");
  writeFileSync(path, DSR_HELPER_SCRIPT);
  return path;
}

function isDaOkLine(line: string): boolean {
  return line.startsWith("DA_OK:");
}

function isDsrOkLine(line: string): boolean {
  return line.startsWith("DSR_OK:");
}

function hasDaOkLine(state: ReturnType<TerminalSession["getState"]>): boolean {
  return getLines(state).some(isDaOkLine);
}

function hasDsrOkLine(state: ReturnType<TerminalSession["getState"]>): boolean {
  return getLines(state).some(isDsrOkLine);
}

function lastNonEmptyLineIsPrompt(state: ReturnType<TerminalSession["getState"]>): boolean {
  const last =
    getLines(state)
      .toReversed()
      .find((line) => line.length > 0) ?? "";
  return last === "$";
}

describe.skipIf(isPlatform("win32"))("terminal POSIX-only", () => {
  it("sets zsh wrapper env when spawning zsh", () => {
    const resolvedEnv = buildTerminalEnvironment({
      shell: "/bin/zsh",
      env: {
        HOME: "/tmp/paseo-home",
        ZDOTDIR: "/tmp/paseo-zdotdir",
      },
    });

    expect(resolvedEnv.TERM).toBe("xterm-256color");
    expect(resolvedEnv.PASEO_ZSH_ZDOTDIR).toBe("/tmp/paseo-zdotdir");
    expect(resolvedEnv.ZDOTDIR).not.toBe("/tmp/paseo-zdotdir");
    expect(existsSync(join(resolvedEnv.ZDOTDIR, ".zshenv"))).toBe(true);
    expect(existsSync(join(resolvedEnv.ZDOTDIR, "paseo-integration.zsh"))).toBe(true);
  });

  describe("send input", () => {
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

    it("executes multiple commands sequentially", async () => {
      const session = trackSession(
        await createTerminal({
          cwd: "/tmp",
          shell: "/bin/sh",
          env: { PS1: "$ " },
        }),
      );

      await waitForLines(session, ["$"]);

      session.send({ type: "input", data: "echo first\r" });
      await waitForLines(session, ["$ echo first", "first", "$"]);

      session.send({ type: "input", data: "echo second\r" });
      await waitForLines(session, ["$ echo first", "first", "$ echo second", "second", "$"]);

      const state = session.getState();
      expect(getRowText(state, 0)).toBe("$ echo first");
      expect(getRowText(state, 1)).toBe("first");
      expect(getRowText(state, 2)).toBe("$ echo second");
      expect(getRowText(state, 3)).toBe("second");
      expect(getRowText(state, 4)).toBe("$");
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

  describe("terminal title", () => {
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
  });

  describe("colors", () => {
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

    it("captures 256 color codes (mode 2)", async () => {
      const session = trackSession(
        await createTerminal({
          cwd: "/tmp",
          shell: "/bin/sh",
          env: { PS1: "$ ", TERM: "xterm-256color" },
        }),
      );

      await waitForLines(session, ["$"]);

      // \033[38;5;208m = 256-color orange (color 208)
      session.send({ type: "input", data: "printf '\\033[38;5;208mORG\\033[0m'\r" });

      await waitForLines(session, ["$ printf '\\033[38;5;208mORG\\033[0m'", "ORG$"]);

      const state = session.getState();
      const outputRow = state.grid[1];

      // Check O cell
      expect(outputRow[0].char).toBe("O");
      expect(outputRow[0].fg).toBe(208); // 256-color index
      expect(outputRow[0].fgMode).toBe(2); // Mode 2 = 256 colors
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

  describe("subscribe", () => {
    it("receives a snapshot on initial subscription", async () => {
      const session = trackSession(
        await createTerminal({
          cwd: realpathSync(tmpdir()),
        }),
      );

      const messages: Array<{ type: string }> = [];
      const unsubscribe = session.subscribe((msg) => {
        messages.push(msg);
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(messages.length).toBeGreaterThan(0);
      expect(messages[0].type).toBe("snapshot");

      unsubscribe();
    });

    it("receives output messages on updates without replay snapshots", async () => {
      const session = trackSession(
        await createTerminal({
          cwd: "/tmp",
          shell: "/bin/sh",
          env: { PS1: "$ " },
        }),
      );

      await waitForLines(session, ["$"]);

      const messages: Array<{ type: string }> = [];
      const unsubscribe = session.subscribe((msg) => {
        messages.push(msg);
      });

      await new Promise((resolve) => setTimeout(resolve, 100));
      messages.length = 0;

      session.send({ type: "input", data: "echo test\r" });

      await waitForLines(session, ["$ echo test", "test", "$"]);

      expect(messages.some((message) => message.type === "output")).toBe(true);
      expect(messages.some((message) => message.type === "snapshot")).toBe(false);

      unsubscribe();
    });

    it("does not emit snapshot messages for resize-only updates", async () => {
      const session = trackSession(
        await createTerminal({
          cwd: "/tmp",
          shell: "/bin/sh",
          env: { PS1: "$ " },
          rows: 24,
          cols: 80,
        }),
      );

      const messages: Array<{ type: string }> = [];
      const unsubscribe = session.subscribe((msg) => {
        messages.push(msg);
      });

      await new Promise((resolve) => setTimeout(resolve, 100));
      messages.length = 0;

      session.send({ type: "resize", rows: 30, cols: 100 });
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(messages.some((message) => message.type === "snapshot")).toBe(false);
      expect(session.getSize()).toEqual({ rows: 30, cols: 100 });

      unsubscribe();
    });

    it("emits output only after getState reflects the new data", async () => {
      const session = trackSession(
        await createTerminal({
          cwd: "/tmp",
          shell: "/bin/sh",
          env: { PS1: "$ " },
        }),
      );

      await waitForLines(session, ["$"]);
      const outputSeenInState = new Promise<boolean>((resolve) => {
        const unsubscribe = session.subscribe((message) => {
          if (message.type !== "output" || !message.data.includes("state-after-output")) {
            return;
          }
          unsubscribe();
          const stateText = getLines(session.getState()).join("\n");
          resolve(stateText.includes("state-after-output"));
        });
      });

      session.send({ type: "input", data: "echo state-after-output\r" });
      expect(await outputSeenInState).toBe(true);
    });

    it("unsubscribe stops receiving messages", async () => {
      const session = trackSession(
        await createTerminal({
          cwd: "/tmp",
          shell: "/bin/sh",
          env: { PS1: "$ " },
        }),
      );

      await waitForLines(session, ["$"]);

      const messages: Array<{ type: string }> = [];
      const unsubscribe = session.subscribe((msg) => {
        messages.push(msg);
      });

      unsubscribe();
      messages.length = 0;

      session.send({ type: "input", data: "echo after\r" });
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(messages.length).toBe(0);
    });
  });

  describe("terminal protocol queries", () => {
    it("delivers a DA1 reply to a foreground app on stdin", async () => {
      const helperPath = writeDaHelper("terminal-da-helper-");

      const session = trackSession(
        await createTerminal({
          cwd: "/tmp",
          shell: "/bin/sh",
          env: { PS1: "$ " },
        }),
      );
      await waitForLines(session, ["$"]);

      session.send({ type: "input", data: `${process.execPath} ${helperPath}\r` });
      await waitForState(session, hasDaOkLine);

      const ack = getLines(session.getState()).find(isDaOkLine) ?? "";
      expect(ack).toMatch(/^DA_OK:\[\?[\d;]+c$/);
    });

    it("does not echo DA1 replies onto the prompt after the foreground app exits", async () => {
      const helperPath = writeDaHelper("terminal-da-cleanup-");

      const session = trackSession(
        await createTerminal({
          cwd: "/tmp",
          shell: "/bin/sh",
          env: { PS1: "$ " },
        }),
      );
      await waitForLines(session, ["$"]);

      session.send({ type: "input", data: `${process.execPath} ${helperPath}\r` });
      await waitForState(session, hasDaOkLine);
      await waitForState(session, lastNonEmptyLineIsPrompt);
    });

    it("delivers public DSR cursor-position replies to a foreground app on stdin", async () => {
      const helperPath = writeDsrHelper("terminal-dsr-helper-");

      const session = trackSession(
        await createTerminal({
          cwd: "/tmp",
          shell: "/bin/sh",
          env: { PS1: "$ " },
        }),
      );
      await waitForLines(session, ["$"]);

      session.send({ type: "input", data: `${process.execPath} ${helperPath} cursor\r` });
      await waitForState(session, hasDsrOkLine);

      const ack = getLines(session.getState()).find(isDsrOkLine) ?? "";
      expect(ack).toMatch(/^DSR_OK:\d+:\d+$/);
    });

    it("delivers private DSR cursor-position replies to a foreground app on stdin", async () => {
      const helperPath = writeDsrHelper("terminal-dsr-private-helper-");

      const session = trackSession(
        await createTerminal({
          cwd: "/tmp",
          shell: "/bin/sh",
          env: { PS1: "$ " },
        }),
      );
      await waitForLines(session, ["$"]);

      session.send({ type: "input", data: `${process.execPath} ${helperPath} private-cursor\r` });
      await waitForState(session, hasDsrOkLine);

      const ack = getLines(session.getState()).find(isDsrOkLine) ?? "";
      expect(ack).toMatch(/^DSR_OK:\d+:\d+$/);
    });

    it("delivers DSR terminal-status replies to a foreground app on stdin", async () => {
      const helperPath = writeDsrHelper("terminal-dsr-status-helper-");

      const session = trackSession(
        await createTerminal({
          cwd: "/tmp",
          shell: "/bin/sh",
          env: { PS1: "$ " },
        }),
      );
      await waitForLines(session, ["$"]);

      session.send({ type: "input", data: `${process.execPath} ${helperPath} status\r` });
      await waitForState(session, hasDsrOkLine);

      const ack = getLines(session.getState()).find(isDsrOkLine) ?? "";
      expect(ack).toBe("DSR_OK:status");
    });
  });

  describe("stream snapshots", () => {
    it("streams raw output messages without replay metadata", async () => {
      const session = trackSession(
        await createTerminal({
          cwd: "/tmp",
          shell: "/bin/sh",
          env: { PS1: "$ " },
        }),
      );

      await waitForLines(session, ["$"]);

      const outputMessages: string[] = [];
      const unsubscribe = session.subscribe((message) => {
        if (message.type !== "output") {
          return;
        }
        outputMessages.push(message.data);
      });

      session.send({ type: "input", data: "echo raw-stream\r" });
      await waitForLines(session, ["$ echo raw-stream", "raw-stream", "$"]);

      expect(outputMessages.join("")).toContain("raw-stream");

      unsubscribe();
    });

    it("sends the current snapshot to a new subscriber instead of replaying raw output", async () => {
      const session = trackSession(
        await createTerminal({
          cwd: "/tmp",
          shell: "/bin/sh",
          env: { PS1: "$ " },
        }),
      );

      await waitForLines(session, ["$"]);

      session.send({ type: "input", data: "echo before-detach\r" });
      await waitForLines(session, ["$ echo before-detach", "before-detach", "$"]);

      session.send({ type: "input", data: "echo after-detach\r" });
      await waitForLines(session, [
        "$ echo before-detach",
        "before-detach",
        "$ echo after-detach",
        "after-detach",
        "$",
      ]);

      let snapshotText = "";
      const unsubscribe = session.subscribe((message) => {
        if (message.type !== "snapshot") {
          return;
        }
        snapshotText = [...message.state.scrollback, ...message.state.grid]
          .map(rowToText)
          .join("\n");
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(snapshotText).toContain("before-detach");
      expect(snapshotText).toContain("after-detach");
      unsubscribe();
    });
  });

  describe("getState", () => {
    it("returns current terminal state with grid", async () => {
      const session = trackSession(
        await createTerminal({
          cwd: "/tmp",
          shell: "/bin/sh",
          env: { PS1: "$ " },
          rows: 24,
          cols: 80,
        }),
      );

      const state = session.getState();

      expect(state.rows).toBe(24);
      expect(state.cols).toBe(80);
      expect(state.grid).toBeDefined();
      expect(state.grid.length).toBe(24);
      expect(state.grid[0].length).toBe(80);
      expect(state.cursor).toBeDefined();
      expect(typeof state.cursor.row).toBe("number");
      expect(typeof state.cursor.col).toBe("number");
    });

    it("captures cursor presentation modes emitted by terminal apps", async () => {
      const session = trackSession(
        await createTerminal({
          cwd: "/tmp",
          shell: "/bin/sh",
          env: { PS1: "$ " },
          rows: 24,
          cols: 80,
        }),
      );

      await waitForLines(session, ["$"]);
      session.send({ type: "input", data: "printf '\\033[2 q\\033[?25l'\r" });

      const state = await waitForState(
        session,
        (current) =>
          current.cursor.style === "block" &&
          current.cursor.blink === false &&
          current.cursor.hidden === true,
      );

      expect(state.cursor).toMatchObject({
        style: "block",
        blink: false,
        hidden: true,
      });
    });

    it("grid cells have char and color attributes", async () => {
      const session = trackSession(
        await createTerminal({
          cwd: "/tmp",
          shell: "/bin/sh",
          env: { PS1: "$ " },
        }),
      );

      await waitForLines(session, ["$"]);

      const state = session.getState();
      // First cell should be "$"
      expect(state.grid[0][0].char).toBe("$");
      expect(state.grid[0][0]).toHaveProperty("fg");
      expect(state.grid[0][0]).toHaveProperty("bg");
    });
  });

  describe("scrollback", () => {
    it("preserves scrollback buffer", async () => {
      const session = trackSession(
        await createTerminal({
          cwd: "/tmp",
          shell: "/bin/sh",
          env: { PS1: "$ " },
          rows: 5,
          cols: 80,
        }),
      );

      await waitForLines(session, ["$"]);

      // seq 1 20 produces 20 lines of output
      // With 5 rows, we expect lines to scroll into scrollback
      session.send({ type: "input", data: "seq 1 20\r" });

      // Wait for command to finish - final prompt appears after "20"
      // In a 5-row terminal, we'll see the last lines plus prompt
      // The visible area will show something like: 17, 18, 19, 20, $
      await waitForLines(session, ["17", "18", "19", "20", "$"]);

      const state = session.getState();

      // Scrollback should contain the earlier output
      expect(state.scrollback.length).toBeGreaterThan(0);

      const scrollbackText = state.scrollback.map(rowToText).filter((line) => line.length > 0);

      // The scrollback should contain the command and early numbers
      expect(scrollbackText).toContain("$ seq 1 20");
      expect(scrollbackText).toContain("1");
      expect(scrollbackText).toContain("2");
      expect(scrollbackText).toContain("3");
    });
  });

  describe("kill", () => {
    it("terminates the shell process", async () => {
      const session = trackSession(
        await createTerminal({
          cwd: "/tmp",
          shell: "/bin/sh",
          env: { PS1: "$ " },
        }),
      );

      await waitForLines(session, ["$"]);

      session.kill();

      // Should not throw when trying to get state after kill
      const state = session.getState();
      expect(state).toBeDefined();
    });

    it("send after kill is a no-op", async () => {
      const session = trackSession(
        await createTerminal({
          cwd: "/tmp",
          shell: "/bin/sh",
          env: { PS1: "$ " },
        }),
      );

      session.kill();

      // Should not throw
      session.send({ type: "input", data: "echo test\r" });
    });
  });
});
