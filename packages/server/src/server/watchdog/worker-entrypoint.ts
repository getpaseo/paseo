import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { writeJsonFileAtomic } from "../atomic-file.js";
import { runWatchdogWorker } from "./worker.js";

const WorkerRequestSchema = z.object({
  jobId: z.string().min(1),
  cwd: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()),
  result: z.string().min(1),
  stdout: z.string().min(1),
  stderr: z.string().min(1),
  lock: z.string().min(1),
  cancel: z.string().min(1),
  timeoutMs: z.number().int().positive().max(2_147_483_647).optional(),
});

async function main(): Promise<void> {
  const requestPath = process.argv[2];
  if (!requestPath) {
    throw new Error("Watchdog worker requires a request path");
  }
  const request = WorkerRequestSchema.parse(JSON.parse(await readFile(requestPath, "utf8")));
  try {
    await mkdir(path.dirname(request.lock), { recursive: true });
    const lock = await open(request.lock, "wx", 0o600);
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    await lock.close();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return;
    }
    throw error;
  }
  await runWatchdogWorker(request);
}

void main().catch(async (error: unknown) => {
  const requestPath = process.argv[2];
  if (requestPath) {
    try {
      const request = WorkerRequestSchema.parse(JSON.parse(await readFile(requestPath, "utf8")));
      await writeJsonFileAtomic(
        request.result,
        {
          exitCode: null,
          signal: null,
          error: error instanceof Error ? error.message : String(error),
          finishedAt: new Date().toISOString(),
        },
        { mode: 0o600 },
      );
    } catch {
      // The daemon will retain the queued job for operator inspection when even the request is unreadable.
    }
  }
  process.exitCode = 1;
});
