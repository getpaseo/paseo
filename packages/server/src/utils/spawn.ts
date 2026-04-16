import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { promisify } from "node:util";

import { quoteWindowsArgument, quoteWindowsCommand } from "./executable.js";

const execFileAsync = promisify(execFile);

interface ExecCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  encoding?: BufferEncoding;
  timeout?: number;
  maxBuffer?: number;
}

interface ExecCommandResult {
  stdout: string;
  stderr: string;
}

export function spawnProcess(
  command: string,
  args: string[],
  options?: SpawnOptions,
): ChildProcess {
  const isWindows = process.platform === "win32";

  const resolvedCommand = isWindows ? quoteWindowsCommand(command) : command;
  const resolvedArgs = isWindows ? args.map(quoteWindowsArgument) : args;

  return spawn(resolvedCommand, resolvedArgs, {
    ...options,
    shell: options?.shell ?? isWindows,
    windowsHide: true,
  });
}

export async function execCommand(
  command: string,
  args: string[],
  options?: ExecCommandOptions,
): Promise<ExecCommandResult> {
  const isWindows = process.platform === "win32";
  const resolvedCommand = isWindows ? quoteWindowsCommand(command) : command;
  const resolvedArgs = isWindows ? args.map(quoteWindowsArgument) : args;

  return execFileAsync(resolvedCommand, resolvedArgs, {
    cwd: options?.cwd,
    env: options?.env,
    encoding: options?.encoding ?? "utf8",
    timeout: options?.timeout,
    maxBuffer: options?.maxBuffer,
    shell: isWindows,
    windowsHide: true,
  }) as Promise<ExecCommandResult>;
}

export function platformShell(): { command: string; flag: string[] } {
  if (process.platform === "win32") {
    return { command: "cmd.exe", flag: ["/c"] };
  }

  return { command: "/bin/sh", flag: ["-lc"] };
}

export function platformBash(): { command: string; flag: string[] } {
  if (process.platform === "win32") {
    return { command: "cmd.exe", flag: ["/c"] };
  }

  return { command: "/bin/bash", flag: ["-lc"] };
}
