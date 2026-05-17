import { existsSync } from "node:fs";
import pLimit from "p-limit";
import type { Logger } from "pino";
import type { ProcessEnvRecord } from "../server/paseo-env.js";
import { spawnProcess } from "./spawn.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 20 * 1024 * 1024; // 20MB
const DEFAULT_STDERR_LIMIT = 2048;

const gitConcurrency = parseInt(process.env.PASEO_GIT_CONCURRENCY ?? "8", 10) || 8;
const gitLimit = pLimit(gitConcurrency);

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
  return gitLimit(
    () =>
      new Promise<GitCommandResult>((resolve, reject) => {
        const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
        const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
        const acceptExitCodes = options.acceptExitCodes ?? [0];
        const command = formatGitCommand(args);
        const envOverlay = mergeEnvOverlays(options.env, options.envOverlay);
        const startedAt = Date.now();
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

        // `core.quotepath=false` makes git emit raw UTF-8 paths instead of
        // octal-escaping non-ASCII bytes (e.g. `测试文件.txt` vs `"\346\265\213..."`).
        const child = spawnProcess("git", ["-c", "core.quotepath=false", ...args], {
          cwd: options.cwd,
          envOverlay,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let settled = false;
        let truncated = false;
        let stdoutBytes = 0;
        let stderrBytes = 0;
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];

        const settle = (callback: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          callback();
        };

        const timer = setTimeout(() => {
          const error = new Error(`Git command timed out after ${timeout}ms: ${command}`);
          child.kill("SIGKILL");
          settle(() => reject(error));
        }, timeout);

        child.stdout!.on("data", (chunk: Buffer | string) => {
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

        child.stderr!.on("data", (chunk: Buffer | string) => {
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
          settle(() => reject(error));
        });

        child.on("close", (exitCode, signal) => {
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
      }),
  );
}

function formatGitCommand(args: string[]): string {
  return ["git", ...args].join(" ");
}
