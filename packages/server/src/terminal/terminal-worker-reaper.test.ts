import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isPlatform } from "../test-utils/platform.js";
import { currentBootId } from "../server/pid-lock.js";
import {
  createTerminalWorkerProcessInspector,
  type TerminalWorkerProcessInspector,
} from "./terminal-worker-processes.js";
import { reapTerminalWorkers, TerminalCleanupNotConfirmedError } from "./terminal-worker-reaper.js";
import {
  readTerminalWorkerRecord,
  terminalWorkerRecordPath,
  writeTerminalWorkerRecord,
  type TerminalWorkerRecord,
} from "./terminal-worker-record.js";

// Real throwaway processes stand in for workers and terminal programs, so every signal the
// reaper sends lands on a process this test started. Nothing here uses invented pids.

const inspector = createTerminalWorkerProcessInspector();
const children: ChildProcess[] = [];
const extraPids: number[] = [];
const temporaryDirs: string[] = [];

function spawnIdle(script = "setInterval(() => {}, 1e9)"): ChildProcess {
  const child = spawn(process.execPath, ["-e", script], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  children.push(child);
  return child;
}

// A program with one child of its own in a separate process group, so only the descendant walk
// (not the program's group kill) can reach it.
async function spawnProgramWithChild(): Promise<{ program: ChildProcess; childPid: number }> {
  const program = spawnIdle(`
    const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { stdio: "ignore", detached: true });
    process.stdout.write(String(child.pid) + "\\n");
    setInterval(() => {}, 1e9);
  `);
  const childPid = await new Promise<number>((resolve) => {
    program.stdout!.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
  });
  extraPids.push(childPid);
  return { program, childPid };
}

async function birthOf(pid: number): Promise<string> {
  const inspection = await inspector.inspect(pid);
  if (inspection.status !== "alive" || !inspection.snapshot.startedAt) {
    throw new Error(`cannot read birth time of ${pid}`);
  }
  return inspection.snapshot.startedAt;
}

async function goneProcessPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => child.once("exit", resolve));
  return child.pid!;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilGone(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function makeHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "tw-reaper-"));
  temporaryDirs.push(home);
  return home;
}

function writeRecord(
  home: string,
  input: Partial<TerminalWorkerRecord> & Pick<TerminalWorkerRecord, "pid">,
): string {
  const record: TerminalWorkerRecord = {
    recordId: "record-under-test",
    bootId: currentBootId(),
    createdAt: new Date().toISOString(),
    identity: {
      startedAt: "Thu Jan  1 00:00:00 1970",
      commandLine: "node terminal-worker --paseo-terminal-worker record-under-test",
    },
    protocolVersion: 1,
    paseoVersion: "0.0.0-test",
    socketPath: path.join(home, "missing.sock"),
    secret: "not-a-real-secret",
    terminals: [],
    ...input,
  };
  return writeTerminalWorkerRecord(home, record);
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.pid && isAlive(child.pid)) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  }
  for (const pid of extraPids.splice(0)) {
    if (isAlive(pid)) process.kill(pid, "SIGKILL");
  }
  for (const dir of temporaryDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe.skipIf(isPlatform("win32"))("terminal worker reaper", () => {
  it("ends the programs a dead worker left, and their children, then retires the record", async () => {
    const home = makeHome();
    const { program, childPid } = await spawnProgramWithChild();
    const recordPath = writeRecord(home, {
      pid: await goneProcessPid(),
      terminals: [{ id: "t1", pid: program.pid!, startedAt: await birthOf(program.pid!) }],
    });

    const result = await reapTerminalWorkers({ paseoHome: home, inspector });

    await waitUntilGone(program.pid!);
    await waitUntilGone(childPid);
    expect(isAlive(program.pid!)).toBe(false);
    expect(isAlive(childPid)).toBe(false);
    expect(result.signaled).toEqual(expect.arrayContaining([program.pid!, childPid]));
    expect(existsSync(recordPath)).toBe(false);
  });

  it("never signals a live process that reuses the worker pid, but still ends its programs", async () => {
    const home = makeHome();
    const reusedWorkerPid = spawnIdle().pid!;
    const program = spawnIdle();
    writeRecord(home, {
      pid: reusedWorkerPid,
      terminals: [{ id: "t1", pid: program.pid!, startedAt: await birthOf(program.pid!) }],
    });

    const result = await reapTerminalWorkers({ paseoHome: home, inspector });

    await waitUntilGone(program.pid!);
    expect(isAlive(program.pid!)).toBe(false);
    expect(isAlive(reusedWorkerPid)).toBe(true);
    expect(result.signaled).not.toContain(reusedWorkerPid);
  });

  it("leaves a program alive when its pid now belongs to a process with another birth time", async () => {
    const home = makeHome();
    const unrelated = spawnIdle();
    const recordPath = writeRecord(home, {
      pid: await goneProcessPid(),
      terminals: [{ id: "t1", pid: unrelated.pid!, startedAt: "Thu Jan  1 00:00:00 1970" }],
    });

    await reapTerminalWorkers({ paseoHome: home, inspector, gracefulMs: 0 });

    expect(isAlive(unrelated.pid!)).toBe(true);
    expect(existsSync(recordPath)).toBe(false);
  });

  it("retires a record from an earlier boot without signaling anything it names", async () => {
    const home = makeHome();
    const program = spawnIdle();
    const recordPath = writeRecord(home, {
      pid: spawnIdle().pid!,
      bootId: null,
      createdAt: "2000-01-01T00:00:00.000Z",
      terminals: [{ id: "t1", pid: program.pid!, startedAt: await birthOf(program.pid!) }],
    });

    await reapTerminalWorkers({ paseoHome: home, inspector });

    expect(isAlive(program.pid!)).toBe(true);
    expect(existsSync(recordPath)).toBe(false);
  });

  it("keeps a record of what it could not inspect and reports cleanup unconfirmed", async () => {
    const home = makeHome();
    const uninspectable = spawnIdle();
    const killable = spawnIdle();
    const failing: TerminalWorkerProcessInspector = {
      inspect: (pid) =>
        pid === uninspectable.pid
          ? Promise.resolve({ status: "error", error: new Error("ps unavailable") })
          : inspector.inspect(pid),
      listProcesses: () => inspector.listProcesses(),
    };
    const workerPid = await goneProcessPid();
    const recordPath = writeRecord(home, {
      pid: workerPid,
      terminals: [
        { id: "t1", pid: uninspectable.pid!, startedAt: await birthOf(uninspectable.pid!) },
        { id: "t2", pid: killable.pid!, startedAt: await birthOf(killable.pid!) },
      ],
    });

    let caught: unknown;
    try {
      await reapTerminalWorkers({ paseoHome: home, inspector: failing, confirmMs: 500 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TerminalCleanupNotConfirmedError);
    expect((caught as TerminalCleanupNotConfirmedError).unresolved).toEqual([
      expect.objectContaining({ pid: uninspectable.pid, reason: "inspection failed" }),
    ]);
    await waitUntilGone(killable.pid!);
    expect(isAlive(killable.pid!)).toBe(false);
    expect(isAlive(uninspectable.pid!)).toBe(true);
    const kept = readTerminalWorkerRecord(recordPath);
    expect(kept.closing).toBe(true);
    expect(kept.terminals.map((entry) => entry.pid)).toEqual([uninspectable.pid]);
    expect(recordPath).toBe(terminalWorkerRecordPath(home, workerPid));
  });

  it("escalates to SIGKILL a program that ignores SIGHUP and SIGTERM", async () => {
    const home = makeHome();
    const stubborn = spawnIdle(`
      process.on("SIGHUP", () => {});
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1e9);
    `);
    writeRecord(home, {
      pid: await goneProcessPid(),
      terminals: [{ id: "t1", pid: stubborn.pid!, startedAt: await birthOf(stubborn.pid!) }],
    });

    await reapTerminalWorkers({ paseoHome: home, inspector });

    await waitUntilGone(stubborn.pid!);
    expect(isAlive(stubborn.pid!)).toBe(false);
  });
});
