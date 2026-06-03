import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { acquirePidLock, getPidLockInfo, releasePidLock, updatePidLock } from "./pid-lock.js";

// Independently derive the real OS start time of a live PID, so the staleness
// tests don't depend on the implementation's own start-time helper.
function realProcessStartIso(pid: number): string {
  const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    env: { ...process.env, LC_ALL: "C" },
    encoding: "utf8",
  }).trim();
  return new Date(out).toISOString();
}

describe("pid-lock ownership", () => {
  test("writes and releases lock for explicit owner pid", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-owner-"));
    const ownerPid = process.pid + 10_000;

    try {
      await (
        acquirePidLock as unknown as (
          home: string,
          sockPath: string | null,
          options: { ownerPid: number },
        ) => Promise<void>
      )(paseoHome, null, { ownerPid });

      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(ownerPid);
      expect(lock?.listen).toBeNull();

      await (
        updatePidLock as unknown as (
          home: string,
          patch: { listen: string },
          options: { ownerPid: number },
        ) => Promise<void>
      )(paseoHome, { listen: "127.0.0.1:6767" }, { ownerPid });

      const updatedLock = await getPidLockInfo(paseoHome);
      expect(updatedLock?.listen).toBe("127.0.0.1:6767");

      await (
        releasePidLock as unknown as (home: string, options: { ownerPid: number }) => Promise<void>
      )(paseoHome, { ownerPid: ownerPid + 1 });
      const lockAfterWrongOwnerRelease = await getPidLockInfo(paseoHome);
      expect(lockAfterWrongOwnerRelease?.pid).toBe(ownerPid);

      await (
        releasePidLock as unknown as (home: string, options: { ownerPid: number }) => Promise<void>
      )(paseoHome, { ownerPid });
      const lockAfterOwnerRelease = await getPidLockInfo(paseoHome);
      expect(lockAfterOwnerRelease).toBeNull();
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });
});

describe("pid-lock staleness (PID reuse)", () => {
  test("treats lock as stale when its PID was recycled by a different process", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-reuse-"));

    try {
      // Reproduce the real incident: the lock points at a PID that IS alive
      // (here, this test process — like a recycled `printtool`), but it is not
      // the daemon. Its recorded startedAt is long before that process began.
      const staleLock = {
        pid: process.pid,
        startedAt: "2020-01-01T00:00:00.000Z",
        hostname: hostname(),
        uid: process.getuid?.() ?? 0,
        listen: "127.0.0.1:6767",
      };
      await writeFile(join(paseoHome, "paseo.pid"), JSON.stringify(staleLock));

      const ownerPid = process.pid + 10_000;
      await acquirePidLock(paseoHome, null, { ownerPid });

      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(ownerPid);
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("still rejects when the lock PID is the same live process", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-live-"));

    try {
      // A genuinely-live daemon: its recorded startedAt matches the real OS
      // start time of the PID. The guard must still reject a second acquirer.
      const liveLock = {
        pid: process.pid,
        startedAt: realProcessStartIso(process.pid),
        hostname: hostname(),
        uid: process.getuid?.() ?? 0,
        listen: "127.0.0.1:6767",
      };
      await writeFile(join(paseoHome, "paseo.pid"), JSON.stringify(liveLock));

      const ownerPid = process.pid + 10_000;
      await expect(acquirePidLock(paseoHome, null, { ownerPid })).rejects.toThrow(
        /already running/,
      );
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });
});
