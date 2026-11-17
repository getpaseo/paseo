import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { spawnProcess, type SpawnProcessOptions } from "../../../utils/spawn.js";
import { stopMarkedPosixProcesses, terminateWindowsProcesses } from "./leftovers.js";
import { listWindowsProcesses, WindowsLineageRecorder } from "./windows-lineage.js";

/** Set on every provider process; its descendants inherit it unless they clear their environment. */
export const PROVIDER_PROCESS_ENV = "PASEO_PROVIDER_PROCESS";

export interface SpawnProviderProcessOptions extends SpawnProcessOptions {
  logger: Logger;
}

let windowsLineage: WindowsLineageRecorder | null = null;
const pendingCleanups = new Set<Promise<void>>();

function getWindowsLineage(logger: Logger): WindowsLineageRecorder {
  windowsLineage ??= new WindowsLineageRecorder(listWindowsProcesses, (err) =>
    logger.warn({ err }, "Failed to record provider descendants"),
  );
  return windowsLineage;
}

/**
 * Spawn a provider CLI that Paseo owns. When it exits, for any reason, the processes it left
 * running (shell commands, dev servers, MCP servers) are stopped. Paseo's tree kill only reaches
 * descendants of a live process; a provider that crashed, or one that started commands in a new
 * session, leaves them behind otherwise.
 */
export function spawnProviderProcess(
  command: string,
  args: string[],
  options: SpawnProviderProcessOptions,
): ChildProcess {
  const { logger, ...spawnOptions } = options;
  const marker = randomUUID();
  const spawnedAtMs = Date.now();
  const child = spawnProcess(command, args, {
    ...spawnOptions,
    envOverlay: { ...spawnOptions.envOverlay, [PROVIDER_PROCESS_ENV]: marker },
  });
  const pid = child.pid;
  if (pid === undefined) return child;
  const lineage = process.platform === "win32" ? getWindowsLineage(logger) : null;
  lineage?.track(pid, spawnedAtMs);
  child.once("exit", () => {
    const cleanup = reportLeftovers({ pid, marker, lineage, logger });
    pendingCleanups.add(cleanup);
    void cleanup.finally(() => pendingCleanups.delete(cleanup));
  });
  return child;
}

/** Resolves once every provider that already exited has had its leftovers stopped. */
export async function settleProviderCleanups(): Promise<void> {
  await Promise.all(pendingCleanups);
}

interface ExitedProvider {
  pid: number;
  marker: string;
  lineage: WindowsLineageRecorder | null;
}

// Runs detached from any caller, so a failure is logged here rather than left unhandled.
async function reportLeftovers(input: ExitedProvider & { logger: Logger }): Promise<void> {
  let stopped: number[];
  try {
    stopped = await stopLeftovers(input);
  } catch (err) {
    input.logger.warn({ err, pid: input.pid }, "Failed to stop processes left by a provider");
    return;
  }
  if (stopped.length > 0) {
    input.logger.info({ pid: input.pid, stopped }, "Stopped processes left by an exited provider");
  }
}

async function stopLeftovers(input: ExitedProvider): Promise<number[]> {
  if (input.lineage) {
    const leftovers = await input.lineage.release(input.pid);
    await terminateWindowsProcesses(leftovers);
    return leftovers;
  }
  return stopMarkedPosixProcesses({
    platform: process.platform,
    name: PROVIDER_PROCESS_ENV,
    value: input.marker,
  });
}
