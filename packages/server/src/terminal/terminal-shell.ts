import { existsSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { findExecutableOnPath } from "../executable-resolution/executable-resolution.js";

// Shell resolution lives apart from terminal.ts so callers can import it without
// pulling node-pty and @xterm/headless into the process.

export interface TerminalShellLookupOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Injected for tests. */
  findOnPath?: (name: string) => Promise<string | null>;
}

export function resolveDefaultTerminalShell(
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;

  if (platform === "win32") {
    return env.ComSpec || env.COMSPEC || "C:\\Windows\\System32\\cmd.exe";
  }

  return env.SHELL || "/bin/sh";
}

// Settings send a preset id, not a path. The binary name differs per platform only
// where Windows needs the extension: node-pty's CreateProcess does not apply
// PATHEXT, so a bare `nu` never resolves there.
//
// Windows deliberately has no `bash` entry in its picker. The `bash.exe` on PATH
// is `System32\bash.exe`, the WSL launcher, so a single "Bash" choice silently
// dropped the user into Linux. Windows offers `wsl` and `git-bash` instead.
const PRESET_SHELL_BINARIES: Record<string, { win32: string; posix: string }> = {
  pwsh: { win32: "pwsh.exe", posix: "pwsh" },
  powershell: { win32: "powershell.exe", posix: "powershell" },
  cmd: { win32: "cmd.exe", posix: "cmd" },
  wsl: { win32: "wsl.exe", posix: "wsl" },
  zsh: { win32: "zsh.exe", posix: "zsh" },
  bash: { win32: "bash.exe", posix: "bash" },
  fish: { win32: "fish.exe", posix: "fish" },
  nu: { win32: "nu.exe", posix: "nu" },
  elvish: { win32: "elvish.exe", posix: "elvish" },
};

// Git for Windows does not put its bash on PATH — only `git.exe` (via `cmd/`) is
// there, and the `bash.exe` that IS on PATH belongs to WSL. So Git Bash has to be
// derived from the git install root rather than looked up by name.
const GIT_BASH_WELL_KNOWN_PATHS = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
];

async function resolveGitBashBinary(
  finder: (name: string) => Promise<string | null>,
): Promise<string | null> {
  const gitPath = await finder("git");
  if (gitPath) {
    const gitDir = dirname(gitPath);
    // Covers `<root>/cmd/git.exe`, `<root>/bin/git.exe`, `<root>/mingw64/bin/git.exe`.
    const candidates = [
      join(gitDir, "..", "bin", "bash.exe"),
      join(gitDir, "bash.exe"),
      join(gitDir, "..", "..", "bin", "bash.exe"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return resolvePath(candidate);
      }
    }
  }
  return GIT_BASH_WELL_KNOWN_PATHS.find((candidate) => existsSync(candidate)) ?? null;
}

// Only positive hits are cached. Caching a fallback would pin the preset to the
// default shell for the rest of the process: the fallback path exists, so the
// staleness check passes and the resolver never runs again. That is what made a
// `nu` selection keep opening cmd.exe after nu was installed.
const terminalShellExecutableCache = new Map<string, string>();

export function clearTerminalShellExecutableCache(): void {
  terminalShellExecutableCache.clear();
}

function readCachedTerminalShell(shell: string): string | null {
  const cached = terminalShellExecutableCache.get(shell);
  if (cached === undefined) {
    return null;
  }
  if (existsSync(cached)) {
    return cached;
  }
  terminalShellExecutableCache.delete(shell);
  return null;
}

/**
 * Locate the binary a shell setting points at, or null when it is not installed.
 *
 * `shell` is either a preset id (`nu`, `git-bash`, …) or a path the user typed.
 * Presets resolve through PATH so user-scope installs (winget, scoop, Homebrew)
 * are found without hardcoded locations; `git-bash` is derived from the git
 * install root because Git for Windows keeps its bash off PATH.
 *
 * The settings dropdown and the spawn path both call this, so the list can never
 * offer a shell the spawn path would then resolve differently.
 */
export async function findTerminalShellBinary(
  shell: string,
  options: TerminalShellLookupOptions = {},
): Promise<string | null> {
  const finder = options.findOnPath ?? findExecutableOnPath;
  if (shell === "git-bash") {
    return resolveGitBashBinary(finder);
  }

  const preset = PRESET_SHELL_BINARIES[shell];
  const platformKey = (options.platform ?? process.platform) === "win32" ? "win32" : "posix";
  const targetName = preset?.[platformKey] ?? shell;

  const found = await finder(targetName);
  return found ?? (existsSync(targetName) ? targetName : null);
}

function isPresetShellId(shell: string): boolean {
  return shell === "git-bash" || PRESET_SHELL_BINARIES[shell] !== undefined;
}

/**
 * Resolve a shell setting to a spawnable binary, degrading to the platform
 * default when a preset is not installed so the terminal still opens.
 */
export async function resolveTerminalShellExecutable(
  shell: string | undefined,
  options: TerminalShellLookupOptions = {},
): Promise<string> {
  if (!shell || shell === "default") {
    return resolveDefaultTerminalShell(options);
  }

  const isInjectedFinder = options.findOnPath !== undefined;
  if (!isInjectedFinder) {
    const cached = readCachedTerminalShell(shell);
    if (cached) {
      return cached;
    }
  }

  const resolved = await findTerminalShellBinary(shell, options);
  if (resolved === null) {
    return isPresetShellId(shell) ? resolveDefaultTerminalShell(options) : shell;
  }

  if (!isInjectedFinder) {
    terminalShellExecutableCache.set(shell, resolved);
  }
  return resolved;
}

// Offered in this order. Windows lists `wsl` and `git-bash` instead of a single
// `bash`, because the `bash.exe` on PATH is the WSL launcher.
const OFFERED_SHELL_PRESETS: Record<"win32" | "posix", readonly string[]> = {
  win32: ["pwsh", "powershell", "cmd", "git-bash", "wsl", "nu", "elvish"],
  posix: ["zsh", "bash", "fish", "nu", "elvish", "pwsh"],
};

export interface InstalledTerminalShell {
  /** Preset id (`pwsh`, `nu`, `git-bash`, …). */
  id: string;
  /** Absolute path the preset resolved to on this host. */
  path: string;
}

/**
 * The shells installed on this host, found with the same resolver the spawn path
 * uses so the list and the launch agree on what a preset id means. The resolved
 * path rides along because the caller turns a pick into a terminal profile,
 * which spawns a binary rather than re-interpreting a preset id.
 *
 * Presence here means the binary exists, not that it will run — confirming that
 * would mean executing every candidate on every settings mount. A shell that is
 * installed but broken surfaces as a spawn error, which is where the user is
 * heading anyway.
 */
export async function listAvailableTerminalShells(
  options: TerminalShellLookupOptions = {},
): Promise<InstalledTerminalShell[]> {
  const platformKey = (options.platform ?? process.platform) === "win32" ? "win32" : "posix";
  const found = await Promise.all(
    OFFERED_SHELL_PRESETS[platformKey].map(async (id) => {
      const path = await findTerminalShellBinary(id, options);
      return path === null ? null : { id, path };
    }),
  );
  return found.filter((shell): shell is InstalledTerminalShell => shell !== null);
}
