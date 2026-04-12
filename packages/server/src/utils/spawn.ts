import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

/**
 * Platform-aware spawn that centralizes Windows shell and quoting concerns.
 *
 * On Windows:
 * - Enables `shell: true` (routes through cmd.exe) unless the caller explicitly sets `shell`
 * - Quotes the command and arguments so paths with spaces survive cmd.exe parsing
 * - Always sets `windowsHide: true` to prevent console window flashes
 *
 * On other platforms the call is passed through to `spawn` unchanged (with `windowsHide: true`).
 */
export function spawnProcess(
  command: string,
  args: string[],
  options?: SpawnOptions,
): ChildProcess {
  const isWindows = process.platform === "win32";

  const resolvedCommand = isWindows ? quoteForCmd(command) : command;
  const resolvedArgs = isWindows ? args.map(quoteForCmd) : args;

  return spawn(resolvedCommand, resolvedArgs, {
    ...options,
    shell: options?.shell ?? isWindows,
    windowsHide: true,
  });
}

/**
 * Quote a string for cmd.exe if it contains spaces and isn't already quoted.
 * No-op for strings without spaces or strings that are already double-quoted.
 */
function quoteForCmd(value: string): string {
  if (!value.includes(" ")) return value;
  if (value.startsWith('"') && value.endsWith('"')) return value;
  return `"${value}"`;
}
