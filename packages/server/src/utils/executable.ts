import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { execCommand } from "./spawn.js";
import { isWindowsCommandScript } from "./windows-command.js";

export { quoteWindowsArgument, quoteWindowsCommand } from "./windows-command.js";

type Which = (command: string, options: { all: true }) => Promise<string[]>;

const require = createRequire(import.meta.url);
const which = require("which") as Which;
const PROBE_TIMEOUT_MS = 2000;

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

async function enumerateCandidates(name: string): Promise<string[]> {
  if (process.platform !== "win32" && existsSync("/usr/bin/which")) {
    return enumerateCandidatesViaSystemWhich(name);
  }
  return enumerateCandidatesViaLibrary(name);
}

export interface WindowsKnownInstallOptions {
  platform?: NodeJS.Platform;
  localAppData?: string;
}

/**
 * Find an executable installed by `winget` outside of PATH.
 *
 * winget "portable" packages (like Claude Code) extract their executable into
 * `%LOCALAPPDATA%\Microsoft\WinGet\Packages\<PackageId>\` but do NOT add that
 * directory to PATH or create a Links shim, so PATH-based lookup can't find
 * them. Rather than hardcode each tool's package id, scan every winget package
 * directory for a matching `<name>.exe`. This keeps a single generic fallback
 * that any provider's command resolution benefits from — no per-tool probe.
 */
export function enumerateWindowsKnownInstallCandidates(
  name: string,
  options: WindowsKnownInstallOptions = {},
): string[] {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return [];
  }
  const localAppData = options.localAppData ?? process.env.LOCALAPPDATA;
  if (!localAppData) {
    return [];
  }

  const wingetPackages = join(localAppData, "Microsoft", "WinGet", "Packages");
  let packageDirs: string[];
  try {
    packageDirs = readdirSync(wingetPackages, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  // winget "portable" packages (e.g. Anthropic.ClaudeCode) drop their
  // executable at the package root, so probe `<packageDir>/<name>.exe`.
  const exeName = `${name}.exe`;
  return packageDirs.map((packageDir) => join(wingetPackages, packageDir, exeName));
}

async function enumerateCandidatesViaSystemWhich(name: string): Promise<string[]> {
  try {
    const { stdout } = await execCommand("/usr/bin/which", ["-a", name], {
      timeout: 3000,
      killSignal: "SIGKILL",
    });
    return Array.from(new Set(stdout.trim().split("\n").filter(Boolean)));
  } catch {
    return [];
  }
}

async function enumerateCandidatesViaLibrary(name: string): Promise<string[]> {
  let candidates: string[];
  try {
    candidates = await which(name, { all: true });
  } catch (error) {
    // `which` throws ENOENT when the command is absent from PATH.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate)) {
      return false;
    }
    seen.add(candidate);
    return true;
  });
}

export async function probeExecutable(
  executablePath: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  try {
    await execCommand(executablePath, ["--version"], {
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
      shell: isWindowsCommandScript(executablePath),
    });
    return true;
  } catch (error) {
    return classifyProbeError(error);
  }
}

function classifyProbeError(error: unknown): boolean {
  const err = error as NodeJS.ErrnoException & {
    killed?: boolean;
  };
  if (err.killed) {
    return true;
  }
  if (typeof err.code === "number") {
    return true;
  }
  if (
    err.code === "ENOENT" ||
    err.code === "EACCES" ||
    err.code === "ENOEXEC" ||
    err.code === "UNKNOWN"
  ) {
    return false;
  }
  return false;
}

/**
 * Check a literal executable path. PATH search is handled by findExecutable().
 */
export function executableExists(
  executablePath: string,
  exists: typeof existsSync = existsSync,
): string | null {
  if (exists(executablePath)) return executablePath;
  if (process.platform === "win32" && !extname(executablePath)) {
    for (const ext of [".exe", ".cmd"]) {
      const candidate = executablePath + ext;
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

export async function findExecutable(
  name: string,
  probeTimeoutMs = PROBE_TIMEOUT_MS,
): Promise<string | null> {
  const trimmed = name.trim();
  if (!trimmed) {
    return null;
  }

  if (hasPathSeparator(trimmed)) {
    return (await probeExecutable(trimmed, probeTimeoutMs)) ? trimmed : null;
  }

  const candidates = await enumerateCandidates(trimmed);
  for (const candidate of candidates) {
    if (await probeExecutable(candidate, probeTimeoutMs)) {
      return candidate;
    }
  }

  // PATH didn't resolve it. Fall back to well-known Windows install locations
  // (e.g. winget portable packages) that don't register themselves on PATH.
  // Only the existing executables are probed, so the cost is bounded.
  for (const candidate of enumerateWindowsKnownInstallCandidates(trimmed)) {
    if (existsSync(candidate) && (await probeExecutable(candidate, probeTimeoutMs))) {
      return candidate;
    }
  }
  return null;
}

export async function isCommandAvailable(command: string): Promise<boolean> {
  return (await findExecutable(command)) !== null;
}
