import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  getPidLockInfo,
  isPidLockOwnerRunning,
  isSamePidLock,
  type PidLockInfo,
} from "./pid-lock.js";

// Zero-Zod local daemon file helpers for thin CLI and desktop callers.
// Keep persisted-config schemas, daemon bootstrap, and terminal-worker reaping out of this graph.
export { resolvePaseoHome } from "./paseo-home.js";
export { ensurePrivateDirectory } from "./private-files.js";
export { readLocalCredentialForTarget } from "./local-credential.js";
export {
  isSamePidLock as isSameDaemonInstance,
  type PidLockInfo as DaemonInstance,
} from "./pid-lock.js";

export class DaemonInstanceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function readDaemonInstance(home: string): Promise<PidLockInfo | null> {
  const lock = await getPidLockInfo(home);
  return lock && isPidLockOwnerRunning(lock) ? lock : null;
}

export async function readDaemonLogPath(home: string): Promise<string> {
  try {
    const raw = JSON.parse(await readFile(path.join(home, "config.json"), "utf8")) as {
      log?: { file?: { path?: unknown } };
    };
    const configured = raw?.log?.file?.path;
    if (typeof configured === "string" && configured.length > 0) {
      return path.resolve(home, configured);
    }
  } catch {
    // Missing or unreadable config falls back to the default daemon log path.
  }
  return path.join(home, "daemon.log");
}

export async function createDaemonNotReadyError(
  home: string,
  instance: PidLockInfo,
): Promise<DaemonInstanceError> {
  const logPath = await readDaemonLogPath(home);
  return new DaemonInstanceError(
    "DAEMON_NOT_READY",
    `Daemon PID ${instance.pid} remains running but is not ready for ${home}.\nLogs: ${logPath}\nStatus: paseo daemon status --home ${JSON.stringify(home)}\nStop: paseo daemon stop --home ${JSON.stringify(home)}`,
  );
}

export async function waitForDaemonReady(
  home: string,
  options: {
    timeoutMs?: number;
    instance?: PidLockInfo;
    signal?: AbortSignal;
  } = {},
): Promise<PidLockInfo & { listen: string }> {
  const deadline = Date.now() + (options.timeoutMs ?? 600_000);
  while (true) {
    options.signal?.throwIfAborted();
    const instance = await readDaemonInstance(home);
    if (!instance)
      throw new DaemonInstanceError(
        "DAEMON_NOT_RUNNING",
        `Daemon is not running for ${home}. Start with: paseo daemon start --home ${JSON.stringify(home)}`,
      );
    if (options.instance && !isSamePidLock(instance, options.instance)) {
      throw new DaemonInstanceError(
        "DAEMON_REPLACED",
        `Supervisor changed for ${home}; refusing to follow PID ${instance.pid}.`,
      );
    }
    if (instance.listen) return { ...instance, listen: instance.listen };
    if (Date.now() >= deadline) throw await createDaemonNotReadyError(home, instance);
    await delay(100, undefined, { signal: options.signal });
  }
}
