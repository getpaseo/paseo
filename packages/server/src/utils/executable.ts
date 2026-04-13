import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path, { extname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function pickBestWindowsCandidate(lines: string[]): string | null {
  const candidates = lines.filter((line) => line.length > 0);
  if (candidates.length === 0) return null;

  const extPriority = [".exe", ".cmd", ".ps1"];
  for (const ext of extPriority) {
    const match = candidates.find((candidate) => candidate.toLowerCase().endsWith(ext));
    if (match) return match;
  }

  return candidates[0] ?? null;
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
export function executableExists(
  executablePath: string,
  exists: typeof existsSync = existsSync,
): string | null {
  if (exists(executablePath)) return executablePath;
  if (process.platform === "win32" && !extname(executablePath)) {
    for (const ext of [".exe", ".cmd", ".ps1"]) {
      const candidate = executablePath + ext;
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

export async function findExecutable(name: string): Promise<string | null> {
  const trimmed = name.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return executableExists(trimmed);
  }

  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync("where.exe", [trimmed], {
        encoding: "utf8",
        windowsHide: true,
      });
      return (
        pickBestWindowsCandidate(
          stdout
            .trim()
            .split(/\r?\n/)
            .map((line) => line.trim()),
        ) ?? null
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

function escapeWindowsCmdValue(value: string): string {
  if (process.platform !== "win32") return value;

  const isQuoted = value.startsWith('"') && value.endsWith('"');
  const unquoted = isQuoted ? value.slice(1, -1) : value;
  const escaped = unquoted.replace(/%/g, "%%").replace(/([&|^<>()!])/g, "^$1");

  if (isQuoted || escaped.includes(" ")) {
    return `"${escaped}"`;
  }

  return escaped;
}

/**
 * When spawning with `shell: true` on Windows, the command is passed to
 * `cmd.exe /d /s /c "command args"`. The `/s` strips outer quotes, so a
 * command path with spaces (e.g. `C:\Program Files\...`) is split at the
 * space. Wrapping it in quotes produces the correct `"C:\Program Files\..." args`.
 */
export function quoteWindowsCommand(command: string): string {
  return escapeWindowsCmdValue(command);
}

/**
 * `spawn(..., { shell: true })` on Windows also passes argv through `cmd.exe`.
 * Any argument containing spaces must be quoted or it will be split before the
 * child process sees it.
 */
export function quoteWindowsArgument(argument: string): string {
  return escapeWindowsCmdValue(argument);
}
