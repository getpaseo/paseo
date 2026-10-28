import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, uptime } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";

import {
  DaemonInstanceError,
  readDaemonInstance,
  stopDaemonInstance,
  type StopDaemonPorts,
} from "./daemon-instance.js";
import { acquirePidLock, getPidLockInfo, isLocked, type PidLockInfo } from "./pid-lock.js";

// A process cannot have started before the machine booted, so a lock stamped
// before this boot names a PID that some unrelated process now holds.
function bootedAt(): number {
  return Date.now() - uptime() * 1000;
}

async function writeLock(paseoHome: string, lock: PidLockInfo): Promise<void> {
  await writeFile(join(paseoHome, "paseo.pid"), JSON.stringify(lock));
}

function lockFor(pid: number, startedAt: Date): PidLockInfo {
  return {
    pid,
    startedAt: startedAt.toISOString(),
    hostname: "old-host",
    uid: process.getuid?.() ?? 0,
    listen: "127.0.0.1:6767",
    desktopManaged: true,
    heartbeat: true,
  };
}

describe("daemon instance identity across a reboot", () => {
  let paseoHome: string;
  let bystander: ChildProcess | undefined;

  beforeEach(async () => {
    paseoHome = await mkdtemp(join(tmpdir(), "paseo-daemon-instance-"));
  });

  afterEach(async () => {
    bystander?.kill("SIGKILL");
    bystander = undefined;
    await rm(paseoHome, { recursive: true, force: true });
  });

  test("a lock stamped before this boot has no running owner", async () => {
    await writeLock(paseoHome, lockFor(process.pid, new Date(bootedAt() - 60 * 60_000)));

    expect(await readDaemonInstance(paseoHome)).toBeNull();
    expect(await isLocked(paseoHome)).toMatchObject({ locked: false });
  });

  test("a supervisor started during this boot still holds the lock", async () => {
    await writeLock(paseoHome, lockFor(process.pid, new Date()));

    expect(await readDaemonInstance(paseoHome)).toMatchObject({ pid: process.pid });
    expect(await isLocked(paseoHome)).toMatchObject({ locked: true });
  });

  test("a new supervisor takes over a lock stamped before this boot", async () => {
    await writeLock(paseoHome, lockFor(process.pid, new Date(bootedAt() - 60 * 60_000)));

    await acquirePidLock(paseoHome, null, { ownerPid: process.pid + 10_000 });

    expect(await getPidLockInfo(paseoHome)).toMatchObject({ pid: process.pid + 10_000 });
  });

  test("stopping a lock stamped before this boot leaves the process holding that pid alone", async () => {
    // Records delivery rather than dying of it, so a signal cannot be missed by arriving late.
    const signalMarker = join(paseoHome, "bystander-signalled");
    bystander = spawn(
      process.execPath,
      [
        "-e",
        `process.on("SIGTERM", () => require("node:fs").writeFileSync(${JSON.stringify(signalMarker)}, "SIGTERM"));` +
          `setTimeout(() => {}, 120_000);`,
      ],
      { stdio: "ignore" },
    );
    const bystanderPid = bystander.pid;
    if (bystanderPid === undefined) throw new Error("bystander process did not start");
    let exited = false;
    bystander.once("exit", () => {
      exited = true;
    });

    await writeLock(paseoHome, lockFor(bystanderPid, new Date(bootedAt() - 60 * 60_000)));

    expect(await stopDaemonInstance(paseoHome)).toMatchObject({ action: "not_running" });

    expect(existsSync(signalMarker)).toBe(false);
    expect(exited).toBe(false);
    await expect(readFile(join(paseoHome, "paseo.pid"), "utf-8")).rejects.toThrow(/ENOENT/);
  });
});

// Linux keeps a boot's id while a VM is paused for a host sleep, though the VM's wall clock
// runs ahead of its uptime once it resumes. A sleep longer than the time between boot and
// the supervisor's start puts the wall-clock boot instant after the lock's startedAt.
describe.runIf(process.platform === "linux")("daemon instance identity on Linux", () => {
  let paseoHome: string;

  beforeEach(async () => {
    paseoHome = await mkdtemp(join(tmpdir(), "paseo-daemon-instance-linux-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(paseoHome, { recursive: true, force: true });
  });

  test("a supervisor still holds the lock after its paused VM resumes", async () => {
    await acquirePidLock(paseoHome, null, { ownerPid: process.pid });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + uptime() * 1000 + 12 * 60 * 60_000);

    expect(await readDaemonInstance(paseoHome)).toMatchObject({ pid: process.pid });
    expect(await isLocked(paseoHome)).toMatchObject({ locked: true });
    await expect(
      acquirePidLock(paseoHome, null, { ownerPid: process.pid + 10_000 }),
    ).rejects.toThrow("Another Paseo daemon is already running");
  });

  test("a lock written during another boot has no running owner", async () => {
    await writeLock(paseoHome, {
      ...lockFor(process.pid, new Date()),
      bootId: "00000000-0000-0000-0000-000000000000",
    });

    expect(await readDaemonInstance(paseoHome)).toBeNull();
    expect(await isLocked(paseoHome)).toMatchObject({ locked: false });
  });
});
const INSTANCE = {
  pid: 4242,
  startedAt: "2026-01-01T00:00:00.000Z",
  listen: "127.0.0.1:4949",
} as PidLockInfo;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * In-memory stand-in for the daemon environment. `wait` is a controllable gate:
 * each call parks until the test releases it, so abort and exit points are
 * chosen exactly instead of by making timing assumptions. `enteredWait` resolves
 * on the first parked wait, giving the test a deterministic sync point.
 */
function createFakePorts(input?: { instance?: PidLockInfo | null }) {
  const fake = {
    instance: input?.instance === undefined ? ({ ...INSTANCE } as PidLockInfo) : input.instance,
    running: true,
    events: [] as string[],
    enteredWait: deferred<void>(),
    pendingWait: null as { resolve(): void; reject(error: Error): void } | null,
  };
  const ports: StopDaemonPorts = {
    async readInstance() {
      return fake.instance;
    },
    isLockOwnerRunning() {
      return fake.running;
    },
    isSameInstance(left, right) {
      return left.pid === right.pid && left.startedAt === right.startedAt;
    },
    async releaseLock() {
      fake.events.push("release-lock");
      fake.instance = null;
    },
    async signalTerm() {
      // Platform-dependent environment call; not part of the behavior asserted here.
    },
    async killTree() {
      fake.events.push("kill-tree");
      fake.running = false;
    },
    wait(_ms, signal) {
      if (signal?.aborted) {
        return Promise.reject(new DOMException("Aborted", "AbortError"));
      }
      return new Promise<void>((resolve, reject) => {
        const settle = (fn: () => void) => {
          fake.pendingWait = null;
          signal?.removeEventListener("abort", onAbort);
          fn();
        };
        const onAbort = () => settle(() => reject(new DOMException("Aborted", "AbortError")));
        fake.pendingWait = {
          resolve: () => settle(resolve),
          reject: (error: Error) => settle(() => reject(error)),
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        fake.enteredWait.resolve();
      });
    },
  };
  return {
    ports,
    firstWait: fake.enteredWait.promise,
    state: fake,
    resolveWait() {
      fake.pendingWait?.resolve();
    },
  };
}

describe("stopDaemonInstance", () => {
  it("returns cancelled instead of throwing when the signal aborts during the wait", async () => {
    const fake = createFakePorts();
    const controller = new AbortController();
    const stop = stopDaemonInstance("/tmp/home", {
      timeoutMs: 15_000,
      signal: controller.signal,
      ports: fake.ports,
      requestShutdown: async () => {},
    });

    await fake.firstWait;
    controller.abort();
    const result = await stop;

    // `usedLifecycleRpc` differs by platform (Windows uses the shutdown RPC,
    // POSIX sends SIGTERM), so assert the fields this test owns.
    expect(result).toMatchObject({
      action: "cancelled",
      pid: 4242,
      forced: false,
    });
    // A cancelled wait must not release the lock: the daemon may still be alive.
    expect(fake.state.events).toEqual([]);
    expect(fake.state.instance).not.toBeNull();
  });

  it("returns cancelled when the signal aborts while the shutdown RPC is in flight", async () => {
    const fake = createFakePorts();
    const controller = new AbortController();
    const stop = stopDaemonInstance("/tmp/home", {
      timeoutMs: 15_000,
      signal: controller.signal,
      ports: fake.ports,
      // A shutdown RPC that never settles must not block the stop past the
      // deadline: an aborted signal cancels it (Windows) or the wait loop
      // reports the cancellation (POSIX).
      requestShutdown: () => new Promise<void>(() => {}),
    });

    controller.abort();
    const result = await stop;

    expect(result).toMatchObject({
      action: "cancelled",
      pid: 4242,
      forced: false,
    });
    expect(fake.state.events).toEqual([]);
  });

  it("stops once the daemon exits and releases the lock", async () => {
    const fake = createFakePorts();
    const stop = stopDaemonInstance("/tmp/home", {
      timeoutMs: 15_000,
      ports: fake.ports,
      requestShutdown: async () => {},
    });

    await fake.firstWait;
    fake.state.running = false;
    fake.resolveWait();

    const result = await stop;
    expect(result).toMatchObject({
      action: "stopped",
      pid: 4242,
      forced: false,
    });
    expect(fake.state.events).toEqual(["release-lock"]);
  });

  it("reports not_running when no supervisor holds the lock", async () => {
    const fake = createFakePorts({ instance: null });
    const result = await stopDaemonInstance("/tmp/home", { ports: fake.ports });
    expect(result).toEqual({
      action: "not_running",
      pid: null,
      forced: false,
      usedLifecycleRpc: false,
    });
  });

  it("fails with STOP_NOT_CONFIRMED when the daemon never exits before the timeout", async () => {
    const fake = createFakePorts();
    const stop = stopDaemonInstance("/tmp/home", {
      timeoutMs: 0,
      ports: fake.ports,
      requestShutdown: async () => {},
    });

    await expect(stop).rejects.toBeInstanceOf(DaemonInstanceError);
    await expect(stop).rejects.toMatchObject({ code: "STOP_NOT_CONFIRMED" });
    expect(fake.state.events).toEqual([]);
  });
});
