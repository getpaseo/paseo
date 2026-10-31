import { TerminalInputModeTracker } from "@getpaseo/protocol/terminal-input-mode";
import { encodeTerminalKeyInput } from "@getpaseo/protocol/terminal-key-input";
import type { SubscribeTerminalRequest } from "@getpaseo/protocol/messages";
import { TerminalSessionController } from "./terminal-session-controller.js";
import { SessionDelivery } from "../server/session/owned-subscriptions/index.js";
import {
  decodeTerminalStreamFrame,
  TerminalStreamOpcode,
  type TerminalStreamFrame,
} from "@getpaseo/protocol/binary-frames/index";
import type { SessionOutboundMessage } from "../server/messages.js";
import { createConnection } from "node:net";
import { attachFramedSocket } from "./terminal-worker-frames.js";
import xterm from "@xterm/headless";
import { afterEach, expect, it } from "vitest";
import { isPlatform } from "../test-utils/platform.js";
import { EventEmitter } from "node:events";
import {
  closeSync,
  existsSync,
  openSync,
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
  WorkerTerminalState,
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
  terminalWorkerRecordPath,
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

async function readReplay(manager: DaemonTerminalManager, id: string) {
  const chunks: Uint8Array[] = [];
  const metadata = await manager.replayTerminal(id, undefined, (event) => {
    if (event.type === "data") chunks.push(event.data);
  });
  if (!metadata) return null;
  const terminal = new xterm.Terminal({
    rows: metadata.rows,
    cols: metadata.cols,
    scrollback: 1000,
    allowProposedApi: true,
  });
  await new Promise<void>((resolve) => terminal.write(Buffer.concat(chunks), resolve));
  const buffer = terminal.buffer.active;
  const rows = Array.from({ length: buffer.length }, (_, i) => {
    const line = buffer.getLine(i)!;
    return Array.from({ length: metadata.cols }, (_cell, col) => ({
      char: line.getCell(col)?.getChars() || " ",
    }));
  });
  const state: TerminalState = {
    rows: metadata.rows,
    cols: metadata.cols,
    scrollback: rows.slice(0, buffer.baseY),
    grid: rows.slice(buffer.baseY),
    cursor: { row: buffer.cursorY, col: buffer.cursorX },
  };
  terminal.dispose();
  return { state, revision: metadata.revision };
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

function createTerminalState(): WorkerTerminalState {
  return { rows: 1, cols: 1, hasOutput: false };
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
  options: {
    getTerminalActivityUrl?: () => string | null;
    requestTimeoutMs?: number;
    paseoHome?: string;
  } = {},
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
      return (await readReplay(manager!, terminal.id)) !== null;
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
    const seeds = [
      await launchDetachedWorkerWithTerminal(paseoHome),
      await launchDetachedWorkerWithTerminal(paseoHome),
    ];
    // Exercise an existing seed adopted as current; launch age does not imply draining ownership.
    const [firstAdopted] = await workerRecords(paseoHome);
    const seed = seeds.find((candidate) => candidate.workerPid === firstAdopted!.pid)!;
    manager = await startRealWorkerManager({ paseoHome });
    const added = await manager.createTerminal({
      workspaceId: "ws-peer",
      cwd: seed.cwd,
      ...nodeTerminalCommand("setInterval(() => {}, 1000)"),
    });
    const records = await workerRecords(paseoHome);
    const current = records.find((record) =>
      record.terminals.some((terminal) => terminal.id === added.id),
    )!;
    const draining = records.find((record) => record.pid !== current.pid)!;
    const drainingId = draining.terminals[0]!.id;
    const deadId = target === "current" ? added.id : drainingId;
    const healthyId = target === "current" ? drainingId : added.id;
    const healthy = manager.getTerminal(healthyId);
    expect(healthy).toBeDefined();
    process.kill(target === "current" ? current.pid : draining.pid, "SIGKILL");
    await waitForCondition(() => !manager!.getTerminal(deadId), 10000);
    expect(manager.getTerminal(healthyId)).toBe(healthy);
    expect(await readReplay(manager, healthyId)).not.toBeNull();
    await manager.createTerminal({
      workspaceId: "ws-peer",
      cwd: seed.cwd,
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
  let readinessEvents = 0;
  const unsubscribe = session.subscribe((message) => {
    if (message.type === "output") {
      messages.push(message.data);
    }
    if (message.type === "snapshotReady") {
      readinessEvents += 1;
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(readinessEvents).toBe(1);

  session.send({ type: "input", data: "hello\r" });

  await waitForCondition(() => messages.join("").includes("worker-output:hello"), 10000);
  await new Promise((resolve) => setTimeout(resolve, 100));
  unsubscribe();

  expect(messages.join("")).toContain("worker-output:hello");
  expect(readinessEvents).toBe(1);
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
    } else if (message.type === "snapshotReady") {
      events.push({ type: message.type });
    }
  });

  // Let readiness settle, then trigger the burst.
  await new Promise((resolve) => setTimeout(resolve, 100));
  writeFileSync(burstGatePath, "go");

  const expected = Array.from({ length: 500 }, (_, index) => index);
  let received: number[] = [];
  await waitForCondition(async () => {
    const snapshot = await readReplay(manager!, session.id);
    received = snapshot ? readRenderedTokenIndexesFromState(snapshot.state) : [];
    return expected.every((value, index) => received[index] === value);
  }, 10000);

  expect(received).toEqual(expected);

  await waitForCondition(() => events.some((event) => event.type === "output"), 10000);

  // Readiness precedes the ordered live stream.
  const firstOutputIndex = events.findIndex((event) => event.type === "output");
  expect(firstOutputIndex).toBeGreaterThanOrEqual(0);
  const readinessAfterOutput = events
    .slice(firstOutputIndex + 1)
    .find((event) => event.type === "snapshotReady");
  expect(readinessAfterOutput).toBeUndefined();
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
    const snapshot = await readReplay(manager!, session.id);
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
  "caches input modes from worker output independently of replay capture",
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

    await waitForCondition(() => session.getReplayPreamble() === "\x1b[=1;1u", 10000);
    // Initial shared modes must be ready without a replay response repairing the cache.
    expect(session.getReplayPreamble()).toBe("\x1b[=1;1u");
    expect(await readReplay(manager!, session.id)).not.toBeNull();
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

  expect(session.getTitle()).toBe("Build Output");
});

it("refreshes cached terminal size after worker resize", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "worker-terminal-manager-resize-"));
  temporaryDirs.push(cwd);
  manager = await startRealWorkerManager();
  const session = trackTerminal(await manager.createTerminal({ cwd, workspaceId: "ws-test" }));

  session.send({ type: "resize", rows: 10, cols: 40 });
  const snapshot = await readReplay(manager, session.id);

  expect(snapshot?.state.rows).toBe(10);
  expect(snapshot?.state.cols).toBe(40);
  expect(session.getSize().rows).toBe(10);
  expect(session.getSize().cols).toBe(40);
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

it.each([false, true])(
  "never adopts a live worker's terminals after a kill cleanup it could not finish, even once the worker rewrites its record (held reader: %s)",
  async (holdReader) => {
    const paseoHome = createTemporaryHome();
    const cwd = mkdtempSync(join(tmpdir(), "worker-terminal-manager-unfinished-kill-"));
    temporaryDirs.push(cwd);
    const first = await startRealWorkerManager({ paseoHome });
    manager = first;
    const exitRequestPath = join(cwd, "exit-requested");
    const exitObservedPath = join(cwd, "exit-observed");
    const ending = await first.createTerminal({
      workspaceId: "ws-unfinished-kill",
      cwd,
      ...nodeTerminalCommand(`
      const { existsSync, writeFileSync } = require("node:fs");
      setInterval(() => {
        if (existsSync(${JSON.stringify(exitRequestPath)})) {
          writeFileSync(${JSON.stringify(exitObservedPath)}, "");
          process.exit(0);
        }
      }, 25);
    `),
    });
    const remaining = await first.createTerminal({
      workspaceId: "ws-unfinished-kill",
      cwd,
      ...nodeTerminalCommand("setInterval(() => {}, 1000);"),
    });
    const pids = await recordedTerminalPids(paseoHome);
    const endingPid = pids.get(ending.id)!;
    const remainingPid = pids.get(remaining.id)!;
    const [record] = await workerRecords(paseoHome);

    // A kill cleanup whose process table read fails signals nothing and leaves the worker live.
    const inspector = createTerminalWorkerProcessInspector();
    await expect(
      reapTerminalWorkers({
        paseoHome,
        inspector: {
          ...inspector,
          listProcesses: () => Promise.reject(new Error("ps timed out")),
        },
      }),
    ).rejects.toBeInstanceOf(TerminalCleanupNotConfirmedError);
    expect((await readUnconfirmedTerminalCleanup(paseoHome)).length).toBeGreaterThan(0);

    // Keep an ordinary reader open until the worker delivers the terminal exit.
    // Windows cannot replace the record while this handle is open. The exit must
    // still reach the controller, and publication must recover after release.
    const recordFd = holdReader
      ? openSync(terminalWorkerRecordPath(paseoHome, record!.pid), "r")
      : null;
    try {
      writeFileSync(exitRequestPath, "");
      await waitForCondition(() => first.getTerminal(ending.id) === undefined, 10000);
      expect(existsSync(exitObservedPath)).toBe(true);
      expect(isProcessAlive(endingPid)).toBe(false);
    } finally {
      if (recordFd !== null) closeSync(recordFd);
    }
    await waitForCondition(
      async () => !(await recordedTerminalPids(paseoHome)).has(ending.id),
      10000,
    );
    expect((await readUnconfirmedTerminalCleanup(paseoHome)).length).toBeGreaterThan(0);

    await first.detach();
    manager = await startRealWorkerManager({ paseoHome });

    expect(manager.getTerminal(remaining.id)).toBeUndefined();
    expect(await manager.getTerminals(cwd)).toEqual([]);
    await waitForCondition(() => !isProcessAlive(remainingPid), 10000);
    expect(await readUnconfirmedTerminalCleanup(paseoHome)).toEqual([]);
  },
);

// The worker's own `ps`, delayed: a program that exits while the worker reads its birth time
// lands its exit in the middle of creation. Only the worker launched while this PATH is set sees
// the shim; the PATH is restored as soon as it is up.
async function startWorkerWithSlowProcessTable(
  delaySeconds: number,
  options: { paseoHome?: string; requestTimeoutMs?: number } = {},
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
    return await startRealWorkerManager(options);
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
  expect(await readReplay(terminalManager, session.id)).toBeNull();
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

it.each([1, 4])(
  "hard cuts unreleased worker protocol %s, closing its terminals",
  async (version) => {
    const paseoHome = createTemporaryHome();
    const old = await leaveWorkerWithTerminal(paseoHome, version);

    manager = await startRealWorkerManager({ paseoHome });

    await waitForCondition(
      () => !isProcessAlive(old.workerPid) && !isProcessAlive(old.programPid),
      10000,
    );
    expect(manager.getTerminal(old.terminalId)).toBeUndefined();
    const workers = await workerRecords(paseoHome);
    expect(workers).toHaveLength(1);
    expect(workers[0]!.protocolVersion).toBe(5);
  },
);

it("leaves a worker from a newer Paseo running, reports it incompatible, and closes it on a kill stop", async () => {
  const paseoHome = createTemporaryHome();
  const newer = await leaveWorkerWithTerminal(paseoHome, 6);

  manager = await startRealWorkerManager({ paseoHome });

  const unavailable = manager.getUnavailableError?.();
  expect(unavailable).toBeInstanceOf(TerminalWorkerIncompatibleError);
  expect(unavailable?.message).toContain("worker protocol 6");
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

it("replays bounded ANSI chunks independently of live output and reconstructs the revision cut", async () => {
  const cwd = createTemporaryHome();
  const finishBefore = join(cwd, "finish-before");
  manager = await startRealWorkerManager();
  const session = trackTerminal(
    await manager.createTerminal({
      cwd,
      workspaceId: "ws-replay",
      rows: 8,
      cols: 120,
      ...nodeTerminalCommand(`
      for (let i = 0; i < 800; i++) process.stdout.write("\\x1b[31m" + String(i).padStart(4, "0") + ":" + "x".repeat(100) + "\\x1b[0m\\r\\n");
      require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
        if (line !== "before") { process.stdout.write("LIVE-AFTER-REPLAY\\r\\n"); return; }
        process.stdout.write("PRE-CUT");
        const finish = setInterval(() => {
          if (!require("node:fs").existsSync(${JSON.stringify(finishBefore)})) return;
          clearInterval(finish);
          process.stdout.write("\\r\\n");
        }, 5);
      });
      setInterval(() => {}, 1000);
    `),
    }),
  );
  await waitForCondition(
    async () =>
      (await manager!.captureTerminal(session.id)).lines.some((line) => line.startsWith("0799:")),
    10000,
  );
  const events: string[] = [];
  const replayEvents: string[] = [];
  const liveOutputs: Array<{ data: string; revision?: number }> = [];
  const chunks: Uint8Array[] = [];
  let live = "";
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "output") {
      events.push("live");
      liveOutputs.push(event);
      live += event.data;
    }
  });
  session.send({ type: "input", data: "before\r" });
  await waitForCondition(() => live.includes("PRE-CUT"), 10000);
  // A PTY may deliver the marker and its trailing newline separately. Finish
  // that output before replay, so the two captures must describe the same cut.
  writeFileSync(finishBefore, "");
  await waitForCondition(async () => {
    const { lines } = await manager!.captureTerminal(session.id);
    return lines.at(-2) === "PRE-CUT" && lines.at(-1) === "";
  }, 10000);
  const expected = await manager.captureTerminal(session.id);
  const metadata = await manager.replayTerminal(session.id, undefined, (event) => {
    events.push(event.type);
    replayEvents.push(event.type);
    if (event.type === "begin") session.send({ type: "input", data: "go\r" });
    if (event.type === "data") chunks.push(event.data);
  });
  await waitForCondition(() => live.includes("LIVE-AFTER-REPLAY"), 10000);
  unsubscribe();
  // Existing live observers are independent of replay. Pre-cut output may also be
  // flushed by capture before begin; only the replay events have begin/data/end order.
  expect(events[0]).toBe("live");
  expect(replayEvents[0]).toBe("begin");
  expect(replayEvents.at(-1)).toBe("end");
  expect(replayEvents.slice(1, -1)).toEqual(chunks.map(() => "data"));
  const beforeCut = liveOutputs.filter((output) => output.data.includes("PRE-CUT"));
  const afterCut = liveOutputs.filter((output) => output.data.includes("LIVE-AFTER-REPLAY"));
  expect(beforeCut).toHaveLength(1);
  expect(afterCut).toHaveLength(1);
  expect(beforeCut[0]!.revision).toBeDefined();
  expect(beforeCut[0]!.revision).toBeLessThanOrEqual(metadata!.revision);
  expect(afterCut[0]!.revision).toBeGreaterThan(metadata!.revision);
  expect(live.match(/LIVE-AFTER-REPLAY/g)).toHaveLength(1);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.every((chunk) => chunk.byteLength <= 64 * 1024)).toBe(true);
  expect(metadata?.rows).toBe(8);
  expect(metadata?.cols).toBe(120);
  const terminal = new xterm.Terminal({
    rows: 8,
    cols: 120,
    scrollback: 1000,
    allowProposedApi: true,
  });
  try {
    await new Promise<void>((resolve) => terminal.write(Buffer.concat(chunks), resolve));
    const buffer = terminal.buffer.active;
    expect(
      Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)!.translateToString(true)),
    ).toEqual(expected.lines);
    expect(expected.lines.filter((line) => line.includes("PRE-CUT"))).toHaveLength(1);
    expect(expected.lines.some((line) => line.includes("LIVE-AFTER-REPLAY"))).toBe(false);
    expect(buffer.getLine(0)!.getCell(0)!.getFgColor()).toBe(1);
  } finally {
    terminal.dispose();
  }
});

it("completes a replay larger than the socket budget while a sibling stays usable", async () => {
  const paseoHome = createTemporaryHome();
  const overflowProgress = join(paseoHome, "overflow-progress");
  manager = await startRealWorkerManager({ paseoHome });
  const terminal = trackTerminal(
    await manager.createTerminal({
      cwd: paseoHome,
      workspaceId: "ws-wide",
      rows: 4,
      cols: 1024,
      ...nodeTerminalCommand(`
      const row = Array.from({length: 1000}, (_, i) => "\\x1b[" + (31 + i % 2) + "mX").join("");
      for (let i = 0; i < 900; i++) process.stdout.write(row + "\\r\\n");
      process.stdout.write("READY-WIDE\\r\\n");
      process.stdin.on("data", data => { if (data.toString().includes("small")) { process.stdout.write("SAME-TERMINAL-LIVE\\r\\n"); return; } process.stdout.write("q".repeat(8 * 1024 * 1024) + "\\r\\nRECOVERED-LIVE\\r\\n", () => require("node:fs").writeFileSync(${JSON.stringify(overflowProgress)}, "done")); });
      setInterval(() => {}, 1000);
    `),
    }),
  );
  const siblingProgress = join(paseoHome, "sibling-progress");
  const sibling = trackTerminal(
    await manager.createTerminal({
      cwd: paseoHome,
      workspaceId: "ws-wide",
      ...nodeTerminalCommand(`
        let count = 0;
        process.stdin.on("data", () => {
          count++;
          process.stdout.write((count > 1 ? "z".repeat(1024 * 1024) : "") + "SIBLING-ALIVE\\r\\n", () => require("node:fs").writeFileSync(${JSON.stringify(siblingProgress)}, String(count)));
        });
        setInterval(() => {}, 1000);
      `),
    }),
  );
  await waitForCondition(
    async () =>
      (await manager!.captureTerminal(terminal.id)).lines.some((line) =>
        line.includes("READY-WIDE"),
      ),
    20000,
  );
  const seen: string[] = [];
  const unsubscribe = sibling.subscribe((event) => {
    if (event.type === "output") seen.push(event.data);
  });
  let bytes = 0;
  const metadata = await manager.replayTerminal(terminal.id, undefined, (event) => {
    if (event.type === "data") bytes += event.data.byteLength;
    if (event.type === "begin") {
      sibling.send({ type: "input", data: "go\r" });
    }
  });
  expect(bytes).toBeGreaterThan(4 * 1024 * 1024);
  expect(metadata?.cols).toBe(1024);
  await waitForCondition(() => seen.join("").includes("SIBLING-ALIVE"), 10000);
  unsubscribe();
  expect(manager.getTerminal(sibling.id)).toBe(sibling);
  const truncated = await manager.replayTerminal(terminal.id, { scrollbackLines: 200 }, () => {});
  expect(metadata!.retainedHistoryLines).toBeGreaterThan(200);
  expect(truncated!.retainedHistoryLines).toBe(metadata!.retainedHistoryLines);
  const concurrent = await Promise.all(
    [0, 1].map(() => manager!.replayTerminal(terminal.id, { scrollbackLines: 200 }, () => {})),
  );
  expect(concurrent.map((replay) => replay!.retainedHistoryLines)).toEqual([
    metadata!.retainedHistoryLines,
    metadata!.retainedHistoryLines,
  ]);
  await manager.detach();
  const [record] = await workerRecords(paseoHome);
  const socket = createConnection(record!.socketPath);
  let began = false;
  let ended = false;
  let completed = false;
  let resumedBytes = 0;
  let cancelledReplayBegan = false;
  let existingLiveOutput = "";
  const replayOrder: string[] = [];
  const framed = attachFramedSocket(socket, (value) => {
    const message = value as TerminalWorkerToParentMessage | { type: "helloAck" };
    if (
      message.type === "terminalMessage" &&
      message.terminalId === terminal.id &&
      message.message.type === "output"
    ) {
      existingLiveOutput += message.message.data;
      replayOrder.push("live");
    }
    if (message.type === "helloAck") {
      framed.send({ type: "replayTerminal", terminalId: terminal.id, requestId: "stalled-replay" });
    } else if (message.type === "terminalReplay") {
      if (message.requestId === "cancelled-replay") {
        if (message.event.type === "begin") {
          cancelledReplayBegan = true;
          socket.pause();
        }
        return;
      }
      if (message.event.type === "begin") {
        began = true;
        socket.pause();
      }
      if (message.event.type === "data") resumedBytes += message.event.data.byteLength;
      if (message.event.type === "end") {
        ended = true;
        replayOrder.push("end");
      }
    } else if (message.type === "response" && message.requestId === "stalled-replay")
      completed = message.ok;
  });
  try {
    framed.send({ type: "hello", secret: record!.secret, protocolVersion: 5 });
    await waitForCondition(() => began, 10000);
    framed.send({
      type: "send",
      terminalId: terminal.id,
      requestId: "same-terminal-input",
      message: { type: "input", data: "small\r" },
    });
    framed.send({
      type: "send",
      terminalId: sibling.id,
      requestId: "sibling-input",
      message: { type: "input", data: "again\r" },
    });
    await waitForCondition(
      () => existsSync(siblingProgress) && readFileSync(siblingProgress, "utf8") === "2",
      10000,
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(completed).toBe(false);
    expect(socket.destroyed).toBe(false);
    socket.resume();
    await waitForCondition(() => completed, 10000);
    expect(ended).toBe(true);
    expect(resumedBytes).toBe(bytes);
    await waitForCondition(() => existingLiveOutput.includes("SAME-TERMINAL-LIVE"), 10000);
    expect(existingLiveOutput.match(/SAME-TERMINAL-LIVE/g)).toHaveLength(1);
    expect(replayOrder.indexOf("live")).toBeLessThan(replayOrder.indexOf("end"));
    framed.send({ type: "replayTerminal", terminalId: terminal.id, requestId: "cancelled-replay" });
    await waitForCondition(() => cancelledReplayBegan, 10000);
    // Replace a controller while its large replay is socket-paced. The original
    // request must never leak frames or completion onto the replacement connection.
    manager = await startRealWorkerManager({ paseoHome });
    socket.resume();
    await waitForCondition(() => socket.destroyed, 10000);
    expect((await readReplay(manager, terminal.id))?.state.cols).toBe(1024);
  } finally {
    socket.destroy();
  }
  expect(
    (await manager!.captureTerminal(terminal.id)).lines.some((line) => line.includes("READY-WIDE")),
  ).toBe(true);
  const exitingReplay = await manager.replayTerminal(
    terminal.id,
    { scrollbackLines: 200 },
    (event) => {
      if (event.type === "begin") manager!.killTerminal(terminal.id);
    },
  );
  expect(exitingReplay!.cols).toBe(1024);
  await waitForCondition(() => manager!.getTerminal(terminal.id) === undefined, 10000);
  expect(manager.getTerminal(sibling.id)?.id).toBe(sibling.id);
}, 60000);

function terminalViewers(
  terminalManager: DaemonTerminalManager,
  terminalId: string,
  chunked = true,
  getClientBufferedAmount?: (source: object) => number | null,
) {
  const frames: Array<{ source: object; frame: TerminalStreamFrame }> = [];
  const messages: Array<{ source: object; message: SessionOutboundMessage }> = [];
  let blockedSource: object | null = null;
  let started = false;
  let finish!: (error?: Error) => void;
  const block = new Promise<void>((resolve, reject) => {
    finish = (error) => (error ? reject(error) : resolve());
  });
  const delivery = new SessionDelivery(
    (source, message) => {
      messages.push({ source, message });
    },
    async (source, bytes) => {
      const frame = decodeTerminalStreamFrame(bytes)!;
      frames.push({ source, frame });
      if (
        source === blockedSource &&
        frame.opcode === (chunked ? TerminalStreamOpcode.ReplayBegin : TerminalStreamOpcode.Restore)
      ) {
        started = true;
        await block;
      }
    },
  );
  const controller = new TerminalSessionController({
    terminalManager,
    emit: (message) => {
      delivery.reply(message);
    },
    hasBinaryChannel: () => true,
    supportsChunkedReplay: () => chunked,
    getClientBufferedAmount,
    isPathWithinRoot: () => true,
    sessionLogger: pino({ level: "silent" }),
  });
  return {
    frames,
    messages,
    delivery,
    controller,
    block(source: object) {
      blockedSource = source;
    },
    started: () => started,
    finish,
    async attach(
      source: object,
      requestId: string,
      restore: NonNullable<SubscribeTerminalRequest["restore"]> = {
        mode: "visible-snapshot",
        scrollbackLines: 1000,
      },
    ) {
      delivery.attach(source, true);
      const request = {
        type: "subscribe_terminal_request" as const,
        terminalId,
        requestId,
        restore,
      };
      await delivery.request(source, request, () => controller.dispatch(request, delivery));
    },
    text(source: object) {
      return frames
        .filter((row) => row.source === source && row.frame.opcode === TerminalStreamOpcode.Output)
        .map((row) => Buffer.from(row.frame.payload).toString("utf8"))
        .join("");
    },
    ended(source: object) {
      return messages.filter(
        (row) => row.source === source && row.message.type === "terminal_stream_exit",
      );
    },
    replayed(source: object) {
      return frames.some(
        (row) => row.source === source && row.frame.opcode === TerminalStreamOpcode.ReplayEnd,
      );
    },
  };
}

it("isolates a failed app transport while another viewer of the same terminal stays live", async () => {
  manager = await startRealWorkerManager();
  const session = trackTerminal(
    await manager.createTerminal({
      cwd: createTemporaryHome(),
      workspaceId: "two-viewers",
      ...nodeTerminalCommand(
        'process.stdout.write("READY\\r\\n"); process.stdin.on("data", data => process.stdout.write("ECHO:" + data)); setInterval(() => {}, 1000);',
      ),
    }),
  );
  await waitForCondition(
    async () =>
      (await manager!.captureTerminal(session.id)).lines.some((line) => line.includes("READY")),
    10000,
  );
  const viewers = terminalViewers(manager, session.id);
  const desktop = {},
    phone = {},
    fresh = {};
  try {
    await viewers.attach(desktop, "desktop");
    await waitForCondition(() => viewers.replayed(desktop), 10000);
    await expect(
      manager.replayTerminal(session.id, undefined, () => {
        throw new Error("Consumer cancelled replay");
      }),
    ).rejects.toThrow("Consumer cancelled replay");
    viewers.block(phone);
    await viewers.attach(phone, "phone");
    await waitForCondition(viewers.started, 10000);
    session.send({ type: "input", data: "BEFORE-FAILURE\r" });
    await waitForCondition(() => viewers.text(desktop).includes("ECHO:BEFORE-FAILURE"), 1500);
    expect(viewers.ended(desktop)).toHaveLength(0);
    expect(viewers.ended(phone)).toHaveLength(0);
    viewers.finish(new Error("Phone socket closed"));
    await viewers.delivery.detach(phone);
    expect(viewers.ended(desktop)).toHaveLength(0);
    session.send({ type: "input", data: "AFTER-FAILURE\r" });
    await waitForCondition(() => viewers.text(desktop).includes("ECHO:AFTER-FAILURE"), 10000);
    expect(viewers.ended(desktop)).toHaveLength(0);
    await viewers.attach(fresh, "fresh");
    await waitForCondition(() => viewers.replayed(fresh), 10000);
    expect(manager.getTerminal(session.id)).toBe(session);
  } finally {
    viewers.finish();
    await viewers.delivery.close();
  }
}, 20000);

it("keeps concurrent viewer replays and live output ordered behind slow app delivery", async () => {
  manager = await startRealWorkerManager();
  const session = trackTerminal(
    await manager.createTerminal({
      cwd: createTemporaryHome(),
      workspaceId: "concurrent-delivery",
      ...nodeTerminalCommand(
        'process.stdout.write("READY\\r\\n"); process.stdin.on("data", data => process.stdout.write("ECHO:" + data)); setInterval(() => {}, 1000);',
      ),
    }),
  );
  await waitForCondition(
    async () => (await manager!.captureTerminal(session.id)).lines.join("").includes("READY"),
    10000,
  );
  const viewers = terminalViewers(manager, session.id);
  const desktop = {},
    phone = {},
    concurrent = {};
  try {
    await viewers.attach(desktop, "desktop");
    await waitForCondition(() => viewers.replayed(desktop), 10000);
    viewers.block(phone);
    await viewers.attach(phone, "phone");
    await waitForCondition(viewers.started, 10000);
    await viewers.attach(concurrent, "concurrent");
    await waitForCondition(() => viewers.replayed(concurrent) && viewers.replayed(phone), 10000);
    session.send({ type: "input", data: "DURING-DELIVERY\r" });
    await waitForCondition(
      () =>
        viewers.text(phone).includes("ECHO:DURING-DELIVERY") &&
        viewers.text(desktop).includes("ECHO:DURING-DELIVERY"),
      3000,
    );
    expect(viewers.text(phone).match(/ECHO:DURING-DELIVERY/g)).toHaveLength(1);
    const order = viewers.frames
      .filter((row) => row.source === phone)
      .map((row) => row.frame.opcode);
    expect(order.indexOf(TerminalStreamOpcode.Output)).toBeGreaterThan(
      order.indexOf(TerminalStreamOpcode.ReplayEnd),
    );
    expect(viewers.ended(phone)).toHaveLength(0);
    expect(viewers.ended(desktop)).toHaveLength(0);
  } finally {
    viewers.finish();
    await viewers.delivery.close();
  }
}, 20000);

it.each([true, false])(
  "queues replay independently of app delivery past the worker deadline (chunked=%s)",
  async (chunked) => {
    const paseoHome = createTemporaryHome();
    // Slow program identification belongs to setup, not the replay request deadline.
    // The POSIX shim deterministically exceeds 800 ms; Windows keeps its real OS path.
    manager = isPlatform("win32")
      ? await startRealWorkerManager({ paseoHome })
      : await startWorkerWithSlowProcessTable(1, { paseoHome });
    const created = await manager.createTerminal({
      cwd: paseoHome,
      workspaceId: "slow-delivery",
      ...nodeTerminalCommand(
        'process.stdout.write("READY\\r\\n"); process.stdin.on("data", data => process.stdout.write("ECHO:" + data)); setInterval(() => {}, 1000);',
      ),
    });
    await waitForCondition(
      async () => (await manager!.captureTerminal(created.id)).lines.join("").includes("READY"),
      10000,
    );
    await manager.detach();
    manager = await startRealWorkerManager({ paseoHome, requestTimeoutMs: 800 });
    const session = manager.getTerminal(created.id);
    if (!session) throw new Error("Replay fixture did not adopt its prepared terminal");
    trackTerminal(session);
    const viewers = terminalViewers(manager, session.id, chunked);
    const phone = {};
    viewers.block(phone);
    try {
      await viewers.attach(phone, "slow-phone");
      await waitForCondition(viewers.started, 10000);
      await new Promise((resolve) => setTimeout(resolve, 1100));
      expect(viewers.ended(phone)).toHaveLength(0);
      expect((await manager.captureTerminal(session.id)).lines.join("")).toContain("READY");
      session.send({ type: "input", data: "AFTER-DEADLINE\r" });
      await waitForCondition(() => viewers.text(phone).includes("ECHO:AFTER-DEADLINE"), 3000);
    } finally {
      viewers.finish();
      await viewers.delivery.close();
    }
  },
  20000,
);

it.each(["replacement", "socket-overflow"] as const)(
  "recovers an attached restore viewer after worker %s",
  async (loss) => {
    const paseoHome = createTemporaryHome();
    const drained = join(paseoHome, "burst-drained");
    manager = await startRealWorkerManager({ paseoHome });
    const session = trackTerminal(
      await manager.createTerminal({
        cwd: paseoHome,
        workspaceId: "attached-reconnect",
        ...nodeTerminalCommand(
          `process.stdout.write("RETAINED\\r\\n"); process.stdin.on("data", data => {
            if (data.toString().includes("BURST")) process.stdout.write("x".repeat(12 * 1024 * 1024) + "\\r\\nRETAINED-AFTER-LOSS\\r\\n", () => require("node:fs").writeFileSync(${JSON.stringify(drained)}, "done"));
            else process.stdout.write("ECHO:" + data);
          }); setInterval(() => {}, 1000);`,
        ),
      }),
    );
    await waitForCondition(
      async () => (await manager!.captureTerminal(session.id)).lines.join("").includes("RETAINED"),
      10000,
    );
    const viewers = terminalViewers(manager, session.id);
    const desktop = {};
    try {
      await viewers.attach(desktop, "desktop");
      await waitForCondition(() => viewers.replayed(desktop), 10000);
      viewers.frames.length = 0;
      const [record] = await workerRecords(paseoHome);
      if (loss === "replacement") {
        const competitor = await connectTerminalWorker({
          socketPath: record!.socketPath,
          secret: record!.secret,
        });
        await waitForCondition(() => !competitor.connected, 10000);
      } else {
        session.send({ type: "input", data: "BURST\r" });
        // Stall only the daemon event loop. The detached worker and PTY keep running,
        // filling the bounded worker socket and forcing its disconnect/re-adoption path.
        const stall = new Int32Array(new SharedArrayBuffer(4));
        const deadline = Date.now() + 10000;
        while (!existsSync(drained) && Date.now() < deadline) Atomics.wait(stall, 0, 0, 25);
        expect(existsSync(drained)).toBe(true);
      }
      await waitForCondition(() => viewers.replayed(desktop), 10000);
      const replay = viewers.frames
        .filter((row) => row.frame.opcode === TerminalStreamOpcode.ReplayData)
        .map((row) => Buffer.from(row.frame.payload).toString("utf8"))
        .join("");
      expect(replay).toContain("RETAINED");
      if (loss === "socket-overflow") expect(replay).toContain("RETAINED-AFTER-LOSS");
      expect((await workerRecords(paseoHome)).map((worker) => worker.pid)).toEqual([record!.pid]);
      session.send({ type: "input", data: "RECOVERED\r" });
      await waitForCondition(() => viewers.text(desktop).includes("ECHO:RECOVERED"), 3000);
      expect(viewers.ended(desktop)).toHaveLength(0);
      expect(manager.getTerminal(session.id)).toBe(session);
    } finally {
      await viewers.delivery.close();
    }
  },
  30000,
);

it.each([true, false])(
  "keeps live modes after a replay captured enabled=%s while restoring its own modes first",
  async (enabled) => {
    const on = "\x1b[?1h\x1b[?2004h";
    const off = "\x1b[?1l\x1b[?2004l";
    const captured = enabled ? on : "";
    const latest = enabled ? "" : on;
    const live = (enabled ? off : on) + "MODE-LIVE";
    const worker = new FakeTerminalWorker();
    manager = createWorkerTerminalManager({ worker, requestTimeoutMs: 1000 });
    worker.emitWorkerMessage({
      type: "terminalCreated",
      terminal: {
        id: "mode-terminal",
        name: "Terminal",
        cwd: "/tmp",
        workspaceId: "modes",
        activity: null,
      },
      state: createTerminalState(),
    });
    worker.emitWorkerMessage({
      type: "terminalMessage",
      terminalId: "mode-terminal",
      replayPreamble: captured,
      message: { type: "snapshotReady", revision: 1 },
    });
    const session = manager.getTerminal("mode-terminal")!;
    const viewers = terminalViewers(manager, session.id);
    const restoring = {},
      following = {};
    try {
      await viewers.attach(restoring, "restoring");
      await waitForCondition(
        () => worker.sentMessages.some((message) => message.type === "replayTerminal"),
        1000,
      );
      const request = worker.sentMessages.find((message) => message.type === "replayTerminal")!;
      const metadata = {
        rows: 30,
        cols: 120,
        retainedHistoryLines: 10,
        revision: 1,
        replayPreamble: captured,
      };
      worker.emitWorkerMessage({
        type: "terminalReplay",
        requestId: request.requestId,
        event: { type: "begin", metadata },
      });
      worker.emitWorkerMessage({
        type: "terminalReplay",
        requestId: request.requestId,
        event: { type: "data", data: Buffer.from("CAPTURE-A") },
      });
      worker.emitWorkerMessage({
        type: "terminalMessage",
        terminalId: session.id,
        replayPreamble: latest,
        message: { type: "output", data: live, revision: 2 },
      });
      expect(session.getReplayPreamble()).toBe(latest);
      worker.emitWorkerMessage({
        type: "terminalReplay",
        requestId: request.requestId,
        event: { type: "data", data: Buffer.from("CAPTURE-B") },
      });
      worker.emitWorkerMessage({
        type: "terminalReplay",
        requestId: request.requestId,
        event: { type: "end" },
      });
      worker.emitWorkerMessage({
        type: "response",
        requestId: request.requestId,
        ok: true,
        result: metadata,
      });
      await waitForCondition(() => viewers.text(restoring).includes("MODE-LIVE"), 1000);
      expect(session.getReplayPreamble()).toBe(latest);
      expect(viewers.text(restoring)).toBe(captured + live);
      const sequence = viewers.frames
        .filter((row) => row.source === restoring)
        .map((row) => row.frame.opcode);
      expect(sequence.indexOf(TerminalStreamOpcode.Output)).toBeGreaterThan(
        sequence.indexOf(TerminalStreamOpcode.ReplayEnd),
      );
      const modes = new TerminalInputModeTracker();
      modes.feed(session.getReplayPreamble());
      expect(encodeTerminalKeyInput({ key: "ArrowUp" }, { inputMode: modes.getState() })).toBe(
        enabled ? "\x1b[A" : "\x1bOA",
      );
      expect(modes.getState().bracketedPaste).toBe(!enabled);
      await viewers.attach(following, "live-following", { mode: "live" });
      await waitForCondition(() => latest === "" || viewers.text(following).length > 0, 1000);
      expect(viewers.text(following)).toBe(latest);
      expect(
        worker.sentMessages.filter((message) => message.type === "replayTerminal"),
      ).toHaveLength(1);
    } finally {
      await viewers.delivery.close();
    }
  },
);

it.each([3000, 12050])(
  "retains ten thousand history rows and restores exact demands after %s printed rows",
  async (count) => {
    manager = await startRealWorkerManager();
    const gate = createTemporaryHome();
    const releaseNewline = join(gate, "newline");
    const session = trackTerminal(
      await manager.createTerminal({
        cwd: createTemporaryHome(),
        workspaceId: "ten-thousand",
        rows: 4,
        cols: 80,
        ...nodeTerminalCommand(
          `const fs=require("node:fs");
          const watcher=fs.watch(${JSON.stringify(gate)},()=>{
            if(fs.existsSync(${JSON.stringify(releaseNewline)})){
              watcher.close();process.stdout.write("\\r\\nROWS-COMPLETE");
            }
          });
          for(let i=0;i<${count};i++) process.stdout.write("\\x1b[31mrow-"+String(i).padStart(5,"0")+" 界é🙂\\x1b[0m"+(i===${count}-1?"":"\\r\\n"));
          setInterval(()=>{},1000)`,
        ),
      }),
    );
    await waitForCondition(
      async () =>
        (await manager!.captureTerminal(session.id, { start: -5 })).lines
          .join("")
          .includes("row-" + String(count - 1).padStart(5, "0")),
      15000,
    );
    // A visible final label can precede its trailing CRLF. Hold that transition
    // deliberately, then observe content on the following row before capture.
    writeFileSync(releaseNewline, "release");
    await waitForCondition(
      async () =>
        (await manager!.captureTerminal(session.id, { start: -1 })).lines[0] === "ROWS-COMPLETE",
      15000,
    );
    for (const history of [0, 200, 1000, 10000]) {
      const chunks: Uint8Array[] = [];
      const metadata = await manager.replayTerminal(
        session.id,
        { scrollbackLines: history },
        (event) => {
          if (event.type === "data") chunks.push(event.data);
        },
      );
      expect(metadata).toMatchObject({
        rows: 4,
        cols: 80,
        retainedHistoryLines: Math.min(10000, count - 3),
      });
      expect(chunks.every((chunk) => chunk.byteLength <= 64 * 1024)).toBe(true);
      const restored = new xterm.Terminal({
        rows: 4,
        cols: 80,
        scrollback: 10000,
        allowProposedApi: true,
      });
      try {
        await new Promise<void>((resolve) => restored.write(Buffer.concat(chunks), resolve));
        const buffer = restored.buffer.active;
        const labels = Array.from({ length: buffer.length }, (_, i) =>
          buffer.getLine(i)!.translateToString(true),
        ).filter((line) => line.includes("row-"));
        expect({ row: buffer.cursorY, col: buffer.cursorX }).toEqual({ row: 3, col: 13 });
        expect(buffer.getLine(buffer.length - 1)!.translateToString(true)).toBe("ROWS-COMPLETE");
        expect(labels).toHaveLength(Math.min(count, history + 3));
        expect(labels[0]).toContain("row-" + String(count - labels.length).padStart(5, "0"));
        expect(labels.at(-1)).toContain("row-" + String(count - 1).padStart(5, "0") + " 界é🙂");
      } finally {
        restored.dispose();
      }
    }
  },
  30000,
);

it.each([false, true])(
  "shrinks real ten-thousand-row pressure recovery and preserves reattach (chunked=%s)",
  async (chunked) => {
    manager = await startRealWorkerManager();
    const session = trackTerminal(
      await manager.createTerminal({
        cwd: createTemporaryHome(),
        workspaceId: "pressure-history",
        rows: 4,
        cols: 120,
        ...nodeTerminalCommand(`
      process.stdin.setRawMode(true);
      let row = 0;
      function print(count) {
        for(let i=0;i<count;i++,row++) process.stdout.write("\\x1b[31mrow-" + String(row).padStart(5,"0") + " 界é🙂 " + "log ".repeat(20) + "\\x1b[0m\\r\\n");
      }
      print(12050);
      process.stdout.write("READY\\r\\n");
      process.stdin.on("data", data => {
        if(data.toString().includes("BURST")) { print(4000); process.stdout.write("BURST-DONE\\r\\n"); }
        else process.stdout.write("ECHO:" + data.toString() + "\\r\\n");
      });
      setInterval(()=>{},1000);
    `),
      }),
    );
    await waitForCondition(
      async () =>
        (await manager!.captureTerminal(session.id, { start: -5 })).lines
          .join("")
          .includes("READY"),
      15000,
    );
    const desktop = {},
      phone = {},
      fresh = {};
    let pressure = false;
    const viewers = terminalViewers(manager, session.id, chunked, (source) =>
      source === phone && pressure ? 8 * 1024 * 1024 : 0,
    );
    const restore = { mode: "full-snapshot" as const, scrollbackLines: 10000 };
    function payloads(source: object): Buffer[] {
      const result: Buffer[] = [];
      let chunks: Uint8Array[] = [];
      for (const { source: owner, frame } of viewers.frames) {
        if (owner !== source) continue;
        if (frame.opcode === TerminalStreamOpcode.Restore) result.push(Buffer.from(frame.payload));
        if (frame.opcode === TerminalStreamOpcode.ReplayBegin) chunks = [];
        if (frame.opcode === TerminalStreamOpcode.ReplayData) chunks.push(frame.payload);
        if (frame.opcode === TerminalStreamOpcode.ReplayEnd) result.push(Buffer.concat(chunks));
      }
      return result;
    }
    async function parse(payload: Uint8Array) {
      const receiver = new xterm.Terminal({
        rows: 4,
        cols: 120,
        scrollback: 10000,
        allowProposedApi: true,
      });
      try {
        await new Promise<void>((resolve) => receiver.write(payload, resolve));
        const buffer = receiver.buffer.active;
        return {
          history: buffer.baseY,
          text: Array.from({ length: buffer.length }, (_, i) =>
            buffer.getLine(i)!.translateToString(true),
          ).join("\n"),
        };
      } finally {
        receiver.dispose();
      }
    }
    try {
      await viewers.attach(desktop, "healthy", restore);
      await viewers.attach(phone, "pressured", restore);
      await waitForCondition(
        () => payloads(phone).length === 1 && payloads(desktop).length === 1,
        15000,
      );
      const initial = payloads(phone)[0]!;
      expect((await parse(initial)).history).toBe(10000);
      pressure = true;
      session.send({ type: "input", data: "BURST" });
      await waitForCondition(() => payloads(phone).length >= 2, 15000);
      pressure = false;
      // The final burst marker may belong to the replay cut or to its live tail.
      // Read the same replay/output exchange a renderer sees rather than assuming
      // worker parsing and daemon request scheduling cut the burst at one point.
      async function currentView(source: object) {
        const frames = viewers.frames
          .filter((row) => row.source === source)
          .map((row) => row.frame);
        const start = frames.findLastIndex(
          (frame) =>
            frame.opcode === TerminalStreamOpcode.Restore ||
            frame.opcode === TerminalStreamOpcode.ReplayBegin,
        );
        return parse(
          Buffer.concat(
            frames
              .slice(start)
              .filter(
                (frame) =>
                  frame.opcode === TerminalStreamOpcode.Restore ||
                  frame.opcode === TerminalStreamOpcode.ReplayData ||
                  frame.opcode === TerminalStreamOpcode.Output,
              )
              .map((frame) => frame.payload),
          ),
        );
      }
      await waitForCondition(
        async () =>
          (await currentView(phone)).text.includes("BURST-DONE") &&
          (await currentView(desktop)).text.includes("BURST-DONE"),
        15000,
      );
      const recovery = payloads(phone)[1]!;
      const recovered = await parse(recovery);
      expect(recovered.history).toBe(500);
      expect(recovered.text).toContain("界é🙂");
      for (const source of [phone, desktop]) {
        const indexes = [...(await currentView(source)).text.matchAll(/row-(\d+)/g)].map((match) =>
          Number(match[1]),
        );
        expect(indexes.at(-1)).toBe(16049);
        expect(indexes).toEqual(Array.from({ length: indexes.length }, (_, i) => indexes[0]! + i));
      }
      expect(recovery.byteLength).toBeLessThan(initial.byteLength / 10);
      expect(recovery.byteLength).toBeLessThan(256 * 1024);
      expect(payloads(desktop)).toHaveLength(1); // The healthy peer keeps its full replay and live stream.
      session.send({ type: "input", data: "AFTER-CATCH-UP" });
      await waitForCondition(
        () =>
          viewers.text(phone).includes("ECHO:AFTER-CATCH-UP") &&
          viewers.text(desktop).includes("ECHO:AFTER-CATCH-UP"),
        10000,
      );
      expect(viewers.text(phone).match(/ECHO:AFTER-CATCH-UP/g)).toHaveLength(1);
      expect(viewers.text(desktop).match(/ECHO:AFTER-CATCH-UP/g)).toHaveLength(1);
      await viewers.delivery.detach(phone);
      await viewers.attach(fresh, "reattach", restore);
      await waitForCondition(() => payloads(fresh).length === 1, 15000);
      const reattached = await parse(payloads(fresh)[0]!);
      expect(reattached.history).toBe(10000);
      expect(reattached.text).toContain("row-16049");
      expect(reattached.text).toContain("ECHO:AFTER-CATCH-UP");
      expect(viewers.ended(desktop)).toHaveLength(0);
      expect(viewers.ended(phone)).toHaveLength(0);
      process.stdout.write(
        JSON.stringify({
          chunked,
          initialBytes: initial.byteLength,
          recoveryBytes: recovery.byteLength,
          reattachBytes: payloads(fresh)[0]!.byteLength,
          retainedHistory: reattached.history,
          recoveryHistory: recovered.history,
        }) + "\n",
      );
    } finally {
      await viewers.delivery.close();
    }
  },
  45000,
);
