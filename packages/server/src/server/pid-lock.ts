import { open, readFile, readdir, unlink, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
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

function getPidsDir(junctionHome: string): string {
  return join(junctionHome, "pids");
}

function getLegacyPidFilePath(junctionHome: string): string {
  return join(junctionHome, "junction.pid");
}

function listenAddressToFilename(listenAddr: string): string {
  const normalized = listenAddr.trim();

  // Unix socket path or unix:// URL — hash for safe filename
  if (normalized.startsWith("/") || normalized.startsWith("unix://")) {
    const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
    return `unix_${hash}.pid`;
  }

  // Bare port number -> 127.0.0.1_port
  if (/^\d+$/.test(normalized)) {
    return `127.0.0.1_${normalized}.pid`;
  }

  // host:port -> host_port
  if (normalized.includes(":")) {
    return normalized.replace(/:/g, "_") + ".pid";
  }

  // Fallback: hash
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `${hash}.pid`;
}

function getPidFilePath(junctionHome: string, sockPath: string): string {
  return join(getPidsDir(junctionHome), listenAddressToFilename(sockPath));
}

function resolveOwnerPid(ownerPid?: number): number {
  if (typeof ownerPid === "number" && Number.isInteger(ownerPid) && ownerPid > 0) {
    return ownerPid;
  }
  return process.pid;
}

async function readPidFile(filePath: string): Promise<PidLockInfo | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    return JSON.parse(content) as PidLockInfo;
  } catch {
    return null;
  }
}

export async function acquirePidLock(
  junctionHome: string,
  sockPath: string,
  options?: { ownerPid?: number }
): Promise<void> {
  const pidsDir = getPidsDir(junctionHome);
  const pidPath = getPidFilePath(junctionHome, sockPath);

  // Ensure pids directory exists
  await mkdir(pidsDir, { recursive: true });

  // Migrate legacy junction.pid if present and stale
  const legacyPath = getLegacyPidFilePath(junctionHome);
  if (existsSync(legacyPath)) {
    const legacyLock = await readPidFile(legacyPath);
    if (legacyLock) {
      if (!isPidRunning(legacyLock.pid)) {
        // Stale legacy lock — remove it
        await unlink(legacyPath).catch(() => {});
      } else if (legacyLock.sockPath === sockPath) {
        // Live legacy lock for same address — let the check below handle it
      }
    }
  }

  // Try to read existing lock for this listen address
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
        `Another Junction daemon is already running on ${sockPath} (PID ${existingLock.pid}, started ${existingLock.startedAt})`,
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
          `Another Junction daemon is already running on ${sockPath} (PID ${raceLock.pid})`,
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
  sockPathOrOptions?: string | { ownerPid?: number },
  options?: { ownerPid?: number }
): Promise<void> {
  let sockPath: string | undefined;
  let opts: { ownerPid?: number } | undefined;

  if (typeof sockPathOrOptions === "string") {
    sockPath = sockPathOrOptions;
    opts = options;
  } else {
    opts = sockPathOrOptions;
  }

  const lockOwnerPid = resolveOwnerPid(opts?.ownerPid);

  if (sockPath) {
    // Release specific lock file
    const pidPath = getPidFilePath(junctionHome, sockPath);
    try {
      const content = await readFile(pidPath, "utf-8");
      const lock = JSON.parse(content) as PidLockInfo;
      if (lock.pid === lockOwnerPid) {
        await unlink(pidPath);
      }
    } catch {
      // Ignore errors - lock may already be gone
    }
    return;
  }

  // No sockPath — scan pids/ for matching ownerPid, then check legacy
  const pidsDir = getPidsDir(junctionHome);
  if (existsSync(pidsDir)) {
    try {
      const entries = await readdir(pidsDir);
      for (const entry of entries) {
        if (!entry.endsWith(".pid")) continue;
        const filePath = join(pidsDir, entry);
        try {
          const content = await readFile(filePath, "utf-8");
          const lock = JSON.parse(content) as PidLockInfo;
          if (lock.pid === lockOwnerPid) {
            await unlink(filePath);
          }
        } catch {
          // Skip invalid files
        }
      }
    } catch {
      // pids dir may not exist
    }
  }

  // Also check legacy path
  const legacyPath = getLegacyPidFilePath(junctionHome);
  try {
    const content = await readFile(legacyPath, "utf-8");
    const lock = JSON.parse(content) as PidLockInfo;
    if (lock.pid === lockOwnerPid) {
      await unlink(legacyPath);
    }
  } catch {
    // Ignore errors
  }
}

export async function getPidLockInfo(
  junctionHome: string,
  sockPath?: string
): Promise<PidLockInfo | null> {
  if (sockPath) {
    return readPidFile(getPidFilePath(junctionHome, sockPath));
  }

  // No sockPath — check pids/ for any lock, then legacy
  const pidsDir = getPidsDir(junctionHome);
  if (existsSync(pidsDir)) {
    try {
      const entries = await readdir(pidsDir);
      for (const entry of entries) {
        if (!entry.endsWith(".pid")) continue;
        const info = await readPidFile(join(pidsDir, entry));
        if (info) return info;
      }
    } catch {
      // Fall through to legacy
    }
  }

  return readPidFile(getLegacyPidFilePath(junctionHome));
}

export async function isLocked(
  junctionHome: string,
  sockPath?: string
): Promise<{ locked: boolean; info?: PidLockInfo }> {
  if (sockPath) {
    const info = await getPidLockInfo(junctionHome, sockPath);
    if (!info) return { locked: false };
    if (!isPidRunning(info.pid)) return { locked: false, info };
    return { locked: true, info };
  }

  // Check all locks
  const allLocks = await listPidLocks(junctionHome);
  if (allLocks.length === 0) return { locked: false };
  return { locked: true, info: allLocks[0] };
}

export async function listPidLocks(
  junctionHome: string
): Promise<PidLockInfo[]> {
  const results: PidLockInfo[] = [];
  const seenPids = new Set<number>();

  // Scan pids/ directory
  const pidsDir = getPidsDir(junctionHome);
  if (existsSync(pidsDir)) {
    try {
      const entries = await readdir(pidsDir);
      for (const entry of entries) {
        if (!entry.endsWith(".pid")) continue;
        const filePath = join(pidsDir, entry);
        const info = await readPidFile(filePath);
        if (!info) continue;
        if (isPidRunning(info.pid)) {
          results.push(info);
          seenPids.add(info.pid);
        } else {
          // Clean up stale lock
          await unlink(filePath).catch(() => {});
        }
      }
    } catch {
      // pids dir read failed
    }
  }

  // Check legacy junction.pid
  const legacyPath = getLegacyPidFilePath(junctionHome);
  const legacyInfo = await readPidFile(legacyPath);
  if (legacyInfo && !seenPids.has(legacyInfo.pid)) {
    if (isPidRunning(legacyInfo.pid)) {
      results.push(legacyInfo);
    }
  }

  return results;
}
