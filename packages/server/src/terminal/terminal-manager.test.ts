import { describe, it, expect, afterEach } from "vitest";
import { createTerminalManager, type TerminalManager } from "./terminal-manager.js";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 25
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

async function withShell<T>(shell: string, run: () => Promise<T>): Promise<T> {
  const originalShell = process.env.SHELL;
  process.env.SHELL = shell;
  try {
    return await run();
  } finally {
    if (originalShell === undefined) {
      delete process.env.SHELL;
    } else {
      process.env.SHELL = originalShell;
    }
  }
}

describe("TerminalManager", () => {
  let manager: TerminalManager;
  const temporaryDirs: string[] = [];

  afterEach(() => {
    if (manager) {
      manager.killAll();
    }
    while (temporaryDirs.length > 0) {
      const dir = temporaryDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  describe("getTerminals", () => {
    it("auto-creates first terminal for new cwd", async () => {
      manager = createTerminalManager();
      const terminals = await manager.getTerminals("/tmp");

      expect(terminals.length).toBe(1);
      expect(terminals[0].name).toBe("Terminal 1");
      expect(terminals[0].cwd).toBe("/tmp");
    });

    it("returns existing terminals on subsequent calls", async () => {
      manager = createTerminalManager();
      const first = await manager.getTerminals("/tmp");
      const second = await manager.getTerminals("/tmp");

      expect(first).toBe(second);
      expect(first.length).toBe(1);
    });

    it("throws for relative paths", async () => {
      manager = createTerminalManager();
      await expect(manager.getTerminals("tmp")).rejects.toThrow("cwd must be absolute path");
    });

    it("creates separate terminals for different cwds", async () => {
      manager = createTerminalManager();
      const tmpTerminals = await manager.getTerminals("/tmp");
      const homeTerminals = await manager.getTerminals("/home");

      expect(tmpTerminals.length).toBe(1);
      expect(homeTerminals.length).toBe(1);
      expect(tmpTerminals[0].id).not.toBe(homeTerminals[0].id);
    });
  });

  describe("createTerminal", () => {
    it("creates additional terminal with auto-incrementing name", async () => {
      manager = createTerminalManager();
      await manager.getTerminals("/tmp");
      const second = await manager.createTerminal({ cwd: "/tmp" });

      expect(second.name).toBe("Terminal 2");

      const terminals = await manager.getTerminals("/tmp");
      expect(terminals.length).toBe(2);
    });

    it("uses custom name when provided", async () => {
      manager = createTerminalManager();
      const session = await manager.createTerminal({ cwd: "/tmp", name: "Dev Server" });

      expect(session.name).toBe("Dev Server");
    });

    it("creates first terminal if none exist", async () => {
      manager = createTerminalManager();
      const session = await manager.createTerminal({ cwd: "/tmp" });

      expect(session.name).toBe("Terminal 1");

      const terminals = await manager.getTerminals("/tmp");
      expect(terminals.length).toBe(1);
      expect(terminals[0].id).toBe(session.id);
    });

    it("throws for relative paths", async () => {
      manager = createTerminalManager();
      await expect(manager.createTerminal({ cwd: "tmp" })).rejects.toThrow("cwd must be absolute path");
    });

    it("inherits registered env for the worktree root cwd", async () => {
      await withShell("/bin/sh", async () => {
        manager = createTerminalManager();
        const cwd = mkdtempSync(join(tmpdir(), "terminal-manager-env-root-"));
        temporaryDirs.push(cwd);
        const markerPath = join(cwd, "root-port.txt");

        manager.registerCwdEnv({
          cwd,
          env: { PASEO_WORKTREE_PORT: "45678" },
        });
        const session = await manager.createTerminal({ cwd });
        for (let attempt = 0; attempt < 10 && !existsSync(markerPath); attempt++) {
          session.send({
            type: "input",
            data: `printf '%s' \"$PASEO_WORKTREE_PORT\" > ${JSON.stringify(markerPath)}\r`,
          });
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        await waitForCondition(() => existsSync(markerPath), 10000);
        expect(readFileSync(markerPath, "utf8")).toBe("45678");
      });
    });

    it("inherits registered env for subdirectories within the worktree", async () => {
      await withShell("/bin/sh", async () => {
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
        const session = await manager.createTerminal({ cwd: subdirCwd });
        for (let attempt = 0; attempt < 10 && !existsSync(markerPath); attempt++) {
          session.send({
            type: "input",
            data: `printf '%s' \"$PASEO_WORKTREE_PORT\" > ${JSON.stringify(markerPath)}\r`,
          });
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        await waitForCondition(() => existsSync(markerPath), 10000);
        expect(readFileSync(markerPath, "utf8")).toBe("45679");
      });
    });
  });

  describe("getTerminal", () => {
    it("returns terminal by id", async () => {
      manager = createTerminalManager();
      const terminals = await manager.getTerminals("/tmp");
      const found = manager.getTerminal(terminals[0].id);

      expect(found).toBe(terminals[0]);
    });

    it("returns undefined for unknown id", () => {
      manager = createTerminalManager();
      const found = manager.getTerminal("unknown-id");

      expect(found).toBeUndefined();
    });
  });

  describe("killTerminal", () => {
    it("removes terminal from manager", async () => {
      manager = createTerminalManager();
      const terminals = await manager.getTerminals("/tmp");
      const id = terminals[0].id;

      manager.killTerminal(id);

      expect(manager.getTerminal(id)).toBeUndefined();
    });

    it("removes cwd entry when last terminal is killed", async () => {
      manager = createTerminalManager();
      const terminals = await manager.getTerminals("/tmp");

      manager.killTerminal(terminals[0].id);

      expect(manager.listDirectories()).not.toContain("/tmp");
    });

    it("keeps cwd entry when other terminals remain", async () => {
      manager = createTerminalManager();
      await manager.getTerminals("/tmp");
      const second = await manager.createTerminal({ cwd: "/tmp" });

      const terminals = await manager.getTerminals("/tmp");
      manager.killTerminal(terminals[0].id);

      expect(manager.listDirectories()).toContain("/tmp");
      const remaining = await manager.getTerminals("/tmp");
      expect(remaining.length).toBe(1);
      expect(remaining[0].id).toBe(second.id);
    });

    it("is no-op for unknown id", () => {
      manager = createTerminalManager();
      expect(() => manager.killTerminal("unknown-id")).not.toThrow();
    });

    it("auto-removes terminal when shell exits", async () => {
      manager = createTerminalManager();
      const terminals = await manager.getTerminals("/tmp");
      const exitedId = terminals[0].id;
      terminals[0].kill();

      await waitForCondition(() => manager.getTerminal(exitedId) === undefined, 10000);

      expect(manager.getTerminal(exitedId)).toBeUndefined();

      const remaining = await manager.getTerminals("/tmp");
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).not.toBe(exitedId);
    });
  });

  describe("listDirectories", () => {
    it("returns empty array initially", () => {
      manager = createTerminalManager();
      expect(manager.listDirectories()).toEqual([]);
    });

    it("returns all cwds with active terminals", async () => {
      manager = createTerminalManager();
      await manager.getTerminals("/tmp");
      await manager.getTerminals("/home");

      const dirs = manager.listDirectories();
      expect(dirs).toContain("/tmp");
      expect(dirs).toContain("/home");
      expect(dirs.length).toBe(2);
    });
  });

  describe("killAll", () => {
    it("kills all terminals and clears state", async () => {
      manager = createTerminalManager();
      const tmpTerminals = await manager.getTerminals("/tmp");
      const homeTerminals = await manager.getTerminals("/home");
      const tmpId = tmpTerminals[0].id;
      const homeId = homeTerminals[0].id;

      manager.killAll();

      expect(manager.listDirectories()).toEqual([]);
      expect(manager.getTerminal(tmpId)).toBeUndefined();
      expect(manager.getTerminal(homeId)).toBeUndefined();
    });
  });

  describe("subscribeTerminalsChanged", () => {
    it("emits cwd snapshots when terminals are created", async () => {
      manager = createTerminalManager();
      const snapshots: Array<{ cwd: string; terminalNames: string[] }> = [];
      const unsubscribe = manager.subscribeTerminalsChanged((input) => {
        snapshots.push({
          cwd: input.cwd,
          terminalNames: input.terminals.map((terminal) => terminal.name),
        });
      });

      await manager.getTerminals("/tmp");
      await manager.createTerminal({ cwd: "/tmp", name: "Dev Server" });

      expect(snapshots).toContainEqual({
        cwd: "/tmp",
        terminalNames: ["Terminal 1"],
      });
      expect(snapshots).toContainEqual({
        cwd: "/tmp",
        terminalNames: ["Terminal 1", "Dev Server"],
      });

      unsubscribe();
    });

    it("emits empty snapshot when last terminal is removed", async () => {
      manager = createTerminalManager();
      const snapshots: Array<{ cwd: string; terminalCount: number }> = [];
      const unsubscribe = manager.subscribeTerminalsChanged((input) => {
        snapshots.push({
          cwd: input.cwd,
          terminalCount: input.terminals.length,
        });
      });

      const terminals = await manager.getTerminals("/tmp");
      manager.killTerminal(terminals[0].id);

      expect(snapshots).toContainEqual({
        cwd: "/tmp",
        terminalCount: 0,
      });

      unsubscribe();
    });
  });
});
