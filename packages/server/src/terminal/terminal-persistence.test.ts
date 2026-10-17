import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { isPlatform } from "../test-utils/platform.js";
import { createTestLogger } from "../test-utils/test-logger.js";
import { PersistedTerminalStore } from "./persisted-terminal-store.js";
import { createTerminalManager, type TerminalManager } from "./terminal-manager.js";
import { createTerminalPersistence, type TerminalPersistence } from "./terminal-persistence.js";
import { createWorkerTerminalManager } from "./worker-terminal-manager.js";

async function waitForCondition(predicate: () => Promise<boolean>, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

async function terminalText(manager: TerminalManager, id: string): Promise<string> {
  const capture = await manager.captureTerminal(id, { stripAnsi: true });
  return capture.lines.join("\n");
}

const temporaryDirs: string[] = [];
const managers: TerminalManager[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) {
    manager.killAll();
  }
  for (const dir of temporaryDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Daemon {
  persistence: TerminalPersistence;
  manager: TerminalManager;
}

function setup(options: { enabled?: boolean; createManager?: () => TerminalManager } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "terminal-persistence-")));
  temporaryDirs.push(root);
  const cwd = join(root, "repo");
  const bin = join(root, "bin");
  mkdirSync(cwd);
  mkdirSync(bin);
  const store = new PersistedTerminalStore(
    join(root, "paseo-home", "terminals"),
    createTestLogger(),
  );
  let enabled = options.enabled ?? true;

  // A stand-in agent binary named like the real one, so relaunch planning
  // treats it as Claude. It prints the arguments it was started with.
  const claude = join(bin, "claude");
  writeFileSync(claude, '#!/bin/sh\necho "claude-args:$*"\nexec sleep 30\n');
  chmodSync(claude, 0o755);

  function startDaemon(): Daemon {
    const inner = (options.createManager ?? createTerminalManager)();
    managers.push(inner);
    const persistence = createTerminalPersistence({
      manager: inner,
      store,
      isEnabled: () => enabled,
      logger: createTestLogger(),
    });
    return { persistence, manager: persistence.manager };
  }

  async function stopDaemon(daemon: Daemon): Promise<void> {
    daemon.manager.killAll();
    await daemon.persistence.flush();
  }

  return {
    cwd,
    claude,
    store,
    startDaemon,
    stopDaemon,
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    restoreAll: (daemon: Daemon) => daemon.persistence.restore({ canRestore: async () => true }),
  };
}

describe.skipIf(isPlatform("win32"))("terminal persistence", () => {
  it("restores an agent terminal after a daemon restart, resumed into its session", async () => {
    const env = setup();
    const first = env.startDaemon();
    const created = await first.manager.createTerminal({
      cwd: env.cwd,
      workspaceId: "ws-1",
      name: "Agent",
      command: env.claude,
      args: ["--model", "opus", "fix the build"],
      restorable: true,
    });
    first.persistence.recordAgentSession(created.id, {
      provider: "claude",
      sessionId: "session-1",
    });
    await env.stopDaemon(first);

    const second = env.startDaemon();
    const summary = await env.restoreAll(second);

    expect(summary).toEqual({ restored: [created.id], dropped: [] });
    const restored = second.manager.getTerminal(created.id);
    expect(restored).toMatchObject({ id: created.id, name: "Agent", workspaceId: "ws-1" });
    await waitForCondition(async () =>
      (await terminalText(second.manager, created.id)).includes("claude-args:"),
    );
    expect(await terminalText(second.manager, created.id)).toContain(
      "claude-args:--model opus --resume session-1",
    );
    // The record keeps the original launch so the next restore resumes the latest session.
    expect(await env.store.list()).toEqual([
      expect.objectContaining({
        id: created.id,
        command: env.claude,
        args: ["--model", "opus", "fix the build"],
        agentSession: { provider: "claude", sessionId: "session-1" },
      }),
    ]);
  });

  it("types the resume command into a restored shell terminal", async () => {
    const env = setup();
    const first = env.startDaemon();
    const created = await first.manager.createTerminal({
      cwd: env.cwd,
      workspaceId: "ws-1",
      restorable: true,
    });
    first.persistence.recordAgentSession(created.id, { provider: "codex", sessionId: "codex-1" });
    await env.stopDaemon(first);

    const second = env.startDaemon();
    await env.restoreAll(second);

    await waitForCondition(async () =>
      (await terminalText(second.manager, created.id)).includes("codex resume codex-1"),
    );
  });

  it("restores a prompt terminal without a session as a plain shell, without the prompt", async () => {
    const env = setup();
    const first = env.startDaemon();
    const created = await first.manager.createTerminal({
      cwd: env.cwd,
      workspaceId: "ws-1",
      command: env.claude,
      args: ["fix the build"],
      restorable: true,
    });
    await waitForCondition(async () =>
      (await terminalText(first.manager, created.id)).includes("claude-args:fix the build"),
    );
    await env.stopDaemon(first);

    const second = env.startDaemon();
    await env.restoreAll(second);
    second.manager.getTerminal(created.id)?.send({ type: "input", data: "echo shell-$((40+2))\r" });

    await waitForCondition(async () =>
      (await terminalText(second.manager, created.id)).includes("shell-42"),
    );
    expect(second.manager.getTerminal(created.id)?.cwd).toBe(env.cwd);
    expect(await terminalText(second.manager, created.id)).not.toContain("claude-args");
  });

  it("restores a plain shell once the agent session ended", async () => {
    const env = setup();
    const first = env.startDaemon();
    const created = await first.manager.createTerminal({
      cwd: env.cwd,
      workspaceId: "ws-1",
      command: env.claude,
      args: ["--model", "opus"],
      restorable: true,
    });
    first.persistence.recordAgentSession(created.id, { provider: "claude", sessionId: "s-1" });
    first.persistence.recordAgentSession(created.id, { provider: "claude", sessionId: null });
    await env.stopDaemon(first);

    expect(await env.store.list()).toEqual([
      expect.not.objectContaining({ agentSession: expect.anything() }),
    ]);
  });

  it("resumes in the directory the agent reported, inside the terminal cwd", async () => {
    const env = setup();
    const nested = join(env.cwd, "packages", "app");
    mkdirSync(nested, { recursive: true });
    const first = env.startDaemon();
    const inside = await first.manager.createTerminal({
      cwd: env.cwd,
      workspaceId: "ws-1",
      restorable: true,
    });
    const outside = await first.manager.createTerminal({
      cwd: env.cwd,
      workspaceId: "ws-1",
      restorable: true,
    });
    first.persistence.recordAgentSession(inside.id, {
      provider: "codex",
      sessionId: "c-1",
      cwd: nested,
    });
    first.persistence.recordAgentSession(outside.id, {
      provider: "codex",
      sessionId: "c-2",
      cwd: tmpdir(),
    });
    await env.stopDaemon(first);

    const second = env.startDaemon();
    await env.restoreAll(second);

    expect(second.manager.getTerminal(inside.id)?.cwd).toBe(nested);
    expect(second.manager.getTerminal(outside.id)?.cwd).toBe(env.cwd);
  });

  it("relaunches an agent command in its launch cwd so relative directory flags resolve once", async () => {
    const env = setup();
    const nested = join(env.cwd, "packages", "app");
    mkdirSync(nested, { recursive: true });
    const codex = join(env.cwd, "..", "bin", "codex");
    writeFileSync(codex, '#!/bin/sh\necho "codex-run:$(pwd) $*"\nexec sleep 30\n');
    chmodSync(codex, 0o755);
    const first = env.startDaemon();
    const created = await first.manager.createTerminal({
      cwd: env.cwd,
      workspaceId: "ws-1",
      command: codex,
      args: ["-C", "packages/app"],
      restorable: true,
    });
    // Codex reports the directory it moved into.
    first.persistence.recordAgentSession(created.id, {
      provider: "codex",
      sessionId: "c-1",
      cwd: nested,
    });
    await env.stopDaemon(first);

    const second = env.startDaemon();
    await env.restoreAll(second);

    await waitForCondition(async () =>
      (await terminalText(second.manager, created.id)).includes("codex-run:"),
    );
    // Rows are joined because the long path wraps at the terminal width.
    expect((await terminalText(second.manager, created.id)).replaceAll("\n", "")).toContain(
      `codex-run:${env.cwd} -C packages/app resume c-1`,
    );
  });

  it.skipIf(!existsSync("/bin/zsh"))(
    "clears the session when the agent quits back to the shell",
    async () => {
      const env = setup();
      const daemon = env.startDaemon();
      const created = await daemon.manager.createTerminal({
        cwd: env.cwd,
        workspaceId: "ws-1",
        command: "/bin/zsh",
        env: { HOME: env.cwd },
        restorable: true,
      });
      daemon.persistence.recordAgentSession(created.id, { provider: "codex", sessionId: "c-1" });
      await daemon.persistence.flush();
      expect((await env.store.list())[0]?.agentSession).toEqual({
        provider: "codex",
        sessionId: "c-1",
      });

      // The first prompt alone reports no finished command.
      await waitForCondition(
        async () => (await terminalText(daemon.manager, created.id)).trim().length > 0,
      );
      await daemon.persistence.flush();
      expect((await env.store.list())[0]?.agentSession?.sessionId).toBe("c-1");

      created.send({ type: "input", data: "true\r" });

      await waitForCondition(async () => {
        await daemon.persistence.flush();
        return (await env.store.list())[0]?.agentSession === undefined;
      });
    },
  );

  it("ignores session reports and exits once shutdown starts", async () => {
    const env = setup();
    const first = env.startDaemon();
    const created = await first.manager.createTerminal({
      cwd: env.cwd,
      workspaceId: "ws-1",
      restorable: true,
    });
    first.persistence.recordAgentSession(created.id, { provider: "claude", sessionId: "s-1" });
    first.persistence.prepareForShutdown();
    first.persistence.recordAgentSession(created.id, { provider: "claude", sessionId: null });
    await first.manager.killTerminalAndWait(created.id);
    await first.persistence.flush();

    expect(await env.store.list()).toEqual([
      expect.objectContaining({ agentSession: { provider: "claude", sessionId: "s-1" } }),
    ]);
  });

  it("drops session ids that are unsafe to type into a shell", async () => {
    const env = setup();
    const daemon = env.startDaemon();
    const created = await daemon.manager.createTerminal({
      cwd: env.cwd,
      workspaceId: "ws-1",
      restorable: true,
    });
    daemon.persistence.recordAgentSession(created.id, {
      provider: "claude",
      sessionId: "x; rm -rf ~",
    });
    await env.stopDaemon(daemon);

    expect(await env.store.list()).toEqual([
      expect.not.objectContaining({ agentSession: expect.anything() }),
    ]);
  });

  it("forgets a terminal the user closes or that exits on its own", async () => {
    const env = setup();
    const daemon = env.startDaemon();
    const closed = await daemon.manager.createTerminal({
      cwd: env.cwd,
      workspaceId: "ws-1",
      restorable: true,
    });
    const exiting = await daemon.manager.createTerminal({
      cwd: env.cwd,
      workspaceId: "ws-1",
      command: "/bin/sh",
      args: ["-c", "sleep 0.2"],
      restorable: true,
    });
    await daemon.persistence.flush();
    expect((await env.store.list()).map((record) => record.id).sort()).toEqual(
      [closed.id, exiting.id].sort(),
    );

    await daemon.manager.killTerminalAndWait(closed.id);
    await waitForCondition(async () => daemon.manager.getTerminal(exiting.id) === undefined);
    await daemon.persistence.flush();

    expect(await env.store.list()).toEqual([]);
  });

  it("forgets a terminal whose command exits before it is tracked", async () => {
    // The production worker manager can deliver the exit before createTerminal resolves.
    const env = setup({ createManager: () => createWorkerTerminalManager() });
    const daemon = env.startDaemon();
    const ids: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const created = await daemon.manager.createTerminal({
        cwd: env.cwd,
        workspaceId: "ws-1",
        command: "/bin/echo",
        args: ["done"],
        restorable: true,
      });
      ids.push(created.id);
    }
    const isGone = (id: string) => !daemon.manager.getTerminal(id);
    await waitForCondition(async () => ids.every(isGone));
    await daemon.persistence.flush();

    expect(await env.store.list()).toEqual([]);
  });

  it("does not record terminals that are not user terminal tabs", async () => {
    const env = setup();
    const daemon = env.startDaemon();
    await daemon.manager.createTerminal({ cwd: env.cwd, workspaceId: "ws-1" });
    await env.stopDaemon(daemon);

    expect(await env.store.list()).toEqual([]);
  });

  it("drops records whose workspace can no longer host them", async () => {
    const env = setup();
    const first = env.startDaemon();
    const created = await first.manager.createTerminal({
      cwd: env.cwd,
      workspaceId: "ws-archived",
      restorable: true,
    });
    await env.stopDaemon(first);

    const second = env.startDaemon();
    const summary = await second.persistence.restore({ canRestore: async () => false });

    expect(summary).toEqual({ restored: [], dropped: [created.id] });
    expect(second.manager.getTerminal(created.id)).toBeUndefined();
    expect(await env.store.list()).toEqual([]);
  });

  it("writes nothing while the setting is off and clears records when it is turned off", async () => {
    const env = setup({ enabled: false });
    const daemon = env.startDaemon();
    const created = await daemon.manager.createTerminal({
      cwd: env.cwd,
      workspaceId: "ws-1",
      restorable: true,
    });
    await daemon.persistence.flush();
    expect(await env.store.list()).toEqual([]);

    env.setEnabled(true);
    await daemon.persistence.setEnabled(true);
    expect((await env.store.list()).map((record) => record.id)).toEqual([created.id]);

    env.setEnabled(false);
    await daemon.persistence.setEnabled(false);
    expect(await env.store.list()).toEqual([]);
  });

  it("serializes a fast off-then-on toggle so the records survive", async () => {
    const env = setup();
    const daemon = env.startDaemon();
    const created = await daemon.manager.createTerminal({
      cwd: env.cwd,
      workspaceId: "ws-1",
      restorable: true,
    });

    void daemon.persistence.setEnabled(false);
    void daemon.persistence.setEnabled(true);
    await daemon.persistence.flush();
    await daemon.persistence.setEnabled(true);

    expect((await env.store.list()).map((record) => record.id)).toEqual([created.id]);
  });

  it("restores several terminals concurrently", async () => {
    const env = setup();
    const first = env.startDaemon();
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const created = await first.manager.createTerminal({
        cwd: env.cwd,
        workspaceId: "ws-1",
        restorable: true,
      });
      ids.push(created.id);
    }
    await env.stopDaemon(first);

    const second = env.startDaemon();
    const summary = await env.restoreAll(second);

    expect(summary.restored.sort()).toEqual([...ids].sort());
    for (const id of ids) {
      expect(second.manager.getTerminal(id)?.id).toBe(id);
    }
  });
});
