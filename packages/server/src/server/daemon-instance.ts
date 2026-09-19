import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  getPidLockInfo,
  isPidRunning,
  isSamePidLock,
  releasePidLock,
  type PidLockInfo,
} from "./pid-lock.js";
import { daemonLaunchEnvironment } from "./config-environment.js";
import { readPersistedConfig } from "./persisted-config.js";
import treeKill from "tree-kill";
const killTree = (pid: number, signal: string): Promise<void> =>
  new Promise((resolve, reject) =>
    treeKill(pid, signal, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    }),
  );

// Process ownership only: desktop and CLI load this entry in their own processes.
// Keep daemon bootstrap and WebSocket schemas out of its dependency tree.
export { resolvePaseoHome } from "./paseo-home.js";
export { ensurePrivateDirectory } from "./private-files.js";
export { daemonLaunchEnvironment } from "./config-environment.js";
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

/**
 * Environment edges `stopDaemonInstance` touches, injected so tests can drive it
 * with a typed in-memory fake instead of mocking modules. Production passes the
 * real implementations through `defaultStopDaemonPorts`.
 */
export interface StopDaemonPorts {
  readInstance(home: string): Promise<PidLockInfo | null>;
  isRunning(pid: number): boolean;
  isSameInstance(left: PidLockInfo, right: PidLockInfo): boolean;
  releaseLock(home: string, owner: { ownerPid: number; startedAt: string }): Promise<void>;
  signalTerm(pid: number): Promise<void>;
  killTree(pid: number, signal: NodeJS.Signals): Promise<void>;
  /** Waits `ms`, rejecting with an AbortError once `signal` aborts. */
  wait(ms: number, signal?: AbortSignal): Promise<void>;
}

export const defaultStopDaemonPorts: StopDaemonPorts = {
  readInstance(home) {
    return getPidLockInfo(home);
  },
  isRunning(pid) {
    return isPidRunning(pid);
  },
  isSameInstance(left, right) {
    return isSamePidLock(left, right);
  },
  releaseLock(home, owner) {
    return releasePidLock(home, owner);
  },
  signalTerm(pid) {
    process.kill(pid, "SIGTERM");
    return Promise.resolve();
  },
  killTree(pid, signal) {
    return killTree(pid, signal);
  },
  wait(ms, signal) {
    return delay(ms, undefined, { signal });
  },
};

export async function readDaemonInstance(home: string): Promise<PidLockInfo | null> {
  const lock = await getPidLockInfo(home);
  return lock && isPidRunning(lock.pid) ? lock : null;
}

export function daemonLogPath(home: string): string {
  try {
    return path.resolve(home, readPersistedConfig(home).log?.file?.path ?? "daemon.log");
  } catch {
    return path.join(home, "daemon.log");
  }
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
    if (Date.now() >= deadline) throw notReady(home, instance);
    await delay(100, undefined, { signal: options.signal });
  }
}

function notReady(home: string, instance: PidLockInfo): DaemonInstanceError {
  return new DaemonInstanceError(
    "DAEMON_NOT_READY",
    `Daemon PID ${instance.pid} remains running but is not ready for ${home}.\nLogs: ${daemonLogPath(home)}\nStatus: paseo daemon status --home ${JSON.stringify(home)}\nStop: paseo daemon stop --home ${JSON.stringify(home)}`,
  );
}

/**
 * Races `promise` against `signal` so an aborted caller never waits on a
 * graceful-shutdown callback that ignores the signal (e.g. a hung CLI child).
 * The underlying promise keeps running; callers pass the same signal through to
 * their own work so they can cancel it.
 */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted)
    return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function requestInstanceStop(
  home: string,
  instance: PidLockInfo,
  options: {
    force?: boolean;
    ports: StopDaemonPorts;
    signal?: AbortSignal;
    requestShutdown?: (
      instance: PidLockInfo & { listen: string },
      signal?: AbortSignal,
    ) => Promise<void>;
  },
) {
  const { ports, signal } = options;
  let forced = false;
  let usedLifecycleRpc = false;
  if (process.platform === "win32") {
    if (instance.listen && options.requestShutdown) {
      try {
        await abortable(
          options.requestShutdown({ ...instance, listen: instance.listen }, signal),
          signal,
        );
        usedLifecycleRpc = true;
      } catch (error) {
        if (signal?.aborted) {
          // The caller's deadline fired while the graceful shutdown was in
          // flight. Leave the daemon running; the caller's wait loop turns this
          // into a cancellation instead of an AbortError escaping the stop.
          return { forced, usedLifecycleRpc };
        }
        if (!options.force) throw error;
        const current = await ports.readInstance(home);
        if (current && !ports.isSameInstance(instance, current))
          throw new DaemonInstanceError(
            "DAEMON_REPLACED",
            `Supervisor changed for ${home}; refusing forced cleanup.`,
          );
        await ports.killTree(instance.pid, "SIGKILL");
        forced = true;
      }
    } else if (!options.force) {
      throw new DaemonInstanceError(
        "STOP_NO_GRACEFUL_CHANNEL",
        `PID ${instance.pid} for ${home} has no graceful shutdown channel. Use --force explicitly to terminate it.`,
      );
    } else {
      await ports.killTree(instance.pid, "SIGKILL");
      forced = true;
    }
  } else {
    try {
      await ports.signalTerm(instance.pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  return { forced, usedLifecycleRpc };
}

async function resolveNotRunningLock(
  ports: StopDaemonPorts,
  home: string,
  instance: PidLockInfo | null,
): Promise<{
  action: "not_running";
  pid: number | null;
  forced: boolean;
  usedLifecycleRpc: boolean;
}> {
  if (instance)
    await ports.releaseLock(home, { ownerPid: instance.pid, startedAt: instance.startedAt });
  return {
    action: "not_running",
    pid: instance?.pid ?? null,
    forced: false,
    usedLifecycleRpc: false,
  };
}

function assertStoppableInstance(instance: PidLockInfo): void {
  if (instance.pid <= 1 || instance.pid === process.pid)
    throw new Error("Refusing to stop invalid supervisor PID");
}

/**
 * Polls until the captured supervisor process exits, the caller's deadline
 * passes, or `signal` aborts. An abort returns "cancelled" without forcing a
 * kill, so the caller can abandon the stop and leave daemon termination
 * semantics untouched.
 */
async function waitForInstanceExit(input: {
  home: string;
  instance: PidLockInfo;
  ports: StopDaemonPorts;
  signal?: AbortSignal;
  waitMs: number;
}): Promise<boolean | "cancelled"> {
  const { home, instance, ports, signal } = input;
  const exitDeadline = Date.now() + input.waitMs;
  while (ports.isRunning(instance.pid)) {
    const current = await ports.readInstance(home);
    if (current && !ports.isSameInstance(instance, current))
      throw new DaemonInstanceError(
        "DAEMON_REPLACED",
        `Supervisor changed for ${home}; stop of PID ${instance.pid} was not confirmed.`,
      );
    if (Date.now() >= exitDeadline) return false;
    try {
      await ports.wait(100, signal);
    } catch (error) {
      if (signal?.aborted) return "cancelled";
      throw error;
    }
  }
  return true;
}

export async function stopDaemonInstance(
  home: string,
  options: {
    instance?: PidLockInfo;
    force?: boolean;
    timeoutMs?: number;
    killTimeoutMs?: number;
    signal?: AbortSignal;
    ports?: StopDaemonPorts;
    requestShutdown?: (
      instance: PidLockInfo & { listen: string },
      signal?: AbortSignal,
    ) => Promise<void>;
  } = {},
): Promise<{
  action: "stopped" | "not_running" | "cancelled";
  pid: number | null;
  forced: boolean;
  usedLifecycleRpc: boolean;
}> {
  const ports = options.ports ?? defaultStopDaemonPorts;
  const { timeoutMs = 15_000, killTimeoutMs = 3_000, signal } = options;
  const deadline = Date.now() + timeoutMs;
  const instance = await ports.readInstance(home);
  if (options.instance && instance && !ports.isSameInstance(instance, options.instance)) {
    throw new DaemonInstanceError(
      "DAEMON_REPLACED",
      `Supervisor changed for ${home}; refusing to stop PID ${instance.pid}.`,
    );
  }
  if (!instance || !ports.isRunning(instance.pid)) {
    return resolveNotRunningLock(ports, home, instance);
  }
  assertStoppableInstance(instance);
  let { forced, usedLifecycleRpc } = await requestInstanceStop(home, instance, {
    ...options,
    ports,
  });
  const cancelled = () =>
    ({ action: "cancelled", pid: instance.pid, forced, usedLifecycleRpc }) as const;
  let stopped = await waitForInstanceExit({
    home,
    instance,
    ports,
    signal,
    waitMs: forced ? killTimeoutMs : Math.max(0, deadline - Date.now()),
  });
  if (stopped === "cancelled") return cancelled();
  if (!stopped && options.force && !forced) {
    await ports.killTree(instance.pid, "SIGKILL");
    forced = true;
    stopped = await waitForInstanceExit({ home, instance, ports, signal, waitMs: killTimeoutMs });
    if (stopped === "cancelled") return cancelled();
  }
  if (!stopped)
    throw new DaemonInstanceError(
      "STOP_NOT_CONFIRMED",
      `Timed out waiting for supervisor PID ${instance.pid} in ${home} to exit${options.force ? "" : "; use --force to permit forced cleanup"}.`,
    );
  await ports.releaseLock(home, { ownerPid: instance.pid, startedAt: instance.startedAt });
  return { action: "stopped", pid: instance.pid, forced, usedLifecycleRpc };
}

export async function startDaemonInstance(input: {
  home: string;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  mode: "managed" | "deployment";
  desktopManaged?: boolean;
  foreground?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  onAcquired?: (instance: PidLockInfo) => void;
  onReady?: (instance: PidLockInfo & { listen: string }) => void;
}): Promise<{ instance: PidLockInfo; spawned: boolean; exitCode?: number }> {
  input.signal?.throwIfAborted();
  const existing = await readDaemonInstance(input.home);
  if (existing) return { instance: existing, spawned: false };
  const {
    foreground = false,
    timeoutMs = 600_000,
    signal,
    onAcquired = () => {},
    onReady = () => {},
  } = input;
  const child = spawn(input.command, input.args, {
    env: daemonLaunchEnvironment(input),
    detached: !foreground,
    stdio: foreground ? "inherit" : "ignore",
    windowsHide: true,
  });
  let exit: { code: number; error?: Error } | undefined;
  const exited = new Promise<number>((resolve) => {
    child.once("error", (error) => {
      exit = { code: 1, error };
      resolve(1);
    });
    child.once("exit", (code) => {
      exit = { code: code ?? 1 };
      resolve(code ?? 1);
    });
  });
  const cancel = () => {
    if (child.pid && !exit) {
      child.ref();
      child.kill("SIGTERM");
    }
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (!foreground) child.unref();
  const deadline = foreground ? Infinity : Date.now() + timeoutMs;
  let acquired: PidLockInfo | undefined;
  async function waitUntilReady() {
    while (true) {
      signal?.throwIfAborted();
      const instance = await readDaemonInstance(input.home);
      if (instance && instance.pid !== child.pid) return { instance, spawned: false };
      if (instance && !acquired) {
        acquired = instance;
        onAcquired(instance);
      }
      if (exit) {
        const logPath = daemonLogPath(input.home);
        const log = await readFile(logPath, "utf8").catch(() => "");
        throw new DaemonInstanceError(
          "DAEMON_START_FAILED",
          `Daemon failed to start (${exit.error?.message ?? `exit ${exit.code}`}). Logs: ${logPath}\n${log.split("\n").slice(-30).join("\n")}`,
        );
      }
      if (instance?.listen) {
        const ready = { ...instance, listen: instance.listen };
        onReady(ready);
        return {
          instance: ready,
          spawned: true,
          ...(foreground ? { exitCode: await exited } : {}),
        };
      }
      if (Date.now() >= deadline) {
        if (acquired) throw notReady(input.home, acquired);
        throw new DaemonInstanceError(
          "DAEMON_NOT_READY",
          `Supervisor PID ${child.pid} remains running but has not published its lock for ${input.home}. Logs: ${daemonLogPath(input.home)}. Check paseo daemon status --home ${JSON.stringify(input.home)}. Stop with paseo daemon stop --home ${JSON.stringify(input.home)} once its lock is published, or signal this PID.`,
        );
      }
      await delay(100, undefined, { signal });
    }
  }
  try {
    return await waitUntilReady();
  } catch (error) {
    if (!(error instanceof DaemonInstanceError && error.code === "DAEMON_NOT_READY")) {
      cancel();
      const stopped = await Promise.race([
        exited.then(() => true),
        delay(15_000, false, { ref: false }),
      ]);
      if (!stopped && child.pid) {
        await killTree(child.pid, "SIGKILL");
        await exited;
      }
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}
