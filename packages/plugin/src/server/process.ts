import {
  execFile,
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
} from "node:child_process";
import { extname } from "node:path";
import { promisify } from "node:util";
import {
  isWindowsCommandScript,
  quoteWindowsArgument,
  quoteWindowsCommand,
} from "./process-internal/windows-command.js";
import type { PluginLaunchWrap } from "./lifecycle.js";
const execFileAsync = promisify(execFile);
export interface ExecCommandOptions {
  env?: NodeJS.ProcessEnv;
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
  requestedShell: boolean | string | undefined,
  platform: NodeJS.Platform,
): boolean | string {
  if (isWindowsCommandScript(command, platform)) {
    return true;
  }
  if (requestedShell !== undefined) {
    return requestedShell;
  }
  return platform === "win32" && !hasPathSeparator(command) && !extname(command);
}

export interface SpawnInvocation {
  command: string;
  args: string[];
  shell: boolean | string;
}

/**
 * How `spawnProcess` and `execCommand` start `command` on `platform`. On Windows a command script
 * or a bare name runs through cmd.exe, so the command and every argument are quoted for it.
 */
export function resolveSpawnInvocation(
  command: string,
  args: readonly string[],
  requestedShell: boolean | string | undefined,
  platform: NodeJS.Platform = process.platform,
): SpawnInvocation {
  const shell = shouldUseWindowsShell(command, requestedShell, platform);
  if (platform !== "win32" || shell === false) return { command, args: [...args], shell };
  return {
    command: quoteWindowsCommand(command, platform),
    args: args.map((argument) => quoteWindowsArgument(argument, platform)),
    shell,
  };
}

export interface SpawnProcessOptions extends SpawnOptions {
  /**
   * Start `[...wrap, command, ...args]`: the wrap's executable runs the command. `shell` is then
   * ignored; the wrap's executable runs through cmd.exe only when it is a `.cmd` or `.bat` file.
   */
  wrap?: PluginLaunchWrap;
}

/** Launch a CLI with Windows command-script handling and argv quoting. The caller owns env. */
export function spawnProcess(
  command: string,
  args: string[],
  options: SpawnProcessOptions & { stdio: "pipe" },
): ChildProcessWithoutNullStreams;
export function spawnProcess(
  command: string,
  args: string[],
  options?: SpawnProcessOptions,
): ChildProcess;
export function spawnProcess(
  command: string,
  args: string[],
  options?: SpawnProcessOptions,
): ChildProcess {
  const { wrap, ...spawnOptions } = options ?? {};
  const invocation = wrap
    ? resolveSpawnInvocation(wrap[0], [...wrap.slice(1), command, ...args], false)
    : resolveSpawnInvocation(command, args, spawnOptions.shell);

  return spawn(invocation.command, invocation.args, {
    ...spawnOptions,
    env: options?.env,
    shell: invocation.shell,
    signal: options?.signal,
    windowsHide: true,
  });
}

export async function execCommand(
  command: string,
  args: string[],
  options?: ExecCommandOptions,
): Promise<ExecCommandResult> {
  const invocation = resolveSpawnInvocation(command, args, options?.shell);

  return execFileAsync(invocation.command, invocation.args, {
    cwd: options?.cwd,
    env: options?.env,
    encoding: options?.encoding ?? "utf8",
    signal: options?.signal,
    killSignal: options?.killSignal,
    timeout: options?.timeout,
    maxBuffer: options?.maxBuffer,
    shell: invocation.shell,
    windowsHide: true,
  }) as Promise<ExecCommandResult>;
}

/** Force-stop a CLI, including descendants behind Windows command-script launchers. */
export async function terminateProcess(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGKILL",
): Promise<void> {
  if (process.platform !== "win32") {
    child.kill(signal);
    return;
  }
  if (child.pid === undefined) return;
  try {
    await execCommand("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      shell: false,
      timeout: 5000,
    });
  } catch (error) {
    // The process can finish between its close check and taskkill.
    if (!(error instanceof Error && "code" in error && error.code === 128)) throw error;
  }
}
