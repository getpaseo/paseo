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
  findWindowsCommand,
  isWindowsCommandScript,
  windowsCommandLine,
  windowsCommandShell,
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
  /**
   * `true` runs the command through cmd.exe on Windows, quoted for it. A shell named here other
   * than cmd.exe gets the command and arguments as given, on every platform; quote for it.
   */
  shell?: boolean | string;
  signal?: AbortSignal;
}
interface ExecCommandResult {
  stdout: string;
  stderr: string;
}

export interface SpawnInvocation {
  command: string;
  args: string[];
  shell: boolean | string;
  /** The args are one cmd.exe line that Node must pass as given. */
  windowsVerbatimArguments?: boolean;
}

function namesCmd(shell: boolean | string | undefined): boolean {
  return (
    shell === true || (typeof shell === "string" && /^(?:.*[\\/])?cmd(?:\.exe)?$/iu.test(shell))
  );
}

/**
 * How `spawnProcess` and `execCommand` start `command` on `platform`.
 *
 * On Windows a bare name is first found on `PATH`, as cmd.exe would find it, unless the caller
 * passes `shell: false`. A program then starts directly. A `.cmd` or `.bat` script, a name that is not on `PATH` (a cmd.exe builtin), or a
 * `shell: true` launch runs as `cmd.exe /d /s /c "..."`, quoted by `windowsCommandLine`. A shell
 * the caller names other than cmd.exe gets the command and arguments as given.
 */
export function resolveSpawnInvocation(
  command: string,
  args: readonly string[],
  requestedShell: boolean | string | undefined,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): SpawnInvocation {
  if (platform !== "win32") return { command, args: [...args], shell: requestedShell ?? false };
  if (typeof requestedShell === "string" && !namesCmd(requestedShell)) {
    return { command, args: [...args], shell: requestedShell };
  }
  const bareName = !/[\\/]/u.test(command) && !extname(command);
  // `shell: false` starts a bare name directly, and Windows searches PATH without blocking Node.
  const found = bareName && requestedShell !== false ? findWindowsCommand(command, env) : undefined;
  const target = found ?? command;
  const commandScript = isWindowsCommandScript(target, platform);
  // Only cmd.exe knows a builtin, so a bare name off `PATH` goes to it unless the caller said no shell.
  const builtin = bareName && !found && requestedShell === undefined;
  if (!commandScript && !namesCmd(requestedShell) && !builtin) {
    return { command: target, args: [...args], shell: false };
  }
  // A cmd.exe the caller names runs the line; otherwise the child's ComSpec does.
  return {
    command: typeof requestedShell === "string" ? requestedShell : windowsCommandShell(env),
    args: ["/d", "/s", "/c", windowsCommandLine(target, args, { commandScript })],
    shell: false,
    windowsVerbatimArguments: true,
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
  const env = options?.env ?? process.env;
  const invocation = wrap
    ? resolveSpawnInvocation(wrap[0], [...wrap.slice(1), command, ...args], false, undefined, env)
    : resolveSpawnInvocation(command, args, spawnOptions.shell, undefined, env);

  return spawn(invocation.command, invocation.args, {
    ...spawnOptions,
    env: options?.env,
    shell: invocation.shell,
    // Paseo's own cmd.exe line is verbatim; a direct launch keeps the caller's choice.
    windowsVerbatimArguments:
      invocation.windowsVerbatimArguments ?? spawnOptions.windowsVerbatimArguments,
    signal: options?.signal,
    windowsHide: true,
  });
}

export async function execCommand(
  command: string,
  args: string[],
  options?: ExecCommandOptions,
): Promise<ExecCommandResult> {
  const invocation = resolveSpawnInvocation(
    command,
    args,
    options?.shell,
    undefined,
    options?.env ?? process.env,
  );

  return execFileAsync(invocation.command, invocation.args, {
    cwd: options?.cwd,
    env: options?.env,
    encoding: options?.encoding ?? "utf8",
    signal: options?.signal,
    killSignal: options?.killSignal,
    timeout: options?.timeout,
    maxBuffer: options?.maxBuffer,
    shell: invocation.shell,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
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
