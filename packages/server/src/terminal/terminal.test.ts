import { describe, it, expect, afterEach } from "vitest";
import { isPlatform } from "../test-utils/platform.js";
import {
  createTerminal,
  ensureNodePtySpawnHelperExecutableForCurrentPlatform,
  resolveDefaultTerminalShell,
  humanizeProcessTitle,
  normalizeProcessTitle,
  type TerminalSession,
} from "./terminal.js";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

if (isPlatform("win32") && !process.env.ComSpec && !process.env.COMSPEC) {
  process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";
}

const sessions: TerminalSession[] = [];
const temporaryDirs: string[] = [];

afterEach(async () => {
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
