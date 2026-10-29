import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { buildSelfNodeCommand } from "../server/paseo-env.js";
import { ensurePrivateDirectory } from "../server/private-files.js";
import {
  readTerminalWorkerRecord,
  terminalWorkerDirectory,
  terminalWorkerRecordPath,
  type TerminalWorkerRecord,
} from "./terminal-worker-record.js";
import { resolveTerminalWorkerEntry, type TerminalWorkerEntry } from "./terminal-worker-runtime.js";

const LAUNCH_TIMEOUT_MS = 20_000;

export class TerminalWorkerLaunchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TerminalWorkerLaunchError";
  }
}

/**
 * Starts a terminal worker outside this process's tree: the launcher spawns the worker
 * detached and exits once it listens, so the worker is re-parented and survives this daemon.
 * Resolves with the record the worker wrote; a failed start leaves no worker behind.
 */
export async function launchTerminalWorker(input: {
  paseoHome: string;
  paseoVersion: string;
  timeoutMs?: number;
  /** Defaults to the copy of this installation's bundle (source in dev). */
  entry?: TerminalWorkerEntry;
}): Promise<{ record: TerminalWorkerRecord; recordPath: string }> {
  const recordId = randomUUID();
  ensurePrivateDirectory(terminalWorkerDirectory(input.paseoHome));
  const entry = input.entry ?? resolveTerminalWorkerEntry(input);
  const launch = buildSelfNodeCommand([
    ...entry.execArgv,
    entry.scriptPath,
    "--launch",
    "--record-id",
    recordId,
    "--paseo-home",
    input.paseoHome,
    "--paseo-version",
    input.paseoVersion,
    ...(entry.runtime ? ["--runtime", entry.runtime] : []),
  ]);
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      launch.command,
      launch.args,
      {
        env: launch.env,
        timeout: input.timeoutMs ?? LAUNCH_TIMEOUT_MS,
        windowsHide: true,
        encoding: "utf8",
      },
      (error, out, err) => {
        if (error) {
          const detail = err.trim() || error.message;
          reject(
            new TerminalWorkerLaunchError(`Terminal worker failed to start: ${detail}`, {
              cause: error,
            }),
          );
          return;
        }
        resolve(out);
      },
    );
  });

  let pid: number;
  try {
    const parsed = JSON.parse(stdout.trim()) as { pid?: unknown };
    if (typeof parsed.pid !== "number") throw new Error("missing pid");
    pid = parsed.pid;
  } catch (error) {
    throw new TerminalWorkerLaunchError(
      `Terminal worker launcher printed an unexpected result: ${stdout.trim()}`,
      { cause: error },
    );
  }
  const recordPath = terminalWorkerRecordPath(input.paseoHome, pid);
  const record = await readTerminalWorkerRecord(recordPath);
  if (record.recordId !== recordId) {
    throw new TerminalWorkerLaunchError(
      `Terminal worker record ${recordPath} belongs to another launch`,
    );
  }
  return { record, recordPath };
}
