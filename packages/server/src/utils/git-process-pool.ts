import { exec, execFile, type ExecOptions, type ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";

const rawExecAsync = promisify(exec);
const rawExecFileAsync = promisify(execFile);

/**
 * Default timeout for read-only git operations (30 seconds).
 * Mutating operations (merge, push, fetch) should pass a longer timeout.
 */
const DEFAULT_GIT_TIMEOUT_MS = 30_000;

/**
 * Maximum concurrent git subprocesses. Prevents the event loop from becoming
 * saturated, which in turn prevents zombie accumulation (SIGCHLD can't be
 * processed when the loop is starved).
 */
const MAX_CONCURRENT_GIT_PROCESSES = 8;

// ---------------------------------------------------------------------------
// Semaphore – bounds the number of concurrent git subprocesses
// ---------------------------------------------------------------------------

class Semaphore {
  private available: number;
  private readonly waiters: (() => void)[] = [];

  constructor(max: number) {
    this.available = max;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.available++;
    }
  }
}

const gitSemaphore = new Semaphore(MAX_CONCURRENT_GIT_PROCESSES);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Concurrency-limited, timeout-aware wrapper around `child_process.exec`.
 *
 * This goes through the shell (`sh -c "…"`). Prefer `gitExecFile` when
 * the command can be expressed as a program + args array — it avoids
 * spawning an extra shell process.
 */
export async function gitExec(
  command: string,
  options: ExecOptions & { maxBuffer?: number },
): Promise<{ stdout: string; stderr: string }> {
  const timeout = options.timeout ?? DEFAULT_GIT_TIMEOUT_MS;
  await gitSemaphore.acquire();
  try {
    const result = await rawExecAsync(command, { ...options, timeout });
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  } finally {
    gitSemaphore.release();
  }
}

/**
 * Concurrency-limited, timeout-aware wrapper around `child_process.execFile`.
 *
 * Does NOT spawn a shell — avoids the extra `sh` process that causes zombie
 * accumulation on Linux.
 */
export async function gitExecFile(
  file: string,
  args: string[],
  options: ExecFileOptions & { maxBuffer?: number },
): Promise<{ stdout: string; stderr: string }> {
  const timeout = options.timeout ?? DEFAULT_GIT_TIMEOUT_MS;
  await gitSemaphore.acquire();
  try {
    const result = await rawExecFileAsync(file, args, { ...options, timeout });
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  } finally {
    gitSemaphore.release();
  }
}

/**
 * Acquire a slot in the git process pool. The caller is responsible for
 * calling `release()` when their subprocess completes. Use this for
 * `spawn()`-based flows (e.g. `spawnLimitedText`) that can't use the
 * higher-level wrappers.
 */
export async function acquireGitSlot(): Promise<{ release: () => void }> {
  await gitSemaphore.acquire();
  return {
    release: () => gitSemaphore.release(),
  };
}
