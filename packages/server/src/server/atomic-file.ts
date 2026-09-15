import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

interface FileLockOwner {
  pid: number;
  processStartedAt: string;
  token: string;
  createdAt: string;
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
    await delay(5);
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

async function removeVerifiedDeadLock(lockPath: string, expected: FileLockOwner): Promise<boolean> {
  const current = await readFileLock(lockPath);
  if (!current || !sameFileLockOwner(current, expected) || isProcessRunning(current.pid)) {
    return false;
  }
  await fs.unlink(lockPath);
  return true;
}

async function acquireRecoveryLock(lockPath: string, owner: FileLockOwner): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await createOwnedLock(lockPath, owner)) return;
    const existing = await readFileLock(lockPath);
    if (!existing || isProcessRunning(existing.pid)) {
      throw new Error("file_lock_recovery_busy");
    }
    if (!(await removeVerifiedDeadLock(lockPath, existing))) {
      throw new Error("file_lock_recovery_changed");
    }
  }
  throw new Error("file_lock_recovery_busy");
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

async function recoverStaleFileLock(lockPath: string, expected: FileLockOwner): Promise<void> {
  const recoveryPath = `${lockPath}.recovery`;
  const recoveryOwner = createFileLockOwner();
  await acquireRecoveryLock(recoveryPath, recoveryOwner);
  await runWithOwnedLock(recoveryPath, recoveryOwner, async () => {
    const current = await readFileLock(lockPath);
    if (!current || !sameFileLockOwner(current, expected) || isProcessRunning(current.pid)) {
      return;
    }
    await fs.unlink(lockPath);
  });
}

export async function withExclusiveFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const owner = createFileLockOwner();
  let acquired = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await createOwnedLock(lockPath, owner)) {
      acquired = true;
      break;
    }
    const existing = await readFileLock(lockPath);
    if (!existing) continue;
    // A reused live PID is ambiguous because Node cannot inspect another process's
    // instance token portably. Keep the processStartedAt mismatch fail closed.
    if (!isProcessRunning(existing.pid)) {
      await recoverStaleFileLock(lockPath, existing);
      continue;
    }
    await delay(5);
  }
  if (!acquired) throw new Error("file_lock_busy");
  return runWithOwnedLock(lockPath, owner, operation);
}

export async function writeFileAtomic(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
  options?: { expectedSource?: string | NodeJS.ArrayBufferView },
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(tempPath, data, "utf8");
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
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

export async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  await writeFileAtomic(filePath, JSON.stringify(value, null, 2));
}
