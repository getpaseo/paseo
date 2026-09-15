import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
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
  token: string;
  createdAt: string;
}

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

async function readFileLock(lockPath: string): Promise<FileLockOwner | null> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(lockPath, "utf8"));
      if (
        parsed &&
        typeof parsed === "object" &&
        "pid" in parsed &&
        Number.isInteger(parsed.pid) &&
        Number(parsed.pid) > 0 &&
        "token" in parsed &&
        typeof parsed.token === "string" &&
        "createdAt" in parsed &&
        typeof parsed.createdAt === "string"
      ) {
        return parsed as FileLockOwner;
      }
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") return null;
    }
    await sleep(5);
  }
  throw new Error("file_lock_invalid");
}

async function recoverStaleFileLock(lockPath: string, expected: FileLockOwner): Promise<void> {
  const recoveryPath = `${lockPath}.recovery`;
  let recoveryHandle;
  try {
    recoveryHandle = await fs.open(recoveryPath, "wx", 0o600);
  } catch (error) {
    if (isErrnoException(error) && error.code === "EEXIST") {
      throw new Error("file_lock_recovery_busy", { cause: error });
    }
    throw error;
  }
  try {
    const current = await readFileLock(lockPath);
    if (
      !current ||
      current.pid !== expected.pid ||
      current.token !== expected.token ||
      isProcessRunning(current.pid)
    ) {
      return;
    }
    await fs.unlink(lockPath);
  } finally {
    await recoveryHandle.close();
    await fs.unlink(recoveryPath).catch(() => undefined);
  }
}

export async function withExclusiveFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const owner: FileLockOwner = {
    pid: process.pid,
    token: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  let acquired = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    let handle;
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify(owner));
      acquired = true;
      break;
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "EEXIST") throw error;
      const existing = await readFileLock(lockPath);
      if (!existing) continue;
      if (!isProcessRunning(existing.pid)) {
        await recoverStaleFileLock(lockPath, existing);
        continue;
      }
      await sleep(5);
    } finally {
      await handle?.close();
    }
  }
  if (!acquired) throw new Error("file_lock_busy");

  let result: T | undefined;
  let operationError: unknown;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }
  let releaseError: unknown;
  try {
    const current = await readFileLock(lockPath);
    if (!current || current.token !== owner.token || current.pid !== owner.pid) {
      throw new Error("file_lock_ownership_lost");
    }
    await fs.unlink(lockPath);
  } catch (error) {
    releaseError = error;
  }
  if (operationError && releaseError) {
    throw new AggregateError(
      [operationError, releaseError],
      "file_lock_operation_and_release_failed",
    );
  }
  if (operationError) throw operationError;
  if (releaseError) throw releaseError;
  return result as T;
}


export async function writeFileAtomic(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
  operations: AtomicFileRuntime = runtime,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(tempPath, data, "utf8");
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
