import { afterEach, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkerTerminalManager } from "./worker-terminal-manager.js";
import type { TerminalManager } from "./terminal-manager.js";
import type { TerminalSession } from "./terminal.js";
import type { TerminalState } from "../shared/messages.js";
import type {
  TerminalWorkerRequest,
  TerminalWorkerToParentMessage,
} from "./terminal-worker-protocol.js";

function nodeTerminalCommand(script: string): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: ["-e", script],
  };
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 25,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

function getVisibleText(session: TerminalSession): string {
  return getVisibleTextFromState(session.getState());
}

function getVisibleTextFromState(state: TerminalState): string {
  return state.grid
    .map((row) =>
      row
        .map((cell) => cell.char)
        .join("")
        .trimEnd(),
    )
    .join("\n");
}

function createTerminalState(): TerminalState {
  const blankCell = { char: " " };
  return {
    rows: 1,
    cols: 1,
    grid: [[blankCell]],
    scrollback: [],
    cursor: { row: 0, col: 0 },
  };
}

class FakeTerminalWorker extends EventEmitter {
  connected = true;
  killed = false;
  readonly sentMessages: TerminalWorkerRequest[] = [];

  send(message: TerminalWorkerRequest, callback: (error: Error | null) => void): boolean {
    this.sentMessages.push(message);
    callback(null);
    return true;
  }

  disconnect(): void {
    this.connected = false;
    this.emit("exit", 0, null);
  }

  kill(): boolean {
    this.killed = true;
    this.connected = false;
    this.emit("exit", 0, null);
    return true;
  }

  emitWorkerMessage(message: TerminalWorkerToParentMessage): void {
    this.emit("message", message);
  }
}

let manager: TerminalManager | null = null;
const temporaryDirs: string[] = [];
const terminalSessions: TerminalSession[] = [];

function trackTerminal(session: TerminalSession): TerminalSession {
  terminalSessions.push(session);
  return session;
}

async function removeTemporaryDir(dir: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError;
}

afterEach(async () => {
  const sessions = terminalSessions.splice(0);
  await Promise.all(
    sessions.map((session) =>
      session
        .killAndWait({
          gracefulTimeoutMs: 1000,
          forceTimeoutMs: 500,
        })
        .catch(() => {}),
    ),
  );
  manager?.killAll();
  manager = null;
  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop();
    if (dir) {
      await removeTemporaryDir(dir);
    }
  }
});

it("creates a terminal through the worker and streams output", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "worker-terminal-manager-output-"));
  temporaryDirs.push(cwd);
  manager = createWorkerTerminalManager();
  const session = trackTerminal(
    await manager.createTerminal({
      cwd,
      ...nodeTerminalCommand(`
      process.stdin.on("data", (chunk) => {
        process.stdout.write("worker-output:" + chunk.toString());
      });
      setInterval(() => {}, 1000);
    `),
    }),
  );
  const messages: string[] = [];
  let snapshots = 0;
  const unsubscribe = session.subscribe((message) => {
    if (message.type === "output") {
      messages.push(message.data);
    }
    if (message.type === "snapshot") {
      snapshots += 1;
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const snapshotsBeforeOutput = snapshots;

  session.send({ type: "input", data: "hello\r" });

  await waitForCondition(
    () =>
      messages.join("").includes("worker-output:hello") ||
      getVisibleText(session).includes("worker-output:hello"),
    10000,
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  unsubscribe();

  expect(messages.join("") + getVisibleText(session)).toContain("worker-output:hello");
  expect(snapshots).toBe(snapshotsBeforeOutput);
});

it("pulls fresh terminal state from the worker authority", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "worker-terminal-manager-state-"));
  temporaryDirs.push(cwd);
  manager = createWorkerTerminalManager();
  const session = trackTerminal(
    await manager.createTerminal({
      cwd,
      ...nodeTerminalCommand(`
      process.stdout.write("worker-state-ready\\n");
      setInterval(() => {}, 1000);
    `),
    }),
  );

  let visibleText = "";
  await waitForCondition(async () => {
    const snapshot = await manager!.getTerminalState(session.id);
    visibleText = snapshot ? getVisibleTextFromState(snapshot.state) : "";
    return visibleText.includes("worker-state-ready");
  }, 10000);

  expect(visibleText).toContain("worker-state-ready");
});

it("refreshes cached terminal title after worker title changes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "worker-terminal-manager-title-"));
  temporaryDirs.push(cwd);
  manager = createWorkerTerminalManager();
  const session = trackTerminal(
    await manager.createTerminal({
      cwd,
      ...nodeTerminalCommand(`
      process.stdout.write("\\u001b]0;Build Output\\u0007");
      setTimeout(() => {}, 2000);
    `),
    }),
  );

  await waitForCondition(() => session.getTitle() === "Build Output", 10000);

  expect(session.getState().title).toBe("Build Output");
});

it("refreshes cached terminal size after worker resize", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "worker-terminal-manager-resize-"));
  temporaryDirs.push(cwd);
  manager = createWorkerTerminalManager();
  const session = trackTerminal(await manager.createTerminal({ cwd }));

  session.send({ type: "resize", rows: 10, cols: 40 });

  await waitForCondition(() => {
    const size = session.getSize();
    return size.rows === 10 && size.cols === 40;
  }, 10000);

  expect(session.getState().rows).toBe(10);
  expect(session.getState().cols).toBe(40);
});

it("captures terminal output from the worker authority", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "worker-terminal-manager-capture-"));
  temporaryDirs.push(cwd);
  manager = createWorkerTerminalManager();
  const session = trackTerminal(await manager.createTerminal({ cwd }));

  session.send({ type: "input", data: "echo hello world\r" });

  let capture = await manager.captureTerminal(session.id);
  await waitForCondition(async () => {
    capture = await manager!.captureTerminal(session.id);
    return capture.lines.join("\n").includes("hello world");
  }, 10000);

  expect(capture.lines.join("\n")).toContain("hello world");
  expect(capture.totalLines).toBeGreaterThan(0);
});

it("does not surface fire-and-forget send timeouts as unhandled rejections", async () => {
  const worker = new FakeTerminalWorker();
  manager = createWorkerTerminalManager({
    requestTimeoutMs: 5,
    forkWorker: () => worker,
  });

  worker.emitWorkerMessage({
    type: "terminalCreated",
    terminal: { id: "terminal-1", name: "Terminal", cwd: "/tmp" },
    state: createTerminalState(),
  });
  const session = manager.getTerminal("terminal-1");
  expect(session).toBeDefined();

  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    session?.send({ type: "input", data: "x" });
    await new Promise((resolve) => setTimeout(resolve, 25));
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }

  expect(worker.sentMessages.some((message) => message.type === "send")).toBe(true);
  expect(unhandledRejections).toEqual([]);
});

it("keeps registered cwd env inheritance behind the worker manager interface", async () => {
  manager = createWorkerTerminalManager();
  const cwd = mkdtempSync(join(tmpdir(), "worker-terminal-manager-env-"));
  temporaryDirs.push(cwd);
  const markerPath = join(cwd, "env.txt");

  manager.registerCwdEnv({
    cwd,
    env: { PASEO_WORKER_TERMINAL_TEST: "worker-env" },
  });
  trackTerminal(
    await manager.createTerminal({
      cwd,
      ...nodeTerminalCommand(`
      require("node:fs").writeFileSync(
        ${JSON.stringify(markerPath)},
        process.env.PASEO_WORKER_TERMINAL_TEST ?? "",
      );
      setInterval(() => {}, 1000);
    `),
    }),
  );

  await waitForCondition(() => existsSync(markerPath), 10000);

  expect(readFileSync(markerPath, "utf8")).toBe("worker-env");
});

it("starts the default shell through the worker and accepts quoted commands", async () => {
  manager = createWorkerTerminalManager();
  const cwd = mkdtempSync(join(tmpdir(), "worker-terminal-manager-shell-"));
  temporaryDirs.push(cwd);
  const markerPath = join(cwd, "shell quoted marker.txt");
  const session = trackTerminal(await manager.createTerminal({ cwd }));
  const command = [
    "node",
    "-e",
    `"require('node:fs').writeFileSync('shell quoted marker.txt','shell-ok')"`,
  ].join(" ");

  session.send({ type: "input", data: `${command}\r` });

  await waitForCondition(() => existsSync(markerPath), 10000);

  expect(readFileSync(markerPath, "utf8")).toBe("shell-ok");
});

it("removes worker terminals after killAndWait", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "worker-terminal-manager-kill-"));
  temporaryDirs.push(cwd);
  manager = createWorkerTerminalManager();
  const session = trackTerminal(
    await manager.createTerminal({
      cwd,
      ...nodeTerminalCommand("setInterval(() => {}, 1000);"),
    }),
  );

  await manager.killTerminalAndWait(session.id, {
    gracefulTimeoutMs: 1000,
    forceTimeoutMs: 500,
  });
  terminalSessions.splice(terminalSessions.indexOf(session), 1);

  await waitForCondition(() => manager?.getTerminal(session.id) === undefined, 5000);

  expect(manager.getTerminal(session.id)).toBeUndefined();
  expect(manager.listDirectories()).not.toContain(cwd);
});
