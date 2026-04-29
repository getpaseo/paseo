/**
 * `run_command` — one-shot shell execution scoped to a cwd with a
 * mandatory timeout. Stdout and stderr are captured separately. This is
 * distinct from the persistent terminal (`create_terminal` + friends),
 * which is for interactive sessions — run_command is for "run this,
 * give me the output, I'll decide next step" flows.
 *
 * Security notes:
 * - Shell is spawned with `/bin/sh -c` so pipes/redirects work. Callers
 *   (agents) are expected to pass trusted strings; the daemon doesn't
 *   sanitize because it can't know the intent.
 * - Timeout is required: an unterminated command would hold a file
 *   descriptor forever. We default to 30s for safety.
 */

import { spawn } from "node:child_process";

import { childEnv } from "../../utils/child-env.js";

export interface RunCommandInput {
  cwd: string;
  command: string;
  /** Extra env vars merged over `process.env`. */
  env?: Record<string, string>;
  /** Timeout in ms. Default 30_000. Max 600_000 (10 min). */
  timeoutMs?: number;
  /** Max bytes captured per stream. Past this, output is truncated and
   * the corresponding `*Truncated` flag is set. Default 1 MiB each. */
  maxBytes?: number;
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** True if we had to kill the process because it exceeded the timeout. */
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /** Wall-clock duration in ms. */
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_BYTES = 1024 * 1024;

export async function runCommand(input: RunCommandInput): Promise<RunCommandResult> {
  const timeoutMs = Math.min(Math.max(1, input.timeoutMs ?? DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS);
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  const start = Date.now();

  return new Promise<RunCommandResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;

    const child = spawn("/bin/sh", ["-c", input.command], {
      cwd: input.cwd,
      env: childEnv(input.env ?? {}),
      // Detach so `sh` becomes the leader of its own process group; otherwise
      // killing `sh` leaves grandchildren (e.g. `sleep`) running with shared
      // stdio, and `child.on("close")` blocks until the grandchild exits
      // naturally — the test would observe durationMs ≈ 5s instead of <200ms.
      detached: true,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      // SIGKILL the whole process group (negative pid = group leader's group).
      // SIGKILL guarantees exit even when long-running tools (npm, cargo)
      // swallow SIGTERM.
      try {
        if (child.pid !== undefined) {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        // Process may have already exited between the timer firing and the
        // kill — that's fine, the close handler will still resolve.
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutTruncated) return;
      const room = maxBytes - stdout.length;
      if (room <= 0) {
        stdoutTruncated = true;
        return;
      }
      if (chunk.length > room) {
        stdout += chunk.subarray(0, room).toString("utf-8");
        stdoutTruncated = true;
      } else {
        stdout += chunk.toString("utf-8");
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrTruncated) return;
      const room = maxBytes - stderr.length;
      if (room <= 0) {
        stderrTruncated = true;
        return;
      }
      if (chunk.length > room) {
        stderr += chunk.subarray(0, room).toString("utf-8");
        stderrTruncated = true;
      } else {
        stderr += chunk.toString("utf-8");
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: code,
        timedOut,
        stdoutTruncated,
        stderrTruncated,
        durationMs: Date.now() - start,
      });
    });
  });
}
