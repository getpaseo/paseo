import { randomUUID } from "node:crypto";
import { link, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_RETRIES = 200;
const DEFAULT_RETRY_MS = 5;
const MAX_LOCK_BYTES = 512;
const SAFE_TOKEN = /^[A-Za-z0-9_-]{1,128}$/;

interface LockOwner {
  token: string;
  pid: number;
  createdAt: number;
}

export interface TimelineMutationLockOptions {
  retries?: number;
  retryMs?: number;
  createToken?: () => string;
  onContention?: () => void;
}

/**
 * Serializes timeline cache mutations without stealing an existing lock. A lock left by a crashed
 * process is recovered only by explicitly deleting/resetting the disposable cache while no store
 * is active; runtime ownership cannot safely infer that another process is dead.
 */
export async function withTimelineMutationLock<T>(
  directory: string,
  operation: () => Promise<T>,
  options?: TimelineMutationLockOptions,
): Promise<T> {
  const retries = options?.retries ?? DEFAULT_RETRIES;
  const retryMs = options?.retryMs ?? DEFAULT_RETRY_MS;
  validatePositiveInteger(retries, "retries");
  validateNonnegativeInteger(retryMs, "retryMs");

  const lockPath = path.join(directory, ".timeline-write.lock");
  const token = options?.createToken?.() ?? randomUUID();
  if (!SAFE_TOKEN.test(token)) throw new Error("Invalid timeline mutation lock token");
  const owner: LockOwner = {
    token,
    pid: process.pid,
    createdAt: Date.now(),
  };
  const ownerPath = path.join(directory, `.timeline-write-lock-${owner.token}.tmp`);
  await writeFile(ownerPath, JSON.stringify(owner), { flag: "wx" });
  try {
    for (let attempt = 0; attempt < retries; attempt += 1) {
      try {
        await link(ownerPath, lockPath);
        const identity = await stat(ownerPath);
        try {
          return await operation();
        } finally {
          await releaseIfOwner(lockPath, owner.token, identity.dev, identity.ino);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        options?.onContention?.();
        await readOwner(lockPath);
        if (retryMs > 0) await new Promise((resolve) => setTimeout(resolve, retryMs));
      }
    }
    throw new Error("Timed out acquiring timeline mutation lock");
  } finally {
    await unlink(ownerPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function releaseIfOwner(
  lockPath: string,
  token: string,
  expectedDevice: number,
  expectedInode: number,
): Promise<void> {
  const lockStat = await stat(lockPath).catch(() => null);
  if (lockStat?.dev !== expectedDevice || lockStat.ino !== expectedInode) return;
  if ((await readOwner(lockPath))?.token !== token) return;
  await unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function readOwner(lockPath: string): Promise<LockOwner | null> {
  let lockStat;
  try {
    lockStat = await stat(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!lockStat.isFile() || lockStat.size > MAX_LOCK_BYTES) {
    throw new Error("Invalid timeline mutation lock");
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(lockPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Invalid timeline mutation lock", { cause: error });
  }
  if (!value || typeof value !== "object") throw new Error("Invalid timeline mutation lock");
  const owner = value as Partial<LockOwner>;
  if (
    typeof owner.token !== "string" ||
    !SAFE_TOKEN.test(owner.token) ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid! < 0 ||
    !Number.isSafeInteger(owner.createdAt) ||
    owner.createdAt! < 0
  ) {
    throw new Error("Invalid timeline mutation lock");
  }
  return owner as LockOwner;
}

function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function validateNonnegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative safe integer`);
  }
}
