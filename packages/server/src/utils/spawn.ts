import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
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
    let aborting = false;
    let settled = false;
    const child = execFile(
      resolvedCommand,
      resolvedArgs,
      {
        cwd: options?.cwd,
        env: childEnv,
        encoding: options?.encoding ?? "utf8",
        killSignal: options?.killSignal,
        timeout: options?.timeout,
        maxBuffer: options?.maxBuffer,
        shell,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (aborting || settled) return;
        settled = true;
        options?.signal?.removeEventListener("abort", onAbort);
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );

    const onAbort = () => {
      if (aborting || settled) return;
      aborting = true;
      void (async () => {
        try {
          await terminateAbortableCommand(child, options?.killSignal ?? "SIGTERM");
          if (settled) return;
          settled = true;
          options?.signal?.removeEventListener("abort", onAbort);
          reject(
            options?.signal?.reason instanceof Error
              ? options.signal.reason
              : new Error("Command execution aborted"),
          );
        } catch (error: unknown) {
          if (settled) return;
          settled = true;
          options?.signal?.removeEventListener("abort", onAbort);
          reject(error);
        }
      })();
    };
    options?.signal?.addEventListener("abort", onAbort, { once: true });
    if (options?.signal?.aborted) {
      onAbort();
    }
  });
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

  const exitPromise = waitForChildExit(child);
  signalChild(child, gracefulSignal);
  if (await waitForChildExitOrTimeout(exitPromise, 1_000)) return;

  signalChild(child, "SIGKILL");
  if (!(await waitForChildExitOrTimeout(exitPromise, 1_000))) {
    throw new Error("Timed out while terminating aborted command");
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
