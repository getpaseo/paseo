import { existsSync } from "node:fs";
import type { Logger } from "pino";
import type { ProcessEnvRecord } from "../server/paseo-env.js";
import {
  GitCommandRuntimeMetricsWindow,
  type GitCommandRuntimeMetricsSnapshot,
} from "./git-command-runtime-metrics.js";
import {
  settleGitCommandTrace,
  spawnGitCommandTrace,
  startGitCommandTrace,
  submitGitCommandTrace,
} from "./git-command-trace.js";
import { spawnProcess } from "./spawn.js";
import {
  GitProcessScheduler,
  resolveGitProcessPolicy,
  type GitProcessPolicy,
} from "./git-process-scheduler.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 20 * 1024 * 1024; // 20MB
const DEFAULT_STDERR_LIMIT = 2048;

let gitProcessScheduler = new GitProcessScheduler(resolveGitProcessPolicy({ env: process.env }));
let gitRuntimeMetrics = createGitCommandRuntimeMetricsWindow(gitProcessScheduler.policy);

function createGitCommandRuntimeMetricsWindow(policy: GitProcessPolicy) {
  return new GitCommandRuntimeMetricsWindow({
    concurrencyLimit: policy.maxProcessConcurrency,
    maxProcessesPerSecond: policy.maxProcessesPerSecond,
  });
}

export function configureGitProcessPolicy(policy: GitProcessPolicy): void {
  gitProcessScheduler = new GitProcessScheduler(policy);
  gitRuntimeMetrics = createGitCommandRuntimeMetricsWindow(policy);
}

export interface GitCommandOptions {
  cwd: string;
  env?: ProcessEnvRecord;
  envOverlay?: ProcessEnvRecord;
  logger?: Pick<Logger, "trace">;
  timeout?: number;
  maxOutputBytes?: number;
  acceptExitCodes?: number[];
}

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  truncated: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface GitCommandMetric {
  args: string[];
  cwd: string;
  startedAtMs: number;
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  success: boolean;
}

export interface GitCommandMetricsSnapshot {
  commands: GitCommandMetric[];
  total: number;
  failed: number;
  maxConcurrent: number;
}

interface GitCommandMetricsState {
  commands: GitCommandMetric[];
  active: number;
  maxConcurrent: number;
}

let gitCommandMetricsState: GitCommandMetricsState | null = null;

export function startGitCommandMetrics(): void {
  gitCommandMetricsState = {
    commands: [],
    active: 0,
    maxConcurrent: 0,
  };
}

export function stopGitCommandMetrics(): GitCommandMetricsSnapshot {
  const state = gitCommandMetricsState;
  gitCommandMetricsState = null;
  if (!state) {
    return {
      commands: [],
      total: 0,
      failed: 0,
      maxConcurrent: 0,
    };
  }
  return {
    commands: [...state.commands],
    total: state.commands.length,
    failed: state.commands.filter((command) => !command.success).length,
    maxConcurrent: state.maxConcurrent,
  };
}

export function snapshotGitCommandRuntimeMetrics(): GitCommandRuntimeMetricsSnapshot {
  return gitRuntimeMetrics.snapshotAndReset({
    active: gitProcessScheduler.activeCount,
    pending: gitProcessScheduler.pendingCount,
  });
}

function beginGitCommandMetric(): GitCommandMetricsState | null {
  const state = gitCommandMetricsState;
  if (!state) {
    return null;
  }
  state.active += 1;
  state.maxConcurrent = Math.max(state.maxConcurrent, state.active);
  return state;
}

function finishGitCommandMetric(
  state: GitCommandMetricsState | null,
  metric: GitCommandMetric,
): void {
  if (!state) {
    return;
  }
  state.active = Math.max(0, state.active - 1);
  state.commands.push(metric);
}

function mergeEnvOverlays(
  env: ProcessEnvRecord | undefined,
  envOverlay: ProcessEnvRecord | undefined,
): ProcessEnvRecord | undefined {
  if (!env) {
    return envOverlay;
  }
  if (!envOverlay) {
    return env;
  }
  return { ...env, ...envOverlay };
}

function getEnvOverlayKeys(envOverlay: ProcessEnvRecord | undefined): string[] {
  return Object.keys(envOverlay ?? {}).sort();
}

export function runGitCommand(
  args: string[],
  options: GitCommandOptions,
): Promise<GitCommandResult> {
  const commandTrace = submitGitCommandTrace(args, options.cwd, {
    active: gitProcessScheduler.activeCount,
    pending: gitProcessScheduler.pendingCount,
  });
  const runtimeMetric = gitRuntimeMetrics.submit(getGitOperation(args));
  const promise = gitProcessScheduler.run(() => {
    let releaseProcessSlot!: () => void;
    const exited = new Promise<void>((resolve) => {
      releaseProcessSlot = resolve;
    });
    const resultPromise = new Promise<GitCommandResult>((resolve, reject) => {
      startGitCommandTrace(commandTrace, {
        active: gitProcessScheduler.activeCount,
        pending: gitProcessScheduler.pendingCount,
      });
      gitRuntimeMetrics.start(runtimeMetric);
      const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
      const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
      const acceptExitCodes = options.acceptExitCodes ?? [0];
      const command = formatGitCommand(args);
      const envOverlay = mergeEnvOverlays(options.env, options.envOverlay);
      const startedAt = Date.now();
      const metricsState = beginGitCommandMetric();
      const logger = typeof options.logger?.trace === "function" ? options.logger : undefined;
      const traceContext = logger
        ? {
            command: "git",
            args,
            cwd: options.cwd,
            cwdExists: existsSync(options.cwd),
            timeout,
            maxOutputBytes,
            acceptExitCodes,
            envOverlayKeys: getEnvOverlayKeys(envOverlay),
          }
        : null;

      if (logger && traceContext) {
        logger.trace(traceContext, "Spawning git command");
      }

      let settled = false;
      let metricFinished = false;
      let processError: Error | null = null;
      let processExit: { exitCode: number | null; signal: NodeJS.Signals | null } | null = null;
      let timeoutError: Error | null = null;
      let truncated = false;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timer: NodeJS.Timeout | undefined;

      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        callback();
      };

      const finishMetricOnce = (metric: GitCommandMetric, timedOut = false) => {
        if (metricFinished) return;
        metricFinished = true;
        finishGitCommandMetric(metricsState, metric);
        gitRuntimeMetrics.finish(runtimeMetric, { success: metric.success, timedOut });
      };

      const settleTimeoutTrace = (exitCode: number | null, signal: NodeJS.Signals | null) => {
        settleGitCommandTrace(commandTrace, {
          outcome: "timed_out",
          exitCode,
          signal,
        });
      };

      const markProcessExited = (exitCode: number | null, signal: NodeJS.Signals | null) => {
        if (processExit) return;
        processExit = { exitCode, signal };
        const timedOut = timeoutError !== null;
        finishMetricOnce(
          {
            args,
            cwd: options.cwd,
            startedAtMs: startedAt,
            durationMs: Date.now() - startedAt,
            exitCode,
            signal,
            success:
              !timedOut && !processError && (truncated || acceptExitCodes.includes(exitCode ?? -1)),
          },
          timedOut,
        );
        releaseProcessSlot();
        if (timedOut) {
          settleTimeoutTrace(exitCode, signal);
        }
      };

      const rejectSpawnFailure = (error: unknown) => {
        processError = error instanceof Error ? error : new Error(String(error));
        markProcessExited(null, null);
        settleGitCommandTrace(commandTrace, {
          outcome: "spawn_error",
          exitCode: null,
          signal: null,
        });
        settle(() => reject(processError));
      };

      let child: ReturnType<typeof spawnProcess>;
      try {
        // `core.quotepath=false` makes git emit raw UTF-8 paths instead of
        // octal-escaping non-ASCII bytes (e.g. `测试文件.txt` vs `"\346\265\213..."`).
        child = spawnProcess("git", ["-c", "core.quotepath=false", ...args], {
          cwd: options.cwd,
          envOverlay,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
        spawnGitCommandTrace(commandTrace, child.pid);
      } catch (error) {
        rejectSpawnFailure(error);
        return;
      }

      const stdout = child.stdout;
      const stderr = child.stderr;
      if (!stdout || !stderr) {
        child.kill("SIGKILL");
        rejectSpawnFailure(new Error("Git process did not expose piped stdout and stderr"));
        return;
      }

      timer = setTimeout(() => {
        timeoutError = new Error(`Git command timed out after ${timeout}ms: ${command}`);
        child.kill("SIGKILL");
        settle(() => reject(timeoutError));
        if (processExit) {
          settleTimeoutTrace(processExit.exitCode, processExit.signal);
        }
      }, timeout);

      stdout.on("data", (chunk: Buffer | string) => {
        if (settled || truncated) return;

        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remainingBytes = maxOutputBytes - stdoutBytes;

        if (remainingBytes <= 0) {
          truncated = true;
          child.kill("SIGKILL");
          return;
        }

        if (buffer.length > remainingBytes) {
          stdoutChunks.push(buffer.subarray(0, remainingBytes));
          stdoutBytes += remainingBytes;
          truncated = true;
          child.kill("SIGKILL");
          return;
        }

        stdoutChunks.push(buffer);
        stdoutBytes += buffer.length;
      });

      stderr.on("data", (chunk: Buffer | string) => {
        if (settled || stderrBytes >= DEFAULT_STDERR_LIMIT) return;

        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remainingBytes = DEFAULT_STDERR_LIMIT - stderrBytes;

        if (buffer.length > remainingBytes) {
          stderrChunks.push(buffer.subarray(0, remainingBytes));
          stderrBytes += remainingBytes;
          return;
        }

        stderrChunks.push(buffer);
        stderrBytes += buffer.length;
      });

      child.on("error", (error) => {
        processError = error;
        if (logger && traceContext) {
          logger.trace(
            {
              ...traceContext,
              err: error,
              durationMs: Date.now() - startedAt,
            },
            "Git command process error",
          );
        }
      });

      child.on("exit", markProcessExited);

      child.on("close", (exitCode, signal) => {
        markProcessExited(exitCode, signal);
        const result: GitCommandResult = {
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          truncated,
          exitCode,
          signal,
        };
        if (logger && traceContext) {
          logger.trace(
            {
              ...traceContext,
              durationMs: Date.now() - startedAt,
              exitCode,
              signal,
              truncated,
              stdoutBytes,
              stderrBytes,
            },
            "Git command closed",
          );
        }

        if (timeoutError) {
          return;
        }

        if (processError) {
          settleGitCommandTrace(commandTrace, {
            outcome: "spawn_error",
            exitCode,
            signal,
          });
          settle(() => reject(processError));
          return;
        }

        settleGitCommandTrace(commandTrace, {
          outcome: "closed",
          exitCode,
          signal,
          truncated,
        });

        if (!truncated && !acceptExitCodes.includes(exitCode ?? -1)) {
          const stderrPreview = result.stderr.trim() || "(no stderr)";
          const truncationNote = result.truncated ? " (stdout truncated)" : "";

          settle(() =>
            reject(
              new Error(
                `Git command failed: ${command}${truncationNote} (exit code: ${String(exitCode)}, signal: ${signal ?? "none"})\n${stderrPreview}`,
              ),
            ),
          );
          return;
        }

        settle(() => resolve(result));
      });
    });
    return { result: resultPromise, exited };
  });
  gitRuntimeMetrics.observeLimiter(
    gitProcessScheduler.activeCount,
    gitProcessScheduler.pendingCount,
  );
  return promise;
}

function formatGitCommand(args: string[]): string {
  return ["git", ...args].join(" ");
}

function getGitOperation(args: string[]): string {
  return args[0] === "-c" ? (args[2] ?? "unknown") : (args[0] ?? "unknown");
}
