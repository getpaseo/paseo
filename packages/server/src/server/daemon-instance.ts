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

async function requestInstanceStop(
  home: string,
  instance: PidLockInfo,
  options: {
    force?: boolean;
    requestShutdown?: (instance: PidLockInfo & { listen: string }) => Promise<void>;
  },
) {
  let forced = false;
  let usedLifecycleRpc = false;
  if (process.platform === "win32") {
    if (instance.listen && options.requestShutdown) {
      try {
        await options.requestShutdown({ ...instance, listen: instance.listen });
        usedLifecycleRpc = true;
      } catch (error) {
        if (!options.force) throw error;
        const current = await getPidLockInfo(home);
        if (current && !isSamePidLock(instance, current))
          throw new DaemonInstanceError(
            "DAEMON_REPLACED",
            `Supervisor changed for ${home}; refusing forced cleanup.`,
          );
        await killTree(instance.pid, "SIGKILL");
        forced = true;
      }
    } else if (!options.force) {
      throw new DaemonInstanceError(
        "STOP_NO_GRACEFUL_CHANNEL",
        `PID ${instance.pid} for ${home} has no graceful shutdown channel. Use --force explicitly to terminate it.`,
      );
    } else {
      await killTree(instance.pid, "SIGKILL");
      forced = true;
    }
  } else {
    try {
      process.kill(instance.pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  return { forced, usedLifecycleRpc };
}

export async function stopDaemonInstance(
  home: string,
  options: {
    instance?: PidLockInfo;
    force?: boolean;
    timeoutMs?: number;
    killTimeoutMs?: number;
    requestShutdown?: (instance: PidLockInfo & { listen: string }) => Promise<void>;
  } = {},
): Promise<{
  action: "stopped" | "not_running";
  pid: number | null;
  forced: boolean;
  usedLifecycleRpc: boolean;
}> {
  const { timeoutMs = 15_000, killTimeoutMs = 3_000 } = options;
  const deadline = Date.now() + timeoutMs;
  const instance = await getPidLockInfo(home);
  if (options.instance && instance && !isSamePidLock(instance, options.instance)) {
    throw new DaemonInstanceError(
      "DAEMON_REPLACED",
      `Supervisor changed for ${home}; refusing to stop PID ${instance.pid}.`,
    );
  }
  if (!instance || !isPidRunning(instance.pid)) {
    if (instance)
      await releasePidLock(home, { ownerPid: instance.pid, startedAt: instance.startedAt });
    return {
      action: "not_running",
      pid: instance?.pid ?? null,
      forced: false,
      usedLifecycleRpc: false,
    };
  }
  if (instance.pid <= 1 || instance.pid === process.pid)
    throw new Error("Refusing to stop invalid supervisor PID");
  let { forced, usedLifecycleRpc } = await requestInstanceStop(home, instance, options);
  const waitForExit = async (waitMs: number) => {
    const exitDeadline = Date.now() + waitMs;
    while (isPidRunning(instance.pid)) {
      const current = await getPidLockInfo(home);
      if (current && !isSamePidLock(instance, current))
        throw new DaemonInstanceError(
          "DAEMON_REPLACED",
          `Supervisor changed for ${home}; stop of PID ${instance.pid} was not confirmed.`,
        );
      if (Date.now() >= exitDeadline) return false;
      await delay(100);
    }
    return true;
  };
  let stopped = await waitForExit(forced ? killTimeoutMs : Math.max(0, deadline - Date.now()));
  if (!stopped && options.force && !forced) {
    await killTree(instance.pid, "SIGKILL");
    forced = true;
    stopped = await waitForExit(killTimeoutMs);
  }
  if (!stopped)
    throw new DaemonInstanceError(
      "STOP_NOT_CONFIRMED",
      `Timed out waiting for supervisor PID ${instance.pid} in ${home} to exit${options.force ? "" : "; use --force to permit forced cleanup"}.`,
    );
  await releasePidLock(home, { ownerPid: instance.pid, startedAt: instance.startedAt });
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
