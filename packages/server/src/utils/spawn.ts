import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { extname } from "node:path";

import { createExternalCommandProcessEnv, type ProcessEnvRecord } from "../server/paseo-env.js";
import {
  isWindowsCommandScript,
  quoteWindowsArgument,
  quoteWindowsCommand,
} from "./windows-command.js";
import { terminateWithTreeKill } from "./tree-kill.js";

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
  signal?: AbortSignal;
  timeout?: number;
  maxBuffer?: number;
  shell?: boolean | string;
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
  options?.signal?.throwIfAborted();
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

  return await new Promise<ExecCommandResult>((resolve, reject) => {
    let callbackResult:
      | { error: Error | null; stdout: string | Buffer; stderr: string | Buffer }
      | undefined;
    let closed = false;
    let aborting = false;
    let abortComplete = false;
    let abortReason: unknown;
    let settled = false;
    const cleanup = () => {
      options?.signal?.removeEventListener("abort", abort);
    };
    const settle = () => {
      if (settled) {
        return;
      }
      if (aborting) {
        if (!abortComplete) {
          return;
        }
        settled = true;
        cleanup();
        reject(abortReason);
        return;
      }
      if (!closed || !callbackResult) {
        return;
      }
      settled = true;
      cleanup();
      if (callbackResult.error) {
        reject(callbackResult.error);
        return;
      }
      resolve({
        stdout: callbackResult.stdout.toString(),
        stderr: callbackResult.stderr.toString(),
      });
    };
    let child: ChildProcess;
    const abort = () => {
      if (aborting || settled) {
        return;
      }
      aborting = true;
      abortReason = options?.signal?.reason ?? new DOMException("Aborted", "AbortError");
      void terminateWithTreeKill(child, {
        gracefulSignal: options?.killSignal ?? "SIGTERM",
        forceSignal: "SIGKILL",
        gracefulTimeoutMs: options?.killSignal === "SIGKILL" ? 0 : 1_000,
        forceTimeoutMs: 1_000,
      }).then(
        () => {
          abortComplete = true;
          settle();
          return undefined;
        },
        () => {
          abortComplete = true;
          settle();
          return undefined;
        },
      );
    };
    child = execFile(
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
        callbackResult = { error, stdout, stderr };
        settle();
      },
    );
    child.once("close", () => {
      closed = true;
      settle();
    });
    if (options?.signal?.aborted) {
      abort();
    } else {
      options?.signal?.addEventListener("abort", abort, { once: true });
    }
  });
}
