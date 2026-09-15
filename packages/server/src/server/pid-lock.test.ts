import { mkdir, mkdtemp, open, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  acquirePidLock,
  getPidLockInfo,
  isLocked,
  PidLockError,
  type PidLockFileSystem,
  refreshPidLock,
  releasePidLock,
  updatePidLock,
} from "./pid-lock.js";

describe("pid-lock ownership", () => {
  test("writes and releases lock for explicit owner pid", async () => {
    const parent = await mkdtemp(join(tmpdir(), "paseo-pid-lock-owner-"));
    const paseoHome = join(parent, "home");
    const ownerPid = process.pid + 10_000;

    try {
      await (
        acquirePidLock as unknown as (
          home: string,
          sockPath: string | null,
          options: { ownerPid: number },
        ) => Promise<void>
      )(paseoHome, null, { ownerPid });

      if (process.platform !== "win32") {
        expect((await stat(paseoHome)).mode & 0o777).toBe(0o700);
      }
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
      await rm(parent, { recursive: true, force: true });
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

  test("preserves a stale live desktop heartbeat lock", async () => {
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

      await expect(
        acquirePidLock(paseoHome, null, { ownerPid: replacementOwnerPid }),
      ).rejects.toThrow("Another Paseo daemon is already running");

      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(process.pid);
      expect(lock?.listen).toBe("127.0.0.1:6767");
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

  test("preserves a stale live legacy desktop lock", async () => {
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

      await expect(
        acquirePidLock(paseoHome, null, { ownerPid: replacementOwnerPid }),
      ).rejects.toThrow("Another Paseo daemon is already running");

      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(process.pid);
      expect(lock?.heartbeat).toBeUndefined();
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
});

describe("pid-lock recovery from a lock file with no readable owner", () => {
  test("acquires the lock after a zero-byte lock file is left behind", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-empty-"));
    const ownerPid = process.pid + 10_000;

    try {
      // What a daemon killed between the exclusive create and the write leaves.
      await writeFile(join(paseoHome, "paseo.pid"), "");

      await acquirePidLock(paseoHome, null, { ownerPid });

      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(ownerPid);
      expect(lock?.heartbeat).toBe(true);
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("acquires the lock after a lock file that parses but has no valid pid", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-truncated-"));
    const ownerPid = process.pid + 10_000;

    try {
      await writeFile(join(paseoHome, "paseo.pid"), JSON.stringify({ pid: 0 }));

      await acquirePidLock(paseoHome, null, { ownerPid });

      expect((await getPidLockInfo(paseoHome))?.pid).toBe(ownerPid);
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("keeps the path and reports the failure when the lock cannot be read at all", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-unreadable-"));

    try {
      // A directory in place of the lock file fails the read for a reason that
      // is not its contents, so it must not be treated as an abandoned lock.
      await mkdir(join(paseoHome, "paseo.pid"));

      await expect(
        acquirePidLock(paseoHome, null, { ownerPid: process.pid + 10_000 }),
      ).rejects.toThrow(PidLockError);

      expect((await stat(join(paseoHome, "paseo.pid"))).isDirectory()).toBe(true);
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });
});

/**
 * The guard that keeps the recovery path from deleting a lock that became
 * valid after it was read: the entry it deletes must still be the entry it
 * decided about. The interleaving itself is a few instructions wide, so the
 * predicate is exercised directly against real files.
 */
describe("pid-lock recovery leaves an entry it no longer recognises", () => {
  /**
   * The recovery path reads the lock through a handle and then deletes the path.
   * Anything that replaces the file in between would be deleted anyway unless the
   * entry is re-checked, and a valid lock deleted underneath its owner is how two
   * daemons end up both believing they hold the path. That window is a few
   * instructions wide, so the filesystem calls are injected to open it on demand.
   */
  function fileSystemWith(overrides: Partial<PidLockFileSystem>): PidLockFileSystem {
    return { open, stat, unlink, ...overrides };
  }

  test("declines to delete a lock whose entry changed since it was read", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-swapped-"));
    try {
      const pidPath = join(paseoHome, "paseo.pid");
      await writeFile(pidPath, "");
      // Something else's entry, standing in for the file that replaced this one
      // between the read and the delete.
      const other = join(paseoHome, "other");
      await writeFile(other, "x");
      const deleted: string[] = [];

      await expect(
        acquirePidLock(paseoHome, null, {
          ownerPid: process.pid + 10_000,
          fileSystem: fileSystemWith({
            stat: async () => await stat(other),
            unlink: async (path) => {
              deleted.push(path);
            },
          }),
        }),
      ).rejects.toThrow(PidLockError);

      expect(deleted).toEqual([]);
      expect((await stat(pidPath)).isFile()).toBe(true);
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  // One field at a time, so each part of the comparison has to be load-bearing on
  // its own: a replacement changes the inode, a fill-in changes size and time, and
  // a move between filesystems changes the device.
  test.each([
    ["device", { dev: 1 }],
    ["inode", { ino: 1 }],
    ["size", { size: 1 }],
    ["modification time", { mtimeMs: 1 }],
  ])("declines when only the %s differs", async (_label, delta) => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-field-"));
    try {
      const pidPath = join(paseoHome, "paseo.pid");
      await writeFile(pidPath, "");
      const deleted: string[] = [];

      await expect(
        acquirePidLock(paseoHome, null, {
          ownerPid: process.pid + 10_000,
          fileSystem: fileSystemWith({
            stat: async (path) => {
              const real = await stat(path);
              const [[field, step]] = Object.entries(delta);
              return Object.assign(real, {
                [field]: (real[field as keyof typeof real] as number) + step,
              });
            },
            unlink: async (path) => {
              deleted.push(path);
            },
          }),
        }),
      ).rejects.toThrow(PidLockError);

      expect(deleted).toEqual([]);
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("deletes the lock when the entry is the one it read", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-same-"));
    const ownerPid = process.pid + 10_000;
    try {
      await writeFile(join(paseoHome, "paseo.pid"), "");
      const deleted: string[] = [];

      await acquirePidLock(paseoHome, null, {
        ownerPid,
        fileSystem: fileSystemWith({
          unlink: async (path) => {
            deleted.push(path);
            await unlink(path);
          },
        }),
      });

      expect(deleted).toEqual([join(paseoHome, "paseo.pid")]);
      expect((await getPidLockInfo(paseoHome))?.pid).toBe(ownerPid);
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("surfaces an unlink failure instead of acquiring over it", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-undeletable-"));
    try {
      await writeFile(join(paseoHome, "paseo.pid"), "");
      const refusal = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });

      await expect(
        acquirePidLock(paseoHome, null, {
          ownerPid: process.pid + 10_000,
          fileSystem: fileSystemWith({
            unlink: async () => {
              throw refusal;
            },
          }),
        }),
      ).rejects.toBe(refusal);
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("treats a vanished entry as already cleared", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-vanished-"));
    const ownerPid = process.pid + 10_000;
    try {
      await writeFile(join(paseoHome, "paseo.pid"), "");

      await acquirePidLock(paseoHome, null, {
        ownerPid,
        fileSystem: fileSystemWith({
          unlink: async (path) => {
            await unlink(path);
            throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
          },
        }),
      });

      expect((await getPidLockInfo(paseoHome))?.pid).toBe(ownerPid);
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });
});
