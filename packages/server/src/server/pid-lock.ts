import { open, readFile, unlink, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";

export interface PidLockInfo {
  pid: number;
  startedAt: string;
  hostname: string;
  uid: number;
  sockPath: string;
}

export class PidLockError extends Error {
  constructor(
    message: string,
    public readonly existingLock?: PidLockInfo
  ) {
    super(message);
    this.name = "PidLockError";
  }
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getPidFilePath(junctionHome: string): string {
  return join(junctionHome, "junction.pid");
}

function resolveOwnerPid(ownerPid?: number): number {
  if (typeof ownerPid === "number" && Number.isInteger(ownerPid) && ownerPid > 0) {
    return ownerPid;
  }
  return process.pid;
}

export async function acquirePidLock(
  junctionHome: string,
  sockPath: string,
  options?: { ownerPid?: number }
): Promise<void> {
  const pidPath = getPidFilePath(junctionHome);

  // Ensure junctionHome directory exists
  if (!existsSync(junctionHome)) {
    await mkdir(junctionHome, { recursive: true });
  }

  // Try to read existing lock
  let existingLock: PidLockInfo | null = null;
  try {
    const content = await readFile(pidPath, "utf-8");
    existingLock = JSON.parse(content) as PidLockInfo;
  } catch {
    // No existing lock or invalid JSON - that's fine
  }

  // Check if existing lock is stale
  const lockOwnerPid = resolveOwnerPid(options?.ownerPid);
  if (existingLock) {
    if (isPidRunning(existingLock.pid)) {
      if (existingLock.pid === lockOwnerPid) {
        return;
      }

      throw new PidLockError(
        `Another Junction daemon is already running (PID ${existingLock.pid}, started ${existingLock.startedAt})`,
        existingLock
      );
    }
    // Stale lock - remove it
    await unlink(pidPath).catch(() => {});
  }

  // Create new lock with exclusive flag
  const lockInfo: PidLockInfo = {
    pid: lockOwnerPid,
    startedAt: new Date().toISOString(),
    hostname: hostname(),
    uid: process.getuid?.() ?? 0,
    sockPath,
  };

  let fd;
  try {
    fd = await open(pidPath, "wx");
    await fd.write(JSON.stringify(lockInfo));
  } catch (err: any) {
    if (err.code === "EEXIST") {
      // Race condition - another process created the file
      // Re-read and check
      try {
        const content = await readFile(pidPath, "utf-8");
        const raceLock = JSON.parse(content) as PidLockInfo;
        throw new PidLockError(
          `Another Junction daemon is already running (PID ${raceLock.pid})`,
          raceLock
        );
      } catch (innerErr) {
        if (innerErr instanceof PidLockError) throw innerErr;
        throw new PidLockError("Failed to acquire PID lock due to race condition");
      }
    }
    throw err;
  } finally {
    await fd?.close();
  }
}

export async function releasePidLock(
  junctionHome: string,
  options?: { ownerPid?: number }
): Promise<void> {
  const pidPath = getPidFilePath(junctionHome);
  const lockOwnerPid = resolveOwnerPid(options?.ownerPid);
  try {
    // Only remove if it's our lock
    const content = await readFile(pidPath, "utf-8");
    const lock = JSON.parse(content) as PidLockInfo;
    if (lock.pid === lockOwnerPid) {
      await unlink(pidPath);
    }
  } catch {
    // Ignore errors - lock may already be gone
  }
}

export async function getPidLockInfo(
  junctionHome: string
): Promise<PidLockInfo | null> {
  const pidPath = getPidFilePath(junctionHome);
  try {
    const content = await readFile(pidPath, "utf-8");
    return JSON.parse(content) as PidLockInfo;
  } catch {
    return null;
  }
}

export async function isLocked(
  junctionHome: string
): Promise<{ locked: boolean; info?: PidLockInfo }> {
  const info = await getPidLockInfo(junctionHome);
  if (!info) {
    return { locked: false };
  }
  if (!isPidRunning(info.pid)) {
    return { locked: false, info };
  }
  return { locked: true, info };
}
