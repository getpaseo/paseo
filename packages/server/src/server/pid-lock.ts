import { open, readFile, stat, unlink, utimes } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import { ensurePrivateDirectory } from "./private-files.js";
import { join } from "node:path";
import { hostname } from "node:os";
import { z } from "zod";

export const pidLockInfoSchema = z.object({
  pid: z.number().int().positive(),
  startedAt: z.string(),
  hostname: z.string(),
  uid: z.number(),
  listen: z.string().nullable(),
  desktopManaged: z.boolean().optional(),
  heartbeat: z.literal(true).optional(),
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

const PID_LOCK_HEARTBEAT_INTERVAL_MS = 30_000;
const PID_LOCK_READ_RETRY_ATTEMPTS = 10;
const PID_LOCK_READ_RETRY_DELAY_MS = 50;

export function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrnoException(error) && error.code === "EPERM";
  }
}

function getPidFilePath(paseoHome: string): string {
  return join(paseoHome, "paseo.pid");
}

async function touchPidLockFile(pidPath: string): Promise<void> {
  const now = new Date();
  await utimes(pidPath, now, now);
}

async function readPidLock(pidPath: string): Promise<PidLockInfo | null> {
  let lastError: unknown;
  for (let attempt = 0; attempt < PID_LOCK_READ_RETRY_ATTEMPTS; attempt++) {
    try {
      const content = await readFile(pidPath, "utf-8");
      const lock = parsePidLockInfo(JSON.parse(content));
      if (lock) return lock;
      lastError = new Error("Invalid lock shape");
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") return null;
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, PID_LOCK_READ_RETRY_DELAY_MS));
  }
  throw Object.assign(
    new PidLockError(`Cannot read daemon state at ${pidPath}: ${String(lastError)}`),
    { code: "DAEMON_STATE_READ_FAILED" },
  );
}

function resolveOwnerPid(ownerPid?: number): number {
  if (typeof ownerPid === "number" && Number.isInteger(ownerPid) && ownerPid > 0) {
    return ownerPid;
  }
  return process.pid;
}

interface AcquirePidLockOptions {
  ownerPid?: number;
  /** Injected only by the tests that drive the recovery path's read/delete race. */
  fileSystem?: PidLockFileSystem;
}

export function isSamePidLock(left: PidLockInfo, right: PidLockInfo): boolean {
  return left.pid === right.pid && left.startedAt === right.startedAt;
}

function createLockHeldError(lock: PidLockInfo): PidLockError {
  return new PidLockError(
    `Another Paseo daemon is already running (PID ${lock.pid}, started ${lock.startedAt})`,
    lock,
  );
}

async function clearExistingPidLock(
  pidPath: string,
  existingLock: PidLockInfo,
  lockOwnerPid: number,
): Promise<"already_owned" | "cleared"> {
  const lockOwnerRunning = isPidRunning(existingLock.pid);
  if (existingLock.pid === lockOwnerPid && lockOwnerRunning) {
    await touchPidLockFile(pidPath);
    return "already_owned";
  }

  if (lockOwnerRunning) throw createLockHeldError(existingLock);
  const confirmedLock = await readPidLock(pidPath);
  if (
    !confirmedLock ||
    !isSamePidLock(existingLock, confirmedLock) ||
    isPidRunning(confirmedLock.pid)
  ) {
    throw new PidLockError("PID lock changed while checking whether it was abandoned");
  }

  await unlink(pidPath).catch(() => {});
  return "cleared";
}

function holdsAPidLock(content: string): boolean {
  try {
    return parsePidLockInfo(JSON.parse(content)) !== null;
  } catch {
    return false;
  }
}

/**
 * The three filesystem calls the recovery path makes, as a port.
 *
 * The interleaving it guards against is a few instructions wide, so a test
 * cannot produce it against the real filesystem. Injecting these lets one drive
 * the entry changing between the read and the delete, through `acquirePidLock`
 * rather than against an internal predicate.
 */
export interface PidLockFileSystem {
  open(path: string, flags: string): Promise<FileHandle>;
  stat(path: string): Promise<Stats>;
  unlink(path: string): Promise<void>;
}

const realFileSystem: PidLockFileSystem = { open, stat, unlink };

/**
 * Whether two stats describe the same file in the same state: the same
 * directory entry (device and inode) whose contents have not been rewritten
 * since (size and modification time).
 */
function isSameFileEntry(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

/**
 * Remove a lock file that still holds no readable lock after readPidLock has
 * exhausted its retries. Such a file names no pid, so no process can be shown
 * to hold it, and nothing else ever deletes it: a daemon killed between the
 * exclusive create and the write leaves an empty file behind that fails every
 * later start the same way.
 *
 * The read and the delete address the path separately, so the entry is
 * re-checked against the handle the decision was made on. Without that, a
 * daemon that filled in its own empty lock, or one that replaced the file,
 * would have a valid lock deleted underneath it, and both daemons would then
 * believe they hold the path.
 *
 * Returns false and leaves the file alone when the read failed for a reason
 * other than its contents, so a permission or I/O error still surfaces from
 * the caller's original error.
 */
async function clearUnparseablePidLock(pidPath: string, fs: PidLockFileSystem): Promise<boolean> {
  let handle: FileHandle;
  try {
    handle = await fs.open(pidPath, "r");
  } catch {
    return false;
  }

  try {
    if (holdsAPidLock(await handle.readFile("utf-8"))) return false;
    if (!isSameFileEntry(await handle.stat(), await fs.stat(pidPath))) return false;
  } catch {
    // The read or the re-check failed for a reason that is not the contents.
    return false;
  } finally {
    await handle.close();
  }

  try {
    await fs.unlink(pidPath);
  } catch (error) {
    // Someone else removed it, which is the outcome this was after anyway.
    if (isErrnoException(error) && error.code === "ENOENT") return true;
    throw error;
  }
  return true;
}

async function writeNewPidLock(pidPath: string, lockInfo: PidLockInfo): Promise<void> {
  let fd;
  try {
    fd = await open(pidPath, "wx");
    await fd.write(JSON.stringify(lockInfo));
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "EEXIST") {
      throw error;
    }

    const raceLock = await readPidLock(pidPath);
    if (raceLock) {
      throw new PidLockError(
        `Another Paseo daemon is already running (PID ${raceLock.pid})`,
        raceLock,
      );
    }
    throw new PidLockError("Failed to acquire PID lock due to race condition");
  } finally {
    await fd?.close();
  }
}

export async function acquirePidLock(
  paseoHome: string,
  listen: string | null,
  options?: AcquirePidLockOptions,
): Promise<void> {
  const pidPath = getPidFilePath(paseoHome);

  ensurePrivateDirectory(paseoHome);

  // Try to read existing lock
  let existingLock: PidLockInfo | null;
  try {
    existingLock = await readPidLock(pidPath);
  } catch (error) {
    if (!(await clearUnparseablePidLock(pidPath, options?.fileSystem ?? realFileSystem)))
      throw error;
    existingLock = null;
  }

  // Check if existing lock is stale
  const lockOwnerPid = resolveOwnerPid(options?.ownerPid);
  if (existingLock) {
    const result = await clearExistingPidLock(pidPath, existingLock, lockOwnerPid);
    if (result === "already_owned") {
      return;
    }
  }

  // Create new lock with exclusive flag
  const lockInfo: PidLockInfo = {
    pid: lockOwnerPid,
    startedAt: new Date().toISOString(),
    hostname: hostname(),
    uid: process.getuid?.() ?? 0,
    listen,
    heartbeat: true,
    ...(process.env.PASEO_DESKTOP_MANAGED === "1" ? { desktopManaged: true } : {}),
  };

  await writeNewPidLock(pidPath, lockInfo);
}

export async function refreshPidLock(
  paseoHome: string,
  options?: { ownerPid?: number },
): Promise<void> {
  const pidPath = getPidFilePath(paseoHome);
  const lockOwnerPid = resolveOwnerPid(options?.ownerPid);
  let fd;
  try {
    fd = await open(pidPath, "r+");
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      throw new PidLockError("Cannot refresh PID lock: lock file is missing");
    }
    throw error;
  }

  try {
    const lock = await readPidLockFromHandleWithRetry(fd);
    if (!lock) {
      throw new PidLockError("Cannot refresh PID lock: invalid lock file");
    }
    if (lock.pid !== lockOwnerPid) {
      throw new PidLockError(`Cannot refresh PID lock owned by PID ${lock.pid}`, lock);
    }
    const now = new Date();
    await fd.utimes(now, now);
  } finally {
    await fd.close();
  }
}

async function readPidLockFromHandle(fd: FileHandle): Promise<PidLockInfo | null> {
  try {
    const { size } = await fd.stat();
    if (size === 0) {
      return null;
    }
    const content = Buffer.alloc(size);
    const { bytesRead } = await fd.read(content, 0, size, 0);
    return parsePidLockInfo(JSON.parse(content.subarray(0, bytesRead).toString("utf-8")));
  } catch {
    return null;
  }
}

async function readPidLockFromHandleWithRetry(fd: FileHandle): Promise<PidLockInfo | null> {
  for (let attempt = 0; attempt < PID_LOCK_READ_RETRY_ATTEMPTS; attempt += 1) {
    const lock = await readPidLockFromHandle(fd);
    if (lock) {
      return lock;
    }
    if (attempt < PID_LOCK_READ_RETRY_ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, PID_LOCK_READ_RETRY_DELAY_MS));
    }
  }
  return null;
}

export function startPidLockHeartbeat(
  paseoHome: string,
  options?: {
    ownerPid?: number;
    intervalMs?: number;
    onError?: (error: unknown) => void;
  },
): () => void {
  const intervalMs = options?.intervalMs ?? PID_LOCK_HEARTBEAT_INTERVAL_MS;
  let refreshing = false;

  const timer = setInterval(() => {
    if (refreshing) {
      return;
    }
    refreshing = true;
    refreshPidLock(paseoHome, { ownerPid: options?.ownerPid })
      .catch((error) => {
        if (options?.onError) {
          options.onError(error);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`PID lock heartbeat failed: ${message}\n`);
      })
      .finally(() => {
        refreshing = false;
      });
  }, intervalMs);
  timer.unref();

  return () => clearInterval(timer);
}

export async function updatePidLock(
  paseoHome: string,
  patch: { listen: string | null },
  options?: { ownerPid?: number },
): Promise<void> {
  const pidPath = getPidFilePath(paseoHome);
  const lockOwnerPid = resolveOwnerPid(options?.ownerPid);
  const fd = await open(pidPath, "r+");
  try {
    const existingLock = await readPidLockFromHandleWithRetry(fd);
    if (!existingLock) {
      throw new PidLockError("Cannot update PID lock: invalid lock file");
    }
    if (existingLock.pid !== lockOwnerPid) {
      throw new PidLockError(
        `Cannot update PID lock owned by PID ${existingLock.pid}`,
        existingLock,
      );
    }

    const updatedLock: PidLockInfo = {
      ...existingLock,
      ...patch,
    };
    await fd.truncate(0);
    await fd.writeFile(JSON.stringify(updatedLock));
  } finally {
    await fd.close();
  }
}

export async function releasePidLock(
  paseoHome: string,
  options?: { ownerPid?: number; startedAt?: string },
): Promise<void> {
  const pidPath = getPidFilePath(paseoHome);
  const lockOwnerPid = resolveOwnerPid(options?.ownerPid);
  try {
    // Only remove if it's our lock
    const content = await readFile(pidPath, "utf-8");
    const lock = parsePidLockInfo(JSON.parse(content));
    if (
      lock?.pid === lockOwnerPid &&
      (options?.startedAt === undefined || lock.startedAt === options.startedAt)
    ) {
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
  if (!isPidRunning(info.pid)) {
    return { locked: false, info };
  }
  return { locked: true, info };
}
