import { it, expect, afterEach } from "vitest";
import { isPlatform } from "../test-utils/platform.js";
import { createTerminalManager, type TerminalManager } from "./terminal-manager.js";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

if (isPlatform("win32") && !process.env.ComSpec && !process.env.COMSPEC) {
  process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 25,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

let manager: TerminalManager;
const temporaryDirs: string[] = [];

afterEach(async () => {
  if (manager) {
    const terminalsByCwd = await Promise.all(
      manager.listDirectories().map((cwd) => manager.getTerminals(cwd)),
    );
    await Promise.all(
      terminalsByCwd
        .flat()
        .map((terminal) =>
          manager.killTerminalAndWait(terminal.id, { gracefulTimeoutMs: 50, forceTimeoutMs: 50 }),
        ),
    );
    manager.killAll();
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EBUSY") {
          throw error;
        }
      }
    }
  }
});

it("returns empty list for new cwd", async () => {
  manager = createTerminalManager();
  const cwd = realpathSync(tmpdir());
  const terminals = await manager.getTerminals(cwd);

  expect(terminals).toHaveLength(0);
});

it("returns existing terminals on subsequent calls", async () => {
  manager = createTerminalManager();
  const cwd = realpathSync(tmpdir());
  const created = await manager.createTerminal({ cwd });
  const first = await manager.getTerminals(cwd);
  const second = await manager.getTerminals(cwd);

  expect(first.length).toBe(1);
  expect(first[0].id).toBe(created.id);
  expect(second.length).toBe(1);
});

it("throws for relative paths", async () => {
  manager = createTerminalManager();
  await expect(manager.getTerminals("tmp")).rejects.toThrow("cwd must be absolute path");
});

it("accepts Windows absolute paths", async () => {
  manager = createTerminalManager();
  await expect(manager.getTerminals("C:\\Users\\foo\\project")).resolves.not.toThrow();
  await expect(manager.getTerminals("D:\\MyProject")).resolves.not.toThrow();
});

it("creates separate terminals for different cwds", async () => {
  manager = createTerminalManager();
  const firstCwd = mkdtempSync(join(tmpdir(), "terminal-manager-first-"));
  const secondCwd = mkdtempSync(join(tmpdir(), "terminal-manager-second-"));
  temporaryDirs.push(firstCwd, secondCwd);
  const tmpTerminals = [await manager.createTerminal({ cwd: firstCwd })];
  const homeTerminals = [await manager.createTerminal({ cwd: secondCwd })];

  expect(tmpTerminals.length).toBe(1);
  expect(homeTerminals.length).toBe(1);
  expect(tmpTerminals[0].id).not.toBe(homeTerminals[0].id);
});

it("creates additional terminal with auto-incrementing name", async () => {
  manager = createTerminalManager();
  const cwd = realpathSync(tmpdir());
  await manager.createTerminal({ cwd });
  const second = await manager.createTerminal({ cwd });

  expect(second.name).toBe("Terminal 2");

  const terminals = await manager.getTerminals(cwd);
  expect(terminals.length).toBe(2);
});

it("uses custom name when provided", async () => {
  manager = createTerminalManager();
  const session = await manager.createTerminal({ cwd: realpathSync(tmpdir()), name: "Dev Server" });

  expect(session.name).toBe("Dev Server");
});

it("creates first terminal if none exist", async () => {
  manager = createTerminalManager();
  const cwd = realpathSync(tmpdir());
  const session = await manager.createTerminal({ cwd });

  expect(session.name).toBe("Terminal 1");

  const terminals = await manager.getTerminals(cwd);
  expect(terminals.length).toBe(1);
  expect(terminals[0].id).toBe(session.id);
});

it("throws for relative paths", async () => {
  manager = createTerminalManager();
  await expect(manager.createTerminal({ cwd: "tmp" })).rejects.toThrow("cwd must be absolute path");
});

it("does not reject Windows absolute paths as relative", async () => {
  manager = createTerminalManager();
  const cwd = mkdtempSync(join(tmpdir(), "terminal-manager-absolute-path-"));
  temporaryDirs.push(cwd);

  try {
    await manager.createTerminal({ cwd });
  } catch (error) {
    expect((error as Error).message).not.toBe("cwd must be absolute path");
  }
});

it("inherits registered env for the worktree root cwd", async () => {
  manager = createTerminalManager();
  const cwd = mkdtempSync(join(tmpdir(), "terminal-manager-env-root-"));
  temporaryDirs.push(cwd);
  const markerPath = join(cwd, "root-port.txt");

  manager.registerCwdEnv({
    cwd,
    env: { PASEO_WORKTREE_PORT: "45678" },
  });
  await manager.createTerminal({
    cwd,
    command: process.execPath,
    args: [
      "-e",
      `require('fs').writeFileSync(${JSON.stringify(markerPath)}, process.env.PASEO_WORKTREE_PORT ?? '')`,
    ],
  });

  await waitForCondition(() => existsSync(markerPath), 10000);
  expect(readFileSync(markerPath, "utf8")).toBe("45678");
});

it("inherits registered env for subdirectories within the worktree", async () => {
  manager = createTerminalManager();
  const rootCwd = mkdtempSync(join(tmpdir(), "terminal-manager-env-subdir-"));
  const subdirCwd = join(rootCwd, "packages", "app");
  mkdirSync(subdirCwd, { recursive: true });
  temporaryDirs.push(rootCwd);
  const markerPath = join(subdirCwd, "subdir-port.txt");

  manager.registerCwdEnv({
    cwd: rootCwd,
    env: { PASEO_WORKTREE_PORT: "45679" },
  });
  await manager.createTerminal({
    cwd: subdirCwd,
    command: process.execPath,
    args: [
      "-e",
      `require('fs').writeFileSync(${JSON.stringify(markerPath)}, process.env.PASEO_WORKTREE_PORT ?? '')`,
    ],
  });

  await waitForCondition(() => existsSync(markerPath), 10000);
  expect(readFileSync(markerPath, "utf8")).toBe("45679");
});

it("returns terminal by id", async () => {
  manager = createTerminalManager();
  const session = await manager.createTerminal({ cwd: realpathSync(tmpdir()) });
  const found = manager.getTerminal(session.id);

  expect(found).toBe(session);
});

it("returns undefined for unknown id", () => {
  manager = createTerminalManager();
  const found = manager.getTerminal("unknown-id");

  expect(found).toBeUndefined();
});

it("removes terminal from manager", async () => {
  manager = createTerminalManager();
  const session = await manager.createTerminal({ cwd: realpathSync(tmpdir()) });
  const id = session.id;

  manager.killTerminal(id);

  expect(manager.getTerminal(id)).toBeUndefined();
});

it("removes cwd entry when last terminal is killed", async () => {
  manager = createTerminalManager();
  const cwd = realpathSync(tmpdir());
  const created = await manager.createTerminal({ cwd });
  manager.killTerminal(created.id);

  const remaining = await manager.getTerminals(cwd);
  expect(remaining).toHaveLength(0);
  expect(manager.listDirectories()).not.toContain(cwd);
});

it("keeps cwd entry when other terminals remain", async () => {
  manager = createTerminalManager();
  const cwd = realpathSync(tmpdir());
  await manager.createTerminal({ cwd });
  const second = await manager.createTerminal({ cwd });

  const terminals = await manager.getTerminals(cwd);
  manager.killTerminal(terminals[0].id);

  expect(manager.listDirectories()).toContain(cwd);
  const remaining = await manager.getTerminals(cwd);
  expect(remaining.length).toBe(1);
  expect(remaining[0].id).toBe(second.id);
});

it("is no-op for unknown id", () => {
  manager = createTerminalManager();
  expect(() => manager.killTerminal("unknown-id")).not.toThrow();
});

it("auto-removes terminal when shell exits", async () => {
  manager = createTerminalManager();
  const cwd = realpathSync(tmpdir());
  const session = await manager.createTerminal({ cwd });
  const exitedId = session.id;
  session.kill();

  await waitForCondition(() => manager.getTerminal(exitedId) === undefined, 10000);

  expect(manager.getTerminal(exitedId)).toBeUndefined();

  const remaining = await manager.getTerminals(cwd);
  expect(remaining).toHaveLength(0);
});

it("returns empty array initially", () => {
  manager = createTerminalManager();
  expect(manager.listDirectories()).toEqual([]);
});

it("returns all cwds with active terminals", async () => {
  manager = createTerminalManager();
  const firstCwd = mkdtempSync(join(tmpdir(), "terminal-manager-list-first-"));
  const secondCwd = mkdtempSync(join(tmpdir(), "terminal-manager-list-second-"));
  temporaryDirs.push(firstCwd, secondCwd);
  await manager.createTerminal({ cwd: firstCwd });
  await manager.createTerminal({ cwd: secondCwd });

  const dirs = manager.listDirectories();
  expect(dirs).toContain(firstCwd);
  expect(dirs).toContain(secondCwd);
  expect(dirs.length).toBe(2);
});

it("kills all terminals and clears state", async () => {
  manager = createTerminalManager();
  const firstCwd = mkdtempSync(join(tmpdir(), "terminal-manager-kill-first-"));
  const secondCwd = mkdtempSync(join(tmpdir(), "terminal-manager-kill-second-"));
  temporaryDirs.push(firstCwd, secondCwd);
  const tmpSession = await manager.createTerminal({ cwd: firstCwd });
  const homeSession = await manager.createTerminal({ cwd: secondCwd });
  const tmpId = tmpSession.id;
  const homeId = homeSession.id;

  manager.killAll();

  expect(manager.listDirectories()).toEqual([]);
  expect(manager.getTerminal(tmpId)).toBeUndefined();
  expect(manager.getTerminal(homeId)).toBeUndefined();
});

it("emits cwd snapshots when terminals are created", async () => {
  manager = createTerminalManager();
  const cwd = realpathSync(tmpdir());
  const snapshots: Array<{ cwd: string; terminals: Array<{ name: string; title?: string }> }> = [];
  const unsubscribe = manager.subscribeTerminalsChanged((input) => {
    snapshots.push({
      cwd: input.cwd,
      terminals: input.terminals.map((terminal) => ({
        name: terminal.name,
        ...(terminal.title ? { title: terminal.title } : {}),
      })),
    });
  });

  await manager.createTerminal({ cwd });
  await manager.createTerminal({ cwd, name: "Dev Server" });

  expect(snapshots).toContainEqual({
    cwd,
    terminals: [{ name: "Terminal 1" }],
  });
  expect(snapshots).toContainEqual({
    cwd,
    terminals: [{ name: "Terminal 1" }, { name: "Dev Server" }],
  });

  unsubscribe();
});

interface TerminalTitleEntry {
  id: string;
  title?: string;
}

function toTitleEntry(terminal: { id: string; title?: string }): TerminalTitleEntry {
  return {
    id: terminal.id,
    ...(terminal.title ? { title: terminal.title } : {}),
  };
}

function hasLogsTitle(sessionId: string) {
  const matches = (terminal: TerminalTitleEntry) =>
    terminal.id === sessionId && terminal.title === "Logs";
  return (snapshot: TerminalTitleEntry[]) => snapshot.some(matches);
}

it("emits updated terminal titles after debounced title changes", async () => {
  manager = createTerminalManager();
  const snapshots: TerminalTitleEntry[][] = [];
  const unsubscribe = manager.subscribeTerminalsChanged((input) => {
    snapshots.push(input.terminals.map(toTitleEntry));
  });

  const session = await manager.createTerminal({
    cwd: realpathSync(tmpdir()),
    command: process.execPath,
    args: ["-e", "process.stdout.write('\\x1b]0;Logs\\x07'); setTimeout(() => {}, 10000);"],
  });

  await waitForCondition(() => snapshots.some(hasLogsTitle(session.id)), 10000);

  unsubscribe();
}, 10000);

it("emits empty snapshot when last terminal is removed", async () => {
  manager = createTerminalManager();
  const cwd = realpathSync(tmpdir());
  const snapshots: Array<{ cwd: string; terminalCount: number }> = [];
  const unsubscribe = manager.subscribeTerminalsChanged((input) => {
    snapshots.push({
      cwd: input.cwd,
      terminalCount: input.terminals.length,
    });
  });

  const session = await manager.createTerminal({ cwd });
  manager.killTerminal(session.id);

  expect(snapshots).toContainEqual({
    cwd,
    terminalCount: 0,
  });

  unsubscribe();
});
