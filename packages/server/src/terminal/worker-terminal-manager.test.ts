import { afterEach, expect, it } from "vitest";
import { isPlatform } from "../test-utils/platform.js";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import {
  createWorkerTerminalManager,
  startWorkerTerminalManager,
  type DaemonTerminalManager,
} from "./worker-terminal-manager.js";
import type {
  TerminalActivityTransitionEvent,
  TerminalWorkspaceContributionChangedEvent,
} from "./terminal-manager.js";
import {
  resolvePaseoCliBinDir,
  resolvePaseoCliExecutablePath,
  type TerminalSession,
} from "./terminal.js";
import type { TerminalState } from "@getpaseo/protocol/messages";
import type { TerminalActivity } from "@getpaseo/protocol/terminal-activity";
import type {
  TerminalWorkerRequest,
  TerminalWorkerToParentMessage,
} from "./terminal-worker-protocol.js";
import { createTerminalWorkerProcessInspector } from "./terminal-worker-processes.js";
import {
  readUnconfirmedTerminalCleanup,
  reapTerminalWorkers,
  TerminalCleanupNotConfirmedError,
} from "./terminal-worker-reaper.js";
import {
  listTerminalWorkerRecords,
  readTerminalWorkerRecord,
  terminalWorkerDirectory,
  type TerminalWorkerRecord,
} from "./terminal-worker-record.js";
import { TERMINAL_WORKER_PROTOCOL_OVERRIDE_ENV } from "./terminal-worker-protocol.js";
import {
  NoTerminalWorkerAvailableError,
  TerminalWorkerIncompatibleError,
} from "./terminal-worker-pool.js";
import { connectTerminalWorker } from "./terminal-worker-client.js";
import { launchTerminalWorker } from "./terminal-worker-launch.js";

type TerminalRow = TerminalState["grid"][number];

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

function rowToText(row: TerminalRow): string {
  return row
    .map((cell) => cell.char)
    .join("")
    .trimEnd();
}

function getVisibleTextFromState(state: TerminalState): string {
  return state.grid.map(rowToText).join("\n");
}

function getRenderedTextFromState(state: TerminalState): string {
  return [...state.scrollback, ...state.grid].map(rowToText).join("\n");
}

function readRenderedTokenIndexesFromState(state: TerminalState): number[] {
  const indexes: number[] = [];
  for (const match of getRenderedTextFromState(state).matchAll(/\[(\d+)\]/g)) {
    const value = match[1];
    if (value !== undefined) {
      indexes.push(Number(value));
    }
  }
  return indexes;
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
  readonly workerPid = 1;
  readonly sentMessages: TerminalWorkerRequest[] = [];

  send(message: TerminalWorkerRequest, callback: (error: Error | null) => void): boolean {
    this.sentMessages.push(message);
    callback(null);
    return true;
  }

  disconnect(): void {
    this.connected = false;
    this.emit("close");
  }

  emitWorkerMessage(message: TerminalWorkerToParentMessage): void {
    this.emit("message", message);
  }
}

let manager: DaemonTerminalManager | null = null;
const temporaryDirs: string[] = [];

// A real detached worker in a throwaway home; afterEach closes its terminals and the worker.
async function startRealWorkerManager(
  options: { getTerminalActivityUrl?: () => string | null; paseoHome?: string } = {},
): Promise<DaemonTerminalManager> {
  const { paseoHome = createTemporaryHome(), ...rest } = options;
  return startWorkerTerminalManager({
    paseoHome,
    paseoVersion: "0.0.0-test",
    logger: pino({ level: "silent" }),
    ...rest,
  });
}

function createTemporaryHome(): string {
  const paseoHome = mkdtempSync(join(tmpdir(), "worker-terminal-manager-home-"));
  temporaryDirs.push(paseoHome);
  return paseoHome;
}
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
  await manager?.closeTerminals();
  manager = null;
  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop();
    if (dir) {
      await removeTemporaryDir(dir);
    }
  }
});

it("retires a killed worker's sessions and shares one replacement across concurrent creates", async () => {
  const paseoHome = createTemporaryHome();
  manager = await startRealWorkerManager({ paseoHome });
  manager.registerCwdEnv({ cwd: paseoHome, env: { QA_RECOVERY_ENV: "retained" } });
  const terminal = await manager.createTerminal({
    workspaceId: "ws-recovery",
    cwd: paseoHome,
    ...nodeTerminalCommand(
      "process.stdin.on('data', chunk => process.stdout.write('echo:' + process.env.QA_RECOVERY_ENV + ':' + chunk)); setInterval(() => {}, 1000)",
    ),
  });
  const records = await listTerminalWorkerRecords(paseoHome);
  const file = records.find((entry) => !("error" in entry));
  if (!file || "error" in file) throw new Error("Missing worker record");
  const changes: string[][] = [];
  manager.subscribeTerminalsChanged((event) =>
    changes.push(event.terminals.map((item) => item.id)),
  );
  const exits: unknown[] = [];
  terminal.onExit((info) => exits.push(info));
  process.kill(file.record.pid, "SIGKILL");
  await waitForCondition(() => manager!.getTerminal(terminal.id) === undefined, 10000);
  expect(changes).toContainEqual([]);
  expect(exits).toHaveLength(1);
  const sessions = await Promise.all(
    Array.from({ length: 4 }, () =>
      manager!.createTerminal({
        workspaceId: "ws-recovery",
        cwd: paseoHome,
        ...nodeTerminalCommand(
          "process.stdin.on('data', chunk => process.stdout.write('echo:' + process.env.QA_RECOVERY_ENV + ':' + chunk)); setInterval(() => {}, 1000)",
        ),
      }),
    ),
  );
  for (const session of sessions) {
    const output: string[] = [];
    session.subscribe((message) => {
      if (message.type === "output") output.push(message.data);
    });
    session.send({ type: "input", data: "recovered\r" });
    await waitForCondition(() => output.join("").includes("echo:retained:recovered"), 10000);
  }
  expect(await manager.getTerminals(paseoHome)).toHaveLength(4);
  const remaining = (await listTerminalWorkerRecords(paseoHome)).filter(
    (entry) => !("error" in entry),
  );
  expect(remaining).toHaveLength(1);
}, 30000);

it("reconnects a live worker without replacing terminal sessions or processes", async () => {
  const paseoHome = createTemporaryHome();
  manager = await startRealWorkerManager({ paseoHome });
  const terminal = await manager.createTerminal({
    workspaceId: "ws-reconnect",
    cwd: paseoHome,
    ...nodeTerminalCommand(
      "process.stdin.on('data', chunk => process.stdout.write('echo:' + chunk)); setInterval(() => {}, 1000)",
    ),
  });
  const [before] = await workerRecords(paseoHome);
  const pids = await recordedTerminalPids(paseoHome);
  let replayRequests = 0;
  terminal.subscribe((message) => {
    if (message.type === "snapshotReady") replayRequests += 1;
  });
  // A second authenticated controller replaces the daemon's socket. The process stays alive.
  const competitor = await connectTerminalWorker({
    socketPath: before!.socketPath,
    secret: before!.secret,
  });
  await waitForCondition(() => !competitor.connected, 10000);
  await waitForCondition(async () => {
    try {
      return (await manager!.getTerminalState(terminal.id)) !== null;
    } catch {
      return false;
    }
  }, 10000);
  await waitForCondition(() => replayRequests > 0, 1000);
  expect(manager.getTerminal(terminal.id)).toBe(terminal);
  expect(await recordedTerminalPids(paseoHome)).toEqual(pids);
  expect((await workerRecords(paseoHome)).map((record) => record.pid)).toEqual([before!.pid]);
  const output: string[] = [];
  terminal.subscribe((message) => {
    if (message.type === "output") output.push(message.data);
  });
  terminal.send({ type: "input", data: "reconnected\r" });
  await waitForCondition(() => output.join("").includes("echo:reconnected"), 10000);
}, 30000);

it.each(["detach", "closeTerminals"] as const)(
  "does not replace a failed worker during %s",
  async (operation) => {
    const paseoHome = createTemporaryHome();
    manager = await startRealWorkerManager({ paseoHome });
    await manager.createTerminal({
      workspaceId: "ws-stop-recovery",
      cwd: paseoHome,
      ...nodeTerminalCommand("setInterval(() => {}, 1000)"),
    });
    const [record] = await workerRecords(paseoHome);
    process.kill(record!.pid, "SIGKILL");
    await manager[operation]();
    await expect(
      manager.createTerminal({ workspaceId: "ws-stop-recovery", cwd: paseoHome }),
    ).rejects.toBeInstanceOf(NoTerminalWorkerAvailableError);
    await manager.closeTerminals();
    expect(await workerRecords(paseoHome)).toEqual([]);
  },
  30000,
);

it.each(["detach", "closeTerminals"] as const)(
  "does not leak a replacement stopped during launch by %s",
  async (operation) => {
    const paseoHome = createTemporaryHome();
    manager = await startRealWorkerManager({ paseoHome });
    const terminal = await manager.createTerminal({
      workspaceId: "ws-launch-race",
      cwd: paseoHome,
      ...nodeTerminalCommand("setInterval(() => {}, 1000)"),
    });
    const [record] = await workerRecords(paseoHome);
    process.kill(record!.pid, "SIGKILL");
    await waitForCondition(() => !manager!.getTerminal(terminal.id), 10000);
    const creating = manager.createTerminal({ workspaceId: "ws-launch-race", cwd: paseoHome });
    const rejected = expect(creating).rejects.toBeInstanceOf(NoTerminalWorkerAvailableError);
    await manager[operation]();
    await rejected;
    await waitForCondition(async () => (await workerRecords(paseoHome)).length === 0, 10000);
    expect(await manager.getTerminals(paseoHome)).toEqual([]);
  },
  30000,
);

it.each(["current", "draining"] as const)(
  "keeps the peer usable when the %s worker dies",
  async (target) => {
    const paseoHome = createTemporaryHome();
    const old = await leaveWorkerWithTerminal(paseoHome, 0);
    manager = await startRealWorkerManager({ paseoHome });
    const added = await manager.createTerminal({
      workspaceId: "ws-peer",
      cwd: old.cwd,
      ...nodeTerminalCommand("setInterval(() => {}, 1000)"),
    });
    const current = (await workerRecords(paseoHome)).find(
      (record) => record.pid !== old.workerPid,
    )!;
    const deadId = target === "current" ? added.id : old.terminalId;
    const healthyId = target === "current" ? old.terminalId : added.id;
    const healthy = manager.getTerminal(healthyId);
    process.kill(target === "current" ? current.pid : old.workerPid, "SIGKILL");
    await waitForCondition(() => !manager!.getTerminal(deadId), 10000);
    expect(manager.getTerminal(healthyId)).toBe(healthy);
    expect(await manager.getTerminalState(healthyId)).not.toBeNull();
    await manager.createTerminal({
      workspaceId: "ws-peer",
      cwd: old.cwd,
      ...nodeTerminalCommand("setInterval(() => {}, 1000)"),
    });
    expect((await workerRecords(paseoHome)).length).toBeLessThanOrEqual(2);
  },
  30000,
);

it("creates a terminal through the worker and streams output", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "worker-terminal-manager-output-"));
  temporaryDirs.push(cwd);
  manager = await startRealWorkerManager();
  const session = trackTerminal(
    await manager.createTerminal({
      workspaceId: "ws-test",
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

it("delivers rapid small writes complete and in order through worker coalescing", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "worker-terminal-manager-coalesce-"));
  temporaryDirs.push(cwd);
  const burstGatePath = join(cwd, "burst-ready");
  manager = await startRealWorkerManager();
  // The file gate starts the burst after this test subscribes without depending
  // on platform-specific PTY input echo/canonical-mode behavior.
  const session = trackTerminal(
    await manager.createTerminal({
      workspaceId: "ws-test",
      cwd,
      env: { PASEO_TERMINAL_BURST_GATE: burstGatePath },
      ...nodeTerminalCommand(`
      const fs = require("node:fs");
      const gatePath = process.env.PASEO_TERMINAL_BURST_GATE;
      const gate = setInterval(() => {
        if (!gatePath || !fs.existsSync(gatePath)) {
          return;
        }
        clearInterval(gate);
        for (let i = 0; i < 500; i++) {
          process.stdout.write("[" + i + "]\\n");
        }
      }, 10);
      setInterval(() => {}, 1000);
    `),
    }),
  );

  const events: Array<{ type: string; data?: string }> = [];
  session.subscribe((message) => {
    if (message.type === "output") {
      events.push({ type: "output", data: message.data });
    } else if (message.type === "snapshot" || message.type === "snapshotReady") {
      events.push({ type: message.type });
    }
  });

  // Let the snapshot subscription settle, then trigger the burst.
  await new Promise((resolve) => setTimeout(resolve, 100));
  writeFileSync(burstGatePath, "go");

  const expected = Array.from({ length: 500 }, (_, index) => index);
  let received: number[] = [];
  await waitForCondition(async () => {
    const snapshot = await manager!.getTerminalState(session.id);
    received = snapshot ? readRenderedTokenIndexesFromState(snapshot.state) : [];
    return expected.every((value, index) => received[index] === value);
  }, 10000);

  expect(received).toEqual(expected);

  await waitForCondition(() => events.some((event) => event.type === "output"), 10000);

  // No snapshot may land after output it should have preceded: every snapshot
  // event must come before the first output event.
  const firstOutputIndex = events.findIndex((event) => event.type === "output");
  expect(firstOutputIndex).toBeGreaterThanOrEqual(0);
  const snapshotAfterOutput = events
    .slice(firstOutputIndex + 1)
    .find((event) => event.type === "snapshot" || event.type === "snapshotReady");
  expect(snapshotAfterOutput).toBeUndefined();
});

it("pulls fresh terminal state from the worker authority", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "worker-terminal-manager-state-"));
  temporaryDirs.push(cwd);
  manager = await startRealWorkerManager();
  const session = trackTerminal(
    await manager.createTerminal({
      workspaceId: "ws-test",
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

// Windows ConPTY normalizes away the kitty keyboard escape the child writes, so it
// never reaches the worker's input-mode tracker and the preamble stays empty. The
// preamble-caching contract is verified on Linux/macOS; the daemon's input-mode
// handling runs identically on every platform once the escape is observed.
it.skipIf(isPlatform("win32"))(
  "caches the input-mode replay preamble from the worker after getTerminalState",
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), "worker-terminal-manager-preamble-"));
    temporaryDirs.push(cwd);
    manager = await startRealWorkerManager();
    // \x1b[>1u pushes kitty keyboard flag 1, which the worker's input-mode
    // tracker records and reflects in its replay preamble (\x1b[=1;1u).
    const session = trackTerminal(
      await manager.createTerminal({
        workspaceId: "ws-test",
        cwd,
        ...nodeTerminalCommand(`
      process.stdout.write("\\u001b[>1u");
      setInterval(() => {}, 1000);
    `),
      }),
    );

    await waitForCondition(async () => {
      const snapshot = await manager!.getTerminalState(session.id);
      return snapshot !== null && session.getReplayPreamble() === "\x1b[=1;1u";
    }, 10000);

    expect(session.getReplayPreamble()).toBe("\x1b[=1;1u");
  },
);

it("refreshes cached terminal title after worker title changes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "worker-terminal-manager-title-"));
  temporaryDirs.push(cwd);
  manager = await startRealWorkerManager();
  const session = trackTerminal(
    await manager.createTerminal({
      workspaceId: "ws-test",
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
  manager = await startRealWorkerManager();
  const session = trackTerminal(await manager.createTerminal({ cwd, workspaceId: "ws-test" }));

  session.send({ type: "resize", rows: 10, cols: 40 });
  const snapshot = await manager.getTerminalState(session.id);

  expect(snapshot?.state.rows).toBe(10);
  expect(snapshot?.state.cols).toBe(40);
  expect(session.getState().rows).toBe(10);
  expect(session.getState().cols).toBe(40);
});

it("captures terminal output from the worker authority", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "worker-terminal-manager-capture-"));
  temporaryDirs.push(cwd);
  manager = await startRealWorkerManager();
  const session = trackTerminal(await manager.createTerminal({ cwd, workspaceId: "ws-test" }));

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
    worker,
  });

  worker.emitWorkerMessage({
    type: "terminalCreated",
    terminal: {
      id: "terminal-1",
      name: "Terminal",
      cwd: "/tmp",
      workspaceId: "ws-test",
      activity: { state: "idle", changedAt: 0 },
    },
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
  manager = await startRealWorkerManager();
  const cwd = mkdtempSync(join(tmpdir(), "worker-terminal-manager-env-"));
  temporaryDirs.push(cwd);
  const markerPath = join(cwd, "env.txt");

  manager.registerCwdEnv({
    cwd,
    env: { PASEO_WORKER_TERMINAL_TEST: "worker-env" },
  });
  trackTerminal(
    await manager.createTerminal({
      workspaceId: "ws-test",
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

it("injects parent-minted terminal activity env through the worker", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "worker-terminal-manager-activity-env-"));
  temporaryDirs.push(cwd);
  const envPath = join(cwd, "activity-env.json");
  const activityUrl = "http://127.0.0.1:12345/api/terminal-activity";
  manager = await startRealWorkerManager({
    getTerminalActivityUrl: () => activityUrl,
  });

  const session = trackTerminal(
    await manager.createTerminal({
      workspaceId: "ws-test",
      cwd,
      ...nodeTerminalCommand(`
        require("node:fs").writeFileSync(
          ${JSON.stringify(envPath)},
          JSON.stringify({
            terminalId: process.env.PASEO_TERMINAL_ID,
            token: process.env.PASEO_ACTIVITY_TOKEN,
            url: process.env.PASEO_TERMINAL_ACTIVITY_URL,
            hookCli: process.env.PASEO_HOOK_CLI,
            path: process.env.PATH ?? process.env.Path,
          }),
        );
        setInterval(() => {}, 1000);
      `),
    }),
  );

  await waitForCondition(() => existsSync(envPath), 10000);

  const env = JSON.parse(readFileSync(envPath, "utf8")) as {
    terminalId?: string;
    token?: string;
    url?: string;
    hookCli?: string;
    path?: string;
  };
  const paseoCliBinDir = resolvePaseoCliBinDir();
  const paseoCliPath = resolvePaseoCliExecutablePath();
  expect(paseoCliBinDir).not.toBeNull();
  expect(paseoCliPath).not.toBeNull();
  expect(env.terminalId).toBe(session.id);
  expect(env.token).toEqual(expect.any(String));
  expect(env.token).not.toBe("");
  expect(env.url).toBe(activityUrl);
  expect(env.hookCli).toBe(paseoCliPath);
  expect(manager.validateTerminalActivityToken(session.id, env.token ?? "")).toBe("valid");
  await expect(manager.setTerminalActivity(session.id, "attention")).resolves.toBe(true);
  expect(env.path?.split(delimiter)[0]).toBe(paseoCliBinDir);
});

it("adopts a detached worker's terminals with their activity tokens and keeps them usable", async () => {
  const paseoHome = createTemporaryHome();
  const cwd = mkdtempSync(join(tmpdir(), "worker-terminal-manager-adopt-"));
  temporaryDirs.push(cwd);
  const envPath = join(cwd, "adopt-env.json");
  const first = await startRealWorkerManager({ paseoHome });
  const created = await first.createTerminal({
    workspaceId: "ws-adopt",
    cwd,
    ...nodeTerminalCommand(`
      require("node:fs").writeFileSync(
        ${JSON.stringify(envPath)},
        JSON.stringify({ token: process.env.PASEO_ACTIVITY_TOKEN }),
      );
      process.stdin.on("data", (chunk) => {
        process.stdout.write("adopted-output:" + chunk.toString());
      });
      setInterval(() => {}, 1000);
    `),
  });
  await waitForCondition(() => existsSync(envPath), 10000);
  const { token } = JSON.parse(readFileSync(envPath, "utf8")) as { token: string };

  await first.detach();
  manager = await startRealWorkerManager({ paseoHome });

  const adopted = manager.getTerminal(created.id);
  expect(adopted?.workspaceId).toBe("ws-adopt");
  expect(await manager.getTerminals(cwd)).toHaveLength(1);
  expect(manager.validateTerminalActivityToken(created.id, token)).toBe("valid");
  const messages: string[] = [];
  adopted?.subscribe((message) => {
    if (message.type === "output") messages.push(message.data);
  });
  adopted?.send({ type: "input", data: "after-adopt\r" });
  await waitForCondition(() => messages.join("").includes("adopted-output:after-adopt"), 10000);
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The terminals the worker itself recorded, read from its own record file.
async function recordedTerminalPids(paseoHome: string): Promise<Map<string, number>> {
  const pids = new Map<string, number>();
  const directory = terminalWorkerDirectory(paseoHome);
  for (const name of readdirSync(directory).filter((entry) => /^\d+\.json$/.test(entry))) {
    for (const entry of (await readTerminalWorkerRecord(join(directory, name))).terminals) {
      pids.set(entry.id, entry.pid);
    }
  }
  return pids;
}

it("never adopts a live worker's terminals after a kill cleanup it could not finish, even once the worker rewrites its record", async () => {
  const paseoHome = createTemporaryHome();
  const cwd = mkdtempSync(join(tmpdir(), "worker-terminal-manager-unfinished-kill-"));
  temporaryDirs.push(cwd);
  const first = await startRealWorkerManager({ paseoHome });
  manager = first;
  const ending = await first.createTerminal({
    workspaceId: "ws-unfinished-kill",
    cwd,
    ...nodeTerminalCommand("setInterval(() => {}, 1000);"),
  });
  const remaining = await first.createTerminal({
    workspaceId: "ws-unfinished-kill",
    cwd,
    ...nodeTerminalCommand("setInterval(() => {}, 1000);"),
  });
  const pids = await recordedTerminalPids(paseoHome);
  const endingPid = pids.get(ending.id)!;
  const remainingPid = pids.get(remaining.id)!;

  // A kill cleanup whose process table read fails signals nothing and leaves the worker live.
  const inspector = createTerminalWorkerProcessInspector();
  await expect(
    reapTerminalWorkers({
      paseoHome,
      inspector: { ...inspector, listProcesses: () => Promise.reject(new Error("ps timed out")) },
    }),
  ).rejects.toBeInstanceOf(TerminalCleanupNotConfirmedError);
  await first.detach();
  expect((await readUnconfirmedTerminalCleanup(paseoHome)).length).toBeGreaterThan(0);

  // One terminal ends on its own: the live worker rewrites its record from memory.
  process.kill(endingPid, "SIGKILL");
  await waitForCondition(
    async () => !(await recordedTerminalPids(paseoHome)).has(ending.id),
    10000,
  );
  expect((await readUnconfirmedTerminalCleanup(paseoHome)).length).toBeGreaterThan(0);

  manager = await startRealWorkerManager({ paseoHome });

  expect(manager.getTerminal(remaining.id)).toBeUndefined();
  expect(await manager.getTerminals(cwd)).toEqual([]);
  await waitForCondition(() => !isProcessAlive(remainingPid), 10000);
  expect(await readUnconfirmedTerminalCleanup(paseoHome)).toEqual([]);
});

// The worker's own `ps`, delayed: a program that exits while the worker reads its birth time
// lands its exit in the middle of creation. Only the worker launched while this PATH is set sees
// the shim; the PATH is restored as soon as it is up.
async function startWorkerWithSlowProcessTable(
  delaySeconds: number,
): Promise<DaemonTerminalManager> {
  const realPs = (process.env.PATH ?? "")
    .split(delimiter)
    .map((dir) => join(dir, "ps"))
    .find((candidate) => existsSync(candidate));
  if (!realPs) throw new Error("ps not found on PATH");
  const shimDir = createTemporaryHome();
  writeFileSync(join(shimDir, "ps"), `#!/bin/sh\nsleep ${delaySeconds}\nexec ${realPs} "$@"\n`, {
    mode: 0o755,
  });
  const originalPath = process.env.PATH;
  process.env.PATH = `${shimDir}${delimiter}${originalPath ?? ""}`;
  try {
    return await startRealWorkerManager();
  } finally {
    process.env.PATH = originalPath;
  }
}

async function expectCompletedShortCommand(
  terminalManager: DaemonTerminalManager,
  script: string,
): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "worker-terminal-manager-short-"));
  temporaryDirs.push(cwd);

  const session = await terminalManager.createTerminal({
    workspaceId: "ws-test",
    cwd,
    command: "/bin/sh",
    args: ["-c", script],
  });

  await waitForCondition(() => session.getExitInfo() !== null, 10000);
  expect(session.getExitInfo()?.exitCode).toBe(0);
  expect(terminalManager.getTerminal(session.id)).toBeUndefined();
  expect(await terminalManager.getTerminals(cwd)).toEqual([]);
  expect(await terminalManager.getTerminalState(session.id)).toBeNull();
}

it.skipIf(isPlatform("win32"))(
  "creates a short command that finishes before creation returns, with its exit",
  async () => {
    manager = await startRealWorkerManager();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expectCompletedShortCommand(manager, "echo short; exit 0");
    }
  },
);

it.skipIf(isPlatform("win32"))(
  "publishes the creation before an exit that arrives while the program is being recorded",
  async () => {
    manager = await startWorkerWithSlowProcessTable(0.3);
    await expectCompletedShortCommand(manager, "sleep 0.1; echo short; exit 0");
  },
);

it("starts the default shell through the worker and accepts quoted commands", async () => {
  manager = await startRealWorkerManager();
  const cwd = mkdtempSync(join(tmpdir(), "worker-terminal-manager-shell-"));
  temporaryDirs.push(cwd);
  const markerPath = join(cwd, "shell quoted marker.txt");
  const session = trackTerminal(await manager.createTerminal({ cwd, workspaceId: "ws-test" }));
  const command = [
    "node",
    "-e",
    `"require('node:fs').writeFileSync('shell quoted marker.txt','shell-ok')"`,
  ].join(" ");

  session.send({ type: "input", data: `${command}\r` });

  await expect.poll(() => readFileSync(markerPath, "utf8"), { timeout: 10000 }).toBe("shell-ok");
});

it("lists subdirectory terminals when querying the workspace root", async () => {
  const rootCwd = mkdtempSync(join(tmpdir(), "worker-terminal-manager-subdir-root-"));
  const subdirCwd = join(rootCwd, "apps", "mobile");
  mkdirSync(subdirCwd, { recursive: true });
  temporaryDirs.push(rootCwd);
  manager = await startRealWorkerManager();
  const created = trackTerminal(
    await manager.createTerminal({
      workspaceId: "ws-test",
      cwd: subdirCwd,
      ...nodeTerminalCommand("setInterval(() => {}, 1000);"),
    }),
  );

  const rootTerminals = await manager.getTerminals(rootCwd);

  expect(rootTerminals.map((terminal) => terminal.id)).toEqual([created.id]);
});

it("lists terminals locally without waiting on the worker", async () => {
  const worker = new FakeTerminalWorker();
  manager = createWorkerTerminalManager({
    requestTimeoutMs: 5,
    worker,
  });

  worker.emitWorkerMessage({
    type: "terminalCreated",
    terminal: {
      id: "terminal-root",
      name: "Shell",
      cwd: "/workspace",
      workspaceId: "ws-test",
      activity: { state: "idle", changedAt: 0 },
    },
    state: createTerminalState(),
  });
  worker.emitWorkerMessage({
    type: "terminalCreated",
    terminal: {
      id: "terminal-subdir",
      name: "Shell",
      cwd: "/workspace/apps/mobile",
      workspaceId: "ws-test",
      activity: { state: "idle", changedAt: 0 },
    },
    state: createTerminalState(),
  });

  // The fake worker never answers requests, so a round-trip would reject at the
  // 5ms timeout. A local mirror read must resolve regardless.
  const terminals = await manager.getTerminals("/workspace");

  expect(terminals.map((terminal) => terminal.id).sort()).toEqual([
    "terminal-root",
    "terminal-subdir",
  ]);
  expect(worker.sentMessages.some((message) => message.type === "getTerminals")).toBe(false);
});

it("includes only stamped terminals in workspace-scoped local reads", async () => {
  const worker = new FakeTerminalWorker();
  manager = createWorkerTerminalManager({
    requestTimeoutMs: 5,
    worker,
  });

  worker.emitWorkerMessage({
    type: "terminalCreated",
    terminal: {
      id: "terminal-legacy",
      name: "Legacy",
      cwd: "/workspace",
      workspaceId: "ws-test",
      activity: null,
    },
    state: createTerminalState(),
  });
  worker.emitWorkerMessage({
    type: "terminalCreated",
    terminal: {
      id: "terminal-owned",
      name: "Owned",
      cwd: "/workspace",
      workspaceId: "ws-owned",
      activity: null,
    },
    state: createTerminalState(),
  });
  worker.emitWorkerMessage({
    type: "terminalCreated",
    terminal: {
      id: "terminal-sibling",
      name: "Sibling",
      cwd: "/workspace",
      workspaceId: "ws-sibling",
      activity: null,
    },
    state: createTerminalState(),
  });

  const scoped = await manager.getTerminals("/workspace", { workspaceId: "ws-owned" });
  const unscoped = await manager.getTerminals("/workspace");

  expect(scoped.map((terminal) => terminal.id)).toEqual(["terminal-owned"]);
  expect(unscoped.map((terminal) => terminal.id)).toEqual([
    "terminal-legacy",
    "terminal-owned",
    "terminal-sibling",
  ]);
});

it("rejects non-absolute cwd in getTerminals", async () => {
  const worker = new FakeTerminalWorker();
  manager = createWorkerTerminalManager({
    requestTimeoutMs: 5,
    worker,
  });

  await expect(manager.getTerminals("relative/path")).rejects.toThrow("cwd must be absolute path");
});

it("surfaces worker activity changes via getActivity, onActivityChange, and terminalsChanged", async () => {
  const worker = new FakeTerminalWorker();
  manager = createWorkerTerminalManager({
    requestTimeoutMs: 50,
    worker,
  });

  worker.emitWorkerMessage({
    type: "terminalCreated",
    terminal: {
      id: "terminal-a",
      name: "Shell",
      cwd: "/workspace",
      workspaceId: "ws-test",
      activity: { state: "idle", changedAt: 0 },
    },
    state: createTerminalState(),
  });

  const session = manager.getTerminal("terminal-a");
  expect(session).toBeDefined();
  expect(session!.getActivity()).toEqual({ state: "idle", changedAt: 0 });

  const activityChanges: Array<{
    activity: TerminalActivity | null;
    previous: TerminalActivity | null;
  }> = [];
  const activityTransitions: TerminalActivityTransitionEvent[] = [];
  const terminalsChangedCwds: string[] = [];
  session!.onActivityChange((transition) => {
    activityChanges.push(transition);
  });
  manager.subscribeTerminalActivity((event) => {
    activityTransitions.push(event);
  });
  manager.subscribeTerminalsChanged((event) => {
    terminalsChangedCwds.push(event.cwd);
  });

  const workingActivity = { state: "working" as const, changedAt: 1000 };
  const idleActivity = { state: "idle" as const, changedAt: 0 };
  worker.emitWorkerMessage({
    type: "terminalActivityChange",
    terminalId: "terminal-a",
    activity: workingActivity,
    previous: idleActivity,
  });

  expect(session!.getActivity()).toEqual(workingActivity);
  expect(activityChanges).toEqual([{ activity: workingActivity, previous: idleActivity }]);
  expect(activityTransitions).toEqual([
    {
      terminalId: "terminal-a",
      name: "Shell",
      cwd: "/workspace",
      workspaceId: "ws-test",
      activity: workingActivity,
      previous: idleActivity,
    },
  ]);
  expect(terminalsChangedCwds).toContain("/workspace");
});

it("sets terminal activity through a worker request", async () => {
  const worker = new FakeTerminalWorker();
  manager = createWorkerTerminalManager({
    requestTimeoutMs: 50,
    worker,
  });
  worker.emitWorkerMessage({
    type: "terminalCreated",
    terminal: {
      id: "terminal-a",
      name: "Shell",
      cwd: "/workspace",
      workspaceId: "ws-test",
      activity: null,
    },
    state: createTerminalState(),
  });

  const result = manager.setTerminalActivity("terminal-a", "attention");
  const request = worker.sentMessages.find((message) => message.type === "setActivity");
  expect(request).toMatchObject({
    type: "setActivity",
    terminalId: "terminal-a",
    state: "attention",
  });
  if (!request) {
    throw new Error("setActivity request not sent");
  }
  worker.emitWorkerMessage({ type: "response", requestId: request.requestId, ok: true });

  await expect(result).resolves.toBe(true);
});

it("clears terminal attention through a worker request", async () => {
  const worker = new FakeTerminalWorker();
  manager = createWorkerTerminalManager({
    requestTimeoutMs: 50,
    worker,
  });
  worker.emitWorkerMessage({
    type: "terminalCreated",
    terminal: {
      id: "terminal-a",
      name: "Shell",
      cwd: "/workspace",
      workspaceId: "ws-test",
      activity: { state: "idle", attentionReason: "finished", changedAt: 1000 },
    },
    state: createTerminalState(),
  });

  const result = manager.clearTerminalAttention("terminal-a");
  const request = worker.sentMessages.find((message) => message.type === "clearAttention");
  expect(request).toMatchObject({
    type: "clearAttention",
    terminalId: "terminal-a",
  });
  if (!request) {
    throw new Error("attention clear request not sent");
  }
  worker.emitWorkerMessage({ type: "response", requestId: request.requestId, ok: true });

  await expect(result).resolves.toBe(true);
});

it("clears finished attention on a real terminal", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "worker-terminal-manager-attention-"));
  temporaryDirs.push(cwd);
  manager = await startRealWorkerManager();
  const session = trackTerminal(
    await manager.createTerminal({
      workspaceId: "ws-test",
      cwd,
      ...nodeTerminalCommand("setInterval(() => {}, 1000);"),
    }),
  );

  // A working -> idle transition is how the real tracker records a "finished"
  // attention: { state: "idle", attentionReason: "finished" }. The state is
  // never literally "attention", so a clear that checks state === "attention"
  // would never fire — the bug this reproduces.
  await manager.setTerminalActivity(session.id, "working");
  await manager.setTerminalActivity(session.id, "idle");
  await waitForCondition(
    () => manager?.getTerminal(session.id)?.getActivity()?.attentionReason === "finished",
    5000,
  );

  const cleared = await manager.clearTerminalAttention(session.id);

  expect(cleared).toBe(true);
  await waitForCondition(
    () => manager?.getTerminal(session.id)?.getActivity()?.attentionReason == null,
    5000,
  );
  expect(manager.getTerminal(session.id)?.getActivity()).toEqual({
    state: "idle",
    changedAt: expect.any(Number),
  });
});

it("removes worker terminals after killAndWait", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "worker-terminal-manager-kill-"));
  temporaryDirs.push(cwd);
  manager = await startRealWorkerManager();
  const session = trackTerminal(
    await manager.createTerminal({
      workspaceId: "ws-test",
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

it("produces one terminals-changed snapshot per title change", async () => {
  const worker = new FakeTerminalWorker();
  manager = createWorkerTerminalManager({
    requestTimeoutMs: 50,
    worker,
  });

  worker.emitWorkerMessage({
    type: "terminalCreated",
    terminal: {
      id: "terminal-a",
      name: "Shell",
      cwd: "/workspace",
      workspaceId: "ws-test",
      activity: null,
    },
    state: createTerminalState(),
  });

  const snapshots: Array<{ cwd: string; terminalIds: string[] }> = [];
  manager.subscribeTerminalsChanged((event) => {
    snapshots.push({ cwd: event.cwd, terminalIds: event.terminals.map((t) => t.id) });
  });

  worker.emitWorkerMessage({
    type: "terminalTitleChange",
    terminalId: "terminal-a",
    title: "Updated",
  });

  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]).toEqual({
    cwd: "/workspace",
    terminalIds: ["terminal-a"],
  });
});

it("produces one terminals-changed snapshot and one contribution event per activity change", async () => {
  const worker = new FakeTerminalWorker();
  manager = createWorkerTerminalManager({
    requestTimeoutMs: 50,
    worker,
  });

  worker.emitWorkerMessage({
    type: "terminalCreated",
    terminal: {
      id: "terminal-a",
      name: "Shell",
      cwd: "/workspace",
      workspaceId: "ws-test",
      activity: null,
    },
    state: createTerminalState(),
  });

  const snapshots: Array<{ cwd: string; terminalIds: string[] }> = [];
  manager.subscribeTerminalsChanged((event) => {
    snapshots.push({ cwd: event.cwd, terminalIds: event.terminals.map((t) => t.id) });
  });
  const contributions: TerminalWorkspaceContributionChangedEvent[] = [];
  manager.subscribeTerminalWorkspaceContributionChanged((event) => {
    contributions.push(event);
  });

  const workingActivity = { state: "working" as const, changedAt: 1000 };
  worker.emitWorkerMessage({
    type: "terminalActivityChange",
    terminalId: "terminal-a",
    activity: workingActivity,
    previous: null,
  });

  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]).toEqual({
    cwd: "/workspace",
    terminalIds: ["terminal-a"],
  });
  expect(contributions).toEqual([
    {
      terminalId: "terminal-a",
      cwd: "/workspace",
      workspaceId: "ws-test",
    },
  ]);
});

it("removes a killed worker terminal from terminalExit without duplicate snapshots", async () => {
  const worker = new FakeTerminalWorker();
  manager = createWorkerTerminalManager({
    requestTimeoutMs: 50,
    worker,
  });
  const workingActivity = { state: "working" as const, changedAt: 1000 };

  worker.emitWorkerMessage({
    type: "terminalCreated",
    terminal: {
      id: "terminal-a",
      name: "Shell",
      cwd: "/workspace",
      workspaceId: "ws-test",
      activity: workingActivity,
    },
    state: createTerminalState(),
  });

  const snapshots: Array<{ cwd: string; terminalIds: string[] }> = [];
  manager.subscribeTerminalsChanged((event) => {
    snapshots.push({ cwd: event.cwd, terminalIds: event.terminals.map((terminal) => terminal.id) });
  });
  const contributions: TerminalWorkspaceContributionChangedEvent[] = [];
  manager.subscribeTerminalWorkspaceContributionChanged((event) => {
    contributions.push(event);
  });

  manager.killTerminal("terminal-a");
  const request = worker.sentMessages.find(
    (message) => message.type === "killTerminal" && message.terminalId === "terminal-a",
  );
  if (!request) {
    throw new Error("killTerminal request not sent");
  }
  worker.emitWorkerMessage({ type: "response", requestId: request.requestId, ok: true });

  worker.emitWorkerMessage({
    type: "terminalExit",
    terminalId: "terminal-a",
    info: {
      exitCode: null,
      signal: null,
      lastOutputLines: [],
    },
  });

  expect(manager.getTerminal("terminal-a")).toBeUndefined();
  expect(snapshots).toEqual([{ cwd: "/workspace", terminalIds: [] }]);
  expect(contributions).toEqual([
    {
      terminalId: "terminal-a",
      cwd: "/workspace",
      workspaceId: "ws-test",
    },
  ]);
});

it("does not resurrect a terminal that exited before its create response was handled", async () => {
  const worker = new FakeTerminalWorker();
  manager = createWorkerTerminalManager({
    requestTimeoutMs: 50,
    worker,
  });

  const snapshots: Array<{ cwd: string; terminalIds: string[] }> = [];
  manager.subscribeTerminalsChanged((event) => {
    snapshots.push({ cwd: event.cwd, terminalIds: event.terminals.map((terminal) => terminal.id) });
  });

  const created = manager.createTerminal({
    id: "terminal-a",
    cwd: "/workspace",
    workspaceId: "ws-test",
  });
  const request = worker.sentMessages.find((message) => message.type === "createTerminal");
  if (!request) {
    throw new Error("createTerminal request not sent");
  }

  // The worker delivers all three messages in one tick, so the awaiting
  // createTerminal continuation resumes only after the exit was processed.
  const terminal = {
    id: "terminal-a",
    name: "Shell",
    cwd: "/workspace",
    workspaceId: "ws-test",
    activity: null,
  };
  const state = createTerminalState();
  const exitInfo = { exitCode: 0, signal: null, lastOutputLines: [] };
  worker.emitWorkerMessage({ type: "terminalCreated", terminal, state });
  worker.emitWorkerMessage({
    type: "response",
    requestId: request.requestId,
    ok: true,
    result: { terminal, state },
  });
  worker.emitWorkerMessage({ type: "terminalExit", terminalId: "terminal-a", info: exitInfo });

  const session = await created;

  expect(manager.getTerminal("terminal-a")).toBeUndefined();
  expect(await manager.getTerminals("/workspace")).toEqual([]);
  expect(session.getExitInfo()).toEqual(exitInfo);
  expect(snapshots).toEqual([
    { cwd: "/workspace", terminalIds: ["terminal-a"] },
    { cwd: "/workspace", terminalIds: [] },
  ]);
});

it("replays the exit to a listener attached after a create that lost the race", async () => {
  const worker = new FakeTerminalWorker();
  manager = createWorkerTerminalManager({
    requestTimeoutMs: 50,
    worker,
  });

  const created = manager.createTerminal({
    id: "terminal-a",
    cwd: "/workspace",
    workspaceId: "ws-test",
  });
  const request = worker.sentMessages.find((message) => message.type === "createTerminal");
  if (!request) {
    throw new Error("createTerminal request not sent");
  }

  const terminal = {
    id: "terminal-a",
    name: "Shell",
    cwd: "/workspace",
    workspaceId: "ws-test",
    activity: null,
  };
  const state = createTerminalState();
  const exitInfo = { exitCode: 0, signal: null, lastOutputLines: [] };
  worker.emitWorkerMessage({ type: "terminalCreated", terminal, state });
  worker.emitWorkerMessage({
    type: "response",
    requestId: request.requestId,
    ok: true,
    result: { terminal, state },
  });
  worker.emitWorkerMessage({ type: "terminalExit", terminalId: "terminal-a", info: exitInfo });

  const session = await created;

  // The session controller subscribes only after createTerminal resolves; that
  // subscription is what turns into a terminal_exit for the client.
  const observedExits: Array<{ exitCode: number | null }> = [];
  session.onExit((info) => {
    observedExits.push({ exitCode: info.exitCode });
  });
  await new Promise((resolve) => setImmediate(resolve));

  expect(observedExits).toEqual([{ exitCode: 0 }]);
});

it("rejects createTerminal and registers nothing when the worker cannot start the command", async () => {
  const worker = new FakeTerminalWorker();
  manager = createWorkerTerminalManager({
    requestTimeoutMs: 50,
    worker,
  });

  const snapshots: Array<{ cwd: string; terminalIds: string[] }> = [];
  manager.subscribeTerminalsChanged((event) => {
    snapshots.push({ cwd: event.cwd, terminalIds: event.terminals.map((terminal) => terminal.id) });
  });

  const created = manager.createTerminal({
    id: "terminal-a",
    cwd: "/workspace",
    workspaceId: "ws-test",
    command: "paseo-qa-absent-codex",
  });
  const request = worker.sentMessages.find((message) => message.type === "createTerminal");
  if (!request) {
    throw new Error("createTerminal request not sent");
  }
  worker.emitWorkerMessage({
    type: "response",
    requestId: request.requestId,
    ok: false,
    error: "paseo-qa-absent-codex: command not found",
  });

  await expect(created).rejects.toThrow("paseo-qa-absent-codex: command not found");
  expect(manager.getTerminal("terminal-a")).toBeUndefined();
  expect(await manager.getTerminals("/workspace")).toEqual([]);
  expect(snapshots).toEqual([]);
});

// The live worker records in a home, by worker pid.
async function workerRecords(paseoHome: string): Promise<TerminalWorkerRecord[]> {
  return (await listTerminalWorkerRecords(paseoHome)).flatMap((file) =>
    "record" in file && !file.record.closing ? [file.record] : [],
  );
}

// A worker launched while the override is set reports that protocol version; the variable is
// restored as soon as it is up, so later workers report the build's own.
async function startManagerWithWorkerProtocol(
  paseoHome: string,
  protocolVersion: number,
): Promise<DaemonTerminalManager> {
  const previous = process.env[TERMINAL_WORKER_PROTOCOL_OVERRIDE_ENV];
  process.env[TERMINAL_WORKER_PROTOCOL_OVERRIDE_ENV] = String(protocolVersion);
  try {
    return await startRealWorkerManager({ paseoHome });
  } finally {
    if (previous === undefined) delete process.env[TERMINAL_WORKER_PROTOCOL_OVERRIDE_ENV];
    else process.env[TERMINAL_WORKER_PROTOCOL_OVERRIDE_ENV] = previous;
  }
}

// A terminal running an idle program in a worker that reports `protocolVersion`, left running
// after its daemon lets go (stop --keep-terminals).
async function leaveWorkerWithTerminal(
  paseoHome: string,
  protocolVersion: number,
): Promise<{ terminalId: string; programPid: number; workerPid: number; cwd: string }> {
  const cwd = mkdtempSync(join(tmpdir(), "worker-terminal-manager-protocol-"));
  temporaryDirs.push(cwd);
  const previous = await startManagerWithWorkerProtocol(paseoHome, protocolVersion);
  const session = await previous.createTerminal({
    workspaceId: "ws-protocol",
    cwd,
    ...nodeTerminalCommand("setInterval(() => {}, 1000);"),
  });
  const [record] = await workerRecords(paseoHome);
  await previous.detach();
  return {
    terminalId: session.id,
    programPid: (await recordedTerminalPids(paseoHome)).get(session.id)!,
    workerPid: record!.pid,
    cwd,
  };
}

it("drains a worker one protocol older: it keeps its terminal, new ones open in a second worker, and it exits after its last", async () => {
  const paseoHome = createTemporaryHome();
  const old = await leaveWorkerWithTerminal(paseoHome, 0);

  manager = await startRealWorkerManager({ paseoHome });

  expect(manager.getTerminal(old.terminalId)).toBeDefined();
  const workers = await workerRecords(paseoHome);
  expect(workers).toHaveLength(2);
  const current = workers.find((record) => record.pid !== old.workerPid)!;
  expect(current.protocolVersion).toBe(1);
  const added = await manager.createTerminal({
    workspaceId: "ws-protocol",
    cwd: old.cwd,
    ...nodeTerminalCommand("setInterval(() => {}, 1000);"),
  });
  trackTerminal(added);
  const currentTerminals = (
    await readTerminalWorkerRecord(join(terminalWorkerDirectory(paseoHome), `${current.pid}.json`))
  ).terminals.map((entry) => entry.id);
  expect(currentTerminals).toEqual([added.id]);
  expect((await manager.getTerminals(old.cwd)).map((session) => session.id).sort()).toEqual(
    [old.terminalId, added.id].sort(),
  );

  await manager.killTerminalAndWait(old.terminalId);

  await waitForCondition(() => !isProcessAlive(old.workerPid), 10000);
  expect((await workerRecords(paseoHome)).map((record) => record.pid)).toEqual([current.pid]);
  expect(manager.getTerminal(added.id)).toBeDefined();
});

it("shuts down a worker two protocol versions old, closing its terminals", async () => {
  const paseoHome = createTemporaryHome();
  const old = await leaveWorkerWithTerminal(paseoHome, -1);

  manager = await startRealWorkerManager({ paseoHome });

  await waitForCondition(
    () => !isProcessAlive(old.workerPid) && !isProcessAlive(old.programPid),
    10000,
  );
  expect(manager.getTerminal(old.terminalId)).toBeUndefined();
  const workers = await workerRecords(paseoHome);
  expect(workers).toHaveLength(1);
  expect(workers[0]!.protocolVersion).toBe(1);
});

it("leaves a worker from a newer Paseo running, reports it incompatible, and closes it on a kill stop", async () => {
  const paseoHome = createTemporaryHome();
  const newer = await leaveWorkerWithTerminal(paseoHome, 2);

  manager = await startRealWorkerManager({ paseoHome });

  const unavailable = manager.getUnavailableError?.();
  expect(unavailable).toBeInstanceOf(TerminalWorkerIncompatibleError);
  expect(unavailable?.message).toContain("worker protocol 2");
  await expect(manager.getTerminals(newer.cwd)).rejects.toBeInstanceOf(
    TerminalWorkerIncompatibleError,
  );
  await expect(
    manager.createTerminal({ workspaceId: "ws-protocol", cwd: newer.cwd }),
  ).rejects.toBeInstanceOf(TerminalWorkerIncompatibleError);
  expect(isProcessAlive(newer.programPid)).toBe(true);
  expect((await workerRecords(paseoHome)).map((record) => record.pid)).toEqual([newer.workerPid]);

  await manager.closeTerminals();

  expect(isProcessAlive(newer.workerPid)).toBe(false);
  expect(isProcessAlive(newer.programPid)).toBe(false);
  expect(await workerRecords(paseoHome)).toEqual([]);
});

// A worker launched on its own, as two daemons that each started one would leave it: running an
// idle program in a terminal, with no daemon attached.
async function launchDetachedWorkerWithTerminal(
  paseoHome: string,
  protocolVersion?: number,
): Promise<{ terminalId: string; workerPid: number; cwd: string }> {
  const cwd = mkdtempSync(join(tmpdir(), "worker-terminal-manager-detached-"));
  temporaryDirs.push(cwd);
  const previous = process.env[TERMINAL_WORKER_PROTOCOL_OVERRIDE_ENV];
  if (protocolVersion !== undefined) {
    process.env[TERMINAL_WORKER_PROTOCOL_OVERRIDE_ENV] = String(protocolVersion);
  }
  let launched: Awaited<ReturnType<typeof launchTerminalWorker>>;
  try {
    launched = await launchTerminalWorker({ paseoHome, paseoVersion: "0.0.0-test" });
  } finally {
    if (previous === undefined) delete process.env[TERMINAL_WORKER_PROTOCOL_OVERRIDE_ENV];
    else process.env[TERMINAL_WORKER_PROTOCOL_OVERRIDE_ENV] = previous;
  }
  const worker = createWorkerTerminalManager({
    worker: await connectTerminalWorker({
      socketPath: launched.record.socketPath,
      secret: launched.record.secret,
    }),
  });
  const session = await worker.createTerminal({
    workspaceId: "ws-detached",
    cwd,
    ...nodeTerminalCommand("setInterval(() => {}, 1000);"),
  });
  await worker.detach();
  return { terminalId: session.id, workerPid: launched.record.pid, cwd };
}

// Worker pids alive in a home, from every record, closing ones included.
async function liveWorkerPids(paseoHome: string): Promise<number[]> {
  return (await listTerminalWorkerRecords(paseoHome))
    .flatMap((file) => ("record" in file ? [file.record.pid] : []))
    .filter(isProcessAlive)
    .sort();
}

it.skipIf(isPlatform("win32"))(
  "counts live workers whose cleanup could not be confirmed and never starts a third",
  async () => {
    const paseoHome = createTemporaryHome();
    const first = await launchDetachedWorkerWithTerminal(paseoHome);
    const second = await launchDetachedWorkerWithTerminal(paseoHome);
    // A kill cleanup that cannot read the process table signals nothing: both workers keep
    // running with their records marked closing.
    const inspector = createTerminalWorkerProcessInspector();
    await expect(
      reapTerminalWorkers({
        paseoHome,
        gracefulMs: 0,
        inspector: { ...inspector, listProcesses: () => Promise.reject(new Error("ps timed out")) },
      }),
    ).rejects.toBeInstanceOf(TerminalCleanupNotConfirmedError);
    expect((await readUnconfirmedTerminalCleanup(paseoHome)).map((entry) => entry.role)).toContain(
      "worker",
    );

    // The daemon's own retry fails the same way: only the full process table is unreadable.
    const realPs = (process.env.PATH ?? "")
      .split(delimiter)
      .map((dir) => join(dir, "ps"))
      .find((candidate) => existsSync(candidate));
    if (!realPs) throw new Error("ps not found on PATH");
    const shimDir = createTemporaryHome();
    writeFileSync(
      join(shimDir, "ps"),
      `#!/bin/sh\nif [ "$1" = "-A" ]; then echo "process table unavailable" >&2; exit 1; fi\nexec ${realPs} "$@"\n`,
      { mode: 0o755 },
    );
    const originalPath = process.env.PATH;
    process.env.PATH = `${shimDir}${delimiter}${originalPath ?? ""}`;
    try {
      manager = await startRealWorkerManager({ paseoHome });
    } finally {
      process.env.PATH = originalPath;
    }

    expect(await liveWorkerPids(paseoHome)).toEqual([first.workerPid, second.workerPid].sort());
    await expect(
      manager.createTerminal({ workspaceId: "ws-detached", cwd: first.cwd }),
    ).rejects.toThrow("2 terminal workers are already running");
    expect(await liveWorkerPids(paseoHome)).toEqual([first.workerPid, second.workerPid].sort());
  },
);

it("opens new terminals in a new worker once one of two draining workers exits", async () => {
  const paseoHome = createTemporaryHome();
  const first = await launchDetachedWorkerWithTerminal(paseoHome, 0);
  const second = await launchDetachedWorkerWithTerminal(paseoHome, 0);

  manager = await startRealWorkerManager({ paseoHome });

  expect(await liveWorkerPids(paseoHome)).toEqual([first.workerPid, second.workerPid].sort());
  await expect(
    manager.createTerminal({ workspaceId: "ws-detached", cwd: first.cwd }),
  ).rejects.toBeInstanceOf(NoTerminalWorkerAvailableError);

  await manager.killTerminalAndWait(first.terminalId);
  await waitForCondition(() => !isProcessAlive(first.workerPid), 10000);

  // Concurrent creates start one worker between them.
  const created = await Promise.all(
    [0, 1].map(() =>
      manager!.createTerminal({
        workspaceId: "ws-detached",
        cwd: first.cwd,
        ...nodeTerminalCommand("setInterval(() => {}, 1000);"),
      }),
    ),
  );
  created.forEach(trackTerminal);
  const workers = await workerRecords(paseoHome);
  expect(workers.map((record) => record.pid).sort()).toEqual(await liveWorkerPids(paseoHome));
  expect(workers).toHaveLength(2);
  const started = workers.find((record) => record.pid !== second.workerPid)!;
  expect(started.protocolVersion).toBe(1);
  expect(
    (
      await readTerminalWorkerRecord(
        join(terminalWorkerDirectory(paseoHome), `${started.pid}.json`),
      )
    ).terminals
      .map((entry) => entry.id)
      .sort(),
  ).toEqual(created.map((session) => session.id).sort());
  expect(manager.getTerminal(second.terminalId)).toBeDefined();
});
