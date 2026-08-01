import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { extname } from "node:path";

import { createExternalCommandProcessEnv, type ProcessEnvRecord } from "../server/paseo-env.js";
import { terminateWithTreeKill } from "./tree-kill.js";
import {
  isWindowsCommandScript,
  quoteWindowsArgument,
  quoteWindowsCommand,
} from "./windows-command.js";

interface ExternalEnvOptions {
  baseEnv?: ProcessEnvRecord;
  envMode?: "external" | "internal";
  env?: ProcessEnvRecord;
  envOverlay?: ProcessEnvRecord;
}

export type SpawnProcessOptions = Omit<SpawnOptions, "env"> & ExternalEnvOptions;

interface ExecCommandOptions extends ExternalEnvOptions {
  cwd?: string;
  encoding?: BufferEncoding;
  killSignal?: NodeJS.Signals;
  timeout?: number;
  maxBuffer?: number;
  shell?: boolean | string;
  signal?: AbortSignal;
}

interface ExecCommandResult {
  stdout: string;
  stderr: string;
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function shouldUseWindowsShell(
  command: string,
  requestedShell?: boolean | string,
): boolean | string {
  if (isWindowsCommandScript(command)) {
    return true;
  }
  if (requestedShell !== undefined) {
    return requestedShell;
  }
  return process.platform === "win32" && !hasPathSeparator(command) && !extname(command);
}

export function spawnProcess(
  command: string,
  args: string[],
  options?: SpawnProcessOptions,
): ChildProcess {
  const { baseEnv, env, envOverlay, ...spawnOptions } = options ?? {};
  const resolvedBaseEnv = env ?? baseEnv ?? process.env;
  const isWindows = process.platform === "win32";
  const shell = shouldUseWindowsShell(command, spawnOptions.shell);

  const shouldQuoteForShell = isWindows && shell !== false;
  const resolvedCommand = shouldQuoteForShell ? quoteWindowsCommand(command) : command;
  const resolvedArgs = shouldQuoteForShell ? args.map(quoteWindowsArgument) : args;
  const childEnv =
    options?.envMode === "internal"
      ? ({ ...resolvedBaseEnv, ...envOverlay } as NodeJS.ProcessEnv)
      : createExternalCommandProcessEnv(
          command,
          resolvedBaseEnv,
          ...(envOverlay ? [envOverlay] : []),
        );

  return spawn(resolvedCommand, resolvedArgs, {
    ...spawnOptions,
    env: childEnv,
    shell,
    windowsHide: true,
  });
}

export async function execCommand(
  command: string,
  args: string[],
  options?: ExecCommandOptions,
): Promise<ExecCommandResult> {
  validateExecCommandOptions(options);
  const { baseEnv, env, envOverlay } = options ?? {};
  const resolvedBaseEnv = env ?? baseEnv ?? process.env;
  const isWindows = process.platform === "win32";
  const shell = shouldUseWindowsShell(command, options?.shell);
  const shouldQuoteForShell = isWindows && shell !== false;
  const resolvedCommand = shouldQuoteForShell ? quoteWindowsCommand(command) : command;
  const resolvedArgs = shouldQuoteForShell ? args.map(quoteWindowsArgument) : args;
  const childEnv =
    options?.envMode === "internal"
      ? ({ ...resolvedBaseEnv, ...envOverlay } as NodeJS.ProcessEnv)
      : createExternalCommandProcessEnv(
          command,
          resolvedBaseEnv,
          ...(envOverlay ? [envOverlay] : []),
        );

  options?.signal?.throwIfAborted();
  return await new Promise<ExecCommandResult>((resolve, reject) => {
    let terminating = false;
    let settled = false;
    let timeout: NodeJS.Timeout | null = null;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutLength = 0;
    let stderrLength = 0;
    const maxBuffer = options?.maxBuffer ?? 1024 * 1024;
    const child = spawn(resolvedCommand, resolvedArgs, {
      cwd: options?.cwd,
      env: childEnv,
      shell,
      detached: process.platform !== "win32",
      windowsHide: true,
    });

    const clearControlFlow = () => {
      if (timeout) clearTimeout(timeout);
      options?.signal?.removeEventListener("abort", onAbort);
    };
    const terminate = (reason: Error) => {
      if (terminating || settled) return;
      terminating = true;
      clearControlFlow();
      void (async () => {
        try {
          await terminateAbortableCommand(child, options?.killSignal ?? "SIGTERM");
          if (settled) return;
          settled = true;
          reject(reason);
        } catch {
          if (settled) return;
          settled = true;
          reject(reason);
        }
      })();
    };
    const onAbort = () => {
      terminate(
        options?.signal?.reason instanceof Error
          ? options.signal.reason
          : new Error("Command execution aborted"),
      );
    };
    const collect = (target: Buffer[], chunk: Buffer, stream: "stdout" | "stderr") => {
      if (terminating || settled) return;
      target.push(chunk);
      if (stream === "stdout") {
        stdoutLength += chunk.length;
      } else {
        stderrLength += chunk.length;
      }
      if (stdoutLength > maxBuffer || stderrLength > maxBuffer) {
        terminate(
          Object.assign(new Error(`${stream} exceeded maxBuffer of ${maxBuffer} bytes`), {
            code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          }),
        );
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => collect(stdout, chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => collect(stderr, chunk, "stderr"));
    child.once("error", (error) => {
      if (terminating || settled) return;
      settled = true;
      clearControlFlow();
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (terminating || settled) return;
      settled = true;
      clearControlFlow();
      const encoding = options?.encoding ?? "utf8";
      const output = {
        stdout: Buffer.concat(stdout).toString(encoding),
        stderr: Buffer.concat(stderr).toString(encoding),
      };
      if (code === 0) {
        resolve(output);
        return;
      }
      reject(
        Object.assign(new Error(`Command failed with exit code ${code ?? signal ?? "unknown"}`), {
          code,
          signal,
          killed: child.killed,
          ...output,
        }),
      );
    });
    options?.signal?.addEventListener("abort", onAbort, { once: true });
    if (options?.signal?.aborted) {
      onAbort();
    }
    if (options?.timeout !== undefined && options.timeout > 0 && !terminating) {
      timeout = setTimeout(() => {
        const error = Object.assign(
          new Error(`Command execution timed out after ${options.timeout}ms`),
          { killed: true },
        );
        terminate(error);
      }, options.timeout);
      timeout.unref?.();
    }
  });
}

function validateExecCommandOptions(options: ExecCommandOptions | undefined): void {
  if (
    options?.timeout !== undefined &&
    (!Number.isInteger(options.timeout) || options.timeout < 0 || options.timeout > 0xffff_ffff)
  ) {
    throw new RangeError(`timeout must be an unsigned 32-bit integer: ${options.timeout}`);
  }
  if (
    options?.maxBuffer !== undefined &&
    (Number.isNaN(options.maxBuffer) || options.maxBuffer < 0)
  ) {
    throw new RangeError(`maxBuffer must be a non-negative number: ${options.maxBuffer}`);
  }
}

async function terminateAbortableCommand(
  child: ChildProcess,
  gracefulSignal: NodeJS.Signals,
): Promise<void> {
  if (process.platform === "win32") {
    const result = await terminateWithTreeKill(child, {
      gracefulSignal,
      gracefulTimeoutMs: 1_000,
      forceSignal: "SIGKILL",
      forceTimeoutMs: 1_000,
    });
    if (result === "kill-timeout") {
      throw new Error("Timed out while terminating aborted command");
    }
    return;
  }

  const pid = child.pid;
  if (typeof pid !== "number" || pid <= 0) {
    signalChild(child, gracefulSignal);
    await waitForChildExitOrTimeout(waitForChildExit(child), 1_000);
    return;
  }

  const exitPromise = waitForChildExit(child);
  signalProcessGroup(pid, gracefulSignal);
  if (
    (await waitForProcessGroupExit(pid, 1_000)) &&
    (await waitForChildExitOrTimeout(exitPromise, 1_000))
  ) {
    return;
  }

  signalProcessGroup(pid, "SIGKILL");
  if (
    !(await waitForProcessGroupExit(pid, 1_000)) ||
    !(await waitForChildExitOrTimeout(exitPromise, 1_000))
  ) {
    throw new Error("Timed out while terminating aborted command");
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessGroupAlive(pid)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return false;
    }
    if (code === "EPERM") {
      return true;
    }
    throw error;
  }
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // Ignore cleanup races.
  }
}

function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => child.once("exit", resolve));
}

async function waitForChildExitOrTimeout(
  exitPromise: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      exitPromise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
