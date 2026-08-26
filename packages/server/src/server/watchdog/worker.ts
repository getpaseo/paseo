import { createWriteStream } from "node:fs";
import { access, mkdir, open } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { finished } from "node:stream/promises";
import type { Readable } from "node:stream";

import { terminateWithTreeKill } from "../../utils/tree-kill.js";
import { writeJsonFileAtomic } from "../atomic-file.js";
import { WATCHDOG_MAX_STREAM_BYTES, type WatchdogResult } from "./service.js";

export interface WatchdogWorkerInput {
  cwd: string;
  command: string;
  args: string[];
  result: string;
  stdout: string;
  stderr: string;
  cancel?: string;
  timeoutMs?: number;
  maxStreamBytes?: number;
}

export interface WatchdogStreamStats {
  bytes: number;
  truncated: boolean;
}

export async function runWatchdogWorker(input: WatchdogWorkerInput): Promise<void> {
  await Promise.all([
    mkdir(path.dirname(input.result), { recursive: true }),
    mkdir(path.dirname(input.stdout), { recursive: true }),
    mkdir(path.dirname(input.stderr), { recursive: true }),
  ]);
  // Truncate previous logs for a relaunch of the same job id.
  await Promise.all([
    (await open(input.stdout, "w", 0o600)).close(),
    (await open(input.stderr, "w", 0o600)).close(),
  ]);

  const maxStreamBytes = input.maxStreamBytes ?? WATCHDOG_MAX_STREAM_BYTES;
  let terminationReason: "cancelled" | "timeout" | null = null;
  const child = spawn(input.command, input.args, {
    cwd: input.cwd,
    env: process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!child.stdout || !child.stderr) {
    throw new Error("Watchdog worker failed to open child stdio pipes");
  }

  const stdoutCapture = captureBoundedStream(child.stdout, input.stdout, maxStreamBytes);
  const stderrCapture = captureBoundedStream(child.stderr, input.stderr, maxStreamBytes);

  const terminate = (reason: "cancelled" | "timeout") => {
    if (child.exitCode !== null || child.signalCode !== null || terminationReason) return;
    terminationReason = reason;
    void terminateWithTreeKill(child, {
      gracefulTimeoutMs: 200,
      forceTimeoutMs: 200,
    });
  };
  const timeout =
    input.timeoutMs === undefined ? null : setTimeout(() => terminate("timeout"), input.timeoutMs);
  timeout?.unref();
  const checkCancellation = () => {
    if (!input.cancel) return;
    void access(input.cancel)
      .then(() => terminate("cancelled"))
      .catch(() => undefined);
  };
  checkCancellation();
  const cancellationPoll = input.cancel ? setInterval(checkCancellation, 50) : null;
  cancellationPoll?.unref();

  const result = await Promise.race([
    new Promise<WatchdogResult>((resolve) => {
      child.once("error", (error) =>
        resolve({
          exitCode: null,
          signal: null,
          error: error.message,
          finishedAt: new Date().toISOString(),
        }),
      );
    }),
    new Promise<WatchdogResult>((resolve) => {
      child.once("close", (exitCode, signal) =>
        resolve({
          exitCode: terminationReason ? null : exitCode,
          signal,
          error: null,
          finishedAt: new Date().toISOString(),
          ...(terminationReason ? { terminationReason } : {}),
        }),
      );
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (cancellationPoll) clearInterval(cancellationPoll);

  const [stdout, stderr] = await Promise.all([stdoutCapture, stderrCapture]);
  await writeJsonFileAtomic(
    input.result,
    {
      ...result,
      stdout,
      stderr,
    },
    { mode: 0o600 },
  );
}

function captureBoundedStream(
  stream: Readable,
  filePath: string,
  maxBytes: number,
): Promise<WatchdogStreamStats> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let truncated = false;
    const output = createWriteStream(filePath, { flags: "w", mode: 0o600 });
    stream.on("data", (chunk: Buffer | string) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      if (truncated) {
        return;
      }
      const remaining = maxBytes - bytes;
      if (buffer.length <= remaining) {
        bytes += buffer.length;
        if (!output.write(buffer)) {
          stream.pause();
          output.once("drain", () => stream.resume());
        }
        return;
      }
      if (remaining > 0) {
        bytes += remaining;
        output.write(buffer.subarray(0, remaining));
      }
      truncated = true;
      stream.resume();
    });
    stream.on("error", reject);
    output.on("error", reject);
    void finished(stream)
      .then(() => {
        output.end();
        return finished(output);
      })
      .then(() => resolve({ bytes, truncated }))
      .catch(reject);
  });
}
