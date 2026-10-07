import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, uptime } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { readDaemonInstance, stopDaemonInstance } from "./daemon-instance.js";
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

describe("stopDaemonInstance requireLifecycleRpc", () => {
  const children: Array<{ kill: (signal?: NodeJS.Signals) => boolean }> = [];

  afterEach(() => {
    for (const child of children.splice(0)) child.kill("SIGKILL");
    vi.restoreAllMocks();
  });

  test("a refused lifecycle RPC does not fall through to SIGTERM", async () => {
    const home = await mkdtemp(join(tmpdir(), "paseo-idle-stop-"));
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    children.push(child);
    const pid = child.pid;
    if (!pid) throw new Error("sleep child has no pid");
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    const original = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation(((
      target: number,
      signal?: NodeJS.Signals | number,
    ) => {
      signals.push(signal);
      if (signal === "SIGTERM" || signal === "SIGKILL") return true;
      return original(target, signal);
    }) as typeof process.kill);

    try {
      await writeFile(
        join(home, "paseo.pid"),
        JSON.stringify({
          pid,
          startedAt: new Date().toISOString(),
          hostname: "test",
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:9",
        }),
      );

      await expect(
        stopDaemonInstance(home, {
          requireLifecycleRpc: true,
          timeoutMs: 1_000,
          requestShutdown: async () => {
            throw Object.assign(new Error("Agents are busy"), { code: "AGENTS_BUSY" });
          },
        }),
      ).rejects.toThrow(/Agents are busy/);

      expect(signals).not.toContain("SIGTERM");
      expect(signals).not.toContain("SIGKILL");
      expect(original(pid, 0)).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
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
