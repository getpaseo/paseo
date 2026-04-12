import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface FindExecutableDependencies {
  execFileSync: typeof execFileSync;
  existsSync: typeof existsSync;
  platform: typeof platform;
}

function resolveExecutableFromWhichOutput(
  name: string,
  output: string,
  source: "which",
): string | null {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const candidate = lines.at(-1);

  if (!candidate) {
    return null;
  }

  if (!path.isAbsolute(candidate)) {
    console.warn(
      `[findExecutable] Ignoring non-absolute ${source} output for '${name}': ${JSON.stringify(candidate)}`,
    );
    return null;
  }

  return candidate;
}

/**
 * On Unix we use `which`. On Windows we use `where.exe`.
 *
 * Both rely on the inherited process.env.PATH — on macOS/Linux, Electron
 * enriches it at startup via inheritLoginShellEnv(); on Windows, Electron
 * inherits the full user environment from Explorer.
 */
export function findExecutableSync(
  name: string,
  dependencies?: FindExecutableDependencies,
): string | null {
  const trimmed = name.trim();
  if (!trimmed) {
    return null;
  }

  const deps: FindExecutableDependencies = {
    execFileSync,
    existsSync,
    platform,
    ...dependencies,
  };

  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return deps.existsSync(trimmed) ? trimmed : null;
  }

  if (deps.platform() === "win32") {
    try {
      const out = deps
        .execFileSync("where.exe", [trimmed], {
          encoding: "utf8",
          windowsHide: true,
        })
        .trim();
      return (
        out
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => line.length > 0) ?? null
      );
    } catch {
      return null;
    }
  }

  try {
    return resolveExecutableFromWhichOutput(
      trimmed,
      deps.execFileSync("which", [trimmed], { encoding: "utf8" }).trim(),
      "which",
    );
  } catch {
    return null;
  }
}

export function isCommandAvailableSync(command: string): boolean {
  return findExecutableSync(command) !== null;
}

export async function findExecutable(name: string): Promise<string | null> {
  const trimmed = name.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return existsSync(trimmed) ? trimmed : null;
  }

  if (platform() === "win32") {
    try {
      const { stdout } = await execFileAsync("where.exe", [trimmed], {
        encoding: "utf8",
        windowsHide: true,
      });
      return (
        stdout
          .trim()
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => line.length > 0) ?? null
      );
    } catch {
      return null;
    }
  }

  try {
    const { stdout } = await execFileAsync("which", [trimmed], { encoding: "utf8" });
    return resolveExecutableFromWhichOutput(trimmed, stdout.trim(), "which");
  } catch {
    return null;
  }
}

export async function isCommandAvailable(command: string): Promise<boolean> {
  return (await findExecutable(command)) !== null;
}

/**
 * When spawning with `shell: true` on Windows, the command is passed to
 * `cmd.exe /d /s /c "command args"`. The `/s` strips outer quotes, so a
 * command path with spaces (e.g. `C:\Program Files\...`) is split at the
 * space. Wrapping it in quotes produces the correct `"C:\Program Files\..." args`.
 */
export function quoteWindowsCommand(command: string): string {
  if (process.platform !== "win32") return command;
  if (!command.includes(" ")) return command;
  if (command.startsWith('"') && command.endsWith('"')) return command;
  return `"${command}"`;
}

/**
 * `spawn(..., { shell: true })` on Windows also passes argv through `cmd.exe`.
 * Any argument containing spaces must be quoted or it will be split before the
 * child process sees it.
 */
export function quoteWindowsArgument(argument: string): string {
  if (process.platform !== "win32") return argument;
  if (!argument.includes(" ")) return argument;
  if (argument.startsWith('"') && argument.endsWith('"')) return argument;
  return `"${argument}"`;
}
