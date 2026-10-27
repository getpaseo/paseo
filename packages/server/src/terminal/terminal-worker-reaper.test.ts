import { afterEach, describe, expect, it } from "vitest";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { isPlatform } from "../test-utils/platform.js";
import { currentBootId } from "../server/pid-lock.js";
import {
  createTerminalWorkerProcessInspector,
  type TerminalWorkerProcessInspector,
} from "./terminal-worker-processes.js";
import {
  readUnconfirmedTerminalCleanup,
  reapTerminalWorkers,
  retryUnconfirmedTerminalCleanup,
  TerminalCleanupNotConfirmedError,
} from "./terminal-worker-reaper.js";
import {
  readTerminalWorkerRecord,
  terminalCleanupRecordPath,
  terminalWorkerDirectory,
  writeTerminalWorkerRecord,
  type TerminalWorkerRecord,
} from "./terminal-worker-record.js";

// Real throwaway processes stand in for workers and terminal programs, so every signal the
// reaper sends lands on a process this test started. Nothing here uses invented pids.

const inspector = createTerminalWorkerProcessInspector();
const children: ChildProcess[] = [];
const extraPids: number[] = [];
const temporaryDirs: string[] = [];

function spawnIdle(
  script = "setInterval(() => {}, 1e9)",
  env: NodeJS.ProcessEnv = process.env,
): ChildProcess {
  const child = spawn(process.execPath, ["-e", script], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
    env,
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

// A member of the terminal "t1" carries its id, as every program a terminal starts does.
function terminalEnv(terminalId: string): NodeJS.ProcessEnv {
  return { ...process.env, PASEO_TERMINAL_ID: terminalId };
}

// A process's start environment: /proc where the real inspector reads it (Linux), `ps -E` on
// macOS, whose real inspector has no session walk and so never reads one.
function readEnvironment(pid: number): Promise<string[] | null> {
  if (process.platform === "linux") return inspector.readEnvironment(pid);
  return new Promise((resolve) => {
    execFile("ps", ["-E", "-ww", "-o", "command=", "-p", String(pid)], (error, stdout) => {
      resolve(error ? null : stdout.trim().split(/\s+/));
    });
  });
}

// The real process table as a Linux `ps` would print it for one session: `memberPid` belongs to
// the session `sessionId` led, and every other process to none this test knows. macOS `ps` has
// no session column, so this is the only way to run the Linux branch here; the member is a real
// process the test started. `reusedRoot` adds a process that took the session id's pid.
function withSessionMember(input: {
  memberPid: number;
  sessionId: number;
  reusedRoot?: boolean;
  environmentUnreadable?: boolean;
}): TerminalWorkerProcessInspector {
  return {
    reportsSessions: true,
    inspect: (pid) => inspector.inspect(pid),
    listProcesses: async () => {
      // A fresh snapshot each call, so it is rewritten in place.
      const snapshot = await inspector.listProcesses();
      for (const entry of snapshot) {
        entry.sessionId = entry.pid === input.memberPid ? input.sessionId : null;
      }
      if (input.reusedRoot) {
        snapshot.push({
          pid: input.sessionId,
          ppid: 1,
          startedAt: "Fri Jan  1 00:00:00 2100",
          sessionId: input.sessionId,
        });
      }
      return snapshot;
    },
    readEnvironment: (pid) =>
      input.environmentUnreadable
        ? Promise.reject(new Error("permission denied"))
        : readEnvironment(pid),
  };
}

// A record this process cannot open until another thread restores it, the way a worker's
// rename over its record ends a Windows sharing violation. The thread waits for `release()`, then
// restores the record while this thread is still inside the (synchronous) record read.
async function unreadableUntilReleased(
  recordPath: string,
): Promise<{ release: () => void; restored: Promise<void> }> {
  chmodSync(recordPath, 0);
  const signal = new Int32Array(new SharedArrayBuffer(8));
  const thread = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    const signal = new Int32Array(workerData.signal);
    parentPort.postMessage("ready");
    Atomics.wait(signal, 0, 0);
    Atomics.wait(signal, 1, 0, 30);
    require("node:fs").chmodSync(workerData.recordPath, 0o600);
    `,
    { eval: true, workerData: { recordPath, signal: signal.buffer } },
  );
  await new Promise((resolve) => thread.once("message", resolve));
  const restored = new Promise<void>((resolve, reject) => {
    thread.once("exit", () => resolve());
    thread.once("error", reject);
  });
  return {
    release: () => {
      Atomics.store(signal, 0, 1);
      Atomics.notify(signal, 0);
    },
    restored,
  };
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
      reportsSessions: inspector.reportsSessions,
      inspect: (pid) =>
        pid === uninspectable.pid
          ? Promise.resolve({ status: "error", error: new Error("ps unavailable") })
          : inspector.inspect(pid),
      listProcesses: () => inspector.listProcesses(),
      readEnvironment: (pid) => inspector.readEnvironment(pid),
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
    // The closing state goes to the cleanup record; the worker's own record is left as it was.
    const kept = await readTerminalWorkerRecord(
      terminalCleanupRecordPath(home, "record-under-test"),
    );
    expect(kept.pid).toBe(workerPid);
    expect(kept.closing?.unresolved.length).toBeGreaterThan(0);
    expect(kept.terminals.map((entry) => entry.pid)).toEqual([uninspectable.pid]);
    expect((await readTerminalWorkerRecord(recordPath)).closing).toBeUndefined();
  });

  it("ends a session member its gone terminal program left behind, where sessions are reported", async () => {
    const home = makeHome();
    const member = spawnIdle(undefined, terminalEnv("t1"));
    const goneProgramPid = await goneProcessPid();
    const recordPath = writeRecord(home, {
      pid: await goneProcessPid(),
      terminals: [{ id: "t1", pid: goneProgramPid, startedAt: await birthOf(process.pid) }],
    });

    const result = await reapTerminalWorkers({
      paseoHome: home,
      inspector: withSessionMember({ memberPid: member.pid!, sessionId: goneProgramPid }),
    });

    await waitUntilGone(member.pid!);
    expect(isAlive(member.pid!)).toBe(false);
    expect(result.signaled).toContain(member.pid);
    expect(existsSync(recordPath)).toBe(false);
  });

  it("leaves alive a later session that reuses a gone terminal program's session id", async () => {
    const home = makeHome();
    // Born after the recorded program, as any member of a later session is; only the missing
    // terminal id tells it apart.
    const member = spawnIdle(undefined, terminalEnv("another-terminal"));
    const goneProgramPid = await goneProcessPid();
    const recordPath = writeRecord(home, {
      pid: await goneProcessPid(),
      terminals: [{ id: "t1", pid: goneProgramPid, startedAt: "Thu Jan  1 00:00:00 1970" }],
    });

    const result = await reapTerminalWorkers({
      paseoHome: home,
      inspector: withSessionMember({ memberPid: member.pid!, sessionId: goneProgramPid }),
    });

    expect(isAlive(member.pid!)).toBe(true);
    expect(result.signaled).toEqual([]);
    expect(existsSync(recordPath)).toBe(false);
  });

  it("signals no session member it cannot identify, and keeps the cleanup unconfirmed", async () => {
    const home = makeHome();
    const member = spawnIdle(undefined, terminalEnv("t1"));
    const goneProgramPid = await goneProcessPid();
    writeRecord(home, {
      pid: await goneProcessPid(),
      terminals: [{ id: "t1", pid: goneProgramPid, startedAt: "Thu Jan  1 00:00:00 1970" }],
    });

    await expect(
      reapTerminalWorkers({
        paseoHome: home,
        inspector: withSessionMember({
          memberPid: member.pid!,
          sessionId: goneProgramPid,
          environmentUnreadable: true,
        }),
      }),
    ).rejects.toBeInstanceOf(TerminalCleanupNotConfirmedError);

    expect(isAlive(member.pid!)).toBe(true);
    expect(await readUnconfirmedTerminalCleanup(home)).toEqual([
      expect.objectContaining({ pid: goneProgramPid, reason: "inspection failed" }),
    ]);
  });

  it("signals no session member whose environment carries no terminal id, and keeps the cleanup unconfirmed", async () => {
    const home = makeHome();
    // A job started with a scrubbed environment (`env -i`) carries no terminal id at all: it
    // may still be this terminal's, so it is neither signaled nor dismissed as unrelated.
    const member = spawnIdle(undefined, {});
    const goneProgramPid = await goneProcessPid();
    writeRecord(home, {
      pid: await goneProcessPid(),
      terminals: [{ id: "t1", pid: goneProgramPid, startedAt: "Thu Jan  1 00:00:00 1970" }],
    });
    const scrubbedMember = withSessionMember({ memberPid: member.pid!, sessionId: goneProgramPid });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        reapTerminalWorkers({ paseoHome: home, inspector: scrubbedMember }),
      ).rejects.toBeInstanceOf(TerminalCleanupNotConfirmedError);
      expect(isAlive(member.pid!)).toBe(true);
      expect(await readUnconfirmedTerminalCleanup(home)).toEqual([
        expect.objectContaining({
          pid: goneProgramPid,
          reason: "inspection failed",
          detail: expect.stringContaining(`session member ${member.pid}`),
        }),
      ]);
    }
    expect(existsSync(terminalCleanupRecordPath(home, "record-under-test"))).toBe(true);
  });

  it("does not walk a gone terminal program's pid that another process took before the table was read", async () => {
    const home = makeHome();
    const member = spawnIdle(undefined, terminalEnv("t1"));
    const goneProgramPid = await goneProcessPid();
    writeRecord(home, {
      pid: await goneProcessPid(),
      terminals: [{ id: "t1", pid: goneProgramPid, startedAt: "Thu Jan  1 00:00:00 1970" }],
    });

    const result = await reapTerminalWorkers({
      paseoHome: home,
      inspector: withSessionMember({
        memberPid: member.pid!,
        sessionId: goneProgramPid,
        reusedRoot: true,
      }),
    });

    expect(isAlive(member.pid!)).toBe(true);
    expect(result.signaled).toEqual([]);
  });

  // A kill cleanup that meets an unreadable worker record cannot check what it names and
  // leaves nothing else behind, so status and retry must keep reporting it after a respawn.
  it.each([
    ["cleanup", (home: string) => terminalCleanupRecordPath(home, "record-under-test")],
    ["worker", (home: string) => path.join(terminalWorkerDirectory(home), "4242.json")],
  ])("never reports an unreadable %s record as finished", async (_kind, recordPathIn) => {
    const home = makeHome();
    mkdirSync(terminalWorkerDirectory(home), { recursive: true });
    const unreadablePath = recordPathIn(home);
    writeFileSync(unreadablePath, "{ not json");

    for (const attempt of [
      async () => await readUnconfirmedTerminalCleanup(home),
      () => retryUnconfirmedTerminalCleanup(home),
      () => reapTerminalWorkers({ paseoHome: home, inspector }),
    ]) {
      let caught: unknown;
      try {
        await attempt();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(TerminalCleanupNotConfirmedError);
      expect((caught as TerminalCleanupNotConfirmedError).unreadableRecords).toEqual([
        expect.objectContaining({ path: unreadablePath }),
      ]);
    }
    expect(existsSync(unreadablePath)).toBe(true);
  });

  it("signals nothing while the process table cannot be read, so a retry still ends the children", async () => {
    const home = makeHome();
    const { program, childPid } = await spawnProgramWithChild();
    const recordPath = writeRecord(home, {
      pid: await goneProcessPid(),
      terminals: [{ id: "t1", pid: program.pid!, startedAt: await birthOf(program.pid!) }],
    });
    const tableUnavailable: TerminalWorkerProcessInspector = {
      reportsSessions: inspector.reportsSessions,
      inspect: (pid) => inspector.inspect(pid),
      listProcesses: () => Promise.reject(new Error("ps timed out")),
      readEnvironment: (pid) => inspector.readEnvironment(pid),
    };

    await expect(
      reapTerminalWorkers({ paseoHome: home, inspector: tableUnavailable }),
    ).rejects.toBeInstanceOf(TerminalCleanupNotConfirmedError);

    expect(isAlive(program.pid!)).toBe(true);
    expect(isAlive(childPid)).toBe(true);
    const kept = await readTerminalWorkerRecord(
      terminalCleanupRecordPath(home, "record-under-test"),
    );
    expect(kept.closing?.unresolved.length).toBeGreaterThan(0);
    expect(kept.terminals.map((entry) => entry.pid)).toEqual([program.pid]);

    const retry = await reapTerminalWorkers({ paseoHome: home, inspector, gracefulMs: 0 });

    await waitUntilGone(program.pid!);
    await waitUntilGone(childPid);
    expect(isAlive(program.pid!)).toBe(false);
    expect(isAlive(childPid)).toBe(false);
    expect(retry.signaled).toEqual(expect.arrayContaining([program.pid!, childPid]));
    expect(existsSync(recordPath)).toBe(false);
    expect(existsSync(terminalCleanupRecordPath(home, "record-under-test"))).toBe(false);
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

  it.skipIf(process.getuid?.() === 0)(
    "keeps the daemon event loop responsive while status retries an unreadable record",
    async () => {
      const home = makeHome();
      const recordPath = writeRecord(home, { pid: process.pid });
      chmodSync(recordPath, 0);
      let serviced = false;
      setImmediate(() => {
        serviced = true;
      });
      try {
        await expect(
          Promise.resolve().then(() => readUnconfirmedTerminalCleanup(home)),
        ).rejects.toBeInstanceOf(TerminalCleanupNotConfirmedError);
        expect(serviced).toBe(true);
      } finally {
        chmodSync(recordPath, 0o600);
      }
    },
  );

  // chmod cannot make a file unreadable to root.
  describe.skipIf(process.getuid?.() === 0)("a record that cannot be opened for a moment", () => {
    it("still ends a live worker it names, then retires the record", async () => {
      const home = makeHome();
      const worker = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1e9)", "--", "--paseo-terminal-worker", "record-under-test"],
        { detached: true, stdio: "ignore" },
      );
      children.push(worker);
      const recordPath = writeRecord(home, {
        pid: worker.pid!,
        identity: {
          startedAt: await birthOf(worker.pid!),
          commandLine: "node -e --paseo-terminal-worker record-under-test",
        },
      });
      const record = await unreadableUntilReleased(recordPath);

      record.release();
      const result = await reapTerminalWorkers({ paseoHome: home, inspector, gracefulMs: 0 });
      await record.restored;

      await waitUntilGone(worker.pid!);
      expect(isAlive(worker.pid!)).toBe(false);
      expect(result.signaled).toContain(worker.pid!);
      expect(existsSync(recordPath)).toBe(false);
    });

    it("confirms the cleanup of a worker that already exited, then retires the record", async () => {
      const home = makeHome();
      const program = spawnIdle();
      const recordPath = writeRecord(home, {
        pid: await goneProcessPid(),
        terminals: [{ id: "t1", pid: program.pid!, startedAt: await birthOf(program.pid!) }],
      });
      const record = await unreadableUntilReleased(recordPath);

      record.release();
      const result = await reapTerminalWorkers({ paseoHome: home, inspector, gracefulMs: 0 });
      await record.restored;

      await waitUntilGone(program.pid!);
      expect(isAlive(program.pid!)).toBe(false);
      expect(result.retired).toBe(1);
      expect(existsSync(recordPath)).toBe(false);
    });

    it("still reports a record that stays unreadable, and signals nothing it names", async () => {
      const home = makeHome();
      const worker = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1e9)", "--", "--paseo-terminal-worker", "record-under-test"],
        { detached: true, stdio: "ignore" },
      );
      children.push(worker);
      const recordPath = writeRecord(home, {
        pid: worker.pid!,
        identity: {
          startedAt: await birthOf(worker.pid!),
          commandLine: "node -e --paseo-terminal-worker record-under-test",
        },
      });
      chmodSync(recordPath, 0);

      let caught: unknown;
      try {
        await reapTerminalWorkers({ paseoHome: home, inspector, gracefulMs: 0 });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(TerminalCleanupNotConfirmedError);
      expect((caught as TerminalCleanupNotConfirmedError).unreadableRecords).toEqual([
        expect.objectContaining({ path: recordPath, error: expect.stringContaining("EACCES") }),
      ]);
      expect(isAlive(worker.pid!)).toBe(true);
      chmodSync(recordPath, 0o600);
      expect(existsSync(recordPath)).toBe(true);
    });
  });
});
