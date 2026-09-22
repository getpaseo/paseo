import type { ChildProcess } from "node:child_process";
import type { Logger } from "pino";

import { spawnProcess } from "../../utils/spawn.js";

export interface SleepInhibitorBackend {
  /**
   * False once we know this host has no usable inhibitor (unsupported platform,
   * or the helper binary is missing). Reported to clients so the indicator never
   * claims the machine is being held awake when it isn't.
   */
  isSupported(): boolean;
  isHeld(): boolean;
  onChange(listener: () => void): () => void;
  acquire(): void;
  release(): void;
}

export interface ProcessSleepInhibitorOptions {
  logger: Logger;
  /** Overridden in tests. */
  spawn?: typeof spawnProcess;
  platform?: NodeJS.Platform;
  pid?: number;
}

const INHIBIT_REASON = "Paseo agents are running";

interface InhibitorCommand {
  command: string;
  args: string[];
}

export function resolveInhibitorCommand(
  platform: NodeJS.Platform,
  pid: number,
): InhibitorCommand | null {
  if (platform === "darwin") {
    // -i blocks idle sleep only, so the lid still works. -w makes caffeinate
    // exit when this daemon's pid does: without it a daemon crash orphans a
    // live caffeinate and the machine never sleeps again. The explicit kill in
    // release() is the normal path; -w is the crash net.
    return { command: "caffeinate", args: ["-i", "-w", String(pid)] };
  }
  if (platform === "linux") {
    return {
      command: "systemd-inhibit",
      args: [
        "--what=idle:sleep",
        `--why=${INHIBIT_REASON}`,
        "--mode=block",
        "--who=Paseo",
        "sleep",
        "infinity",
      ],
    };
  }
  return null;
}

/**
 * Holds a sleep inhibitor by keeping a helper process alive. One process at a
 * time; acquire() while already held is a no-op.
 */
export function createProcessSleepInhibitor(
  options: ProcessSleepInhibitorOptions,
): SleepInhibitorBackend {
  const log = options.logger.child({ module: "sleep-inhibitor" });
  const spawn = options.spawn ?? spawnProcess;
  const platform = options.platform ?? process.platform;
  const pid = options.pid ?? process.pid;
  const resolved = resolveInhibitorCommand(platform, pid);

  let supported = resolved !== null;
  let child: ChildProcess | null = null;
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of listeners) listener();
  }

  return {
    isSupported: () => supported,
    isHeld: () => child !== null,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    acquire(): void {
      if (!resolved || !supported || child) return;

      let spawned: ChildProcess;
      try {
        spawned = spawn(resolved.command, resolved.args, {
          envMode: "internal",
          stdio: ["ignore", "ignore", "ignore"],
        });
      } catch (err) {
        supported = false;
        log.warn({ err, command: resolved.command }, "Sleep inhibitor unavailable");
        notify();
        return;
      }

      child = spawned;

      spawned.on("error", (err: NodeJS.ErrnoException) => {
        if (child !== spawned) return;
        child = null;
        // ENOENT means the helper isn't installed — stop claiming support so
        // the client indicator tells the truth.
        if (err.code === "ENOENT") supported = false;
        log.warn({ err, command: resolved.command }, "Sleep inhibitor failed to start");
        notify();
      });

      spawned.on("exit", () => {
        if (child !== spawned) return;
        child = null;
        notify();
      });

      log.debug({ command: resolved.command, pid: spawned.pid }, "Sleep inhibitor acquired");
      notify();
    },

    release(): void {
      const current = child;
      if (!current) return;
      child = null;
      try {
        current.kill();
      } catch (err) {
        log.warn({ err }, "Failed to release sleep inhibitor");
      }
      notify();
    },
  };
}
