import { it, expect, afterEach } from "vitest";
import { isPlatform } from "../test-utils/platform.js";
import { createTerminalManager, type TerminalManager } from "./terminal-manager.js";
import type { TerminalWorkspaceContributionChangedEvent } from "./terminal-manager.js";
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
    for (const terminal of terminalsByCwd.flat()) {
      await manager.killTerminalAndWait(terminal.id);
    }
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
  const created = await manager.createTerminal({ cwd, workspaceId: "ws-test" });
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
  const tmpTerminals = [await manager.createTerminal({ cwd: firstCwd, workspaceId: "ws-test" })];
  const homeTerminals = [await manager.createTerminal({ cwd: secondCwd, workspaceId: "ws-test" })];

  expect(tmpTerminals.length).toBe(1);
  expect(homeTerminals.length).toBe(1);
  expect(tmpTerminals[0].id).not.toBe(homeTerminals[0].id);
});

it("lists subdirectory terminals when querying the workspace root", async () => {
  manager = createTerminalManager();
  const rootCwd = mkdtempSync(join(tmpdir(), "terminal-manager-subdir-root-"));
  const subdirCwd = join(rootCwd, "apps", "mobile");
  mkdirSync(subdirCwd, { recursive: true });
  temporaryDirs.push(rootCwd);

  const created = await manager.createTerminal({
    cwd: subdirCwd,
    name: "Mobile",
    workspaceId: "ws-test",
  });

  const rootTerminals = await manager.getTerminals(rootCwd);
  expect(rootTerminals.map((terminal) => terminal.id)).toEqual([created.id]);
});

it("includes only stamped terminals in workspace-scoped queries", async () => {
  manager = createTerminalManager();
  const cwd = realpathSync(tmpdir());
  const legacy = await manager.createTerminal({ cwd, workspaceId: "ws-test" });
  const owned = await manager.createTerminal({ cwd, workspaceId: "ws-owned" });
  const sibling = await manager.createTerminal({ cwd, workspaceId: "ws-sibling" });

  const scoped = await manager.getTerminals(cwd, { workspaceId: "ws-owned" });
  const unscoped = await manager.getTerminals(cwd);

  expect(scoped.map((terminal) => terminal.id)).toEqual([owned.id]);
  expect(unscoped.map((terminal) => terminal.id)).toEqual([legacy.id, owned.id, sibling.id]);
});

it("creates additional terminal with auto-incrementing name", async () => {
  manager = createTerminalManager();
  const cwd = realpathSync(tmpdir());
  await manager.createTerminal({ cwd, workspaceId: "ws-test" });
  const second = await manager.createTerminal({ cwd, workspaceId: "ws-test" });

  expect(second.name).toBe("Terminal 2");

  const terminals = await manager.getTerminals(cwd);
  expect(terminals.length).toBe(2);
});

it("uses custom name when provided", async () => {
  manager = createTerminalManager();
  const session = await manager.createTerminal({
    cwd: realpathSync(tmpdir()),
    name: "Dev Server",
    workspaceId: "ws-test",
  });

  expect(session.name).toBe("Dev Server");
});

it("creates first terminal if none exist", async () => {
  manager = createTerminalManager();
  const cwd = realpathSync(tmpdir());
  const session = await manager.createTerminal({ cwd, workspaceId: "ws-test" });

  expect(session.name).toBe("Terminal 1");

  const terminals = await manager.getTerminals(cwd);
  expect(terminals.length).toBe(1);
  expect(terminals[0].id).toBe(session.id);
});

it("throws for relative paths", async () => {
  manager = createTerminalManager();
  await expect(manager.createTerminal({ cwd: "tmp", workspaceId: "ws-test" })).rejects.toThrow(
    "cwd must be absolute path",
  );
});

it("does not reject Windows absolute paths as relative", async () => {
  manager = createTerminalManager();
  const cwd = mkdtempSync(join(tmpdir(), "terminal-manager-absolute-path-"));
  temporaryDirs.push(cwd);

  try {
    await manager.createTerminal({ cwd, workspaceId: "ws-test" });
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
    workspaceId: "ws-test",
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
    workspaceId: "ws-test",
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
  const session = await manager.createTerminal({
    cwd: realpathSync(tmpdir()),
    workspaceId: "ws-test",
  });
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
  const session = await manager.createTerminal({
    cwd: realpathSync(tmpdir()),
    workspaceId: "ws-test",
  });
  const id = session.id;

  manager.killTerminal(id);

  expect(manager.getTerminal(id)).toBeUndefined();
});

it("removes cwd entry when last terminal is killed", async () => {
  manager = createTerminalManager();
  const cwd = realpathSync(tmpdir());
  const created = await manager.createTerminal({ cwd, workspaceId: "ws-test" });
  manager.killTerminal(created.id);

  const remaining = await manager.getTerminals(cwd);
  expect(remaining).toHaveLength(0);
  expect(manager.listDirectories()).not.toContain(cwd);
});

it("keeps cwd entry when other terminals remain", async () => {
  manager = createTerminalManager();
  const cwd = realpathSync(tmpdir());
  await manager.createTerminal({ cwd, workspaceId: "ws-test" });
  const second = await manager.createTerminal({ cwd, workspaceId: "ws-test" });

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
  const session = await manager.createTerminal({ cwd, workspaceId: "ws-test" });
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
  await manager.createTerminal({ cwd: firstCwd, workspaceId: "ws-test" });
  await manager.createTerminal({ cwd: secondCwd, workspaceId: "ws-test" });

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
  const tmpSession = await manager.createTerminal({ cwd: firstCwd, workspaceId: "ws-test" });
  const homeSession = await manager.createTerminal({ cwd: secondCwd, workspaceId: "ws-test" });
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
  const snapshots: Array<{ cwd: string; terminals: Array<{ name: string }> }> = [];
  const unsubscribe = manager.subscribeTerminalsChanged((input) => {
    snapshots.push({
      cwd: input.cwd,
      terminals: input.terminals.map((terminal) => ({
        name: terminal.name,
      })),
    });
  });

  await manager.createTerminal({ cwd, workspaceId: "ws-test" });
  await manager.createTerminal({ cwd, name: "Dev Server", workspaceId: "ws-test" });

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
    workspaceId: "ws-test",
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

  const session = await manager.createTerminal({ cwd, workspaceId: "ws-test" });
  manager.killTerminal(session.id);

  expect(snapshots).toContainEqual({
    cwd,
    terminalCount: 0,
  });

  unsubscribe();
});

it("setTerminalTitle returns false for unknown terminal ids without changing existing terminals", async () => {
  manager = createTerminalManager();
  const session = await manager.createTerminal({
    workspaceId: "ws-test",
    cwd: realpathSync(tmpdir()),
    title: "Existing title",
  });
  const snapshots: Array<Array<{ id: string; title?: string }>> = [];
  const unsubscribe = manager.subscribeTerminalsChanged((input) => {
    snapshots.push(
      input.terminals.map((terminal) => ({
        id: terminal.id,
        ...(terminal.title ? { title: terminal.title } : {}),
      })),
    );
  });

  expect(manager.setTerminalTitle("unknown-id", "x")).toBe(false);
  expect(session.getTitle()).toBe("Existing title");
  expect(session.getState().title).toBe("Existing title");
  expect(snapshots).toEqual([]);

  unsubscribe();
});

it("setTerminalTitle returns true and updates the terminal title for existing terminals", async () => {
  manager = createTerminalManager();
  const session = await manager.createTerminal({
    cwd: realpathSync(tmpdir()),
    workspaceId: "ws-test",
  });

  expect(manager.setTerminalTitle(session.id, "x")).toBe(true);
  expect(session.getTitle()).toBe("x");
});

it("new terminal starts with unknown activity", async () => {
  manager = createTerminalManager();
  const session = await manager.createTerminal({
    cwd: realpathSync(tmpdir()),
    workspaceId: "ws-test",
  });

  expect(session.getActivity()).toBeNull();
});

it("includes nullable activity in terminals-changed snapshot items", async () => {
  manager = createTerminalManager();
  const cwd = realpathSync(tmpdir());
  const snapshots: Array<{ id: string; activityState: string | null }[]> = [];
  const unsubscribe = manager.subscribeTerminalsChanged((input) => {
    snapshots.push(
      input.terminals.map((terminal) => ({
        id: terminal.id,
        activityState: terminal.activity?.state ?? null,
      })),
    );
  });

  const session = await manager.createTerminal({ cwd, workspaceId: "ws-test" });

  expect(snapshots.length).toBeGreaterThan(0);
  const lastSnapshot = snapshots[snapshots.length - 1];
  expect(lastSnapshot?.find((t) => t.id === session.id)?.activityState).toBeNull();

  unsubscribe();
});

it("setTerminalActivity returns true and emits terminals-changed", async () => {
  manager = createTerminalManager();
  const cwd = realpathSync(tmpdir());
  interface ActivityEntry {
    id: string;
    state: string | null;
  }
  const snapshots: ActivityEntry[][] = [];
  const unsubscribe = manager.subscribeTerminalsChanged((input) => {
    snapshots.push(
      input.terminals.map((terminal) => ({
        id: terminal.id,
        state: terminal.activity?.state ?? null,
      })),
    );
  });

  const session = await manager.createTerminal({ cwd, workspaceId: "ws-test" });
  await expect(manager.setTerminalActivity(session.id, "working")).resolves.toBe(true);

  const hasWorkingActivity = (entries: ActivityEntry[]) =>
    entries.some((e) => e.id === session.id && e.state === "working");

  expect(snapshots.some(hasWorkingActivity)).toBe(true);

  unsubscribe();
});

it("clearTerminalAttention returns attention terminals to idle", async () => {
  manager = createTerminalManager();
  const cwd = realpathSync(tmpdir());
  interface ActivityEntry {
    id: string;
    state: string | null;
  }
  const snapshots: ActivityEntry[][] = [];
  const unsubscribe = manager.subscribeTerminalsChanged((input) => {
    snapshots.push(
      input.terminals.map((terminal) => ({
        id: terminal.id,
        state: terminal.activity?.state ?? null,
      })),
    );
  });

  const session = await manager.createTerminal({ cwd, workspaceId: "ws-test" });
  await manager.setTerminalActivity(session.id, "attention");

  await expect(manager.clearTerminalAttention(session.id)).resolves.toBe(true);

  expect(session.getActivity()?.state).toBe("idle");
  expect(
    snapshots.some((entries) =>
      entries.some((entry) => entry.id === session.id && entry.state === "idle"),
    ),
  ).toBe(true);

  unsubscribe();
});

it("clearTerminalAttention leaves non-attention terminals unchanged", async () => {
  manager = createTerminalManager();
  const session = await manager.createTerminal({
    cwd: realpathSync(tmpdir()),
    workspaceId: "ws-test",
  });
  await manager.setTerminalActivity(session.id, "working");

  await expect(manager.clearTerminalAttention(session.id)).resolves.toBe(false);

  expect(session.getActivity()?.state).toBe("working");
});

it("emits workspace contribution event when activity bucket changes", async () => {
  manager = createTerminalManager();
  const cwd = realpathSync(tmpdir());
  const events: TerminalWorkspaceContributionChangedEvent[] = [];
  const unsubscribe = manager.subscribeTerminalWorkspaceContributionChanged((event) => {
    events.push(event);
  });

  const session = await manager.createTerminal({ cwd, workspaceId: "ws-test" });
  await manager.setTerminalActivity(session.id, "working");

  expect(events).toEqual([
    {
      terminalId: session.id,
      cwd,
      workspaceId: "ws-test",
    },
  ]);

  unsubscribe();
});

it("does not emit workspace contribution event for title-only changes", async () => {
  manager = createTerminalManager();
  const cwd = realpathSync(tmpdir());
  const events: TerminalWorkspaceContributionChangedEvent[] = [];
  const unsubscribe = manager.subscribeTerminalWorkspaceContributionChanged((event) => {
    events.push(event);
  });

  const session = await manager.createTerminal({ cwd, workspaceId: "ws-test" });
  manager.setTerminalTitle(session.id, "New title");

  expect(events).toEqual([]);

  unsubscribe();
});

it("emits workspace contribution event when a contributing terminal is removed", async () => {
  manager = createTerminalManager();
  const cwd = realpathSync(tmpdir());
  const events: TerminalWorkspaceContributionChangedEvent[] = [];
  const unsubscribe = manager.subscribeTerminalWorkspaceContributionChanged((event) => {
    events.push(event);
  });

  const session = await manager.createTerminal({ cwd, workspaceId: "ws-test" });
  await manager.setTerminalActivity(session.id, "working");
  events.length = 0;
  manager.killTerminal(session.id);

  expect(events).toEqual([
    {
      terminalId: session.id,
      cwd,
      workspaceId: "ws-test",
    },
  ]);

  unsubscribe();
});

it("does not emit workspace contribution event when an idle terminal is removed", async () => {
  manager = createTerminalManager();
  const cwd = realpathSync(tmpdir());
  const events: TerminalWorkspaceContributionChangedEvent[] = [];
  const unsubscribe = manager.subscribeTerminalWorkspaceContributionChanged((event) => {
    events.push(event);
  });

  const session = await manager.createTerminal({ cwd, workspaceId: "ws-test" });
  manager.killTerminal(session.id);

  expect(events).toEqual([]);

  unsubscribe();
});
