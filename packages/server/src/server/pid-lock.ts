import { execFileSync } from "node:child_process";
import { open, readFile, unlink, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { z } from "zod";

// The OS reuses PIDs. A stale lock left by an unclean daemon shutdown can name a
// PID the OS has since handed to an unrelated process, so a bare "is this PID
// alive?" check is not enough to prove the daemon is still running. If the live
// process started materially later than the lock was written, the PID was
// recycled and the lock is stale. lstart is second-granularity and the lock is
// written a beat after the daemon starts, so a genuine daemon's two timestamps
// sit within a few seconds; a recycled PID differs by the daemon's whole lifetime.
const PID_REUSE_TOLERANCE_MS = 60_000;

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

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Wall-clock start time of a live process, or null if it can't be determined
// (process gone, or `ps` unavailable e.g. on Windows). `ps -o lstart` is the
// portable keyword present on both macOS (BSD) and Linux; LC_ALL=C forces an
// English, Date.parse-able timestamp regardless of the user's locale.
function getProcessStartTimeMs(pid: number): number | null {
  try {
    const output = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
    }).trim();
    if (!output) {
      return null;
    }
    const parsed = Date.parse(output);
    return Number.isNaN(parsed) ? null : parsed;
  } catch {
    return null;
  }
}

// Whether the lock's PID still belongs to the daemon that wrote the lock, as
// opposed to an unrelated process that inherited the PID after reuse.
function isLockProcessAlive(lock: PidLockInfo): boolean {
  if (!isPidRunning(lock.pid)) {
    return false;
  }
  const liveStartMs = getProcessStartTimeMs(lock.pid);
  const lockStartMs = Date.parse(lock.startedAt);
  if (liveStartMs === null || Number.isNaN(lockStartMs)) {
    // Can't compare start times — stay conservative and assume the daemon is
    // still running rather than risk launching a second one.
    return true;
  }
  return Math.abs(liveStartMs - lockStartMs) <= PID_REUSE_TOLERANCE_MS;
}

function getPidFilePath(paseoHome: string): string {
  return join(paseoHome, "paseo.pid");
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
  let existingLock: PidLockInfo | null = null;
  try {
    const content = await readFile(pidPath, "utf-8");
    existingLock = parsePidLockInfo(JSON.parse(content));
  } catch {
    // No existing lock or invalid JSON - that's fine
  }

  // Check if existing lock is stale
  const lockOwnerPid = resolveOwnerPid(options?.ownerPid);
  if (existingLock) {
    if (existingLock.pid === lockOwnerPid && isPidRunning(existingLock.pid)) {
      return;
    }

    if (isLockProcessAlive(existingLock)) {
      throw new PidLockError(
        `Another Paseo daemon is already running (PID ${existingLock.pid}, started ${existingLock.startedAt})`,
        existingLock,
      );
    }
    // Stale lock (process gone, or its PID was recycled by another process) - remove it
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
  try {
    const content = await readFile(pidPath, "utf-8");
    return parsePidLockInfo(JSON.parse(content));
  } catch {
    return null;
  }
}

export async function isLocked(
  paseoHome: string,
): Promise<{ locked: boolean; info?: PidLockInfo }> {
  const info = await getPidLockInfo(paseoHome);
  if (!info) {
    return { locked: false };
  }
  if (!isLockProcessAlive(info)) {
    return { locked: false, info };
  }
  return { locked: true, info };
}
