// Process access stays behind the server runtime boundary.
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const RUNTIME_CONTROL_ENV_KEYS = [
  "PASEO_NODE_ENV",
  "PASEO_DESKTOP_MANAGED",
  "PASEO_SUPERVISED",
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_NO_ATTACH_CONSOLE",
  "ESBUILD_BINARY_PATH",
] as const;

type ProcessEnvRecord = Record<string, string | undefined>;

export interface ExecCommandOptions {
  cwd?: string;
  envOverlay?: ProcessEnvRecord;
  maxBuffer?: number;
  timeout?: number;
  shell?: boolean | string;
}

export interface ExecCommandResult {
  stdout: string;
  stderr: string;
}

export function createExternalProcessEnv(
  baseEnv: ProcessEnvRecord,
  envOverlay: ProcessEnvRecord = {},
): NodeJS.ProcessEnv {
  const env: ProcessEnvRecord = { ...baseEnv, ...envOverlay };
  for (const key of RUNTIME_CONTROL_ENV_KEYS) {
    delete env[key];
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  return env;
}

function isWindowsCommandScript(command: string): boolean {
  const extension = path.extname(command).toLowerCase();
  return process.platform === "win32" && (extension === ".cmd" || extension === ".bat");
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

const WINDOWS_CMD_META_CHARACTERS = /([()\][%!^"`<>&|;, *?])/gu;

export function shouldUseWindowsShell(
  command: string,
  requestedShell?: boolean | string,
): boolean | string {
  if (isWindowsCommandScript(command)) return true;
  if (requestedShell !== undefined) return requestedShell;
  return process.platform === "win32" && !hasPathSeparator(command) && !path.extname(command);
}

function escapeWindowsCmdMetaCharacters(value: string, twice: boolean): string {
  const escaped = value.replace(WINDOWS_CMD_META_CHARACTERS, "^$1");
  return twice ? escaped.replace(WINDOWS_CMD_META_CHARACTERS, "^$1") : escaped;
}

function escapeWindowsCmdArgument(value: string, twice: boolean): string {
  if (process.platform !== "win32") return value;
  const quoted = value
    .replace(/(\\*)"/gu, (_match, slashes: string) => `${slashes}${slashes}\\"`)
    .replace(/\\+$/u, (slashes) => `${slashes}${slashes}`);
  return escapeWindowsCmdMetaCharacters(`"${quoted}"`, twice);
}

export function quoteWindowsCommand(command: string): string {
  if (process.platform !== "win32") return command;
  return escapeWindowsCmdMetaCharacters(path.normalize(command), false);
}

export function quoteWindowsArgument(argument: string, doubleEscapeMetaCharacters = false): string {
  return escapeWindowsCmdArgument(argument, doubleEscapeMetaCharacters);
}

export async function execCommand(
  command: string,
  args: string[],
  options: ExecCommandOptions = {},
): Promise<ExecCommandResult> {
  const shell = shouldUseWindowsShell(command, options.shell);
  const useWindowsCommandShell = process.platform === "win32" && shell === true;
  const doubleEscapeMetaCharacters = isWindowsCommandScript(command);
  const shellCommand = useWindowsCommandShell
    ? [
        quoteWindowsCommand(command),
        ...args.map((argument) => quoteWindowsArgument(argument, doubleEscapeMetaCharacters)),
      ].join(" ")
    : null;
  const resolvedCommand = useWindowsCommandShell
    ? (process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe")
    : command;
  const resolvedArgs = shellCommand ? ["/d", "/s", "/c", `"${shellCommand}"`] : args;
  const result = await execFileAsync(resolvedCommand, resolvedArgs, {
    cwd: options.cwd,
    env: createExternalProcessEnv(process.env, options.envOverlay),
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
    timeout: options.timeout,
    windowsHide: true,
    shell: useWindowsCommandShell ? false : shell,
    windowsVerbatimArguments: useWindowsCommandShell,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

export async function findExecutable(name: string): Promise<string | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const pathValue = process.env.PATH ?? "";
  const extensions =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, `${trimmed}${extension}`);
      try {
        await access(candidate, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
        return candidate;
      } catch {
        // Continue searching PATH.
      }
    }
  }
  return null;
}

export function runGitCommand(
  args: string[],
  options: { cwd: string },
): Promise<ExecCommandResult> {
  return execCommand("git", args, { cwd: options.cwd });
}
