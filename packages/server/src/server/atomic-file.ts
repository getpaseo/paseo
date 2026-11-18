import { createHash, randomUUID } from "node:crypto";
import { promises as fs, type Stats } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

interface AtomicFileRuntime {
  platform: NodeJS.Platform;
  rename: (source: string, destination: string) => Promise<void>;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}

const runtime: AtomicFileRuntime = {
  platform: process.platform,
  rename: fs.rename,
  now: () => performance.now(),
  sleep,
};

interface FileLockOwner {
  pid: number;
  processStartedAt: string;
  token: string;
  createdAt: string;
}

interface FileLockRuntime {
  sleep: (milliseconds: number) => Promise<void>;
  /** Interleaving seam for tests: awaited once a recovery claim exists, before the claimed lock is verified. */
  onRecoveryClaim?: (details: { lockPath: string; claimPath: string }) => Promise<void>;
}

export interface FileLockOptions {
  /** Replaces the delay between lock attempts. */
  sleep?: (milliseconds: number) => Promise<void>;
  /** Interleaving seam for tests; see {@link FileLockRuntime.onRecoveryClaim}. */
  onRecoveryClaim?: (details: { lockPath: string; claimPath: string }) => Promise<void>;
}

const LOCK_ATTEMPTS = 200;
const LOCK_RETRY_DELAY_MS = 5;
const MAX_RECOVERY_DEPTH = 8;

type AtomicFileSourceStat = Pick<Stats, "dev" | "ino" | "uid" | "gid" | "mode">;

function hasSameOwnershipAndMode(left: AtomicFileSourceStat, right: AtomicFileSourceStat): boolean {
  return (
    left.uid === right.uid &&
    left.gid === right.gid &&
    (left.mode & 0o7777) === (right.mode & 0o7777)
  );
}

function isSameSourceFile(left: AtomicFileSourceStat, right: AtomicFileSourceStat): boolean {
  return left.dev === right.dev && left.ino === right.ino && hasSameOwnershipAndMode(left, right);
}

const PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1_000).toISOString();

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrnoException(error) && error.code === "EPERM";
  }
}

function parseIsoDate(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    ? timestamp
    : null;
}

function parseFileLockOwner(value: unknown): FileLockOwner | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const processStartedAt = parseIsoDate(candidate.processStartedAt);
  const createdAt = parseIsoDate(candidate.createdAt);
  if (
    !Number.isInteger(candidate.pid) ||
    Number(candidate.pid) <= 0 ||
    processStartedAt === null ||
    typeof candidate.token !== "string" ||
    candidate.token.length === 0 ||
    createdAt === null ||
    createdAt < processStartedAt
  ) {
    return null;
  }
  return candidate as unknown as FileLockOwner;
}

function sameFileLockOwner(left: FileLockOwner, right: FileLockOwner): boolean {
  return (
    left.pid === right.pid &&
    left.processStartedAt === right.processStartedAt &&
    left.token === right.token &&
    left.createdAt === right.createdAt
  );
}

function createFileLockOwner(): FileLockOwner {
  return {
    pid: process.pid,
    processStartedAt: PROCESS_STARTED_AT,
    token: randomUUID(),
    createdAt: new Date().toISOString(),
  };
}

async function readFileLock(lockPath: string): Promise<FileLockOwner | null> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const parsed = parseFileLockOwner(JSON.parse(await fs.readFile(lockPath, "utf8")));
      if (parsed) return parsed;
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") return null;
    }
    await sleep(5);
  }
  throw new Error("file_lock_invalid");
}

async function createOwnedLock(lockPath: string, owner: FileLockOwner): Promise<boolean> {
  let handle;
  try {
    handle = await fs.open(lockPath, "wx", 0o600);
    await handle.writeFile(JSON.stringify(owner));
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === "EEXIST") return false;
    throw error;
  } finally {
    await handle?.close();
  }
}

/**
 * Path of the claim that grants the right to discard one specific lock instance.
 * The observed owner's token names the claim, so every contender that read the same
 * dead owner races for the same claim and only one can win it.
 */
export function fileLockRecoveryClaimPath(lockPath: string, ownerToken: string): string {
  const digest = createHash("sha256").update(ownerToken, "utf8").digest("hex");
  return `${lockPath}.recovery.${digest}`;
}

/**
 * Discard `lockPath` when it still holds the dead `victim` we observed.
 *
 * Only the holder of the victim-derived claim may remove the lock, and a new lock can
 * only appear at `lockPath` after that removal, so no live replacement can slip between
 * the verification read and the unlink. A claim left behind by a dead recoverer is
 * discarded through the same rule, which names the next claim after that claim's own token.
 */
async function discardDeadLock(
  lockPath: string,
  victim: FileLockOwner,
  lockRuntime: FileLockRuntime,
  depth: number,
): Promise<void> {
  const claimPath = fileLockRecoveryClaimPath(lockPath, victim.token);
  const claimOwner = createFileLockOwner();
  let claimed = false;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS && !claimed; attempt++) {
    if (await createOwnedLock(claimPath, claimOwner)) {
      claimed = true;
      break;
    }
    const claimant = await readFileLock(claimPath);
    if (!claimant) continue;
    if (isProcessRunning(claimant.pid)) {
      // A live recoverer is discarding this exact instance; wait for it to finish.
      await lockRuntime.sleep(LOCK_RETRY_DELAY_MS);
      continue;
    }
    if (depth >= MAX_RECOVERY_DEPTH) throw new Error("file_lock_recovery_busy");
    await discardDeadLock(claimPath, claimant, lockRuntime, depth + 1);
  }
  if (!claimed) throw new Error("file_lock_recovery_busy");
  try {
    await lockRuntime.onRecoveryClaim?.({ lockPath, claimPath });
    const current = await readFileLock(lockPath);
    if (!current || !sameFileLockOwner(current, victim) || isProcessRunning(current.pid)) {
      return;
    }
    await fs.unlink(lockPath);
  } finally {
    await releaseOwnedLock(claimPath, claimOwner);
  }
}

async function releaseOwnedLock(lockPath: string, owner: FileLockOwner): Promise<void> {
  const current = await readFileLock(lockPath);
  if (!current || !sameFileLockOwner(current, owner)) {
    throw new Error("file_lock_ownership_lost");
  }
  await fs.unlink(lockPath);
}

async function runWithOwnedLock<T>(
  lockPath: string,
  owner: FileLockOwner,
  operation: () => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  let operationError: unknown;
  let releaseError: unknown;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  } finally {
    try {
      await releaseOwnedLock(lockPath, owner);
    } catch (error) {
      releaseError = error;
    }
  }
  if (operationError && releaseError) {
    throw new AggregateError(
      [operationError, releaseError],
      "file_lock_operation_and_release_failed",
      { cause: operationError },
    );
  }
  if (operationError) throw operationError;
  if (releaseError) throw releaseError;
  return result as T;
}

export async function withExclusiveFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  options?: FileLockOptions,
): Promise<T> {
  const lockRuntime: FileLockRuntime = {
    sleep: options?.sleep ?? sleep,
    onRecoveryClaim: options?.onRecoveryClaim,
  };
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const owner = createFileLockOwner();
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    if (await createOwnedLock(lockPath, owner)) {
      return runWithOwnedLock(lockPath, owner, operation);
    }
    const existing = await readFileLock(lockPath);
    if (!existing) continue;
    // A reused live PID is ambiguous because Node cannot inspect another process's
    // instance token portably. Keep the processStartedAt mismatch fail closed.
    if (!isProcessRunning(existing.pid)) {
      await discardDeadLock(lockPath, existing, lockRuntime, 0);
      continue;
    }
    await lockRuntime.sleep(LOCK_RETRY_DELAY_MS);
  }
  throw new Error("file_lock_busy");
}

export async function writeFileAtomic(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
  operations: AtomicFileRuntime = runtime,
  options?: {
    expectedSource?: string | NodeJS.ArrayBufferView;
    expectedSourceStat?: AtomicFileSourceStat;
    preserveSourceMetadata?: boolean;
  },
): Promise<void> {
  if (options?.preserveSourceMetadata && !options.expectedSourceStat) {
    throw new Error("atomic_file_expected_stat_required");
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(tempPath, data, "utf8");
    if (options?.preserveSourceMetadata && options.expectedSourceStat) {
      const tempStat = await fs.stat(tempPath);
      if (
        tempStat.uid !== options.expectedSourceStat.uid ||
        tempStat.gid !== options.expectedSourceStat.gid
      ) {
        await fs.chown(tempPath, options.expectedSourceStat.uid, options.expectedSourceStat.gid);
      }
      await fs.chmod(tempPath, options.expectedSourceStat.mode & 0o7777);
      const preserved = await fs.stat(tempPath);
      if (!hasSameOwnershipAndMode(preserved, options.expectedSourceStat)) {
        throw new Error("atomic_file_metadata_not_preserved");
      }
    }
    if (options?.expectedSource !== undefined) {
      const expected =
        typeof options.expectedSource === "string"
          ? Buffer.from(options.expectedSource, "utf8")
          : Buffer.from(
              options.expectedSource.buffer,
              options.expectedSource.byteOffset,
              options.expectedSource.byteLength,
            );
      if (!(await fs.readFile(filePath)).equals(expected)) {
        throw new Error("atomic_file_source_changed");
      }
    }
    if (options?.expectedSourceStat) {
      const current = await fs.stat(filePath);
      if (!isSameSourceFile(current, options.expectedSourceStat)) {
        throw new Error("atomic_file_source_changed");
      }
    }
    await replaceFile(tempPath, filePath, operations);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

async function replaceFile(
  source: string,
  destination: string,
  operations: AtomicFileRuntime,
): Promise<void> {
  // Windows readers/scanners can briefly deny replacement. Yield with backoff,
  // but keep interactive persistence failures bounded to a one-second retry budget.
  const deadline = operations.now() + 1000;
  let delay = 10;
  for (;;) {
    try {
      await operations.rename(source, destination);
      return;
    } catch (error) {
      if (
        operations.platform !== "win32" ||
        !(error instanceof Error) ||
        !("code" in error) ||
        !["EPERM", "EACCES", "EBUSY"].includes(String(error.code))
      ) {
        throw error;
      }
      const remaining = deadline - operations.now();
      if (remaining <= 0) throw error;
      await operations.sleep(Math.min(delay, remaining));
      if (operations.now() >= deadline) throw error;
      delay = Math.min(delay * 2, 100);
    }
  }
}

export async function writeJsonFileAtomic(
  filePath: string,
  value: unknown,
  operations: AtomicFileRuntime = runtime,
): Promise<void> {
  await writeFileAtomic(filePath, JSON.stringify(value, null, 2), operations);
}
