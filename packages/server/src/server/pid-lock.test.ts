import { mkdtemp, open, readFile, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  acquirePidLock,
  getPidLockInfo,
  isLocked,
  PidLockError,
  refreshPidLock,
  releasePidLock,
  updatePidLock,
} from "./pid-lock.js";

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
      expect(lock?.heartbeat).toBe(true);

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

  test("keeps a stale heartbeat lock when the recorded pid is alive without a reachability check", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-stale-heartbeat-"));
    const replacementOwnerPid = process.pid + 10_000;

    try {
      const pidPath = join(paseoHome, "paseo.pid");
      await writeFile(
        pidPath,
        JSON.stringify({
          pid: process.pid,
          startedAt: "2026-01-01T00:00:00.000Z",
          hostname: "old-host",
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          desktopManaged: true,
          heartbeat: true,
        }),
      );
      const staleTime = new Date(Date.now() - 10 * 60_000);
      await utimes(pidPath, staleTime, staleTime);

      await expect(isLocked(paseoHome)).resolves.toMatchObject({ locked: true });
      await expect(
        acquirePidLock(paseoHome, null, { ownerPid: replacementOwnerPid }),
      ).rejects.toThrow("Another Paseo daemon is already running");

      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(process.pid);
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("reclaims a stale desktop heartbeat lock after desktop confirms the daemon is unreachable", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-stale-desktop-heartbeat-"));
    const replacementOwnerPid = process.pid + 10_000;

    try {
      const pidPath = join(paseoHome, "paseo.pid");
      await writeFile(
        pidPath,
        JSON.stringify({
          pid: process.pid,
          startedAt: "2026-01-01T00:00:00.000Z",
          hostname: "old-host",
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          desktopManaged: true,
          heartbeat: true,
        }),
      );
      const staleTime = new Date(Date.now() - 10 * 60_000);
      await utimes(pidPath, staleTime, staleTime);

      await acquirePidLock(paseoHome, null, {
        ownerPid: replacementOwnerPid,
        reclaimStaleDesktopLock: true,
      });

      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(replacementOwnerPid);
      expect(lock?.listen).toBeNull();
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("keeps a stale live lock written by a pre-heartbeat daemon", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-legacy-live-"));
    const pidPath = join(paseoHome, "paseo.pid");

    try {
      await writeFile(
        pidPath,
        JSON.stringify({
          pid: process.pid,
          startedAt: "2026-01-01T00:00:00.000Z",
          hostname: "old-host",
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          desktopManaged: true,
        }),
      );
      const staleTime = new Date(Date.now() - 10 * 60_000);
      await utimes(pidPath, staleTime, staleTime);

      await expect(
        acquirePidLock(paseoHome, null, { ownerPid: process.pid + 10_000 }),
      ).rejects.toThrow("Another Paseo daemon is already running");

      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(process.pid);
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("reclaims a stale legacy desktop lock after desktop confirms the daemon is unreachable", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-legacy-desktop-"));
    const replacementOwnerPid = process.pid + 10_000;
    const pidPath = join(paseoHome, "paseo.pid");

    try {
      await writeFile(
        pidPath,
        JSON.stringify({
          pid: process.pid,
          startedAt: "2026-01-01T00:00:00.000Z",
          hostname: "old-host",
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          desktopManaged: true,
        }),
      );
      const staleTime = new Date(Date.now() - 10 * 60_000);
      await utimes(pidPath, staleTime, staleTime);

      await acquirePidLock(paseoHome, null, {
        ownerPid: replacementOwnerPid,
        reclaimStaleDesktopLock: true,
      });

      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(replacementOwnerPid);
      expect(lock?.heartbeat).toBe(true);
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("rejects a heartbeat refresh after another supervisor takes ownership", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-refresh-owner-"));

    try {
      await acquirePidLock(paseoHome, null, { ownerPid: process.pid + 10_000 });

      await expect(refreshPidLock(paseoHome, { ownerPid: process.pid })).rejects.toBeInstanceOf(
        PidLockError,
      );
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("retries a heartbeat refresh while its owner is rewriting the lock", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-refresh-rewrite-"));
    const pidPath = join(paseoHome, "paseo.pid");

    try {
      await acquirePidLock(paseoHome, null, { ownerPid: process.pid });
      const lock = await getPidLockInfo(paseoHome);
      expect(lock).not.toBeNull();

      const rewriteHandle = await open(pidPath, "r+");
      await rewriteHandle.truncate(0);

      const refresh = refreshPidLock(paseoHome, { ownerPid: process.pid });
      await new Promise((resolve) => setTimeout(resolve, 250));
      await rewriteHandle.writeFile(JSON.stringify(lock));
      await rewriteHandle.close();

      await expect(refresh).resolves.toBeUndefined();
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("keeps a fresh lock when the recorded pid is alive", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-fresh-heartbeat-"));

    try {
      await writeFile(
        join(paseoHome, "paseo.pid"),
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          hostname: "current-host",
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          desktopManaged: true,
          heartbeat: true,
        }),
      );

      await expect(
        acquirePidLock(paseoHome, null, { ownerPid: process.pid + 10_000 }),
      ).rejects.toThrow("Another Paseo daemon is already running");

      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(process.pid);
      expect(lock?.listen).toBe("127.0.0.1:6767");
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("keeps a recently heartbeating lock when the recorded pid is not visible", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-fresh-unseen-owner-"));
    const unseenOwnerPid = 2_147_483_647;

    try {
      await writeFile(
        join(paseoHome, "paseo.pid"),
        JSON.stringify({
          pid: unseenOwnerPid,
          startedAt: new Date().toISOString(),
          hostname: "shared-host",
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          heartbeat: true,
        }),
      );

      await expect(isLocked(paseoHome)).resolves.toMatchObject({
        locked: true,
        info: { pid: unseenOwnerPid },
      });
      await expect(acquirePidLock(paseoHome, null, { ownerPid: process.pid })).rejects.toThrow(
        "Another Paseo daemon is already running",
      );

      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(unseenOwnerPid);
      expect(lock?.listen).toBe("127.0.0.1:6767");
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("reclaims an unseen owner after its heartbeat grace period expires", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-stale-unseen-owner-"));
    const unseenOwnerPid = 2_147_483_647;
    const replacementOwnerPid = process.pid;

    try {
      const pidPath = join(paseoHome, "paseo.pid");
      await writeFile(
        pidPath,
        JSON.stringify({
          pid: unseenOwnerPid,
          startedAt: "2026-01-01T00:00:00.000Z",
          hostname: "shared-host",
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          heartbeat: true,
        }),
      );
      const staleTime = new Date(Date.now() - 2 * 60_000);
      await utimes(pidPath, staleTime, staleTime);

      await expect(isLocked(paseoHome)).resolves.toMatchObject({ locked: false });
      await acquirePidLock(paseoHome, null, { ownerPid: replacementOwnerPid });

      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(replacementOwnerPid);
      expect(lock?.heartbeat).toBe(true);
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("keeps an unseen owner that refreshes its heartbeat during stale-lock recovery", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-racing-heartbeat-"));
    const unseenOwnerPid = 2_147_483_647;
    const pidPath = join(paseoHome, "paseo.pid");
    let statCalls = 0;

    try {
      await writeFile(
        pidPath,
        JSON.stringify({
          pid: unseenOwnerPid,
          startedAt: "2026-01-01T00:00:00.000Z",
          hostname: "shared-host",
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          heartbeat: true,
        }),
      );
      const staleTime = new Date(Date.now() - 2 * 60_000);
      await utimes(pidPath, staleTime, staleTime);

      await expect(
        acquirePidLock(paseoHome, null, {
          ownerPid: process.pid,
          filesystem: {
            async readTextFile(path) {
              return readFile(path, "utf-8");
            },
            async statMtimeMs(path) {
              const mtimeMs = (await stat(path)).mtimeMs;
              statCalls += 1;
              if (statCalls === 1) {
                const refreshedAt = new Date();
                await utimes(path, refreshedAt, refreshedAt);
              }
              return mtimeMs;
            },
            unlink,
          },
        }),
      ).rejects.toThrow("PID lock changed while checking whether it was abandoned");

      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(unseenOwnerPid);
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });
});
