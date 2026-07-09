import { open, readFile, stat, unlink, mkdir, utimes } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { z } from "zod";

export const pidLockInfoSchema = z.object({
  pid: z.number(),
  startedAt: z.string(),
  hostname: z.string(),
  uid: z.number(),
  listen: z.string().nullable(),
  desktopManaged: z.boolean().optional(),
});

export interface PidLockInfo extends z.infer<typeof pidLockInfoSchema> {}

function parsePidLockInfo(raw: unknown): PidLockInfo | null {
  const result = pidLockInfoSchema.safeParse(raw);
  return result.success ? result.data : null;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

export class PidLockError extends Error {
  constructor(
    message: string,
    public readonly existingLock?: PidLockInfo,
  ) {
    super(message);
    this.name = "PidLockError";
  }
}

// Stale recovery is for abandoned locks, so keep this well above ordinary event-loop stalls.
const PID_LOCK_STALE_MS = 5 * 60_000;
const PID_LOCK_HEARTBEAT_INTERVAL_MS = 30_000;

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getPidFilePath(paseoHome: string): string {
  return join(paseoHome, "paseo.pid");
}

async function isPidLockFresh(pidPath: string): Promise<boolean> {
  try {
    const lockStat = await stat(pidPath);
    return lockStat.mtimeMs >= Date.now() - PID_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

async function touchPidLockFile(pidPath: string): Promise<void> {
  const now = new Date();
  await utimes(pidPath, now, now);
}

async function readPidLock(pidPath: string): Promise<PidLockInfo | null> {
  try {
    const content = await readFile(pidPath, "utf-8");
    return parsePidLockInfo(JSON.parse(content));
  } catch {
    return null;
  }
}

function resolveOwnerPid(ownerPid?: number): number {
  if (typeof ownerPid === "number" && Number.isInteger(ownerPid) && ownerPid > 0) {
    return ownerPid;
  }
  return process.pid;
}

export async function acquirePidLock(
  paseoHome: string,
  listen: string | null,
  options?: { ownerPid?: number },
): Promise<void> {
  const pidPath = getPidFilePath(paseoHome);

  // Ensure paseoHome directory exists
  if (!existsSync(paseoHome)) {
    await mkdir(paseoHome, { recursive: true });
  }

  // Try to read existing lock
  const existingLock = await readPidLock(pidPath);

  // Check if existing lock is stale
  const lockOwnerPid = resolveOwnerPid(options?.ownerPid);
  if (existingLock) {
    const lockOwnerRunning = isPidRunning(existingLock.pid);
    if (existingLock.pid === lockOwnerPid && lockOwnerRunning) {
      await touchPidLockFile(pidPath);
      return;
    }
    if (lockOwnerRunning && (await isPidLockFresh(pidPath))) {
      throw new PidLockError(
        `Another Paseo daemon is already running (PID ${existingLock.pid}, started ${existingLock.startedAt})`,
        existingLock,
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
    listen,
    ...(process.env.PASEO_DESKTOP_MANAGED === "1" ? { desktopManaged: true } : {}),
  };

  let fd;
  try {
    fd = await open(pidPath, "wx");
    await fd.write(JSON.stringify(lockInfo));
  } catch (err) {
    if (isErrnoException(err) && err.code === "EEXIST") {
      // Race condition - another process created the file
      // Re-read and check
      try {
        const content = await readFile(pidPath, "utf-8");
        const raceLock = parsePidLockInfo(JSON.parse(content));
        if (raceLock) {
          throw new PidLockError(
            `Another Paseo daemon is already running (PID ${raceLock.pid})`,
            raceLock,
          );
        }
        throw new PidLockError("Failed to acquire PID lock due to race condition");
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

export async function refreshPidLock(
  paseoHome: string,
  options?: { ownerPid?: number },
): Promise<void> {
  const pidPath = getPidFilePath(paseoHome);
  const lockOwnerPid = resolveOwnerPid(options?.ownerPid);
  const lock = await readPidLock(pidPath);
  if (!lock) {
    throw new PidLockError("Cannot refresh PID lock: invalid lock file");
  }
  if (lock.pid !== lockOwnerPid) {
    throw new PidLockError(`Cannot refresh PID lock owned by PID ${lock.pid}`, lock);
  }
  await touchPidLockFile(pidPath);
}

export function startPidLockHeartbeat(
  paseoHome: string,
  options?: { ownerPid?: number; intervalMs?: number },
): () => void {
  const intervalMs = options?.intervalMs ?? PID_LOCK_HEARTBEAT_INTERVAL_MS;
  let refreshing = false;

  const timer = setInterval(() => {
    if (refreshing) {
      return;
    }
    refreshing = true;
    refreshPidLock(paseoHome, options)
      .catch(() => undefined)
      .finally(() => {
        refreshing = false;
      });
  }, intervalMs);
  timer.unref();

  return () => clearInterval(timer);
}

export async function updatePidLock(
  paseoHome: string,
  patch: { listen: string },
  options?: { ownerPid?: number },
): Promise<void> {
  const pidPath = getPidFilePath(paseoHome);
  const lockOwnerPid = resolveOwnerPid(options?.ownerPid);
  const content = await readFile(pidPath, "utf-8");
  const existingLock = parsePidLockInfo(JSON.parse(content));
  if (!existingLock) {
    throw new PidLockError("Cannot update PID lock: invalid lock file");
  }

  if (existingLock.pid !== lockOwnerPid) {
    throw new PidLockError(`Cannot update PID lock owned by PID ${existingLock.pid}`, existingLock);
  }

  const updatedLock: PidLockInfo = {
    ...existingLock,
    ...patch,
  };

  const fd = await open(pidPath, "r+");
  try {
    await fd.truncate(0);
    await fd.writeFile(JSON.stringify(updatedLock));
  } finally {
    await fd.close();
  }
}

export async function releasePidLock(
  paseoHome: string,
  options?: { ownerPid?: number },
): Promise<void> {
  const pidPath = getPidFilePath(paseoHome);
  const lockOwnerPid = resolveOwnerPid(options?.ownerPid);
  try {
    // Only remove if it's our lock
    const content = await readFile(pidPath, "utf-8");
    const lock = parsePidLockInfo(JSON.parse(content));
    if (lock?.pid === lockOwnerPid) {
      await unlink(pidPath);
    }
  } catch {
    // Ignore errors - lock may already be gone
  }
}

export async function getPidLockInfo(paseoHome: string): Promise<PidLockInfo | null> {
  const pidPath = getPidFilePath(paseoHome);
  return readPidLock(pidPath);
}

export async function isLocked(
  paseoHome: string,
): Promise<{ locked: boolean; info?: PidLockInfo }> {
  const info = await getPidLockInfo(paseoHome);
  if (!info) {
    return { locked: false };
  }
  const pidPath = getPidFilePath(paseoHome);
  if (!isPidRunning(info.pid) || !(await isPidLockFresh(pidPath))) {
    return { locked: false, info };
  }
  return { locked: true, info };
}
