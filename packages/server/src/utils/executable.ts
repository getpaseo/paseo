import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import path from "node:path";
import { shellEnvSync } from "shell-env";

export interface FindExecutableDependencies {
  execSync: typeof execSync;
  execFileSync: typeof execFileSync;
  existsSync: typeof existsSync;
  platform: typeof platform;
  shell: string | undefined;
}

function resolveWindowsPathEntries(deps: FindExecutableDependencies): string[] {
  try {
    const output = deps.execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        [
          '$machine = [Environment]::GetEnvironmentVariable("Path", "Machine")',
          '$user = [Environment]::GetEnvironmentVariable("Path", "User")',
          "if ($machine) { Write-Output $machine }",
          "if ($user) { Write-Output $user }",
        ].join("; "),
      ],
      { encoding: "utf8" },
    );
    return output
      .split(/\r?\n/)
      .flatMap((line) => line.split(";"))
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  } catch {
    return [];
  }
}

function resolveExecutableFromWhichOutput(
  name: string,
  output: string,
  source: "login-shell" | "which",
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
 * On Unix we first try `$SHELL -lic "which <name>"` so that rc-file PATH
 * additions (asdf, nvm, homebrew, nix, etc.) are visible — exactly as if the
 * user opened a terminal and typed the command.  If that fails (e.g. the login
 * shell itself errors) we fall back to a plain `which`.
 *
 * On Windows we augment the daemon PATH with machine/user registry PATH values
 * and return the first `where.exe` match. Launch-time execution decides whether
 * the resolved path needs `cmd.exe` semantics (for example npm shims under
 * nvm4w such as `C:\nvm4w\nodejs\codex`).
 */
export function findExecutable(
  name: string,
  dependencies?: FindExecutableDependencies,
): string | null {
  const trimmed = name.trim();
  if (!trimmed) {
    return null;
  }

  const deps: FindExecutableDependencies = {
    execSync,
    execFileSync,
    existsSync,
    platform,
    shell: process.env["SHELL"],
    ...dependencies,
  };

  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return deps.existsSync(trimmed) ? trimmed : null;
  }

  if (deps.platform() === "win32") {
    try {
      const inheritedPath = process.env["Path"] ?? process.env["PATH"] ?? "";
      const resolvedPath = [
        ...inheritedPath.split(";"),
        ...resolveWindowsPathEntries(deps),
      ]
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .filter((entry, index, entries) => entries.indexOf(entry) === index)
        .join(";");
      const env = {
        ...process.env,
        PATH: resolvedPath,
        Path: resolvedPath,
      };
      const out = deps.execFileSync("where.exe", [trimmed], { encoding: "utf8", env }).trim();
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

  // Unix: try the user's login shell so rc-file PATH entries are visible.
  const shell = deps.shell;
  if (shell) {
    try {
      const out = deps
        .execSync(`${shell} -lic "which ${trimmed}"`, {
          encoding: "utf8",
          timeout: 5000,
        })
        .trim();
      const resolved = resolveExecutableFromWhichOutput(trimmed, out, "login-shell");
      if (resolved) {
        return resolved;
      }
    } catch {
      // Login shell failed (broken rc, etc.) — fall through to plain which.
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

export function isCommandAvailable(command: string): boolean {
  return findExecutable(command) !== null;
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

let cachedShellEnv: Record<string, string> | null = null;

export function resolveShellEnv(): Record<string, string> {
  if (cachedShellEnv) return cachedShellEnv;
  try {
    cachedShellEnv = shellEnvSync();
  } catch {
    cachedShellEnv = { ...process.env } as Record<string, string>;
  }
  return cachedShellEnv;
}
