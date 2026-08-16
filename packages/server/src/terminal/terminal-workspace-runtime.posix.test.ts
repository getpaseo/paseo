import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { createWorkspaceRuntimeService } from "../server/workspace-runtime/index.js";
import { createConfiguredTerminalManager } from "./terminal-manager-factory.js";
import type { TerminalManager } from "./terminal-manager.js";

const posixDescribe = describe.runIf(process.platform !== "win32");
const cleanup: Array<{ root: string; manager: TerminalManager }> = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map(async ({ root, manager }) => {
      await manager.killAll();
      await rm(root, { recursive: true, force: true });
    }),
  );
});

posixDescribe("workspace-bound terminal manager", () => {
  test("keeps terminal state in Paseo while the selected runtime owns the PTY", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-terminal-runtime-"));
    const cwd = path.join(root, "workspace");
    await mkdir(cwd);
    const runtimeIds = new Map<string, string>();
    const runtime = createWorkspaceRuntimeService({
      paseoHome: path.join(root, "home"),
      resolveRuntimeId: async (workspaceId) => runtimeIds.get(workspaceId) ?? null,
      persistRuntimeId: async (workspaceId, runtimeId) => {
        runtimeIds.set(workspaceId, runtimeId);
      },
      beginWorkspaceDeletion: async () => {},
      removeWorkspaceRecord: async (workspaceId) => {
        runtimeIds.delete(workspaceId);
      },
    });
    await runtime.create({
      workspaceId: "selected-workspace",
      runtimeId: "local",
      project: { id: "project", source: { kind: "host-directory", path: cwd } },
      placement: { kind: "existing" },
    });
    const silentShell = path.join(root, "silent-shell");
    const silentShellReady = path.join(root, "silent-shell-ready");
    await writeFile(
      silentShell,
      `#!/usr/bin/env node\nprocess.stdin.setRawMode(true);process.stdin.setEncoding('utf8');require('node:fs').writeFileSync(${JSON.stringify(silentShellReady)},'ready');process.stdin.once('data',data=>{process.stdout.write(\`ready|λ|\${data.trim()}|\${process.stdout.columns}x\${process.stdout.rows}\`);process.exit(4)});\n`,
    );
    await chmod(silentShell, 0o755);
    const originalShell = process.env.SHELL;
    process.env.SHELL = silentShell;
    const manager = createConfiguredTerminalManager({
      launchPty: async (input) =>
        runtime.openTerminal({
          workspaceId: input.workspaceId,
          argv: input.argv,
          env: input.env,
          purpose: { kind: "terminal", terminalId: input.terminalId },
          rows: input.rows,
          cols: input.cols,
          term: input.term,
        }),
    });
    if (originalShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = originalShell;
    cleanup.push({ root, manager });

    const terminal = await manager.createTerminal({
      workspaceId: "selected-workspace",
      cwd,
      rows: 24,
      cols: 80,
    });
    let output = "";
    terminal.subscribe((message) => {
      if (message.type === "output") output += message.data;
    });
    await vi.waitFor(async () => expect(await readFile(silentShellReady, "utf8")).toBe("ready"));
    terminal.send({ type: "resize", rows: 35, cols: 97 });
    terminal.send({ type: "input", data: "héllo\n" });
    await vi.waitFor(() => expect(output).toContain("ready|λ|héllo|97x35"));
    await vi.waitFor(() => expect(manager.getTerminal(terminal.id)).toBeUndefined());
  });

  test("a selected runtime failure never falls back to a host PTY", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-terminal-runtime-failure-"));
    const manager = createConfiguredTerminalManager({
      launchPty: async () => {
        throw new Error("selected runtime PTY unavailable");
      },
    });
    cleanup.push({ root, manager });
    await expect(manager.createTerminal({ workspaceId: "selected", cwd: root })).rejects.toThrow(
      "selected runtime PTY unavailable",
    );
  });

  test("forwards initial runtime input before a following resize without a readiness timer", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-terminal-immediate-input-"));
    let input = "";
    let observeResize!: () => void;
    const resized = new Promise<void>((resolve) => {
      observeResize = resolve;
    });
    let finish!: () => void;
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        finish = () => resolve({ code: null, signal: "SIGTERM" });
      },
    );
    const manager = createConfiguredTerminalManager({
      launchPty: async () => ({
        onData: () => () => {},
        write: (data) => {
          input += data;
        },
        resize: observeResize,
        exited,
        kill: finish,
      }),
    });
    cleanup.push({ root, manager });
    const terminal = await manager.createTerminal({
      workspaceId: "selected-workspace",
      cwd: root,
      command: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
    });

    terminal.send({ type: "input", data: "first-input" });
    terminal.send({ type: "resize", rows: 35, cols: 97 });
    await resized;

    expect(input).toBe("first-input");
  });

  test("an unexpected terminal-worker exit terminates its parent-owned runtime PTY", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-terminal-worker-exit-"));
    const cwd = path.join(root, "workspace");
    const pidFile = path.join(root, "runtime-pty.pid");
    await mkdir(cwd);
    const runtimeIds = new Map<string, string>();
    const runtime = createWorkspaceRuntimeService({
      paseoHome: path.join(root, "home"),
      resolveRuntimeId: async (workspaceId) => runtimeIds.get(workspaceId) ?? null,
      persistRuntimeId: async (workspaceId, runtimeId) => {
        runtimeIds.set(workspaceId, runtimeId);
      },
      beginWorkspaceDeletion: async () => {},
      removeWorkspaceRecord: async (workspaceId) => {
        runtimeIds.delete(workspaceId);
      },
    });
    await runtime.create({
      workspaceId: "selected-workspace",
      runtimeId: "local",
      project: { id: "project", source: { kind: "host-directory", path: cwd } },
      placement: { kind: "existing" },
    });
    const manager = createConfiguredTerminalManager({
      launchPty: async (input) => {
        if (input.workspaceId === "legacy-crasher") return null;
        return runtime.openTerminal({
          workspaceId: input.workspaceId,
          argv: input.argv,
          env: input.env,
          purpose: { kind: "terminal", terminalId: input.terminalId },
          rows: input.rows,
          cols: input.cols,
          term: input.term,
        });
      },
    });
    cleanup.push({ root, manager });

    try {
      await manager.createTerminal({
        workspaceId: "selected-workspace",
        cwd,
        command: process.execPath,
        args: [
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`,
        ],
      });
      await vi.waitFor(async () =>
        expect(processExists(Number(await readFile(pidFile, "utf8")))).toBe(true),
      );

      await expect(
        manager.createTerminal({
          workspaceId: "legacy-crasher",
          cwd,
          command: process.execPath,
          args: ["-e", "process.kill(process.ppid, 'SIGKILL')"],
        }),
      ).rejects.toThrow("Terminal worker exited");

      await vi.waitFor(
        async () => expect(processExists(Number(await readFile(pidFile, "utf8")))).toBe(false),
        { timeout: 5_000 },
      );
    } finally {
      await runtime.destroy("selected-workspace");
    }
  }, 15_000);

  test("killAll waits for parent-owned runtime PTYs to terminate", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-terminal-kill-all-"));
    const cwd = path.join(root, "workspace");
    const pidFile = path.join(root, "runtime-pty.pid");
    await mkdir(cwd);
    const runtimeIds = new Map<string, string>();
    const runtime = createWorkspaceRuntimeService({
      paseoHome: path.join(root, "home"),
      resolveRuntimeId: async (workspaceId) => runtimeIds.get(workspaceId) ?? null,
      persistRuntimeId: async (workspaceId, runtimeId) => {
        runtimeIds.set(workspaceId, runtimeId);
      },
      beginWorkspaceDeletion: async () => {},
      removeWorkspaceRecord: async (workspaceId) => {
        runtimeIds.delete(workspaceId);
      },
    });
    await runtime.create({
      workspaceId: "selected-workspace",
      runtimeId: "local",
      project: { id: "project", source: { kind: "host-directory", path: cwd } },
      placement: { kind: "existing" },
    });
    const manager = createConfiguredTerminalManager({
      launchPty: async (input) =>
        runtime.openTerminal({
          workspaceId: input.workspaceId,
          argv: input.argv,
          env: input.env,
          purpose: { kind: "terminal", terminalId: input.terminalId },
          rows: input.rows,
          cols: input.cols,
          term: input.term,
        }),
    });

    try {
      await manager.createTerminal({
        workspaceId: "selected-workspace",
        cwd,
        command: process.execPath,
        args: [
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`,
        ],
      });
      await vi.waitFor(async () =>
        expect(processExists(Number(await readFile(pidFile, "utf8")))).toBe(true),
      );

      await manager.killAll();

      expect(processExists(Number(await readFile(pidFile, "utf8")))).toBe(false);
    } finally {
      await runtime.destroy("selected-workspace");
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("a hung runtime PTY launch cannot block cleanup of an already-owned PTY", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-terminal-hung-launch-"));
    const cwd = path.join(root, "workspace");
    const pidFile = path.join(root, "runtime-pty.pid");
    await mkdir(cwd);
    const runtimeIds = new Map<string, string>();
    const runtime = createWorkspaceRuntimeService({
      paseoHome: path.join(root, "home"),
      resolveRuntimeId: async (workspaceId) => runtimeIds.get(workspaceId) ?? null,
      persistRuntimeId: async (workspaceId, runtimeId) => {
        runtimeIds.set(workspaceId, runtimeId);
      },
      beginWorkspaceDeletion: async () => {},
      removeWorkspaceRecord: async (workspaceId) => {
        runtimeIds.delete(workspaceId);
      },
    });
    await runtime.create({
      workspaceId: "selected-workspace",
      runtimeId: "local",
      project: { id: "project", source: { kind: "host-directory", path: cwd } },
      placement: { kind: "existing" },
    });
    let markHungLaunchStarted!: () => void;
    const hungLaunchStarted = new Promise<void>((resolve) => {
      markHungLaunchStarted = resolve;
    });
    const manager = createConfiguredTerminalManager({
      launchPty: async (input) => {
        if (input.workspaceId === "hung-workspace") {
          markHungLaunchStarted();
          return new Promise(() => {});
        }
        if (input.workspaceId === "legacy-crasher") return null;
        return runtime.openTerminal({
          workspaceId: input.workspaceId,
          argv: input.argv,
          env: input.env,
          purpose: { kind: "terminal", terminalId: input.terminalId },
          rows: input.rows,
          cols: input.cols,
          term: input.term,
        });
      },
    });

    try {
      await manager.createTerminal({
        workspaceId: "selected-workspace",
        cwd,
        command: process.execPath,
        args: [
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`,
        ],
      });
      await vi.waitFor(async () =>
        expect(processExists(Number(await readFile(pidFile, "utf8")))).toBe(true),
      );

      await manager.createTerminal({
        workspaceId: "legacy-crasher",
        cwd,
        command: process.execPath,
        args: ["-e", "setTimeout(()=>process.kill(process.ppid, 'SIGKILL'),500)"],
      });

      const hungCreate = manager.createTerminal({
        workspaceId: "hung-workspace",
        cwd,
        command: process.execPath,
        args: ["-e", "setInterval(()=>{},1000)"],
      });
      const hungCreateResult = hungCreate.then(
        () => null,
        (error: unknown) => error,
      );
      await hungLaunchStarted;
      const hungCreateError = await hungCreateResult;
      expect(hungCreateError).toBeInstanceOf(Error);
      expect((hungCreateError as Error).message).toContain("Terminal worker exited");
      await manager.killAll();

      expect(processExists(Number(await readFile(pidFile, "utf8")))).toBe(false);
    } finally {
      await runtime.destroy("selected-workspace");
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("killAll reports a runtime PTY that remains alive after SIGKILL", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-terminal-stuck-cleanup-"));
    const manager = createConfiguredTerminalManager({
      launchPty: async () => ({
        onData: () => () => {},
        write: () => {},
        resize: () => {},
        exited: new Promise(() => {}),
        kill: () => {},
      }),
    });

    try {
      await manager.createTerminal({
        workspaceId: "selected-workspace",
        cwd: root,
        command: process.execPath,
        args: ["-e", "setInterval(()=>{},1000)"],
      });

      await expect(manager.killAll()).rejects.toThrow("Runtime PTY remained alive after SIGKILL");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);
});

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
