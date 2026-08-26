import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";

import { writeJsonFileAtomic } from "../atomic-file.js";
import type { WatchdogLauncher, WatchdogResult, WatchdogResultReader } from "./service.js";

const WatchdogResultFileSchema = z.object({
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  error: z.string().nullable(),
  finishedAt: z.string(),
  terminationReason: z.enum(["cancelled", "timeout"]).optional(),
  stdout: z
    .object({
      bytes: z.number().int().nonnegative(),
      truncated: z.boolean(),
    })
    .optional(),
  stderr: z
    .object({
      bytes: z.number().int().nonnegative(),
      truncated: z.boolean(),
    })
    .optional(),
});

export class DetachedWatchdogLauncher implements WatchdogLauncher {
  private readonly workerModulePath: string;

  constructor(
    private readonly paseoHome: string,
    workerModulePath?: string,
  ) {
    if (workerModulePath) {
      this.workerModulePath = workerModulePath;
      return;
    }
    const builtWorkerPath = fileURLToPath(new URL("./worker-entrypoint.js", import.meta.url));
    this.workerModulePath = existsSync(builtWorkerPath)
      ? builtWorkerPath
      : fileURLToPath(new URL("./worker-entrypoint.ts", import.meta.url));
  }

  async launch(input: {
    jobId: string;
    cwd: string;
    command: string;
    args: string[];
    timeoutMs?: number;
  }): Promise<{ pid: number }> {
    const requestPath = path.join(this.paseoHome, "watchdogs", "requests", `${input.jobId}.json`);
    await writeJsonFileAtomic(
      requestPath,
      {
        ...input,
        result: path.join(this.paseoHome, "watchdogs", "results", `${input.jobId}.json`),
        stdout: path.join(this.paseoHome, "watchdogs", "logs", `${input.jobId}.stdout.log`),
        stderr: path.join(this.paseoHome, "watchdogs", "logs", `${input.jobId}.stderr.log`),
        lock: path.join(this.paseoHome, "watchdogs", "locks", `${input.jobId}.lock`),
        cancel: path.join(this.paseoHome, "watchdogs", "cancellations", `${input.jobId}.json`),
      },
      { mode: 0o600 },
    );
    const runtimeArgs = this.workerModulePath.endsWith(".ts") ? ["--import", "tsx"] : [];
    const worker = spawn(process.execPath, [...runtimeArgs, this.workerModulePath, requestPath], {
      detached: true,
      stdio: "ignore",
      shell: false,
    });
    if (!worker.pid) {
      throw new Error("Failed to start watchdog worker");
    }
    worker.unref();
    return { pid: worker.pid };
  }
}

export class FileWatchdogResultReader implements WatchdogResultReader {
  constructor(private readonly paseoHome: string) {}

  async read(jobId: string): Promise<WatchdogResult | null> {
    try {
      const content = await readFile(this.resultPath(jobId), "utf8");
      return WatchdogResultFileSchema.parse(JSON.parse(content));
    } catch (error) {
      if (isNodeErrorWithCode(error, "ENOENT")) {
        return null;
      }
      throw error;
    }
  }

  private resultPath(jobId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(jobId)) {
      throw new Error(`Invalid watchdog job id: ${jobId}`);
    }
    return path.join(this.paseoHome, "watchdogs", "results", `${jobId}.json`);
  }
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
