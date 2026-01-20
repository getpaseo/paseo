import { describe, it, expect, afterEach } from "vitest";
import { createTerminalManager, type TerminalManager } from "./terminal-manager.js";

describe("TerminalManager", () => {
  let manager: TerminalManager;

  afterEach(() => {
    if (manager) {
      manager.killAll();
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

      manager.killAll();

      expect(manager.listDirectories()).toEqual([]);
      expect(manager.getTerminal(tmpTerminals[0].id)).toBeUndefined();
      expect(manager.getTerminal(homeTerminals[0].id)).toBeUndefined();
    });
  });
});
